(() => {
  const config=window.__REA_REPLAY__;if(!config?.mission6)return;
  const install=()=>{
    const aside=document.querySelector('aside');if(!aside||aside.querySelector('#hongthreads-workspace'))return;
    const nav=document.createElement('div');nav.id='hongthreads-workspace';nav.style.cssText='display:flex;gap:8px;flex-wrap:wrap;padding:10px 20px;border-top:1px solid #e5e7eb;background:#fff;flex-shrink:0;font-size:12px;font-weight:700';
    for(const [href,label]of [['/workspace/benchmarks','자료 관리'],['/workspace/connect',config.mission6.connected?'계정 연결 관리':'원본 계정 연결']]){const a=document.createElement('a');a.href=href;a.textContent=label;a.style.cssText='padding:7px 10px;border:1px solid #dce7df;border-radius:8px;color:#126439;text-decoration:none';nav.append(a)}aside.append(nav);
    if(!config.mission6.connected&&!document.getElementById('hongthreads-connect-notice')){
      const notice=document.createElement('a');notice.id='hongthreads-connect-notice';notice.href='/workspace/connect';notice.textContent='원본 계정을 연결하면 기존 자료와 기능을 사용할 수 있습니다.';notice.style.cssText='position:fixed;bottom:18px;right:18px;z-index:1000;max-width:min(420px,calc(100vw - 36px));background:white;border:1px solid #cde4d4;box-shadow:0 4px 18px #0001;border-radius:12px;padding:14px 18px;color:#126439;font:600 13px/1.6 system-ui;text-decoration:none';document.body.append(notice);
    }
  };
  const baseFetch=window.fetch.bind(window);
  window.fetch=(input,init)=>{
    try{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href),headers=new Headers(init?.headers??input?.headers);
      if(!config.mission6.connected&&headers.has('rsc')&&!url.pathname.startsWith('/workspace')&&/^\/(?:dashboard\/|write$|multi-write$|smart-multi-write$|mypage$|onboarding\/)/.test(url.pathname)&&!headers.has('next-router-prefetch')){url.searchParams.delete('_rsc');location.assign(url.pathname+url.search);return new Promise(()=>{})}
    }catch{}
    return baseFetch(input,init);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
  new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});
})();
