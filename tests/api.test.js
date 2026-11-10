import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { buildSchema, parse, validate } from 'graphql';
import worker, { store } from '../src/worker.js';

const contract = JSON.parse(await readFile(new URL('../contracts/rest.contract.json', import.meta.url)));
const asset = async request => {
  try { return new Response(await readFile(new URL('../public' + new URL(request.url).pathname, import.meta.url))); }
  catch { return new Response(null, { status: 404 }); }
};
const env = { ASSETS: { fetch: asset } };
const call = (path, init, bindings = env) => worker.fetch(new Request('https://pokemon.example' + path, init), bindings);

test('every move exposes a Brazilian Portuguese description without replacing English', async () => {
  const folder = new URL('../public/data/move/', import.meta.url);
  const index = JSON.parse(await readFile(new URL('index.json', folder)));
  let count = 0;
  for (const shard of new Set(Object.values(index.shards))) {
    const moves = JSON.parse(await readFile(new URL(`${shard}.json`, folder)));
    for (const move of Object.values(moves)) {
      const descriptions = move.flavor_text_entries.filter(entry => entry.language.name === 'pt-br');
      assert.ok(descriptions.length >= 1, move.name);
      for (const description of descriptions) assert.ok(description.flavor_text.trim(), move.name);
      for (const english of move.flavor_text_entries.filter(entry => entry.language.name === 'en')) {
        assert.ok(descriptions.some(entry => entry.version_group.name === english.version_group.name),
          `${move.name}: ${english.version_group.name}`);
      }
      if (move.effect_entries.some(entry => entry.language.name === 'en')) {
        const effect = move.effect_entries.find(entry => entry.language.name === 'pt-br');
        assert.ok(effect?.short_effect.trim(), move.name);
        assert.equal(effect.effect, effect.short_effect, move.name);
      }
      count++;
    }
  }
  assert.equal(count, Object.keys(index.shards).length);
  const ember = await (await call('/api/v2/move/ember/')).json();
  assert.equal(ember.effect_entries.find(entry => entry.language.name === 'pt-br').short_effect, 'Pode queimar o alvo.');
  assert.ok(ember.effect_entries.find(entry => entry.language.name === 'en').short_effect.includes('burn'));
  const recent = await (await call('/api/v2/move/malignant-chain/')).json();
  assert.match(recent.flavor_text_entries.find(entry => entry.language.name === 'pt-br').flavor_text, /envenená-lo gravemente/);
});

test('all localized REST descriptions have a Brazilian Portuguese entry', async () => {
  const descriptive = ['description', 'effect', 'short_effect', 'flavor_text', 'genus', 'flavor', 'awesome_name'];
  let checked = 0;
  const inspect = (value, path) => {
    if (Array.isArray(value)) {
      for (const english of value.filter(entry => entry?.language?.name === 'en')) {
        if (!descriptive.some(field => typeof english[field] === 'string' && english[field].trim())) continue;
        const portuguese = value.find(entry => entry?.language?.name === 'pt-br'
          && entry.version?.name === english.version?.name
          && entry.version_group?.name === english.version_group?.name);
        assert.ok(portuguese, path);
        for (const field of descriptive) {
          if (typeof english[field] === 'string' && english[field].trim()) {
            assert.ok(portuguese[field]?.trim(), `${path}.${field}`);
          }
        }
        checked++;
      }
      value.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) inspect(entry, `${path}.${key}`);
    }
  };
  const root = new URL('../public/data/', import.meta.url);
  for (const folder of await readdir(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const resource = new URL(`${folder.name}/`, root);
    for (const file of await readdir(resource)) {
      if (!/^\d+\.json$/.test(file)) continue;
      inspect(JSON.parse(await readFile(new URL(file, resource))), `${folder.name}/${file}`);
    }
  }
  assert.ok(checked > 5000, `Expected catalog-wide coverage, found ${checked}`);
  const ability = await (await call('/api/v2/ability/limber/')).json();
  assert.match(ability.effect_entries.find(entry => entry.language.name === 'pt-br').short_effect, /paralis/i);
  const species = await (await call('/api/v2/pokemon-species/bulbasaur/')).json();
  assert.match(species.flavor_text_entries.find(entry => entry.language.name === 'pt-br').flavor_text, /semente/i);
});

// These expectations were captured by running the unchanged PokeAPI/deploy helpers.
test('public REST root includes exactly all 51 official entries, including meta', async () => {
  const root = await (await call('/api/v2/')).json();
  assert.deepEqual(Object.keys(root).sort(), contract.endpoints.toSorted());
  for (const [key, url] of Object.entries(root)) assert.equal(url, `https://pokemon.example/api/v2/${key}/`);
});

test('every official REST collection supports ID, name and uppercase names', async () => {
  for (const resource of contract.endpoints.filter(x => x !== 'meta')) {
    const page = await (await call(`/api/v2/${resource}/?limit=1`)).json();
    assert.ok(page.count > 0, resource);
    assert.equal(page.results.length, 1, resource);
    const item = await call(new URL(page.results[0].url).pathname);
    assert.equal(item.status, 200, resource);
    const body = await item.json();
    assert.ok(Number.isInteger(body.id), resource);
    if (page.results[0].name) {
      const byName = await call(`/api/v2/${resource}/${page.results[0].name.toUpperCase()}/`);
      assert.equal(byName.status, 200, resource);
      assert.deepEqual(await byName.json(), body, resource);
    }
  }
});

