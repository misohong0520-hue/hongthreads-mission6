import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const root=join(import.meta.dirname,'workflow-capture');
await mkdir(join(root,'objects'),{recursive:true});
const local='http://127.0.0.1:9248';
const status=await(await fetch(local+'/__live/status')).json();
if(!status.configured)throw new Error('A connected original session is required');
const filename=join(root,'manifest.json');
let manifest={schema:'rea-original-workflow-resources-v1',origin:'https://drt.agczero.com',records:[]};
try{manifest=JSON.parse(await readFile(filename,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
const originals=manifest.origin;
const seen=new Set(manifest.records.filter(item=>item.status===200).map(item=>item.path));
const assets=new Set();
let captured=0;
async function capture(path){
  if(seen.has(path))return;
  seen.add(path);
  const url=new URL('/__workflow/resource',local);url.searchParams.set('path',path);
  const response=await fetch(url,{headers:{'x-rea-setup-token':status.setupToken},redirect:'manual',signal:AbortSignal.timeout(25000)});
  const bytes=Buffer.from(await response.arrayBuffer());
  const digest=createHash('sha256').update(bytes).digest('hex');
  const record={path,method:'GET',status:response.status,media_type:response.headers.get('content-type'),bytes:bytes.length,
    object_sha256:digest,file:'objects/'+digest,location:response.headers.get('location'),captured_at:new Date().toISOString()};
  await writeFile(join(root,record.file),bytes);
  manifest.records=manifest.records.filter(item=>item.path!==path);manifest.records.push(record);
  if(response.ok){
    captured++;
    if(/text\/html/.test(record.media_type??'')){
      for(const match of bytes.toString('utf8').matchAll(/\b(?:src|href)=["']([^"']+)["']/g)){
        const target=new URL(match[1].replaceAll('&amp;','&'),originals);
        if(target.origin===originals&&target.pathname.startsWith('/_next/static/')&&/\.(?:js|css|woff2?|ttf|otf|eot)$/.test(target.pathname))assets.add(target.pathname+target.search);
      }
    }
  }
  console.log(JSON.stringify({path,status:response.status,bytes:bytes.length}));
}
const documents=process.argv.slice(2);
for(const path of documents.length?documents:['/write?mode=realtime&keyword=테스트소재','/smart-multi-write?mode=realtime&keyword=테스트소재','/multi-write?mode=realtime&keyword=테스트소재'])await capture(path);
const list=[...assets];
for(let index=0;index<list.length;index+=6)await Promise.all(list.slice(index,index+6).map(capture));
await writeFile(filename,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({captured_this_run:captured,total_records:manifest.records.length,document_count:manifest.records.filter(item=>/text\/html/.test(item.media_type??'')).length}));
