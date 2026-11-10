"""Build-time translation registry and shared atomic, batched persistence."""
import json
import hashlib
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_locales():
    entries = json.loads((ROOT / 'data/translations/locales.json').read_text(encoding='utf-8'))
    names, ids = set(), set()
    for entry in entries:
        if entry['name'] in names or entry['id'] in ids or entry['id'] == entry['source_id']:
            raise ValueError('Duplicate locale or source language used as target')
        names.add(entry['name'])
        ids.add(entry['id'])
        path = (ROOT / 'data/translations' / entry['catalog']).resolve()
        if not path.is_relative_to(ROOT / 'data/translations'):
            raise ValueError(f'Invalid translation path: {entry["catalog"]}')
        entry['catalog'] = path
    return entries


def validate_language(locale):
    from pokemon_v2.models import Language

    if not Language.objects.filter(pk=locale['id'], name=locale['name']).exists():
        raise ValueError(f'Unknown translation language: {locale["name"]}')


FIELDS = {'description', 'effect', 'short_effect', 'flavor_text', 'genus'}
SPECIAL_FIELDS = {
    'PokemonShapeName': {'name', 'awesome_name'},
    'ContestTypeName': {'name', 'flavor', 'color'},
}


def source_resources(source_id, language_id):
    from django.apps import apps
    resources = {}
    coverage = {}
    shapes = {}
    for model in apps.get_app_config('pokemon_v2').get_models():
        fields = {field.name for field in model._meta.local_concrete_fields}
        translated = sorted((fields & FIELDS) | SPECIAL_FIELDS.get(model.__name__, set()))
        if 'language' not in fields or not translated:
            continue
        # Rows with a genus also need the proper Pokémon name, which is not translated.
        copied = ['name'] if model.__name__ == 'PokemonSpeciesName' else []
        keys = [f.attname for f in model._meta.local_concrete_fields if f.is_relation and f.name != 'language']
        entity_keys = [key for key in keys if key not in {'version_id', 'version_group_id'}]
        selected = {}
        for row in model.objects.filter(language_id=source_id).order_by('pk').values(*keys, *translated, *copied):
            # Version is part of a description's identity: historical games
            # can describe different mechanics for the same resource.
            selected[tuple(row[key] for key in keys)] = row
        available = set(model.objects.exclude(language_id=language_id).values_list(*entity_keys))
        coverage[model.__name__] = (available, entity_keys)
        rows = []
        for row in sorted(selected.values(), key=lambda row: tuple(row[key] for key in keys)):
            rows.append({'key': {key: row[key] for key in keys},
                         'source': {field: row[field] for field in translated},
                         'copy': {field: row[field] for field in copied}})
        resources[model.__name__] = rows
        shapes[model.__name__] = {'key': dict.fromkeys(keys), 'source': dict.fromkeys(translated), 'copy': dict.fromkeys(copied)}
    # Explicit sources also cover project descriptions absent from upstream.
    supplements = json.loads((ROOT / 'data/translations/sources.json').read_text(encoding='utf-8'))
    for name, rows in supplements.items():
        if name not in resources:
            raise ValueError(f'Unknown supplementary source model: {name}')
        model = apps.get_model('pokemon_v2', name)
        known = {tuple(sorted(row['key'].items())) for row in resources[name]}
        sample = shapes[name]
        for row in rows:
            identity = tuple(sorted(row['key'].items()))
            if identity in known or row['key'].keys() != sample['key'].keys() or row['source'].keys() != sample['source'].keys() or row['copy'].keys() != sample['copy'].keys():
                raise ValueError(f'Invalid supplementary source: {name}: {row["key"]}')
            for field, value in row['key'].items():
                relation = model._meta.get_field(field.removesuffix('_id'))
                if not relation.related_model.objects.filter(pk=value).exists():
                    raise ValueError(f'Unknown supplementary source reference: {name}.{field}: {value}')
            known.add(identity)
            resources[name].append(row)
        resources[name].sort(key=lambda row: tuple(row['key'][key] for key in sample['key']))
    for name, (available, keys) in coverage.items():
        selected = {tuple(row['key'][key] for key in keys) for row in resources[name]}
        if not available.issubset(selected):
            raise ValueError(f'Missing source language for localized resources: {name}')
    return resources