test('pagination matches all 60 fixtures from the official public deployment', async () => {
  for (const example of contract.pagination) {
    const entries = Array.from({ length: example.count }, (_, i) => ({ name: `pokemon-${i}`, url: `https://pokemon.example/api/v2/pokemon/${i}/` }));
    const fixtureEnv = { ASSETS: { fetch: async () => new Response(JSON.stringify({ results: entries })) } };
    const page = await store(fixtureEnv, 'https://pokemon.example').list('pokemon', new URL('https://pokemon.example/api/v2/pokemon/?' + example.query));
    assert.deepEqual(page, { count: example.count, next: example.next, previous: example.previous, results: example.indices.map(i => entries[i]) }, `${example.count}: ${example.query}`);
  }
  const big = await (await call('/api/v2/pokemon/?limit=100000')).json();
  assert.equal(big.results.length, big.count);
  const filtered = await (await call('/api/v2/pokemon/?limit=1&q=char')).json();
  assert.equal(filtered.results[0].name, 'bulbasaur', 'q is ignored by the public API');
});

test('metadata has the official shape, separate from project provenance', async () => {
  const response = await call('/api/v2/meta/');
  const meta = await response.json();
  assert.deepEqual(Object.keys(meta).sort(), ['deploy_date', 'hash', 'tag']);
  for (const value of Object.values(meta)) assert.ok(value === null || typeof value === 'string');
  if (meta.hash != null) assert.equal(response.headers.get('x-pokeapi-hash'), meta.hash);
  const provenance = await (await call('/snapshot.json')).json();
  assert.equal(provenance.source.commit.length, 40);
});

test('REST errors use the public deployment status and JSON envelope', async () => {
  for (const [path, status, message] of [
    ['/api/v2/missing/', 400, 'Invalid endpoint'],
    ['/api/v2/missing/1/', 400, 'Invalid endpoint or resource formatting'],
    ['/api/v2/pokemon/pika%20chu/', 400, 'Invalid endpoint or resource formatting'],
    ['/api/v2/pokemon/25/invalid/', 400, 'Invalid path'],
    ['/api/v2/missing/25/invalid/', 400, 'Invalid path'],
    ['/api/v2/pokemon/missing/', 404, 'Not Found'],
    ['/api/v2/pokemon/025/', 404, 'Not Found'],
    ['/api/v2/pokemon/999999/', 404, 'Not Found'],
    ['/data/pokemon/index.json', 404, 'Not Found'],
  ]) {
    const response = await call(path);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { status, message }, path);
  }
});

test('encounters, legacy redirect, CORS, HEAD and POST-only GraphQL', async () => {
  const response = await call('/api/v2/pokemon/1/encounters');
  assert.equal(response.status, 200);
  assert.match((await response.json())[0].location_area.url, /^https:\/\/pokemon.example\//);
  assert.equal((await call('/api/v2/pokemon/999999/encounters')).status, 404);
  const head = await call('/api/v2/', { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/api/v2/', { method: 'OPTIONS' })).status, 204);
  const redirect = await call('/api/v1/pokemon/25?limit=1');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), 'https://pokemon.example/api/v2/pokemon/25?limit=1');
  assert.equal((await call('/v1beta2')).status, 405);
  assert.equal((await call('/v1beta2', { method: 'OPTIONS' })).status, 204);
});

test('GraphQL forwards the original operation and response without schema translation', async () => {
  const body = JSON.stringify({ query: 'query($id:Int!){ pokemon(where:{id:{_eq:$id}}){id name} }', variables: { id: 25 }, operationName: null });
  for (const path of ['/v1beta2', '/v1beta2/', '/graphql']) {
    const bindings = { HASURA_GRAPHQL_URL: 'https://own-graphql.example/v1/graphql', GRAPHQL_FETCH: async request => {
      assert.equal(request.url, 'https://own-graphql.example/v1/graphql');
      assert.equal(await request.text(), body);
      assert.equal(request.headers.get('x-hasura-role'), 'anon');
      assert.equal(request.headers.get('x-hasura-admin-secret'), null);
      assert.equal(request.headers.get('authorization'), null);
      return new Response('{"data":{"pokemon":[{"id":25,"name":"pikachu"}]}}', { headers: { 'content-type': 'application/json' } });
    } };
    const response = await call(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': 'client-secret', 'x-hasura-role': 'admin' }, body }, bindings);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { pokemon: [{ id: 25, name: 'pikachu' }] } });
  }
  assert.equal((await call('/v1beta2', { method: 'POST', body })).status, 503, 'no fallback to the public PokeAPI or incompatible schema');
});

test('GraphQL backend errors preserve status and body', async () => {
  const errorBody = '{"errors":[{"extensions":{"code":"validation-failed","path":"$.selectionSet.missing"},"message":"field missing not found"}]}';
  const response = await call('/v1beta2', { method: 'POST', body: '{}' }, { HASURA_GRAPHQL_URL: 'https://own.example/v1/graphql', GRAPHQL_FETCH: async () => new Response(errorBody, { status: 400 }) });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), errorBody);
});

test('the committed official anonymous schema accepts every upstream GraphQL example', async () => {
  const schema = buildSchema(await readFile(new URL('../contracts/graphql.schema.graphql', import.meta.url), 'utf8'));
  assert.ok(schema.getQueryType().getFields().pokemon_aggregate);
  assert.equal(schema.getMutationType(), undefined);
  const directory = new URL('../vendor/pokeapi/graphql/v1beta2/examples/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.gql')) continue;
    const source = (await readFile(new URL(name, directory), 'utf8')).replace(/^"""[\s\S]*?"""\s*/, '');
    assert.deepEqual(validate(schema, parse(source)).map(e => e.message), [], name);
  }
});
