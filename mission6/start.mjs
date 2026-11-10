import {spawn} from 'node:child_process';
import {mkdir,open,cp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
const root=resolve(import.meta.dirname,'..'),runtime=process.env.HONGTHREADS_RUNTIME_DIR??join(homedir(),process.platform==='win32'?'AppData/Local/HongThreads/runtime':'.local/share/hongthreads');
await mkdir(runtime,{recursive:true});
const children=[];
try{const previous=JSON.parse(await readFile(join(runtime,'processes.json'),'utf8'));for(const child of previous.children??[]){try{process.kill(child.pid,0);children.push(child)}catch{}}}catch{}
const start=async(name,args,cwd,env={})=>{const out=await open(join(runtime,name+'.log'),'a'),err=await open(join(runtime,name+'-error.log'),'a');const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},detached:true,windowsHide:true,stdio:['ignore',out.fd,err.fd]});child.unref();const previous=children.findIndex(c=>c.name===name);if(previous>=0)children.splice(previous,1);children.push({name,pid:child.pid});await out.close();await err.close()};
const check=async url=>{try{return(await fetch(url,{signal:AbortSignal.timeout(2000)})).ok}catch{return false}};
if(!await check('http://127.0.0.1:9250/workspace/connect')){
  const standalone=join(root,'web/.next/standalone');
  await cp(join(root,'web/public'),join(standalone,'public'),{recursive:true});
  await cp(join(root,'web/.next/static'),join(standalone,'.next/static'),{recursive:true});
  await start('web',[join(standalone,'server.js')],standalone,{PORT:'9250',HOSTNAME:'127.0.0.1'});
}
if(!await check('http://127.0.0.1:9251/healthz'))await start('gateway',['--use-system-ca',join(root,'mission6/server.mjs')],root,{PORT:'9251'});
for(let i=0;i<40;i++){if(await check('http://127.0.0.1:9251/healthz')&&await check('http://127.0.0.1:9250/workspace/connect'))break;await new Promise(r=>setTimeout(r,500))}
await writeFile(join(runtime,'processes.json'),JSON.stringify({at:new Date().toISOString(),children},null,2)+'\n');
if(!await check('http://127.0.0.1:9251/healthz'))throw new Error('HongThreads gateway did not start; check '+runtime);
console.log(JSON.stringify({ready:true,url:'http://127.0.0.1:9251/dashboard/insights',workspace:'http://127.0.0.1:9251/workspace/benchmarks',logs:runtime}));
