import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphQL } from '../src/backend/graphql.js';
import { createApp } from '../src/backend/server.js';

const typename = { query: '{__typename}' };

test('serialized GraphQL batches preserve order, cache status and error envelopes', async () => {
  const engine = createGraphQL();
  for (const cache of ['MISS', 'HIT']) {
    const result = await engine.run([typename, typename]);
    assert.equal(result.cache, cache);
    assert.deepEqual(JSON.parse(result.json), [
      { data: { __typename: 'query_root' } }, { data: { __typename: 'query_root' } },
    ]);
  }
  const mixed = await engine.run([typename, { query: '{unknown}' }, typename]);
  assert.equal(mixed.json, undefined);
  assert.deepEqual(mixed.body[0], mixed.body[2]);
  assert.equal(mixed.body[1].errors[0].extensions.code, 'validation-failed');
  assert.deepEqual(JSON.parse((await engine.run([])).json), []);
});

test('root dispatch supports aliases, fragments, variables and combined SQL execution', async () => {
  const statements = [];
  const engine = createGraphQL({ pool: { async query(statement) {
    statements.push(statement);
    return { rows: [{ data: { r0: [{ id: 25, name: 'pikachu' }], r1: [{ id: 1 }] } }] };
  } } });
  const result = await engine.run({
    query: 'query($id:Int!){p:pokemon(where:{id:{_eq:$id}}){...P} type(limit:1){id}} fragment P on pokemon{id name}',
    variables: { id: 25 },
  });
  assert.deepEqual(JSON.parse(result.json), { data: { p: [{ id: 25, name: 'pikachu' }], type: [{ id: 1 }] } });
  assert.equal(statements.length, 1);
  assert.ok(statements[0].values.includes(25));
});

test('concurrent assets return independent bodies and failed reads can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'poke-assets-'));
  const { server } = createApp({ publicDirectory: directory });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/snapshot.json`;
    const missing = await Promise.all(Array.from({ length: 8 }, () => fetch(url)));
    assert.ok(missing.every(response => response.status === 404));
    await Promise.all(missing.map(response => response.text()));
    const content = JSON.stringify({ snapshot: 'x'.repeat(100000) });
    await writeFile(join(directory, 'snapshot.json'), content);
    const bodies = await Promise.all(Array.from({ length: 16 }, async () => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      return response.text();
    }));
    assert.ok(bodies.every(body => body === content));
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('identical concurrent GraphQL requests share SQL and failures can be retried', async () => {
  let calls = 0;
  let release;
  let fail = true;
  const engine = createGraphQL({ pool: { async query() {
    calls++;
    await new Promise(resolve => { release = resolve; });
    if (fail) throw new Error('temporary failure');
    return { rows: [{ data: { r0: [{ id: 25 }] } }] };
  } } });
  const input = { query: '{pokemon(where:{id:{_eq:25}}){id}}' };
  for (const shouldFail of [true, false]) {
    fail = shouldFail;
    const requests = Array.from({ length: 32 }, () => engine.run(input));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, shouldFail ? 1 : 2);
    release();
    const results = await Promise.all(requests);
    if (shouldFail) assert.ok(results.every(result => result.body.errors));
    else assert.ok(results.every(result => JSON.parse(result.json).data.pokemon[0].id === 25));
  }
  assert.equal((await engine.run(input)).cache, 'HIT');
  assert.equal(engine.metrics.coalescedRequests, 62);
});

test('coalescing isolates GraphQL variables and respects disabled response cache', async () => {
  const statements = [];
  const pool = { async query(statement) {
    statements.push(statement);
    await new Promise(resolve => setImmediate(resolve));
    return { rows: [{ data: { r0: [{ id: statement.values[0] }] } }] };
  } };
  const query = 'query($id:Int!){pokemon(where:{id:{_eq:$id}}){id}}';
  const engine = createGraphQL({ pool });
  const results = await Promise.all([25, 1].map(id => engine.run({ query, variables: { id } })));
  assert.deepEqual(results.map(result => JSON.parse(result.json).data.pokemon[0].id), [25, 1]);
  const uncached = createGraphQL({ pool, responseTtlMs: 0 });
  await Promise.all(Array.from({ length: 4 }, () => uncached.run({ query, variables: { id: 25 } })));
  assert.equal(statements.length, 6);
});
