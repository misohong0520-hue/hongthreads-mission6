import {createHash} from 'node:crypto';
import {DataError} from './data/index.mjs';
const sensitive=/^(?:cookie|cookieName|cookieValue|authorization|apiKey|geminiKey|accessKey|secretKey|accessToken|refreshToken|sessionToken|password|privateKey|service_role|token)$/i;
export function clean(value,depth=0){
  if(depth>20)return'[depth limit]';
  if(Array.isArray(value))return value.slice(0,1000).map(v=>clean(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!sensitive.test(k)&&!['__proto__','prototype','constructor'].includes(k)).map(([k,v])=>[k,k==='inlineData'?{mimeType:v?.mimeType,bytesOmitted:true}:clean(v,depth+1)]));
  if(typeof value==='string'&&value.length>50000)return value.slice(0,50000);
  return value;
}
const mapping=path=>path.startsWith('/api/personas')?'personas':path.startsWith('/api/templates')?'templates':path.startsWith('/api/batch-sessions')?'sessions':path.startsWith('/api/threads-manage')||path.startsWith('/api/trends')?'insights':path.startsWith('/api/threads')||path==='/api/generate/save-draft'?'drafts':path.startsWith('/api/keys/accounts')?'accounts':/coupang|toss|shopping|wdrb/.test(path)?'affiliate_items':/revenue|settlement/.test(path)?'revenue':/publish|schedule/.test(path)?'publish_jobs':'cache';
export function createMirror(repository){
  const queues=new Map();
  const upsert=async(resource,wid,upstream,data)=>{const existing=(await repository.list(resource,wid,{upstreamId:upstream,limit:1})).data[0];return existing?repository.update(resource,wid,existing.id,data,{version:existing.version}):repository.create(resource,wid,{...data,upstream_id:upstream})};
  return{
    async record(wid,{path,method='GET',status,data,requestData}){
      if(status<200||status>=300||!data||path==='/api/auth/session'||/active-decrypted|csrf|extension|provider$|keys\/(?:coupang|toss|wdrb)$/.test(path))return;
      const previous=queues.get(wid)??Promise.resolve();
      const pending=previous.catch(()=>{}).then(async()=>{
        const resource=mapping(path),safe=clean(data),parsed=new URL(path,'https://drt.agczero.com');
        const list=Array.isArray(safe)?safe:Array.isArray(safe.data)?safe.data:Array.isArray(safe.personas)?safe.personas:Array.isArray(safe.sessions)?safe.sessions:Array.isArray(safe.accounts)?safe.accounts:[safe];
        for(let index=0;index<Math.min(list.length,100);index++){
          const item=list[index];if(!item||typeof item!=='object')continue;
          const id=item.id??item.persona_id??item.session_id??null;
          const upstream=id!==null?parsed.pathname+':'+String(id):parsed.pathname+':'+createHash('sha256').update(parsed.search||'default').digest('hex').slice(0,24)+':'+index;
          const title=String(item.title??item.name??item.persona_name??item.account_name??parsed.pathname).slice(0,200);
          const content=String(item.raw_content??item.mainContent??item.content??item.description??'').slice(0,50000);
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
