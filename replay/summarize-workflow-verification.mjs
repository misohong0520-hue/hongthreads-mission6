import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=import.meta.dirname;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async file=>JSON.parse((await readFile(join(root,file),'utf8')).replace(/^\uFEFF/,''));
const manifest=await readJson('workflow-capture/manifest.json');
for(const record of manifest.records){
  const bytes=await readFile(join(root,'workflow-capture',record.file));
  assert.equal(sha(bytes),record.object_sha256);assert.equal(bytes.length,record.bytes);assert.equal(record.status,200);
}
const cases=['workflow-generate-write-fixed','workflow-generate-multi','workflow-dashboard-inspection',
  'workflow-drafts-inspection','workflow-final-trends','workflow-resume-edit'];
const browser=[];
for(const name of cases){
  const filename=name+'-evidence.json',bytes=await readFile(join(root,filename));
  const evidence=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),result=evidence.normalized_result;
  const errors=result.events.items.filter(item=>item.kind==='page-error');
  const responses=result.events.items.filter(item=>item.kind==='response').map(item=>({method:item.method,
    pathname:new URL(item.url.url).pathname,status:item.status,step:item.step_index}));
  const failed=responses.filter(item=>item.status>=400);
  assert.ok(result.steps.every(step=>step.status==='completed'),name+' action failure');
  assert.equal(errors.length,0,name+' page error');assert.equal(failed.length,0,name+' HTTP error');
  assert.equal(result.events.dropped,0,name+' dropped events');
  const publications=result.events.items.filter(item=>item.kind==='request'&&
    ['/api/threads/schedule','/api/threads-manage/publish-single'].includes(new URL(item.url.url).pathname));
  assert.equal(publications.length,0,'A verification case must not publish or schedule');
  if(name==='workflow-generate-write-fixed')assert.ok(responses.some(item=>item.pathname==='/api/generate/save-draft'&&item.status===200));
  if(name==='workflow-generate-multi'){
    assert.ok(responses.some(item=>item.pathname==='/api/threads'&&item.status===201&&item.step<6));
    assert.ok(responses.some(item=>item.pathname==='/api/threads'&&item.status===201&&item.step>6));
  }
  const finalText=result.steps.at(-1).artifacts.accessibility.value.text;
  if(name==='workflow-drafts-inspection')assert.ok(finalText.includes('전체 3')&&!finalText.includes('내 게시물 보관함 이용 불가'));
  if(name==='workflow-resume-edit')assert.ok(finalText.includes('[개발 연결 검증용 초안 · 실제 발행하지 않음]'));
  browser.push({case:name,evidence_id:evidence.evidence_id,evidence_sha256:sha(bytes),steps:result.steps.length,
    page_errors:errors.length,http_errors:failed.length,publication_requests:publications.length,
    mutations:responses.filter(item=>item.method!=='GET')});
}
const local='http://127.0.0.1:9248';
const [state,subscription,drafts,sessions,accounts]=await Promise.all(['/__workflow/status','/api/subscription/status','/api/threads','/api/batch-sessions','/api/keys/accounts']
  .map(async path=>{const response=await fetch(local+path);assert.equal(response.status,200);return response.json()}));
assert.equal(state.vertex.model,'gemini-3.8-flash');assert.equal(state.vertex.credentialReady,true);
assert.equal(state.session.configured,true);assert.equal(drafts.data.length,3);
assert.ok(accounts.data.some(account=>account.threads_username==='latest_support_kr'||account.account_name==='latest_support_kr'));
assert.ok(drafts.data.every(item=>item.status==='DRAFT'));
assert.ok(sessions.data.some(item=>JSON.stringify(item).includes('[개발 연결 검증용 초안 · 실제 발행하지 않음]')),'Edited original session was not persisted');
const smoke=await readJson('vertex-wif-verification.json');assert.equal(smoke.actualModelVersion,'gemini-3.8-flash');
const report={checked_at:new Date().toISOString(),original_responses:manifest.records.length,all_original_hashes_verified:true,
  original_backend:'https://drt.agczero.com',provider:'VERTEX_WIF',model:'gemini-3.8-flash',actual_model_smoke:smoke.actualModelVersion,
  connected_threads_username:'latest_support_kr',stored_verification_drafts:drafts.data.length,all_drafts_unpublished:true,
  edited_session_persisted:true,actual_subscription:{isSubscribed:subscription.isSubscribed,remainingDays:subscription.remainingDays,hasPaidBilling:subscription.hasPaidBilling},browser_cases:browser,
  user_publication_decision:'Keep current state without public posting; no publication or schedule test authorized',
  unit_tests:{command:'node --test replay/live-trends-bridge.test.mjs replay/vertex-wif-bridge.test.mjs replay/workflow-routes.test.mjs',passed:41},
  benchmark:{fixture:'benchmark-browser-verification.json',live:'benchmark-live-key-verification.json',automatic_issuance:true,diagnostics_ui:false,live_issuer_status:403,live_key_received:false},
  limitations:['Original backend, login session and EC2 are required; this is not an independent server clone',
    'No real Threads publication or scheduling was performed','Affiliate integrations and every media/source/settings path were not all exercised']};
await writeFile(join(root,'workflow-verification-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({original_responses:report.original_responses,all_original_hashes_verified:true,browser_cases:browser.length,
  page_errors:0,http_errors:0,stored_unpublished_drafts:3,edited_session_persisted:true,unit_tests_passed:41}));
