import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {sealPublicConnection,openPublicConnection,createPublicConnection} from './public-connection.mjs';
import {createRepository} from './data/index.mjs';
import {createMissionServer} from './server.mjs';
import {loadRuntimeAssets} from './render.mjs';

const originalCookie='fixture-private-original-cookie-not-profile-id';
const overrideCookie='fixture-private-other-original-cookie';
const ownerId='fixture-verified-owner',otherId='fixture-verified-other';
const secret='fixture-app-session-signing-secret-at-least-thirty-two-characters';
const key=()=>randomBytes(32).toString('base64url');
const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value))});
const changed=encoded=>{const bytes=Buffer.from(encoded,'base64url');bytes[0]^=1;return bytes.toString('base64url')};
let assets;

test('public original vault uses authenticated encryption, random nonces and supported cookie names',()=>{
  const encryptionKey=key();
  for(const cookieName of ['next-auth.session-token','__Secure-next-auth.session-token']){
    const input={cookieName,cookieValue:originalCookie};
    const document=sealPublicConnection(input,encryptionKey),second=sealPublicConnection(input,encryptionKey);
    assert.deepEqual(openPublicConnection(document,encryptionKey),input);
    assert.notEqual(document.iv,second.iv);assert.notEqual(document.encrypted,second.encrypted);
    assert.ok(!JSON.stringify(document).includes(originalCookie));assert.ok(!JSON.stringify(document).includes(encryptionKey));
  }
});

