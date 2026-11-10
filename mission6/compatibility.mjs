import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {DataError} from './data/index.mjs';
import {readBody,readJson,json} from './http.mjs';
import {clean} from './mirror.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
export const legacyId=row=>parseInt(row.id.replaceAll('-','').slice(0,12),16);
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function createCompatibility({repository,secret,publicOrigin,publicAsset}){
  const tickets=new Map();
  const byId=async(resource,wid,id)=>{
    if(uuid.test(String(id)))return repository.get(resource,wid,String(id));
    for(let page=1;page<=100;page++){const batch=await repository.list(resource,wid,{page,limit:100});const found=batch.data.find(r=>legacyId(r)===Number(id));if(found)return found;if(page*100>=batch.total)break}
    throw new DataError('NOT_FOUND',404);
  };
  const legacyFolder=async(wid,id)=>id===null||id===undefined||['','NONE','null','ALL'].includes(String(id))?null:(await byId('folders',wid,id)).id;
  const folderView=row=>({id:legacyId(row),folder_name:row.title,sort_order:row.metadata.sort_order??0,created_at:row.created_at});
  const view=async row=>{
    const attachments=await Promise.all(row.assets.map(async a=>{const asset=await publicAsset(row.workspace_id,a.id);return{url:asset.url,type:asset.mime_type?.startsWith('video/')?'video':'image'}}));
    return{...row.metadata,id:legacyId(row),original_url:row.source_url,raw_content:row.content,original_author:row.metadata.original_author??'',folder_id:row.folder_id?legacyId({id:row.folder_id}):null,media_items:attachments.length?attachments:row.metadata.media_items??[],content_structure:typeof row.metadata.content_structure==='string'?row.metadata.content_structure:JSON.stringify(row.metadata.content_structure??{}),created_at:row.created_at,updated_at:row.updated_at};
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
    async handle(req,res,url,ctx){
      const path=url.pathname,method=req.method,wid=ctx.workspace.id;
      if(path==='/api/keys/extension'&&method==='POST'){
        let row=(await repository.list('extension-keys',wid,{limit:100})).data.find(r=>r.status==='active'&&r.metadata.exp>Date.now()/1000);
        if(req.headers['x-rea-local-key-rotate']==='1'&&row){await repository.update('extension-keys',wid,row.id,{status:'revoked'});row=null}
        if(!row){const iat=Math.floor(Date.now()/1000),id=randomUUID();const draft={id,workspace_id:wid,metadata:{iat,exp:iat+30*86400}};const value=token(draft);row=await repository.create('extension-keys',wid,{id,title:'확장 프로그램 연결',metadata:{...draft.metadata,token_hash:createHash('sha256').update(value).digest('hex')}})}
        json(res,200,{token:token(row),so_id:1});return true;
      }
      if(path==='/__local_benchmark/key-check'&&method==='GET'){json(res,200,{valid:true,so_id:1});return true}
      if(path==='/api/scraps/folders'){
        if(method==='GET'){
          const folders=await repository.list('folders',wid,{limit:100}),scraps=await repository.list('benchmarks',wid,{limit:100});
          json(res,200,{folders:folders.data.map(r=>({...folderView(r),scrap_count:scraps.data.filter(s=>s.folder_id===r.id).length})).sort((a,b)=>a.sort_order-b.sort_order),total_count:scraps.total,uncategorized_count:scraps.data.filter(s=>!s.folder_id).length});return true;
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
          const batch=await repository.list('benchmarks',wid,options);json(res,200,{...batch,data:await Promise.all(batch.data.map(view)),success:true,link_summary:{all:batch.total,linked:batch.data.filter(r=>r.metadata.affiliate_url).length,unlinked:batch.data.filter(r=>!r.metadata.affiliate_url).length,stabilization:batch.data.filter(r=>r.metadata.is_stabilization).length}});return true;
        }
        const data=await readJson(req,4*1024*1024);
        if(method==='POST'){
          const row=await repository.create('benchmarks',wid,{title:String(data.title??data.raw_content??'벤치마킹 자료').slice(0,200)||'벤치마킹 자료',content:data.raw_content??data.content??'',source_url:data.original_url??data.source_url??'',folder_id:await legacyFolder(wid,data.folder_id),metadata:clean(data)});json(res,201,{success:true,id:legacyId(row),data:await view(row)});return true;
        }
        const ids=data.ids??[data.scrap_id??data.id];
        if(!Array.isArray(ids)||!ids.length||ids.length>100)throw new DataError('INVALID_IDS');
        for(const id of ids){const row=await byId('benchmarks',wid,id);if(method==='DELETE'){await repository.remove('benchmarks',wid,row.id);continue}if(['PATCH','PUT'].includes(method))await repository.update('benchmarks',wid,row.id,{...(data.raw_content!==undefined?{content:data.raw_content}:{}),...(data.folder_id!==undefined?{folder_id:await legacyFolder(wid,data.folder_id)}:{}),metadata:{...row.metadata,...clean(data)}});else throw new DataError('METHOD_NOT_ALLOWED',405)}
        json(res,200,{success:true});return true;
      }
      if(path==='/api/upload/presigned-url'&&method==='POST'&&!ctx.bridge.status().configured){const data=await readJson(req),id=randomUUID();tickets.set(id,{workspaceId:wid,mime:data.fileType??data.contentType??'image/png',name:data.fileName??'upload',expires:Date.now()+300000});json(res,200,{uploadUrl:publicOrigin+'/__local_benchmark/uploads/'+id,finalPublicUrl:publicOrigin+'/__local_benchmark/media/'+id});return true}
      if(path.startsWith('/__local_benchmark/uploads/')&&method==='PUT'){
        const id=path.split('/').at(-1),ticket=tickets.get(id);if(!ticket||ticket.expires<Date.now()||ticket.workspaceId!==wid)throw new DataError('UPLOAD_EXPIRED',401);const bytes=await readBody(req,50*1024*1024);const asset=await repository.uploadAsset(wid,{filename:ticket.name,mimeType:ticket.mime,bytes});ticket.assetId=asset.id;json(res,200,{ok:true});return true;
      }
      if(path.startsWith('/__local_benchmark/media/')&&['GET','HEAD'].includes(method)){
        const id=path.split('/').at(-1),assetId=tickets.get(id)?.assetId??id;const asset=await publicAsset(wid,assetId);res.writeHead(302,{location:asset.url,'cache-control':'no-store'}).end();return true;
      }
      if(path==='/__local_benchmark/install'&&method==='GET'){res.writeHead(302,{location:'/workspace/connect','cache-control':'no-store'}).end();return true}
      return false;
    }
  };
}
