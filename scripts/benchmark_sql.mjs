import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createGraphQL } from '../src/backend/graphql.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the local snapshot database.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, options: '-c default_transaction_read_only=on -c statement_timeout=30000' });
const operations = {
  count_large: '{pokemonmove_aggregate{aggregate{count}}}',
  aggregate_large: '{pokemonmove_aggregate{aggregate{count avg{level} max{level}}}}',
  aggregate_json: '{pokemonsprites_aggregate{aggregate{count max{pokemon_id}}}}',
  aggregate_nodes: '{pokemonmove_aggregate(limit:10000,order_by:{id:asc}){aggregate{count avg{level}} nodes{id level}}}',
  aggregate_distinct: '{pokemonmove_aggregate(distinct_on:[pokemon_id],order_by:[{pokemon_id:asc},{id:asc}],limit:100,offset:10){aggregate{count max{level}} nodes{id pokemon_id}}}',
  nested_aggregate: '{pokemon(limit:20,order_by:{id:asc}){id pokemonmoves_aggregate{aggregate{count max{level}}}}}',
  nested: '{pokemon(limit:20,order_by:{id:asc}){id name pokemonmoves(limit:5,order_by:{id:asc}){level move{name}} pokemontypes{type{name}}}}',
  lookup: '{pokemon(where:{id:{_eq:25}}){id name}}',
};
const compare = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null;
const results = {};
let peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
try {
  for (const [name, query] of Object.entries(operations)) {
    let statement;
    const engine = createGraphQL({ responseTtlMs: 0, pool: { query(config) { statement = config; return pool.query(config); } } });
    const times = [];
    let hash;
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      const result = await engine.run({ query });
      assert.ok(result.json, JSON.stringify(result.body));
      const current = createHash('sha256').update(result.json).digest('hex');
      if (hash) assert.equal(current, hash, `${name}: unstable result`);
      hash = current;
      if (i >= 5) times.push(performance.now() - start);
    }
    if (compare) assert.equal(hash, compare.results[name].result_sha256, `${name}: result changed`);
    const explained = await pool.query({ text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.text, values: statement.values });
    const plan = explained.rows[0]['QUERY PLAN'][0];
    times.sort((a,b) => a-b);
    results[name] = { query, median_ms: +times[14].toFixed(3), p95_ms: +times[28].toFixed(3), result_sha256: hash,
      execution_ms: plan['Execution Time'], planning_ms: plan['Planning Time'],
      shared_hit_blocks: plan.Plan['Shared Hit Blocks'], temp_written_blocks: plan.Plan['Temp Written Blocks'], plan };
    console.log(`${name}: median=${results[name].median_ms}ms p95=${results[name].p95_ms}ms temp=${results[name].temp_written_blocks}`);
  }
  // Distinct variables prevent response coalescing; measure contention on four connections.
  const engine = createGraphQL({ pool, responseTtlMs: 0 });
  const latencies = [];
  let maxWaiting = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const begin = performance.now();
    const result = await engine.run({ query: 'query($id:Int!){pokemon(where:{id:{_eq:$id}}){id name pokemonmoves_aggregate{aggregate{count}}}}', variables: { id: index + 1 } });
    assert.ok(result.json, JSON.stringify(result.body));
    latencies.push(performance.now() - begin);
    maxWaiting = Math.max(maxWaiting, pool.waitingCount);
  }));
  const elapsedMs = performance.now() - start;
  latencies.sort((a,b) => a-b);
  assert.equal(results.count_large.temp_written_blocks, 0, 'Count-only aggregate must not spill a materialized rowset');
  assert.equal(results.aggregate_large.temp_written_blocks, 0, 'Numeric-only aggregate must not spill a materialized rowset');
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  assert.ok(peakRss < 384 * 1024 * 1024, 'SQL benchmark exceeds the process RSS budget');
  const indexes = (await pool.query("SELECT indexname, indexdef, pg_relation_size(format('%I.%I',schemaname,indexname)::regclass)::int AS bytes FROM pg_indexes WHERE schemaname='public' AND tablename='pokemon_v2_pokemonmove' ORDER BY indexname")).rows;
  const report = { date: new Date().toISOString(), indexes, node: process.version, postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
    samples_per_operation: 30, warmup: 5, gate: 'count and numeric aggregates write zero temp blocks; process RSS < 384 MiB; optional baseline response hashes match',
    scope: 'Real local PostgreSQL snapshot; response cache disabled, 5 warmups and 30 samples; EXPLAIN ANALYZE BUFFERS; no HTTP/CDN/TLS',
    sampled_peak_rss_mib: +(peakRss / 1024 / 1024).toFixed(1),
    contention: { requests: 32, pool_max: 4, observed_waiting: maxWaiting, elapsed_ms: +elapsedMs.toFixed(3), p95_ms: +latencies[30].toFixed(3) }, results };
  await writeFile(process.argv[2] || 'contracts/sql.performance.json', JSON.stringify(report, null, 2) + '\n');
} finally { clearInterval(memoryTimer); await pool.end(); }
