/* Generic HTTP destination relocation only. Original application scripts are unchanged. */
(() => {
  const config = window.__REA_REPLAY__;
  const nativeFetch = window.fetch.bind(window);
  const encode = value => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const map = value => {
    if (value == null || value === '') return value;
    let u;
    try { u = new URL(String(value), location.href); } catch { return value; }
    if (!['http:', 'https:'].includes(u.protocol) || u.origin === location.origin) return value;
    if(config.originalWorkflows&&u.protocol==='https:'&&
      (u.hostname.endsWith('.amazonaws.com')||u.hostname==='cdn.agczero.com'))return value;
    const prefix = u.origin === config.primaryOrigin ? '' : '/__origin/' + encode(u.origin);
    return prefix + u.pathname + u.search + u.hash;
  };
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = map(request.url);
    const destination=new URL(url,location.href);
    const headers=new Headers(request.headers);
    if(config.originalWorkflows&&destination.origin===location.origin&&
      (destination.pathname.startsWith('/api/')||destination.pathname==='/__vertex/generate'))
      headers.set('X-Rea-Workflow-Token',config.workflowToken);
    if (url === request.url) return nativeFetch(new Request(request,{headers}));
    const body = ['GET','HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer();
    return nativeFetch(url, {
      method: request.method, headers, body, signal: request.signal,
      mode: 'same-origin', credentials: 'same-origin', cache: request.cache,
      redirect: request.redirect, referrerPolicy: request.referrerPolicy,
      integrity: request.integrity, keepalive: request.keepalive
    });
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const destination=new URL(map(url),location.href);
    this.__reaWorkflow=config.originalWorkflows&&destination.origin===location.origin&&destination.pathname.startsWith('/api/');
    return open.call(this, method, destination.href, ...args);
  };
  XMLHttpRequest.prototype.send=function(...args){
    if(this.__reaWorkflow)this.setRequestHeader('X-Rea-Workflow-Token',config.workflowToken);
    return send.apply(this,args);
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(map(url), data);
  }
  const mapSrcset = value => String(value).split(',').map(part => {
    const trimmed = part.trim(); const split = trimmed.search(/\s/);
    return split < 0 ? map(trimmed) : map(trimmed.slice(0, split)) + trimmed.slice(split);
  }).join(', ');
  const attr = Element.prototype.setAttribute;
  const mapAsset=value=>{
    if(config.originalWorkflows){try{if(new URL(String(value),location.href).origin!==config.primaryOrigin)return value}catch{}}
    return map(value);
  };
  Element.prototype.setAttribute = function(name, value) {
    const key = String(name).toLowerCase();
    return attr.call(this, name, ['src','href','action','poster'].includes(key) ? mapAsset(value) :
      key === 'srcset' && !String(value).includes('data:') ? mapSrcset(value) : value);
  };
  for (const [constructor, properties] of [
    [HTMLImageElement,['src','srcset']], [HTMLScriptElement,['src']], [HTMLLinkElement,['href']],
    [HTMLIFrameElement,['src']], [HTMLSourceElement,['src','srcset']], [HTMLVideoElement,['src','poster']],
    [HTMLAudioElement,['src']], [HTMLFormElement,['action']]
  ]) {
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, property);
      if (!descriptor?.set || !descriptor.configurable) continue;
      Object.defineProperty(constructor.prototype, property, {
        ...descriptor, set(value) { descriptor.set.call(this, property === 'srcset' && !String(value).includes('data:') ? mapSrcset(value) : mapAsset(value)); }
      });
    }
  }
  window.__REA_REPLAY__.relocation = 'HTTP destination mapping only; no fabricated response values';
})();
