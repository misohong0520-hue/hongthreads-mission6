import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=join(import.meta.dirname,'workflow-capture');
const filename=join(root,'manifest.json');
const manifest=JSON.parse(await readFile(filename,'utf8'));
for(const path of ['/coupang-icon.png','/toss-icon.png']){
  if(manifest.records.some(record=>record.path===path&&record.status===200))continue;
  const response=await fetch(new URL(path,manifest.origin),{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok||!/^image\//.test(response.headers.get('content-type')??''))throw new Error('Original public icon unavailable');
  const bytes=Buffer.from(await response.arrayBuffer());const digest=createHash('sha256').update(bytes).digest('hex');
  const record={path,method:'GET',status:response.status,media_type:response.headers.get('content-type'),bytes:bytes.length,
    object_sha256:digest,file:'objects/'+digest,location:null,captured_at:new Date().toISOString()};
  await writeFile(join(root,record.file),bytes);manifest.records.push(record);
  console.log(JSON.stringify({path,status:response.status,bytes:bytes.length,sha256:digest}));
}
await writeFile(filename,JSON.stringify(manifest,null,2)+'\n');
