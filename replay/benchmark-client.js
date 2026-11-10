/* Connection plumbing for the original UI. Status details go only to local logs. */
(() => {
  if(!window.__REA_REPLAY__?.benchmarkLive)return;
  const baseFetch=window.fetch.bind(window);
  const fixtureNavigationPages=new Set(['/write','/multi-write','/smart-multi-write','/mypage','/onboarding/coupang','/onboarding/toss',
    '/dashboard/insights','/dashboard/benchmark','/dashboard/threads','/dashboard/threads-manage','/dashboard/personas','/dashboard/videos','/dashboard/revenue']);
  let keyInFlight=null,lastRefresh=0,extensionReady=false;
  const pendingJobs=new Map();
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    if(event.data?.type==='DREATHS_LOCAL_EXTENSION_READY')extensionReady=true;
    if(event.data?.type==='DREATHS_LOCAL_SCRAP_REJECTED'&&pendingJobs.has(event.data.jobId))pendingJobs.set(event.data.jobId,true);
  });
  const classify=(status,data={})=>{
    if(status===401)return 'SESSION_EXPIRED';
    if(status===403)return /premium|subscription|구독|유료/i.test(String(data.error||'')+' '+String(data.message||''))?'SUBSCRIPTION_REQUIRED':'ACCESS_DENIED';
    if(status===429)return 'RATE_LIMITED';
    if(status===503&&data.error==='session_required')return 'SESSION_REQUIRED';
    return status>=500?'UPSTREAM_ERROR':'REQUEST_FAILED';
  };
  const trace=(event,code='OK',status)=>{
    const payload={event,code,...(Number.isInteger(status)?{status}:{})};
    // No token, URL, body, account identity, or provider message is logged.
    void baseFetch('/__workflow/benchmark-log',{method:'POST',headers:{'Content-Type':'application/json',
      'X-Rea-Workflow-Token':window.__REA_REPLAY__.workflowToken},body:JSON.stringify(payload),keepalive:true})
      .catch(()=>console.debug('REA_BENCHMARK',payload));
  };
  const issueKey=(setBusy,receive,rotate=false)=>{
    if(keyInFlight){trace('key_request_merged');return keyInFlight}
    setBusy(true);trace('key_start');
    keyInFlight=(async()=>{
      try{
        const response=await baseFetch('/api/keys/extension',{method:'POST',...(rotate&&window.__REA_REPLAY__.benchmarkLocal?{headers:{'X-Rea-Local-Key-Rotate':'1'}}:{})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok){trace('key_failure',classify(response.status,data),response.status);return false}
        if(typeof data.token!=='string'||!data.token.trim()||data.token.length>32768){trace('key_failure','INVALID_RESPONSE',response.status);return false}
        receive(data.token);trace('key_success','OK',response.status);return true;
      }catch(error){trace('key_failure',error instanceof TypeError?'NETWORK_ERROR':
        ['QuotaExceededError','SecurityError'].includes(error.name)?'LOCAL_STORAGE_ERROR':'CLIENT_ERROR');return false}
      finally{setBusy(false);keyInFlight=null}
    })();return keyInFlight;
  };
  const openLocalKey=async(setBusy,receive,cached)=>{
    setBusy(true);
    if(cached){
      try{
        const response=await baseFetch('/__local_benchmark/key-check',{headers:{Authorization:'Bearer '+cached},cache:'no-store'});
        if(response.ok){receive(cached);trace('key_reused');setBusy(false);return true}
      }catch{}
    }
    return issueKey(setBusy,receive);
  };
  const collectUrl=async job=>{
    if(!extensionReady&&!window.dreathsDesktop){trace('url_scrap_failure','CLIENT_ERROR');return new Response('{"error":"LOCAL_EXTENSION_REQUIRED"}',{status:503,headers:{'Content-Type':'application/json'}})}
    pendingJobs.set(job.job_id,false);
    try{
    if(window.dreathsDesktop)await window.dreathsDesktop.collect({jobId:job.job_id,url:job.url});
    else window.postMessage({type:'DREATHS_LOCAL_SCRAP_JOB',jobId:job.job_id,url:job.url},location.origin);
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,500));
      if(pendingJobs.get(job.job_id))return new Response('{"error":"LOCAL_SCRAP_FAILED"}',{status:502,headers:{'Content-Type':'application/json'}});
      const response=await baseFetch('/__local_benchmark/jobs/'+encodeURIComponent(job.job_id),{headers:{'X-Rea-Workflow-Token':window.__REA_REPLAY__.workflowToken},cache:'no-store'});
      if(!response.ok)return response;
      const result=await response.json();
      if(result.state==='complete')return new Response(JSON.stringify(result.data),{status:200,headers:{'Content-Type':'application/json'}});
      if(result.state==='failed')return new Response('{"error":"LOCAL_SCRAP_FAILED"}',{status:502,headers:{'Content-Type':'application/json'}});
    }
    return new Response('{"error":"LOCAL_SCRAP_TIMEOUT"}',{status:504,headers:{'Content-Type':'application/json'}});
    }finally{pendingJobs.delete(job.job_id)}
  };
  const copyKey=async token=>{
    try{if(window.dreathsDesktop)await window.dreathsDesktop.copyKey(token);else await navigator.clipboard.writeText(token);trace('copy_success');return true}
    catch{trace('copy_failure','CLIPBOARD_DENIED');return false}
  };
  window.fetch=async(input,init)=>{
    let observed=false;try{
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href),headers=new Headers(init?.headers??(typeof input==='object'?input.headers:undefined));
      const localFixtureNavigation=window.__REA_REPLAY__.threadsAuthFixture&&fixtureNavigationPages.has(url.pathname);
      const benchmarkNavigation=window.__REA_REPLAY__.benchmarkLocal&&url.pathname==='/dashboard/benchmark';
      if((localFixtureNavigation||benchmarkNavigation)&&headers.has('rsc')&&!headers.has('next-router-prefetch')&&headers.get('purpose')!=='prefetch'){
        url.searchParams.delete('_rsc');location.assign(url.pathname+url.search);return new Promise(()=>{});
      }
      observed=url.pathname==='/api/scraps/by-url';
    }catch{}
    try{
      let response=await baseFetch(input,init);
      if(observed&&window.__REA_REPLAY__.benchmarkLocal&&response.status===202){const job=await response.clone().json();if(job.local_job)response=await collectUrl(job)}
      if(observed){
        if(response.ok)trace('url_scrap_success','OK',response.status);
        else void response.clone().json().catch(()=>({})).then(data=>trace('url_scrap_failure',classify(response.status,data),response.status));
      }
      return response;
    }catch(error){if(observed)trace('url_scrap_failure','NETWORK_ERROR');throw error}
  };
  const refresh=()=>{
    if(location.pathname!=='/dashboard/benchmark'||document.hidden||Date.now()-lastRefresh<2000)return;
    lastRefresh=Date.now();window.dispatchEvent(new Event('rea:refresh-benchmark'));trace('refresh_requested');
  };
  window.__REA_BENCHMARK__=Object.freeze({trace,issueKey,openLocalKey,copyKey});
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
  setInterval(refresh,30000);
})();
