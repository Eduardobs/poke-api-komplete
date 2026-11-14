"""Insert/update the local snapshot in PostgreSQL, preserving destination-only rows."""
import os
from pathlib import Path
import sqlite3
import sys
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/pokeapi'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
import django
from django.conf import settings
from django.core.management import call_command
import psycopg
from psycopg import sql


def sync_table(snapshot, cursor, table_name, columns, pk):
    """Stage with COPY, then merge by primary key without rewriting equal rows."""
    table = sql.Identifier(table_name)
    stage = sql.Identifier('_snapshot_stage')
    fields = sql.SQL(',').join(map(sql.Identifier, columns))
    selected = ','.join('"' + c.replace('"', '""') + '"' for c in columns)
    cursor.execute(sql.SQL('CREATE TEMP TABLE {} (LIKE {}) ON COMMIT DROP').format(stage, table))
    count = 0
    with cursor.copy(sql.SQL('COPY {} ({}) FROM STDIN').format(stage, fields)) as copy:
        for row in snapshot.execute(f'SELECT {selected} FROM "{table_name}"'):
            copy.write_row(row)
            count += 1
    mutable = [column for column in columns if column != pk]
    if mutable:
        assignments = sql.SQL(',').join(
            sql.SQL('{} = EXCLUDED.{}').format(sql.Identifier(c), sql.Identifier(c))
            for c in mutable)
        old = sql.SQL(',').join(sql.SQL('destination.{}').format(sql.Identifier(c)) for c in mutable)
        new = sql.SQL(',').join(sql.SQL('EXCLUDED.{}').format(sql.Identifier(c)) for c in mutable)
        conflict = sql.SQL('DO UPDATE SET {} WHERE ROW({}) IS DISTINCT FROM ROW({})').format(assignments, old, new)
    else:
        conflict = sql.SQL('DO NOTHING')
    cursor.execute(sql.SQL(
        'INSERT INTO {} AS destination ({}) SELECT {} FROM {} '
        'ON CONFLICT ({}) {}'
    ).format(table, fields, fields, stage, sql.Identifier(pk), conflict))
    changed = cursor.rowcount
    cursor.execute(sql.SQL('DROP TABLE {}').format(stage))
    cursor.execute(sql.SQL(
        'SELECT setval(pg_get_serial_sequence(%s, %s), '
        'GREATEST(COALESCE(MAX({}),1),1), MAX({}) IS NOT NULL) FROM {}'
    ).format(sql.Identifier(pk), sql.Identifier(pk), table), (table_name, pk))
    return count, changed


def main():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise SystemExit('Set DATABASE_URL to your own PostgreSQL database.')
    source = ROOT / 'vendor/pokeapi/db.sqlite3'
    if not source.exists() or not (source.parent / '.snapshot-db-ready').exists():
        raise SystemExit('Run npm run data:build first.')
    target = urlsplit(database_url)
    options = dict(part.split('=', 1) for part in target.query.split('&') if '=' in part)
    settings.DATABASES = {'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': unquote(target.path.lstrip('/')),
        'USER': unquote(target.username or ''), 'PASSWORD': unquote(target.password or ''),
        'HOST': target.hostname or '', 'PORT': str(target.port or 5432),
        'OPTIONS': options,
    }}
    settings.CACHES = {'default': {'BACKEND': 'django.core.cache.backends.dummy.DummyCache'}}
    django.setup()
    from django.apps import apps
    models = list(apps.get_app_config('pokemon_v2').get_models())
    call_command('migrate', verbosity=0)
    total = 0
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as snapshot, psycopg.connect(database_url) as pg:
        snapshot.execute('BEGIN')
        with pg.cursor() as cursor:
            # Serialize importers and block writes while allowing API SELECTs.
            tables = sql.SQL(',').join(sql.Identifier(m._meta.db_table) for m in models)
            cursor.execute(sql.SQL('LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE').format(tables))
            cursor.execute('SET CONSTRAINTS ALL DEFERRED')
            changed_total = 0
            for model in models:
                table_name = model._meta.db_table
                columns = [field.column for field in model._meta.local_concrete_fields]
                count, changed = sync_table(snapshot, cursor, table_name, columns, model._meta.pk.column)
                total += count
                changed_total += changed
                print(f'{table_name}: {count} snapshot rows; {changed} inserted/updated', flush=True)
            # Finish deferred foreign-key checks before creating an index.
            cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
            # Support bounded relation pages and DISTINCT ON ordered by Pokémon/id.
            cursor.execute('CREATE INDEX IF NOT EXISTS pokeapi_pokemonmove_pokemon_id_id_idx '
                           'ON pokemon_v2_pokemonmove (pokemon_id, id)')
            # COPY bypasses normal incremental traffic: collect planner statistics
            # before the newly imported snapshot receives its first queries.
            for model in models:
                cursor.execute(sql.SQL('ANALYZE {}').format(sql.Identifier(model._meta.db_table)))
        pg.commit()
        print(f'Synchronized {total} relational rows; {changed_total} inserted/updated. PostgreSQL bytes: {pg.execute("SELECT pg_database_size(current_database())").fetchone()[0]}', flush=True)


if __name__ == '__main__':
    main()
