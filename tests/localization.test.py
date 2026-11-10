"""Run with vendor/pokeapi/.venv/bin/python tests/localization.test.py."""
import os
import json
import shutil
import tempfile
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'vendor/pokeapi')]
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
import django

django.setup()
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext
from localization import apply_translations, persist_rows, load_locales, validated_rows, source_resources
from pokemon_v2.models import AbilityEffectText


class LocalizationTest(unittest.TestCase):
    def test_full_catalog_is_idempotent_and_preserves_other_languages(self):
        with transaction.atomic():
            original = list(AbilityEffectText.objects.exclude(language_id=13).values())
            apply_translations()
            with CaptureQueriesContext(connection) as queries:
                apply_translations()
            writes = [q['sql'] for q in queries if q['sql'].startswith(('INSERT', 'UPDATE', 'DELETE'))]
            self.assertEqual(writes, [])
            self.assertEqual(original, list(AbilityEffectText.objects.exclude(language_id=13).values()))
            transaction.set_rollback(True)

    def test_batch_updates_preserve_primary_keys_and_restore_text(self):
        with transaction.atomic():
            row = AbilityEffectText.objects.filter(language_id=13).first()
            original = row.effect
            persist_rows([(AbilityEffectText, {'ability_id': row.ability_id},
                           {'effect': 'Texto de teste', 'short_effect': row.short_effect})], 13)
            row.refresh_from_db()
            self.assertEqual(row.effect, 'Texto de teste')
            apply_translations()
            row.refresh_from_db()
            self.assertEqual(row.effect, original)
            ability_id = row.ability_id
            row.delete()
            apply_translations()
            recreated = AbilityEffectText.objects.get(language_id=13, ability_id=ability_id)
            self.assertEqual(recreated.effect, original)
            transaction.set_rollback(True)

    def test_all_resources_use_the_same_catalog_validation(self):
        locale = load_locales()[0]
        rows = validated_rows(locale)
        self.assertEqual(len(rows), 38573)
        self.assertIn('MoveFlavorText', {model.__name__ for model, _, _ in rows})
        # Existing translations in another target language must not affect sources.
        self.assertEqual(len(validated_rows({**locale, 'id': 12})), len(rows))
        with tempfile.TemporaryDirectory() as directory:
            catalog = Path(directory) / 'catalog'
            shutil.copytree(locale['catalog'], catalog)
            for name in ('AbilityEffectText', 'MoveEffectEffectText', 'MoveFlavorText'):
                with self.subTest(model=name):
                    path = catalog / f'{name}.json'
                    original = path.read_text(encoding='utf-8')
                    payload = json.loads(original)
                    field = next(iter(payload['entries'][0]['text']))
                    payload['entries'][0]['text'][field] = ''
                    path.write_text(json.dumps(payload), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'Empty translation'):
                        validated_rows({**locale, 'catalog': catalog})
                    path.write_text(original, encoding='utf-8')

    def test_duplicate_keys_are_rejected(self):
        with transaction.atomic():
            row = AbilityEffectText.objects.filter(language_id=13).first()
            entry = (AbilityEffectText, {'ability_id': row.ability_id},
                     {'effect': row.effect, 'short_effect': row.short_effect})
            with self.assertRaises(ValueError):
                persist_rows([entry, entry], 13)
            transaction.set_rollback(True)

    def test_every_source_version_has_a_translation(self):
        from django.apps import apps

        locale = load_locales()[0]
        resources = source_resources(locale['source_id'], locale['id'])
        translated = validated_rows(locale)
        for name in resources:
            model = apps.get_model('pokemon_v2', name)
            keys = [field.attname for field in model._meta.local_concrete_fields
                    if field.is_relation and field.name != 'language']
            expected = set(model.objects.filter(language_id=locale['source_id']).values_list(*keys))
            actual = {tuple(key[field] for field in keys) for row_model, key, _ in translated
                      if row_model == model}
            self.assertTrue(expected.issubset(actual), name)
        move_sources = resources['MoveFlavorText']
        pound = [row for row in move_sources if row['key']['move_id'] == 1]
        self.assertGreater(len(pound), 1)
        self.assertGreater(len({row['source']['flavor_text'] for row in pound}), 1)

    def test_historical_flavor_texts_are_applied_without_changing_english(self):
        from pokemon_v2.models import MoveFlavorText

        with transaction.atomic():
            english = list(MoveFlavorText.objects.filter(language_id=9, move_id=1)
                           .order_by('version_group_id').values('version_group_id', 'flavor_text'))
            apply_translations()
            portuguese = list(MoveFlavorText.objects.filter(language_id=13, move_id=1)
                              .values('version_group_id', 'flavor_text'))
            self.assertTrue({row['version_group_id'] for row in english}.issubset(
                {row['version_group_id'] for row in portuguese}))
            self.assertGreater(len({row['flavor_text'] for row in portuguese}), 1)
            self.assertEqual(english, list(MoveFlavorText.objects.filter(language_id=9, move_id=1)
                                          .order_by('version_group_id').values('version_group_id', 'flavor_text')))
            transaction.set_rollback(True)


if __name__ == '__main__':
    unittest.main()
