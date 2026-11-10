import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const ORIGIN='https://drt.agczero.com';
const root=join(import.meta.dirname,'workflow-capture');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventoryBytes=await readFile(join(root,'client-inventory.json'));
const inventory=JSON.parse(inventoryBytes);
const manifestBytes=await readFile(join(root,'manifest.json'));
if(inventory.schema!=='rea-workflow-client-inventory-v1'||inventory.origin!==ORIGIN||
   inventory.source_manifest_sha256!==digest(manifestBytes)||inventory.verification_failures?.length)
  throw new Error('Workflow inventory does not match its captured source manifest.');

const methods=new Set(['GET','POST','PATCH','DELETE','PUT']);
const keyReads=new Set(['/api/keys/status','/api/keys/accounts','/api/keys/active-decrypted']);
const threadsAuthReturnTargets=new Set(['/mypage','/dashboard/threads-manage']);
const rules=new Map();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const excluded=(path,method)=>
  (path.startsWith('/api/auth/')&&!(path==='/api/auth/session'&&method==='GET')&&
    !(path==='/api/auth/threads'&&method==='GET')&&!(path==='/api/auth/threads/disconnect'&&method==='DELETE'))||
  ((path==='/api/keys'||path.startsWith('/api/keys/'))&&!(keyReads.has(path)&&method==='GET')&&
    !(path==='/api/keys/accounts'&&['PATCH','PUT'].includes(method))&&
    !(path==='/api/keys/provider'&&['POST','DELETE'].includes(method))&&
    !(path==='/api/keys/wdrb'&&method==='GET')&&!(path==='/api/keys/extension'&&method==='POST'))||
  (/^\/api\/(?:billing[^/]*|payments?|purchase|checkout|subscribe)(?:\/|$)/i.test(path)&&
    !(path==='/api/billingMonth/userBilling'&&method==='POST')&&!(path==='/api/billingMonth/cancel'&&method==='POST'))||
  (path.startsWith('/api/subscription/')&&!(path==='/api/subscription/status'&&method==='GET'));

