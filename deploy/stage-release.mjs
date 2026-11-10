import {readFile,writeFile,mkdir,cp,copyFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {sanitizeDocument} from '../mission6/render.mjs';
const root=resolve(import.meta.dirname,'..'),destination=resolve(process.argv[2]??join(import.meta.dirname,'staged/source'));
if(!destination.startsWith(resolve(import.meta.dirname,'staged')+sep))throw new Error('Stage must remain inside deploy/staged');
const sha=b=>createHash('sha256').update(b).digest('hex'),copied=new Set();
const copy=async relative=>{if(copied.has(relative))return;copied.add(relative);const source=resolve(root,relative),target=resolve(destination,relative);if(!source.startsWith(root+sep)||!target.startsWith(destination+sep))throw new Error('Unsafe runtime path');await mkdir(dirname(target),{recursive:true});await copyFile(source,target)};
const save=async(relative,bytes)=>{const target=resolve(destination,relative);if(!target.startsWith(destination+sep))throw new Error('Unsafe output');await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)};
const walk=async(relative,filter)=>{for(const item of await readdir(join(root,relative),{withFileTypes:true})){const file=relative+'/'+item.name;if(item.isDirectory()){if(!['node_modules','.next','verification','runtime-data','.git','.temp','staged'].includes(item.name))await walk(file,filter)}else if(filter(file))await copy(file)}};
await mkdir(destination,{recursive:true});
await walk('mission6',f=>/\.(?:mjs|js)$/.test(f));
await walk('web',f=>/\.(?:tsx?|css|mjs|json|png)$/.test(f)||f.endsWith('.env.example'));
await walk('deploy',f=>/\.(?:mjs|sh|conf|service|example|md)$/.test(f));
await walk('supabase/migrations',f=>f.endsWith('.sql'));
await walk('extension-cloud',f=>/\.(?:js|json|html|png|md)$/.test(f));
await copy('extension-cloud.zip');
await walk('.github',f=>/\.ya?ml$/.test(f));
await save('README.md',(await readFile(join(root,'mission6/README.md'),'utf8')).replaceAll('](../MISSION6-','](MISSION6-'));
for(const file of ['MISSION6-FINAL-PLAN.ko.html','MISSION6-IMPLEMENTATION-REPORT.ko.html','development/patch-server-markup.mjs','development/branding/h-logo.png'])await copy(file);
for(const item of await readdir(join(root,'replay'),{withFileTypes:true}))if(item.isFile()&&/\.(?:mjs|js)$/.test(item.name))await copy('replay/'+item.name);
const original=JSON.parse(await readFile(join(root,'replay/manifest.json')));
const records=original.records.filter(r=>r.replayable&&r.method==='GET'&&!r.pathname?.startsWith('/api/')&&!/json|html|x-component/.test(r.response.media_type??'')&&/javascript|css|image\/|font\/|woff|octet-stream/.test(r.response.media_type??''));
for(const record of records)await copy('replay/objects/'+record.response.object_sha256);
await save('replay/manifest.json',JSON.stringify({schema:original.schema,primary_origin:original.primary_origin,summary:{staticOnly:true,records:records.length},records:records.map(r=>({replayable:true,method:r.method,original_url:r.original_url,pathname:r.pathname,search:r.search,response:{object_sha256:r.response.object_sha256,media_type:r.response.media_type}}))},null,2)+'\n');
const guest={user:{id:'public-shell',name:'체험 사용자',email:null,image:null,soId:0,authId:'',role:'GUEST'},expires:'2030-01-01T00:00:00Z'};
const overlay=JSON.parse(await readFile(join(root,'replay/workflow-development/manifest.json')));
for(const record of overlay.records){
 if(/html/.test(record.media_type)){const bytes=sanitizeDocument(await readFile(join(root,'replay/workflow-development',record.file)),guest);const digest=sha(bytes);record.development_sha256=digest;record.file='objects/'+digest;record.changed=true;record.deployment_sanitized=true;await save('replay/workflow-development/'+record.file,bytes)}
 else await copy('replay/workflow-development/'+record.file);
}
await save('replay/workflow-development/manifest.json',JSON.stringify(overlay,null,2)+'\n');
for(const file of ['replay/workflow-capture/manifest.json','replay/workflow-capture/client-inventory.json'])await copy(file);
const inventory=JSON.parse(await readFile(join(root,'replay/workflow-capture/client-inventory.json')));for(const source of inventory.sources)await copy('replay/workflow-capture/objects/'+source.object_sha256);
// Additional exact policy witnesses outside the original inventory.
for(const hash of ['8399f00bd8cf3aedc90ef9bc94f0ac1dbd8e89d87de6757a94066782e7c3c7a8'])await copy('replay/workflow-capture/objects/'+hash);
const pointer=JSON.parse(await readFile(join(root,'replay/client-updates/active.json')));
for(const release of pointer.releases??[pointer]){
 const base='replay/client-updates/'+release.release,source=JSON.parse(await readFile(join(root,base,'manifest.json'))),development=JSON.parse(await readFile(join(root,base,'development.json')));
 for(const record of source.records){
  if(record.status!==200)continue;
  if(/html/.test(record.media_type)){const bytes=sanitizeDocument(await readFile(join(root,base,record.file)),guest);record.original_source_sha256=record.object_sha256;record.object_sha256=sha(bytes);record.file='objects/'+record.object_sha256;record.deployment_sanitized=true;await save(base+'/'+record.file,bytes)}
  else await copy(base+'/'+record.file);
 }
 const sourceBytes=Buffer.from(JSON.stringify(source,null,2)+'\n');await save(base+'/manifest.json',sourceBytes);development.source_manifest_sha256=sha(sourceBytes);
 for(const record of development.records)await copy(base+'/'+record.file);
 const devBytes=Buffer.from(JSON.stringify(development,null,2)+'\n');await save(base+'/development.json',devBytes);release.source_manifest_sha256=sha(sourceBytes);release.development_manifest_sha256=sha(devBytes);
}
await save('replay/client-updates/active.json',JSON.stringify(pointer,null,2)+'\n');
const fonts=JSON.parse(await readFile(join(root,'replay/font-assets/manifest.json')));await copy('replay/font-assets/manifest.json');for(const font of fonts.records)await copy('replay/font-assets/'+font.file);
await save('package.json',JSON.stringify({name:'hongthreads-runtime',version:'1.0.0',type:'module',private:true,scripts:{start:'node mission6/server.mjs',test:'node --test mission6/server.test.mjs mission6/mirror.test.mjs mission6/runtime/vertex-worker.test.mjs'},dependencies:{parse5:'8.1.0'}},null,2)+'\n');
await save('.gitignore','node_modules/\nweb/node_modules/\nweb/.next/\n.env\n.env.*\n!.env.example\nmission6/runtime-data/\nmission6/verification/\n*.log\n');
await copy('.gitattributes');
await save('release.json',JSON.stringify({name:'HongThreads',domain:'hongthreads.hongsik.blog',createdAt:new Date().toISOString(),staticRecords:records.length,originalApiBodiesIncluded:false,originalSessionsIncluded:false,documentsSanitized:true,files:copied.size},null,2)+'\n');
console.log(JSON.stringify({destination,files:copied.size,staticRecords:records.length,personalApiResponsesIncluded:false,documentsSanitized:true}));
