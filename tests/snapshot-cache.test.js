import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { store } from '../src/worker.js';
import { LruCache } from '../src/backend/cache.js';

test('ready REST responses isolate versions/origins, expire and preserve HEAD and headers', async () => {
  let revision = 1;
  const env = { ASSETS: { async fetch(request) {
    return Response.json(new URL(request.url).pathname === '/data/meta.json'
      ? { hash: String(revision) } : { revision, url: 'https://snapshot.invalid/api/v2/' });
  } } };
  const call = (origin = 'https://one.example', method = 'GET') => worker.fetch(new Request(origin + '/api/v2/', { method }), env);
  const first = await call();
  const original = await first.text();
  first.headers.set('x-pokeapi-hash', 'client-change');
  revision++;
  const hit = await call();
  assert.equal(await hit.text(), original);
  assert.equal(hit.headers.get('x-pokeapi-hash'), '1');
  const head = await call(undefined, 'HEAD');
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('x-pokeapi-hash'), '1');
  assert.equal((await (await call('https://two.example')).json()).url, 'https://two.example/api/v2/');
  env.CACHE_VERSION = '2';
  assert.equal((await (await call()).json()).revision, 2);
  const now = Date.now;
  try {
    const future = now() + 60001;
    Date.now = () => future;
    revision++;
    const expired = await call();
    assert.equal((await expired.json()).revision, 3);
    assert.equal(expired.headers.get('x-pokeapi-hash'), '3');
  } finally { Date.now = now; }
});

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
