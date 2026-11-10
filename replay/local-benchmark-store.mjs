import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const failure=(code,status=400)=>Object.assign(new Error(code),{code,status});
const clone=value=>structuredClone(value);
export const localIdentityCodec=operation=>bytes=>new Promise((resolve,reject)=>{
  if(process.platform!=='win32'){reject(failure('WINDOWS_DPAPI_REQUIRED',500));return}
  const command='Add-Type -AssemblyName System.Security; $taskBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); '+
    '$taskResult=[Security.Cryptography.ProtectedData]::'+operation+'($taskBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($taskResult))';
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
  let output='',settled=false;
  const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result)};
  const timer=setTimeout(()=>{child.kill();done(failure('LOCAL_KEY_PROTECTION_FAILED',500))},20000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();done(failure('LOCAL_KEY_PROTECTION_FAILED',500))}});
  child.once('error',()=>done(failure('LOCAL_KEY_PROTECTION_FAILED',500)));child.stdin.once('error',()=>done(failure('LOCAL_KEY_PROTECTION_FAILED',500)));
  child.once('close',code=>{
    if(code!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(output.trim()))return done(failure('LOCAL_KEY_PROTECTION_FAILED',500));
    done(null,Buffer.from(output.trim(),'base64'));
  });child.stdin.end(Buffer.from(bytes).toString('base64'));
});
const atomic=async(file,bytes)=>{const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,file)};
const folderId=value=>value===null||value===undefined||['','NONE','null'].includes(value)?null:Number(value);
const day=timestamp=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp));
const structure=value=>{
  if(value===undefined||value===null||value==='')return{};
  try{const parsed=typeof value==='string'?JSON.parse(value):value;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw failure('INVALID_CONTENT_STRUCTURE');return clone(parsed);
  }catch{throw failure('INVALID_CONTENT_STRUCTURE')}
};
const affiliateUrl=value=>{
  if(value===null||value===undefined||value==='')return'';
  if(typeof value!=='string'||value.length>8192)throw failure('INVALID_AFFILIATE_URL');
  let parsed;try{parsed=new URL(value)}catch{throw failure('INVALID_AFFILIATE_URL')}
  if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw failure('INVALID_AFFILIATE_URL');
  return value.trim();
};
const metadata=value=>{
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>64000)throw failure('INVALID_AFFILIATE_META');
  return clone(value);
};
const purpose=row=>row.is_stabilization||row.affiliate_type==='STABILIZATION'||row.scrap_purpose==='STABILIZATION'
  ?'STABILIZATION':row.affiliate_url?'LINKED':'UNLINKED';

