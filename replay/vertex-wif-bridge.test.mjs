import test from 'node:test';
import assert from 'node:assert/strict';
import {VertexWifBridge,VERTEX_SETTINGS,vertexWirePayload} from './vertex-wif-bridge.mjs';
const auth={authenticated:true,credentialType:'external_account',project:VERTEX_SETTINGS.project,location:'global',model:'gemini-3.8-flash'};
test('WIF metadata is explicit and never invents an API key',async()=>{
  const bridge=new VertexWifBridge({runner:async()=>auth});
  assert.equal(bridge.status().credentialReady,false);await bridge.authenticate();
  const data=bridge.credentialMetadata();assert.equal(data.credentialReady,true);assert.equal(data.hasKey,false);
  assert.equal(data.apiKey,null);assert.deepEqual(data.keys,[]);assert.equal(data.credentials[0].kind,'WIF');
});
test('original multimodal prompt/configuration and raw Google response remain unchanged',async()=>{
  const payload={contents:[{parts:[{text:'source prompt'},{inlineData:{mimeType:'image/png',data:'fixture'}}]}],
    systemInstruction:{parts:[{text:'original instruction'}]},generationConfig:{temperature:.9,responseMimeType:'application/json'},tools:[{googleSearch:{}}]};
  const output={candidates:[{content:{parts:[{text:'{"threads":[]}' }]}}],usageMetadata:{totalTokenCount:10}};
  const original=structuredClone(payload);
  const bridge=new VertexWifBridge({runner:async(operation,value)=>{if(operation==='auth')return auth;
    assert.deepEqual(value,{...payload,contents:payload.contents.map(content=>({...content,role:'user'}))});return output}});
  await bridge.authenticate();assert.strictEqual(await bridge.generate(payload),output);
  assert.deepEqual(payload,original);
});
test('Vertex supplies only omitted user roles and preserves explicit conversation roles',()=>{
  const user={role:'user',parts:[{text:'question'}]},model={role:'model',parts:[{text:'prior answer'}]};
  const omitted={parts:[{text:'original next prompt'}]};const payload={contents:[user,model,omitted]};
  const wire=vertexWirePayload(payload);
  assert.strictEqual(wire.contents[0],user);assert.strictEqual(wire.contents[1],model);
  assert.deepEqual(wire.contents[2],{...omitted,role:'user'});assert.equal(omitted.role,undefined);
});
test('wrong WIF identity/model and unavailable authentication fail without fallback',async()=>{
  const bridge=new VertexWifBridge({runner:async()=>({...auth,model:'other-model'})});
  await assert.rejects(bridge.authenticate(),error=>error.code==='VERTEX_CONFIG');
  await assert.rejects(bridge.generate({contents:[]}),error=>error.code==='VERTEX_AUTH');
});
test('invalid bodies and credential-bearing fields never reach the worker',async()=>{
  let generated=false;const bridge=new VertexWifBridge({runner:async(operation)=>{if(operation==='generate')generated=true;return auth}});
  await bridge.authenticate();
  await assert.rejects(bridge.generate({contents:[]}),error=>error.status===400);
  await assert.rejects(bridge.generate({contents:[{}],apiKey:'not-a-real-key'}),error=>error.status===400);
  assert.equal(generated,false);
});
