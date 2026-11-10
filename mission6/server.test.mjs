import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createRepository} from './data/index.mjs';
import {createMissionServer} from './server.mjs';
import {loadRuntimeAssets,sanitizeDocument,replaceFlightSession} from './render.mjs';

let assets;
const vertex={status:()=>({provider:'VERTEX_WIF',model:'gemini-3.8-flash',credentialReady:true}),credentialMetadata:()=>({hasKey:false,provider:'VERTEX_WIF',credentialReady:true}),generate:async()=>({candidates:[{content:{parts:[{text:'fixture generated text'}]}}]})};
const bridgeFactory=()=>{let identity=null;return{status:()=>({configured:Boolean(identity),state:identity?'connected':'awaiting-session'}),match:()=>false,clear:()=>{identity=null},configure:async value=>{if(!['fixture-a','fixture-b'].includes(value.cookieValue))return{status:401,body:{error:'INVALID_FIXTURE'}};identity=value.cookieValue;return{status:200,body:{}}},readOriginalResource:async()=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({user:{id:identity,name:identity,soId:identity==='fixture-a'?1:2,authId:identity},expires:'2030-01-01T00:00:00Z'}))}),forwardOriginalRequest:async()=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from('{"data":[]}')})}};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-test-'));const repository=await createRepository({backend:'local',directory});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const base='http://127.0.0.1:'+port;
  assets??=await loadRuntimeAssets();const app=await createMissionServer({repository,publicOrigin:base,secret:'fixture-secret-with-at-least-thirty-two-characters',vertex,bridgeFactory,assetRuntime:assets});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true})});
  const client=()=>{let cookie='';return{async request(path,{method='GET',body,headers={}}={}){const response=await fetch(base+path,{method,headers:{cookie,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response},get cookie(){return cookie}}};
  const session=async c=>c.request('/workspace/api/session').then(r=>r.json());const write=async(c,path,method,body)=>{const s=await session(c);return c.request(path,{method,body,headers:{Origin:base,'X-CSRF-Token':s.csrfToken}})};
  return{base,app,repository,client,session,write};
}
test('workspace CRUD is isolated across browsers and rejects client-selected ownership',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);
  const created=await(await f.write(a,'/workspace/api/v1/benchmarks','POST',{title:'Private A',content:'fixture'})).json();assert.ok(created.data.id);
  assert.equal((await b.request('/workspace/api/v1/benchmarks/'+created.data.id)).status,404);
  assert.equal((await(await b.request('/workspace/api/v1/benchmarks')).json()).total,0);
  assert.equal((await f.write(a,'/workspace/api/v1/benchmarks','POST',{title:'owner override',workspace_id:(await f.session(b)).workspace.id})).status,400);
});
test('mutations require same Origin and a token bound to the current browser',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client(),as=await f.session(a),bs=await f.session(b);
  for(const headers of [{Origin:f.base},{Origin:'https://other.invalid','X-CSRF-Token':as.csrfToken},{Origin:f.base,'X-CSRF-Token':bs.csrfToken}])assert.equal((await a.request('/workspace/api/v1/drafts',{method:'POST',body:{title:'No'},headers})).status,403);
  assert.equal((await f.write(a,'/workspace/api/v1/drafts','POST',{title:'Allowed'})).status,201);
});
test('connecting and disconnecting one original account never changes another browser',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);const oldCookie=a.cookie;
  const ar=await f.write(a,'/workspace/api/connection','POST',{cookieValue:'fixture-a'});assert.equal(ar.status,200);assert.notEqual(a.cookie,oldCookie);
  assert.equal((await f.session(a)).connected,true);assert.equal((await f.session(b)).connected,false);
  assert.equal((await f.write(b,'/workspace/api/connection','POST',{cookieValue:'fixture-b'})).status,200);
  assert.notEqual((await f.session(a)).workspace.id,(await f.session(b)).workspace.id);
  await f.write(a,'/workspace/api/connection','DELETE');assert.equal((await f.session(a)).connected,false);assert.equal((await f.session(b)).connected,true);
});
test('same verified original identity restores the same private workspace in a new browser',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);await f.write(a,'/workspace/api/connection','POST',{cookieValue:'fixture-a'});await f.write(a,'/workspace/api/v1/drafts','POST',{title:'Restorable'});await f.write(b,'/workspace/api/connection','POST',{cookieValue:'fixture-a'});
  assert.equal((await f.session(a)).workspace.id,(await f.session(b)).workspace.id);assert.equal((await(await b.request('/workspace/api/v1/drafts')).json()).data[0].title,'Restorable');
});
test('guest HTML replaces captured SessionProvider identity and never exposes debug controls',async t=>{
  const f=await fixture(t),a=f.client();const response=await a.request('/dashboard/insights');assert.equal(response.status,200);const html=await response.text();assert.doesNotMatch(html,/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);assert.match(html,/체험 사용자/);assert.match(html,/H 로고/);
  for(const path of ['/__shutdown','/__workflow/resource?path=/mypage','/__replay/coverage','/internal/context'])assert.equal((await a.request(path)).status,404);
  assert.equal((await a.request('/workspace/api/v1/extension-keys')).status,404);
});
test('storage, references, optimistic concurrency and deletion preserve ownership',async t=>{
  const f=await fixture(t),a=await f.repository.ensureWorkspace(),b=await f.repository.ensureWorkspace();const bytes=await readFile(new URL('../development/branding/h-logo.png',import.meta.url));const file=await f.repository.uploadAsset(a.id,{filename:'fixture.png',mimeType:'image/png',bytes});
  await assert.rejects(f.repository.create('benchmarks',b.id,{title:'Forbidden attachment',assets:[{id:file.id}]}),e=>e.status===404);
  const row=await f.repository.create('benchmarks',a.id,{title:'Owned',assets:[{id:file.id}]});await assert.rejects(f.repository.removeAsset(a.id,file.id),e=>e.status===409);
  const updated=await f.repository.update('benchmarks',a.id,row.id,{title:'Version two'},{version:1});assert.equal(updated.version,2);await assert.rejects(f.repository.update('benchmarks',a.id,row.id,{title:'Stale'},{version:1}),e=>e.status===409);
  await f.repository.remove('benchmarks',a.id,row.id);await assert.rejects(f.repository.get('assets',a.id,file.id),e=>e.status===404);
});
test('credential-shaped fields are rejected before they enter the business database',async t=>{
  const f=await fixture(t),a=f.client();for(const data of [{title:'bad',metadata:{access_token:'secret'}},{title:'bad',metadata:{cookieValue:'secret'}},{title:'bad',metadata:{password:'secret'}}])assert.equal((await f.write(a,'/workspace/api/v1/drafts','POST',data)).status,400);
});
test('Flight replacement handles nested braces, strings and null sessions without changing other data',()=>{
  const source='1:{"session":{"user":{"name":"name with } bracket","nested":{"x":1}}},"keep":{"valid":true}}';
  const result=replaceFlightSession(source,{user:{id:'guest'}});assert.equal(result,'1:{"session":{"user":{"id":"guest"}},"keep":{"valid":true}}');assert.equal(replaceFlightSession('"session":null',{user:null}),'"session":{"user":null}');
});
test('a database failure before AI generation releases the viewer concurrency slot',async t=>{
  const f=await fixture(t),a=f.client();await f.session(a);await f.write(a,'/workspace/api/connection','POST',{cookieValue:'fixture-a'});
  const original=f.repository.create;let rejectOnce=true;f.repository.create=async(resource,...args)=>{if(resource==='generations'&&rejectOnce){rejectOnce=false;throw Object.assign(new Error('fixture database outage'),{status:503,code:'SUPABASE_UNAVAILABLE'})}return original(resource,...args)};
  const body={contents:[{parts:[{text:'fixture'}]}]};assert.equal((await f.write(a,'/__vertex/generate','POST',body)).status,503);assert.equal((await f.write(a,'/__vertex/generate','POST',body)).status,200);
});
