import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {parse}=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json')('@babel/parser');
const sha=b=>createHash('sha256').update(b).digest('hex');
const release='2026-11-10',updates=join(import.meta.dirname,'client-updates'),root=join(updates,release);
const sourceBytes=await readFile(join(root,'manifest.json')),source=JSON.parse(sourceBytes);
if(source.schema!=='rea-current-client-source-capture-v1')throw new Error('Capture schema mismatch');
const expected=new Set(['/_next/static/chunks/app/write/page-b5b4dd68880135cc.js',
  '/_next/static/chunks/app/mypage/page-19a4345a28ba44fd.js',
  '/_next/static/chunks/webpack-3646dcd87e8ef153.js','/_next/static/chunks/5281-a0b9813b3e91c253.js']);
const records=[];await mkdir(join(root,'development/objects'),{recursive:true});
for(const entry of source.records.filter(r=>expected.has(r.path))){
  if(entry.status!==200||entry.file!=='objects/'+entry.object_sha256)throw new Error('Invalid captured object');
  const original=await readFile(join(root,entry.file));if(sha(original)!==entry.object_sha256)throw new Error('Source digest mismatch');
  const text=original.toString(),ast=parse(text),patches=[];
  if(entry.path.includes('/app/write/')){
    const calls=[];
    const walk=n=>{if(!n?.type)return;if(n.type==='CallExpression'&&n.callee.name==='eL'&&n.arguments.length===1&&n.arguments[0].type==='MemberExpression'&&n.arguments[0].property.name==='hasKey')calls.push(n);
      for(const [key,value] of Object.entries(n)){if(['loc','extra','comments'].includes(key))continue;if(Array.isArray(value))value.forEach(walk);else if(value?.type)walk(value)}};
    walk(ast);if(calls.length!==1)throw new Error('Current editor credential contract changed');
    const member=calls[0].arguments[0],object=text.slice(member.object.start,member.object.end);
    patches.push({id:'wif-smart-editor-credential-status',start_utf16:member.start,end_utf16:member.end,
      original_sha256:sha(text.slice(member.start,member.end)),replacement:'('+text.slice(member.start,member.end)+'||('+object+'.provider==="VERTEX_WIF"&&'+object+'.credentialReady))'});
  }
  let output=text;for(const p of [...patches].reverse())output=output.slice(0,p.start_utf16)+p.replacement+output.slice(p.end_utf16);
  parse(output);const bytes=Buffer.from(output),digest=sha(bytes),file=patches.length?'development/objects/'+digest:entry.file;
  if(patches.length)await writeFile(join(root,file),bytes);
  records.push({path:entry.path,media_type:entry.media_type,source_sha256:entry.object_sha256,development_sha256:digest,file,patches});
}
if(records.length!==4||records.flatMap(r=>r.patches).length!==1)throw new Error('Incomplete current page update');
const overlay=Buffer.from(JSON.stringify({schema:'rea-client-update-overlay-v1',source_manifest_sha256:sha(sourceBytes),records},null,2)+'\n');
await writeFile(join(root,'development.json'),overlay);
const active=JSON.parse(await readFile(join(updates,'active.json')));
const releases=(active.releases??[active]).filter(r=>r.release!==release);
releases.push({schema:'rea-client-update-pointer-v1',release,source_manifest_sha256:sha(sourceBytes),development_manifest_sha256:sha(overlay)});
await writeFile(join(updates,'active.json'),JSON.stringify({schema:'rea-client-update-pointer-v1',releases},null,2)+'\n');
console.log(JSON.stringify({release,assets:records.length,wifPatches:1,originalSourcesPreserved:true}));
