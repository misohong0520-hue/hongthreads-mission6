(() => {
  if(!['http://127.0.0.1:9248','http://localhost:9248'].includes(location.origin))return;
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.type!=='DREATHS_LOCAL_SCRAP_JOB')return;
    if(!/^[-0-9a-f]{36}$/i.test(event.data.jobId??''))return;
    const jobId=event.data.jobId;
    chrome.runtime.sendMessage({action:'DREATHS_LOCAL_SCRAP_JOB',jobId,url:event.data.url},response=>{
      if(chrome.runtime.lastError||!response?.success)window.postMessage({type:'DREATHS_LOCAL_SCRAP_REJECTED',jobId},location.origin);
    });
  });
  window.postMessage({type:'DREATHS_LOCAL_EXTENSION_READY'},location.origin);
})();
