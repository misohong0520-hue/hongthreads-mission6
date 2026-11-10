import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {VERTEX_SETTINGS as settings} from './vertex-wif-bridge.mjs';
// One read-only diagnostic run. No worker/configuration files on EC2 are changed.
const code=`(async()=>{const {loadSettings}=require("/home/ubuntu/baekmega-vertex/src/config/vertex-settings");
const {requestDirect}=require("/home/ubuntu/baekmega-vertex/src/config/vertex-transport");
let text="";for await(const chunk of process.stdin)text+=chunk;
let reported=false;try{const result=await requestDirect(JSON.parse(text),loadSettings(),{fetchImpl:async(url,options)=>{
 const response=await fetch(url,options);if(!response.ok){const value=await response.clone().json();reported=true;
 process.stdout.write(JSON.stringify({status:response.status,error:{code:value.error?.code,status:value.error?.status,message:String(value.error?.message||"").slice(0,1000)}}));}
 return response;}});if(!reported)process.stdout.write(JSON.stringify({status:200,model:result.modelVersion}));
}catch(error){if(!reported)process.stdout.write(JSON.stringify({error:{code:error.code,status:error.status}}));}})()`;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const payload={contents:[{parts:[{text:'Return a JSON object with the boolean field ok set to true.'}]}],
  generationConfig:{temperature:.9,topP:.95,responseMimeType:'application/json'},systemInstruction:{parts:[{text:'You are a helpful assistant.'}]}};
const child=spawn('ssh.exe',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-i',settings.identityFile,
  settings.user+'@'+settings.host,'node -e '+quote(code)],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
const chunks=[];child.stdout.on('data',chunk=>chunks.push(chunk));child.stdin.end(JSON.stringify(payload));
await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
const result=JSON.parse(Buffer.concat(chunks));
await writeFile(join(import.meta.dirname,'vertex-request-diagnostic.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
