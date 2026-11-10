import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'parse5';
import {patchDevelopmentMarkup,patchDevelopmentScript} from '../development/patch-server-markup.mjs';
import {loadClientUpdates} from '../replay/workflow-client-updates.mjs';
import {loadWorkflowFonts} from '../replay/workflow-fonts.mjs';
import {loadWorkflowStyles} from '../replay/workflow-styles.mjs';
import {applyBookmarkMetadata} from './bookmark.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=resolve(import.meta.dirname,'..');
const ORIGIN='https://drt.agczero.com';
export const ORIGINAL_PAGES=new Set(['/write','/multi-write','/smart-multi-write','/mypage','/onboarding/coupang','/onboarding/toss',...['insights','benchmark','threads','personas','threads-manage','videos','revenue'].map(p=>'/dashboard/'+p)]);

// Flight chunks contain a server-rendered SessionProvider value. Replace the
// whole value rather than masking individual names while leaking other fields.
export function replaceFlightSession(text,profile){
  let cursor=0,output='';const pattern=/"session"\s*:/g;let match;
  while((match=pattern.exec(text))){
    let start=pattern.lastIndex;while(/\s/.test(text[start]??'')&&start<text.length)start++;
    let end=start;
    if(text.startsWith('null',start))end=start+4;
    else if(text[start]==='{'){
      let depth=0,string=false,escaped=false;
      for(let i=start;i<text.length;i++){
        const c=text[i];if(string){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')string=false;continue}
        if(c==='"')string=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break}
      }
    }
    if(end===start)continue;
    try{JSON.parse(text.slice(start,end))}catch{continue}
    output+=text.slice(cursor,start)+JSON.stringify(profile);cursor=end;pattern.lastIndex=end;
  }
  return output+text.slice(cursor);
}
export function sanitizeDocument(bytes,profile){
  const source=bytes.toString(),tree=parse(source,{sourceCodeLocationInfo:true}),edits=[];
  const walk=n=>{
    if(n.tagName==='script'){
      const text=(n.childNodes??[]).map(c=>c.value??'').join('');
      if(text.startsWith('self.__next_f.push(')&&text.endsWith(')')){
        try{const payload=JSON.parse(text.slice(19,-1));if(typeof payload[1]==='string'){payload[1]=replaceFlightSession(payload[1],profile);const content='self.__next_f.push('+JSON.stringify(payload).replace(/</g,'\\u003c')+')';const loc=n.sourceCodeLocation;if(loc?.startTag&&loc.endTag)edits.push({start:loc.startTag.endOffset,end:loc.endTag.startOffset,content})}}catch{}
      }
    }
    for(const c of n.childNodes??[])walk(c);
  };walk(tree);let result=source;
  for(const edit of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.content+result.slice(edit.end);
  return patchDevelopmentMarkup(Buffer.from(result)).bytes;
}
export async function loadRuntimeAssets(){
  const manifest=JSON.parse(await readFile(join(root,'replay/manifest.json'))),assets=new Map(),documents=new Map();
  for(const record of manifest.records.filter(r=>r.replayable&&r.method==='GET'&&!r.pathname?.startsWith('/api/')&&!/json|html|x-component/.test(r.response.media_type??'')&&/javascript|css|image\/|font\/|woff|octet-stream/.test(r.response.media_type??''))){
    const bytes=await readFile(join(root,'replay/objects',record.response.object_sha256));if(sha(bytes)!==record.response.object_sha256)throw new Error('Runtime asset digest mismatch');
    const u=new URL(record.original_url);const key=u.origin===ORIGIN?u.pathname+u.search:'/__origin/'+Buffer.from(u.origin).toString('base64url')+u.pathname+u.search;
    assets.set(key,{bytes,type:record.response.media_type});
  }
  const overlay=JSON.parse(await readFile(join(root,'replay/workflow-development/manifest.json')));
  const approved=new Set();
  for(const record of overlay.records.filter(r=>!/html/.test(r.media_type))){const bytes=await readFile(join(root,'replay/workflow-development',record.file));if(sha(bytes)!==record.development_sha256)throw new Error('Development asset digest mismatch');assets.set(record.path,{bytes,type:record.media_type});approved.add(record.path)}
  for(const {record,bytes}of await loadClientUpdates()){assets.set(record.path,{bytes,type:record.media_type});approved.add(record.path)}
  for(const {record,bytes}of await loadWorkflowFonts())assets.set(record.path,{bytes,type:record.media_type});
  for(const {record,bytes}of await loadWorkflowStyles())assets.set(record.path,{bytes,type:record.media_type});
  for(const key of assets.keys())if(key.startsWith('/_next/static/chunks/app/')&&!approved.has(key))assets.delete(key);
  for(const record of overlay.records.filter(r=>/html/.test(r.media_type))){const bytes=await readFile(join(root,'replay/workflow-development',record.file));if(sha(bytes)!==record.development_sha256)throw new Error('Document digest mismatch');documents.set(new URL(record.path,ORIGIN).pathname,{bytes,type:record.media_type})}
  for(const release of ['2026-11-06','2026-11-10','2026-11-07-onboarding']){
    const dir=join(root,'replay/client-updates',release),m=JSON.parse(await readFile(join(dir,'manifest.json')));
    for(const record of m.records.filter(r=>/html/.test(r.media_type)&&ORIGINAL_PAGES.has(new URL(r.path,ORIGIN).pathname))){const bytes=await readFile(join(dir,record.file));if(sha(bytes)!==record.object_sha256)throw new Error('Updated document digest mismatch');documents.set(new URL(record.path,ORIGIN).pathname,{bytes,type:record.media_type})}
  }
  const client=await readFile(join(root,'replay/relocate.js'));
  const code=await readFile(join(root,'replay/benchmark-client.js'));
  assets.set('/__replay/relocate.js',{bytes:client,type:'application/javascript'});
  assets.set('/__workflow/benchmark-client.js',{bytes:code,type:'application/javascript'});
  assets.set('/__replay/brand.png',{bytes:await readFile(join(root,'development/branding/h-logo.png')),type:'image/png'});
  assets.set('/__replay/ui-visibility.css',{bytes:await readFile(join(root,'replay/ui-visibility.css')),type:'text/css; charset=utf-8'});
  for(const asset of assets.values())if(/javascript|ecmascript/.test(asset.type))asset.bytes=patchDevelopmentScript(asset.bytes);
  return{manifest,assets,documents};
}
export function rewriteDocument(bytes,{ctx,profile,vertex,publicOrigin}){
  const config={primaryOrigin:ORIGIN,originalWorkflows:true,liveTrends:true,developmentDraftView:true,developmentArchiveImport:true,benchmarkLive:true,benchmarkLocal:true,threadsAuthFixture:false,workflowToken:ctx.csrfToken,vertex,mission6:{connected:ctx.bridge.status().configured}};
  let text=sanitizeDocument(bytes,profile).toString();
  text=text.replace(/\b(src|href|action|poster)=(['"])(https:\/\/drt\.agczero\.com[^'"]*)\2/g,(_,name,quote,value)=>name+'='+quote+value.slice(ORIGIN.length)+quote);
  const injection='<link rel="stylesheet" href="/__replay/ui-visibility.css"><script>window.__REA_REPLAY__='+JSON.stringify(config).replace(/</g,'\\u003c')+';</script><script src="/__replay/relocate.js"></script><script src="/__workflow/benchmark-client.js"></script><script src="/mission6/client.js" defer></script>';
  return applyBookmarkMetadata(Buffer.from(text.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+injection)),publicOrigin);
}
