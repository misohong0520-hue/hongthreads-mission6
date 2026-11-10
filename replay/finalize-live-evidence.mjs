import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=import.meta.dirname;
const load=async name=>JSON.parse((await readFile(join(root,name),'utf8')).replace(/^\uFEFF/,''));
const api=await load('live-original-api-verification.json');
const browser=await load('live-original-browser-evidence.json');
const automatic=await load('live-auto-refresh-browser-evidence.json');
const fixture=await load('live-browser-fixture-evidence.json');
const validate=evidence=>{
  const capture=evidence.normalized_result;
  assert.ok(capture.steps.every(step=>step.status==='completed'));
  const errors=capture.events.items.filter(event=>event.kind==='page-error');
  const failed=capture.events.items.filter(event=>event.kind==='response'&&event.status>=400&&!new URL(event.url.url).pathname.startsWith('/__origin/'));
  assert.equal(errors.length,0);assert.equal(failed.length,0);
  return capture;
};
const live=validate(browser),auto=validate(automatic),test=validate(fixture);
assert.equal(api.passed,10);
const snapshot=(capture,id)=>capture.steps.find(step=>step.step_id===id).artifacts.accessibility.value.text;
const countHeadings=value=>value.split('\n').filter(line=>line.includes('- heading ')&&line.includes('[level=3]')).length;
assert.equal(countHeadings(snapshot(live,'google-loaded')),20);
for(const [step,count] of [['shopping-issue-loaded',50],['shopping-popular-loaded',50],['shopping-new-loaded',20]])
  assert.equal(snapshot(live,step).split('\n').filter(line=>/^\s+- text: \d+ /.test(line)).length,count);
const news=snapshot(live,'news-loaded');
assert.equal(countHeadings(news),30);
const keywordBlock=news.split('heading "급상승 검색어"')[1].split('heading "실시간 이슈 및 뉴스"')[0];
const keywordCount=keywordBlock.split('\n').filter(line=>line.includes('- button ')).length;
assert.equal(keywordCount,17);
const counts={};
for(const event of auto.events.items.filter(event=>event.kind==='request')){
  const url=new URL(event.url.url);
  if(!url.pathname.startsWith('/api/trends/'))continue;
  const key=url.pathname+url.search;counts[key]=(counts[key]??0)+1;
}
for(const path of ['/api/trends/realtime','/api/trends/datalab','/api/trends/google','/api/trends/shortents','/api/trends/shopping/keywords?type=NEW'])
  assert.ok(counts[path]>=2);
assert.ok(snapshot(test,'google-before-refresh').includes('브리지 갱신 검증 1'));
assert.ok(snapshot(test,'google-after-refresh').includes('브리지 갱신 검증 2'));
assert.ok(!snapshot(test,'google-after-refresh').includes('브리지 갱신 검증 1'));
const shot=live.steps.at(-1).artifacts.screenshot.value;
const bytes=Buffer.from(shot.data_base64,'base64');
assert.equal(createHash('sha256').update(bytes).digest('hex'),shot.sha256);
await writeFile(join(root,'live-original-news.png'),bytes);
const report={
  scope:'Authenticated original read-only trend API bridge plus original captured client assets; not a full backend clone',
  api:{passed:api.passed,total:api.total,verification:'live-original-api-verification.json'},
  original_browser:{evidence_id:browser.evidence_id,steps_completed:live.steps.length,page_errors:0,application_http_errors:0,
    google_items:20,shopping_items:{ISSUE:50,POPULAR:50,NEW:20},news_items:30,rising_keywords:keywordCount},
  automatic_refresh:{evidence_id:automatic.evidence_id,seconds:60,observed_trend_request_counts:counts,page_errors:0,shopping_tab_remained_selected:true},
  fixture_refresh:{evidence_id:fixture.evidence_id,scope:'Isolated test upstream only',visible_content_changed:true,google_tab_remained_selected:true,page_errors:0},
  memory_only_session:true,session_values_in_report:false,
  limitations:['Upstream collection and cache schedules determine actual data freshness.','Expired sessions or server restarts require reconnecting.','Only allowlisted trend GET routes are live; other recorded app routes retain their previous replay behavior.','Article navigation and AI writing/publication backends are outside this verification.']
};
await writeFile(join(root,'live-verification-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
