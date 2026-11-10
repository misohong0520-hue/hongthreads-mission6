import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {createLocalBenchmarkStore} from './local-benchmark-store.mjs';

const failure=(code,status=400)=>Object.assign(new Error(code),{code,status});
const extensionOrigin=value=>/^chrome-extension:\/\/[a-p]{32}$/.test(value??'');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mediaName=/^[0-9a-f-]{36}\.(?:jpg|jpeg|png|gif|webp|mp4|webm|mov)$/i;
const types=new Map([['image/jpeg','jpg'],['image/png','png'],['image/gif','gif'],['image/webp','webp'],['video/mp4','mp4'],['video/webm','webm'],['video/quicktime','mov']]);
const read=async(req,limit=8*1024*1024)=>{
  if(Number(req.headers['content-length'])>limit){req.resume();throw failure('LOCAL_BODY_TOO_LARGE',413)}
  let count=0;const chunks=[];for await(const chunk of req){count+=chunk.length;if(count>limit)throw failure('LOCAL_BODY_TOO_LARGE',413);chunks.push(chunk)}return Buffer.concat(chunks);
};
const parse=async req=>{try{return JSON.parse(await read(req))}catch(error){if(error.code)throw error;throw failure('INVALID_JSON')}};
const listIds=value=>String(value??'').split(',').filter(Boolean).map(Number).filter(Number.isSafeInteger).filter(value=>value>0);
const validThread=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
  /(^|\.)threads\.(com|net)$/.test(u.hostname)&&(/^\/@[^/]+\/post\/[^/]+(?:\/|$)/.test(u.pathname)||/^\/t\/[^/]+(?:\/|$)/.test(u.pathname))?u.href:null}catch{return null}};
const mimeOf=(bytes,fallback)=>{
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216)return 'image/jpeg';
  if(bytes.subarray(0,3).toString()==='GIF')return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(bytes.subarray(4,8).toString()==='ftyp')return fallback==='video/quicktime'?fallback:'video/mp4';
  if(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])))return 'video/webm';
  throw failure('INVALID_MEDIA_TYPE',415);
};

