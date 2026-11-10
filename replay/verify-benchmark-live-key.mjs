import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {chromium}=require('playwright-core');
let browser;
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR'});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const calls=[],pageErrors=[];
  page.on('pageerror',()=>pageErrors.push('browser_page_error'));
  page.on('response',response=>{if(new URL(response.url()).pathname==='/api/keys/extension')calls.push(response)});
  // This opens the requested original automatic issuance flow once. No scrap,
  // publication, schedule, or extension configuration action is performed.
  await page.goto('http://127.0.0.1:9248/dashboard/benchmark',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>Boolean(window.__REA_REPLAY__?.benchmarkLive&&window.__REA_BENCHMARK__));
  const issued=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/keys/extension');
  await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();
  const response=await issued;const status=response.status();
  let token;try{const data=await response.json();if(typeof data.token==='string')token=data.token}catch{}
  let displayed=false,reused=false;
  if(response.ok()&&token){
    const field=page.getByLabel('Chrome 확장 프로그램 JWT 연동 키');await field.waitFor();
    displayed=(await field.inputValue())===token;
    await page.screenshot({path:join(import.meta.dirname,'benchmark-live-key.png'),mask:[field]});
    await page.reload({waitUntil:'networkidle'});
    await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();
    await field.waitFor();reused=(await field.inputValue())===token&&calls.length===1;
  }
  await page.waitForTimeout(300);
  const lines=(await readFile(join(import.meta.dirname,'development-traffic.jsonl'),'utf8')).trim().split('\n');
  const events=lines.map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(value=>value?.channel==='benchmark_internal').slice(-10);
  const report={checked_at:new Date().toISOString(),authority:'live original API and original browser client',
    issuer_status:status,automatic_request_count:calls.length,key_received:Boolean(token),key_displayed:displayed,
    cached_key_reused_without_reissue:reused,page_errors:pageErrors.length,
    extra_notification_panels:await page.locator('[aria-label="벤치마킹 연결 알림"]').count(),
    logged_events:events.map(({event,code,status})=>({event,code,...(status?{status}:{})})),
    secret_values_retained_in_report:false,publication_or_schedule_performed:false,extension_configured:false};
  await writeFile(join(import.meta.dirname,'benchmark-live-key-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({issuer_status:status,key_received:report.key_received,key_displayed:displayed,cached_key_reused:reused,page_errors:pageErrors.length}));
  if(!displayed||!reused||pageErrors.length)process.exitCode=1;
}catch(error){console.error(JSON.stringify({errorName:error.name,code:'LIVE_KEY_VERIFICATION_FAILED'}));process.exitCode=1}
finally{await browser?.close()}
