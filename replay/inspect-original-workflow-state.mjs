import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const base='http://127.0.0.1:9248';
const control=await(await fetch(base+'/__live/status')).json();
const paths=['/api/auth/session','/api/subscription/status','/api/keys/accounts','/api/keys/status',
  ...['THREADS','COUPANG','TOSS','WDRB'].map(provider=>'/api/keys/status?provider='+provider)];
const safe=value=>{
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return '[string omitted]';
  if(Array.isArray(value))return {count:value.length,first_item_fields:value[0]&&typeof value[0]==='object'?Object.keys(value[0]):[]};
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,safe(item)]));
  return null;
};
const results=[];
for(const path of paths){
  const url=new URL('/__workflow/resource',base);url.searchParams.set('path',path);
  const response=await fetch(url,{headers:{'x-rea-setup-token':control.setupToken},signal:AbortSignal.timeout(25000)});
  let data;try{data=await response.json()}catch{data={non_json_response:true}}
  results.push({path,status:response.status,summary:safe(data)});
}
const report={checked_at:new Date().toISOString(),scope:'Read-only original authentication/subscription/key-presence metadata; all string values omitted',results};
await writeFile(join(import.meta.dirname,'workflow-state-inspection.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
