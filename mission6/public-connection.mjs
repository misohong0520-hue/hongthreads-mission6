import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {DataError} from './data/model.mjs';
const schema='hongthreads-public-original-v1';
const keyBytes=value=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new DataError('ORIGINAL_CONNECTION_KEY_INVALID',503);
  const bytes=Buffer.from(value,'base64url');if(bytes.length!==32)throw new DataError('ORIGINAL_CONNECTION_KEY_INVALID',503);return bytes;
};
const payload=input=>{
  const cookieName=input?.cookieName??'next-auth.session-token',cookieValue=input?.cookieValue;
  if(!['next-auth.session-token','__Secure-next-auth.session-token'].includes(cookieName)||typeof cookieValue!=='string'||!cookieValue||Buffer.byteLength(cookieValue)>32768||/[\x00-\x1f\x7f]/.test(cookieValue))throw new DataError('ORIGINAL_CONNECTION_INVALID',400);
  return{cookieName,cookieValue};
};
export function sealPublicConnection(input,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv);
  cipher.setAAD(Buffer.from(schema));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload(input)),'utf8'),cipher.final()]);
  return{schema,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),encrypted:encrypted.toString('base64url')};
}
export function openPublicConnection(document,key){
  try{
    if(document?.schema!==schema||!['iv','tag','encrypted'].every(k=>typeof document[k]==='string'&&/^[A-Za-z0-9_-]+$/.test(document[k])))throw Error();
    const iv=Buffer.from(document.iv,'base64url'),tag=Buffer.from(document.tag,'base64url'),encrypted=Buffer.from(document.encrypted,'base64url');
    if(iv.length!==12||tag.length!==16||encrypted.length>65536)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',keyBytes(key),iv);decipher.setAAD(Buffer.from(schema));decipher.setAuthTag(tag);
    return payload(JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8')));
  }catch{throw new DataError('ORIGINAL_CONNECTION_DECRYPT_FAILED',503)}
}

// This provider alone owns the default bridge. Browser logout/reconnect must
// never clear it or modify the encrypted server-side file.
export async function createPublicConnection({config,repository,bridgeFactory}={}){
  if(!config?.enabled)return null;
  if(!isAbsolute(config.file??''))throw new DataError('ORIGINAL_CONNECTION_FILE_REQUIRED',503);
  let input;
  try{
    const info=await lstat(config.file);
    if(!info.isFile()||info.size>100000||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw Error();
    input=openPublicConnection(JSON.parse(await readFile(config.file,'utf8')),config.key);
  }catch{throw new DataError('ORIGINAL_CONNECTION_UNAVAILABLE',503)}
  const bridge=bridgeFactory();
  try{
    const result=await bridge.configure(input);input=null;
    if(result.status!==200)throw Error();
    const response=await bridge.readOriginalResource({path:'/api/auth/session'});
    const profile=JSON.parse(response.body),identity=profile?.user?.id??profile?.user?.soId;
    if(response.status!==200||!identity)throw Error();
    const workspace=await repository.ensureWorkspace({kind:'user',upstreamUserId:'drt:'+identity});
    return{workspace,bridge,profile,context:ctx=>({...ctx,workspace,bridge,originalSession:bridge.status().configured?profile:null,publicOriginal:true}),close:()=>bridge.clear()};
  }catch{input=null;bridge.clear();throw new DataError('ORIGINAL_CONNECTION_UNAVAILABLE',503)}
}
