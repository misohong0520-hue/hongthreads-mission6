import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createWorkflowRoutes} from './workflow-routes.mjs';
import {VertexWifBridge,VERTEX_SETTINGS} from './vertex-wif-bridge.mjs';

const nonce='fixture-workflow-control';
const raw=(body,status=200,type='application/json')=>({status,body:Buffer.from(body),headers:{'content-type':type}});
async function fixture(t,overrides={}){
  const calls=[],events=[];
  const bridge={status:()=>({configured:true}),match:()=>false,
    forwardOriginalRequest:async request=>{calls.push(request);return raw(' {"original":true,"unknown":17} \n')},
    readOriginalResource:async request=>{calls.push(request);return raw('<html><head></head><body>Original editor</body></html>',200,'text/html')},...overrides.bridge};
  const handler=await createWorkflowRoutes({bridge,vertex:overrides.vertex,nonce,csp:"default-src 'self'",
    patchMarkup:bytes=>({bytes:Buffer.from(bytes.toString().replace('Original editor','Original editor patched'))}),
    rewriteDocument:bytes=>Buffer.from(bytes.toString().replace('<head>','<head><script>fixture adapter</script>')),
    rewriteCss:bytes=>bytes,recordEvent:async event=>events.push(event),threadsAuthFixture:overrides.threadsAuthFixture===true});
  const server=createServer(async(req,res)=>{
    try{if(!await handler(req,res,new URL(req.url,'http://127.0.0.1')))res.writeHead(404).end()}
    catch{res.writeHead(500).end()}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base='http://127.0.0.1:'+server.address().port;
  return{base,calls,events,headers:{origin:base,'x-rea-workflow-token':nonce,'content-type':'application/json'}};
}

test('original workflow writes require a page nonce and matching Origin before any API call',async t=>{
  const f=await fixture(t);
  for(const headers of [{},{...f.headers,origin:'https://foreign.invalid'},{...f.headers,'x-rea-workflow-token':'wrong'}]){
    const response=await fetch(f.base+'/api/threads',{method:'POST',headers,body:'{}'});
    assert.equal(response.status,403);
  }
  assert.equal(f.calls.length,0);
});

test('development Threads auth fixture bypasses only the account check and never calls upstream',async t=>{
  const enabled=await fixture(t,{threadsAuthFixture:true,bridge:{status:()=>({configured:false})}});
  const path='/api/keys/accounts?provider=THREADS&check_token=true';
  const response=await fetch(enabled.base+path);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{data:[{id:'dev-threads-account',account_id:'dev-threads-account',account_name:'dev_threads',provider_type:'THREADS',is_primary:1,is_token_expired:false,token_status:'ACTIVE'}]});
  assert.equal(enabled.calls.length,0);
  assert.equal(enabled.events.at(-1).developmentFixture,'threads-auth-screen-bypass');
  const session=await fetch(enabled.base+'/api/auth/session');
  assert.equal(session.status,200);
  assert.equal((await session.json()).user.id,'dev-user');
  const keyStatus=await fetch(enabled.base+'/api/keys/status?provider=THREADS');
  assert.equal(keyStatus.status,200);assert.equal((await keyStatus.json()).hasKey,false);
  const page=await fetch(enabled.base+'/dashboard/threads-manage');
  assert.equal(page.status,200);
  assert.match(await page.text(),/fixture adapter/);
  assert.equal(enabled.calls.length,0);
  const auth=await fetch(enabled.base+'/api/auth/threads?returnTo=/dashboard/threads-manage',{redirect:'manual'});
  assert.equal(auth.status,302);
  assert.equal(auth.headers.get('location'),'https://drt.agczero.com/api/auth/threads?returnTo=%2Fdashboard%2Fthreads-manage');
  assert.equal((await fetch(enabled.base+'/api/auth/threads?returnTo=/invalid')).status,400);
  const accountPatch=await fetch(enabled.base+'/api/keys/accounts',{method:'PATCH',headers:enabled.headers,body:'{"keyId":"dev-threads-account","default_persona_id":null}'});
  assert.equal(accountPatch.status,200);
  assert.equal(enabled.calls.at(-1).path,'/api/keys/accounts');
  const disconnect=await fetch(enabled.base+'/api/auth/threads/disconnect?accountId=dev-threads-account',{method:'DELETE',headers:enabled.headers});
  assert.equal(disconnect.status,200);
  assert.equal(enabled.calls.at(-1).path,'/api/auth/threads/disconnect?accountId=dev-threads-account');

  const disabled=await fixture(t);
  assert.equal((await fetch(disabled.base+path)).status,200);
  assert.equal(disabled.calls.length,1);
});

test('original JSON contract, business query and raw write/response bytes survive the HTTP route',async t=>{
  const f=await fixture(t);const body=' {"text":"fixture only","unexpected":{"nested":1}} \n';
  const response=await fetch(f.base+'/api/threads?id=fixture-draft',{method:'PATCH',headers:f.headers,body});
  assert.equal(response.status,200);assert.equal(await response.text(),' {"original":true,"unknown":17} \n');
  assert.equal(f.calls[0].path,'/api/threads?id=fixture-draft');assert.equal(f.calls[0].method,'PATCH');
  assert.equal(f.calls[0].body.toString(),body);
  assert.equal(f.events.length,1);assert.ok(!JSON.stringify(f.events).includes('fixture only'));
});

test('affiliate key registration preserves its original payload and checks local origin before forwarding',async t=>{
  const f=await fixture(t);
  for(const provider of ['coupang','toss']){
    const payload={accessKey:'fixture-access-only',secretKey:'fixture-secret-only',...(provider==='toss'?{publisherId:'fixture-publisher'}:{})};
    const path='/api/keys/'+provider,body=' '+JSON.stringify(payload)+'\n';
    assert.equal((await fetch(f.base+path,{method:'POST',body})).status,403);
    const count=f.calls.length,response=await fetch(f.base+path,{method:'POST',headers:f.headers,body});
    assert.equal(response.status,200);assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1).body.toString(),body);
    assert.ok(!JSON.stringify(f.events).includes('fixture-secret-only'));
    assert.equal((await fetch(f.base+path+'?accountId=other',{method:'POST',headers:f.headers,body})).status,404);
    assert.equal((await fetch(f.base+path,{method:'DELETE',headers:f.headers})).status,404);
  }
  assert.equal((await fetch(f.base+'/api/keys/provider',{method:'POST',headers:f.headers,body:'{}'})).status,200);
});

