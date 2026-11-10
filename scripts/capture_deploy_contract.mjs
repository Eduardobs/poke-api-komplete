// Capture the public REST implementation's contract from an official deploy checkout.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node scripts/capture_deploy_contract.mjs /path/to/PokeAPI/deploy');
const source = await readFile(`${checkout}/functions_v1/src/index.js`, 'utf8');
const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const endpoints = JSON.parse(source.match(/const endpoints = (\[[^\n]+\])/)[1]);
const scope = { NETWORK_BASE_URL: 'https://pokemon.example' };
vm.createContext(scope);
// Execute the original helpers unchanged. No Firebase setup or public API calls.
vm.runInContext(source.slice(source.indexOf('function targetUrlForPath'), source.indexOf('function handleErrors')) + '\nthis.helpers = { paramsOrDefault, getPageUrl, getPreviousPage, getNextPage };', scope);
const h = scope.helpers;
const cases = [];
for (const count of [0, 3, 20, 21, 1351]) {
  for (const query of ['', 'limit=0', 'limit=-1', 'limit=bad&offset=bad', 'limit=1.9&offset=1.9', 'limit=100000', 'limit=2&offset=1', `limit=20&offset=${count - 1}`, `limit=20&offset=${count}`, 'limit=20&offset=999999', 'limit=3&offset=-2', 'limit=2&offset=3&q=char']) {
    const params = h.paramsOrDefault(Object.fromEntries(new URLSearchParams(query)));
    const values = Array.from({ length: count }, (_, i) => i);
    cases.push({ count, query, next: h.getPageUrl('/api/v2/pokemon/', h.getNextPage(params, count)), previous: h.getPageUrl('/api/v2/pokemon/', h.getPreviousPage(params)), indices: values.slice(params.offset, params.offset + params.limit) });
  }
}
await writeFile('contracts/rest.contract.json', JSON.stringify({ source: { repository: 'https://github.com/PokeAPI/deploy', commit, file: 'functions_v1/src/index.js', sha256: createHash('sha256').update(source).digest('hex') }, endpoints, pagination: cases }, null, 2) + '\n');
console.log(`Captured ${endpoints.length} public root entries and ${cases.length} pagination cases from ${commit}`);
