import {createVertexWorkerRunner} from '../mission6/runtime/vertex-worker.mjs';

export const VERTEX_SETTINGS=Object.freeze({
  provider:'VERTEX_WIF',model:process.env.VERTEX_MODEL||'gemini-3.8-flash',location:process.env.VERTEX_LOCATION||'global',
  project:process.env.VERTEX_PROJECT||'project-bf2215e0-9af7-4299-840',host:process.env.VERTEX_HOST||'3.35.8.24',user:process.env.VERTEX_USER||'ubuntu',
  identityFile:process.env.VERTEX_IDENTITY_FILE||'C:/Users/misoh/TTJ/hongsik-wordpress-key.pem',
  nodePath:process.env.VERTEX_NODE_PATH,
  worker:process.env.VERTEX_WORKER_PATH||'/home/ubuntu/baekmega-vertex/scripts/telecom-vertex-worker.cjs'
});
export const VERTEX_MAX_BYTES=96*1024*1024;
const CODES=new Set(['VERTEX_AUTH','VERTEX_CONFIG','VERTEX_PERMISSION','VERTEX_QUOTA','VERTEX_SSH','VERTEX_WORKER','VERTEX_TIMEOUT',
  'VERTEX_BILLING_DISABLED','VERTEX_API_DISABLED','VERTEX_RESPONSE','VERTEX_REQUEST']);
export const vertexFailure=(code,status=502)=>Object.assign(new Error(CODES.has(code)?code:'VERTEX_REQUEST'),
  {code:CODES.has(code)?code:'VERTEX_REQUEST',status});

// The original Gemini Developer API accepts contents with no role. Vertex REST
// requires user/model, so supply only the omitted role without changing any part.
export const vertexWirePayload=payload=>({...payload,contents:payload.contents.map(content=>
  content&&typeof content==='object'&&content.role===undefined?{...content,role:'user'}:content)});

// Preserve the Windows SSH entry point for existing local and desktop callers.
export const requestVertexSsh=createVertexWorkerRunner({settings:VERTEX_SETTINGS,transport:'ssh'});
export const requestVertexWorker=createVertexWorkerRunner({settings:VERTEX_SETTINGS,
  transport:process.env.VERTEX_TRANSPORT||(process.platform==='win32'?'ssh':'local')});

export class VertexWifBridge{
  #runner;#ready=false;#lastError=null;#checkedAt=null;
  constructor({runner=requestVertexWorker}={}){this.#runner=runner}
  status(){return{provider:VERTEX_SETTINGS.provider,model:VERTEX_SETTINGS.model,aiModel:VERTEX_SETTINGS.model,
    credentialReady:this.#ready,authSource:'EC2_AWS_WIF',lastError:this.#lastError,checkedAt:this.#checkedAt}}
  credentialMetadata(){return{...this.status(),hasKey:false,rawHasKey:false,apiKey:null,geminiKey:null,keys:[],
    credentials:this.#ready?[{id:'vertex-wif',provider:'VERTEX_WIF',kind:'WIF',accountName:'Vertex AI / EC2 WIF'}]:[]}}
  async authenticate(){
    try{
      const result=await this.#runner('auth');
      if(result.authenticated!==true||result.project!==VERTEX_SETTINGS.project||result.location!==VERTEX_SETTINGS.location||
        result.model!==VERTEX_SETTINGS.model||result.credentialType!=='external_account')throw vertexFailure('VERTEX_CONFIG');
      this.#ready=true;this.#lastError=null;this.#checkedAt=new Date().toISOString();return this.status();
    }catch(error){this.#ready=false;this.#lastError=CODES.has(error.code)?error.code:'VERTEX_AUTH';throw vertexFailure(this.#lastError,error.status||502)}
  }
  async generate(payload){
    if(!this.#ready)throw vertexFailure('VERTEX_AUTH',503);
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.contents)||!payload.contents.length)
      throw vertexFailure('VERTEX_REQUEST',400);
    const permitted=new Set(['contents','systemInstruction','tools','toolConfig','generationConfig','safetySettings','cachedContent','labels']);
    if(Object.keys(payload).some(key=>!permitted.has(key)))throw vertexFailure('VERTEX_REQUEST',400);
    try{
      const result=await this.#runner('generate',vertexWirePayload(payload));
      if(!result||typeof result!=='object'||Array.isArray(result)||(!Array.isArray(result.candidates)&&!result.promptFeedback))
        throw vertexFailure('VERTEX_RESPONSE');
      this.#lastError=null;return result;
    }catch(error){this.#lastError=CODES.has(error.code)?error.code:'VERTEX_REQUEST';throw vertexFailure(this.#lastError,error.status||502)}
  }
}