test('affiliate registration rejects malformed, incomplete and oversized inputs without upstream calls',async t=>{
  const f=await fixture(t);
  for(const body of ['not-json','null','[]','{}',JSON.stringify({accessKey:'fixture',secretKey:7}),JSON.stringify({accessKey:'fixture',secretKey:'fixture',provider:'AI'})])
    assert.equal((await fetch(f.base+'/api/keys/coupang',{method:'POST',headers:f.headers,body})).status,400);
  assert.equal((await fetch(f.base+'/api/keys/toss',{method:'POST',headers:f.headers,body:JSON.stringify({accessKey:'fixture',secretKey:'fixture'})})).status,400);
  assert.equal((await fetch(f.base+'/api/keys/coupang',{method:'POST',headers:f.headers,body:'x'.repeat(65537)})).status,413);
  assert.equal(f.calls.length,0);
});

test('Vertex keeps original multimodal payload and Google response while exposing honest WIF metadata',async t=>{
  const requests=[];
  const google={candidates:[{content:{parts:[{text:'fixture original result'}]}}],modelVersion:VERTEX_SETTINGS.model};
  const vertex=new VertexWifBridge({runner:async(operation,payload)=>{
    if(operation==='auth')return{authenticated:true,project:VERTEX_SETTINGS.project,location:'global',model:VERTEX_SETTINGS.model,credentialType:'external_account'};
    requests.push(payload);return google;
  }});await vertex.authenticate();
  const f=await fixture(t,{vertex});
  const payload={contents:[{role:'user',parts:[{text:'original fixture prompt'},{inlineData:{mimeType:'image/png',data:'fixture'}}]}],
    systemInstruction:{parts:[{text:'original system'}]},generationConfig:{temperature:.9,responseMimeType:'application/json'}};
  const response=await fetch(f.base+'/__vertex/generate',{method:'POST',headers:f.headers,body:JSON.stringify(payload)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),google);assert.deepEqual(requests,[payload]);
  const metadata=await(await fetch(f.base+'/api/keys/active-decrypted')).json();
  assert.equal(metadata.provider,'VERTEX_WIF');assert.equal(metadata.credentialReady,true);
  assert.equal(metadata.hasKey,false);assert.equal(metadata.apiKey,null);assert.equal(metadata.geminiKey,null);
  assert.equal(metadata.credentials[0].kind,'WIF');assert.equal(f.calls.length,0);
  assert.ok(!JSON.stringify(f.events).includes('original fixture prompt'));
});

