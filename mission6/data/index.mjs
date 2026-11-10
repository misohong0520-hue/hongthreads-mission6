import {randomUUID,createHash} from 'node:crypto';
import {createFileDriver} from './file-driver.mjs';
import {createSupabaseDriver} from './supabase-driver.mjs';
import {DataError,RESOURCE_MAP,TABLES,assertId,object,recordData,listOptions,newRecord,assetInput,assertNoSecrets} from './model.mjs';
export {DataError,RESOURCE_MAP,TABLES} from './model.mjs';

export async function createRepository({backend='supabase',url=process.env.SUPABASE_URL,secretKey=process.env.SUPABASE_SECRET_KEY,directory,fetchImpl,now=()=>new Date().toISOString()}={}){
  if(!['supabase','local'].includes(backend))throw new DataError('INVALID_DATA_BACKEND',503);
  const driver=backend==='local'?await createFileDriver(directory):await createSupabaseDriver({url,secretKey,fetchImpl});
  const workspace=async id=>{assertId(id,'workspace_id');if(!await driver.getWorkspace(id))throw new DataError('WORKSPACE_NOT_FOUND',404)};
  const get=async(resource,wid,id)=>{assertId(wid,'workspace_id');assertId(id);const table=RESOURCE_MAP[resource];if(!table)throw new DataError('UNKNOWN_RESOURCE',404);const row=await driver.get(table,wid,id);if(!row)throw new DataError('NOT_FOUND',404);return row};
  const refs=async(table,wid,data,id)=>{
    if(data.folder_id){if(table==='scrap_folders'&&data.folder_id===id)throw new DataError('INVALID_FOLDER',400);await get('folders',wid,data.folder_id)}
    for(const asset of data.assets??[]){const row=await get('assets',wid,asset.id);if(row.status!=='ready')throw new DataError('ASSET_NOT_READY',409)}
  };
  const api={
    backend,
    async ensureWorkspace({id=randomUUID(),kind='guest',upstreamUserId=null}={}){
      assertId(id);if(!['guest','user'].includes(kind))throw new DataError('INVALID_WORKSPACE_KIND');
      if(upstreamUserId!==null&&(typeof upstreamUserId!=='string'||!upstreamUserId||upstreamUserId.length>512))throw new DataError('INVALID_UPSTREAM_USER');
      if(upstreamUserId){const existing=await driver.findWorkspace(upstreamUserId);if(existing)return existing}
      const existing=await driver.getWorkspace(id);if(existing)return existing;
      return driver.putWorkspace({id,kind,upstream_user_id:upstreamUserId,created_at:now(),updated_at:now()});
    },
    async list(resource,wid,options={}){await workspace(wid);const table=RESOURCE_MAP[resource];if(!table)throw new DataError('UNKNOWN_RESOURCE',404);return driver.list(table,wid,listOptions(options))},
    get,
    async create(resource,wid,input){await workspace(wid);const table=RESOURCE_MAP[resource];if(!table)throw new DataError('UNKNOWN_RESOURCE',404);const data=recordData(table,input,{now:now()});await refs(table,wid,data,data.id);return driver.insert(table,newRecord(wid,data,now()))},
    async update(resource,wid,id,input,{version=input?.version}={}){
      const current=await get(resource,wid,id),table=RESOURCE_MAP[resource];
      if(version!==undefined&&(!Number.isInteger(Number(version))||Number(version)!==current.version))throw new DataError('VERSION_CONFLICT',409);
      const data=recordData(table,input,{partial:true,now:now()});delete data.id;
      await refs(table,wid,{...current,...data},id);
      const row=await driver.patch(table,wid,id,data,current.version);if(!row)throw new DataError('VERSION_CONFLICT',409);
      if(data.assets&&table!=='assets')for(const ref of current.assets.filter(a=>!row.assets.some(b=>b.id===a.id)))await api.cleanupAsset(wid,ref.id);
      return row;
    },
    async remove(resource,wid,id){
      const current=await get(resource,wid,id);const row=await driver.remove(RESOURCE_MAP[resource],wid,id);if(!row)throw new DataError('NOT_FOUND',404);
      if(RESOURCE_MAP[resource]!=='assets')for(const ref of current.assets){
        await api.cleanupAsset(wid,ref.id);
      }
      return current;
    },
    async putSession(input){
      if(!object(input)||!/^[a-f0-9]{64}$/.test(input.token_hash??''))throw new DataError('INVALID_SESSION_HASH');
      const allowed=new Set(['id','token_hash','workspace_id','expires_at','last_seen_at']);if(Object.keys(input).some(k=>!allowed.has(k)))throw new DataError('INVALID_SESSION_FIELDS');
      await workspace(input.workspace_id);if(!Number.isFinite(Date.parse(input.expires_at)))throw new DataError('INVALID_SESSION_EXPIRY');
      return driver.putSession({...input,id:input.id??randomUUID(),last_seen_at:input.last_seen_at??now()});
    },
    async getSession(hash){if(!/^[a-f0-9]{64}$/.test(hash??''))return null;const row=await driver.getSession(hash);return row&&Date.parse(row.expires_at)>Date.parse(now())?row:null},
    async deleteSession(hash){if(!/^[a-f0-9]{64}$/.test(hash??''))return false;return driver.deleteSession(hash)},
    async uploadAsset(wid,input,{id=randomUUID()}={}){
      await workspace(wid);assertId(id);const valid=assetInput(input),path=wid+'/'+valid.entity+'/'+id+'.'+({ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov' })[valid.mime];
      const bytes=Buffer.from(input.bytes);await driver.storage.upload(path,bytes,valid.mime);
      try{return await api.create('assets',wid,{id,title:valid.filename,content:'',status:'ready',metadata:{...valid.metadata,path,mime_type:valid.mime,size:valid.size,sha256:createHash('sha256').update(bytes).digest('hex')}})}catch(error){await driver.storage.remove(path).catch(()=>{});throw error}
    },
    async getAssetUrl(wid,id,{expiresIn=300}={}){const row=await get('assets',wid,id);if(row.status!=='ready')throw new DataError('ASSET_NOT_READY',409);if(backend==='local')return '/workspace/api/v1/assets/'+id+'/content';return driver.storage.sign(row.metadata.path,Math.min(3600,Math.max(30,expiresIn)))},
    async downloadAsset(wid,id){const row=await get('assets',wid,id);if(row.status!=='ready')throw new DataError('ASSET_NOT_READY',409);return{row,bytes:await driver.storage.download(row.metadata.path)}},
    async removeAsset(wid,id){const row=await get('assets',wid,id);if(await driver.assetReferences(wid,id))throw new DataError('ASSET_IN_USE',409);await driver.storage.remove(row.metadata.path);await api.remove('assets',wid,id);return row},
    async cleanupAsset(wid,id){
      try{if(await driver.assetReferences(wid,id)===0){const asset=await driver.get('assets',wid,id);if(asset){await driver.storage.remove(asset.metadata.path);await driver.remove('assets',wid,id)}}}
      catch{await api.create('sync_events',wid,{title:'첨부파일 정리 대기',status:'cleanup_pending',metadata:{asset_id:id}}).catch(()=>{})}
    },
    async createAssetUpload(wid,input){
      await workspace(wid);const valid=assetInput(input),id=randomUUID(),path=wid+'/'+valid.entity+'/'+id;
      const row=await api.create('assets',wid,{id,title:valid.filename,status:'pending',metadata:{...valid.metadata,path,mime_type:valid.mime,size:valid.size,expires_at:new Date(Date.parse(now())+10*60000).toISOString()}});
      try{return{asset:row,...await driver.storage.signUpload(path)}}catch(e){await api.remove('assets',wid,id);throw e}
    },
    async completeAssetUpload(wid,id){const row=await get('assets',wid,id);if(row.status==='ready')return row;if(Date.parse(row.metadata.expires_at)<Date.parse(now()))throw new DataError('UPLOAD_EXPIRED',410);const bytes=await driver.storage.download(row.metadata.path);assetInput({filename:row.title,mimeType:row.metadata.mime_type,bytes});if(bytes.length!==row.metadata.size)throw new DataError('UPLOAD_SIZE_MISMATCH');return api.update('assets',wid,id,{status:'ready',metadata:{...row.metadata,sha256:createHash('sha256').update(bytes).digest('hex')}},{version:row.version})},
    async rawAssetReferences(wid,id){assertId(wid);assertId(id);return driver.assetReferences(wid,id)}
  };
  return api;
}
