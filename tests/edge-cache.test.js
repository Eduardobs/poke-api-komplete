import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedFetch} from '../src/edge-cache.js';

test('edge caches successful anonymous operations and isolates variables/backend',async()=>{
  const previous=globalThis.caches;
  const entries=new Map();const pending=[];
  globalThis.caches={default:{async match(key){return entries.get(key.url)?.clone();},async put(key,value){entries.set(key.url,value);}}};
  const ctx={waitUntil(promise){pending.push(promise);}};
  let calls=0;
  const invoke=async(body='{__typename}',env={GRAPHQL_BACKEND_URL:'https://own.example/v1beta2'},headers={})=>{
    const request=new Request('https://api.example/v1beta2',{method:'POST',headers,body:JSON.stringify({query:body})});
    const response=await cachedFetch(request,env,ctx,async()=>{calls++;return Response.json({data:{value:body}},{headers:{'x-poke-cacheable':'1','cache-control':'no-store'}});});
    await Promise.all(pending);return response;
  };
  try {
    assert.equal((await invoke()).headers.get('x-poke-edge-cache'),'MISS');
    assert.equal((await invoke()).headers.get('x-poke-edge-cache'),'HIT');
    assert.equal(calls,1);
    assert.equal((await invoke('query Different{__typename}')).headers.get('x-poke-edge-cache'),'MISS');
    assert.equal((await invoke('{__typename}',{GRAPHQL_BACKEND_URL:'https://other.example/v1beta2'})).headers.get('x-poke-edge-cache'),'MISS');
    const before=calls;
    await invoke('{__typename}',undefined,{authorization:'Bearer private'});
    assert.equal(calls,before+1);
    const request=new Request('https://api.example/v1beta2',{method:'POST',body:'error'});
    for(let i=0;i<2;i++) await cachedFetch(request.clone(),{},ctx,async()=>{calls++;return Response.json({errors:[{message:'bad'}]});});
    assert.equal(calls,before+3);
  } finally {globalThis.caches=previous;}
});
