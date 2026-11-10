import {createServer as httpServer,request as httpRequest} from 'node:http';
import {readFile,mkdir,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createRepository,DataError,RESOURCE_MAP} from './data/index.mjs';
import {createSessionManager} from './sessions.mjs';
import {loadRuntimeAssets,rewriteDocument,ORIGINAL_PAGES} from './render.mjs';
import {createMirror,clean} from './mirror.mjs';
import {createCompatibility} from './compatibility.mjs';
import {readBody,readJson,multipart,json,fail} from './http.mjs';
import {createWorkflowRoutes} from '../replay/workflow-routes.mjs';
import {patchDevelopmentMarkup} from '../development/patch-server-markup.mjs';
import {VertexWifBridge} from '../replay/vertex-wif-bridge.mjs';

const root=resolve(import.meta.dirname,'..'),publicResources=new Set(['benchmarks','drafts','personas','templates','revenue','folders','sessions','generations','accounts','insights','affiliate_items','affiliate_links','publish_jobs','cache']);
const readonlyResources=new Set(['sessions','generations','accounts','insights','affiliate_items','affiliate_links','publish_jobs','cache']);
export async function createMissionServer({repository,publicOrigin,secret,vertex,bridgeFactory,assetRuntime,logDirectory,nextUrl='http://127.0.0.1:9250'}={}){
  const origin=new URL(publicOrigin);if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/')throw new Error('PUBLIC_ORIGIN invalid');
  const runtime=assetRuntime??await loadRuntimeAssets();
  const storage=new AsyncLocalStorage(),sessions=createSessionManager({repository,secret,publicOrigin,bridgeFactory}),mirror=createMirror(repository),internalNonce=randomBytes(32).toString('hex');
  const pending=new Set();let aiActive=0;const aiOwners=new Set();
  const current=()=>{const context=storage.getStore();if(!context)throw new Error('Request context missing');return context};
  const event=async value=>{if(!logDirectory)return;await mkdir(logDirectory,{recursive:true});await appendFile(join(logDirectory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),method:value.method,path:value.pathname,status:value.status,code:value.code})+'\n')};
  const background=fn=>{const promise=Promise.resolve().then(fn).catch(()=>{});pending.add(promise);promise.finally(()=>pending.delete(promise))};
  const observe=(response,details)=>{
    const ctx=current();if(response.body&&/application\/json/.test(response.headers?.['content-type']??'')&&response.status>=200&&response.status<300){let data;try{data=JSON.parse(response.body)}catch{};if(data)background(()=>mirror.record(ctx.workspace.id,{...details,status:response.status,data}).catch(()=>mirror.syncFailure(ctx.workspace.id,details.path,response.status)))}return response;
  };
  const bridge={
    status:()=>current().bridge.status(),match:url=>current().bridge.match(url),
    readOriginalResource:async request=>{
      const ctx=current(),url=new URL(request.path,publicOrigin);
      if((!ctx.bridge.status().configured||url.pathname==='/dashboard/benchmark')&&ORIGINAL_PAGES.has(url.pathname)){
        const doc=runtime.documents.get(url.pathname);if(doc)return{status:200,body:doc.bytes,headers:{'content-type':doc.type,'x-rea-body-representation':'public-original-shell'}};
      }
      return ctx.bridge.readOriginalResource(request);
    },
    forwardOriginalRequest:async request=>{
      const response=await current().bridge.forwardOriginalRequest(request);let requestData;try{requestData=JSON.parse(request.body)}catch{}
      return observe(response,{path:request.path,method:request.method,requestData});
    }
  };
  const vertexFacade={status:()=>({...vertex.status(),credentialReady:vertex.status().credentialReady&&current().bridge.status().configured}),credentialMetadata:()=>({...vertex.credentialMetadata(),credentialReady:vertex.status().credentialReady&&current().bridge.status().configured}),generate:async payload=>{
    const ctx=current();if(!ctx.bridge.status().configured)throw new DataError('ORIGINAL_CONNECTION_REQUIRED',401);
    if(aiOwners.has(ctx.workspace.id)||aiActive>=2)throw new DataError('AI_BUSY',429);aiOwners.add(ctx.workspace.id);aiActive++;
    let job;
    try{let input=clean(payload);if(Buffer.byteLength(JSON.stringify(input))>800000)input={largeInput:true};job=await repository.create('generations',ctx.workspace.id,{title:'AI 원고 생성',status:'running',metadata:{provider:'VERTEX_WIF',model:vertex.status().model,input}});const result=await vertex.generate(payload);const parts=(result.candidates??[]).flatMap(c=>c.content?.parts??[]).filter(p=>!p.thought),text=parts.map(p=>p.text??'').join('');await repository.update('generations',ctx.workspace.id,job.id,{content:text.slice(0,50000),status:text||parts.some(p=>p.functionCall)?'completed':'empty',metadata:{...job.metadata,completed_at:new Date().toISOString(),finish_reason:result.candidates?.[0]?.finishReason??null}});return result}
    catch(error){if(job)await repository.update('generations',ctx.workspace.id,job.id,{status:'failed',metadata:{...job.metadata,error:error.code??'VERTEX_REQUEST'}}).catch(()=>{});throw error}
    finally{aiActive--;aiOwners.delete(ctx.workspace.id)}
  }};
  const csp="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com https://cdn.agczero.com https://*.supabase.co; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  const workflows=await createWorkflowRoutes({bridge,vertex:vertexFacade,nonce:internalNonce,csp,
    rewriteDocument:bytes=>{const ctx=current();return rewriteDocument(bytes,{ctx,profile:ctx.originalSession??sessions.guestProfile(ctx),vertex:vertexFacade.status()})},rewriteCss:b=>b,patchMarkup:patchDevelopmentMarkup,recordEvent:event});
  const publicAsset=async(wid,id)=>{const row=await repository.get('assets',wid,id);return{id:row.id,name:row.title,mime_type:row.metadata.mime_type,size:row.metadata.size,status:row.status,url:await repository.getAssetUrl(wid,id)}};
  const decorate=async(wid,row)=>({...row,assets:await Promise.all(row.assets.map(a=>publicAsset(wid,a.id)))});
  const compatibility=createCompatibility({repository,secret,publicOrigin,publicAsset});
  const client=await readFile(join(root,'mission6/client.js'));
  const setupPage=await readFile(join(root,'replay/session-setup.html'));
  const setupScript=await readFile(join(root,'replay/session-setup.js'));
  const workspaceDestinations={benchmarks:'/dashboard/benchmark',folders:'/dashboard/benchmark',drafts:'/dashboard/threads',personas:'/dashboard/personas',templates:'/multi-write',revenue:'/dashboard/revenue',sessions:'/multi-write',generations:'/write',connect:'/__live/'};
  const reply=async(res,response)=>{const headers={...response.headers,'cache-control':'no-store','x-content-type-options':'nosniff'};delete headers['set-cookie'];delete headers['content-encoding'];delete headers['transfer-encoding'];if(response.stream){res.writeHead(response.status,headers);await pipeline(Readable.fromWeb(response.stream),res);return}headers['content-length']=response.body.length;res.writeHead(response.status,headers).end(response.body)};
  const proxyNext=(req,res)=>new Promise(resolve=>{
    const target=new URL(req.url,nextUrl);const upstream=httpRequest(target,{method:req.method,headers:{...req.headers,host:target.host,'x-forwarded-host':origin.host,'x-forwarded-proto':origin.protocol.slice(0,-1)}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);r.once('end',resolve)});
    upstream.once('error',()=>{if(!res.headersSent)json(res,503,{error:{code:'WEB_NOT_READY',message:'화면을 준비하고 있습니다. 잠시 후 새로고침해 주세요.'}});resolve()});req.pipe(upstream);
  });
  const server=httpServer(async(req,res)=>{
    try{
      const host=String(req.headers.host??'');if(![origin.host,'127.0.0.1:9251','localhost:9251'].includes(host))throw new DataError('INVALID_HOST',421);
      const url=new URL(req.url,publicOrigin),path=url.pathname,method=req.method;
      if(path==='/healthz'){json(res,200,{app:'hongthreads',ready:true,storage:repository.backend,vertex:vertex.status().credentialReady});return}
      if(path==='/extensions/hongthreads.zip'&&['GET','HEAD'].includes(method)){const bytes=await readFile(join(root,'extension-cloud.zip'));res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="hongthreads-extension.zip"','content-length':bytes.length,'cache-control':'no-store'}).end(method==='HEAD'?undefined:bytes);return}
      if(/^\/(?:__shutdown|__desktop|__origin|__replay\/(?:coverage|misses)|__workflow\/resource|internal)(?:\/|$)/.test(path))throw new DataError('NOT_FOUND',404);
      if((path==='/workspace'||path.startsWith('/workspace/'))&&!path.startsWith('/workspace/api/')){
        if(!['GET','HEAD'].includes(method))throw new DataError('METHOD_NOT_ALLOWED',405);
        const destination=workspaceDestinations[path.split('/')[2]]??'/dashboard/insights';
        res.writeHead(302,{location:destination,'cache-control':'no-store'}).end();return;
      }
      let asset=runtime.assets.get(path+url.search)??runtime.assets.get(path);
      if(!asset&&path==='/_next/image'){
        for(const [key,item]of runtime.assets)if(key.startsWith('/_next/image?')){const captured=new URL(key,publicOrigin);if(captured.searchParams.get('url')===url.searchParams.get('url')&&captured.searchParams.get('q')===url.searchParams.get('q')){asset=item;break}}
      }
      if(path==='/mission6/client.js')asset={bytes:client,type:'application/javascript'};
      if(asset&&['GET','HEAD'].includes(method)){res.writeHead(200,{'content-type':asset.type,'content-length':asset.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'}).end(method==='HEAD'?undefined:asset.bytes);return}
      if(method==='OPTIONS'&&/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin??'')){res.writeHead(204,{'access-control-allow-origin':req.headers.origin,'access-control-allow-methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS','access-control-allow-headers':'Authorization,Content-Type','vary':'Origin'}).end();return}
      const externalExtension=/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin??'');
      const authorization=/^Bearer (.+)$/.exec(req.headers.authorization??'');
      const capability=compatibility.capability(url,method);
      let ctx;
      if(authorization){const validated=await compatibility.verifyExtension(authorization[1]);if(!validated)throw new DataError('EXTENSION_KEY_REQUIRED',401);ctx={...await sessions.workspaceContext(validated.workspaceId),extension:true};if(externalExtension)res.setHeader('access-control-allow-origin',req.headers.origin)}
      else if(capability)ctx={...await sessions.workspaceContext(capability.workspaceId),capability};
      else ctx=await sessions.context(req,res);
      if(capability&&externalExtension)res.setHeader('access-control-allow-origin',req.headers.origin);
      const mutating=!['GET','HEAD'].includes(method);
      if(mutating&&!ctx.extension&&!capability?.upload){
        if(req.headers.origin!==origin.origin||req.headers['sec-fetch-site']==='cross-site')throw new DataError('ORIGIN_REQUIRED',403);
        const token=req.headers['x-csrf-token']??req.headers['x-rea-workflow-token']??req.headers['x-rea-setup-token'];
        if(token!==ctx.csrfToken)throw new DataError('CSRF_REQUIRED',403);
      }
      await storage.run(ctx,async()=>{
        if(path==='/workspace/api/session'){if(method!=='GET')throw new DataError('METHOD_NOT_ALLOWED',405);json(res,200,sessions.view(ctx));return}
        if(path==='/workspace/api/connection'||path==='/__live/session'){
          if(method==='POST'){
            const next=await sessions.connect(ctx,res,await readJson(req,65536));
            background(async()=>{for(const source of ['/api/personas','/api/templates/comment','/api/threads?page=1&limit=100','/api/batch-sessions','/api/keys/accounts']){try{const response=await next.bridge.forwardOriginalRequest({path:source,method:'GET'});if(response.status===200&&response.body){const data=JSON.parse(response.body);await mirror.record(next.workspace.id,{path:source,method:'GET',status:response.status,data})}}catch{await mirror.syncFailure(next.workspace.id,source,200).catch(()=>{})}}});
            json(res,200,sessions.view(next));return;
          }
          if(method==='DELETE'){json(res,200,sessions.view(await sessions.disconnect(ctx,res)));return}throw new DataError('METHOD_NOT_ALLOWED',405);
        }
        if(['/__live/','/__live'].includes(path)&&method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':setupPage.length,'cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY'}).end(setupPage);return}
        if(path==='/__live/setup.js'&&method==='GET'){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','content-length':setupScript.length,'cache-control':'no-store'}).end(setupScript);return}
        if(path==='/auth/login'){res.writeHead(302,{location:'/__live/','cache-control':'no-store'}).end();return}
        if(path==='/__live/status'){json(res,200,{...ctx.bridge.status(),enabled:true,setupToken:ctx.csrfToken});return}
        if(path==='/api/auth/csrf'){json(res,200,{csrfToken:ctx.csrfToken});return}
        if(path==='/api/auth/signout'&&method==='POST'){await sessions.disconnect(ctx,res);json(res,200,{url:origin.origin+'/auth/login'});return}
        if(path==='/api/auth/session'&&method==='GET'){json(res,200,ctx.originalSession??sessions.guestProfile(ctx));return}
        if(path==='/__workflow/status'){json(res,200,{enabled:true,session:ctx.bridge.status(),vertex:vertexFacade.status(),benchmark:{mode:'supabase',workspace:ctx.workspace.id},storage:repository.backend});return}
        if(path==='/workspace/api/v1/uploads'&&method==='POST'){
          const form=await multipart(req),file=form.get('file');if(!file||typeof file.arrayBuffer!=='function')throw new DataError('FILE_REQUIRED',400);
          const row=await repository.uploadAsset(ctx.workspace.id,{filename:file.name,mimeType:file.type,bytes:Buffer.from(await file.arrayBuffer())});json(res,201,{data:await publicAsset(ctx.workspace.id,row.id)});return;
        }
        const fileRoute=/^\/workspace\/api\/v1\/assets\/([a-f0-9-]+)(?:\/(content))?$/.exec(path);
        if(fileRoute){if(method==='DELETE'){await repository.removeAsset(ctx.workspace.id,fileRoute[1]);json(res,200,{success:true});return}if(method==='GET'){const asset=await repository.downloadAsset(ctx.workspace.id,fileRoute[1]);res.writeHead(200,{'content-type':asset.row.metadata.mime_type,'content-length':asset.bytes.length,'cache-control':'private,no-store','x-content-type-options':'nosniff'}).end(asset.bytes);return}throw new DataError('METHOD_NOT_ALLOWED',405)}
        const resource=/^\/workspace\/api\/v1\/([a-z_-]+)(?:\/([a-f0-9-]+))?$/.exec(path);
        if(resource){
          const [,name,id]=resource;if(!publicResources.has(name))throw new DataError('UNKNOWN_RESOURCE',404);const wid=ctx.workspace.id;
          if(method==='GET'&&!id){const batch=await repository.list(name,wid,{page:url.searchParams.get('page')??1,limit:url.searchParams.get('limit')??15,search:url.searchParams.get('search')??'',sort:url.searchParams.get('sort')??'updated_desc',...(url.searchParams.has('folder_id')?{folderId:url.searchParams.get('folder_id')}:{})});json(res,200,{...batch,data:await Promise.all(batch.data.map(r=>decorate(wid,r)))});return}
          if(method==='GET'&&id){json(res,200,{data:await decorate(wid,await repository.get(name,wid,id))});return}
          if(readonlyResources.has(name))throw new DataError('READ_ONLY_RESOURCE',405);
          if(method==='POST'&&!id){json(res,201,{data:await decorate(wid,await repository.create(name,wid,await readJson(req)))});return}
          if(['PATCH','DELETE'].includes(method)&&id){const row=await repository.get(name,wid,id);if(row.upstream_id)throw new DataError('UPSTREAM_EDIT_REQUIRED',409)}
          if(method==='PATCH'&&id){const input=await readJson(req);json(res,200,{data:await decorate(wid,await repository.update(name,wid,id,input,{version:input.version}))});return}
          if(method==='DELETE'&&id){await repository.remove(name,wid,id);json(res,200,{success:true});return}
          throw new DataError('METHOD_NOT_ALLOWED',405);
        }
        if(await compatibility.handle(req,res,url,ctx))return;
        if(!ctx.bridge.status().configured&&path.startsWith('/api/')&&path!=='/api/keys/status'){
          if(path==='/api/keys/accounts'){json(res,200,{data:[],connectionRequired:true});return}
          if(path==='/api/subscription/status'){json(res,200,{isSubscribed:false,dreath:null,remainingDays:0,connectionRequired:true});return}
          if(['/api/personas','/api/templates/comment','/api/threads','/api/batch-sessions'].includes(path)&&method==='GET'){json(res,200,{data:[],personas:[],sessions:[],total:0,connectionRequired:true});return}
          throw new DataError('ORIGINAL_CONNECTION_REQUIRED',401);
        }
        if(!ctx.bridge.status().configured&&path==='/api/keys/status'&&url.searchParams.get('provider')!=='AI'){json(res,200,{provider:url.searchParams.get('provider'),hasKey:false,rawHasKey:false,tokenStatus:'NONE',connectionRequired:true});return}
        if(ctx.bridge.match(url)){const response=await ctx.bridge.request(url);await reply(res,observe(response,{path:path+url.search,method}));return}
        // The legacy handlers enforce their original localhost CSRF shape after
        // the public Origin and viewer-specific token have already been checked.
        req.headers.origin='http://'+req.headers.host;req.headers['x-rea-workflow-token']=internalNonce;
        if(await workflows(req,res,url))return;
        if(path==='/'){res.writeHead(302,{location:'/dashboard/insights'}).end();return}
        throw new DataError('NOT_FOUND',404);
      });
    }catch(error){await event({method:req.method,pathname:new URL(req.url,publicOrigin).pathname,status:error.status??500,code:error.code??error.name}).catch(()=>{});fail(res,error)}
  });
  return{server,sessions,repository,async close(){sessions.close();await Promise.allSettled([...pending]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const defaultEnv=join(homedir(),'AppData/Local/HongThreads/secrets/mission6.env');
  try{process.loadEnvFile(process.env.MISSION6_ENV_FILE??defaultEnv)}catch(error){if(error.code!=='ENOENT')throw error}
  const port=Number(process.env.PORT??9251),publicOrigin=process.env.PUBLIC_ORIGIN??'http://127.0.0.1:'+port;
  const repository=await createRepository({backend:process.env.DATA_BACKEND??'supabase',directory:process.env.DREATHS_LOCAL_DATA_DIR});
  const vertex=new VertexWifBridge();try{await vertex.authenticate()}catch(error){console.error('VERTEX_NOT_READY',error.code??'VERTEX_AUTH')}
  const app=await createMissionServer({repository,publicOrigin,secret:process.env.SESSION_SIGNING_SECRET,vertex,nextUrl:process.env.DRT_NEXT_URL??'http://127.0.0.1:9250',logDirectory:process.env.HONGTHREADS_LOG_DIR??join(root,'mission6/runtime-data/logs')});
  app.server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,origin:publicOrigin,storage:repository.backend,vertex:vertex.status().credentialReady})));
  process.once('SIGTERM',()=>app.close().then(()=>process.exit(0)));
}
