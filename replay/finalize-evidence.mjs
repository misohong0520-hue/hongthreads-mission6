import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=import.meta.dirname;
const bundle=JSON.parse(await readFile(join(root,'browser-qa-evidence.json'),'utf8'));
const ids={category:'ev_8b233c47d7cff290356b893d3f482208e23d41fcc6f9a367efce359cdec0ccb4',purchase:'ev_071c77ee054705bf6df5634f12f61c7149519579302491d45f05d9c3132c9dac'};
const report={scope:'Original captured application and exact recorded API bytes on localhost; no full backend equivalence.',cases:{}};
for(const [name,id] of Object.entries(ids)){
 const matches=bundle.records.filter(x=>x.evidence_id===id);
 if(matches.length!==1)throw Error('Missing exact REA browser evidence: '+id);
 const evidence=matches[0],capture=evidence.normalized_result;
 if(!capture.steps.every(step=>step.status==='completed'))throw Error('Incomplete browser steps: '+name);
 const text=capture.steps.at(-1).artifacts.accessibility.value.text;
 const responses=capture.events.items.filter(e=>e.kind==='response');
 const errors=responses.filter(e=>e.status>=400&&!e.url.url.includes('/__origin/'));
 const pageErrors=capture.events.items.filter(e=>e.kind==='page-error');
 if(errors.length||pageErrors.length)throw Error('Application browser error: '+name);
 const checks=name==='category'?{original_category_heading:text.includes('디지털/가전'),actual_first_keywords:['가습기','정수기','공기청정기','냉장고','김치냉장고'].every(x=>text.includes(x))}:{original_purchase_heading:text.includes('프리미엄 구독'),original_plan_price:text.includes('33,000')};
 if(!Object.values(checks).every(Boolean))throw Error('Expected original content missing: '+name);
 await writeFile(join(root,'browser-'+name+'-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 report.cases[name]={evidence_id:id,url:capture.steps.at(-1).after_url.url,steps_completed:capture.steps.length,checks,page_errors:pageErrors.length,application_http_errors:errors.length,uncaptured_external_telemetry_responses:responses.filter(e=>e.status>=400&&e.url.url.includes('/__origin/')).length,browser_cleanup:capture.browser.cleanup};
}
await writeFile(join(root,'browser-verification.json'),JSON.stringify(report,null,2)+'\n');
let readme=await readFile(join(root,'README.md'),'utf8');
readme=readme.replaceAll('http://127.0.0.1:<port>','http://127.0.0.1:9247');
if(!readme.includes('## 브라우저 검증'))readme+='\n## 브라우저 검증\n\nREA로 원본 JavaScript가 로컬에서 실행되는 것을 확인했습니다. 데이터랩 분류를 디지털/가전으로 변경하면 실제 수집된 가습기·정수기·공기청정기 등의 순위가 표시됩니다. 원본 구독 페이지와 33,000원 요금 표시도 확인했습니다. 브라우저 실행 중 애플리케이션 HTTP 오류와 페이지 오류는 없었고, 미수집 외부 분석 요청은 501로 남습니다. 상세 결과는 browser-verification.json과 browser-category-evidence.json, browser-purchase-evidence.json에 있습니다.\n';
await writeFile(join(root,'README.md'),readme);
const source=await readFile(join(root,'server.mjs'),'utf8');
console.log(JSON.stringify({report,server_control_lines:source.split('\n').filter(x=>/9247|process.env|__shutdown|listen\(/.test(x))},null,2));