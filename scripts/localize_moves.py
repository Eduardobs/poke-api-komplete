"""Project-owned Brazilian Portuguese move summaries, shared by REST and GraphQL."""
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV = ROOT / 'vendor/pokeapi/data/v2/csv'
TRANSLATIONS = ROOT / 'data/translations'
LANGUAGE_ID = 13


def read_translations(path):
    result = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        key, text = line.split('|', 1)
        key = int(key)
        if key in result or not text.strip():
            raise ValueError(f'Invalid or duplicate translation: {path}:{key}')
        result[key] = text
    return result


def localized_rows():
    effects = read_translations(TRANSLATIONS / 'move-effects.pt-br.txt')
    overrides = read_translations(TRANSLATIONS / 'moves.pt-br.txt')
    with (CSV / 'move_effect_prose.csv').open(encoding='utf-8', newline='') as source:
        expected = {int(r['move_effect_id']) for r in csv.DictReader(source)
                    if r['local_language_id'] == '9'}
    if effects.keys() != expected:
        raise ValueError('Portuguese effect translations do not match the source effect IDs')
    # Use the most recent English version's group, ordered by release rather than ID.
    with (CSV / 'version_groups.csv').open(encoding='utf-8', newline='') as source:
        order = {int(r['id']): int(r['order']) for r in csv.DictReader(source)}
    versions = {}
    with (CSV / 'move_flavor_text.csv').open(encoding='utf-8', newline='') as source:
        for row in csv.DictReader(source):
            if row['language_id'] != '9':
                continue
            move, version = int(row['move_id']), int(row['version_group_id'])
            if move not in versions or order[version] > order[versions[move]]:
                versions[move] = version
    descriptions = []
    with (CSV / 'moves.csv').open(encoding='utf-8', newline='') as source:
        moves = list(csv.DictReader(source))
    missing_effect = {int(row['id']) for row in moves if not row['effect_id']}
    if overrides.keys() != missing_effect:
        raise ValueError('Portuguese move overrides do not match moves without effect prose')
    for row in moves:
        move = int(row['id'])
        text = overrides[move] if move in overrides else effects[int(row['effect_id'])]
        # Shadow moves belong to XD; the five Torque moves belong to Scarlet/Violet.
        version = versions.get(move, 13 if move >= 10000 else 25)
        descriptions.append((move, version, text))
    return effects, descriptions


def apply_move_translations():
    from django.db import transaction
    from pokemon_v2.models import Language, MoveEffectEffectText, MoveFlavorText

    effects, descriptions = localized_rows()
    if not Language.objects.filter(pk=LANGUAGE_ID, name='pt-br').exists():
        raise ValueError('Expected Brazilian Portuguese language at ID 13')
    with transaction.atomic():
        for effect, text in effects.items():
            MoveEffectEffectText.objects.update_or_create(
                move_effect_id=effect, language_id=LANGUAGE_ID,
                defaults={'short_effect': text, 'effect': text},
            )
        for move, version, text in descriptions:
            MoveFlavorText.objects.update_or_create(
                move_id=move, language_id=LANGUAGE_ID, version_group_id=version,
                defaults={'flavor_text': text},
            )
    print(f'pt-br: {len(effects)} effect summaries, {len(descriptions)} move descriptions', flush=True)
