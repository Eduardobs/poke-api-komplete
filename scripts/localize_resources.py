"""Apply versioned pt-br descriptions without contacting a translation service at build time."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / 'data/translations/resources'
LANGUAGE_ID = 13
FIELDS = {'description', 'effect', 'short_effect', 'flavor_text', 'genus'}
EXCLUDED = {'MoveFlavorText', 'MoveEffectEffectText'}  # Existing curated move summaries.
SPECIAL_FIELDS = {
    'PokemonShapeName': {'name', 'awesome_name'},
    'ContestTypeName': {'name', 'flavor', 'color'},
}


def source_resources():
    from django.apps import apps
    from pokemon_v2.models import Version, VersionGroup

    groups = dict(VersionGroup.objects.values_list('id', 'order'))
    versions = {pk: (groups[group], pk) for pk, group in Version.objects.values_list('id', 'version_group_id')}
    resources = {}
    for model in apps.get_app_config('pokemon_v2').get_models():
        fields = {field.name for field in model._meta.local_concrete_fields}
        translated = sorted((fields & FIELDS) | SPECIAL_FIELDS.get(model.__name__, set()))
        if 'language' not in fields or not translated or model.__name__ in EXCLUDED:
            continue
        # Rows with a genus also need the proper Pokémon name, which is not translated.
        copied = ['name'] if model.__name__ == 'PokemonSpeciesName' else []
        keys = [f.attname for f in model._meta.local_concrete_fields if f.is_relation and f.name != 'language']
        entity_keys = [key for key in keys if key not in {'version_id', 'version_group_id'}]
        selected = {}
        for row in model.objects.filter(language_id=9).order_by('pk').values(*keys, *translated, *copied):
            entity = tuple(row[key] for key in entity_keys)
            if 'version_id' in row:
                rank = versions[row['version_id']]
            elif 'version_group_id' in row:
                rank = (groups[row['version_group_id']], 0)
            else:
                rank = (0, 0)
            if entity not in selected or rank > selected[entity][0]:
                selected[entity] = (rank, row)
        available = set(model.objects.exclude(language_id=LANGUAGE_ID).values_list(*entity_keys))
        if available != selected.keys():
            raise ValueError(f'Missing English source for localized resources: {model.__name__}')
        rows = []
        for _, row in sorted(selected.values(), key=lambda item: tuple(item[1][key] for key in keys)):
            rows.append({'key': {key: row[key] for key in keys},
                         'source': {field: row[field] for field in translated},
                         'copy': {field: row[field] for field in copied}})
        resources[model.__name__] = rows
    return resources


def source_hash(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def validated_resources():
    from django.apps import apps

    sources = source_resources()
    if {path.stem for path in FOLDER.glob('*.json')} != sources.keys():
        raise ValueError('pt-br resource files do not match the translatable models')
    validated = []
    for name, rows in sources.items():
        model = apps.get_model('pokemon_v2', name)
        payload = json.loads((FOLDER / f'{name}.json').read_text(encoding='utf-8'))
        if payload['source_sha256'] != source_hash(rows) or len(payload['entries']) != len(rows):
            raise ValueError(f'Stale or incomplete pt-br translations: {name}')
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


def apply_resource_translations():
    from django.db import transaction
    from pokemon_v2.models import Language

    if not Language.objects.filter(pk=LANGUAGE_ID, name='pt-br').exists():
        raise ValueError('Expected pt-br at language ID 13')
    rows = validated_resources()
    with transaction.atomic():
        for model, key, text in rows:
            model.objects.update_or_create(language_id=LANGUAGE_ID, **key, defaults=text)
    print(f'pt-br: {len(rows)} descriptions across {len({m for m, _, _ in rows})} resource models', flush=True)


if __name__ == '__main__':
    import argparse
    import os
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export-sources', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'vendor/pokeapi'))
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
    import django
    django.setup()
    args.export_sources.write_text(json.dumps(source_resources(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
