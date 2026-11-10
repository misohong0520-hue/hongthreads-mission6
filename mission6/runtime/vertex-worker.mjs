import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

export const VERTEX_WORKER_LIMIT=96*1024*1024;
const failure=(code,status=502)=>Object.assign(new Error(code),{code,status});
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";

/** Run the existing WIF worker protocol without putting credentials in arguments. */
export function createVertexWorkerRunner({settings,transport=process.platform==='win32'?'ssh':'local',
  spawnImpl=spawn,timeoutMs=180000,maxBytes=VERTEX_WORKER_LIMIT,platform=process.platform}={}){
  if(!settings||!['ssh','local'].includes(transport)||typeof settings.worker!=='string'||!isAbsolute(settings.worker))
    throw failure('VERTEX_CONFIG');
  return (operation,payload)=>new Promise((resolve,reject)=>{
    if(!['auth','generate'].includes(operation)){reject(failure('VERTEX_REQUEST',400));return}
    let input;
    try{input=JSON.stringify({operation,project:settings.project,location:settings.location,model:settings.model,
      ...(payload?{payload}:{}),timeoutMs:Math.min(150000,timeoutMs)})}catch{reject(failure('VERTEX_REQUEST',400));return}
    if(Buffer.byteLength(input)>maxBytes){reject(failure('VERTEX_REQUEST',413));return}
    const command=transport==='local'?(settings.nodePath||process.execPath):(platform==='win32'?'ssh.exe':'ssh');
    const args=transport==='local'?[settings.worker]:['-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
      '-o','ConnectTimeout=15','-i',settings.identityFile,settings.user+'@'+settings.host,
      quote(settings.remoteNodePath||'node')+' '+quote(settings.worker)];
    let child;
    try{child=spawnImpl(command,args,{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']})}
    catch{reject(failure(transport==='local'?'VERTEX_WORKER':'VERTEX_SSH'));return}
    const chunks=[];let size=0,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>{finish(failure('VERTEX_TIMEOUT',504));child.kill()},timeoutMs);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){finish(failure('VERTEX_RESPONSE'));child.kill()}else chunks.push(chunk)});
    const transportFailure=()=>finish(failure(transport==='local'?'VERTEX_WORKER':'VERTEX_SSH'));
    child.once('error',transportFailure);child.stdin.once('error',transportFailure);
    child.once('close',code=>{
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{transportFailure();return}
      if(result.error){finish(failure(String(result.error.code||'VERTEX_REQUEST'),Number(result.error.status)||502));return}
      if(code!==0||!result.result){transportFailure();return}
      finish(null,result.result);
    });
    child.stdin.end(input);
  });
}
