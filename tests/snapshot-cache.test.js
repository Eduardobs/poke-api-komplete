import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/worker.js';
import { LruCache } from '../src/backend/cache.js';

test('REST stores reuse parsed snapshots and concurrent reads across requests', async () => {
  let reads = 0;
  const env = { ASSETS: { async fetch() {
    reads++;
    await new Promise(resolve => setImmediate(resolve));
    return new Response('{"url":"https://snapshot.invalid/api/v2/"}');
  } } };
  const read = () => store(env, 'https://one.example').read('data/root.json');
  const results = await Promise.all(Array.from({ length: 32 }, read));
  assert.equal(reads, 1);
  assert.ok(results.every(value => value.url === 'https://one.example/api/v2/'));
  await read();
  assert.equal(reads, 1);
  assert.equal((await store(env, 'https://two.example').read('data/root.json')).url, 'https://two.example/api/v2/');
  assert.equal(reads, 2);
  env.CACHE_VERSION = 'next';
  await read();
  assert.equal(reads, 3);
  await store({ ASSETS: env.ASSETS }, 'https://one.example').read('data/root.json');
  assert.equal(reads, 4);
});

test('REST cache retries failures and does not retain oversized parsed files', async () => {
  let reads = 0;
  const env = { ASSETS: { async fetch() {
    reads++;
    if (reads === 1) return new Response(null, { status: 503 });
    return new Response(JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) }));
  } } };
  const read = () => store(env, 'https://one.example').read('data/root.json');
  await assert.rejects(read(), /Snapshot unavailable/);
  await read();
  await read();
  assert.equal(reads, 3);
});

test('bounded LRU expires entries and evicts the least recently used content', () => {
  const cache = new LruCache({ maxBytes: 6, maxEntries: 2 });
  cache.set('a', 'aaa', 3);
  cache.set('b', 'bbb', 3);
  cache.get('a');
  cache.set('c', 'ccc', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.bytes, 6);
  cache.items.get('a').expires = Date.now() - 1;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.bytes, 3);
});
