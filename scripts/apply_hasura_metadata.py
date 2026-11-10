"""Apply the unchanged official v1beta2 metadata to a Hasura instance you own."""
import json
import os
from pathlib import Path
import urllib.request
import yaml

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / 'vendor/pokeapi/graphql/v1beta2/metadata'


def load(path):
    path = path.resolve()
    if not path.is_relative_to(METADATA.resolve()):
        raise ValueError('Metadata include outside the metadata directory')
    def resolve(value):
        if isinstance(value, str) and value.startswith('!include '):
            return load(path.parent / value.removeprefix('!include '))
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        return value
    return resolve(yaml.safe_load(path.read_text()))


def main():
    url = os.environ.get('HASURA_GRAPHQL_URL', 'http://localhost:8080/v1/graphql')
    secret = os.environ.get('HASURA_GRAPHQL_ADMIN_SECRET')
    if not secret:
        raise SystemExit('Set HASURA_GRAPHQL_ADMIN_SECRET for your own Hasura instance.')
    metadata = {p.stem: load(p) for p in METADATA.glob('*.yaml') if p.stem not in ('actions', 'version', 'allow_list')}
    metadata = {key: value for key, value in metadata.items() if value != {}}
    metadata.update(load(METADATA / 'version.yaml'))
    metadata.update(load(METADATA / 'actions.yaml'))
    metadata['allowlist'] = load(METADATA / 'allow_list.yaml')
    metadata['sources'] = load(METADATA / 'databases/databases.yaml')
    payload = {'type': 'replace_metadata', 'args': {'allow_inconsistent_metadata': False, 'metadata': metadata}}
    request = urllib.request.Request(url.replace('/v1/graphql', '/v1/metadata'), data=json.dumps(payload).encode(), headers={'content-type': 'application/json', 'x-hasura-admin-secret': secret})
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.load(response)
    if result.get('is_consistent') is False:
        raise SystemExit('Hasura reported inconsistent metadata')
    print(f'Official metadata applied: {len(metadata["sources"][0]["tables"])} tables')


if __name__ == '__main__':
    main()
