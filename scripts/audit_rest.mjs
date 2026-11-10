import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const full = process.argv.includes('--full');
const child = spawn('vendor/pokeapi/.venv/bin/python', ['scripts/rest_reference.py', ...(full ? ['--full'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
const completion = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Reference generator exited ${code}`)));
});
const env = { ASSETS: { fetch: async request => {
  try { return new Response(await readFile(new URL('../public' + new URL(request.url).pathname, import.meta.url))); }
  catch { return new Response(null, { status: 404 }); }
} } };
let count = 0, details = 0, encounters = 0;
try {
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    const reference = JSON.parse(line);
    const response = await worker.fetch(new Request('https://pokemon.example' + reference.path), env);
    assert.equal(response.status, 200, reference.path);
    assert.deepEqual(await response.json(), reference.body, reference.path);
    count++;
    if (/\/encounters$/.test(reference.path)) encounters++;
    else if (/\/[^/]+\/-?\d+\/$/.test(reference.path)) details++;
    if (count % 250 === 0) console.log(`${count} exact REST response comparisons passed`);
  }
  await completion;
  const source = JSON.parse(await readFile('upstream.lock.json'));
  const report = { mode: full ? 'all-records' : 'first-and-last-per-collection', reference: { repository: source.repository, commit: source.commit, implementation: 'Unmodified official Django views/serializers, same local CSV snapshot' }, comparisons: count, detailResponses: details, encounterResponses: encounters, publicRoutingContract: 'contracts/rest.contract.json', liveHttpComparison: 'Unavailable in this environment: pokeapi.co returned Cloudflare 403 (1010). This report checks the pinned official source, not live data equality.' };
  await writeFile(full ? 'contracts/rest.audit.json' : 'contracts/rest.sample-audit.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  child.kill();
  throw error;
}
