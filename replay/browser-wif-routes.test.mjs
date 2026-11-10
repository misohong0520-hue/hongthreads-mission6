import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createBrowserWifRoutes} from './browser-wif-routes.mjs';
import {BROWSER_WIF_ORIGIN} from './browser-wif-contract.mjs';
async function fixture(t,{generate=async payload=>({candidates:[{content:{parts:[{text:'fixture'}]}}]}),maxBytes=1024}={}){
  const calls=[],vertex={status:()=>({credentialReady:true}),credentialMetadata:()=>({provider:'VERTEX_WIF',credentialReady:true,hasKey:false,apiKey:null}),generate:async payload=>{calls.push(payload);return generate(payload)}};
  const routes=createBrowserWifRoutes({vertex,maxBytes}),server=createServer(async(req,res)=>{if(!await routes.handle(req,res,new URL(req.url,'http://127.0.0.1')))res.writeHead(404).end()});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base='http://127.0.0.1:'+server.address().port,headers={Origin:BROWSER_WIF_ORIGIN,'Content-Type':'application/json'};
  const response=await fetch(base+'/__browser-wif/handshake',{method:'POST',headers,body:'{}'}),handshake=await response.json();
  return{base,headers:{...headers,'X-Rea-Browser-Token':handshake.controlToken},handshake,calls,routes};
}
test('browser WIF exposes honest metadata only to its extension and does not expose tokens in local status',async t=>{
  const f=await fixture(t);assert.equal(f.handshake.metadata.provider,'VERTEX_WIF');assert.equal(f.handshake.metadata.hasKey,false);assert.equal(f.handshake.metadata.apiKey,null);
  assert.ok(!JSON.stringify(f.routes.status()).includes(f.handshake.controlToken));
  for(const Origin of ['https://drt.agczero.com','https://unrelated.invalid','chrome-extension://wrong']){
    const response=await fetch(f.base+'/__browser-wif/handshake',{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
  }
});
test('browser generation requires both its extension origin and private control token',async t=>{
  const f=await fixture(t),body=JSON.stringify({contents:[{parts:[{text:'fixture'}]}]});
  for(const headers of [{Origin:BROWSER_WIF_ORIGIN,'Content-Type':'application/json'},{...f.headers,Origin:'https://drt.agczero.com'},{...f.headers,'X-Rea-Browser-Token':'wrong'}])
    assert.equal((await fetch(f.base+'/__browser-wif/jobs',{method:'POST',headers,body})).status,403);
  assert.equal(f.calls.length,0);
});
test('browser job returns quickly, preserves multimodal payload and returns the actual provider result',async t=>{
  let finish;const result={candidates:[{content:{parts:[{text:'provider fixture'}]}}]};
  const f=await fixture(t,{generate:()=>new Promise(resolve=>{finish=resolve})}),payload={contents:[{role:'user',parts:[{text:'fixture'},{inlineData:{mimeType:'video/mp4',data:'fixture'}}]}]};
  const response=await fetch(f.base+'/__browser-wif/jobs',{method:'POST',headers:f.headers,body:JSON.stringify(payload)});assert.equal(response.status,202);const {jobId}=await response.json();
  assert.deepEqual(f.calls,[payload]);assert.equal(f.routes.status().activeJobs,1);
  assert.equal((await(await fetch(f.base+'/__browser-wif/jobs/'+jobId,{headers:f.headers})).json()).state,'pending');
  finish(result);await new Promise(resolve=>setImmediate(resolve));
  const done=await(await fetch(f.base+'/__browser-wif/jobs/'+jobId,{headers:f.headers})).json();assert.deepEqual(done.result,result);assert.equal(f.routes.status().activeJobs,0);
});
test('browser job rejects malformed and oversized payloads and retains provider error decisions',async t=>{
  const f=await fixture(t,{generate:async()=>{throw Object.assign(new Error('unlogged details'),{code:'VERTEX_QUOTA',status:429})}});
  for(const body of ['null','{}','bad json'])assert.equal((await fetch(f.base+'/__browser-wif/jobs',{method:'POST',headers:f.headers,body})).status,400);
  assert.equal((await fetch(f.base+'/__browser-wif/jobs',{method:'POST',headers:f.headers,body:'x'.repeat(1025)})).status,413);
  const r=await(await fetch(f.base+'/__browser-wif/jobs',{method:'POST',headers:f.headers,body:'{"contents":[{"parts":[{"text":"fixture"}]}]}'})).json();
  await new Promise(resolve=>setImmediate(resolve));const error=await(await fetch(f.base+'/__browser-wif/jobs/'+r.jobId,{headers:f.headers})).json();
  assert.deepEqual(error.error,{code:'VERTEX_QUOTA',status:429});assert.ok(!JSON.stringify(error).includes('unlogged details'));
});
test('browser bridge cannot request arbitrary paths, methods, or original account APIs',async t=>{
  const f=await fixture(t);
  for(const path of ['/__browser-wif/keys','/__browser-wif/jobs?url=https://unrelated.invalid','/__browser-wif/handshake?x=1'])
    assert.equal((await fetch(f.base+path,{headers:f.headers})).status,404);
  assert.equal((await fetch(f.base+'/__browser-wif/jobs',{headers:f.headers})).status,405);
  assert.equal((await fetch(f.base+'/api/keys/active-decrypted',{headers:f.headers})).status,404);assert.equal(f.calls.length,0);
});
