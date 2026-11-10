import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json')('playwright-core');
const root=import.meta.dirname,base='http://127.0.0.1:9248',extension=JSON.parse(await readFile(join(root,'extension-local-manifest.json'),'utf8'));
const directory=await mkdtemp(join(tmpdir(),'dreaths-e2e-'));
const checks={},pageErrors=[],externalRequests=[],createdRows=[],createdFolders=[];
let context,page,phase='start',nonce;
const api=async(path,method='GET',body)=>{
  const response=await fetch(base+path,{method,headers:{Origin:base,'X-Rea-Workflow-Token':nonce,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(response.ok,'Local API operation failed: '+method+' '+new URL(path,base).pathname);return response.json();
};
try{
  assert.equal((await(await fetch(base+'/__workflow/status')).json()).benchmark.mode,'local');
  context=await chromium.launchPersistentContext(directory,{executablePath:'C:/Users/misoh/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true,
    ignoreDefaultArgs:['--disable-extensions'],args:['--disable-extensions-except='+extension.output_root,'--load-extension='+extension.output_root],
    viewport:{width:1440,height:1000},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  const fixture=await readFile(join(root,'fixtures/local-thread.html'));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===base||url.protocol==='chrome-extension:'||url.protocol==='data:'){await route.continue();return}
    if(url.origin==='https://www.threads.com'&&['/@fixture_author/post/localfixture','/t/localfixture'].includes(url.pathname)){
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fixture});return;
    }
    externalRequests.push({origin:url.origin,path:url.pathname});await route.abort();
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(error.name));
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.type());void dialog.dismiss()});
  phase='automatic_key';await page.goto(base+'/dashboard/benchmark',{waitUntil:'domcontentloaded'});
  nonce=await page.evaluate(()=>window.__REA_REPLAY__.workflowToken);
  await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();
  const input=page.getByLabel('Chrome 확장 프로그램 JWT 연동 키');await input.waitFor();const key=await input.inputValue();
  assert.ok(key.length>100);assert.equal(JSON.parse(Buffer.from(key.split('.')[1],'base64url')).iss,'drt-local');checks.dialog_automatically_issues_local_key=true;
  assert.equal(await page.getByRole('link',{name:'로컬 확장 프로그램 설치'}).getAttribute('href'),'/__local_benchmark/install');
  assert.ok((await fetch(base+'/__local_benchmark/install')).ok);checks.local_install_guide_link=true;
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__fixtureClipboard=value}}}));
  await page.getByRole('button',{name:'📋 복사',exact:true}).click();assert.ok(await page.evaluate(key=>window.__fixtureClipboard===key,key));checks.copy_correct=true;
  assert.equal(await page.locator('[aria-label="벤치마킹 연결 알림"]').count(),0);assert.equal(dialogs.length,0);checks.no_added_key_notifications=true;
  await page.screenshot({path:join(root,'benchmark-local-key.png'),mask:[input]});
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'익스텐션 키',exact:true}).click();await input.waitFor();assert.ok((await input.inputValue())===key);checks.key_reused_after_reload=true;
  phase='extension_connection';const popup=await context.newPage();await popup.goto('chrome-extension://'+extension.extension_id+'/popup.html');
  await popup.locator('#jwtInput').fill(key);await popup.locator('#saveBtn').click();await popup.waitForFunction(()=>document.getElementById('quotaContainer').style.display==='block');
  const status=await popup.evaluate(()=>chrome.runtime.sendMessage({action:'GET_DAILY_STATUS'}));assert.ok(status.success&&status.so_id===1);checks.native_extension_authenticated=true;
  phase='extension_media';const marker='LOCAL_EXTENSION_E2E_'+Date.now();
  const result=await popup.evaluate(async marker=>chrome.runtime.sendMessage({action:'SCRAP_THREAD',payload:{original_url:'https://www.threads.com/@local_fixture/post/'+marker,
    raw_content:marker,original_author:'local_fixture',likes:7,media_items:[{type:'image',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cQZsAAAAASUVORK5CYII='}]}}),marker);
  assert.ok(result.success);createdRows.push(result.data.id);
  const mediaUrl=JSON.parse(result.data.content_structure).media_items[0].url;assert.equal(new URL(mediaUrl).origin,base);
  const media=await fetch(mediaUrl);assert.equal(media.headers.get('content-type'),'image/png');assert.ok((await media.arrayBuffer()).byteLength>30);checks.extension_text_and_image_saved_locally=true;
  await page.reload({waitUntil:'domcontentloaded'});await page.getByText(marker,{exact:false}).first().waitFor();checks.original_ui_displays_extension_scrap=true;
  phase='folder_creation';await page.getByRole('button',{name:'폴더 관리',exact:true}).click();
  const folderName='LOCAL_E2E_FOLDER_'+Date.now();await page.getByPlaceholder('새 폴더 이름 입력...').fill(folderName);await page.getByRole('button',{name:'+ 생성',exact:true}).click();
  await page.getByText(folderName,{exact:false}).first().waitFor();const folder=(await api('/api/scraps/folders')).folders.find(row=>row.folder_name===folderName);assert.ok(folder);createdFolders.push(folder.id);checks.original_ui_creates_local_folder=true;
  await api('/api/reference/scrap','PATCH',{ids:[result.data.id],folder_id:folder.id});
  assert.equal((await api('/api/reference/scrap?folder_id='+folder.id)).total,1);checks.original_bulk_move_contract=true;
  await api('/api/scraps/folders','PUT',{folder_orders:[{id:folder.id,sort_order:1}]});checks.original_folder_order_contract=true;
  phase='link_scrap';
  // Chrome's extension-created first navigation can occur before Playwright's
  // route attaches. Supply a preloaded, owned fixture tab for this one target;
  // all selection, extraction, runtime messages and local saves remain native.
  const fixtureUrl='https://www.threads.com/@fixture_author/post/localfixture';
  const fixturePage=await context.newPage();await fixturePage.goto(fixtureUrl);
  await fixturePage.locator('#dreaths-scrap-btn').waitFor();
  const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://'+extension.extension_id+'/'));
  await worker.evaluate(async target=>{
    const tab=(await chrome.tabs.query({})).find(tab=>tab.url===target);if(!tab)throw new Error('Fixture tab unavailable');
    const nativeCreate=chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create=async options=>{if(options.url===target){chrome.tabs.create=nativeCreate;return chrome.tabs.get(tab.id)}return nativeCreate(options)};
  },fixtureUrl);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'링크로 스크랩',exact:true}).click();
  await page.locator('input[placeholder*="threads" i]').fill('https://www.threads.com/@fixture_author/post/localfixture');
  await page.getByRole('button',{name:'스크랩 등록',exact:true}).click();await page.getByText('LOCAL_LINK_SCRAP_FIXTURE',{exact:false}).first().waitFor({timeout:45000});
  const saved=(await api('/api/reference/scrap?search=LOCAL_LINK_SCRAP_FIXTURE')).data.find(row=>row.original_url.includes('localfixture'));
  assert.ok(saved);createdRows.push(saved.id);assert.equal(saved.raw_content,'LOCAL_LINK_SCRAP_FIXTURE');assert.equal(saved.original_author,'fixture_author');
  assert.equal(JSON.parse(saved.content_structure).metrics.likes,12);checks.link_scrap_native_selection_to_local_library=true;
  assert.equal(pageErrors.length,0);checks.no_page_errors=true;
  await page.screenshot({path:join(root,'benchmark-local-library.png')});
  phase='cleanup';await api('/api/reference/scrap','DELETE',{ids:createdRows});checks.original_delete_body_contract=true;createdRows.length=0;
  for(const id of createdFolders)await api('/api/scraps/folders?id='+id,'DELETE');createdFolders.length=0;
  const report={checked_at:new Date().toISOString(),authority:'native unpacked extension and retained original client in Chromium; Threads responses replaced by a fixed fixture',
    extension_id:extension.extension_id,checks,page_errors:pageErrors,public_posts_or_original_writes:false,real_threads_collection_tested:false,
    user_chrome_extension_installed:false,fixture_tab_preloaded:true,blocked_external_requests:externalRequests.length};
  await writeFile(join(root,'benchmark-local-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks:Object.keys(checks).length,page_errors:pageErrors.length,public_posts_or_original_writes:false}));
}catch(error){
  await writeFile(join(root,'benchmark-local-verification-failure.json'),JSON.stringify({phase,error_name:error.name,checks,page_errors:pageErrors},null,2)+'\n');
  console.error(JSON.stringify({failed_phase:phase,error_name:error.name}));process.exitCode=1;
}finally{
  if(nonce){for(const id of createdRows)await api('/api/reference/scrap','DELETE',{ids:[id]}).catch(()=>{});for(const id of createdFolders)await api('/api/scraps/folders?id='+id,'DELETE').catch(()=>{})}
  await context?.close();const target=resolve(directory);if(!target.startsWith(resolve(tmpdir())+sep+'dreaths-e2e-'))throw new Error('Invalid test cleanup path');await rm(target,{recursive:true,force:true});
}
