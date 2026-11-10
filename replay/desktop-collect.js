(() => {
  const query=new URL(location.href).searchParams,jobId=query.get('job'),target=query.get('url');
  const status=document.getElementById('status');
  let sent=false,valid=false;
  try{const u=new URL(target);valid=/^[0-9a-f-]{36}$/i.test(jobId??'')&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)threads\.(com|net)$/.test(u.hostname)&&(/^\/@[^/]+\/post\/[^/]+/.test(u.pathname)||/^\/t\/[^/]+/.test(u.pathname))}catch{}
  if(!valid){status.textContent='유효한 수집 요청이 아닙니다.';return}
  const dispatch=()=>{
    if(sent)return;sent=true;
    window.postMessage({type:'DREATHS_LOCAL_SCRAP_JOB',jobId,url:target},location.origin);
    status.textContent='확장 프로그램이 글을 수집하고 있습니다. 드레쓰 앱으로 돌아가 주세요.';
  };
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    if(event.data?.type==='DREATHS_LOCAL_EXTENSION_READY')dispatch();
    if(event.data?.type==='DREATHS_LOCAL_SCRAP_REJECTED'&&event.data.jobId===jobId)status.textContent='확장 프로그램의 로컬 키와 Threads 로그인 상태를 확인해 주세요.';
  });
  // Content scripts may already have sent their ready message before defer runs.
  // A direct request is safe: the bridge validates both the local sender and URL.
  setTimeout(dispatch,500);
})();
