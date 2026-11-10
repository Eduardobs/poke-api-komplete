import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createApp} from '../src/backend/server.js';

if (!process.env.DATABASE_URL || !process.env.REFERENCE_GRAPHQL_URL) throw new Error('Set DATABASE_URL and REFERENCE_GRAPHQL_URL for HTTP tests.');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,options:'-c default_transaction_read_only=on'});
const app = createApp({pool});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
test.after(async()=>{await new Promise(resolve=>{app.server.close(resolve);app.server.closeIdleConnections();});await pool.end();});

test('standalone HTTP service serves the full REST contract and its own URLs',async()=>{
  const root = await (await fetch(origin+'/api/v2/')).json();
  assert.equal(Object.keys(root).length,51);
  assert.equal(root.pokemon,origin+'/api/v2/pokemon/');
  const pokemon = await (await fetch(origin+'/api/v2/pokemon/pikachu/')).json();
  assert.equal(pokemon.id,25);
  assert.ok(pokemon.species.url.startsWith(origin+'/api/v2/'));
  const head = await fetch(origin+'/api/v2/pokemon/25/',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(origin+'/v1beta2/console/')).status,200);
  assert.equal((await fetch(origin+'/healthz')).status,200);
});

test('HTTP GraphQL matches independent reference, including aliases and errors',async()=>{
  for (const input of [
    {query:'query($id:Int!){p:pokemon(where:{id:{_eq:$id}}){id name pokemontypes(order_by:{id:asc}){type{name}}} pokemon_aggregate{aggregate{count}}}',variables:{id:25}},
    {query:'{__schema{queryType{name} mutationType{name}} __type(name:"pokemon"){name}}'},
    {query:'{pokemon(limit:-1){id}}'},
    {query:'{pokemon(where:{name:{_eq:"x\u0027 OR 1=1 --"}}){id}}'},
    {query:'mutation {delete_pokemon(where:{id:{_eq:25}}){affected_rows}}'},
  ]) {
    const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)};
    const expected=await fetch(process.env.REFERENCE_GRAPHQL_URL,options);
    const actual=await fetch(origin+'/v1beta2',options);
    assert.equal(actual.status,expected.status);
    assert.deepEqual(await actual.json(),await expected.json());
    assert.equal(actual.headers.get('access-control-allow-origin'),'*');
  }
});

test('HTTP aliases share backend cache; errors do not enter cache',async()=>{
  const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{type(limit:1,order_by:{id:asc}){id name}}'})};
  const first=await fetch(origin+'/v1beta2',options);await first.text();
  assert.equal(first.headers.get('x-poke-backend-cache'),'MISS');
  const second=await fetch(origin+'/graphql',options);await second.text();
  assert.equal(second.headers.get('x-poke-backend-cache'),'HIT');
  const invalid=await fetch(origin+'/v1beta2',{...options,body:'{"query":"{unknown}"}'});await invalid.text();
  assert.equal(invalid.headers.get('x-poke-cacheable'),null);
  assert.equal((await fetch(origin+'/v1beta2')).status,405);
  assert.equal((await fetch(origin+'/v1beta2',{method:'OPTIONS'})).status,204);
});

test('malformed JSON errors match the legacy HTTP protocol',async()=>{
  for (const body of ['', '{', 'not json','{"query":','{"query":"{__typename}",}',
    '[]x','{"x" 1}','{"x":true false}','[1,]','{"query":"x}','[1','false true','{x:1}','{"x":01}']) {
    const options={method:'POST',headers:{'content-type':'application/json'},body};
    const reference=await fetch(process.env.REFERENCE_GRAPHQL_URL,options);
    const candidate=await fetch(origin+'/v1beta2',options);
    assert.equal(candidate.status,reference.status);
    assert.deepEqual(await candidate.json(),await reference.json());
  }
});