def source_hash(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def validated_rows(locale):
    from django.apps import apps

    folder = locale["catalog"]
    sources = source_resources(locale["source_id"], locale["id"])
    if {path.stem for path in folder.glob('*.json')} != sources.keys():
        raise ValueError('Resource files do not match the translatable models')
    validated = []
    for name, rows in sources.items():
        model = apps.get_model('pokemon_v2', name)
        payload = json.loads((folder / f'{name}.json').read_text(encoding='utf-8'))
        if payload['source_sha256'] != source_hash(rows) or len(payload['entries']) != len(rows):
            raise ValueError(f'Stale or incomplete resource translations: {name}')
        for source, entry in zip(rows, payload['entries'], strict=True):
            if entry['key'] != source['key'] or entry['text'].keys() != source['source'].keys():
                raise ValueError(f'Invalid translation keys: {name}: {source["key"]}')
            for field, text in entry['text'].items():
                if not isinstance(text, str) or (source['source'][field].strip() and not text.strip()):
                    raise ValueError(f'Empty translation: {name}.{field}: {entry["key"]}')
                placeholders = r'\[VAR[^\]]*\]|\$[a-z_]+'
                if sorted(re.findall(placeholders, text)) != sorted(re.findall(placeholders, source['source'][field])):
                    raise ValueError(f'Changed placeholders: {name}.{field}: {entry["key"]}')
                if re.search(r'ZXQ(?:NAME|ID)\d+QXZ', text, re.I):
                    raise ValueError(f'Unresolved translation token: {name}.{field}: {entry["key"]}')
                limit = model._meta.get_field(field).max_length
                if limit and len(text) > limit:
                    raise ValueError(f'Translation too long ({len(text)}/{limit}): {name}.{field}: {entry["key"]}: {text}')
            validated.append((model, entry['key'], {**source['copy'], **entry['text']}))
    return validated


def persist_rows(rows, language_id):
    """Use existing PKs so batching does not require backend-specific conflict SQL."""
    grouped = defaultdict(list)
    for model, key, text in rows:
        grouped[model].append((key, text))
    for model, entries in grouped.items():
        keys = tuple(sorted(entries[0][0]))
        fields = tuple(sorted(entries[0][1]))
        existing = {
            tuple(row[field] for field in keys): row
            for row in model.objects.filter(language_id=language_id).values('pk', *keys, *fields)
        }
        create, update, seen = [], [], set()
        for key, text in entries:
            if tuple(sorted(key)) != keys or tuple(sorted(text)) != fields:
                raise ValueError(f'Inconsistent translation fields: {model.__name__}: {key}')
            identity = tuple(key[field] for field in keys)
            if identity in seen:
                raise ValueError(f'Duplicate or inconsistent translation: {model.__name__}: {key}')
            seen.add(identity)
            for field, value in text.items():
                limit = model._meta.get_field(field).max_length
                if not isinstance(value, str) or (limit and len(value) > limit):
                    raise ValueError(f'Invalid translation text: {model.__name__}.{field}: {key}')
            previous = existing.get(identity)
            if previous is None:
                create.append(model(language_id=language_id, **key, **text))
            elif any(previous[field] != value for field, value in text.items()):
                update.append(model(pk=previous['pk'], **text))
        model.objects.bulk_create(create, batch_size=250)
        model.objects.bulk_update(update, fields, batch_size=250)


def apply_translations():
    from django.db import transaction

    # One transaction prevents partially applied languages if any catalog is invalid.
    with transaction.atomic():
        for locale in load_locales():
            validate_language(locale)
            rows = validated_rows(locale)
            persist_rows(rows, locale['id'])
            print(f'{locale["name"]}: {len(rows)} translations applied', flush=True)


def main():
    import argparse
    import os
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export-sources', type=Path)
    parser.add_argument('--locale', default='pt-br')
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'vendor/pokeapi'))
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
    import django
    django.setup()
    if args.export_sources:
        locale = next((entry for entry in load_locales() if entry['name'] == args.locale), None)
        if locale is None:
            parser.error(f'Unknown locale: {args.locale}')
        args.export_sources.write_text(json.dumps(source_resources(locale['source_id'], locale['id']), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    else:
        apply_translations()


if __name__ == '__main__':
    main()
