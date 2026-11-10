import {randomBytes,createHash,createHmac} from 'node:crypto';
import {LiveTrendsBridge} from '../replay/live-trends-bridge.mjs';
import {DataError} from './data/index.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const COOKIE='hongthreads_session';
export function createSessionManager({repository,secret,publicOrigin,bridgeFactory=()=>new LiveTrendsBridge(),now=Date.now}){
  if(typeof secret!=='string'||secret.length<32)throw new DataError('SESSION_SECRET_REQUIRED',503);
  const connections=new Map(),lifetime=30*86400000,secure=new URL(publicOrigin).protocol==='https:';
  const csrf=hash=>createHmac('sha256',secret).update('csrf:'+hash).digest('hex');
  const setCookie=(res,token)=>res.setHeader('set-cookie',COOKIE+'='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+lifetime/1000+(secure?'; Secure':''));
  const issue=async(res,workspace)=>{
    const token=randomBytes(32).toString('base64url'),hash=digest(token);
    const row=await repository.putSession({token_hash:hash,workspace_id:workspace.id,expires_at:new Date(now()+lifetime).toISOString()});setCookie(res,token);
    return{row,workspace,hash,csrfToken:csrf(hash),bridge:connections.get(hash)?.bridge??bridgeFactory(),originalSession:connections.get(hash)?.profile??null};
  };
  const context=async(req,res)=>{
    const cookies=String(req.headers.cookie??'').split(';').map(v=>v.trim());const value=cookies.find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const hash=value&&/^[A-Za-z0-9_-]{43}$/.test(value)?digest(value):null;
    const row=hash?await repository.getSession(hash):null;
    if(!row){
      // A request started before login/logout may finish after the rotated
      // cookie response. It must not overwrite that new cookie with a guest.
      if(value&&!(req.method==='GET'&&/text\/html/i.test(req.headers.accept??'')))throw new DataError('SESSION_EXPIRED',401);
      return issue(res,await repository.ensureWorkspace({kind:'guest'}));
    }
    const workspace=await repository.ensureWorkspace({id:row.workspace_id});
    const connected=connections.get(hash);if(connected&&Date.parse(row.expires_at)<now()){connected.bridge.clear();connections.delete(hash)}
    return{row,workspace,hash,csrfToken:csrf(hash),bridge:connected?.bridge??bridgeFactory(),originalSession:connected?.profile??null};
  };
  return{
    context,
    async workspaceContext(id){const workspace=await repository.ensureWorkspace({id});return{workspace,row:{expires_at:new Date(now()+lifetime).toISOString()},hash:null,csrfToken:null,bridge:bridgeFactory(),originalSession:null}},
    async connect(current,res,payload){
      const bridge=bridgeFactory();const result=await bridge.configure(payload);
      if(result.status!==200){bridge.clear();throw new DataError(result.body?.error??'ORIGINAL_CONNECTION_FAILED',result.status)}
      const response=await bridge.readOriginalResource({path:'/api/auth/session'});let profile;try{profile=JSON.parse(response.body)}catch{}
      const user=profile?.user,identity=user?.id??user?.soId;
      if(response.status!==200||!identity){bridge.clear();throw new DataError('ORIGINAL_IDENTITY_REQUIRED',401)}
      const workspace=await repository.ensureWorkspace({kind:'user',upstreamUserId:'drt:'+identity});
      const next=await issue(res,workspace);connections.set(next.hash,{bridge,profile});next.bridge=bridge;next.originalSession=profile;
      connections.get(current.hash)?.bridge.clear();connections.delete(current.hash);await repository.deleteSession(current.hash);
      return next;
    },
    async disconnect(current,res){connections.get(current.hash)?.bridge.clear();connections.delete(current.hash);await repository.deleteSession(current.hash);return issue(res,await repository.ensureWorkspace({kind:'guest'}))},
    view(ctx){return{csrfToken:ctx.csrfToken,connected:ctx.bridge.status().configured,workspace:{id:ctx.workspace.id,kind:ctx.workspace.kind},storage:{backend:repository.backend,ready:true}}},
    guestProfile(ctx){return{user:{id:'guest-'+ctx.workspace.id,name:'체험 사용자',email:null,image:null,soId:0,authId:'',role:'GUEST'},expires:ctx.row.expires_at}},
    close(){for(const c of connections.values())c.bridge.clear();connections.clear()}
  };
}
