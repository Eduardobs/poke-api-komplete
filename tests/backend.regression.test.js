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
