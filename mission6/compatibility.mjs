import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {DataError} from './data/index.mjs';
import {readBody,readJson,json,multipart} from './http.mjs';
import {MIME_EXT} from './data/model.mjs';
import {clean} from './mirror.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
export const legacyId=row=>parseInt(row.id.replaceAll('-','').slice(0,12),16);
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function createCompatibility({repository,secret,publicOrigin,publicAsset}){
  const tickets=new Map();
  const sign=value=>{const payload=encoded(value);return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url')};
  const unsign=value=>{
    if(typeof value!=='string'||value.length>2048)return null;
    const [payload,signature,...extra]=value.split('.');if(extra.length||!payload||!signature)return null;
    const actual=Buffer.from(signature),expected=Buffer.from(createHmac('sha256',secret).update(payload).digest('base64url'));
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
    try{const data=JSON.parse(Buffer.from(payload,'base64url'));return uuid.test(data.wid)&&uuid.test(data.id)&&data.exp>Date.now()/1000?data:null}catch{return null}
  };
  const mediaUrl=(wid,id)=>publicOrigin+'/__local_benchmark/media/'+id+'?access='+sign({wid,id,exp:Math.floor(Date.now()/1000)+86400});
  const mediaId=value=>{try{const url=new URL(value);const id=url.pathname.split('/').at(-1);return url.origin===publicOrigin&&url.pathname.startsWith('/__local_benchmark/media/')&&uuid.test(id)?id:null}catch{return null}};
  const mediaReferences=async(wid,data)=>{
    const ids=[...new Set((data.media_items??[]).map(item=>mediaId(item?.url)).filter(Boolean))];
    if(ids.length>9)throw new DataError('TOO_MANY_ASSETS');
    for(const id of ids){const row=await repository.get('assets',wid,id);if(row.status!=='ready')throw new DataError('ASSET_NOT_READY',409)}
    return ids.map(id=>({id}));
  };
  const byId=async(resource,wid,id)=>{
    if(uuid.test(String(id)))return repository.get(resource,wid,String(id));
    for(let page=1;page<=100;page++){const batch=await repository.list(resource,wid,{page,limit:100});const found=batch.data.find(r=>legacyId(r)===Number(id));if(found)return found;if(page*100>=batch.total)break}
    throw new DataError('NOT_FOUND',404);
  };
  const legacyFolder=async(wid,id)=>id===null||id===undefined||['','NONE','null','ALL'].includes(String(id))?null:(await byId('folders',wid,id)).id;
  const all=async(resource,wid,options={})=>{const rows=[];for(let page=1;page<=100;page++){const batch=await repository.list(resource,wid,{...options,page,limit:100});rows.push(...batch.data);if(rows.length>=batch.total)return rows}throw new DataError('LIST_LIMIT',413)};
  const purpose=row=>row.metadata.is_stabilization||row.metadata.affiliate_type==='STABILIZATION'||row.metadata.scrap_purpose==='STABILIZATION'?'STABILIZATION':row.metadata.affiliate_url?'LINKED':'UNLINKED';
  const folderView=row=>({id:legacyId(row),folder_name:row.title,sort_order:row.metadata.sort_order??0,created_at:row.created_at});
  const view=async row=>{
    const replaceMedia=value=>{
      if(Array.isArray(value))return value.map(replaceMedia);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replaceMedia(item)]));
      const id=typeof value==='string'?mediaId(value):null;return id&&row.assets.some(a=>a.id===id)?mediaUrl(row.workspace_id,id):value;
    };
    const attachments=await Promise.all(row.assets.map(async a=>{const asset=await repository.get('assets',row.workspace_id,a.id);return{url:mediaUrl(row.workspace_id,a.id),type:asset.metadata.mime_type?.startsWith('video/')?'video':'image'}}));
    const metadata=replaceMedia(row.metadata);let structure=metadata.content_structure??{};if(typeof structure==='string'){try{structure=replaceMedia(JSON.parse(structure))}catch{}}
    const items=metadata.media_items?.length?metadata.media_items:attachments;
    if(!structure||typeof structure!=='object'||Array.isArray(structure))structure={};
    const stabilized=purpose(row)==='STABILIZATION';
    return{...metadata,id:legacyId(row),original_url:row.source_url||(metadata.original_url==='MANUAL_INPUT'?'MANUAL_INPUT':''),raw_content:row.content,extracted_content:row.content,excerpt:row.content,custom_guide:metadata.custom_guide??'',original_author:metadata.original_author??'',folder_id:row.folder_id?legacyId({id:row.folder_id}):null,media_items:items,content_structure:JSON.stringify({...structure,content:row.content,text:row.content,media_items:items,metrics:structure.metrics??{}}),scrap_purpose:metadata.scrap_purpose??'BENCHMARK',is_stabilization:stabilized,has_affiliate_link:!stabilized&&Boolean(metadata.affiliate_url),created_at:row.created_at,updated_at:row.updated_at};
  };
  const token=row=>{const header=encoded({alg:'HS256',typ:'JWT'}),payload=encoded({wid:row.workspace_id,jti:row.id,iat:row.metadata.iat,exp:row.metadata.exp,so_id:1});const data=header+'.'+payload;return data+'.'+createHmac('sha256',secret).update(data).digest('base64url')};
  const verify=async value=>{
    if(typeof value!=='string'||value.length>8192)return null;const parts=value.split('.');if(parts.length!==3)return null;
    const signature=createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest('base64url');const a=Buffer.from(parts[2]),b=Buffer.from(signature);if(a.length!==b.length||!timingSafeEqual(a,b))return null;
    let payload;try{payload=JSON.parse(Buffer.from(parts[1],'base64url'))}catch{return null}if(!payload.wid||!payload.jti||payload.exp<Date.now()/1000)return null;
    try{const row=await repository.get('extension-keys',payload.wid,payload.jti);if(row.status!=='active'||row.metadata.token_hash!==createHash('sha256').update(value).digest('hex'))return null;return{workspaceId:payload.wid}}catch{return null}
  };
  return{
    byId,view,verifyExtension:verify,
    capability(url,method){
      if(method==='PUT'&&url.pathname.startsWith('/__local_benchmark/uploads/')){const ticket=tickets.get(url.pathname.split('/').at(-1));if(ticket&&!ticket.used&&ticket.expires>Date.now())return{workspaceId:ticket.workspaceId,upload:true}}
      if(['GET','HEAD'].includes(method)&&url.pathname.startsWith('/__local_benchmark/media/')){const data=unsign(url.searchParams.get('access'));if(data&&data.id===url.pathname.split('/').at(-1))return{workspaceId:data.wid,media:true}}
      return null;
    },
    async handle(req,res,url,ctx){
      const path=url.pathname,method=req.method,wid=ctx.workspace.id;
      let benchmarkUpload=false;try{const referer=new URL(req.headers.referer??'');benchmarkUpload=referer.origin===publicOrigin&&referer.pathname==='/dashboard/benchmark'}catch{}
      const ownedUpload=ctx.extension||!ctx.bridge.status().configured||benchmarkUpload;
      if(path==='/api/keys/extension'&&method==='POST'){
        let row=(await repository.list('extension-keys',wid,{limit:100})).data.find(r=>r.status==='active'&&r.metadata.exp>Date.now()/1000);
        if(req.headers['x-rea-local-key-rotate']==='1'&&row){await repository.update('extension-keys',wid,row.id,{status:'revoked'});row=null}
        if(!row){const iat=Math.floor(Date.now()/1000),id=randomUUID();const draft={id,workspace_id:wid,metadata:{iat,exp:iat+30*86400}};const value=token(draft);row=await repository.create('extension-keys',wid,{id,title:'확장 프로그램 연결',metadata:{...draft.metadata,token_hash:createHash('sha256').update(value).digest('hex')}})}
        json(res,200,{token:token(row),so_id:1});return true;
      }
      if(path==='/__local_benchmark/key-check'&&method==='GET'){json(res,200,{valid:true,so_id:1});return true}
      if(path==='/api/scraps/folders'){
        if(method==='GET'){
          const folders=await all('folders',wid),scraps=await all('benchmarks',wid);
          json(res,200,{folders:folders.map(r=>({...folderView(r),count:scraps.filter(s=>s.folder_id===r.id).length,scrap_count:scraps.filter(s=>s.folder_id===r.id).length})).sort((a,b)=>a.sort_order-b.sort_order),total_count:scraps.length,uncategorized_count:scraps.filter(s=>!s.folder_id).length});return true;
        }
        const data=await readJson(req);
        if(method==='POST'){const row=await repository.create('folders',wid,{title:data.folder_name??data.title});json(res,201,{success:true,folder:folderView(row),data:folderView(row)});return true}
        if(method==='PATCH'){const row=await byId('folders',wid,url.searchParams.get('id')??data.id);json(res,200,{success:true,folder:folderView(await repository.update('folders',wid,row.id,{title:data.folder_name??data.title}))});return true}
        if(method==='PUT'){for(const item of data.folder_orders??[]){const row=await byId('folders',wid,item.id);await repository.update('folders',wid,row.id,{metadata:{...row.metadata,sort_order:Number(item.sort_order)||0}})}json(res,200,{success:true});return true}
        if(method==='DELETE'){for(const id of (url.searchParams.get('ids')??url.searchParams.get('id')??'').split(',').filter(Boolean)){const row=await byId('folders',wid,id);await repository.remove('folders',wid,row.id)}json(res,200,{success:true});return true}
      }
      if(path==='/api/reference/scrap'){
        if(method==='GET'){
          if(url.searchParams.get('view_mode')==='ALL_USERS')return false;
          const folder=url.searchParams.get('folder_id');const options={page:Number(url.searchParams.get('page')??1),limit:Number(url.searchParams.get('limit')??15),search:url.searchParams.get('search')??'',...(folder!==null?{folderId:await legacyFolder(wid,folder)}:{})};
          // Validate pagination before collecting owned records for the original
          // metadata-based category filters and summary counters.
          await repository.list('benchmarks',wid,{...options,limit:options.limit});
          const filter=url.searchParams.get('link_filter')??'ALL';if(!['ALL','LINKED','UNLINKED','STABILIZATION'].includes(filter))throw new DataError('INVALID_FILTER');
          const rows=await all('benchmarks',wid,options),selected=filter==='ALL'?rows:rows.filter(r=>purpose(r)===filter),summary={all:rows.length,linked:0,unlinked:0,stabilization:0};for(const row of rows)summary[purpose(row).toLowerCase()]++;
          json(res,200,{page:options.page,limit:options.limit,total:selected.length,data:await Promise.all(selected.slice((options.page-1)*options.limit,options.page*options.limit).map(view)),success:true,link_summary:summary});return true;
        }
        const data=await readJson(req,4*1024*1024);
        if(data.action&&['PATCH','PUT'].includes(method)){
          const action=data.action;if(!['SAVE_LINK','REMOVE_LINK','SAVE_STABILIZATION','BULK_SET_STABILIZATION','BULK_REMOVE_PURPOSE'].includes(action))throw new DataError('SHARED_LIBRARY_ACTION_UNAVAILABLE',503);
          const ids=action.startsWith('BULK_')?data.ids:[data.scrap_id];if(!Array.isArray(ids)||!ids.length||ids.length>100)throw new DataError('INVALID_IDS');
          const selected=await Promise.all(ids.map(id=>byId('benchmarks',wid,id)));let patch;
          if(action==='SAVE_LINK'){
            let url;try{url=new URL(data.affiliate_url)}catch{}
            if(!data.affiliate_type||data.affiliate_type==='STABILIZATION'||!url||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new DataError('AFFILIATE_LINK_REQUIRED');
            patch={...clean(data),is_stabilization:false,has_affiliate_link:true,scrap_purpose:'BENCHMARK'};
          }else if(['SAVE_STABILIZATION','BULK_SET_STABILIZATION'].includes(action))patch={...clean(data),affiliate_type:'STABILIZATION',affiliate_url:'',is_stabilization:true,has_affiliate_link:false,scrap_purpose:'STABILIZATION'};
          else patch={affiliate_type:null,affiliate_url:'',affiliate_meta:null,is_stabilization:false,has_affiliate_link:false,scrap_purpose:'BENCHMARK'};
          const updated=[];for(const row of selected)updated.push(await repository.update('benchmarks',wid,row.id,{metadata:{...row.metadata,...patch}}));json(res,200,{success:true,updated:updated.length,...(updated.length===1?{id:legacyId(updated[0]),data:await view(updated[0])}:{})});return true;
        }
        if(method==='POST'){
          const source=data.original_url??data.source_url??'';
          const row=await repository.create('benchmarks',wid,{title:String(data.title??data.raw_content??'벤치마킹 자료').slice(0,200)||'벤치마킹 자료',content:data.raw_content??data.content??'',source_url:source==='MANUAL_INPUT'?'':source,folder_id:await legacyFolder(wid,data.folder_id),assets:await mediaReferences(wid,data),metadata:clean(data)});json(res,201,{success:true,id:legacyId(row),data:await view(row)});return true;
        }
        const ids=data.ids??(method==='DELETE'&&url.searchParams.has('ids')?url.searchParams.get('ids').split(','):[url.searchParams.get('id')??data.scrap_id??data.id]);
        if(!Array.isArray(ids)||!ids.length||ids.length>100)throw new DataError('INVALID_IDS');
        for(const id of ids){const row=await byId('benchmarks',wid,id);if(method==='DELETE'){await repository.remove('benchmarks',wid,row.id);continue}if(['PATCH','PUT'].includes(method))await repository.update('benchmarks',wid,row.id,{...(data.raw_content!==undefined?{content:data.raw_content}:{}),...(data.folder_id!==undefined?{folder_id:await legacyFolder(wid,data.folder_id)}:{}),metadata:{...row.metadata,...clean(data)}});else throw new DataError('METHOD_NOT_ALLOWED',405)}
        json(res,200,{success:true});return true;
      }
      if(path==='/api/upload/presigned-url'&&method==='POST'&&ownedUpload){
        for(const[id,ticket]of tickets)if(ticket.expires<Date.now())tickets.delete(id);
        if([...tickets.values()].filter(t=>t.workspaceId===wid&&!t.used).length>=30)throw new DataError('UPLOAD_LIMIT',429);
        const data=await readJson(req),id=randomUUID(),assetId=randomUUID(),mime=data.fileType??data.contentType;
        if(!MIME_EXT[mime])throw new DataError('INVALID_MEDIA_TYPE',415);
        tickets.set(id,{workspaceId:wid,assetId,mime,name:data.fileName??'upload.'+MIME_EXT[mime],expires:Date.now()+300000});
        json(res,200,{uploadUrl:publicOrigin+'/__local_benchmark/uploads/'+id,finalPublicUrl:mediaUrl(wid,assetId)});return true;
      }
      if(path.startsWith('/__local_benchmark/uploads/')&&method==='PUT'){
        const id=path.split('/').at(-1),ticket=tickets.get(id);if(!ticket||ticket.used||ticket.expires<Date.now()||ticket.workspaceId!==wid)throw new DataError('UPLOAD_EXPIRED',401);
        ticket.used=true;
        try{const bytes=await readBody(req,50*1024*1024);await repository.uploadAsset(wid,{filename:ticket.name,mimeType:ticket.mime,bytes},{id:ticket.assetId});json(res,200,{ok:true})}catch(error){tickets.delete(id);throw error}return true;
      }
      if(path.startsWith('/__local_benchmark/media/')&&['GET','HEAD'].includes(method)){
        const asset=await repository.downloadAsset(wid,path.split('/').at(-1));res.writeHead(200,{'content-type':asset.row.metadata.mime_type,'content-length':asset.bytes.length,'cache-control':'private,no-store','x-content-type-options':'nosniff'}).end(method==='HEAD'?undefined:asset.bytes);return true;
      }
      if(path==='/api/upload'&&method==='POST'&&ownedUpload){
        const form=await multipart(req),file=form.get('file');if(!file?.arrayBuffer)throw new DataError('FILE_REQUIRED');
        const row=await repository.uploadAsset(wid,{filename:file.name,mimeType:file.type,bytes:Buffer.from(await file.arrayBuffer())}),link=mediaUrl(wid,row.id);json(res,200,{url:link,thumbnail_url:file.type.startsWith('image/')?link:null});return true;
      }
      if(path==='/api/scraps/by-url'&&method==='POST'){
        const data=await readJson(req);let target;try{target=new URL(data.url)}catch{}
        if(!target||target.protocol!=='https:'||target.username||target.password||target.port||!/(^|\.)threads\.(com|net)$/.test(target.hostname)||!(/\/@[^/]+\/post\/[^/]+/.test(target.pathname)||/^\/t\/[^/]+/.test(target.pathname)))throw new DataError('THREAD_POST_URL_REQUIRED');
        const folder=await legacyFolder(wid,data.folder_id),row=await repository.create('sync_events',wid,{title:'Threads URL 수집',status:'pending',metadata:{type:'scrape_job',url:target.href,folder_id:folder,expires:Date.now()+120000}});
        json(res,202,{local_job:true,job_id:row.id,url:target.href});return true;
      }
      const jobPath=/^\/__local_benchmark\/jobs\/([a-f0-9-]+)(\/result)?$/.exec(path);
      if(jobPath){
        const job=await repository.get('sync_events',wid,jobPath[1]);if(job.metadata.type!=='scrape_job'||job.metadata.expires<Date.now())throw new DataError('LOCAL_JOB_EXPIRED',404);
        if(method==='GET'&&!jobPath[2]){json(res,200,{state:job.status,url:job.metadata.url,...(job.metadata.scrap_id?{data:{id:job.metadata.scrap_id}}:{}),...(job.status==='failed'?{error:'LOCAL_SCRAP_FAILED'}:{})});return true}
        if(method==='POST'&&jobPath[2]&&ctx.extension){
          if(job.status!=='pending')throw new DataError('JOB_ALREADY_COMPLETED',409);const result=await readJson(req);let row;
          if(result.success){row=await byId('benchmarks',wid,result.scrap_id);if(row.source_url!==job.metadata.url)throw new DataError('JOB_URL_MISMATCH',409);if(job.metadata.folder_id)await repository.update('benchmarks',wid,row.id,{folder_id:job.metadata.folder_id})}
          await repository.update('sync_events',wid,job.id,{status:row?'complete':'failed',metadata:{...job.metadata,scrap_id:row?legacyId(row):null}});json(res,200,{ok:true});return true;
        }
        throw new DataError('METHOD_NOT_ALLOWED',405);
      }
      if(path==='/api/errors/scrap-media'&&method==='POST'){const data=clean(await readJson(req,1024*1024));await repository.create('sync_events',wid,{title:'스크랩 첨부 수집 오류',status:'failed',metadata:{type:'scrap_media',detail:data}});json(res,200,{ok:true});return true}
      if(path==='/__local_benchmark/install'&&method==='GET'){res.writeHead(302,{location:'/extensions/hongthreads.zip','cache-control':'no-store'}).end();return true}
      return false;
    }
  };
}
