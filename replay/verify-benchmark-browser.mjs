import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {chromium}=require('playwright-core');
const root=import.meta.dirname,original='http://127.0.0.1:9248';
const overlay=JSON.parse(await readFile(join(root,'workflow-development/manifest.json'),'utf8'));
const assets=new Map();
for(const record of overlay.records.filter(record=>!/^text\/html/.test(record.media_type??'')))
  assets.set(record.path,{bytes:await readFile(join(root,'workflow-development',record.file)),type:record.media_type});
const helper=await readFile(join(root,'benchmark-client.js'));
const blocked=[];
// Test-only facade: read original documents/APIs, use the current verified client
// overlay, and refuse every real mutation. Browser fixtures handle the test POSTs.
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){blocked.push({method:req.method,path:new URL(req.url,original).pathname});res.writeHead(409,{'content-type':'application/json'}).end('{"error":"fixture_mutation_guard"}');return}
    const url=new URL(req.url,original),asset=assets.get(url.pathname);
    let bytes,headers,status=200;
    if(url.pathname==='/__workflow/benchmark-client.js'){bytes=helper;headers={'content-type':'application/javascript'}}
    else if(asset){bytes=asset.bytes;headers={'content-type':asset.type}}
    else{
      const response=await fetch(original+url.pathname+url.search,{redirect:'manual'});status=response.status;
      headers=Object.fromEntries(response.headers);bytes=Buffer.from(await response.arrayBuffer());
      if(/^text\/html/.test(headers['content-type']??'')){
        let html=bytes.toString('utf8');
        html=html.replace(/window\.__REA_REPLAY__=(\{.*?\});<\/script>/s,(_,text)=>'window.__REA_REPLAY__='+JSON.stringify({...JSON.parse(text),benchmarkLive:true})+';</script>');
        html=html.replace('<script src="/__replay/relocate.js"></script>',match=>match+'<script src="/__workflow/benchmark-client.js"></script>');
        bytes=Buffer.from(html);
      }
    }
    delete headers['content-encoding'];delete headers['transfer-encoding'];delete headers['set-cookie'];
    res.writeHead(status,{...headers,'content-length':bytes.length,'cache-control':'no-store'}).end(bytes);
  }catch{res.writeHead(502).end('fixture_read_failed')}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
let browser,page;
const requests=[],errors=[],rows=[],logs=[],dialogs=[];let keyMode='forbidden',scrapMode='forbidden',listReads=0;
const makeRow=(id,text)=>({id,original_url:'https://www.threads.com/@fixture/post/benchmark'+id,
  raw_content:text,excerpt:text,content_structure:JSON.stringify({text,media_items:[]}),original_author:'fixture_benchmark',folder_id:null,media_items:[],custom_guide:'',scrap_purpose:'BENCHMARK',created_at:new Date().toISOString()});
