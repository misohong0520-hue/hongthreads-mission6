import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
const root=import.meta.dirname,sourceRoot=join(root,'extension-inspection/original'),outputRoot=resolve(root,'../extension-local');
const base='http://127.0.0.1:9248';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence=JSON.parse(await readFile(join(root,'extension-inspection/artifact-evidence.json'),'utf8'));
const extract=evidence.extraction.structuredContent??JSON.parse(evidence.extraction.content.find(block=>block.type==='text').text);
const originals=extract.normalized_result.artifacts;let old;
try{old=JSON.parse(await readFile(join(root,'extension-local-manifest.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
await mkdir(outputRoot,{recursive:true});
const files=[];
const retain=async(name,bytes,source)=>{
  const path=join(outputRoot,name);let current;
  try{current=await readFile(path)}catch(error){if(error.code!=='ENOENT')throw error}
  if(current&&sha(current)!==sha(bytes)&&sha(current)!==old?.files.find(file=>file.path===name)?.development_sha256)throw new Error('Local extension has user changes: '+name);
  await writeFile(path,bytes);files.push({path:name,source_sha256:source??null,development_sha256:sha(bytes),changed:source?source!==sha(bytes):true});
};
const replace=(text,from,to,label)=>{if(!text.includes(from))throw new Error('Source witness changed: '+label);return text.replace(from,to)};
let publicKey=old?.public_key;
if(!publicKey){const pair=generateKeyPairSync('rsa',{modulusLength:2048});publicKey=pair.publicKey.export({type:'spki',format:'der'}).toString('base64')}
const extensionId=createHash('sha256').update(Buffer.from(publicKey,'base64')).digest().subarray(0,16).toString('hex').split('').map(char=>String.fromCharCode(97+parseInt(char,16))).join('');
for(const file of originals.filter(file=>!file.relative_path.startsWith('_metadata/'))){
  const original=await readFile(join(sourceRoot,file.relative_path));if(sha(original)!==file.sha256)throw new Error('Original extension digest mismatch');
  let bytes=original;
  if(file.relative_path==='manifest.json'){
    const manifest=JSON.parse(original);manifest.name='DReaThs Scraper Local';manifest.version='1.136.0.1';
    manifest.description='개인 PC의 로컬 벤치마킹 보관함에 연결하는 개발용 확장 프로그램';
    delete manifest.update_url;manifest.key=publicKey;
    manifest.host_permissions=manifest.host_permissions.filter(value=>!/^http:\/\//.test(value)&&!value.includes('drt.agczero.com'));
    manifest.host_permissions.push('http://127.0.0.1:9248/*','http://localhost:9248/*');
    manifest.content_scripts[0].js.push('local-post-bridge.js');
    manifest.content_scripts.push({matches:['http://127.0.0.1:9248/*','http://localhost:9248/*'],js:['local-app-bridge.js'],run_at:'document_end'});
    bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  }else if(/\.js$/.test(file.relative_path)){
    let text=original.toString('utf8');
    text=text.replaceAll('https://drt.agczero.com',base).replaceAll('http://14.5.136.233:15979',base)
      .replaceAll('http://localhost:15979',base).replaceAll('http://localhost:3000',base);
    text=text.replaceAll('chrome.storage.sync','chrome.storage.local');
    if(file.relative_path==='background.js'){
      text=replace(text,'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {',
        'chrome.runtime.onMessage.addListener((message, sender, originalSendResponse) => {\n    const sendResponse = result => { if (self.__DREATHS_LOCAL_RESULT) self.__DREATHS_LOCAL_RESULT(message, sender, result); originalSendResponse(result); };\n    if (message.action === "OPEN_TAB" && self.__DREATHS_LOCAL_HAS_JOB?.(sender.tab?.id)) { sendResponse({success:true}); return false; }','background response hook');
      const sync=text.indexOf('// Sync changes listener:');if(sync<0)throw new Error('Source storage listener changed');text=text.slice(0,sync)+'\nimportScripts("local-jobs.js");\n';
    }
    if(file.relative_path==='popup.js')text=text.replaceAll('☁️','').replaceAll('Google Account cloud sync','local device storage');
    bytes=Buffer.from(text);
  }else if(file.relative_path==='popup.html'){
    bytes=Buffer.from(original.toString('utf8').replace('DReaThs Scraper</h3>','DReaThs Scraper Local</h3>').replace('☁️ 구글 계정 동기화','이 PC에 저장'));
  }
  await retain(file.relative_path,bytes,file.sha256);
}
for(const[name,input]of [['local-jobs.js','extension-local-jobs.js'],['local-app-bridge.js','extension-local-app-bridge.js'],['local-post-bridge.js','extension-local-post-bridge.js']])
  await retain(name,await readFile(join(root,input)),null);
const report={schema:'rea-local-extension-overlay-v1',source_zip_sha256:'a23f9615141c43ea702c0780eecf4b397389320fbeb27b66c0bcfd8d1856b837',
  source_evidence_id:extract.evidence_id,public_key:publicKey,extension_id:extensionId,base_url:base,output_root:outputRoot,files,
  original_scraping_algorithm_preserved:true,original_interceptor_unchanged:files.find(file=>file.path==='interceptor.js').changed===false,
  original_service_credentials_used:false,cloud_storage_sync:false};
await writeFile(join(root,'extension-local-manifest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({files:files.length,extension_id:extensionId,output_root:outputRoot,original_interceptor_unchanged:report.original_interceptor_unchanged}));
