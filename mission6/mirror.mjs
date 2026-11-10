import {createHash} from 'node:crypto';
import {DataError} from './data/index.mjs';
const sensitive=/^(?:cookies?|cookieName|cookieValue|sessionCookie|authorization|api[_-]?(?:key|token)|geminiKey|access[_-]?(?:key|token)|secret(?:[_-]?(?:access)?key)?|clientSecret|refresh[_-]?token|session[_-]?token|password|private[_-]?key|service[_-]?role|token)$/i;
export function clean(value,depth=0){
  if(depth>20)return'[depth limit]';
  if(Array.isArray(value))return value.slice(0,1000).map(v=>clean(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!sensitive.test(k)&&!['__proto__','prototype','constructor'].includes(k)).map(([k,v])=>[k,k==='inlineData'?{mimeType:v?.mimeType,bytesOmitted:true}:clean(v,depth+1)]));
  if(typeof value==='string'&&value.length>50000)return value.slice(0,50000);
  return value;
}
const mapping=path=>path.startsWith('/api/personas')?'personas':path.startsWith('/api/templates')?'templates':path.startsWith('/api/batch-sessions')?'sessions':path.startsWith('/api/threads-manage')||path.startsWith('/api/trends')?'insights':path.startsWith('/api/threads')||path==='/api/generate/save-draft'?'drafts':path.startsWith('/api/keys/accounts')?'accounts':/coupang|toss|shopping|wdrb/.test(path)?'affiliate_items':/revenue|settlement/.test(path)?'revenue':/publish|schedule/.test(path)?'publish_jobs':'cache';
const collection=path=>path==='/api/generate/save-draft'?'/api/threads':path.replace(/\/(?:[0-9]+|[a-f0-9]{8}-[a-f0-9-]{27})$/i,'');
const entityId=(value,path)=>value?.id??value?.persona_id??value?.session_id??value?.thread_id??(/\/(?:[0-9]+|[a-f0-9]{8}-[a-f0-9-]{27})$/i.test(path)?path.split('/').at(-1):null);
export function createMirror(repository){
  const queues=new Map();
  const upsert=async(resource,wid,upstream,data)=>{
    const existing=(await repository.list(resource,wid,{upstreamId:upstream,limit:1})).data[0];
    if(existing&&data.metadata.method!=='GET'){
      const original={...existing.metadata.original,...data.metadata.original};data.metadata={...existing.metadata,...data.metadata,original};
      data.content=String(original.raw_content??original.mainContent??original.main_content??original.content??original.description??existing.content).slice(0,50000);
      data.title=String(original.title??original.name??original.persona_name??original.account_name??existing.title).slice(0,200);
    }
    return existing?repository.update(resource,wid,existing.id,data,{version:existing.version}):repository.create(resource,wid,{...data,upstream_id:upstream});
  };
  return{
    async record(wid,{path,method='GET',status,data,requestData}){
      if(status<200||status>=300||!data||data.success===false||data.error||path==='/api/auth/session'||/active-decrypted|csrf|extension|provider$|keys\/(?:coupang|toss|wdrb)$/.test(path))return;
      const previous=queues.get(wid)??Promise.resolve();
      const pending=previous.catch(()=>{}).then(async()=>{
        const resource=mapping(path),safe=clean(data),parsed=new URL(path,'https://drt.agczero.com'),base=collection(parsed.pathname),request=clean(requestData??{});
        if(method==='DELETE'&&['drafts','personas','templates','sessions'].includes(resource)){
          const ids=request.ids??parsed.searchParams.get('ids')?.split(',')??[entityId(request,parsed.pathname)??parsed.searchParams.get('id')];
          if(!Array.isArray(ids)||!ids.length||ids.some(id=>id===null||id===undefined))throw new DataError('SYNC_DELETE_ID_REQUIRED');
          for(const id of ids){const row=(await repository.list(resource,wid,{upstreamId:base+':'+id,limit:1})).data[0];if(row)await repository.remove(resource,wid,row.id)}return;
        }
        const single=safe.data&&typeof safe.data==='object'&&!Array.isArray(safe.data)?safe.data:safe;
        const acknowledged=method!=='GET'&&!Array.isArray(single)?{...request,...single}:single;
        const list=Array.isArray(safe)?safe:Array.isArray(safe.data)?safe.data:Array.isArray(safe.personas)?safe.personas:Array.isArray(safe.sessions)?safe.sessions:Array.isArray(safe.accounts)?safe.accounts:[acknowledged];
        for(let index=0;index<Math.min(list.length,100);index++){
          const item=list[index];if(!item||typeof item!=='object')continue;
          const id=entityId(item,parsed.pathname);
          if(method!=='GET'&&id===null&&['drafts','personas','templates','sessions'].includes(resource))throw new DataError('SYNC_ENTITY_ID_REQUIRED');
          const upstream=id!==null?base+':'+String(id):parsed.pathname+':'+createHash('sha256').update(parsed.search||'default').digest('hex').slice(0,24)+':'+index;
          const content=String(item.raw_content??item.mainContent??item.main_content??item.content??item.description??'').slice(0,50000);
          const title=String(item.title??item.name??item.persona_name??item.account_name??content.slice(0,70)??parsed.pathname).slice(0,200)||parsed.pathname;
          const metadata={original:item,source_path:parsed.pathname,checked_at:new Date().toISOString(),method,...(method!=='GET'?{request:clean(requestData)}:{})};
          if(Buffer.byteLength(JSON.stringify(metadata))>900000)metadata.original={largeResponse:true};
          await upsert(resource,wid,upstream,{title,content,metadata,status:'synced'});
        }
      });
      queues.set(wid,pending);try{await pending}finally{if(queues.get(wid)===pending)queues.delete(wid)}
    },
    async syncFailure(wid,path,status){await repository.create('sync_events',wid,{title:'원본 반영 후 저장소 동기화 대기',status:'pending',metadata:{path,status,at:new Date().toISOString()}})}
  };
}
