import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {loadClientUpdates} from './workflow-client-updates.mjs';
const {parse}=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json')('@babel/parser');
async function permission({local=true,subscribed=false}={}){
  const asset=(await loadClientUpdates()).find(asset=>asset.record.path.includes('/3838-'));
  const source=asset.bytes.toString(),found=[];
  const walk=node=>{if(!node?.type)return;if(node.type==='ObjectProperty'&&node.key?.name==='checkPermission')found.push(node.value);for(const[key,value]of Object.entries(node)){if(['loc','extra','comments'].includes(key))continue;if(Array.isArray(value))value.forEach(walk);else if(value?.type)walk(value)}};walk(parse(source));
  assert.equal(found.length,1);const node=found[0];
  return runInNewContext('('+source.slice(node.start,node.end)+')',{window:{__REA_REPLAY__:{developmentArchiveImport:local}},b:false,l:subscribed,v:()=>{},w:()=>{}},{timeout:1000});
}
const localActions=['archive_import','videos_preview','videos_write','insights_search','threads_manage_subtabs'];
test('local archive, insights search and management navigation preserve publication permissions',async()=>{
  const check=await permission();for(const feature of localActions)assert.equal(check(feature),true);
  for(const feature of ['publish_multi','publish_schedule'])assert.equal(check(feature),false);
});
test('without the explicit local mode, original subscribed and unsubscribed decisions remain',async()=>{
  const unsubscribed=await permission({local:false}),subscribed=await permission({local:false,subscribed:true});
  for(const feature of localActions){assert.equal(unsubscribed(feature),false);assert.equal(subscribed(feature),true)}
});