export async function createLocalBenchmarkStore({directory,protect=localIdentityCodec('Protect'),unprotect=localIdentityCodec('Unprotect'),now=Date.now}){
  await mkdir(directory,{recursive:true});
  const identityFile=join(directory,'identity.dpapi'),dataFile=join(directory,'benchmark.json');
  let identity,data,queue=Promise.resolve();
  try{identity=JSON.parse((await unprotect(await readFile(identityFile))).toString('utf8'))}
  catch(error){
    if(error.code!=='ENOENT')throw failure('LOCAL_IDENTITY_INVALID',500);
    const iat=Math.floor(now()/1000);
    identity={version:1,secret:randomBytes(32).toString('base64'),deviceId:randomUUID(),jti:randomUUID(),iat,exp:iat+365*86400,soId:1};
    await atomic(identityFile,await protect(Buffer.from(JSON.stringify(identity))));
  }
  if(identity.version!==1||Buffer.from(identity.secret??'','base64').length!==32||!identity.deviceId||!identity.jti||identity.soId!==1)throw failure('LOCAL_IDENTITY_INVALID',500);
  try{data=JSON.parse(await readFile(dataFile,'utf8'))}
  catch(error){if(error.code!=='ENOENT')throw failure('LOCAL_STORE_INVALID',500);data={version:1,nextScrapId:1,nextFolderId:1,scraps:[],folders:[]};await atomic(dataFile,JSON.stringify(data))}
  if(data.version!==1||!Array.isArray(data.scraps)||!Array.isArray(data.folders)||!Number.isInteger(data.nextScrapId)||!Number.isInteger(data.nextFolderId))throw failure('LOCAL_STORE_INVALID',500);
  const serialized=operation=>{const result=queue.then(operation);queue=result.catch(()=>{});return result};
  const mutate=operation=>serialized(async()=>{const next=clone(data);const result=operation(next);await atomic(dataFile,JSON.stringify(next));data=next;return clone(result)});
  const countToday=()=>data.scraps.filter(row=>day(row.created_at)===day(now())).length;
  const sign=()=>{
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({iss:'drt-local',aud:'drt-local-benchmark',scope:'benchmark',soId:1,
      deviceId:identity.deviceId,jti:identity.jti,iat:identity.iat,exp:identity.exp})).toString('base64url');
    const input=header+'.'+payload;return input+'.'+createHmac('sha256',Buffer.from(identity.secret,'base64')).update(input).digest('base64url');
  };
  const checkFolder=(state,id)=>{if(id!==null&&(!Number.isSafeInteger(id)||!state.folders.some(row=>row.id===id)))throw failure('LOCAL_FOLDER_NOT_FOUND',404)};
  const normalized=(payload,state,existing)=>{
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw failure('INVALID_SCRAP');
    const previous=structure(existing?.content_structure),incoming=structure(payload.content_structure);
    const content={...previous,...incoming};
    const raw=typeof payload.raw_content==='string'?payload.raw_content:typeof payload.excerpt==='string'?payload.excerpt:
      typeof incoming.content==='string'?incoming.content:typeof incoming.text==='string'?incoming.text:existing?.raw_content??'';
    const media=payload.media_items??incoming.media_items??incoming.media??previous.media_items??previous.media??[];
    if(raw.length>1000000||!Array.isArray(media)||media.length>20||(!raw.trim()&&!media.length))throw failure('INVALID_SCRAP');
    let url=String(payload.original_url??existing?.original_url??'').trim()||'MANUAL_INPUT';
    if(url!=='MANUAL_INPUT'){
      let parsed;try{parsed=new URL(url)}catch{throw failure('INVALID_SCRAP_URL')}
      if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw failure('INVALID_SCRAP_URL');
      parsed.hash='';url=parsed.href;
    }
    const fid=folderId(payload.folder_id!==undefined?payload.folder_id:existing?.folder_id);checkFolder(state,fid);
    const metrics={...previous.metrics,...incoming.metrics,...Object.fromEntries(['likes','comments','reposts','shares','views'].filter(key=>payload[key]!==undefined&&Number.isFinite(Number(payload[key]))).map(key=>[key,Number(payload[key])]))};
    const affiliate_type=payload.affiliate_type!==undefined?payload.affiliate_type:existing?.affiliate_type??null;
    if(affiliate_type!==null&&(typeof affiliate_type!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(affiliate_type)))throw failure('INVALID_AFFILIATE_TYPE');
    const affiliate_url=affiliateUrl(payload.affiliate_url!==undefined?payload.affiliate_url:existing?.affiliate_url);
    const affiliate_meta=payload.affiliate_meta!==undefined?metadata(payload.affiliate_meta):clone(existing?.affiliate_meta??null);
    const scrap_purpose=String(payload.scrap_purpose??existing?.scrap_purpose??'BENCHMARK').slice(0,80);
    const is_stabilization=affiliate_type==='STABILIZATION'||scrap_purpose==='STABILIZATION';
    const fields={};
    for(const[key,max]of Object.entries({post_date:250,shortcode:250,category:1000})){
      if(payload[key]!==undefined){if(payload[key]!==null&&typeof payload[key]!=='string')throw failure('INVALID_SCRAP_METADATA');
        if((payload[key]?.length??0)>max)throw failure('INVALID_SCRAP_METADATA');fields[key]=payload[key]}
    }
    if(payload.video_issues!==undefined){
      if(!Array.isArray(payload.video_issues)||payload.video_issues.length>100||JSON.stringify(payload.video_issues).length>64000)throw failure('INVALID_SCRAP_METADATA');
      fields.video_issues=clone(payload.video_issues);
    }
    return {...existing,original_url:url,original_author:String(payload.original_author??existing?.original_author??'').slice(0,250),
      raw_content:raw,extracted_content:raw,excerpt:raw,custom_guide:String(payload.custom_guide??existing?.custom_guide??'').slice(0,20000),folder_id:fid,
      ...fields,affiliate_type,affiliate_url,affiliate_meta,is_stabilization,has_affiliate_link:!is_stabilization&&Boolean(affiliate_url),
      content_structure:JSON.stringify({...content,content:raw,text:raw,media_items:media,metrics}),
      scrap_purpose,updated_at:new Date(now()).toISOString()};
  };
  const stats=()=>({today_count:countToday(),daily_limit:1000000,max_limit:1000000,so_id:1});
  return {
    async issueToken({rotate=false}={}){return serialized(async()=>{
      if(rotate||identity.exp<=Math.floor(now()/1000)){
        const iat=Math.floor(now()/1000),next={...identity,jti:randomUUID(),iat,exp:iat+365*86400};
        await atomic(identityFile,await protect(Buffer.from(JSON.stringify(next))));identity=next;
      }return{token:sign(),soId:1};
    })},
    async verifyToken(token){
      await queue;
      if(typeof token!=='string'||token.length>32768)return null;
      const parts=token.split('.');if(parts.length!==3||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part)))return null;
      try{
        const header=JSON.parse(Buffer.from(parts[0],'base64url')),payload=JSON.parse(Buffer.from(parts[1],'base64url'));
        if(header.alg!=='HS256'||header.typ!=='JWT'||payload.iss!=='drt-local'||payload.aud!=='drt-local-benchmark'||payload.scope!=='benchmark'||
          payload.soId!==1||payload.deviceId!==identity.deviceId||payload.jti!==identity.jti||payload.iat!==identity.iat||payload.exp!==identity.exp||payload.exp<=Math.floor(now()/1000))return null;
        const expected=createHmac('sha256',Buffer.from(identity.secret,'base64')).update(parts[0]+'.'+parts[1]).digest();
        const observed=Buffer.from(parts[2],'base64url');return observed.length===expected.length&&timingSafeEqual(observed,expected)?payload:null;
      }catch{return null}
    },
    async status(){await queue;return{mode:'local',soId:1,scraps:data.scraps.length,folders:data.folders.length}},
    async listScraps({page=1,limit=15,search='',folder_id='ALL',view_mode='MINE',link_filter='ALL'}={}){
      // A local personal store has no access to the original administrator's other-account library.
      if(view_mode==='ALL_USERS')throw failure('LOCAL_SHARED_LIBRARY_UNAVAILABLE',503);
      if(view_mode!=='MINE'||!['ALL','LINKED','STABILIZATION','UNLINKED'].includes(link_filter))throw failure('INVALID_LIST_REQUEST');
      await queue;const query=String(search).toLocaleLowerCase(),fid=folder_id==='ALL'?'ALL':folderId(folder_id);
      const rows=data.scraps.filter(row=>(fid==='ALL'||row.folder_id===fid)&&(!query||(row.original_author+' '+row.raw_content).toLocaleLowerCase().includes(query)))
        .toSorted((a,b)=>b.created_at.localeCompare(a.created_at)||b.id-a.id);
      const link_summary={all:rows.length,linked:0,stabilization:0,unlinked:0};
      for(const row of rows)link_summary[purpose(row).toLowerCase()]++;
      const filtered=link_filter==='ALL'?rows:rows.filter(row=>purpose(row)===link_filter);
      return{data:clone(filtered.slice((page-1)*limit,page*limit).map(row=>({...row,is_stabilization:purpose(row)==='STABILIZATION',has_affiliate_link:purpose(row)==='LINKED'}))),total:filtered.length,link_summary};
    },
    async getScrap(id){await queue;return clone(data.scraps.find(row=>row.id===Number(id))??null)},
    async saveScrap(payload){
      const row=await mutate(state=>{
        let url=String(payload.original_url??'').trim();
        if(url&&url!=='MANUAL_INPUT'){try{const parsed=new URL(url);parsed.hash='';url=parsed.href}catch{throw failure('INVALID_SCRAP_URL')}}
        const old=url&&url!=='MANUAL_INPUT'?state.scraps.find(row=>row.original_url===url):null;
        const row=normalized(payload,state,old);row.id=old?.id??state.nextScrapId++;row.created_at=old?.created_at??new Date(now()).toISOString();
        if(old)state.scraps[state.scraps.indexOf(old)]=row;else state.scraps.push(row);return row;
      });return{...row,...stats()};
    },
    async updateScrap(id,patch){return mutate(state=>{
      const index=state.scraps.findIndex(row=>row.id===Number(id));if(index<0)return null;
      const row=normalized(patch,state,state.scraps[index]);state.scraps[index]=row;return row;
    })},
    async applyAction(body){
      // Request names and fields are from retained original benchmark client SHA-256
      // 8318610e57c69f041f5d2573bd45ef90eb78f518ac2222ddd50b2eb927f881b8.
      // This personal-store adapter does not reproduce the unavailable remote shared library.
      if(!body||typeof body!=='object'||Array.isArray(body))throw failure('INVALID_SCRAP_ACTION');
      const action=body.action;
      if(['COPY_WITH_LINK','COPY_AS_STABILIZATION'].includes(action)||body.view_mode==='ALL_USERS')throw failure('LOCAL_SHARED_LIBRARY_UNAVAILABLE',503);
      if(!['SAVE_LINK','REMOVE_LINK','SAVE_STABILIZATION','BULK_SET_STABILIZATION','BULK_REMOVE_PURPOSE'].includes(action))throw failure('LOCAL_ACTION_NOT_SUPPORTED');
      const bulk=action.startsWith('BULK_');
      const ids=bulk?body.ids:[body.scrap_id];
      if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1))throw failure('INVALID_SCRAP_ID');
      const selected=[...new Set(ids.map(Number))];
      return mutate(state=>{
        const rows=selected.map(id=>state.scraps.find(row=>row.id===id));
        if(rows.some(row=>!row))throw failure('LOCAL_SCRAP_NOT_FOUND',404);
        const updated=rows.map(row=>{
          let patch;
          if(action==='SAVE_LINK'){
            if(!body.affiliate_type||body.affiliate_type==='STABILIZATION'||!affiliateUrl(body.affiliate_url))throw failure('AFFILIATE_LINK_REQUIRED');
            patch={...body,scrap_purpose:'BENCHMARK'};
          }else if(action==='SAVE_STABILIZATION'||action==='BULK_SET_STABILIZATION'){
            const guide=body.custom_guide??row.custom_guide??'';
            patch={...(bulk?{}:body),affiliate_type:'STABILIZATION',affiliate_url:'',
              affiliate_meta:!bulk&&body.affiliate_meta!==undefined?body.affiliate_meta:guide?{customGuide:guide}:null,scrap_purpose:'STABILIZATION'};
          }else patch={affiliate_type:null,affiliate_url:'',affiliate_meta:null,scrap_purpose:'BENCHMARK'};
          const next=normalized(patch,state,row);state.scraps[state.scraps.indexOf(row)]=next;return next;
        });
        return bulk?{success:true,updated:updated.length}:{success:true,id:updated[0].id,data:updated[0]};
      });
    },
    async deleteScraps(ids){const selected=new Set(ids.map(Number));return mutate(state=>{const before=state.scraps.length;state.scraps=state.scraps.filter(row=>!selected.has(row.id));return before-state.scraps.length})},
    async listFolders(){await queue;return{folders:clone(data.folders.toSorted((a,b)=>(a.sort_order??a.id)-(b.sort_order??b.id)).map(row=>({...row,count:data.scraps.filter(scrap=>scrap.folder_id===row.id).length}))),
      total_count:data.scraps.length,uncategorized_count:data.scraps.filter(row=>row.folder_id===null).length,...stats()}},
    async createFolder(name){name=String(name??'').trim();if(!name||name.length>100)throw failure('INVALID_FOLDER_NAME');return mutate(state=>{
      const folder={id:state.nextFolderId++,folder_name:name,created_at:new Date(now()).toISOString()};state.folders.push(folder);return folder;
    })},
    async renameFolder(id,name){name=String(name??'').trim();if(!name||name.length>100)throw failure('INVALID_FOLDER_NAME');return mutate(state=>{
      const row=state.folders.find(row=>row.id===Number(id));if(!row)throw failure('LOCAL_FOLDER_NOT_FOUND',404);row.folder_name=name;return row;
    })},
    async reorderFolders(orders){if(!Array.isArray(orders))throw failure('INVALID_FOLDER_ORDER');return mutate(state=>{
      const selected=new Set();for(const order of orders){const id=Number(order.id),position=Number(order.sort_order);checkFolder(state,id);
        if(selected.has(id)||!Number.isSafeInteger(position)||position<0)throw failure('INVALID_FOLDER_ORDER');
        selected.add(id);state.folders.find(row=>row.id===id).sort_order=position;}return true;
    })},
    async moveScraps(ids,fid){return mutate(state=>{
      const destination=folderId(fid);checkFolder(state,destination);
      if(!Array.isArray(ids)||!ids.length||ids.some(id=>!Number.isSafeInteger(Number(id))||!state.scraps.some(row=>row.id===Number(id))))throw failure('INVALID_SCRAP_ID');
      const selected=new Set(ids.map(Number));state.scraps.forEach(row=>{if(selected.has(row.id))row.folder_id=destination});return ids.length;
    })},
    async deleteFolders(ids){const selected=new Set(ids.map(Number));return mutate(state=>{
      const before=state.folders.length;state.folders=state.folders.filter(row=>!selected.has(row.id));state.scraps.forEach(row=>{if(selected.has(row.folder_id))row.folder_id=null});return before-state.folders.length;
    })}
  };
}
