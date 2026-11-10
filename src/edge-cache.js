// Cache only anonymous responses, for at most 60 seconds. Set CACHE_VERSION
// when deploying a new snapshot to invalidate keys immediately. GraphQL keys
// also include the backend URL, operation, variables and operationName.
export async function cachedFetch(request, env, ctx, handle) {
  const cache = globalThis.caches?.default;
  if (!cache || !ctx?.waitUntil || request.headers.has('authorization') || request.headers.has('cookie')) return handle();
  const url = new URL(request.url);
  const graphql = ['/v1beta2', '/graphql'].includes(url.pathname.replace(/\/+$/, '')) && request.method === 'POST';
  const rest = request.method === 'GET' && url.pathname.startsWith('/api/v2');
  if (!graphql && !rest) return handle();
  const keyUrl = new URL(url);
  keyUrl.pathname = '/__poke_cache/' + (graphql ? 'graphql' : 'rest');
  let payload = `${env.CACHE_VERSION || '1'}\n${request.url}`;
  if (graphql) {
    // Bound hashing work without limiting the actual API request size.
    const reader = request.clone().body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 128 * 1024) { reader.cancel().catch(() => {}); return handle(); }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    payload += `\n${env.GRAPHQL_BACKEND_URL || env.HASURA_GRAPHQL_URL}\n${new TextDecoder().decode(body)}`;
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  keyUrl.search = '?' + Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  const key = new Request(keyUrl, {method:'GET'});
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) {
    const response = new Response(hit.body, hit);
    if (graphql) response.headers.set('cache-control', 'no-store');
    response.headers.set('x-poke-edge-cache', 'HIT');
    return response;
  }
  const response = await handle();
  if (response.status === 200 && (!graphql || response.headers.get('x-poke-cacheable') === '1')) {
    const entry = new Response(response.clone().body, response);
    entry.headers.set('cache-control', 'public, max-age=60');
    ctx.waitUntil(cache.put(key, entry).catch(() => {}));
  }
  response.headers.set('x-poke-edge-cache', 'MISS');
  return response;
}
