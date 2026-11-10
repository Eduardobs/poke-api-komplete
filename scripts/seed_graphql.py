"""Copy the local snapshot to an empty PostgreSQL database for the own backend."""
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


def main():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise SystemExit('Set DATABASE_URL to your own empty PostgreSQL database.')
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
        with pg.cursor() as cursor:
            # Abort without replacing existing records. A failed copy rolls back in full.
            for model in models:
                table = sql.Identifier(model._meta.db_table)
                cursor.execute(sql.SQL('SELECT EXISTS(SELECT 1 FROM {} LIMIT 1)').format(table))
                if cursor.fetchone()[0]:
                    raise SystemExit('Target already contains Pokémon data; use a new empty database.')
            cursor.execute('SET CONSTRAINTS ALL DEFERRED')
            for model in models:
                table_name = model._meta.db_table
                columns = [field.column for field in model._meta.local_concrete_fields]
                selected = ','.join('"' + c.replace('"', '""') + '"' for c in columns)
                rows = snapshot.execute(f'SELECT {selected} FROM "{table_name}"')
                statement = sql.SQL('COPY {} ({}) FROM STDIN').format(sql.Identifier(table_name), sql.SQL(',').join(map(sql.Identifier, columns)))
                count = 0
                with cursor.copy(statement) as copy:
                    for row in rows:
                        copy.write_row(row)
                        count += 1
                pk = model._meta.pk.column
                cursor.execute(sql.SQL('SELECT setval(pg_get_serial_sequence(%s, %s), GREATEST(COALESCE(MAX({}),1),1), MAX({}) IS NOT NULL) FROM {}').format(sql.Identifier(pk), sql.Identifier(pk), sql.Identifier(table_name)), (table_name, pk))
                total += count
                print(f'{table_name}: {count}', flush=True)
            # Finish deferred foreign-key checks before creating an index.
            cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
            # Support bounded relation pages and DISTINCT ON ordered by Pokémon/id.
            cursor.execute('CREATE INDEX IF NOT EXISTS pokeapi_pokemonmove_pokemon_id_id_idx '
                           'ON pokemon_v2_pokemonmove (pokemon_id, id)')
            # COPY bypasses normal incremental traffic: collect planner statistics
            # before the newly imported snapshot receives its first queries.
            for model in models:
                cursor.execute(sql.SQL('ANALYZE {}').format(sql.Identifier(model._meta.db_table)))
        print(f'Imported {total} relational rows. PostgreSQL bytes: {pg.execute("SELECT pg_database_size(current_database())").fetchone()[0]}', flush=True)


if __name__ == '__main__':
    main()
