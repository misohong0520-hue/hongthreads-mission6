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

test('extension upload tickets work without cookies, are single use and produce durable owned media',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);
  const key=await(await f.write(a,'/api/keys/extension','POST')).json(),headers={Authorization:'Bearer '+key.token,Origin:'chrome-extension://'+'a'.repeat(32)};
  const ticket=await(await fetch(f.base+'/api/upload/presigned-url',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({fileType:'image/png',fileName:'fixture.png'})})).json();
  const bytes=await readFile(new URL('../development/branding/h-logo.png',import.meta.url));
  const upload=await fetch(ticket.uploadUrl,{method:'PUT',headers:{Origin:headers.Origin,'Content-Type':'image/png'},body:bytes});assert.equal(upload.status,200);assert.equal(upload.headers.get('access-control-allow-origin'),headers.Origin);
  assert.equal((await fetch(ticket.uploadUrl,{method:'PUT',body:bytes})).status,403);
  const media=await fetch(ticket.finalPublicUrl);assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),bytes);
  const noCapability=new URL(ticket.finalPublicUrl);noCapability.search='';assert.equal((await b.request(noCapability.pathname)).status,404);
  const invalid=new URL(ticket.finalPublicUrl);invalid.searchParams.set('access',invalid.searchParams.get('access')+'x');assert.equal((await b.request(invalid.pathname+invalid.search)).status,404);
  const saved=await fetch(f.base+'/api/reference/scrap',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({raw_content:'Extension capture',original_url:'https://www.threads.com/@fixture/post/test',media_items:[{type:'image',url:ticket.finalPublicUrl}]})});assert.equal(saved.status,201);const row=await saved.json();assert.ok(row.data.media_items[0].url.includes('?access='));
  const native=(await(await a.request('/workspace/api/v1/benchmarks')).json()).data[0];assert.equal(native.assets.length,1);assert.equal((await b.request('/workspace/api/v1/benchmarks/'+native.id)).status,404);
  assert.equal((await f.write(a,'/api/reference/scrap?ids='+row.id,'DELETE')).status,200);assert.equal((await fetch(ticket.finalPublicUrl)).status,404);
});

test('extension key rotation revokes the previous key and folders/categories stay isolated',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);
  const key=await(await f.write(a,'/api/keys/extension','POST')).json();const folder=await(await f.write(a,'/api/scraps/folders','POST',{folder_name:'Owned'})).json();
  const scrap=await(await f.write(a,'/api/reference/scrap','POST',{original_url:'MANUAL_INPUT',raw_content:'Categorized',folder_id:folder.folder.id})).json();assert.equal(scrap.data.original_url,'MANUAL_INPUT');assert.equal(JSON.parse(scrap.data.content_structure).content,'Categorized');assert.equal(scrap.data.extracted_content,'Categorized');
  assert.equal((await f.write(b,'/api/reference/scrap','POST',{raw_content:'Foreign folder',folder_id:folder.folder.id})).status,404);
  assert.equal((await f.write(a,'/api/reference/scrap','PUT',{action:'SAVE_STABILIZATION',scrap_id:scrap.id})).status,200);
  const filtered=await(await a.request('/api/reference/scrap?link_filter=STABILIZATION')).json();assert.equal(filtered.total,1);assert.equal(filtered.link_summary.unlinked,0);
  const s=await f.session(a);assert.equal((await a.request('/api/keys/extension',{method:'POST',headers:{Origin:f.base,'X-CSRF-Token':s.csrfToken,'X-Rea-Local-Key-Rotate':'1'}})).status,200);
  assert.equal((await fetch(f.base+'/__local_benchmark/key-check',{headers:{Authorization:'Bearer '+key.token}})).status,401);
});

test('URL collection jobs require a matching owned scrap and extension credentials',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);await f.session(b);const url='https://www.threads.com/@fixture/post/test';
  assert.equal((await f.write(a,'/api/scraps/by-url','POST',{url:'https://127.0.0.1/private'})).status,400);
  const job=await(await f.write(a,'/api/scraps/by-url','POST',{url})).json(),path='/__local_benchmark/jobs/'+job.job_id;
  assert.equal((await b.request(path)).status,404);assert.equal((await f.write(a,path+'/result','POST',{success:false})).status,405);
  const key=await(await f.write(a,'/api/keys/extension','POST')).json(),headers={Authorization:'Bearer '+key.token,'Content-Type':'application/json'};
  const row=await(await f.write(a,'/api/reference/scrap','POST',{raw_content:'Collected',original_url:url})).json();
  assert.equal((await fetch(f.base+path+'/result',{method:'POST',headers,body:JSON.stringify({success:true,scrap_id:row.id})})).status,200);
  assert.equal((await(await a.request(path)).json()).state,'complete');
  assert.equal((await fetch(f.base+path+'/result',{method:'POST',headers,body:JSON.stringify({success:true,scrap_id:row.id})})).status,409);
});

test('native management cannot silently edit or delete an upstream record copy',async t=>{
  const f=await fixture(t),a=f.client(),s=await f.session(a);const row=await f.repository.create('drafts',s.workspace.id,{title:'Original',upstream_id:'/api/threads:1'});
  assert.equal((await f.write(a,'/workspace/api/v1/drafts/'+row.id,'PATCH',{title:'Unsent edit'})).status,409);
  assert.equal((await f.write(a,'/workspace/api/v1/drafts/'+row.id,'DELETE')).status,409);
  assert.equal((await f.repository.get('drafts',s.workspace.id,row.id)).title,'Original');
});

test('an old concurrent request cannot overwrite a newly rotated browser session',async t=>{
  const f=await fixture(t),a=f.client();await f.session(a);const oldCookie=a.cookie;await f.write(a,'/workspace/api/connection','POST',{cookieValue:'fixture-a'});
  const stale=await fetch(f.base+'/workspace/api/session',{headers:{cookie:oldCookie}});assert.equal(stale.status,401);assert.equal(stale.headers.get('set-cookie'),null);assert.equal((await f.session(a)).connected,true);
  const key=await(await f.write(a,'/api/keys/extension','POST')).json();const extension=await fetch(f.base+'/api/scraps/folders',{headers:{Authorization:'Bearer '+key.token}});assert.equal(extension.status,200);assert.equal(extension.headers.get('set-cookie'),null);
});

test('retired workspace pages return to original DRT screens without adding a second product UI',async t=>{
  const f=await fixture(t);
  for(const [path,target]of Object.entries({'/workspace':'/dashboard/insights','/workspace/benchmarks':'/dashboard/benchmark','/workspace/benchmarks/new':'/dashboard/benchmark','/workspace/folders':'/dashboard/benchmark','/workspace/drafts/fixture/edit':'/dashboard/threads','/workspace/personas':'/dashboard/personas','/workspace/templates':'/multi-write','/workspace/sessions':'/multi-write','/workspace/revenue':'/dashboard/revenue','/workspace/generations':'/write','/workspace/connect':'/__live/'})){
    const response=await fetch(f.base+path,{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),target);
  }
  const script=await fetch(f.base+'/mission6/client.js').then(r=>r.text());assert.doesNotMatch(script,/hongthreads-workspace|hongthreads-connect-notice|document\.createElement/);
  const setup=await fetch(f.base+'/__live/');assert.equal(setup.status,200);assert.match(await setup.text(),/id="session-form"/);
  const status=await fetch(f.base+'/__live/status').then(r=>r.json());assert.equal(status.enabled,true);
  assert.equal((await fetch(f.base+'/workspace/api/session')).status,200);
});
