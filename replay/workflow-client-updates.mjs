import {readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>new Error('Client update verification failed.');
// Lazy chunks witnessed in the retained client's public runtime. These exact
// source bytes are additions only; they must never carry development patches.
const supplementalAssets=new Map([
  ['/_next/static/chunks/2897.1b32fc00e21c9a61.js','b422fb80d58e05d28162c2bdf1eecd2386667f4eb7e69f2956361b60d6fb2cd7']
]);
/** Load only explicitly captured and source-bound editor updates; never fetch or patch unknown code on demand. */
export async function loadClientUpdates(root=join(import.meta.dirname,'client-updates')){
  let pointerBytes;
  try{pointerBytes=await readFile(join(root,'active.json'))}catch(error){if(error.code==='ENOENT')return[];throw error}
  const pointer=JSON.parse(pointerBytes);
  if(pointer.schema!=='rea-client-update-pointer-v1')throw invalid();
  const releases=pointer.releases??[pointer];
  if(!Array.isArray(releases)||!releases.length||releases.length>8)throw invalid();
  const records=[],paths=new Set(),names=new Set();
  for(const release of releases){
    if(names.has(release.release))throw invalid();names.add(release.release);
    for(const asset of await loadRelease(root,release)){
      if(paths.has(asset.record.path))throw invalid();paths.add(asset.record.path);records.push(asset);
    }
  }
  return records;
}
async function loadRelease(root,pointer){
  if(pointer.schema!=='rea-client-update-pointer-v1'||!/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/.test(pointer.release??'')||!digest(pointer.source_manifest_sha256)||!digest(pointer.development_manifest_sha256))throw invalid();
  const directory=join(root,pointer.release),sourceBytes=await readFile(join(directory,'manifest.json')),overlayBytes=await readFile(join(directory,'development.json'));
  if(sha(sourceBytes)!==pointer.source_manifest_sha256||sha(overlayBytes)!==pointer.development_manifest_sha256)throw invalid();
  const source=JSON.parse(sourceBytes),overlay=JSON.parse(overlayBytes);
  if(overlay.schema!=='rea-client-update-overlay-v1'||overlay.source_manifest_sha256!==sha(sourceBytes)||!Array.isArray(overlay.records)||!Array.isArray(source.records))throw invalid();
  const read=async(file,expected)=>{
    if(typeof file!=='string'||!digest(expected))throw invalid();
    const path=resolve(directory,file);if(!path.startsWith(resolve(directory)+sep))throw invalid();
    const bytes=await readFile(path);if(sha(bytes)!==expected)throw invalid();return bytes;
  };
  const paths=new Set(),records=[];
  for(const record of overlay.records){
    const supplemental=supplementalAssets.get(record.path);
    const supplementalAllowed=supplemental&&pointer.release==='2026-11-11-assets'&&
      source.schema==='rea-supplemental-client-assets-v1'&&source.origin==='https://drt.agczero.com'&&
      record.source_sha256===supplemental&&record.development_sha256===supplemental;
    if((!/^\/_next\/static\/chunks\/(?:app\/(?:write|multi-write|smart-multi-write|mypage|dashboard\/(?:personas|threads-manage)|onboarding\/(?:coupang|toss))\/page|app\/onboarding\/layout|3838|5281|9465|webpack)-[a-f0-9]+\.js$/.test(record.path??'')&&!supplementalAllowed)||paths.has(record.path)||!/(?:java|ecma)script/.test(record.media_type??''))throw invalid();
    paths.add(record.path);
    const original=source.records.find(item=>item.path===record.path&&item.status===200&&item.object_sha256===record.source_sha256);
    if(!original)throw invalid();
    await read(original.file,record.source_sha256);
    const bytes=await read(record.file,record.development_sha256);
    records.push({bytes,record:{...record,changed:record.source_sha256!==record.development_sha256},release:pointer.release});
  }
  return records;
}