test('original HTML is patched and relocated while Next RSC responses remain byte-for-byte intact',async t=>{
  const rsc='1:{"original":"RSC fixture"}\n';
  const f=await fixture(t,{bridge:{readOriginalResource:async request=>request.headers.rsc?
    raw(rsc,200,'text/x-component'):raw('<html><head></head><body>Original editor</body></html>',200,'text/html')}});
  const html=await(await fetch(f.base+'/write?mode=general&keyword=fixture')).text();
  assert.ok(html.includes('fixture adapter'));assert.ok(html.includes('Original editor patched'));
  assert.equal(await(await fetch(f.base+'/write?_rsc=fixture',{headers:{rsc:'1'}})).text(),rsc);
});

test('Coupang and Toss registration pages retain original HTML and Next navigation contracts',async t=>{
  const rsc='1:{"registration":"source fixture"}\n';
  const f=await fixture(t,{bridge:{readOriginalResource:async request=>request.headers.rsc?
    raw(rsc,200,'text/x-component'):raw('<html><head></head><body>Original editor</body></html>',200,'text/html')}});
  for(const path of ['/onboarding/coupang','/onboarding/toss']){
    const page=await fetch(f.base+path);assert.equal(page.status,200);assert.ok((await page.text()).includes('fixture adapter'));
    const navigation=await fetch(f.base+path+'?_rsc=fixture',{headers:{rsc:'1'}});
    assert.equal(navigation.status,200);assert.equal(await navigation.text(),rsc);
  }
  assert.equal((await fetch(f.base+'/onboarding/unknown')).status,404);
});

test('development fixture serves the verified onboarding captures without a live session',async t=>{
  const f=await fixture(t,{threadsAuthFixture:true,bridge:{status:()=>({configured:false})}});
  for(const path of ['/onboarding/coupang','/onboarding/toss']){
    const response=await fetch(f.base+path);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('x-rea-body-representation'),'captured-page-fixture');
    assert.match(await response.text(),/fixture adapter/);
  }
  assert.equal(f.calls.length,0);
});

test('a configured original session keeps live page forwarding ahead of the development fixture',async t=>{
  const f=await fixture(t,{threadsAuthFixture:true});
  const response=await fetch(f.base+'/dashboard/threads-manage');
  assert.equal(response.status,200);
  assert.match(await response.text(),/Original editor patched/);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].path,'/dashboard/threads-manage');
});

test('served workflow asset is the verified overlay object with its original digest identified',async t=>{
  const manifest=JSON.parse(await readFile(join(import.meta.dirname,'workflow-development/manifest.json'),'utf8'));
  const record=manifest.records.find(record=>record.changed&&record.path.includes('/6548-'));
  const f=await fixture(t);const response=await fetch(f.base+record.path);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200);assert.equal(createHash('sha256').update(bytes).digest('hex'),record.development_sha256);
  assert.equal(response.headers.get('x-rea-original-sha256'),record.source_sha256);assert.equal(f.calls.length,0);
});

