// Run against a real Hasura instance with the official metadata and seeded data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildClientSchema, getIntrospectionQuery, lexicographicSortSchema, printSchema, getNamedType, isListType, isNonNullType } from 'graphql';
import worker from '../src/worker.js';

const target = process.env.HASURA_GRAPHQL_URL;
if (!target) throw new Error('Integration tests require HASURA_GRAPHQL_URL; they must not silently skip.');
const env = { HASURA_GRAPHQL_URL: target };
const post = body => worker.fetch(new Request('https://pokemon.example/v1beta2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
const direct = body => fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hasura-role': 'anon' }, body: JSON.stringify(body) });

async function equivalent(body) {
  const reference = await direct(body);
  const expected = await reference.json();
  const response = await post(body);
  assert.equal(response.status, reference.status);
  const actual = await response.json();
  assert.deepEqual(actual, expected);
  return actual;
}

let schema;
test('full anonymous introspection exactly matches the official schema contract', async () => {
  const result = await equivalent({ query: getIntrospectionQuery() });
  assert.equal(result.errors, undefined);
  schema = lexicographicSortSchema(buildClientSchema(result.data));
  assert.equal(printSchema(schema) + '\n', await readFile(new URL('../contracts/graphql.schema.graphql', import.meta.url), 'utf8'));
  assert.equal(Object.keys(schema.getQueryType().getFields()).length, 327);
});

test('every official GraphQL root field executes against real PostgreSQL data', async () => {
  for (const field of Object.values(schema.getQueryType().getFields())) {
    const type = isNonNullType(field.type) ? field.type.ofType : field.type;
    let query;
    if (isListType(type)) query = `{ ${field.name}(limit:1,order_by:{id:asc}){id} }`;
    else if (getNamedType(type).getFields()?.aggregate) query = `{ ${field.name}{aggregate{count}} }`;
    else if (field.name.endsWith('_by_pk')) query = `{ ${field.name}(id:-2147483647){id} }`;
    else throw new Error('Uncovered root: ' + field.name);
    const result = await equivalent({ query });
    assert.equal(result.errors, undefined, `${field.name}: ${JSON.stringify(result.errors)}`);
    assert.ok(Object.hasOwn(result.data, field.name));
  }
});

test('relations, aggregate ordering, filters, distinct_on, variables and JSON paths work', async () => {
  const result = await equivalent({ query: `query Named($name:String!){
    selected:pokemon(where:{name:{_eq:$name}},limit:1){id name pokemontypes(order_by:{slot:asc}){slot type{name}}}
    pokemon_aggregate(where:{is_default:{_eq:true}}){aggregate{count avg{height}}}
    distinct:pokemon(distinct_on:[name],order_by:[{name:asc}],limit:2,offset:1){id name}
    pokemonsprites(where:{pokemon_id:{_eq:25}}){sprites(path:"front_default")}
  }`, variables: { name: 'pikachu' }, operationName: 'Named' });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.data.selected[0].id, 25);
  assert.equal(result.data.selected[0].pokemontypes[0].type.name, 'electric');
  assert.ok(result.data.pokemon_aggregate.aggregate.count > 1000);
  assert.equal(result.data.distinct.length, 2);
  assert.match(result.data.pokemonsprites[0].sprites, /25\.png$/);
});

test('official errors and anonymous read-only permissions are preserved', async () => {
  for (const query of ['{ pokemon(id:25){name} }', '{ unknown_field }', 'mutation { delete_pokemon(where:{id:{_eq:25}}){affected_rows} }']) {
    const result = await equivalent({ query });
    assert.ok(result.errors?.length);
  }
  const missing = await equivalent({ query: '{ pokemon(where:{id:{_eq:999999}}){id} }' });
  assert.deepEqual(missing.data.pokemon, []);
});
