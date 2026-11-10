// Keep this entry point lightweight: apply OS limits before loading the schema.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';

// Linux RLIMIT_AS caps all address space (heap, native allocations and mappings).
// Leave 1 GB below the requested 20 GB for this launcher and runtime overhead.
// A heap limit alone would not constrain buffers or other native allocations.
const result = spawnSync('prlimit', [
  '--as=19000000000:19000000000', '--', process.execPath,
  '--max-old-space-size=4096', '--disable-wasm-trap-handler',
  fileURLToPath(new URL('./backend.compatibility.suite.js', import.meta.url)),
], { stdio: ['inherit','pipe','inherit'], maxBuffer:1024*1024, env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.error) {
  console.error('Cannot apply the memory limit. Install util-linux (prlimit) on Linux. Test was not started.', result.error.message);
}
if (result.signal) console.error(`Compatibility test stopped by ${result.signal}; the memory limit remains enforced.`);
if (result.status === 0) {
  const comparisons = Number(result.stdout.toString().match(/Compared (\d+) GraphQL requests/)?.[1]);
  if (!comparisons) throw new Error('Successful test did not report its comparison count.');
  writeFileSync(new URL('../contracts/backend.compatibility.json',import.meta.url),JSON.stringify({
    date:new Date().toISOString(),node:process.version,passed:true,comparisons,
    reference:'Hasura 2.50.2, unchanged official anonymous metadata, same local PostgreSQL snapshot',
    source:JSON.parse(readFileSync(new URL('../upstream.lock.json',import.meta.url))),
    scope:'327 root fields; 163 tables and all their columns; 601 relationships; 299 related aggregates; official examples; combined operations, filters, errors and batches',
    live_public_api_comparison:false,memory_address_space_limit_bytes:19000000000,node_heap_limit_mib:4096,
  },null,2)+'\n');
}
process.exit(result.status ?? 1);
