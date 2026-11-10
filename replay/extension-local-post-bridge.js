(() => {
  const nativeAlert=window.alert.bind(window);
  window.alert=(...args)=>{if(!window.__DREATHS_LOCAL_AUTOSCRAP__)return nativeAlert(...args)};
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message.action!=='DREATHS_LOCAL_SCRAP_PAGE')return;
    (async()=>{
      try{
        const target=new URL(message.url);
        const post=url=>url.pathname.match(/^\/@[^/]+\/post\/([^/]+)(?:\/|$)|^\/t\/([^/]+)(?:\/|$)/)?.slice(1).find(Boolean);
        const threads=url=>url.protocol==='https:'&&/(^|\.)threads\.(com|net)$/.test(url.hostname);
        if(!threads(target)||!threads(location)||!post(target)||post(target)!==post(location))throw new Error('post');
        window.__DREATHS_LOCAL_AUTOSCRAP__=true;
        for(let attempt=0;attempt<80;attempt++){
          const button=document.getElementById('dreaths-scrap-btn');
          const link=Array.from(document.querySelectorAll('a[href*="/post/"], a[href*="/t/"]')).find(anchor=>{
            try{
              const candidate=new URL(anchor.getAttribute('href'),location.href);
              return threads(candidate)&&post(candidate)===post(target)&&typeof findOriginalPostContainer==='function'&&findOriginalPostContainer(anchor);
            }catch{return false}
          });
          if(button&&!button.disabled&&link&&document.readyState==='complete'){
            await new Promise(resolve=>setTimeout(resolve,1800));
            if(!link.isConnected)continue;
            // The original button starts selection mode. Its document handler
            // then selects the matching post and calls the original extractor.
            button.click();
            if(button.dataset.inSelection!=='true')throw new Error('selection');
            link.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true}));
            link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
            if(button.dataset.inSelection!=='false')throw new Error('selection');
            sendResponse({success:true});return;
          }
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        throw new Error('post_unavailable');
      }catch{
        window.__DREATHS_LOCAL_AUTOSCRAP__=false;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        sendResponse({success:false});
      }
    })();return true;
  });
})();
