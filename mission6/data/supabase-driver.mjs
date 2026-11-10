import {DataError,object} from './model.mjs';

export async function createSupabaseDriver({url,secretKey,fetchImpl=fetch,bucket='drt-assets'}){
  let origin;try{const value=new URL(url);if(value.protocol!=='https:'||value.username||value.password||value.pathname!=='/')throw new Error();origin=value.origin}catch{throw new DataError('SUPABASE_URL_REQUIRED',503)}
  if(typeof secretKey!=='string'||secretKey.length<20)throw new DataError('SUPABASE_SECRET_KEY_REQUIRED',503);
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket))throw new DataError('INVALID_STORAGE_BUCKET',503);
  const credentials={apikey:secretKey,...(secretKey.startsWith('eyJ')?{authorization:'Bearer '+secretKey}:{})};
  const request=async(path,{method='GET',body,rawBody,headers={},binary=false}={})=>{
    let response;try{response=await fetchImpl(origin+path,{method,headers:{...credentials,...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:rawBody??(body===undefined?undefined:JSON.stringify(body)),signal:AbortSignal.timeout(45000),redirect:'error'})}catch{throw new DataError('SUPABASE_UNAVAILABLE',503)}
    if(!response.ok){
      let data;try{data=await response.json()}catch{}
      if(data?.code==='23505')throw new DataError('DUPLICATE_RECORD',409);
      if(data?.code==='23503'||data?.code==='23514'||data?.code==='22023')throw new DataError('INVALID_REFERENCE',400);
      if(response.status===404||data?.code==='PGRST116')throw new DataError('NOT_FOUND',404);
      if(response.status===413)throw new DataError('ASSET_SIZE_LIMIT',413);
      if(response.status===401||response.status===403||data?.code==='42501')throw new DataError('SUPABASE_PERMISSION',503);
      if(data?.code==='42P01'||data?.code==='42883'||data?.code==='PGRST202'||data?.code==='PGRST205')throw new DataError('SUPABASE_MIGRATION_REQUIRED',503);
      throw new DataError('SUPABASE_REQUEST_FAILED',502);
    }
    if(binary){const declared=Number(response.headers.get('content-length')??0);if(declared>50*1024*1024)throw new DataError('ASSET_SIZE_LIMIT',413);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>50*1024*1024)throw new DataError('ASSET_SIZE_LIMIT',413);return{data:bytes,response}}
    if(response.status===204)return{data:null,response};
    let data;try{data=await response.json()}catch{throw new DataError('SUPABASE_RESPONSE_INVALID',502)}
    return{data,response};
  };
  const rest=(table,params={})=>'/rest/v1/'+table+'?'+new URLSearchParams(params);
  const first=data=>Array.isArray(data)?data[0]??null:null;
  const scoped=(workspace,id)=>({workspace_id:'eq.'+workspace,id:'eq.'+id});
  const pathOf=path=>path.split('/').map(encodeURIComponent).join('/');
  const api={
    backend:'supabase',
    getWorkspace:async id=>first((await request(rest('workspaces',{id:'eq.'+id,select:'*',limit:1}))).data),
    findWorkspace:async upstream=>first((await request(rest('workspaces',{upstream_user_id:'eq.'+upstream,select:'*',limit:1}))).data),
    putWorkspace:async row=>{
      try{return first((await request(rest('workspaces'),{method:'POST',body:row,headers:{Prefer:'return=representation'}})).data)}
      catch(error){if(error.code!=='DUPLICATE_RECORD')throw error;const existing=row.upstream_user_id?await api.findWorkspace(row.upstream_user_id):await api.getWorkspace(row.id);if(!existing)throw error;return existing}
    },
    list:async(table,workspace,options)=>{
      const {data}=await request('/rest/v1/rpc/drt_list_records',{method:'POST',body:{p_table:table,p_workspace:workspace,p_page:options.page,p_limit:options.limit,p_search:options.search,p_sort:options.sort,p_folder:options.folderId??null,p_filter_folder:options.folderId!==undefined,p_upstream:options.upstreamId??null}});
      if(!object(data)||!Array.isArray(data.data)||!Number.isSafeInteger(data.total))throw new DataError('SUPABASE_RESPONSE_INVALID',502);
      return{data:data.data,total:data.total,page:options.page,limit:options.limit};
    },
    get:async(table,workspace,id)=>first((await request(rest(table,{...scoped(workspace,id),select:'*',limit:1}))).data),
    insert:async(table,row)=>first((await request(rest(table),{method:'POST',body:row,headers:{Prefer:'return=representation'}})).data),
    patch:async(table,workspace,id,patch,version)=>first((await request(rest(table,{...scoped(workspace,id),version:'eq.'+version}),{method:'PATCH',body:patch,headers:{Prefer:'return=representation'}})).data),
    remove:async(table,workspace,id)=>first((await request(rest(table,scoped(workspace,id)),{method:'DELETE',headers:{Prefer:'return=representation'}})).data),
    putSession:async row=>first((await request(rest('app_sessions',{on_conflict:'token_hash'}),{method:'POST',body:row,headers:{Prefer:'resolution=merge-duplicates,return=representation'}})).data),
    getSession:async hash=>first((await request(rest('app_sessions',{token_hash:'eq.'+hash,select:'*',limit:1}))).data),
    deleteSession:async hash=>{const {data}=await request(rest('app_sessions',{token_hash:'eq.'+hash}),{method:'DELETE',headers:{Prefer:'return=representation'}});return Array.isArray(data)&&data.length>0},
    assetReferences:async(workspace,id)=>{const{data}=await request('/rest/v1/rpc/drt_asset_references',{method:'POST',body:{p_workspace:workspace,p_asset:id}});if(!Number.isSafeInteger(data))throw new DataError('SUPABASE_RESPONSE_INVALID',502);return data},
    storage:{
      upload:async(path,bytes,mime)=>{await request('/storage/v1/object/'+bucket+'/'+pathOf(path),{method:'POST',rawBody:bytes,headers:{'content-type':mime,'x-upsert':'false'}})},
      download:async path=>(await request('/storage/v1/object/authenticated/'+bucket+'/'+pathOf(path),{binary:true})).data,
      remove:async path=>{await request('/storage/v1/object/'+bucket,{method:'DELETE',body:{prefixes:[path]}})},
      sign:async(path,expiresIn)=>{const{data}=await request('/storage/v1/object/sign/'+bucket+'/'+pathOf(path),{method:'POST',body:{expiresIn}});const signed=data.signedURL??data.signedUrl;if(typeof signed!=='string')throw new DataError('SUPABASE_RESPONSE_INVALID',502);return signed.startsWith('http')?signed:origin+'/storage/v1'+(signed.startsWith('/')?'':'/')+signed},
      signUpload:async path=>{const{data}=await request('/storage/v1/object/upload/sign/'+bucket+'/'+pathOf(path),{method:'POST',body:{},headers:{'x-upsert':'false'}});const signed=data.url??data.signedURL??data.signedUrl;if(typeof signed!=='string')throw new DataError('SUPABASE_RESPONSE_INVALID',502);return{uploadUrl:signed.startsWith('http')?signed:origin+'/storage/v1'+(signed.startsWith('/')?'':'/')+signed,token:data.token??new URL(signed,origin).searchParams.get('token')}}
    }
  };
  return api;
}
