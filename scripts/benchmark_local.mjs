// Measures CPU/cache mechanisms with local snapshot bytes and a simulated pool.
// For real PostgreSQL, HTTP and Hasura comparisons use npm run benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import worker from '../src/worker.js';
import { createGraphQL } from '../src/backend/graphql.js';

const samples = 100;
const assets = new Map();
const index = JSON.parse(await readFile(new URL('../public/data/pokemon/index.json', import.meta.url)));
for (const path of ['data/pokemon/index.json', `data/pokemon/${index.shards['25']}.json`, 'data/meta.json']) {
  assets.set('/' + path, await readFile(new URL('../public/' + path, import.meta.url)));
}
const rest = {};
for (const mode of ['cold_parsed_cache', 'warm_parsed_cache']) {
  let reads = 0;
  const ASSETS = { async fetch(request) {
    reads++;
    const content = assets.get(new URL(request.url).pathname);
    assert.ok(content, 'benchmark fixture must contain requested shard');
    return new Response(content);
  } };
  const env = { ASSETS };
  const request = async () => {
    // New bindings emulate the former per-request parsed snapshot lifetime.
    const response = await worker.fetch(new Request('https://benchmark.invalid/api/v2/pokemon/25/'), mode === 'warm_parsed_cache' ? env : { ASSETS });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, 'pikachu');
  };
  for (let i = 0; i < 10; i++) await request();
  reads = 0;
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await request();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  rest[mode] = { median_ms: +times[49].toFixed(3), p95_ms: +times[94].toFixed(3), asset_reads: reads };
}
const graphql = {};
for (const enabled of [false, true]) {
  let statements = 0;
  const engine = createGraphQL({ responseTtlMs: enabled ? 60000 : 0, pool: { async query() {
    statements++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { rows: [{ data: { r0: [{ id: 25 }] } }] };
  } } });
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: 32 }, () => engine.run({ query: '{pokemon(where:{id:{_eq:25}}){id}}' })));
  for (const result of results) assert.equal(JSON.parse(result.json).data.pokemon[0].id, 25);
  graphql[enabled ? 'coalesced' : 'independent'] = { sql_statements: statements, elapsed_ms: +(performance.now() - start).toFixed(3) };
}
assert.equal(rest.warm_parsed_cache.asset_reads, 0);
assert.equal(graphql.coalesced.sql_statements, 1);
const report = { node: process.version, samples, scope: 'Local REST with in-memory asset bytes; simulated GraphQL pool with 5 ms delay, no real database, HTTP, CDN or production latency measured', rest, graphql };
await writeFile(new URL('../contracts/local.performance.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