test('public original vault rejects a wrong key, tampered fields and invalid session inputs',()=>{
  const encryptionKey=key(),document=sealPublicConnection({cookieValue:originalCookie},encryptionKey);
  const rejects=value=>assert.throws(()=>openPublicConnection(value,encryptionKey),e=>e.code==='ORIGINAL_CONNECTION_DECRYPT_FAILED'&&e.status===503);
  assert.throws(()=>openPublicConnection(document,key()),e=>e.code==='ORIGINAL_CONNECTION_DECRYPT_FAILED');
  for(const field of ['iv','tag','encrypted'])rejects({...document,[field]:changed(document[field])});
  rejects({...document,schema:'fixture-untrusted-schema'});rejects({...document,tag:'invalid'});
  for(const input of [{cookieName:'unrelated',cookieValue:originalCookie},{cookieValue:''},{cookieValue:'fixture\r\nInjected: value'}])
    assert.throws(()=>sealPublicConnection(input,encryptionKey),e=>e.code==='ORIGINAL_CONNECTION_INVALID');
  assert.throws(()=>sealPublicConnection({cookieValue:originalCookie},'invalid-key'),e=>e.code==='ORIGINAL_CONNECTION_KEY_INVALID');
});

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-public-connection-')),file=join(directory,'original-session.enc.json'),encryptionKey=key();
  const vault=Buffer.from(JSON.stringify(sealPublicConnection({cookieValue:originalCookie},encryptionKey)));
  await writeFile(file,vault,{mode:0o600});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const base='http://127.0.0.1:'+port;
  assets??=await loadRuntimeAssets();
  const bridges=[],responses=[],sourceWrites=[];
  const bridgeFactory=()=>{
    let identity=null;
    const profile=()=>({user:{id:identity,name:identity===ownerId?'원본 테스트 계정':'개별 테스트 계정',soId:identity===ownerId?1:2,authId:identity},expires:'2030-01-01T00:00:00.000Z'});
    const bridge={clearCount:0,configuredIdentity:null,
      status:()=>({configured:Boolean(identity),state:identity?'connected':'awaiting-session'}),match:()=>false,
      clear(){identity=null;bridge.clearCount++},
      async configure(input){
        identity=input.cookieValue===originalCookie?ownerId:input.cookieValue===overrideCookie?otherId:null;
        bridge.configuredIdentity=identity;
        return{status:identity?200:401,body:identity?{}:{error:'INVALID_FIXTURE'}};
      },
      async readOriginalResource({path}){
        if(!identity)return{status:401,headers:{'content-type':'application/json'},body:Buffer.from('{"error":"session_expired"}')};
        if(path==='/api/auth/session')return json(profile());
        const doc=assets.documents.get(new URL(path,base).pathname);
        if(doc)return{status:200,headers:{'content-type':doc.type},body:Buffer.from(doc.bytes)};
        return json({data:[]});
      },
      async forwardOriginalRequest(request){
        if(request.method!=='GET')sourceWrites.push(request);
        return json({data:[],personas:[],sessions:[],total:0});
      }
    };bridges.push(bridge);return bridge;
  };
  const vertex={status:()=>({provider:'VERTEX_WIF',model:'fixture-model',credentialReady:true}),credentialMetadata:()=>({provider:'VERTEX_WIF',credentialReady:true}),generate:async()=>({candidates:[{content:{parts:[{text:'fixture AI output'}]},finishReason:'STOP'}]})};
  let app,repository;
  const start=async({enabled=true}={})=>{
    repository=await createRepository({backend:'local',directory:join(directory,'database')});
    app=await createMissionServer({repository,publicOrigin:base,secret,vertex,bridgeFactory,assetRuntime:assets,publicConnectionConfig:{enabled,file,key:encryptionKey}});
    await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  };
  await start();
  t.after(async()=>{if(app)await app.close();assert.equal(sourceWrites.length,0);await rm(directory,{recursive:true,force:true})});
  const client=()=>{let cookie='';return{
    async request(path,{method='GET',body,headers={}}={}){
      const response=await fetch(base+path,{method,redirect:'manual',headers:{cookie,...headers,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
      responses.push(JSON.stringify([...response.headers])+await response.clone().text());
      return response;
    },get cookie(){return cookie}
  }};
  const session=async c=>{const response=await c.request('/workspace/api/session');assert.equal(response.status,200);return response.json()};
  const write=async(c,path,method,body)=>{const current=await session(c);return c.request(path,{method,body,headers:{Origin:base,'X-CSRF-Token':current.csrfToken}})};
  return{base,file,vault,encryptionKey,bridges,responses,client,session,write,get repository(){return repository},
    async restart(options){await app.close();app=null;await start(options)},
    async assertVaultUnchanged(){assert.equal(fingerprint(await readFile(file)),fingerprint(vault))},
    assertNoCredentials(){for(const response of responses)for(const sensitive of [originalCookie,overrideCookie,encryptionKey])assert.ok(!response.includes(sensitive))}
  };
}

test('fresh browsers automatically share the verified original workspace while retaining separate CSRF tokens',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client(),as=await f.session(a),bs=await f.session(b);
  assert.equal(as.connected,true);assert.equal(bs.connected,true);assert.equal(as.workspace.kind,'user');
  assert.equal(as.workspace.id,bs.workspace.id);assert.notEqual(as.csrfToken,bs.csrfToken);assert.notEqual(a.cookie,b.cookie);
  const verified=await f.repository.ensureWorkspace({kind:'user',upstreamUserId:'drt:'+ownerId});assert.equal(as.workspace.id,verified.id);
  for(const c of [a,b])assert.equal((await(await c.request('/api/auth/session')).json()).user.id,ownerId);
  const wrongCsrf=await a.request('/workspace/api/v1/drafts',{method:'POST',body:{title:'Rejected'},headers:{Origin:f.base,'X-CSRF-Token':bs.csrfToken}});assert.equal(wrongCsrf.status,403);
  const created=await f.write(a,'/workspace/api/v1/drafts','POST',{title:'Shared original workspace'});assert.equal(created.status,201);
  const id=(await created.json()).data.id;assert.equal((await(await b.request('/workspace/api/v1/drafts/'+id)).json()).data.title,'Shared original workspace');
  assert.equal((await a.request('/dashboard/insights')).status,200);
  const ai=await f.write(b,'/__vertex/generate','POST',{contents:[{parts:[{text:'fixture'}]}]});assert.equal(ai.status,200);assert.match(await ai.text(),/fixture AI output/);
  await f.assertVaultUnchanged();f.assertNoCredentials();
});

test('browser logout and individual original overrides cannot clear another browser or modify the public vault',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await f.session(a);const bs=await f.session(b),defaultBridge=f.bridges.find(bridge=>bridge.configuredIdentity===ownerId),oldCookie=a.cookie;
  const logout=await f.write(a,'/api/auth/signout','POST');assert.equal(logout.status,200);assert.equal((await logout.json()).url,f.base+'/dashboard/insights');assert.notEqual(a.cookie,oldCookie);
  assert.equal((await f.session(a)).connected,true);assert.equal((await f.session(b)).csrfToken,bs.csrfToken);assert.equal(defaultBridge.clearCount,0);
  const connected=await f.write(a,'/workspace/api/connection','POST',{cookieValue:overrideCookie});assert.equal(connected.status,200);
  assert.notEqual((await f.session(a)).workspace.id,bs.workspace.id);assert.equal((await(await a.request('/api/auth/session')).json()).user.id,otherId);
  assert.equal((await(await b.request('/api/auth/session')).json()).user.id,ownerId);assert.equal(defaultBridge.clearCount,0);
  const overrideBridge=f.bridges.find(bridge=>bridge.configuredIdentity===otherId);
  assert.equal((await f.write(a,'/workspace/api/connection','DELETE')).status,200);assert.equal(overrideBridge.clearCount,1);
  assert.equal((await f.session(a)).workspace.id,bs.workspace.id);assert.equal((await f.session(b)).connected,true);assert.equal(defaultBridge.clearCount,0);
  assert.equal((await a.request('/auth/login')).headers.get('location'),'/dashboard/insights');
  await f.assertVaultUnchanged();f.assertNoCredentials();
});

