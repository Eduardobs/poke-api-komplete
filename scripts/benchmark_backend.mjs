import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../src/backend/server.js';

if (!process.env.DATABASE_URL || !process.env.REFERENCE_GRAPHQL_URL) throw new Error('Set DATABASE_URL and REFERENCE_GRAPHQL_URL.');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,options:'-c default_transaction_read_only=on'});
const plain = createApp({pool,cacheTtlMs:0});
const cached = createApp({pool});
const listen = app => new Promise(resolve => app.server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${app.server.address().port}/v1beta2`)));
const urls = [process.env.REFERENCE_GRAPHQL_URL, await listen(plain), await listen(cached)];
const operations = {
  lookup:'{pokemon(where:{id:{_eq:25}}){id name height weight}}',
  list:'{pokemon(limit:20,order_by:{id:asc}){id name height weight}}',
  nested:'{pokemon(limit:10,order_by:{id:asc}){id name pokemontypes(order_by:{id:asc}){slot type{name}} pokemonstats(order_by:{id:asc}){base_stat stat{name}}}}',
  aggregate:'{pokemon_aggregate{aggregate{count avg{height weight} max{height}}}}',
  json:'{pokemonsprites(where:{pokemon_id:{_eq:25}}){sprites}}',
};
const results = {};
// ru_maxrss can inherit the launcher's high-water mark across exec on Linux.
// Sample this Node process directly, including the HTTP client and both apps.
let peakRss = process.memoryUsage().rss;
const sampleMemory = () => { peakRss = Math.max(peakRss,process.memoryUsage().rss); };
const memoryTimer = setInterval(sampleMemory,10);
async function request(url,query) {
  const start = performance.now();
  const response = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
  const result = await response.json();
  sampleMemory();
  assert.equal(response.status,200); assert.equal(result.errors,undefined,JSON.stringify(result.errors));
  return performance.now()-start;
}
try {
  for (const [name,query] of Object.entries(operations)) {
    const samples = [[],[],[]];
    for (const url of urls) for (let i=0;i<5;i++) await request(url,query);
    // Interleave engines to reduce timing bias from warm database/CPU conditions.
    for (let i=0;i<30;i++) for (let step=0;step<3;step++) {
      const engine=(i+step)%3; samples[engine].push(await request(urls[engine],query));
    }
    const stats = samples.map(values => {values.sort((a,b)=>a-b);return {median_ms:+values[15].toFixed(3),p95_ms:+values[28].toFixed(3)};});
    results[name]={reference:stats[0],own_uncached:stats[1],own_cached:stats[2]};
    assert.ok(stats[1].p95_ms <= Math.max(100,stats[0].p95_ms*5), `${name}: uncached regression exceeds gate`);
    assert.ok(stats[2].median_ms <= stats[1].median_ms+1,`${name}: response cache regression`);
  }
  const peakRssMiB=+(peakRss/1024/1024).toFixed(1);
  assert.ok(peakRssMiB<384,'Benchmark exceeds memory budget for a 512 MiB service');
  const report={date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,scope:'Local HTTP, same PostgreSQL snapshot; no CDN, free hosting, TLS or cold starts measured',source:JSON.parse(await readFile(new URL('../upstream.lock.json',import.meta.url))),samples_per_operation:30,warmup:5,gate:'uncached p95 <= max(100 ms, 5x reference); cached median <= uncached median + 1 ms; sampled RSS < 384 MiB',memory_measurement:'process.memoryUsage().rss, sampled every 10 ms and after each response; includes two app instances and HTTP client',sampled_peak_rss_mib:peakRssMiB,results};
  await writeFile(new URL('../contracts/backend.performance.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  clearInterval(memoryTimer);
  await Promise.all([plain,cached].map(app=>new Promise(resolve=>{app.server.close(resolve);app.server.closeIdleConnections();})));
  await pool.end();
}