for(const source of inventory.sources??[]){
  const calls=(source.fetch_calls??[]).filter(call=>call.target_kind==='endpoint'&&typeof call.target==='string'&&methods.has(call.method));
  if(!calls.length)continue;
  if(!/^[a-f0-9]{64}$/.test(source.object_sha256))throw new Error('Invalid workflow source digest.');
  const bytes=await readFile(join(root,'objects',source.object_sha256));
  if(bytes.length!==source.bytes||digest(bytes)!==source.object_sha256)
    throw new Error('Workflow captured source digest mismatch.');
  for(const call of calls){
    const path=call.target.split('?',1)[0];
    if(!path.startsWith('/api/')||excluded(path,call.method)||/[\\\x00-\x20\x7F#%]/.test(path))continue;
    const segments=path.split('/');
    if(segments.some(segment=>segment==='.'||segment==='..'||
        (/[{}]/.test(segment)&&!(call.dynamic&&segment==='{expression}'))))continue;
    const pattern='^'+segments.map(segment=>segment==='{expression}'?'[^/]+':escape(segment)).join('/')+'$';
    const key=call.method+' '+path;
    const rule=rules.get(key)??{method:call.method,path,pattern:new RegExp(pattern),sources:new Set()};
    rule.sources.add(source.object_sha256);rules.set(key,rule);
  }
}

// The add-account navigation is a browser redirect rather than a fetch call,
// so the client inventory cannot discover it. Keep the route explicit and
// restrict its return target to the two captured Threads account screens.
rules.set('GET /api/auth/threads',{method:'GET',path:'/api/auth/threads',pattern:/^\/api\/auth\/threads$/,sources:new Set()});
// Reviewed indirect GET: the original client assigns this URL to a local then fetches it.
// Keep the exact source witness because a literal-only fetch-call index cannot resolve it.
{
  const source='8399f00bd8cf3aedc90ef9bc94f0ac1dbd8e89d87de6757a94066782e7c3c7a8';
  const bytes=await readFile(join(root,'objects',source));
  const witness='let r="/api/proxy-media?url=".concat(encodeURIComponent(t)),n=await fetch(r)';
  if(digest(bytes)!==source||!bytes.toString('utf8').includes(witness))throw new Error('Indirect media GET source witness mismatch.');
  const path='/api/proxy-media';
  rules.set('GET '+path,{method:'GET',path,pattern:/^\/api\/proxy-media$/,sources:new Set([source])});
}
// These forms were missing from the baseline inventory. Admit only the exact
// POST contracts witnessed in the newly retained, unmodified original pages.
const affiliateForms=new Map([
  ['/api/keys/coupang',{sha256:'0bf52ed3e5a5dbfbada2ea9f2fc02789425e0b02281d001adc4cbd72106d429c',fields:['accessKey','secretKey'],witness:'fetch("/api/keys/coupang",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessKey:e,secretKey:r})})'}],
  ['/api/keys/toss',{sha256:'e516e0fd09ace94d0adcc81c02b1dfb6945f8a013bdf8388e27f4e8e7ec761e4',fields:['accessKey','secretKey','publisherId'],witness:'fetch("/api/keys/toss",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessKey:e,secretKey:r,publisherId:l})})'}]
]);
for(const [path,form]of affiliateForms){
  const bytes=await readFile(join(import.meta.dirname,'client-updates/2026-11-07-onboarding/objects',form.sha256));
  if(digest(bytes)!==form.sha256||!bytes.toString('utf8').includes(form.witness))throw new Error('Affiliate registration source witness mismatch.');
  rules.set('POST '+path,{method:'POST',path,pattern:new RegExp('^'+escape(path)+'$'),sources:new Set([form.sha256])});
}
export const AFFILIATE_KEY_MAX_BYTES=64*1024;
export const affiliateKeyPath=path=>affiliateForms.has(path);
export const affiliateKeyBodyAllowed=(path,bytes)=>{
  const form=affiliateForms.get(path);if(!form)return true;
  if(!Buffer.isBuffer(bytes)||bytes.length>AFFILIATE_KEY_MAX_BYTES)return false;
  let value;try{value=JSON.parse(bytes.toString('utf8'))}catch{return false}
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===form.fields.length&&form.fields.every(field=>
      Object.hasOwn(value,field)&&typeof value[field]==='string'&&value[field].length>0&&value[field].length<=32768);
};
const compiled=[...rules.values()];
export const workflowPolicySource=Object.freeze({
  inventory_sha256:digest(inventoryBytes),source_manifest_sha256:inventory.source_manifest_sha256,
  origin:ORIGIN,rules:Object.freeze(compiled.map(rule=>Object.freeze({method:rule.method,path:rule.path,source_count:rule.sources.size})))
});

/** Strict root-relative path validation before the URL parser can erase escapes. */
const normalize=(path,method)=>{
  if(typeof path!=='string'||typeof method!=='string'||!path.startsWith('/')||path.startsWith('//')||
     Buffer.byteLength(path,'utf8')>65536||/[\\\x00-\x20\x7F#]/.test(path))return null;
  const rawPath=path.split('?',1)[0];
  if(/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)||/%(?:2e|2f|5c|25)/i.test(rawPath))return null;
  let target;
  try{decodeURIComponent(rawPath);target=new URL(path,ORIGIN);}catch{return null;}
  const normalizedMethod=method.toUpperCase();
  if(!methods.has(normalizedMethod)||target.origin!==ORIGIN||target.username||target.password||target.pathname!==rawPath)return null;
  if(!compiled.some(rule=>rule.method===normalizedMethod&&rule.pattern.test(target.pathname)))return null;
  if(target.pathname==='/api/keys/extension'&&target.search)return null;
  if(affiliateForms.has(target.pathname)&&target.search)return null;
  if(target.pathname==='/api/keys/status'){
    const providers=target.searchParams.getAll('provider');
    if(providers.length>1||(providers.length&&!['AI','COUPANG','TOSS','THREADS','WDRB'].includes(providers[0])))return null;
  }
  if(target.pathname==='/api/auth/threads'){
    const entries=[...target.searchParams.entries()];
    if(normalizedMethod!=='GET'||entries.length!==1||entries[0][0]!=='returnTo'||!threadsAuthReturnTargets.has(entries[0][1]))return null;
  }
  if(target.pathname==='/api/auth/threads/disconnect'){
    const entries=[...target.searchParams.entries()];
    if(normalizedMethod!=='DELETE'||entries.length!==1||entries[0][0]!=='accountId'||
       !/^[A-Za-z0-9_-]{1,128}$/.test(entries[0][1]))return null;
  }
  if(target.pathname==='/api/keys/accounts'&&['PATCH','PUT'].includes(normalizedMethod)&&target.search)return null;
  if(target.pathname==='/api/keys/provider'){
    if(normalizedMethod==='POST'&&target.search)return null;
    if(normalizedMethod==='DELETE'){
      const entries=[...target.searchParams.entries()];
      if(entries.length!==2||!entries.some(([name])=>name==='keyId')||!entries.some(([name])=>name==='provider'))return null;
    }
  }
  if(target.pathname==='/api/keys/wdrb'&&target.search)return null;
  if(target.pathname==='/api/generate'&&target.search)return null;
  return {target,method:normalizedMethod};
};

export const resolveWorkflowRequest=(path,method='GET')=>normalize(path,method);
export const matchesWorkflowRequest=(path,method='GET')=>normalize(path,method)!==null;
