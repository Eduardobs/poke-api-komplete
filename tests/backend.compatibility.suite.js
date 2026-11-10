import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { getIntrospectionQuery, isListType, isNonNullType, getNamedType, parse, Kind } from 'graphql';
import { createGraphQL, schema } from '../src/backend/graphql.js';

if (!process.env.DATABASE_URL || !process.env.REFERENCE_GRAPHQL_URL) throw new Error('Set DATABASE_URL and REFERENCE_GRAPHQL_URL to the independent Hasura reference.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: '-c default_transaction_read_only=on' });
const originalQuery = pool.query.bind(pool);
pool.query = async (...args) => { try { return await originalQuery(...args); } catch (e) { console.error('Candidate SQL error:', e.message, 'position:', e.position); throw e; } };
const engine = createGraphQL({ pool, responseTtlMs: 0 });
let comparisons = 0;
async function compare(query, variables, operationName) {
  const input = typeof query === 'object' ? query : { query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) };
  const label = typeof query === 'string' ? query : JSON.stringify(query);
  const reference = await fetch(process.env.REFERENCE_GRAPHQL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const expected = await reference.json();
  const candidate = await engine.run(input);
  const actual = candidate.json ? JSON.parse(candidate.json) : candidate.body;
  assert.equal(candidate.status, reference.status, label);
  // Assertion formatters can allocate enormous strings for the full schema.
  // Report the first mismatch instead of rendering both multi-megabyte trees.
  if (!isDeepStrictEqual(actual, expected)) {
    const firstDifference = (a, b, path = '$') => {
      if (Object.is(a, b)) return null;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
          if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${path}.${key}: missing key`;
          const mismatch = firstDifference(a[key], b[key], `${path}.${key}`);
          if (mismatch) return mismatch;
        }
      }
      return `${path}: values differ`;
    };
    assert.fail(`${label.slice(0, 500)}\n${firstDifference(actual, expected)}`);
  }
  comparisons++;
  return actual;
}
test.after(async () => { await pool.end(); console.log(`Compared ${comparisons} GraphQL requests against independent Hasura`); });

test('candidate preserves the complete official introspection response', async () => { await compare(getIntrospectionQuery()); });

test('candidate executes every official root field', async () => {
  for (const field of Object.values(schema.getQueryType().getFields())) {
    const type = isNonNullType(field.type) ? field.type.ofType : field.type;
    let query;
    if (isListType(type)) query = `{ ${field.name}(limit:1,order_by:{id:asc}){id} }`;
    else if (getNamedType(type).getFields()?.aggregate) query = `{ ${field.name}{aggregate{count}} }`;
    else query = `{ ${field.name}(id:-2147483647){id} }`;
    await compare(query);
  }
});

test('candidate executes every public relationship', async () => {
  for (const [table, config] of Object.entries(engine.catalog)) for (const [name, relation] of Object.entries(config.relations)) {
    await compare(`{ ${table}(where:{${name}:{}},limit:1,order_by:{id:asc}){id ${name}${relation.many ? '(limit:1,order_by:{id:asc})' : ''}{id}} }`);
  }
});

test('every public column matches the reference data and scalar types', async () => {
  for (const [table,config] of Object.entries(engine.catalog)) await compare(`{${table}(limit:1,order_by:{id:asc}){${Object.keys(config.columns).join(' ')}}}`);
});

test('every exposed relationship aggregation matches the reference', async () => {
  for (const [table,config] of Object.entries(engine.catalog)) for (const name of Object.keys(config.relations)) {
    if (schema.getType(table).getFields()[name+'_aggregate']) await compare(`{${table}(where:{${name}:{}},limit:1,order_by:{id:asc}){id ${name}_aggregate{aggregate{count}}}}`);
  }
});

test('official example operations remain valid and return equivalent data', async () => {
  const directory = new URL('../vendor/pokeapi/graphql/v1beta2/examples/', import.meta.url);
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.gql')) continue;
    const query = (await readFile(new URL(file, directory), 'utf8')).replace(/^"""[\s\S]*?"""\s*/, '');
    for (const op of parse(query).definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION)) await compare(query, op.variableDefinitions?.length ? { region: 'alola' } : undefined, op.name?.value);
  }
});

test('combinations of filters, sorting, aggregates, JSON and directives match', async () => {
  const queries = [
    '{ pokemon(where:{_and:[{id:{_gte:20}},{id:{_lte:30}}],_not:{name:{_like:"%chu"}}},order_by:[{height:desc_nulls_last},{id:asc}],limit:5,offset:1){id name height} }',
    '{ pokemon(where:{name:{_iregex:"^pika"}},limit:5){id name} }',
    '{ pokemon(where:{name:{_similar:"pika%"}},limit:5){id name} }',
    '{ pokemon(distinct_on:[height],order_by:[{height:desc},{id:asc}],limit:5){id height} }',
    '{ pokemon(order_by:{pokemonspecy:{generation_id:desc}},limit:1){id} }',
    '{ pokemon(order_by:[{pokemonstats_aggregate:{sum:{base_stat:desc}}},{id:asc}],limit:3){id name} }',
    '{ pokemon(where:{pokemonstats_aggregate:{count:{filter:{base_stat:{_gt:50}},predicate:{_gte:4}}}},order_by:{id:asc},limit:3){id name} }',
    '{ pokemon_aggregate(where:{id:{_lte:100}},order_by:{id:asc},limit:10,offset:2){nodes{id} aggregate{count a:count(columns:[name,base_experience],distinct:true) avg{height} sum{weight} stddev{height} var_pop{height} variance{height} max{name} min{id}}} }',
    '{ pokemonsprites(where:{sprites:{_has_key:"front_default",_contains:{front_default:"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png"}}}){id sprites(path:"$.front_default")} }',
    '{ pokemonsprites(where:{sprites:{_has_keys_any:["front_female","bad"]}},limit:1){id sprites(path:"other[\"official-artwork\"].front_default")} }',
    '{ pokemonsprites(where:{sprites:{_jsonb_path_exists:"$.front_default"}},limit:1){id} }',
    'query A($id:Int!,$show:Boolean!){ p:pokemon(where:{id:{_eq:$id}}){ ...P name @include(if:$show) hidden:name @skip(if:$show) a:typesAlias: name } } fragment P on pokemon {id}',
    '{ pokemon(where:{id:{_in:[]}},limit:1){id} pokemon_aggregate(limit:0){nodes{id} aggregate{count avg{height}}} }',
  ];
  // Correct aliases are deliberately exercised with distinct arguments on one field.
  queries[11] = 'query A($id:Int!,$show:Boolean!){p:pokemon(where:{id:{_eq:$id}}){...P name @include(if:$show) hidden:name @skip(if:$show) a:pokemonstats(limit:1,order_by:{id:asc}){id} b:pokemonstats(limit:2,order_by:{id:asc}){id}}} fragment P on pokemon{id}';
  for (const query of queries) await compare(query, query.startsWith('query A') ? { id: 25, show: true } : undefined);
});

test('official validation and database errors match', async () => {
  const queries = ['{ unknown_field }','{ pokemon(id:25){name} }','{ pokemon{wrong} }','{ pokemon(limit:-1){id} }','{ pokemon(offset:-1,limit:1){id} }','{ pokemon(where:{id:{_eq:null}}){id} }','mutation { delete_pokemon(where:{id:{_eq:25}}){affected_rows} }','subscription { itemprice {id} }','query($x:Int!){pokemon(limit:$x){id}}','{ pokemon(limit:"x"){id} }','not valid','{ pokemon(distinct_on:[name],order_by:{id:asc},limit:1){id} }','{ pokemonsprites(limit:1){sprites(path:"foo[bad]")} }','{ pokemon(where:{name:{_regex:"["}}){id} }'];
  for (const query of queries) await compare(query);
});

test('one PostgreSQL round trip covers all roots and nested selections', async () => {
  const before = engine.metrics.sqlStatements;
  await compare('{pokemon(limit:2,order_by:{id:asc}){id pokemonstats(order_by:{id:asc}){id stat{name}}} type(limit:2,order_by:{id:asc}){id name}}');
  assert.equal(engine.metrics.sqlStatements - before, 1);
});

test('additional coercion, variables, selection and transport errors match', async () => {
  const inputs = [
    {query:'{pokemon(where:{id:{_eq:"x"}}){id}}'},
    {query:'{pokemon(where:{id:{_eq:"25"}}){id name}}'},
    {query:'{pokemon(limit:2147483648){id}}'},
    {query:'{pokemon(limit:1.5){id}}'},
    {query:'{pokemon(limit:null,offset:null,where:null){id}}'},
    {query:'{pokemon(where:{id:{_in:[1,null]}}){id}}'},
    {query:'{pokemon(where:{_or:null},limit:1){id}}'},
    {query:'{pokemon(where:{name:null},limit:1){id}}'},
    {query:'{pokemon(where:{_not:null},limit:1){id}}'},
    {query:'{pokemon(where:{id:{_eq:1}},order_by:{id:null}){id}}'},
    {query:'query($x:Int!){pokemon(limit:$x){id}}',variables:{x:null}},
    {query:'query($x:Int){pokemon(limit:$x){id}}',variables:{x:'x'}},
    {query:'query A{pokemon(limit:1){id}}',operationName:'Bad'},
    {query:'query A{pokemon(limit:1){id}} query B{type(limit:1){id}}'},
    {query:'{pokemon}'}, {query:'{pokemon{ id {name} }}'}, {query:'{itemprice_by_pk{id}}'},
    {query:'{pokemon @bad {id}}'}, {query:'query($x:Int){pokemon(limit:1){id}}'},
    {query:'{pokemon(order_by:{id:bad}){id}}'}, {query:'{pokemon(where:{id:{bad:1}}){id}}'},
    {query:'{pokemon(limit:1){...Bad}}'}, {query:'{pokemon(limit:1){id}}',variables:[]},
    {query:'{pokemon(limit:1){id}}',variables:'bad'},
    {query:'{__typename __type(name:"pokemon"){name fields{name}}}'},
    {query:'query($id:Int=25){pokemon(where:{id:{_eq:$id}}){id name}}'},
  ];
  for (const input of inputs) await compare(input.query, input.variables, input.operationName);
});

test('all numeric aggregates, scalar comparisons and aliases match', async () => {
  for (const fn of ['avg','sum','min','max','stddev','stddev_pop','stddev_samp','var_pop','var_samp','variance']) {
    await compare(`{pokemon_aggregate(where:{id:{_lte:10}}){aggregate{${fn}{height weight}}}}`);
  }
  for (const op of ['_eq','_neq','_gt','_gte','_lt','_lte']) await compare(`{pokemon(where:{height:{${op}:10}},order_by:{id:asc},limit:2){id height}}`);
  for (const op of ['_like','_nlike','_ilike','_nilike','_regex','_nregex','_iregex','_niregex','_similar','_nsimilar']) await compare(`{pokemon(where:{name:{${op}:"pika%"}},order_by:{id:asc},limit:2){id name}}`);
  await compare('{pokemon_aggregate(where:{id:{_lt:0}}){aggregate{count(columns:[name,base_experience],distinct:true) sum{height}}} a:pokemon(limit:0){id}}');
  await compare('{pokemon_aggregate{aggregate{count(columns:[base_experience]) a:count(columns:[base_experience,name],distinct:true) b:count(columns:[base_experience,name]) c:count(columns:[base_experience,height],distinct:true)}}}');
  await compare('{pokemon_aggregate(where:{base_experience:{_is_null:true}}){aggregate{count a:count(columns:[base_experience,name],distinct:true) b:count(columns:[base_experience,name])}}}');
  await compare('query($show:Boolean!){pokemon(where:{id:{_eq:25}}){id name @include(if:$show) stats:pokemonstats(order_by:{id:asc}){...S ... on pokemonstat {stat{name}}}}} fragment S on pokemonstat {base_stat}', {show:false});
});

test('successful anonymous responses are cached and errors are not cached', async () => {
  const cached = createGraphQL({pool});
  const input = {query:'{pokemon(where:{id:{_eq:25}}){id name}}'};
  assert.equal((await cached.run(input)).cache, 'MISS');
  assert.equal((await cached.run(input)).cache, 'HIT');
  assert.equal(cached.metrics.sqlStatements, 1);
  for (let i=0;i<2;i++) assert.ok((await cached.run({query:'{unknown_field}'})).body.errors);
  assert.equal(cached.metrics.responseCacheHits, 1);
});

test('official request envelopes, batches and PostgreSQL integer coercion match', async () => {
  for (const input of [
    {},[],null,{query:null},{query:12},{query:''},
    {query:'{__typename}',operationName:12},{query:'{__typename}',operationName:''},
    {query:'{__typename}',operationName:'not valid'},
    {query:'{__typename}',variables:12},{query:'{__typename}',variables:null},
    [{query:'{__typename}'},{query:'{pokemon(where:{id:{_eq:25}}){id name}}'}],
    [{query:'{__typename}'},{query:'{bad}'}],
    [{},{query:'{__typename}'}],[[{query:'{__typename}'}]],
    {query:'{pokemon(where:{is_default:{_eq:"true"}},limit:1){id}}'},
    {query:'{pokemon(where:{id:{_eq:25.5}}){id}}'},
    {query:'{pokemon(where:{id:{_eq:2147483648}}){id}}'},
    {query:'{pokemon(where:{id:{_eq:true}}){id}}'},
    {query:'{pokemon(where:{id:{_eq:"2147483648"}}){id}}'},
    {query:'query($x:Int!){pokemon(where:{id:{_eq:$x}}){id}}',variables:{x:'25'}},
  ]) await compare(input);
});
