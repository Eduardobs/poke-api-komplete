"""Stream authoritative detail responses from the unchanged, vendored Django API."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/pokeapi'))
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.local'
import django

django.setup()
from django.test import Client
from django.test.utils import override_settings

parser = argparse.ArgumentParser()
parser.add_argument('--full', action='store_true')
args = parser.parse_args()
client = Client(SERVER_NAME='pokemon.example')


def get(path):
    response = client.get(path, secure=True)
    assert response.status_code == 200, path
    return response.json()


def emit(path, body):
    print(json.dumps({'path': path, 'body': body}, ensure_ascii=False, separators=(',', ':')), flush=True)


with override_settings(ALLOWED_HOSTS=['pokemon.example'], DEBUG=False):
    root = get('/api/v2/')
    emit('/api/v2/', root)
    emit('/api/v2/meta/', get('/api/v2/meta/'))
    for resource in sorted(set(root) - {'meta'}):
        path = f'/api/v2/{resource}/?limit=100000'
        collection = get(path)
        emit(path, collection)
        entries = collection['results']
        if not args.full:
            entries = entries[:1] + entries[-1:]
        for entry in entries:
            path = entry['url'].removeprefix('https://pokemon.example')
            emit(path, get(path))
            if resource == 'pokemon':
                encounter_path = path + 'encounters'
                emit(encounter_path, get(encounter_path))
