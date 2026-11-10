import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {BROWSER_WIF_EXTENSION_ID,BROWSER_WIF_ORIGIN,BROWSER_WIF_PREFIX as prefix} from './browser-wif-contract.mjs';
import {VERTEX_MAX_BYTES} from './vertex-wif-bridge.mjs';

export function createBrowserWifRoutes({vertex,maxBytes=VERTEX_MAX_BYTES,now=Date.now}){
  const token=randomBytes(32).toString('hex'),jobs=new Map();let latestBrowser=null,lastGeneration=null;
  const observedPaths=new Set(['/onboarding','/write','/multi-write','/smart-multi-write','/mypage','/dashboard/insights','/dashboard/personas','/dashboard/threads-manage','/dashboard/threads']);
  const moduleIds=new Set([73147,93272,77872,68114,89465,31441,10279,67499]);
  const trusted=req=>req.headers.origin===BROWSER_WIF_ORIGIN||
    (req.headers.origin===undefined&&req.headers['sec-fetch-site']==='none'&&req.headers['x-rea-extension-id']===BROWSER_WIF_EXTENSION_ID);
  const authenticated=req=>{
    const supplied=req.headers['x-rea-browser-token'];
    return typeof supplied==='string'&&supplied.length===token.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
  };
  const send=(req,res,status,value)=>{
    const body=Buffer.from(JSON.stringify(value));
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':body.length,'cache-control':'no-store',
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer','vary':'Origin',
      ...(trusted(req)?{'access-control-allow-origin':BROWSER_WIF_ORIGIN}:{}),
      'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type, X-Rea-Browser-Token, X-Rea-Extension-Id'});
    res.end(body);
  };
  const read=async(req,limit)=>{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('BROWSER_WIF_BODY_LIMIT'),{status:413});chunks.push(chunk)}
    try{return{value:JSON.parse(Buffer.concat(chunks).toString('utf8')),bytes:size}}catch{throw Object.assign(new Error('BROWSER_WIF_JSON_REQUIRED'),{status:400})}
  };
  const prune=()=>{for(const[id,job]of jobs)if(now()-(job.finishedAt??job.startedAt)>(job.finishedAt?30000:240000))jobs.delete(id)};
  const status=()=>{prune();return{enabled:true,extensionId:BROWSER_WIF_EXTENSION_ID,activeJobs:[...jobs.values()].filter(job=>job.state==='pending').length,latestBrowser,lastGeneration}};
  const handle=async(req,res,url)=>{
    if(!url.pathname.startsWith(prefix+'/'))return false;
    if(!trusted(req)){req.resume();send(req,res,403,{error:'BROWSER_EXTENSION_REQUIRED'});return true}
    const handshake=url.pathname===prefix+'/handshake',jobId=url.pathname.match(new RegExp('^'+prefix+'/jobs/([0-9a-f-]{36})$'))?.[1];
    if(url.search||(!handshake&&url.pathname!==prefix+'/jobs'&&!jobId)){req.resume();send(req,res,404,{error:'BROWSER_WIF_ROUTE'});return true}
    if(req.method==='OPTIONS'){req.resume();send(req,res,200,{ok:true});return true}
    if(req.method!==(jobId?'GET':'POST')){req.resume();send(req,res,405,{error:'BROWSER_WIF_METHOD'});return true}
    if(!handshake&&!authenticated(req)){req.resume();send(req,res,403,{error:'BROWSER_WIF_TOKEN'});return true}
    try{
      if(handshake){
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw Object.assign(new Error('BROWSER_WIF_JSON_REQUIRED'),{status:415});
        const {value}=await read(req,1024),observation=value?.observation;
        if(observation&&observedPaths.has(observation.path)&&[observation.matched,observation.mismatched].every(values=>Array.isArray(values)&&values.length<=moduleIds.size&&values.every(id=>moduleIds.has(id))))
          latestBrowser={path:observation.path,matchedModules:observation.matched,mismatchedModules:observation.mismatched,wifAuthenticated:vertex.status().credentialReady===true,at:new Date(now()).toISOString()};
        send(req,res,200,{controlToken:token,metadata:vertex.credentialMetadata()});return true;
      }
      prune();
      if(jobId){
        const job=jobs.get(jobId);if(!job){send(req,res,404,{error:'BROWSER_WIF_JOB_GONE'});return true}
        send(req,res,200,job.state==='pending'?{state:'pending'}:job.state==='done'?{state:'done',result:job.result}:{state:'error',error:job.error});return true;
      }
      if(!vertex.status().credentialReady){req.resume();send(req,res,503,{error:'VERTEX_AUTH'});return true}
      if(status().activeJobs>=3||jobs.size>=16){req.resume();send(req,res,429,{error:'BROWSER_WIF_BUSY'});return true}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw Object.assign(new Error('BROWSER_WIF_JSON_REQUIRED'),{status:415});
      const {value}=await read(req,maxBytes);
      if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.contents)||!value.contents.length)throw Object.assign(new Error('VERTEX_REQUEST'),{status:400});
      if(status().activeJobs>=3){send(req,res,429,{error:'BROWSER_WIF_BUSY'});return true}
      const id=randomUUID(),job={state:'pending',startedAt:now()};jobs.set(id,job);
      void Promise.resolve().then(()=>vertex.generate(value)).then(result=>{
        lastGeneration={at:new Date(now()).toISOString(),success:true,configuredModel:vertex.status().model??null,returnedModel:typeof result?.modelVersion==='string'?result.modelVersion:null};
        Object.assign(job,{state:'done',result,finishedAt:now()});
      },error=>{lastGeneration={at:new Date(now()).toISOString(),success:false,code:error.code??'VERTEX_REQUEST'};Object.assign(job,{state:'error',error:{code:error.code??'VERTEX_REQUEST',status:error.status??502},finishedAt:now()})});
      send(req,res,202,{jobId:id});
    }catch(error){if(!res.headersSent)send(req,res,error.status??502,{error:error.status?error.message:'VERTEX_REQUEST'});else res.destroy()}
    return true;
  };
  return{handle,status};
}
