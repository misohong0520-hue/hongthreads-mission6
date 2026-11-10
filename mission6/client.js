(() => {
  const config=window.__REA_REPLAY__;if(!config?.mission6)return;
  // Preserve the retained DRT markup. This adapter only handles navigation;
  // storage, sessions and WIF do not add product menus, panels or notices.
  const baseFetch=window.fetch.bind(window);
  window.fetch=(input,init)=>{
    try{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href),headers=new Headers(init?.headers??input?.headers);
      if(!config.mission6.connected&&headers.has('rsc')&&!url.pathname.startsWith('/workspace')&&/^\/(?:dashboard\/|write$|multi-write$|smart-multi-write$|mypage$|onboarding\/)/.test(url.pathname)&&!headers.has('next-router-prefetch')){url.searchParams.delete('_rsc');location.assign(url.pathname+url.search);return new Promise(()=>{})}
    }catch{}
    return baseFetch(input,init);
  };
})();