test('server restart restores the same original workspace from the encrypted file for existing and new devices',async t=>{
  const f=await fixture(t),existing=f.client(),before=await f.session(existing),originalAppCookie=existing.cookie;
  const created=await f.write(existing,'/workspace/api/v1/drafts','POST',{title:'Persisted across restart'});assert.equal(created.status,201);const id=(await created.json()).data.id;
  const firstBridge=f.bridges.find(bridge=>bridge.configuredIdentity===ownerId);
  await f.restart();assert.equal(firstBridge.clearCount,1);
  const restored=await f.session(existing),phone=f.client(),fresh=await f.session(phone);
  assert.equal(existing.cookie,originalAppCookie);assert.equal(restored.connected,true);assert.equal(fresh.connected,true);
  assert.equal(restored.workspace.id,before.workspace.id);assert.equal(fresh.workspace.id,before.workspace.id);assert.notEqual(restored.csrfToken,fresh.csrfToken);
  for(const c of [existing,phone]){
    assert.equal((await(await c.request('/api/auth/session')).json()).user.id,ownerId);
    assert.equal((await(await c.request('/workspace/api/v1/drafts/'+id)).json()).data.title,'Persisted across restart');
  }
  assert.equal(f.bridges.filter(bridge=>bridge.configuredIdentity===ownerId).length,2);
  await f.assertVaultUnchanged();f.assertNoCredentials();
});

test('disabling public mode revokes an old anonymous cookie from the original owner workspace',async t=>{
  const f=await fixture(t),browser=f.client(),publicSession=await f.session(browser),cookie=browser.cookie;
  const hash=createHash('sha256').update(cookie.split('=')[1]).digest('hex'),stored=await f.repository.getSession(hash);
  assert.notEqual(stored.workspace_id,publicSession.workspace.id);
  const created=await f.write(browser,'/workspace/api/v1/drafts','POST',{title:'Original owner data'});assert.equal(created.status,201);const id=(await created.json()).data.id;
  await f.restart({enabled:false});
  const guest=await f.session(browser);
  assert.equal(browser.cookie,cookie);assert.equal(guest.connected,false);assert.equal(guest.workspace.kind,'guest');
  assert.equal(guest.workspace.id,stored.workspace_id);assert.notEqual(guest.workspace.id,publicSession.workspace.id);
  assert.equal((await browser.request('/workspace/api/v1/drafts/'+id)).status,404);
  assert.equal((await(await browser.request('/workspace/api/v1/drafts')).json()).total,0);
  assert.equal((await f.repository.get('drafts',publicSession.workspace.id,id)).title,'Original owner data');
  await f.assertVaultUnchanged();f.assertNoCredentials();
});

test('public provider fails closed before constructing a bridge when a vault cannot be authenticated',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'hongthreads-public-invalid-')),file=join(directory,'invalid.enc.json'),encryptionKey=key();
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const document=sealPublicConnection({cookieValue:originalCookie},encryptionKey);document.tag=changed(document.tag);
  await writeFile(file,JSON.stringify(document),{mode:0o600});
  let bridges=0;
  await assert.rejects(createPublicConnection({config:{enabled:true,file,key:encryptionKey},repository:{},bridgeFactory:()=>{bridges++;throw Error('must not be called')}}),e=>e.code==='ORIGINAL_CONNECTION_UNAVAILABLE'&&e.status===503);
  assert.equal(bridges,0);
});
