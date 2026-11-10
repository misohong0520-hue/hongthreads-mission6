import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join,resolve,dirname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TABLES,clone,DataError} from './model.mjs';
const locks=new Map();
const empty=()=>({schema:'drt-mission6-file-v1',workspaces:{},sessions:{},tables:Object.fromEntries(TABLES.map(table=>[table,{}]))});
export async function createFileDriver(directory){
  if(!directory)throw new DataError('LOCAL_DATA_DIRECTORY_REQUIRED',503);
  const root=resolve(directory),filename=join(root,'mission6-data.json');await mkdir(root,{recursive:true});
  const load=async()=>{try{const data=JSON.parse(await readFile(filename));if(data.schema!=='drt-mission6-file-v1')throw new DataError('INVALID_LOCAL_DATA',500);return data}catch(error){if(error.code==='ENOENT')return empty();throw error}};
  const save=async data=>{const temporary=filename+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(data),{flag:'wx',mode:0o600});await rename(temporary,filename)};
  const mutate=async fn=>{
    const prior=locks.get(root)??Promise.resolve();let unlock;const current=new Promise(resolve=>{unlock=resolve});locks.set(root,current);
    await prior;try{const data=await load(),result=await fn(data);await save(data);return clone(result)}finally{unlock();if(locks.get(root)===current)locks.delete(root)}
  };
  const scoped=(data,table,workspace,id)=>{const row=data.tables[table]?.[id];return row?.workspace_id===workspace?row:null};
  const storagePath=path=>{if(typeof path!=='string'||path.includes('..')||path.includes('\\'))throw new DataError('INVALID_ASSET_PATH');const value=resolve(root,'assets',path);if(!value.startsWith(resolve(root,'assets')+sep))throw new DataError('INVALID_ASSET_PATH');return value};
  return{
    backend:'local',
    getWorkspace:async id=>clone((await load()).workspaces[id]??null),
    findWorkspace:async upstream=>clone(Object.values((await load()).workspaces).find(row=>row.upstream_user_id===upstream)??null),
    putWorkspace:row=>mutate(data=>{const existing=row.upstream_user_id?Object.values(data.workspaces).find(r=>r.upstream_user_id===row.upstream_user_id):data.workspaces[row.id];if(existing)return existing;data.workspaces[row.id]=row;return row}),
    list:async(table,workspace,options)=>{
      let data=Object.values((await load()).tables[table]).filter(row=>row.workspace_id===workspace);
      if(options.search){const needle=options.search.toLocaleLowerCase();data=data.filter(row=>(row.title+' '+row.content).toLocaleLowerCase().includes(needle))}
      if(options.folderId!==undefined)data=data.filter(row=>row.folder_id===options.folderId);
      if(options.upstreamId!==undefined)data=data.filter(row=>row.upstream_id===options.upstreamId);
      const sort=options.sort;
      data.sort((a,b)=>sort==='title_asc'?a.title.localeCompare(b.title)||a.id.localeCompare(b.id):sort==='created_asc'?a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id):sort==='created_desc'?b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id):b.updated_at.localeCompare(a.updated_at)||b.id.localeCompare(a.id));
      return clone({data:data.slice((options.page-1)*options.limit,options.page*options.limit),total:data.length,page:options.page,limit:options.limit});
    },
    get:async(table,workspace,id)=>clone(scoped(await load(),table,workspace,id)),
    insert:(table,row)=>mutate(data=>{if(data.tables[table][row.id])throw new DataError('DUPLICATE_RECORD',409);if(row.upstream_id&&Object.values(data.tables[table]).some(r=>r.workspace_id===row.workspace_id&&r.upstream_id===row.upstream_id))throw new DataError('DUPLICATE_UPSTREAM_RECORD',409);data.tables[table][row.id]=row;return row}),
    patch:(table,workspace,id,patch,version)=>mutate(data=>{const row=scoped(data,table,workspace,id);if(!row||row.version!==version)return null;const next={...row,...patch,id,workspace_id:workspace,version:row.version+1};data.tables[table][id]=next;return next}),
    remove:(table,workspace,id)=>mutate(data=>{const row=scoped(data,table,workspace,id);if(!row)return null;delete data.tables[table][id];if(table==='scrap_folders')for(const rows of Object.values(data.tables))for(const item of Object.values(rows))if(item.workspace_id===workspace&&item.folder_id===id)item.folder_id=null;return row}),
    putSession:row=>mutate(data=>{data.sessions[row.token_hash]={...data.sessions[row.token_hash],...row};return data.sessions[row.token_hash]}),
    getSession:async hash=>clone((await load()).sessions[hash]??null),
    deleteSession:hash=>mutate(data=>{const existed=Boolean(data.sessions[hash]);delete data.sessions[hash];return existed}),
    assetReferences:async(workspace,id)=>{const data=await load();return TABLES.filter(table=>table!=='assets').flatMap(table=>Object.values(data.tables[table])).filter(row=>row.workspace_id===workspace&&row.assets?.some(asset=>asset.id===id)).length},
    storage:{
      upload:async(path,bytes)=>{const file=storagePath(path);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes,{flag:'wx',mode:0o600})},
      download:async path=>{try{return await readFile(storagePath(path))}catch(error){if(error.code==='ENOENT')throw new DataError('ASSET_FILE_NOT_FOUND',404);throw error}},
      remove:async path=>{try{await unlink(storagePath(path))}catch(error){if(error.code!=='ENOENT')throw error}},
      sign:async()=>{throw new DataError('LOCAL_ASSET_PROXY_REQUIRED',503)},
      signUpload:async()=>{throw new DataError('LOCAL_SIGNED_UPLOAD_UNAVAILABLE',503)}
    }
  };
}
