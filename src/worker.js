import catalog from './generated/catalog.js';
import { cachedFetch } from './edge-cache.js';

const restCors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD',
  'access-control-expose-headers': 'X-PokeAPI-Hash, X-PokeAPI-Deploy-Date',
};
const gqlCors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

function json(body, status = 200, cache = false, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    ...restCors, 'content-type': 'application/json; charset=utf-8',
    'cache-control': cache ? 'public, max-age=86400, s-maxage=86400' : 'no-store',
    'x-content-type-options': 'nosniff', ...headers,
  } });
}

function apiError(status, message) { return json({ status, message }, status); }

export function store(env, origin) {
  const pending = new Map();
  const read = path => {
    if (!pending.has(path)) pending.set(path, (async () => {
      const response = await env.ASSETS.fetch(new Request('https://assets.invalid/' + path));
      if (!response.ok) throw new Error('Snapshot unavailable');
      return JSON.parse((await response.text()).replaceAll('https://snapshot.invalid', origin));
    })());
    return pending.get(path);
  };
  return {
    read,
    async detail(resource, identifier) {
      const index = await read(`data/${resource}/index.json`);
      const normalized = identifier.toLowerCase();
      const key = Object.hasOwn(index.shards, normalized) ? normalized : (Object.hasOwn(index.names, normalized) ? index.names[normalized] : Object.entries(index.names).find(([name]) => name.toLowerCase() === normalized)?.[1]);
      if (key == null || !Object.hasOwn(index.shards, key)) return null;
      return (await read(`data/${resource}/${index.shards[key]}.json`))[key];
    },
    async list(resource, url) {
      const index = await read(`data/${resource}/index.json`);
      // The public Firebase API uses parseInt (not DRF pagination), and ignores q.
      const offset = parseInt(url.searchParams.get('offset')) || 0;
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const count = index.results.length;
      const pageUrl = (begin, end) => `${origin}${url.pathname.toLowerCase()}?offset=${begin}&limit=${end - begin}`;
      const nextBegin = offset + limit;
      const nextEnd = Math.min(offset + limit * 2, count);
      const previousBegin = Math.max(offset - limit, 0);
      return {
        count,
        next: nextEnd > nextBegin ? pageUrl(nextBegin, nextEnd) : null,
        previous: previousBegin < offset ? pageUrl(previousBegin, offset) : null,
        results: index.results.slice(offset, offset + limit),
      };
    },
  };
}

async function graphql(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: gqlCors });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { ...gqlCors, allow: 'POST, OPTIONS' } });
  const backendUrl = env.GRAPHQL_BACKEND_URL || env.HASURA_GRAPHQL_URL;
  if (!backendUrl) return json({ errors: [{ message: 'Configure GRAPHQL_BACKEND_URL with your own backend instance.' }] }, 503, false, gqlCors);
  const target = new URL(backendUrl);
  if (!['https:', 'http:'].includes(target.protocol) || target.origin === new URL(request.url).origin) {
    return json({ errors: [{ message: 'Invalid GraphQL backend configuration.' }] }, 503, false, gqlCors);
  }
  // Always use the official anonymous role. Never forward client admin/session headers.
  const headers = new Headers({ 'content-type': request.headers.get('content-type') || 'application/json', 'x-hasura-role': 'anon' });
  if (request.headers.has('accept')) headers.set('accept', request.headers.get('accept'));
  const upstream = await (env.GRAPHQL_FETCH || fetch)(new Request(target, { method: 'POST', headers, body: request.body, duplex: 'half', redirect: 'manual' }));
  const outputHeaders = new Headers(upstream.headers);
  outputHeaders.delete('content-length');
  for (const [key, value] of Object.entries(gqlCors)) outputHeaders.set(key, value);
  outputHeaders.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outputHeaders });
}

export default {
  async fetch(request, env, ctx) {
    return cachedFetch(request, env, ctx, () => handle(request, env));
  },
};

async function handle(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isGraphql = path === '/graphql' || path === '/v1beta2';
    try {
      if (isGraphql) return await graphql(request, env);
      if (path === '/v1beta2/console') {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
        const asset = await env.ASSETS.fetch(new Request('https://assets.invalid/graphiql.html'));
        return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...restCors, 'access-control-allow-headers': request.headers.get('access-control-request-headers') || '' } });
      if (!['GET', 'HEAD'].includes(request.method)) return apiError(405, 'Method Not Allowed');
      const data = store(env, url.origin);
      let response;
      if (path === '/' || path === '/health') response = json({ name: 'poke-api-komplete', rest: '/api/v2/', graphql: '/v1beta2', resources: catalog.length }, 200, true);
      else if (path === '/schema.graphql' || path === '/snapshot.json') {
        const asset = await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`));
        response = new Response(asset.body, { status: asset.status, headers: { ...restCors, 'content-type': path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8' } });
      } else if (/^\/api\/v1(?:\/|$)/.test(path)) {
        const destination = new URL(request.url);
        destination.pathname = url.pathname.replace(/^\/api\/v1(?=\/|$)/, '/api/v2');
        response = new Response(null, { status: 301, headers: { location: destination.href } });
      } else if (path === '/api/v2') response = json(await data.read('data/root.json'), 200, true);
      else {
        const match = /^\/api\/v2\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path);
        if (!match) response = apiError(404, 'Not Found');
        else {
          const [, resource, key, extra] = match;
          if (extra !== undefined && extra !== 'encounters') response = apiError(400, 'Invalid path');
          else if (!catalog.includes(resource) && resource !== 'meta') response = apiError(400, key ? 'Invalid endpoint or resource formatting' : 'Invalid endpoint');
          else if (key !== undefined && !/^[\w\d-]+$/.test(key)) response = apiError(400, 'Invalid endpoint or resource formatting');
          else if (resource === 'meta') response = key ? apiError(404, 'Not Found') : json(await data.read('data/meta.json'), 200, true);
          else {
            const result = extra
              ? (resource === 'pokemon' && /^-?\d+$/.test(key) ? await data.detail('encounters', key) : null)
              : key ? await data.detail(resource, key) : await data.list(resource, url);
            response = result == null ? apiError(404, 'Not Found') : json(result, 200, true);
          }
        }
      }
      if (url.pathname.startsWith('/api/v2') && response.status === 200) {
        const meta = await data.read('data/meta.json');
        if (meta.hash != null) response.headers.set('x-pokeapi-hash', meta.hash);
        if (meta.deploy_date != null) response.headers.set('x-pokeapi-deploy-date', meta.deploy_date);
      }
      return request.method === 'HEAD' ? new Response(null, response) : response;
    } catch {
      return isGraphql ? json({ errors: [{ message: 'GraphQL backend unavailable.' }] }, 502, false, gqlCors) : apiError(503, 'Snapshot unavailable');
    }
}
