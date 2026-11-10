"""Build an independent snapshot from the vendored CSVs, never from the public API."""
import json
import hashlib
import os
from pathlib import Path
import sys
import shutil
import tempfile
import subprocess

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / 'vendor/pokeapi'
sys.path.insert(0, str(UPSTREAM))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.local')
# Use the versioned manifest without contacting GitHub at build time.
os.environ['POKEAPI_SPRITES_MANIFEST_URL'] = (UPSTREAM / 'data/v2/manifest.json.gz').as_uri()
import django

django.setup()
from django.core.management import call_command
from django.test import Client
from django.test.utils import override_settings

ORIGIN = 'https://snapshot.invalid'
PUBLIC = ROOT / 'public'
GENERATED = ROOT / 'src/generated'
PUBLIC.mkdir(exist_ok=True)
GENERATED.mkdir(parents=True, exist_ok=True)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(',', ':'), ensure_ascii=False))


def build():
    lock = json.loads((ROOT / 'upstream.lock.json').read_text())
    manifest = UPSTREAM / 'data/v2/manifest.json.gz'
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != lock['sprites_manifest_sha256']:
        raise RuntimeError('The sprite manifest does not match upstream.lock.json')
    if not (UPSTREAM / '.snapshot-db-ready').exists():
        call_command('migrate', verbosity=0)
        from data.v2.build import build_all
        build_all()
        (UPSTREAM / '.snapshot-db-ready').touch()
    # Apply on every build, including when the upstream SQLite snapshot is cached.
    from localize_moves import apply_move_translations
    apply_move_translations()
    client = Client(SERVER_NAME='snapshot.invalid', wsgi_url_scheme='https')
    def get(path):
        response = client.get(path, secure=True)
        if response.status_code != 200:
            raise RuntimeError(f'{path}: {response.status_code} {response.content[:300]}')
        return response.json()
    with override_settings(ALLOWED_HOSTS=['snapshot.invalid'], DEBUG=False):
        endpoints = get('/api/v2/')
        write(PUBLIC / 'data/root.json', endpoints)
        write(PUBLIC / 'data/meta.json', get('/api/v2/meta/'))
        shutil.copyfile(ROOT / 'contracts/graphql.schema.graphql', PUBLIC / 'schema.graphql')
        shutil.copyfile(ROOT / 'deploy/graphiql.html', PUBLIC / 'graphiql.html')
        resources = sorted(k for k in endpoints if k != 'meta')
        total = 0
        for resource in resources:
            listing = get(f'/api/v2/{resource}/?limit=100000')
            entries = listing['results']
            index = {'results': entries, 'names': {}, 'shards': {}}
            shard, size, number = {}, 0, 0
            for position, entry in enumerate(entries, 1):
                path = entry['url'].removeprefix(ORIGIN)
                key = path.rstrip('/').split('/')[-1]
                body = get(path)
                encoded = json.dumps(body, ensure_ascii=False)
                # Keep each shard comfortably below the 25 MiB asset limit.
                if shard and size + len(encoded.encode()) > 128_000:
                    write(PUBLIC / f'data/{resource}/{number}.json', shard)
                    shard, size, number = {}, 0, number + 1
                index['shards'][key] = number
                if 'name' in entry:
                    index['names'][entry['name']] = key
                shard[key] = body
                size += len(encoded.encode())
                if position % 100 == 0:
                    print(f'{resource}: {position}/{len(entries)}', flush=True)
            if shard:
                write(PUBLIC / f'data/{resource}/{number}.json', shard)
            write(PUBLIC / f'data/{resource}/index.json', index)
            total += len(entries)
            print(f'{resource}: {len(entries)}', flush=True)
        # The REST encounter route is not a top-level collection.
        pokemon = json.loads((PUBLIC / 'data/pokemon/index.json').read_text())
        encounter_index = {'names': {}, 'shards': {}}
        shard, size, number = {}, 0, 0
        for key in pokemon['shards']:
            body = get(f'/api/v2/pokemon/{key}/encounters')
            encoded = json.dumps(body, ensure_ascii=False)
            if shard and size + len(encoded.encode()) > 128_000:
                write(PUBLIC / f'data/encounters/{number}.json', shard)
                shard, size, number = {}, 0, number + 1
            encounter_index['shards'][key] = number
            shard[key] = body
            size += len(encoded.encode())
        if shard:
            write(PUBLIC / f'data/encounters/{number}.json', shard)
        write(PUBLIC / 'data/encounters/index.json', encounter_index)
        write(GENERATED / 'catalog.json', resources)
        (GENERATED / 'catalog.js').write_text('export default ' + json.dumps(resources) + ';\n')
        report = {'source': json.loads((ROOT / 'upstream.lock.json').read_text()), 'resources': len(resources), 'records': total}
        write(PUBLIC / 'snapshot.json', report)
        files = list(PUBLIC.rglob('*'))
        files = [p for p in files if p.is_file()]
        if len(files) > 20000 or any(p.stat().st_size > 25 * 1024 * 1024 for p in files):
            raise RuntimeError('Snapshot exceeds Cloudflare Free static asset limits')
        print(f'Snapshot: {total} records, {len(files)} files', flush=True)


def main():
    global PUBLIC, GENERATED
    # Publish outputs only after the complete snapshot passes validation.
    with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=ROOT) as directory:
        PUBLIC = Path(directory) / 'public'
        GENERATED = Path(directory) / 'generated'
        PUBLIC.mkdir()
        GENERATED.mkdir()
        build()
        subprocess.run([sys.executable, str(ROOT / 'scripts/build_relational_catalog.py'), str(GENERATED / 'relational.json')], check=True)
        for source, target in [(PUBLIC, ROOT / 'public'), (GENERATED, ROOT / 'src/generated')]:
            if target.exists():
                shutil.rmtree(target)
            source.rename(target)


if __name__ == '__main__':
    main()
