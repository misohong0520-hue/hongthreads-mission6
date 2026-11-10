import {randomUUID} from 'node:crypto';

export class DataError extends Error {
  constructor(code,status=400,fields={}){super(code);this.name='DataError';this.code=code;this.status=status;this.fields=fields}
}
export const RESOURCE_MAP=Object.freeze({benchmarks:'scraps',scraps:'scraps',folders:'scrap_folders',scrap_folders:'scrap_folders',
  drafts:'drafts',personas:'personas',templates:'comment_templates',comment_templates:'comment_templates',
  sessions:'editor_sessions',editor_sessions:'editor_sessions',revenue:'revenue_entries',revenue_entries:'revenue_entries',
  generations:'generation_jobs',generation_jobs:'generation_jobs',accounts:'accounts',assets:'assets',
  insights:'insight_snapshots',insight_snapshots:'insight_snapshots',affiliate_items:'affiliate_items',affiliate_links:'affiliate_links',
  publish_jobs:'publish_jobs',sync_events:'sync_events',cache:'api_cache',api_cache:'api_cache','extension-keys':'extension_keys'});
export const TABLES=Object.freeze([...new Set(Object.values(RESOURCE_MAP))]);
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const assertId=(id,field='id')=>{if(typeof id!=='string'||!UUID.test(id))throw new DataError('INVALID_ID',400,{[field]:'올바른 식별자가 필요합니다.'});return id};
export const tableFor=resource=>{const table=RESOURCE_MAP[resource];if(!table)throw new DataError('UNKNOWN_RESOURCE',404);return table};
export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const clone=value=>structuredClone(value);
const secretKey=/^(?:cookies?|cookieValue|cookieName|sessionCookie|session[_-]?token|access[_-]?(?:token|key)|refresh[_-]?token|secret(?:[_-]?(?:access)?key)?|clientSecret|geminiKey|api[_-]?(?:key|token)|authorization|password|private[_-]?key|service[_-]?role)$/i;
export function assertNoSecrets(value,depth=0){
  if(depth>24)throw new DataError('INVALID_DATA_DEPTH');
  if(Array.isArray(value)){for(const item of value)assertNoSecrets(item,depth+1);return}
  if(object(value))for(const [key,item]of Object.entries(value)){
    if(secretKey.test(key)||['__proto__','prototype','constructor'].includes(key))throw new DataError('SENSITIVE_FIELD_REJECTED',400,{[key]:'자격 정보는 업무 자료에 저장할 수 없습니다.'});
    assertNoSecrets(item,depth+1);
  }
}
export function listOptions(options={}){
  const page=Number(options.page??1),limit=Number(options.limit??15),search=String(options.search??'').trim();
  if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DataError('INVALID_PAGINATION');
  if(search.length>500)throw new DataError('INVALID_SEARCH');
  const sort=({updated_at:'updated_desc',created_at:'created_desc',title:'title_asc'})[options.sort]??options.sort??'updated_desc';if(!['updated_desc','created_desc','created_asc','title_asc'].includes(sort))throw new DataError('INVALID_SORT');
  let folderId=options.folderId;
  if(folderId==='ALL'||folderId==='')folderId=undefined;
  if(folderId==='NONE'||folderId==='null')folderId=null;
  if(folderId!==undefined&&folderId!==null)assertId(folderId,'folder_id');
  return {page,limit,search,sort,...(folderId!==undefined?{folderId}:{}),...(options.upstreamId!==undefined?{upstreamId:String(options.upstreamId)}:{})};
}
const fields=new Set(['id','title','name','folder_name','content','source_url','sourceUrl','folder_id','folderId','assets','metadata','upstream_id','upstreamId','status','version']);
export function recordData(table,input,{partial=false,now=new Date().toISOString()}={}){
  if(!object(input))throw new DataError('INVALID_DATA');assertNoSecrets(input);
  const unknown=Object.keys(input).filter(key=>!fields.has(key));if(unknown.length)throw new DataError('UNKNOWN_FIELDS',400,Object.fromEntries(unknown.map(key=>[key,'지원하지 않는 필드입니다.'])));
  const data={};
  if(input.id!==undefined)data.id=assertId(input.id);
  const title=input.title??input.name??input.folder_name;
  if(title!==undefined||!partial){
    data.title=typeof title==='string'?title.trim():'';
    const required=!['generation_jobs','publish_jobs','sync_events','insight_snapshots','api_cache','accounts','extension_keys'].includes(table);
    if((required&&!data.title)||data.title.length>200)throw new DataError('VALIDATION_ERROR',400,{title:'제목은 1~200자로 입력해 주세요.'});
  }
  if(input.content!==undefined||!partial){data.content=input.content??'';if(typeof data.content!=='string'||data.content.length>50000)throw new DataError('VALIDATION_ERROR',400,{content:'본문은 최대 50,000자입니다.'})}
  const source=input.source_url??input.sourceUrl;
  if(source!==undefined||!partial){
    data.source_url=source===null?'':String(source??'').trim();
    if(data.source_url){let url;try{url=new URL(data.source_url)}catch{};if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||data.source_url.length>8192)throw new DataError('VALIDATION_ERROR',400,{source_url:'올바른 http 또는 https 주소를 입력해 주세요.'})}
  }
  const folder=input.folder_id??input.folderId;
  if(folder!==undefined||input.folder_id===null||input.folderId===null||!partial)data.folder_id=folder==null||folder===''?null:assertId(folder,'folder_id');
  if(input.assets!==undefined||!partial){
    if(!Array.isArray(input.assets??[])||(input.assets??[]).length>9)throw new DataError('VALIDATION_ERROR',400,{assets:'첨부는 최대 9개입니다.'});
    data.assets=[...new Set((input.assets??[]).map(asset=>assertId(typeof asset==='string'?asset:asset?.id,'assets')))].map(id=>({id}));
  }
  if(input.metadata!==undefined||!partial){data.metadata=input.metadata??{};if(!object(data.metadata)||Buffer.byteLength(JSON.stringify(data.metadata))>1024*1024)throw new DataError('INVALID_METADATA')}
  const upstream=input.upstream_id??input.upstreamId;
  if(upstream!==undefined||!partial){data.upstream_id=upstream==null?null:String(upstream);if(data.upstream_id!==null&&data.upstream_id.length>512)throw new DataError('INVALID_UPSTREAM_ID')}
  if(input.status!==undefined||!partial){data.status=input.status??'active';if(typeof data.status!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(data.status))throw new DataError('INVALID_STATUS')}
  data.updated_at=now;return data;
}
export const newRecord=(workspaceId,data,now)=>({...data,id:data.id??randomUUID(),workspace_id:workspaceId,version:1,created_at:now,updated_at:now});
export const MIME_EXT=Object.freeze({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'});
export const MAX_ASSET_BYTES=50*1024*1024;
export function assetInput({filename,mimeType,mime_type,size,bytes,entity='uploads',metadata={}}={}){
  const mime=mimeType??mime_type;
  if(!MIME_EXT[mime])throw new DataError('INVALID_MEDIA_TYPE',415,{file:'지원하지 않는 이미지 또는 영상 형식입니다.'});
  if(typeof filename!=='string'||!filename.trim()||filename.length>255||/[\x00-\x1f]/.test(filename))throw new DataError('INVALID_FILENAME');
  const length=bytes!==undefined?Buffer.byteLength(bytes):Number(size);
  if(!Number.isSafeInteger(length)||length<1||length>MAX_ASSET_BYTES)throw new DataError('ASSET_SIZE_LIMIT',413);
  if(typeof entity!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(entity))throw new DataError('INVALID_ASSET_ENTITY');
  if(!object(metadata))throw new DataError('INVALID_METADATA');assertNoSecrets(metadata);
  if(bytes!==undefined)validateMedia(Buffer.from(bytes),mime);
  return {filename:filename.trim(),mime,size:length,entity,metadata};
}
export function validateMedia(bytes,mime){
  let valid=false;
  if(mime==='image/png')valid=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')valid=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==='image/gif')valid=['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString());
  if(mime==='image/webp')valid=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(['video/mp4','video/quicktime'].includes(mime))valid=bytes.subarray(4,8).toString()==='ftyp';
  if(mime==='video/webm')valid=bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  if(!valid)throw new DataError('MEDIA_SIGNATURE_MISMATCH',415);
}
