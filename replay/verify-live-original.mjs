import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const base='http://127.0.0.1:9248';
const paths=['/api/trends/datalab','/api/trends/google','/api/trends/realtime','/api/trends/shortents',
  ...['ISSUE','POPULAR','NEW'].flatMap(type=>['/api/trends/shopping/categories?type='+type,'/api/trends/shopping/keywords?type='+type])];
const results=[];
for(const path of paths){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(20000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const data=JSON.parse(bytes);
  const arrays=Object.fromEntries(Object.entries(data).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,value.length]));
  const first=Object.values(data).find(value=>Array.isArray(value)&&value[0]&&typeof value[0]==='object')?.[0];
  const timestamps={};
  for(const key of ['cached_at','crawled_at','pub_date','created_at','updated_at'])
    if(data[key]||first?.[key])timestamps[key]=data[key]??first[key];
  results.push({path,status:response.status,representation:response.headers.get('x-rea-body-representation'),
    local_cache:response.headers.get('x-rea-live-cache'),bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),array_counts:arrays,source_timestamps:timestamps,
    ...(data.datalab?{total_category_keywords:data.datalab.reduce((sum,category)=>sum+category.keywords.length,0)}:{}),
    ...(response.ok?{}:{error:data.error})});
}
const status=await(await fetch(base+'/__live/status')).json();
const report={checked_at:new Date().toISOString(),scope:'Authenticated original trend API responses through local memory-only session bridge; no cookie values retained in this report',
  origin:'https://drt.agczero.com',configured:status.configured,state:status.state,
  passed:results.filter(result=>result.status===200&&result.representation==='live-original-api').length,total:results.length,results};
await writeFile(join(import.meta.dirname,'live-original-api-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(report.passed!==report.total)process.exitCode=1;
