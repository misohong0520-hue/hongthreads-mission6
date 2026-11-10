import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from './data/index.mjs';
import {createMirror,clean} from './mirror.mjs';
test('upstream draft snapshots preserve snake-case content, acknowledge partial updates and reflect deletion',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/threads?page=1',status:200,data:{data:[{id:42,main_content:'Original body',status:'DRAFT'}]}});
  let rows=await repository.list('drafts',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].content,'Original body');
  await mirror.record(workspace.id,{path:'/api/threads/42',method:'PATCH',status:200,requestData:{main_content:'Updated body'},data:{success:true}});
  rows=await repository.list('drafts',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].content,'Updated body');
  await mirror.record(workspace.id,{path:'/api/threads/42',method:'PATCH',status:200,requestData:{status:'DRAFT'},data:{success:true}});
  assert.equal((await repository.list('drafts',workspace.id)).data[0].content,'Updated body');
  await mirror.record(workspace.id,{path:'/api/threads/42',method:'DELETE',status:200,data:{success:true}});assert.equal((await repository.list('drafts',workspace.id)).total,0);
});
test('mirror omits credentials and does not persist a failed upstream response',async t=>{
  assert.deepEqual(clean({access_token:'private',session_token:'private',nested:{secret_key:'private',content:'safe'}}),{nested:{content:'safe'}});
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  for(const data of [{success:false},{error:'FAILED'}])await mirror.record(workspace.id,{path:'/api/personas',status:200,data});assert.equal((await repository.list('personas',workspace.id)).total,0);
});

test('original editor query-id updates change the existing draft without creating a phantom row',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/threads?page=1',status:200,data:{data:[{id:51,main_content:'Before',status:'DRAFT'}]}});
  // The retained editor sends the ID only in the query and accepts a success
  // acknowledgement that does not repeat it in the response.
  await mirror.record(workspace.id,{path:'/api/threads?id=51',method:'PATCH',status:200,requestData:{main_content:'After',status:'DRAFT'},data:{success:true}});
  const rows=await repository.list('drafts',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].upstream_id,'/api/threads:51');assert.equal(rows.data[0].content,'After');
});

test('batch session snapshots use sessionId consistently across restore, autosave and deletion',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/batch-sessions',status:200,data:{data:[{sessionId:'smart-multi-1',editorType:'smart-multi-write',sessionData:{topic:'First'}},{sessionId:'multi-2',editorType:'multi-write',sessionData:{topic:'Second'}}]}});
  let rows=await repository.list('sessions',workspace.id);assert.equal(rows.total,2);
  await mirror.record(workspace.id,{path:'/api/batch-sessions',method:'POST',status:200,requestData:{sessionId:'smart-multi-1',sessionData:{topic:'Updated'}},data:{success:true}});
  rows=await repository.list('sessions',workspace.id);assert.equal(rows.total,2);assert.equal(rows.data.find(row=>row.upstream_id==='/api/batch-sessions:smart-multi-1').metadata.original.sessionData.topic,'Updated');
  await mirror.record(workspace.id,{path:'/api/batch-sessions?sessionId=smart-multi-1',method:'DELETE',status:200,data:{success:true}});
  rows=await repository.list('sessions',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].upstream_id,'/api/batch-sessions:multi-2');
});

test('the original POST batch-delete contract removes only successfully requested draft copies',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/threads',status:200,data:{data:[{id:61,main_content:'First'},{id:62,main_content:'Second'},{id:63,main_content:'Retained'}]}});
  await mirror.record(workspace.id,{path:'/api/threads/batch-delete',method:'POST',status:200,requestData:{ids:[61,62]},data:{success:true,message:'Deleted'}});
  await mirror.record(workspace.id,{path:'/api/threads/batch-delete',method:'POST',status:200,requestData:{ids:[63]},data:{success:false}});
  const rows=await repository.list('drafts',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].upstream_id,'/api/threads:63');
});

test('default template selection acknowledgements resolve the original templateId field',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/templates/comment',status:200,data:{data:[{id:71,name:'Existing template',content:'Stored content'}]}});
  await mirror.record(workspace.id,{path:'/api/templates/comment',method:'PATCH',status:200,requestData:{templateId:'71'},data:{success:true}});
  const rows=await repository.list('templates',workspace.id);assert.equal(rows.total,1);assert.equal(rows.data[0].content,'Stored content');assert.equal(rows.data[0].metadata.request.templateId,'71');
});

test('source publish and schedule routes mirror into job history while ordinary reads keep their classes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/threads/schedule',method:'POST',status:200,requestData:{threads:[{text:'Scheduled fixture'}]},data:{success:true,data:{id:'fixture-job-1',content:'Recorded plan',status:'QUEUED'}}});
  await mirror.record(workspace.id,{path:'/api/threads/schedule',method:'POST',status:200,requestData:{id:'fixture-job-1'},data:{success:true}});
  await mirror.record(workspace.id,{path:'/api/threads-manage/publish-single',method:'POST',status:200,requestData:{text:'Publication fixture'},data:{success:true,data:{id:'fixture-job-2'}}});
  await mirror.record(workspace.id,{path:'/api/threads/schedule',method:'POST',status:400,requestData:{id:'fixture-job-1'},data:{error:'UPSTREAM_FAILURE'}});
  await mirror.record(workspace.id,{path:'/api/threads',status:200,data:{data:[{id:81,main_content:'Read draft'}]}});
  await mirror.record(workspace.id,{path:'/api/threads-manage/posts?accountId=fixture',status:200,data:{data:[{id:82,content:'Read post'}]}});
  const jobs=await repository.list('publish_jobs',workspace.id);assert.equal(jobs.total,2);const scheduled=jobs.data.find(row=>row.upstream_id==='/api/threads/schedule:fixture-job-1');assert.equal(scheduled.content,'Recorded plan');assert.equal(scheduled.metadata.original.status,'QUEUED');assert.equal(scheduled.status,'synced');
  assert.equal((await repository.list('drafts',workspace.id)).total,1);assert.equal((await repository.list('insights',workspace.id)).total,1);
});

