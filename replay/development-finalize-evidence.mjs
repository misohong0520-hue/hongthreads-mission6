import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async name => JSON.parse((await readFile(join(root,name),'utf8')).replace(/^\uFEFF/,''));
const evidence = await load('development-browser-final-evidence.json');
const capture = evidence.normalized_result;
assert.ok(capture.steps.every(step => step.status === 'completed'));
const manifest = await load('manifest.json');
const body = async path => {
  const record = manifest.records.find(record => record.replayable && record.pathname+record.search === path);
  assert.ok(record);
  const bytes = await readFile(join(root,'objects',record.response.object_sha256));
  assert.equal(hash(bytes),record.response.object_sha256);
  return JSON.parse(bytes);
};
const text = step => {
  const snapshot = capture.steps.find(item => item.step_id === step)?.artifacts.accessibility;
  assert.equal(snapshot?.state,'captured');
  return snapshot.value.text;
};
const headingCount = value => value.split('\n').filter(line => line.includes('- heading ') && line.includes('[level=3]')).length;
const google = (await body('/api/trends/google')).google;
const googleText = text('google-loaded');
assert.equal(google.length,20);
assert.ok(google.every(item => googleText.includes(item.keyword)));
assert.equal(headingCount(googleText),google.length);
const shopping = {};
for (const [type,step,count] of [['ISSUE','shopping-issue-loaded',50],['POPULAR','shopping-popular-loaded',50],['NEW','shopping-new-loaded',20]]) {
  const data = (await body('/api/trends/shopping/keywords?type='+type)).keywords;
  const snapshot = text(step);
  assert.equal(data.length,count);
  assert.ok(data.every(item => snapshot.includes(item.keyword)));
  assert.equal(snapshot.split('\n').filter(line => /^\s+- text: \d+ /.test(line)).length,count);
  shopping[type] = {items_visible:count,all_recorded_keywords_visible:true};
}
const realtime = await body('/api/trends/realtime');
const newsText = text('news-loaded');
assert.equal(realtime.news.length,30);
assert.equal(realtime.keywords.length,16);
assert.equal(headingCount(newsText),30);
assert.ok(realtime.news.every(item => newsText.includes(JSON.stringify(item.title).slice(1,-1))));
assert.ok(realtime.keywords.every(item => newsText.includes(typeof item === 'string' ? item : item.keyword)));
const completedSnapshots = capture.steps.filter(step => step.artifacts.accessibility?.state === 'captured');
assert.ok(completedSnapshots.every(step => !/- button "구독"/.test(step.artifacts.accessibility.value.text) &&
  !step.artifacts.accessibility.value.text.includes('사용기한 만료') &&
  !step.artifacts.accessibility.value.text.includes('프리미엄 구독이 필요')));
const pageErrors = capture.events.items.filter(event => event.kind === 'page-error');
const responses = capture.events.items.filter(event => event.kind === 'response');
const applicationErrors = responses.filter(event => event.status >= 400 && !new URL(event.url.url).pathname.startsWith('/__origin/'));
assert.equal(pageErrors.length,0);
assert.equal(applicationErrors.length,0);
const screenshot = capture.steps.at(-1).artifacts.screenshot.value;
const image = Buffer.from(screenshot.data_base64,'base64');
assert.equal(hash(image),screenshot.sha256);
await writeFile(join(root,'development-news.png'),image);
const api = await load('development-verification.json');
assert.equal(api.api_byte_comparison.passed,18);
assert.equal(api.development_scripts.length,3);
const report = {
  scope:'Local development copy of REA-captured original client assets and fixed recorded HTTP responses; no live refresh or backend equivalence.',
  evidence_id:evidence.evidence_id,
  browser_steps_completed:capture.steps.length,
  google:{items_visible:google.length,all_recorded_keywords_visible:true},shopping,
  realtime:{keywords_visible:16,news_visible:30,all_recorded_titles_visible:true},
  subscription_ui_absent_in_all_captured_snapshots:true,
  page_errors:pageErrors.length,application_http_errors:applicationErrors.length,
  uncaptured_external_telemetry_responses:responses.filter(event => event.status >= 400 && new URL(event.url.url).pathname.startsWith('/__origin/')).length,
  exact_original_api_responses_verified:api.api_byte_comparison.passed,
  development_script_hashes_verified:api.development_scripts.length,
  browser_cleanup:capture.browser.cleanup,
  screenshot:{path:'development-news.png',sha256:screenshot.sha256}
};
await writeFile(join(root,'development-browser-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
