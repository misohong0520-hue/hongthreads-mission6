import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createVertexWorkerRunner} from './vertex-worker.mjs';

const settings={project:'test-project',location:'global',model:'gemini-3.8-flash',worker:'/srv/existing worker/worker.cjs',
  nodePath:'/usr/local/bin/node',host:'host.invalid',user:'ubuntu',identityFile:'test-identity.pem'};
const fixture=(reply,{code=0,wait=false}={})=>{
  const seen=[];
  const spawn=(command,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{seen.push({killed:true});child.emit('close',null)};
    child.stdin=new Writable({write(chunk,encoding,done){seen.push({input:JSON.parse(chunk.toString())});done()},final(done){done();
      if(!wait)queueMicrotask(()=>{child.stdout.write(reply);child.emit('close',code)})}});
    seen.push({command,args,options});return child;
  };
  return{spawn,seen};
};
test('Linux local worker uses existing executable and the same stdin JSON protocol',async()=>{
  const f=fixture(JSON.stringify({result:{authenticated:true}}));
  const run=createVertexWorkerRunner({settings,transport:'local',spawnImpl:f.spawn});
  assert.deepEqual(await run('auth'),{authenticated:true});
  assert.equal(f.seen[0].command,'/usr/local/bin/node');assert.deepEqual(f.seen[0].args,[settings.worker]);
  assert.equal(f.seen[0].options.shell,false);assert.equal(f.seen[1].input.operation,'auth');
  assert.equal(f.seen[1].input.model,settings.model);assert.ok(!JSON.stringify(f.seen).includes('GOOGLE_APPLICATION_CREDENTIALS'));
});
test('Windows SSH adapter keeps credentials out of the worker stdin and quotes the fixed worker path',async()=>{
  const f=fixture('{"result":{"candidates":[]}}');
  const payload={contents:[{role:'user',parts:[{text:'example'}]}]};
  const run=createVertexWorkerRunner({settings,transport:'ssh',platform:'win32',spawnImpl:f.spawn});
  await run('generate',payload);assert.equal(f.seen[0].command,'ssh.exe');
  assert.ok(f.seen[0].args.includes("'node' '/srv/existing worker/worker.cjs'"));
  assert.deepEqual(f.seen[1].input.payload,payload);assert.ok(!JSON.stringify(f.seen[1].input).includes('test-identity.pem'));
});
test('the existing local WIF worker does not inherit the adapter transport or app secrets',async()=>{
  const f=fixture('{"result":{"authenticated":true}}');
  await createVertexWorkerRunner({settings,transport:'local',spawnImpl:f.spawn,environment:{HOME:'/home/ubuntu',PATH:'/usr/bin',VERTEX_TRANSPORT:'local',SUPABASE_SECRET_KEY:'fixture-private',SESSION_SIGNING_SECRET:'fixture-private',ORIGINAL_CONNECTION_KEY:'fixture-vault-key',PUBLIC_ORIGINAL_SESSION_FILE:'/private/session.enc',PORT:'9251',GOOGLE_APPLICATION_CREDENTIALS:'/safe/wif.json'}})('auth');
  const env=f.seen[0].options.env;assert.equal(env.HOME,'/home/ubuntu');assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS,'/safe/wif.json');
  for(const key of ['VERTEX_TRANSPORT','SUPABASE_SECRET_KEY','SESSION_SIGNING_SECRET','ORIGINAL_CONNECTION_KEY','PUBLIC_ORIGINAL_SESSION_FILE','PORT'])assert.equal(Object.hasOwn(env,key),false);
});
test('oversized input and unknown operations are rejected before starting a child',async()=>{
  let called=false;const run=createVertexWorkerRunner({settings,transport:'local',maxBytes:160,spawnImpl:()=>{called=true}});
  await assert.rejects(run('delete'),e=>e.code==='VERTEX_REQUEST');
  await assert.rejects(run('generate',{contents:[{parts:[{text:'x'.repeat(250)}]}]}),e=>e.status===413);
  assert.equal(called,false);
});
test('malformed worker output and worker failures are never success responses',async()=>{
  const bad=fixture('not json');await assert.rejects(createVertexWorkerRunner({settings,transport:'local',spawnImpl:bad.spawn})('auth'),e=>e.code==='VERTEX_WORKER');
  const denied=fixture('{"error":{"code":"VERTEX_PERMISSION","status":403}}');
  await assert.rejects(createVertexWorkerRunner({settings,transport:'local',spawnImpl:denied.spawn})('auth'),e=>e.code==='VERTEX_PERMISSION'&&e.status===403);
});
test('worker deadline terminates the child and returns timeout',async()=>{
  const f=fixture('',{wait:true});const run=createVertexWorkerRunner({settings,transport:'local',spawnImpl:f.spawn,timeoutMs:15});
  await assert.rejects(run('auth'),e=>e.code==='VERTEX_TIMEOUT'&&e.status===504);assert.ok(f.seen.some(x=>x.killed));
});
