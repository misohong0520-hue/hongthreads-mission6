import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only probes of the exact previously observed trend GET endpoints.
// No cookies, credentials, account mutations, or subscription endpoints are used.
const root = import.meta.dirname;
const paths = ['/api/trends/datalab','/api/trends/google','/api/trends/realtime',
  ...['ISSUE','POPULAR','NEW'].map(type => '/api/trends/shopping/keywords?type='+type)];
const manifest = JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const results = await Promise.allSettled(paths.map(async path => {
  const response = await fetch(manifest.primary_origin+path, {redirect:'manual',signal:AbortSignal.timeout(15000)});
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  const result = {path,status:response.status,content_type:type,bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex')};
  if(response.ok && /application\/json/.test(type)) {
    const json = JSON.parse(bytes);
    result.keys = Object.keys(json);
    result.arrays = Object.fromEntries(Object.entries(json).filter(([,value])=>Array.isArray(value))
      .map(([name,value])=>[name,{count:value.length,first_item_keys:value[0]&&typeof value[0]==='object'?Object.keys(value[0]):null}]));
    result.cached_at = json.cached_at ?? null;
  }
  return result;
}));
const report = {checked_at:new Date().toISOString(),origin:manifest.primary_origin,
  request_scope:'Exact known read-only trend GET paths; empty authentication state',
  results:results.map((result,index)=>result.status==='fulfilled'?result.value:{path:paths[index],error:String(result.reason)})};
await writeFile(join(root,'live-trend-endpoint-inspection.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