export async function createLocalBenchmarkService({directory,nonce,recordEvent=async()=>{},protect,unprotect,now=Date.now}){
  const store=await createLocalBenchmarkStore({directory,protect,unprotect,now});
  const mediaRoot=join(directory,'media');await mkdir(mediaRoot,{recursive:true});
  const uploads=new Map(),jobs=new Map();
  const web=req=>req.headers['x-rea-workflow-token']===nonce&&req.headers['sec-fetch-site']!=='cross-site'&&
    (!req.headers.origin||req.headers.origin==='http://'+req.headers.host);
  const webWrite=req=>web(req)&&req.headers.origin==='http://'+req.headers.host;
  const bearer=async req=>{
    if(req.headers.origin&&!extensionOrigin(req.headers.origin)&&req.headers.origin!=='http://'+req.headers.host)return false;
    const match=/^Bearer ([A-Za-z0-9_.-]{10,32768})$/.exec(req.headers.authorization??'');
    return match?Boolean(await store.verifyToken(match[1])):false;
  };
  const reply=(req,res,status,value)=>{
    const bytes=value===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(value));
    const cors=extensionOrigin(req.headers.origin)?{'access-control-allow-origin':req.headers.origin,vary:'Origin'}:{};
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store',
      'x-content-type-options':'nosniff','x-rea-benchmark-source':'local',...cors});res.end(bytes);
  };
  const trace=async(event,code='OK',status)=>{try{await recordEvent({channel:'benchmark_internal',at:new Date(now()).toISOString(),event,code,...(status?{status}:{})})}catch{}};
  const saveFile=async(filename,bytes,requestedMime)=>{
    if(!mediaName.test(filename)||!bytes.length)throw failure('INVALID_MEDIA');
    const mime=mimeOf(bytes,requestedMime);await writeFile(join(mediaRoot,filename),bytes,{flag:'wx',mode:0o600});
    await writeFile(join(mediaRoot,filename+'.json'),JSON.stringify({mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}),{flag:'wx',mode:0o600});
    return mime;
  };
  const fileResponse=async(req,res,filename)=>{
    if(!mediaName.test(filename))throw failure('LOCAL_MEDIA_NOT_FOUND',404);
    let info,size;try{info=JSON.parse(await readFile(join(mediaRoot,filename+'.json'),'utf8'));size=(await stat(join(mediaRoot,filename))).size}catch{throw failure('LOCAL_MEDIA_NOT_FOUND',404)}
    let start=0,end=size-1,status=200;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2]))throw failure('INVALID_RANGE',416);
      if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);
      if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
      if(start>=size||start<0||end<start)throw failure('INVALID_RANGE',416);status=206;
    }
    res.writeHead(status,{'content-type':info.mime,'content-length':end-start+1,'accept-ranges':'bytes','cache-control':'private, max-age=3600',
      'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'",...(status===206?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD'){res.end();return}
    const stream=createReadStream(join(mediaRoot,filename),{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  };
  const owned=path=>['/api/keys/extension','/api/reference/scrap','/api/scraps/folders','/api/scraps/by-url','/api/upload','/api/upload/presigned-url','/api/errors/scrap-media'].includes(path)||path.startsWith('/__local_benchmark/');
  return {
    store,
    async status(){return{...await store.status(),automaticKeyIssuance:true,refreshSeconds:30}},
    async handle(req,res,url){
      if(!owned(url.pathname))return false;
      // Other original editors retain their original upload destination.
      if(['/api/upload','/api/upload/presigned-url'].includes(url.pathname)&&!req.headers.authorization&&!extensionOrigin(req.headers.origin)){
        let referrer;try{referrer=new URL(req.headers.referer)}catch{}
        if(referrer?.origin==='http://'+req.headers.host&&['/write','/multi-write','/smart-multi-write'].includes(referrer.pathname))return false;
      }
      try{
        if(!/^(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(req.headers.host??''))throw failure('LOOPBACK_HOST_REQUIRED',421);
        const path=url.pathname,method=req.method.toUpperCase(),origin='http://'+req.headers.host;
        if(path==='/__local_benchmark/install'&&method==='GET'){
          const bytes=await readFile(new URL('../로컬-확장프로그램-설치.txt',import.meta.url));
          res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-length':bytes.length,'cache-control':'no-store',
            'content-security-policy':"default-src 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}).end(bytes);return true;
        }
        const file=path.startsWith('/__local_benchmark/media/')?path.slice('/__local_benchmark/media/'.length):null;
        if(file&&['GET','HEAD'].includes(method)){await fileResponse(req,res,file);return true}
        if(method==='OPTIONS'){
          if(!extensionOrigin(req.headers.origin)||path==='/api/keys/extension')throw failure('EXTENSION_ORIGIN_REQUIRED',403);
          const requested=String(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
          if(requested.some(value=>!['authorization','content-type'].includes(value)))throw failure('INVALID_CORS_HEADERS',403);
          res.writeHead(204,{'access-control-allow-origin':req.headers.origin,'access-control-allow-methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-allow-headers':'Authorization, Content-Type','access-control-allow-private-network':'true',vary:'Origin','cache-control':'no-store'}).end();return true;
        }
        if(path==='/api/keys/extension'){
          if(method!=='POST'||url.search)throw failure('INVALID_KEY_REQUEST',405);
          if(!webWrite(req))throw failure('LOCAL_UI_REQUIRED',403);
          if((await read(req,1024)).length)throw failure('KEY_BODY_MUST_BE_EMPTY');
          const rotate=req.headers['x-rea-local-key-rotate']==='1';
          const issued=await store.issueToken({rotate});reply(req,res,200,issued);await trace(rotate?'local_key_rotated':'local_key_ready');return true;
        }
        if(path.startsWith('/__local_benchmark/uploads/')&&method==='PUT'){
          if(req.headers.origin&&!extensionOrigin(req.headers.origin)&&req.headers.origin!==origin)throw failure('INVALID_UPLOAD_ORIGIN',403);
          const ticket=path.slice('/__local_benchmark/uploads/'.length),entry=uploads.get(ticket);
          if(!entry||entry.expires<now())throw failure('UPLOAD_TICKET_EXPIRED',401);
          uploads.delete(ticket);await saveFile(entry.filename,await read(req,64*1024*1024),entry.mime);reply(req,res,200,{ok:true});return true;
        }
        const authorized=await bearer(req);
        if(!authorized&&!(method==='GET'?web(req):webWrite(req)))throw failure('LOCAL_AUTH_REQUIRED',401);
        if(path==='/__local_benchmark/key-check'&&method==='GET'){
          if(!authorized)throw failure('LOCAL_AUTH_REQUIRED',401);reply(req,res,200,{valid:true,so_id:1});return true;
        }
        if(path==='/api/upload/presigned-url'&&method==='POST'){
          const body=await parse(req),mime=String(body.fileType??'');if(!types.has(mime))throw failure('INVALID_MEDIA_TYPE',415);
          const filename=randomUUID()+'.'+types.get(mime),ticket=randomUUID();uploads.set(ticket,{filename,mime,expires:now()+5*60000});
          reply(req,res,200,{uploadUrl:origin+'/__local_benchmark/uploads/'+ticket,finalPublicUrl:origin+'/__local_benchmark/media/'+filename});return true;
        }
        if(path==='/api/upload'&&method==='POST'){
          const bytes=await read(req,64*1024*1024),request=new Request(origin+'/api/upload',{method:'POST',headers:{'content-type':req.headers['content-type']??''},body:bytes});
          let file;try{file=(await request.formData()).get('file')}catch{throw failure('INVALID_MULTIPART')}
          if(!file||typeof file.arrayBuffer!=='function')throw failure('MEDIA_FILE_REQUIRED');
          const content=Buffer.from(await file.arrayBuffer()),mime=mimeOf(content,file.type),filename=randomUUID()+'.'+types.get(mime);
          await saveFile(filename,content,mime);const link=origin+'/__local_benchmark/media/'+filename;reply(req,res,200,{url:link,thumbnail_url:mime.startsWith('image/')?link:null});return true;
        }
        if(path==='/api/reference/scrap'){
          if(method==='GET'){
            const page=Number(url.searchParams.get('page')??1),limit=Number(url.searchParams.get('limit')??15),search=url.searchParams.get('search')??'';
            if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100||search.length>500)throw failure('INVALID_LIST_REQUEST');
            reply(req,res,200,await store.listScraps({page,limit,search,folder_id:url.searchParams.get('folder_id')??'ALL',
              view_mode:url.searchParams.get('view_mode')??'MINE',link_filter:url.searchParams.get('link_filter')??'ALL'}));return true;
          }
          if(method==='POST'){
            const result=await store.saveScrap(await parse(req));reply(req,res,200,result);await trace('local_scrap_saved');return true;
          }
          if(['PUT','PATCH'].includes(method)){
            const body=await parse(req),id=Number(url.searchParams.get('id')??body.id??body.scrap_id),patch={...body};
            if(body.action){reply(req,res,200,await store.applyAction(body));await trace('local_scrap_classification_saved');return true}
            if(method==='PATCH'&&Array.isArray(body.ids)){
              await store.moveScraps(body.ids,body.folder_id);reply(req,res,200,{success:true});return true;
            }
            if(!Number.isSafeInteger(id)||id<1)throw failure('INVALID_SCRAP_ID');
            const row=await store.updateScrap(id,patch);if(!row)throw failure('LOCAL_SCRAP_NOT_FOUND',404);reply(req,res,200,{success:true,...row});return true;
          }
          if(method==='DELETE'){
            let ids=listIds(url.searchParams.get('ids')??url.searchParams.get('id'));
            if(!ids.length){const body=await parse(req);ids=Array.isArray(body.ids)?body.ids.map(Number).filter(Number.isSafeInteger).filter(id=>id>0):[]}
            if(!ids.length)throw failure('SCRAP_IDS_REQUIRED');
            reply(req,res,200,{success:true,deleted:await store.deleteScraps(ids)});return true;
          }
        }
        if(path==='/api/scraps/folders'){
          if(method==='GET'){reply(req,res,200,await store.listFolders());return true}
          if(method==='POST'){reply(req,res,200,{success:true,folder:await store.createFolder((await parse(req)).folder_name)});return true}
          if(method==='PATCH'){reply(req,res,200,{success:true,folder:await store.renameFolder(Number(url.searchParams.get('id')),(await parse(req)).folder_name)});return true}
          if(method==='DELETE'){
            const ids=listIds(url.searchParams.get('ids')??url.searchParams.get('id'));if(!ids.length)throw failure('FOLDER_IDS_REQUIRED');
            reply(req,res,200,{success:true,deleted:await store.deleteFolders(ids)});return true;
          }
          if(method==='PUT'){
            const body=await parse(req);await store.reorderFolders(body.folder_orders);reply(req,res,200,{success:true});return true;
          }
        }
        if(path==='/api/scraps/by-url'&&method==='POST'){
          if(!webWrite(req))throw failure('LOCAL_UI_REQUIRED',403);
          const body=await parse(req),target=validThread(body.url);if(!target)throw failure('THREAD_POST_URL_REQUIRED');
          for(const[id,job]of jobs)if(job.expires<now())jobs.delete(id);
          if(jobs.size>100)throw failure('LOCAL_JOB_LIMIT',429);
          const id=randomUUID();jobs.set(id,{url:target,folder_id:body.folder_id??null,state:'pending',expires:now()+120000});
          reply(req,res,202,{local_job:true,job_id:id,url:target});return true;
        }
        const match=/^\/__local_benchmark\/jobs\/([^/]+)(\/result)?$/.exec(path);
        if(match&&uuid.test(match[1])){
          const job=jobs.get(match[1]);if(!job||job.expires<now())throw failure('LOCAL_JOB_EXPIRED',404);
          if(!match[2]&&method==='GET'){reply(req,res,200,{state:job.state,url:job.url,folder_id:job.folder_id,...(job.scrap_id?{data:{id:job.scrap_id}}:{}),...(job.code?{error:job.code}:{})});return true}
          if(match[2]&&method==='POST'&&authorized){
            const result=await parse(req),row=result.success?await store.getScrap(Number(result.scrap_id)):null;
            if(result.success&&!row)throw failure('LOCAL_SCRAP_NOT_FOUND',404);
            if(row&&job.folder_id!==null)await store.updateScrap(row.id,{folder_id:job.folder_id});
            job.state=row?'complete':'failed';job.scrap_id=row?.id;job.code=row?null:'LOCAL_SCRAP_FAILED';reply(req,res,200,{ok:true});return true;
          }
        }
        if(path==='/api/errors/scrap-media'&&method==='POST'){await read(req,1024*1024);await trace('local_media_capture_failed','MEDIA_CAPTURE_FAILED');reply(req,res,200,{ok:true});return true}
        throw failure('LOCAL_ROUTE_NOT_SUPPORTED',405);
      }catch(error){
        const status=Number(error.status)||500;await trace('local_benchmark_error',error.code??'LOCAL_ERROR',status);
        if(!res.headersSent)reply(req,res,status,{error:error.code??'LOCAL_ERROR'});else res.destroy();return true;
      }
    }
  };
}
