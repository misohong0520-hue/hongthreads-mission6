import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {matchesWorkflowRequest,workflowPolicySource,affiliateKeyPath,affiliateKeyBodyAllowed,AFFILIATE_KEY_MAX_BYTES} from './workflow-policy.mjs';
import {benchmarkEvent} from './benchmark-events.mjs';
import {loadClientUpdates} from './workflow-client-updates.mjs';
import {loadWorkflowFonts} from './workflow-fonts.mjs';
import {loadWorkflowStyles} from './workflow-styles.mjs';
import {VERTEX_MAX_BYTES} from './vertex-wif-bridge.mjs';
import {patchDevelopmentScript} from '../development/patch-server-markup.mjs';

const pages=new Set(['/write','/multi-write','/smart-multi-write','/mypage','/onboarding/coupang','/onboarding/toss',
  ...['insights','benchmark','threads','personas','threads-manage','videos','revenue'].map(page=>'/dashboard/'+page)]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(res,status,value)=>{
  const bytes=Buffer.from(JSON.stringify(value));
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,
    'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);
};
const versionChanged=(req,res)=>{
  if(req.headers.rsc===undefined&&/text\/html/i.test(req.headers.accept??'')){
    const bytes=Buffer.from('<!doctype html><html lang="ko"><meta charset="utf-8"><title>앱 업데이트 안내</title><body style="font:16px/1.7 system-ui;max-width:640px;margin:80px auto;padding:24px"><h1>원본 화면 업데이트가 필요합니다</h1><p>업데이트된 앱을 설치한 뒤 다시 열어 주세요. 저장된 자료는 유지됩니다.</p><a href="/dashboard/insights">인사이트로 돌아가기</a></body></html>');
    res.writeHead(409,{'content-type':'text/html; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(bytes);
  }else json(res,409,{error:'original_client_version_changed'});
};
async function readBody(req,limit=64*1024*1024){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('body_limit'),{status:413});chunks.push(chunk)}
  return Buffer.concat(chunks);
}

/** Mount the source-observed original pages and API contracts in explicit live mode. */
export async function createWorkflowRoutes({bridge,vertex,nonce,csp,rewriteDocument,rewriteCss,patchMarkup,recordEvent,localBenchmark=null,clientUpdatesRoot,threadsAuthFixture=false}){
  const root=join(import.meta.dirname,'workflow-development');
  const overlay=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  const sourceBytes=await readFile(join(import.meta.dirname,'workflow-capture/manifest.json'));
  if(overlay.schema!=='rea-workflow-development-overlay-v1'||overlay.source_manifest_sha256!==sha(sourceBytes))
    throw new Error('Workflow overlay must match the current source manifest.');
  const assets=new Map(),documents=new Map();
  for(const record of overlay.records){
    const filename=resolve(root,record.file);
    if(!filename.startsWith(root+sep))throw new Error('Workflow object path escapes root.');
    const bytes=await readFile(filename);
    if(sha(bytes)!==record.development_sha256)throw new Error('Workflow overlay digest mismatch.');
    if(!/^text\/html\b/i.test(record.media_type??''))assets.set(record.path,{bytes,record});
    else documents.set(new URL(record.path,'https://drt.agczero.com').pathname,{bytes,record});
  }
  // The affiliate onboarding pages were captured in a separately verified
  // client-update release.  Keep their HTML available in the same development
  // fixture path as the dashboard/editor documents; otherwise a disconnected
  // development session falls through to the live bridge and returns 503.
  const onboardingRoot=join(import.meta.dirname,'client-updates','2026-11-07-onboarding');
  const onboardingManifest=JSON.parse(await readFile(join(onboardingRoot,'manifest.json'),'utf8'));
  if(onboardingManifest.schema!=='rea-onboarding-source-capture-v1')throw new Error('Onboarding source capture schema mismatch.');
  for(const record of onboardingManifest.records.filter(record=>/^\/onboarding\/(?:coupang|toss)$/.test(record.path))){
    const filename=resolve(onboardingRoot,record.file);
    if(!filename.startsWith(onboardingRoot+sep))throw new Error('Onboarding object path escapes root.');
    const bytes=await readFile(filename);
    if(sha(bytes)!==record.object_sha256)throw new Error('Onboarding source capture digest mismatch.');
    documents.set(record.path,{bytes,record:{...record,source_sha256:record.object_sha256,development_sha256:record.object_sha256,changed:false}});
  }
  for(const asset of await loadClientUpdates(clientUpdatesRoot))assets.set(asset.record.path,asset);
  for(const asset of await loadWorkflowFonts())assets.set(asset.record.path,asset);
  for(const asset of await loadWorkflowStyles())assets.set(asset.record.path,asset);
  for(const asset of assets.values())if(/javascript|ecmascript/.test(asset.record.media_type??'')){
    const bytes=patchDevelopmentScript(asset.bytes);
    if(!bytes.equals(asset.bytes))asset.record={...asset.record,changed:true,development_sha256:sha(bytes)};
    asset.bytes=bytes;
  }
  const applicationAssets=new Set([...assets.keys()].map(path=>new URL(path,'https://drt.agczero.com').pathname));
  const incompatibleClient=bytes=>{
    const references=bytes.toString('utf8').match(/(?:\/_next\/)?static\/chunks\/app\/[^"'\s<>\\]+\.js/g)??[];
    return references.some(path=>!applicationAssets.has(path.startsWith('/')?path:'/_next/'+path));
  };
  const sameOrigin=req=>req.headers.origin==='http://'+req.headers.host&&req.headers['x-rea-workflow-token']===nonce;
  const send=async(res,response,output=response.body)=>{
    const headers={...response.headers,'cache-control':'no-store','content-security-policy':csp,
      'x-content-type-options':'nosniff'};
    // Cookies and Google/SSH credentials never enter the local HTTP response.
    delete headers['set-cookie'];delete headers['content-encoding'];
    if(response.stream){
      delete headers['content-length'];delete headers['x-rea-served-sha256'];
      res.writeHead(response.status,headers);res.flushHeaders();
      try{await pipeline(Readable.fromWeb(response.stream),res)}
      catch{if(!res.destroyed)res.destroy()}
      return;
    }
    headers['content-length']=output.length;headers['x-rea-served-sha256']=sha(output);
    res.writeHead(response.status,headers);res.end([204,304].includes(response.status)?undefined:output);
  };
  return async(req,res,url)=>{
    const method=req.method.toUpperCase(),path=url.pathname+url.search;
    if(url.pathname==='/__workflow/benchmark-log'){
      if(method!=='POST'){json(res,405,{error:'post_required'});return true}
      if(!sameOrigin(req)){json(res,403,{error:'same_origin_workflow_token_required'});return true}
      try{
        const bytes=await readBody(req,4096);let value;
        try{value=benchmarkEvent(JSON.parse(bytes))}catch{}
        if(!value){json(res,400,{error:'invalid_benchmark_event'});return true}
        await recordEvent({channel:'benchmark_internal',at:new Date().toISOString(),...value});
        res.writeHead(204,{'cache-control':'no-store'}).end();
      }catch{json(res,400,{error:'invalid_benchmark_event'})}
      return true;
    }
    if(url.pathname==='/__workflow/status'&&method==='GET'){
      json(res,200,{enabled:true,originalBackend:'https://drt.agczero.com',sourceRules:workflowPolicySource.rules.length,
        overlayAssets:assets.size,vertex:vertex?.status()??null,session:bridge.status(),
        benchmark:localBenchmark?await localBenchmark.status():{extensionKeyEndpoint:true,automaticKeyIssuance:true,reuseValidAccountKey:true,refreshOnReturn:true,refreshSeconds:30},
        subscription:'Actual upstream state is preserved',publication:'Only explicit original UI requests publish or schedule',threadsAuthFixture});return true;
    }
    if(url.pathname==='/__vertex/generate'){
      if(method!=='POST'){json(res,405,{error:'post_required'});return true}
      if(!sameOrigin(req)){json(res,403,{error:'same_origin_workflow_token_required'});return true}
      if(!vertex){json(res,503,{error:'VERTEX_DISABLED'});return true}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){json(res,415,{error:'json_required'});return true}
      try{
        const bytes=await readBody(req,VERTEX_MAX_BYTES);let payload;
        try{payload=JSON.parse(bytes)}catch{json(res,400,{error:'invalid_json'});return true}
        const response=await vertex.generate(payload);
        await recordEvent({method,pathname:url.pathname,status:200,provider:'VERTEX_WIF',model:vertex.status().model});
        json(res,200,response);
      }catch(error){json(res,error.status??502,{error:{code:error.code??'VERTEX_REQUEST',message:error.code??'VERTEX_REQUEST'}})}
      return true;
    }
    if(method==='GET'&&url.pathname==='/api/auth/threads'){
      const returnTo=url.searchParams.get('returnTo');
      if(returnTo!==null&&['/mypage','/dashboard/threads-manage'].includes(returnTo)){
        const target=new URL('https://drt.agczero.com/api/auth/threads');
        target.searchParams.set('returnTo',returnTo);
        res.writeHead(302,{'location':target.href,'cache-control':'no-store','x-content-type-options':'nosniff'}).end();
        return true;
      }
      json(res,400,{error:'invalid_threads_return_target'});return true;
    }
    if((assets.has(path)||assets.has(url.pathname)||url.pathname.startsWith('/_next/static/'))&&method==='GET'){
      const asset=assets.get(path)??assets.get(url.pathname);
      if(asset){
        const output=/text\/css/.test(asset.record.media_type)?rewriteCss(asset.bytes):asset.bytes;
        await send(res,{status:200,body:asset.bytes,headers:{'content-type':asset.record.media_type,
          'x-rea-original-sha256':asset.record.source_sha256,
          'x-rea-body-representation':asset.record.changed?'development-original-workflow-overlay':'exact-original-workflow-asset'}},output);
        return true;
      }
      if(url.pathname.startsWith('/_next/static/chunks/app/')){
        versionChanged(req,res);return true;
      }
      const response=await bridge.readOriginalResource({path,headers:req.headers});
      await send(res,response);return true;
    }
    if(pages.has(url.pathname)&&method==='GET'){
      if(threadsAuthFixture&&!bridge.status().configured&&req.headers.rsc===undefined&&pages.has(url.pathname)&&documents.has(url.pathname)){
        const document=documents.get(url.pathname);
        if(!document)throw new Error('Development fixture document missing');
        const output=rewriteDocument(patchMarkup(document.bytes).bytes);
        await recordEvent({method,pathname:url.pathname,status:200,developmentFixture:'captured-page-fixture'});
        await send(res,{status:200,body:document.bytes,headers:{'content-type':document.record.media_type,'x-rea-body-representation':'captured-page-fixture'}},output);
        return true;
      }
      if(localBenchmark&&url.pathname==='/dashboard/benchmark'&&req.headers.rsc===undefined){
        const document=documents.get('/dashboard/benchmark');if(!document)throw new Error('Captured benchmark document missing');
        await send(res,{status:200,body:document.bytes,headers:{'content-type':'text/html; charset=utf-8','x-rea-body-representation':'local-benchmark-original-document'}},rewriteDocument(patchMarkup(document.bytes).bytes));return true;
      }
      const response=await bridge.readOriginalResource({path,headers:req.headers});
      if(response.status===200&&/^(?:text\/html|text\/x-component)\b/i.test(response.headers['content-type']??'')&&incompatibleClient(response.body)){
        await recordEvent({method,pathname:url.pathname,status:409,reason:'original_client_version_changed'});
        versionChanged(req,res);return true;
      }
      let output=response.body;
      if(/^text\/html\b/i.test(response.headers['content-type']??''))
        output=rewriteDocument(patchMarkup(response.body).bytes);
      await recordEvent({method,pathname:url.pathname,status:response.status,live:true,originalWorkflow:true,rsc:req.headers.rsc!==undefined});
      await send(res,response,output);return true;
    }
    if(!url.pathname.startsWith('/api/')||bridge.match(url))return false;
    if(localBenchmark&&url.pathname==='/api/auth/session'&&method==='GET'&&!bridge.status().configured){
      let referrer;try{referrer=new URL(req.headers.referer)}catch{}
      if(referrer?.pathname==='/dashboard/benchmark'&&referrer.origin==='http://'+req.headers.host){
        json(res,200,{user:{id:'local',soId:1,name:'내 PC',email:null,image:null},expires:new Date(Date.now()+86400000).toISOString()});return true;
      }
    }
    if(threadsAuthFixture&&method==='GET'&&url.pathname==='/api/auth/session'&&!bridge.status().configured){
      json(res,200,{user:{id:'dev-user',soId:0,name:'개발용 Threads 계정',email:null,image:null},expires:new Date(Date.now()+86400000).toISOString()});return true;
    }
    if(threadsAuthFixture&&method==='GET'&&url.pathname==='/api/keys/accounts'&&url.searchParams.get('provider')==='THREADS'&&!bridge.status().configured){
      const account={id:'dev-threads-account',account_id:'dev-threads-account',account_name:'dev_threads',provider_type:'THREADS',is_primary:1,is_token_expired:false,token_status:'ACTIVE'};
      await recordEvent({method,pathname:url.pathname,status:200,developmentFixture:'threads-auth-screen-bypass'});
      json(res,200,{data:[account]});return true;
    }
    if(!matchesWorkflowRequest(path,method))return false;
    if(method!=='GET'&&!sameOrigin(req)){json(res,403,{error:'same_origin_workflow_token_required'});return true}
    // WIF is a real alternative credential type; the original API-key flags remain false.
    if(vertex&&method==='GET'&&((url.pathname==='/api/keys/status'&&(!url.searchParams.has('provider')||url.searchParams.get('provider')==='AI'))||url.pathname==='/api/keys/active-decrypted')){
      json(res,200,vertex.credentialMetadata());return true;
    }
    if(threadsAuthFixture&&method==='GET'&&url.pathname==='/api/keys/status'&&!bridge.status().configured){
      const provider=url.searchParams.get('provider')??'AI';
      json(res,200,{provider,hasKey:false,rawHasKey:false,apiKey:null,geminiKey:null,tokenStatus:'NONE',credentialReady:false});return true;
    }
    let body;try{body=await readBody(req,affiliateKeyPath(url.pathname)?AFFILIATE_KEY_MAX_BYTES:64*1024*1024)}catch(error){json(res,error.status??400,{error:'workflow_body_limit'});return true}
    if(!affiliateKeyBodyAllowed(url.pathname,body)){json(res,400,{error:'invalid_affiliate_key_input'});return true}
    if(url.pathname==='/api/keys/extension'&&body.length){json(res,400,{error:'extension_key_body_must_be_empty'});return true}
    const response=await bridge.forwardOriginalRequest({path,method,headers:req.headers,body});
    await recordEvent({method,pathname:url.pathname,status:response.status,live:true,originalWorkflow:true});
    await send(res,response);return true;
  };
}