try{
  const session=await(await fetch(original+'/api/auth/session')).json();const soId=Number(session.user?.soId);
  assert.ok(soId>0,'A connected original session is required for read-only browser setup');
  const fixtureToken=Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')+'.'+
    Buffer.from(JSON.stringify({soId,exp:Math.floor(Date.now()/1000)+3600,fixtureOnly:true})).toString('base64url')+'.fixture-signature-not-valid';
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{dialogs.push(dialog.type());void dialog.dismiss()});
  const waitLog=async(event,code)=>{
    for(let attempt=0;attempt<50;attempt++){
      if(logs.some(value=>value.event===event&&(!code||value.code===code)))return;
      await page.waitForTimeout(100);
    }
    throw new Error('Missing private diagnostic '+event+'/'+(code??''));
  };
  await page.route('**/__workflow/benchmark-log',async route=>{
    const value=JSON.parse(route.request().postData());
    assert.ok(!JSON.stringify(value).includes(fixtureToken));
    assert.ok(Object.keys(value).every(key=>['event','code','status'].includes(key)));
    logs.push(value);await route.fulfill({status:204,body:''});
  });
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/api/keys/extension'&&request.method()==='POST'){
      const headers=request.headers();requests.push({feature:'key',emptyBody:!request.postData(),workflowTokenPresent:Boolean(headers['x-rea-workflow-token']),mode:keyMode});
      await route.fulfill({status:keyMode==='forbidden'?403:200,contentType:'application/json',
        body:JSON.stringify(keyMode==='forbidden'?{error:'premium_required',message:'fixture permission refusal'}:{token:fixtureToken})});return;
    }
    if(url.pathname==='/api/scraps/by-url'&&request.method()==='POST'){
      const body=JSON.parse(request.postData());requests.push({feature:'scrap',fields:Object.keys(body),folderIsNull:body.folder_id===null,
        validThreadUrl:new URL(body.url).pathname.includes('/post/'),mode:scrapMode});
      assert.ok(!request.postData().includes(fixtureToken));
      if(scrapMode==='success')rows.push(makeRow(91001,'BENCHMARK_FIXTURE_URL_SCRAP'));
      await route.fulfill({status:scrapMode==='forbidden'?403:200,contentType:'application/json',
        body:JSON.stringify(scrapMode==='forbidden'?{error:'premium_required',message:'fixture permission refusal'}:{id:91001})});return;
    }
    if(url.pathname==='/api/reference/scrap'&&request.method()==='GET'){
      listReads++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:rows,total:rows.length})});return;
    }
    if(url.pathname==='/api/scraps/folders'&&request.method()==='GET'){
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({folders:[],total_count:rows.length,uncategorized_count:rows.length})});return;
    }
    await route.continue();
  });
  const openPage=async()=>{
    await page.goto(base+'/dashboard/benchmark',{waitUntil:'networkidle'});
    await page.waitForFunction(()=>Boolean(window.__REA_BENCHMARK__));
    await page.getByRole('button',{name:'익스텐션 키',exact:true}).waitFor();
    await page.waitForTimeout(300);
  };
  await openPage();
  await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();
  const generate=page.getByRole('button',{name:/크롬 익스텐션 연동 키 발급하기/});
  await waitLog('key_failure','SUBSCRIPTION_REQUIRED');
  await generate.waitFor();assert.equal(requests.filter(item=>item.feature==='key').length,1,'Opening a dialog without a cached key must issue it automatically');
  assert.equal(await page.getByLabel('Chrome 확장 프로그램 JWT 연동 키').count(),0);
  keyMode='success';await generate.click();
  const input=page.getByLabel('Chrome 확장 프로그램 JWT 연동 키');await input.waitFor();
  assert.equal(await input.inputValue(),fixtureToken);
  await waitLog('key_success');
  assert.ok(requests.filter(item=>item.feature==='key').every(item=>item.emptyBody&&item.workflowTokenPresent));
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__fixtureCopied=value}}}));
  await page.getByRole('button',{name:'📋 복사',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixtureCopied),fixtureToken);
  await waitLog('copy_success');
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new DOMException('fixture denial','NotAllowedError')}});
  await page.getByRole('button',{name:'📋 복사',exact:true}).click();
  await waitLog('copy_failure','CLIPBOARD_DENIED');
  assert.equal(await page.locator('[aria-label="벤치마킹 연결 알림"]').count(),0);
  assert.equal(dialogs.length,0,'Key handling must not add popups');
  await page.screenshot({path:join(root,'benchmark-key-fixture.png'),fullPage:false,mask:[input]});
  const issuedCount=requests.filter(item=>item.feature==='key').length;
  await openPage();await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();
  await input.waitFor();assert.equal(await input.inputValue(),fixtureToken);
  await waitLog('key_reused');
  assert.equal(requests.filter(item=>item.feature==='key').length,issuedCount,'Cached account key should be reused');
  await openPage();await page.getByRole('button',{name:'링크로 스크랩',exact:true}).click();
  const urlField=page.locator('input[placeholder*="threads" i]');await urlField.waitFor();
  await urlField.fill('https://www.threads.com/@fixture/post/fixture-benchmark-test');
  const submit=page.getByRole('button',{name:'스크랩 등록',exact:true});await submit.click();
  await waitLog('url_scrap_failure','SUBSCRIPTION_REQUIRED');
  assert.equal(await urlField.inputValue(),'https://www.threads.com/@fixture/post/fixture-benchmark-test');
  scrapMode='success';await submit.click();
  await waitLog('url_scrap_success');
  await page.getByText('BENCHMARK_FIXTURE_URL_SCRAP',{exact:false}).waitFor();
  assert.ok(requests.filter(item=>item.feature==='scrap').every(item=>item.folderIsNull&&item.validThreadUrl&&
    item.fields.length===2&&item.fields.includes('url')&&item.fields.includes('folder_id')));
  const beforeRefresh=listReads;rows.push(makeRow(91002,'BENCHMARK_FIXTURE_EXTENSION_RETURN'));
  await page.waitForTimeout(2100);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByText('BENCHMARK_FIXTURE_EXTENSION_RETURN',{exact:false}).waitFor();
  assert.ok(listReads>beforeRefresh);assert.equal(errors.length,0);
  await page.screenshot({path:join(root,'benchmark-refresh-fixture.png'),fullPage:false});
  const report={checked_at:new Date().toISOString(),authority:'controlled browser fixture using original deployed client',
    original_writes_performed:false,real_extension_installed_or_configured:false,real_key_issued:false,
    checks:{dialog_automatically_issues_missing_key:true,permission_error_logged_only:true,key_response_displayed:true,account_key_reused:true,
      copy_success_logged_only:true,copy_failure_logged_only:true,no_added_key_notifications:true,url_form_reachable:true,url_permission_error_logged:true,
      url_request_contract_preserved:true,url_success_refreshes_list:true,extension_return_focus_refreshes_list:true},
    page_errors:errors,requests,private_diagnostic_events:logs,guarded_unrelated_mutations:blocked};
  await writeFile(join(root,'benchmark-browser-verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:Object.keys(report.checks).length,page_errors:errors.length,real_key_issued:false,original_writes_performed:false}));
}catch(error){
  if(page){
    const mask=page.getByLabel('Chrome 확장 프로그램 JWT 연동 키');
    await page.screenshot({path:join(root,'benchmark-ui-failure.png'),mask:(await mask.count())?[mask]:[]}).catch(()=>{});
    console.error(JSON.stringify({error:error.message.slice(0,900),pageErrors:errors,buttons:(await page.getByRole('button').allTextContents()).filter(text=>/스크랩|익스텐션|복사/.test(text))}));
  }
  throw error;
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
