"""Generate a compact runtime mapping; no Django or Hasura dependency at runtime."""
import json
import os
from pathlib import Path
import sys
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/pokeapi'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
import django
django.setup()
from django.apps import apps

models = {model._meta.db_table: model for model in apps.get_app_config('pokemon_v2').get_models()}
folder = ROOT / 'vendor/pokeapi/graphql/v1beta2/metadata/databases/default/tables'
configs = [yaml.safe_load(p.read_text()) for p in sorted(folder.glob('public_*.yaml'))]
configs = [c for c in configs if any(p['role'] == 'anon' for p in c.get('select_permissions', []))]
names = {c['table']['name']: c['configuration']['custom_name'] for c in configs}
tables = {}
for config in configs:
    physical = config['table']['name']
    model = models[physical]
    columns = {}
    fks = {}
    for field in model._meta.local_concrete_fields:
        internal = field.get_internal_type()
        sql_type = 'jsonb' if internal == 'JSONField' else 'boolean' if internal == 'BooleanField' else 'float8' if internal == 'FloatField' else 'text' if internal in ('CharField', 'TextField') else 'integer'
        columns[field.column] = sql_type
        if field.is_relation:
            fks[field.column] = (field.related_model._meta.db_table, field.target_field.column)
    relations = {}
    for relation in config.get('object_relationships', []):
        column = relation['using']['foreign_key_constraint_on']
        if isinstance(column, dict):
            remote = column['table']['name']
            target_field = next(f for f in models[remote]._meta.local_concrete_fields if f.column == column['column'])
            relations[relation['name']] = {'table': names[remote], 'many': False, 'local': target_field.target_field.column, 'remote': column['column']}
        else:
            remote, pk = fks[column]
            relations[relation['name']] = {'table': names[remote], 'many': False, 'local': column, 'remote': pk}
    for relation in config.get('array_relationships', []):
        fk = relation['using']['foreign_key_constraint_on']
        remote = fk['table']['name']
        if remote not in names:
            continue  # No anonymous select permission; not present in the public schema.
        target_field = next(f for f in models[remote]._meta.local_concrete_fields if f.column == fk['column'])
        relations[relation['name']] = {'table': names[remote], 'many': True, 'local': target_field.target_field.column, 'remote': fk['column']}
    permission = next(p['permission'] for p in config['select_permissions'] if p['role'] == 'anon')
    if permission.get('filter') != {} or permission['columns'] != '*':
        raise RuntimeError(f'Unimplemented permissions for {physical}; refusing unsafe catalog')
    tables[names[physical]] = {'sql': physical, 'columns': columns, 'relations': relations, 'limit': permission.get('limit', 100000), 'pk': model._meta.pk.column}
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'src/generated/relational.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(tables, separators=(',', ':')) + '\n')
print(f'Runtime catalog: {len(tables)} tables, {sum(len(t["relations"]) for t in tables.values())} relationships')
