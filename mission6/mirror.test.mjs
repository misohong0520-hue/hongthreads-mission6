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
