import {VertexWifBridge} from './vertex-wif-bridge.mjs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const bridge=new VertexWifBridge();
const auth=await bridge.authenticate();
const result=await bridge.generate({contents:[{role:'user',parts:[{text:'연결 확인입니다. OK 한 단어로만 답하세요.'}]}],
  generationConfig:{maxOutputTokens:512,temperature:0,thinkingConfig:{thinkingLevel:'LOW'}}});
const text=result.candidates?.flatMap(candidate=>candidate.content?.parts??[]).map(part=>part.text??'').join('')??'';
if(!text.trim())throw new Error('Vertex returned no final text');
const report={verified_at:new Date().toISOString(),provider:auth.provider,model:auth.model,credentialReady:auth.credentialReady,
  actualModelVersion:result.modelVersion??null,responseText:text,usageMetadata:result.usageMetadata??null,
  credentials_remain_on_ec2:true,remote_service_modified:false};
await writeFile(join(import.meta.dirname,'vertex-wif-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