test('source Coupang and Toss link response shapes mirror separately from product searches',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  await mirror.record(workspace.id,{path:'/api/coupang/deeplink',method:'POST',status:200,requestData:{coupangUrls:['https://example.test/product']},data:{success:true,data:[{originalUrl:'https://example.test/product',shortenUrl:'https://example.test/coupang-short'}]}});
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData:{tacaItemId:'fixture-item'},data:{success:true,data:{shortUrl:'https://example.test/toss-short'}}});
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData:{tacaItemId:'fixture-item'},data:{success:true}});
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData:{tacaItemId:'fixture-item'},data:{success:false}});
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData:{tacaItemId:'second-item'},data:{success:true,data:{shortUrl:'https://example.test/second-toss-short'}}});
  await mirror.record(workspace.id,{path:'/api/coupang/search?keyword=fixture',status:200,data:{data:[{productId:'fixture-coupang',productName:'Fixture product'}]}});
  await mirror.record(workspace.id,{path:'/api/shopping/toss/search?q=fixture',status:200,data:{data:[{tacaItemId:'fixture-toss',displayName:'Fixture product'}]}});
  const links=await repository.list('affiliate_links',workspace.id);assert.equal(links.total,3);assert.equal(links.data.find(row=>row.metadata.request.tacaItemId==='fixture-item').metadata.original.shortUrl,'https://example.test/toss-short');assert.equal(links.data.find(row=>row.metadata.request.tacaItemId==='second-item').metadata.original.shortUrl,'https://example.test/second-toss-short');assert.equal(links.data.find(row=>row.metadata.source_path==='/api/coupang/deeplink').metadata.original.shortenUrl,'https://example.test/coupang-short');
  assert.equal((await repository.list('affiliate_items',workspace.id)).total,2);
});

test('large link request metadata stays bounded and credential values are removed before hashing or persistence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),mirror=createMirror(repository);
  const requestData={tacaItemId:'fixture-large',notes:['a'.repeat(50000),'b'.repeat(50000),'c'.repeat(50000)],access_token:'private fixture'};
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData,data:{success:true,data:{shortUrl:'https://example.test/large'}}});
  const first=(await repository.list('affiliate_links',workspace.id)).data[0];assert.equal(first.metadata.request.largeRequest,true);assert.equal(typeof first.metadata.request.sha256,'string');assert.ok(Buffer.byteLength(JSON.stringify(first.metadata))<10000);assert.doesNotMatch(JSON.stringify(first),/private fixture/);
  await mirror.record(workspace.id,{path:'/api/toss/links',method:'POST',status:200,requestData:{...requestData,access_token:'rotated private fixture'},data:{success:true}});
  const links=await repository.list('affiliate_links',workspace.id);assert.equal(links.total,1);assert.equal(links.data[0].metadata.original.shortUrl,'https://example.test/large');
});

test('legacy generated session snapshots are reconciled by source identity without duplicating imports',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));const repository=await createRepository({backend:'local',directory}),workspace=await repository.ensureWorkspace(),other=await repository.ensureWorkspace(),mirror=createMirror(repository);
  const makeLegacy=(wid,index,sessionId)=>repository.create('sessions',wid,{title:'Old snapshot',status:'synced',upstream_id:'/api/batch-sessions:'+'a'.repeat(24)+':'+index,metadata:{source_path:'/api/batch-sessions',original:{sessionId,sessionData:{topic:'Old'}}}});
  const preserved=await makeLegacy(workspace.id,0,'only-legacy');await makeLegacy(workspace.id,1,'already-canonical');const canonical=await repository.create('sessions',workspace.id,{title:'Canonical',upstream_id:'/api/batch-sessions:already-canonical',metadata:{original:{sessionId:'already-canonical'}}});const unrelated=await makeLegacy(workspace.id,2,'not-in-this-response');await makeLegacy(other.id,0,'only-legacy');
  const snapshot={path:'/api/batch-sessions',status:200,data:{data:[{sessionId:'only-legacy',sessionData:{topic:'Latest'}},{sessionId:'already-canonical',sessionData:{topic:'Latest'}}]}};
  await mirror.record(workspace.id,snapshot);await mirror.record(workspace.id,snapshot);
  const rows=await repository.list('sessions',workspace.id);assert.equal(rows.total,3);assert.equal(rows.data.find(r=>r.upstream_id==='/api/batch-sessions:only-legacy').id,preserved.id);assert.equal(rows.data.find(r=>r.upstream_id==='/api/batch-sessions:already-canonical').id,canonical.id);assert.equal(rows.data.find(r=>r.id===unrelated.id).upstream_id,unrelated.upstream_id);assert.equal((await repository.list('sessions',other.id)).total,1);assert.equal(rows.data.find(r=>r.id===preserved.id).metadata.original.sessionData.topic,'Latest');
});
