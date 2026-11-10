// Test preload only. Never imported by the production replay server.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=import.meta.dirname;
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const recorded=new Map();
for(const record of manifest.records.filter(record=>record.replayable&&record.pathname.startsWith('/api/trends/')))
  recorded.set(record.pathname+record.search,await readFile(join(root,'objects',record.response.object_sha256)));
let googleRequests=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input);
  if(url.origin!=='https://drt.agczero.com')return originalFetch(input,options);
  if(options.method!=='GET'||options.redirect!=='manual')throw new Error('Unsafe fixture upstream invocation');
  const cookie=new Headers(options.headers).get('cookie');
  if(cookie!=='next-auth.session-token=fixture-session-not-real')
    return new Response('{"error":"unauthorized"}',{status:401,headers:{'content-type':'application/json'}});
  const bytes=recorded.get(url.pathname+url.search);
  if(!bytes)return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
  let output=bytes;
  if(url.pathname==='/api/trends/google'){
    const value=JSON.parse(bytes);value.google[0].keyword='브리지 갱신 검증 '+(++googleRequests);
    output=JSON.stringify(value);
  }
  return new Response(output,{headers:{'content-type':'application/json','set-cookie':'unrelated=fixture; Secure; HttpOnly'}});
};
