import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import pg from 'pg';
import worker from '../worker.js';
import { createGraphQL } from './graphql.js';
import { LruCache } from './cache.js';
import { parseJson } from './json.js';

export function createApp({ pool, publicDirectory = resolve('public'), cacheTtlMs = 60000 } = {}) {
  const engine = createGraphQL({ pool, responseTtlMs: cacheTtlMs });
  const assets = new LruCache({ maxBytes: 16 * 1024 * 1024 });
  const pendingAssets = new Map();
  const env = {
    ASSETS: { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const file = resolve(publicDirectory, '.' + pathname);
      if (!file.startsWith(publicDirectory + sep)) return new Response(null, { status: 404 });
      try {
        let body = assets.get(file);
        if (body === undefined) {
          let pending = pendingAssets.get(file);
          if (!pending) {
            pending = (async () => {
              try {
                const content = await readFile(file);
                assets.set(file, content, content.byteLength);
                return content;
              } finally { pendingAssets.delete(file); }
            })();
            pendingAssets.set(file, pending);
          }
          body = await pending;
        }
        return new Response(body);
      } catch { return new Response(null, { status: 404 }); }
    } },
    GRAPHQL_BACKEND_URL: 'http://backend.internal/v1beta2',
    async GRAPHQL_FETCH(request) {
      let input;
      try { input = parseJson(await request.text()); }
      catch (error) { return Response.json({ errors: [{ message: error.message, extensions: { path: '$', code: 'invalid-json' } }] }, { status: 200 }); }
      try {
        const result = await engine.run(input);
        return new Response(result.json || JSON.stringify(result.body), { status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8', ...(result.json ? { 'x-poke-cacheable': '1', 'x-poke-backend-cache': result.cache } : {}) } });
      } catch {
        return Response.json({ errors: [{ message: 'database query error', extensions: { path: '$', code: 'unexpected' } }] }, { status: 200 });
      }
    },
  };
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
    try {
      const host = incoming.headers.host || 'localhost';
      const protocol = incoming.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? 'https' : 'http';
      const url = new URL(incoming.url, process.env.PUBLIC_ORIGIN || `${protocol}://${host}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value != null) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(url, { method: incoming.method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      if (url.pathname === '/healthz') {
        // No database polling: let the free database suspend while idle.
        outgoing.writeHead(200, { 'content-type': 'text/plain' }); outgoing.end('OK'); return;
      }
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) outgoing.end();
      else Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }
  });
  server.requestTimeout = 300000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return { server, engine };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point to your own PostgreSQL database.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 4),
    idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000, options: '-c default_transaction_read_only=on', application_name: 'poke-api-komplete' });
  pool.on('error', error => console.error('PostgreSQL pool error:', error.code || 'connection-error'));
  const { server } = createApp({ pool });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Poké API backend listening'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => { await pool.end(); process.exit(0); }));
}
