import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const root=import.meta.dirname;
const base='http://127.0.0.1:9252';
const child=spawn(process.execPath,['--import',pathToFileURL(join(root,'live-test-upstream.mjs')).href,join(root,'server.mjs'),'--dev','--live-trends'],
  {cwd:root,env:{...process.env,PORT:'9252'},windowsHide:true,stdio:['ignore','pipe','pipe']});
const exited=once(child,'exit');
const ready=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Fixture startup deadline')),10000);
  child.stdout.on('data',data=>{if(data.toString().includes('REA_HTTP_REPLAY_READY')){clearTimeout(timeout);resolve()}});
  child.once('error',reject);
  child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Fixture exited before checks completed'))});
});
const results=[];
try{
  await ready;
  const status=await(await fetch(base+'/__live/status')).json();
  assert.equal(status.state,'awaiting-session');assert.equal(status.configured,false);
  assert.ok(status.setupToken.length>=32);
  const setup=await fetch(base+'/__live/');
  assert.ok(setup.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(setup.headers.get('cache-control'),'no-store');
  assert.ok((await setup.text()).includes('type="password"'));
  results.push('Private local setup UI and status');
  const json={cookieName:'next-auth.session-token',cookieValue:'fixture-session-not-real'};
  const headers={'content-type':'application/json','origin':base,'x-rea-setup-token':status.setupToken};
  for(const bad of [{...headers,origin:'https://example.com'},{...headers,'x-rea-setup-token':'invalid'}]){
    assert.equal((await fetch(base+'/__live/session',{method:'POST',headers:bad,body:JSON.stringify(json)})).status,403);
  }
  assert.equal((await fetch(base+'/__live/session',{method:'GET'})).status,405);
  assert.equal((await fetch(base+'/__live/session',{method:'POST',headers,body:'{invalid'})).status,400);
  results.push('Origin/token/method/invalid-JSON protections');
  const connect=await fetch(base+'/__live/session',{method:'POST',headers,body:JSON.stringify(json)});
  assert.equal(connect.status,200);assert.equal((await connect.json()).state,'connected');
  const live=await fetch(base+'/api/trends/google');
  assert.equal(live.status,200);assert.equal(live.headers.get('set-cookie'),null);
  const data=await live.json();assert.equal(data.google[0].keyword,'브리지 갱신 검증 1');
  const observable=await(await fetch(base+'/__live/status')).text();
  assert.ok(!observable.includes(json.cookieValue));
  results.push('Authenticated raw upstream JSON through the live bridge, session absent from status');
  assert.equal((await fetch(base+'/api/trends/google?url=https://example.com')).status,400);
  assert.equal((await fetch(base+'/api/trends/google',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/reference/scrap',{method:'POST',body:'{}'})).status,501);
  results.push('Live query allowlist and write forwarding rejected');
  await fetch(base+'/__live/session',{method:'DELETE',headers});
  const cleared=await(await fetch(base+'/__live/status')).json();assert.equal(cleared.configured,false);
  assert.ok((await fetch(base+'/api/trends/google')).status>=400);
  const expired=await fetch(base+'/__live/session',{method:'POST',headers,body:JSON.stringify({...json,cookieValue:'fixture-expired-not-real'})});
  assert.equal(expired.status,401);
  assert.equal((await(await fetch(base+'/__live/status')).json()).state,'session-expired');
  assert.ok((await fetch(base+'/api/trends/google')).status>=400);
  results.push('Clear and expired sessions cannot fall back to recorded success');
  const report={scope:'Isolated local fixture only; no real session or original authenticated API claim',passed:results.length,checks:results};
  await writeFile(join(root,'live-session-route-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{
  try{await fetch(base+'/__shutdown',{signal:AbortSignal.timeout(2000)})}catch{}
  const timer=setTimeout(()=>child.kill(),3000);await exited;clearTimeout(timer);
}
