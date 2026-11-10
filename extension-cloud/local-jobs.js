/* Only the local benchmark page can request a read-only Threads collection job. */
(() => {
  const BASE='https://hongthreads.hongsik.blog';
  const jobs=new Map();
  const localPage=url=>{try{return ['https://hongthreads.hongsik.blog','https://hongthreads.hongsik.blog'].includes(new URL(url).origin)}catch{return false}};
  const thread=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
    /(^|\.)threads\.(com|net)$/.test(u.hostname)&&(/\/@[^/]+\/post\/[^/]+/.test(u.pathname)||/^\/t\/[^/]+/.test(u.pathname))?u.href:null}catch{return null}};
  const finish=async(tabId,result)=>{
    const job=jobs.get(tabId);if(!job||job.finishing)return;job.finishing=true;
    clearTimeout(job.timer);
    try{
      const token=await getStoredJwt();
      if(token)await fetch(BASE+'/__local_benchmark/jobs/'+encodeURIComponent(job.id)+'/result',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({success:result?.success===true,scrap_id:result?.data?.id,code:result?.success?'OK':'LOCAL_SCRAP_FAILED'})});
    }catch{}
    finally{jobs.delete(tabId);chrome.tabs.remove(tabId).catch(()=>{})}
  };
  self.__DREATHS_LOCAL_HAS_JOB=tabId=>jobs.has(tabId);
  self.__DREATHS_LOCAL_RESULT=(message,sender,result)=>{
    if(message.action==='SCRAP_THREAD'&&sender.tab?.id!==undefined&&jobs.has(sender.tab.id))void finish(sender.tab.id,result);
  };
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message.action!=='DREATHS_LOCAL_SCRAP_JOB')return;
    const target=thread(message.url);
    if(!localPage(sender.tab?.url)||!target||!/^[-0-9a-f]{36}$/i.test(message.jobId??'')){sendResponse({success:false});return false}
    (async()=>{
      let tabId;
      try{
        const token=await getStoredJwt();if(!token){sendResponse({success:false});return}
        const tab=await chrome.tabs.create({url:target,active:false});tabId=tab.id;
        jobs.set(tabId,{id:message.jobId,timer:setTimeout(()=>void finish(tabId,{success:false}),60000)});
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);reject(new Error('timeout'))},30000);
          const done=()=>{clearTimeout(timeout);chrome.tabs.onUpdated.removeListener(listener);resolve()};
          const listener=(id,change)=>{if(id===tabId&&change.status==='complete')done()};
          chrome.tabs.onUpdated.addListener(listener);chrome.tabs.get(tabId).then(current=>{if(current.status==='complete')done()}).catch(reject);
        });
        const response=await chrome.tabs.sendMessage(tabId,{action:'DREATHS_LOCAL_SCRAP_PAGE',jobId:message.jobId,url:target});
        if(!response?.success)throw new Error('capture_unavailable');
        sendResponse({success:true});
      }catch{if(tabId!==undefined)await finish(tabId,{success:false});sendResponse({success:false})}
    })();return true;
  });
})();