test('extension key issuance preserves its raw response, requires local CSRF, and logs no token',async t=>{
  const sent=[];const bytes=' {"token":"fixture-extension-sensitive-value"}\n';
  const f=await fixture(t,{bridge:{forwardOriginalRequest:async request=>{sent.push(request);return raw(bytes)}}});
  assert.equal((await fetch(f.base+'/api/keys/extension',{method:'POST'})).status,403);
  assert.equal(sent.length,0);
  const response=await fetch(f.base+'/api/keys/extension',{method:'POST',headers:f.headers});
  assert.equal(response.status,200);assert.equal(await response.text(),bytes);
  assert.equal(sent.length,1);assert.equal(sent[0].path,'/api/keys/extension');assert.equal(sent[0].body.length,0);
  assert.ok(!JSON.stringify(f.events).includes('fixture-extension-sensitive-value'));
});

test('extension key contract rejects extra bodies, queries, methods, and other key writes before forwarding',async t=>{
  const f=await fixture(t);
  for(const body of ['{}','token=fixture','\n']){
    const response=await fetch(f.base+'/api/keys/extension',{method:'POST',headers:f.headers,body});
    assert.equal(response.status,400);
  }
  for(const [path,method]of [['/api/keys/extension?rotate=1','POST'],['/api/keys/extension','GET'],
    ['/api/keys/extension','DELETE'],['/api/keys/accounts','POST']])
    assert.equal((await fetch(f.base+path,{method,headers:f.headers})).status,404);
  assert.equal(f.calls.length,0);
});

test('extension key upstream refusal reaches the original UI without a fake success',async t=>{
  const bytes=' {"error":"premium_required","message":"fixture permission refusal"}\n';
  const f=await fixture(t,{bridge:{forwardOriginalRequest:async()=>raw(bytes,403)}});
  const response=await fetch(f.base+'/api/keys/extension',{method:'POST',headers:f.headers});
  assert.equal(response.status,403);assert.equal(await response.text(),bytes);
  assert.equal(f.events[0].status,403);
});

test('benchmark internal log accepts only fixed event metadata without issuing original requests',async t=>{
  const f=await fixture(t);
  const value={event:'key_failure',code:'SUBSCRIPTION_REQUIRED',status:403};
  const response=await fetch(f.base+'/__workflow/benchmark-log',{method:'POST',headers:f.headers,body:JSON.stringify(value)});
  assert.equal(response.status,204);assert.equal(f.calls.length,0);
  assert.equal(f.events[0].channel,'benchmark_internal');assert.equal(f.events[0].code,'SUBSCRIPTION_REQUIRED');
  assert.deepEqual(Object.keys(f.events[0]).sort(),['at','channel','code','event','status']);
});

test('benchmark internal log rejects unauthenticated requests and every credential/text field',async t=>{
  const f=await fixture(t);const value={event:'key_success',code:'OK'};
  assert.equal((await fetch(f.base+'/__workflow/benchmark-log',{method:'POST',body:JSON.stringify(value)})).status,403);
  for(const body of [{...value,token:'fixture-secret'},{...value,message:'fixture-private-message'},
    {...value,event:'fixture-secret'},{...value,code:'fixture-secret'},{...value,status:1000}])
    assert.equal((await fetch(f.base+'/__workflow/benchmark-log',{method:'POST',headers:f.headers,body:JSON.stringify(body)})).status,400);
  assert.equal(f.events.length,0);assert.equal(f.calls.length,0);
});

test('HTTP workflow streaming sends chunks before EOF and never sends upstream cookies or a buffered body digest', {timeout:3000}, async t=>{
  let source,cancelled=false;
  const f=await fixture(t,{bridge:{forwardOriginalRequest:async()=>({status:200,headers:{'content-type':'text/event-stream','set-cookie':'fixture-secret','content-length':'999'},
    stream:new ReadableStream({start(controller){source=controller;controller.enqueue(new TextEncoder().encode('data: first\n\n'))},cancel(){cancelled=true}})})}});
  const response=await fetch(f.base+'/api/generate/rewrite',{method:'POST',headers:f.headers,body:'{}'});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),null);
  assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-rea-served-sha256'),null);
  const reader=response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');
  source.enqueue(new TextEncoder().encode('data: last\n\n'));source.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: last\n\n');
  assert.equal((await reader.read()).done,true);
  assert.equal(cancelled,false);
});

test('new original application chunks are rejected before mixing with the captured execution overlay',async t=>{
  const f=await fixture(t,{bridge:{readOriginalResource:async request=>raw(request.headers.rsc?
    '1:["static/chunks/app/write/page-new-version.js"]':'<html><script src="/_next/static/chunks/app/write/page-new-version.js"></script></html>',200,request.headers.rsc?'text/x-component':'text/html')}});
  for(const headers of [{},{rsc:'1'}]){
    const response=await fetch(f.base+'/write',{headers});
    assert.equal(response.status,409);assert.equal((await response.json()).error,'original_client_version_changed');
  }
  const count=f.calls.length;
  assert.equal((await fetch(f.base+'/_next/static/chunks/app/write/page-new-version.js')).status,409);
  assert.equal(f.calls.length,count);
  const html=await fetch(f.base+'/write',{headers:{accept:'text/html'}});
  assert.equal(html.status,409);assert.match(html.headers.get('content-type'),/text\/html/);
  const message=await html.text();assert.ok(message.includes('업데이트가 필요합니다'));assert.ok(!message.includes('original_client_version_changed'));
});

test('original onboarding fonts are served byte-for-byte locally without upstream requests',async t=>{
  const manifest=JSON.parse(await readFile(join(import.meta.dirname,'font-assets/manifest.json')));
  const f=await fixture(t);
  for(const record of manifest.records){
    const response=await fetch(f.base+record.path+'?v=original');const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'font/ttf');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.source_sha256);
  }
  assert.equal((await fetch(f.base+'/font/unknown.ttf')).status,404);assert.equal(f.calls.length,0);
});

test('current general editor and mypage documents accept the verified November 10 assets',async t=>{
  const directory=join(import.meta.dirname,'client-updates/2026-11-10');
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json')));
  for(const path of ['/write','/mypage']){
    const record=manifest.records.find(r=>r.path===path),body=await readFile(join(directory,record.file));
    const f=await fixture(t,{bridge:{readOriginalResource:async()=>({status:200,body,headers:{'content-type':'text/html'}})}});
    assert.equal((await fetch(f.base+path)).status,200);
  }
});

test('captured November editor update serves the user-reported query and all source-verified new chunks',async t=>{
  const directory=join(import.meta.dirname,'client-updates/2026-11-06');
  const capture=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  const overlay=JSON.parse(await readFile(join(directory,'development.json'),'utf8'));
  const original=capture.records.find(record=>record.path==='/multi-write');
  const bytes=await readFile(join(directory,original.file));
  const f=await fixture(t,{bridge:{readOriginalResource:async()=>({status:200,body:bytes,headers:{'content-type':'text/html'}})}});
  const response=await fetch(f.base+'/multi-write?mode=coupang&keyword=%ED%8C%A8%EB%94%A9%EC%A1%B0%EB%81%BC&trend=true',{headers:{accept:'text/html'}});
  assert.equal(response.status,200);assert.ok(!(await response.text()).includes('original_client_version_changed'));
  for(const record of overlay.records){
    const asset=await fetch(f.base+record.path);assert.equal(asset.status,200);
    assert.equal(asset.headers.get('x-rea-original-sha256'),record.source_sha256);
    assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'),record.development_sha256);
  }
});
