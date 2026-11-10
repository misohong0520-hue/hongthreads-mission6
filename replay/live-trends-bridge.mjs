const ORIGIN = 'https://drt.agczero.com';
const CORE_PATHS = new Set(['/api/trends/datalab','/api/trends/google','/api/trends/realtime','/api/trends/shortents']);
const SHOPPING_PATHS = new Set(['/api/trends/shopping/categories','/api/trends/shopping/keywords']);
const COOKIE_NAME = /^((?:__Secure-)?(?:next-auth|authjs)\.session-token)(?:\.(0|[1-9]\d*))?$/;
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 15000;
const CACHE_KEYS = 64;
const RESOURCE_PAGES = new Set(['/write','/multi-write','/smart-multi-write','/mypage','/onboarding/coupang','/onboarding/toss',
  ...['insights','benchmark','threads','personas','threads-manage','videos','revenue'].map(page=>'/dashboard/'+page)]);
const RESOURCE_BOOTSTRAP_PATHS = new Set(['/api/auth/session','/api/subscription/status','/api/keys/accounts','/api/keys/status']);
const RESOURCE_HEADER_NAMES = new Set(['accept','rsc','next-router-state-tree','next-router-prefetch','next-url']);
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

const resourceDestination = path => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      Buffer.byteLength(path,'utf8') > 65536 || /[\\\x00-\x20\x7F#]/.test(path)) return null;
  const rawPath = path.split('?',1)[0];
  // Inspect the supplied spelling before URL normalization can erase traversal.
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || /%(?:2e|2f|5c|25)/i.test(rawPath)) return null;
  let target;
  try { decodeURIComponent(rawPath); target=new URL(path,ORIGIN); } catch { return null; }
  if (target.origin !== ORIGIN || target.username || target.password || target.pathname !== rawPath) return null;
  if (RESOURCE_BOOTSTRAP_PATHS.has(target.pathname)) {
    const entries=[...target.searchParams.entries()];
    if (!entries.length) return target;
    return target.pathname === '/api/keys/status' && entries.length === 1 && entries[0][0] === 'provider' &&
      ['AI','COUPANG','TOSS','THREADS','WDRB'].includes(entries[0][1]) ? target : null;
  }
  const staticAsset = target.pathname.startsWith('/_next/static/') && /\.(?:js|css|woff2?|ttf|otf|eot)$/i.test(target.pathname);
  return RESOURCE_PAGES.has(target.pathname) || staticAsset ? target : null;
};

const resourceHeaders = headers => {
  if (!headers || typeof headers !== 'object') return null;
  const output = {accept:'text/html,application/xhtml+xml,*/*;q=0.8'};
  let bytes=0;
  try {
    const entries=headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
    for (const [key,value] of entries) {
      const name=key.toLowerCase();
      if (!RESOURCE_HEADER_NAMES.has(name)) continue;
      if (typeof value !== 'string' || /[\x00-\x1F\x7F]/.test(value)) return null;
      bytes+=Buffer.byteLength(name+value,'utf8');
      if (bytes > 32768) return null;
      output[name]=value;
    }
  } catch { return null; }
  return output;
};

export const matchesLiveTrendRoute = url => url instanceof URL && (CORE_PATHS.has(url.pathname) || SHOPPING_PATHS.has(url.pathname));

const destination = local => {
  if (!matchesLiveTrendRoute(local)) return {error:'unsupported_trend_route',status:404};
  if (local.search.length > 8192) return {error:'invalid_trend_request',status:400};
  const params = new URLSearchParams(local.search);
  params.delete('_rsc');
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) return {error:'invalid_trend_request',status:400};
  const target = new URL(local.pathname,ORIGIN);
  if (CORE_PATHS.has(local.pathname))
    return names.length ? {error:'invalid_trend_request',status:400} : {target};
  if (names.some(name => !['type','category1','category2','category3'].includes(name)) ||
      !['ISSUE','POPULAR','NEW'].includes(params.get('type')))
    return {error:'invalid_trend_request',status:400};
  for (const name of ['type','category1','category2','category3']) {
    if (!params.has(name)) continue;
    const value = params.get(name);
    if (!value || value.length > 256 || /[\x00-\x1F\x7F]/.test(value))
      return {error:'invalid_trend_request',status:400};
    target.searchParams.set(name,value);
  }
  return {target};
};

const sessionHeader = ({cookieName='next-auth.session-token',cookieValue} = {}) => {
  if (typeof cookieName !== 'string' || !COOKIE_NAME.test(cookieName) || typeof cookieValue !== 'string' ||
      !cookieValue || Buffer.byteLength(cookieValue,'utf8') > 32768 || /[\x00-\x1F\x7F]/.test(cookieValue))
    throw new Error('invalid_session_cookie');
  const prefixed = /^(?:cookie|set-cookie)\s*:/i.test(cookieValue);
  const input = cookieValue.replace(/^(?:cookie|set-cookie)\s*:\s*/i,'');
  const cookies = [];
  for (const segment of input.split(';')) {
    const text = segment.trimStart();
    const equals = text.indexOf('=');
    if (equals < 0) continue;
    const name = text.slice(0,equals);
    const match = COOKIE_NAME.exec(name);
    if (!match) {
      if (/^(?:__Secure-)?(?:next-auth|authjs)\.session-token/.test(name)) throw new Error('invalid_session_cookie');
      continue;
    }
    cookies.push({name,value:text.slice(equals+1),base:match[1],chunk:match[2] === undefined ? null : Number(match[2])});
  }
  if (!cookies.length) {
    if (prefixed || input.includes(';')) throw new Error('invalid_session_cookie');
    const match = COOKIE_NAME.exec(cookieName);
    cookies.push({name:cookieName,value:input,base:match[1],chunk:match[2] === undefined ? null : Number(match[2])});
  }
  if (cookies.length > 32 || new Set(cookies.map(cookie=>cookie.base)).size !== 1 ||
      new Set(cookies.map(cookie=>cookie.name)).size !== cookies.length ||
      cookies.some(cookie=>!COOKIE_OCTETS.test(cookie.value))) throw new Error('invalid_session_cookie');
  if (cookies.some(cookie=>cookie.chunk === null)) {
    if (cookies.length !== 1) throw new Error('invalid_session_cookie');
  } else {
    cookies.sort((a,b)=>a.chunk-b.chunk);
    if (cookies.some((cookie,index)=>cookie.chunk !== index)) throw new Error('invalid_session_cookie');
  }
  return cookies.map(cookie=>cookie.name+'='+cookie.value).join('; ');
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item=>typeof item === 'string');
const validSchema = (path,data) => {
  if (!object(data)) return false;
  if (path === '/api/trends/google') return Array.isArray(data.google) && data.google.every(item=>object(item)&&typeof item.keyword==='string');
  if (path === '/api/trends/datalab') return Array.isArray(data.datalab) && data.datalab.every(item=>object(item)&&typeof item.categoryName==='string'&&strings(item.keywords));
  if (path === '/api/trends/realtime') return strings(data.keywords) && Array.isArray(data.news) && data.news.every(item=>object(item)&&typeof item.title==='string'&&typeof item.url==='string');
  if (path === '/api/trends/shortents') return object(data.shortents) && Object.values(data.shortents).every(items=>Array.isArray(items)&&items.every(item=>object(item)&&typeof item.title==='string'));
  if (path === '/api/trends/shopping/categories') return strings(data.categories);
  if (path === '/api/trends/shopping/keywords') return Array.isArray(data.keywords) && data.keywords.every(item=>object(item)&&typeof item.keyword==='string');
  return false;
};

const errorResponse = (status,error) => ({status,body:Buffer.from(JSON.stringify({error})),headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
  'x-rea-body-representation':'live-api-error'
}});
const copyResponse = (response,cache) => ({status:response.status,body:Buffer.from(response.body),headers:{...response.headers,...(cache?{'x-rea-live-cache':cache}:{})}});

export class LiveTrendsBridge {
  #fetch;
  #now;
  #cookie = null;
  #generation = 0;
  #state = 'awaiting-session';
  #lastSuccessAt = null;
  #lastError = null;
  #lastStatus = null;
  #cache = new Map();
  #inflight = new Map();
  #controllers = new Set();

  constructor({fetchImpl=globalThis.fetch,now=Date.now}={}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Invalid bridge dependencies');
    this.#fetch=fetchImpl;
    this.#now=now;
  }

  status() {
    return {enabled:true,configured:Boolean(this.#cookie),state:this.#state,lastSuccessAt:this.#lastSuccessAt,
      lastError:this.#lastError,lastStatus:this.#lastStatus,refreshSeconds:60};
  }

  match(url) { return matchesLiveTrendRoute(url); }

  /** Authenticated read-only acquisition of the original editor documents/assets. */
  async readOriginalResource({path,headers={}}={}) {
    const target=resourceDestination(path);
    const forwarded=resourceHeaders(headers);
    if (!target || !forwarded) return errorResponse(400,'invalid_original_resource_request');
    if (!this.#cookie) {
      if (this.#state === 'session-expired') return errorResponse(401,'session_expired');
      if (this.#state === 'access-denied') return errorResponse(403,'access_denied');
      return errorResponse(503,'session_required');
    }
    const generation=this.#generation;
    const changed=()=>generation !== this.#generation;
    const controller=new AbortController();
    this.#controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await this.#fetch(target.href,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',
        headers:{...forwarded,cookie:this.#cookie,referer:ORIGIN+'/dashboard/insights'},signal:controller.signal});
      if (changed()) return errorResponse(409,'session_changed');
      if (response.status === 401) {
        this.clear();
        return this.#failure(401,'session_expired','session-expired');
      }
      if (response.status === 403) return this.#failure(403,'access_denied','access-denied');
      const outgoing={'cache-control':'no-store','x-content-type-options':'nosniff','x-rea-body-representation':'live-original-resource'};
      for (const name of ['content-type','content-language','vary']) {
        const value=response.headers.get(name);
        if (value && value.length <= 1024 && !/[\x00-\x1F\x7F]/.test(value)) outgoing[name]=value;
      }
      outgoing['content-type'] ??= 'application/octet-stream';
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location=response.headers.get('location');
        let redirect;
        try {
          if (!location || location.length > 65536 || /[\x00-\x1F\x7F]/.test(location)) throw new Error();
          redirect=new URL(location,target);
          if (redirect.origin !== ORIGIN || redirect.username || redirect.password) throw new Error();
        } catch { return this.#failure(502,'upstream_resource_redirect_rejected','upstream-error'); }
        outgoing.location=redirect.pathname+redirect.search+redirect.hash;
      }
      const declared=response.headers.get('content-length');
      if (declared && Number(declared) > MAX_RESOURCE_BYTES)
        return this.#failure(502,'upstream_resource_too_large','upstream-error');
      const chunks=[];
      let size=0;
      const reader=response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const {done,value}=await reader.read();
            if (changed()) return errorResponse(409,'session_changed');
            if (done) break;
            size+=value.byteLength;
            if (size > MAX_RESOURCE_BYTES) return this.#failure(502,'upstream_resource_too_large','upstream-error');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(()=>{}); }
      }
      if (changed()) return errorResponse(409,'session_changed');
      return {status:response.status,body:Buffer.concat(chunks),headers:outgoing};
    } catch {
      if (changed()) return errorResponse(409,'session_changed');
      return this.#failure(502,controller.signal.aborted?'upstream_resource_timeout':'upstream_resource_unavailable','upstream-error');
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.#controllers.delete(controller);
    }
  }

  /** Forward source-observed workflow calls; the HTTP caller enforces local CSRF. */
  async forwardOriginalRequest({path,method='GET',headers={},body=Buffer.alloc(0)}={}) {
    const {resolveWorkflowRequest,affiliateKeyBodyAllowed}=await import('./workflow-policy.mjs');
    const resolved=resolveWorkflowRequest(path,method);
    if(!resolved)return errorResponse(400,'workflow_request_not_allowed');
    if(!Buffer.isBuffer(body))return errorResponse(400,'workflow_body_must_be_buffer');
    if(!affiliateKeyBodyAllowed(resolved.target.pathname,body))return errorResponse(400,'invalid_affiliate_key_input');
    if(resolved.target.pathname==='/api/keys/extension'&&body.length)return errorResponse(400,'extension_key_body_must_be_empty');
    const limit=64*1024*1024;
    if(body.length>limit)return errorResponse(413,'workflow_body_too_large');
    if(resolved.method==='GET'&&body.length)return errorResponse(400,'workflow_get_body_rejected');
    const forwarded=resourceHeaders(headers);
    if(!forwarded)return errorResponse(400,'invalid_workflow_headers');
    try{
      const entries=headers instanceof Headers?[...headers.entries()]:Object.entries(headers);
      const contentTypes=entries.filter(([name])=>name.toLowerCase()==='content-type');
      if(contentTypes.length>1)return errorResponse(400,'invalid_workflow_headers');
      if(contentTypes.length){
        const value=contentTypes[0][1];
        if(typeof value!=='string'||value.length>1024||/[\x00-\x1F\x7F]/.test(value))return errorResponse(400,'invalid_workflow_headers');
        forwarded['content-type']=value;
      }
      for(const [name,value]of entries){
        const lower=name.toLowerCase();if(!['range','if-range'].includes(lower))continue;
        if(typeof value!=='string'||value.length>1024||/[\x00-\x1F\x7F]/.test(value))return errorResponse(400,'invalid_workflow_headers');
        if(lower==='range'&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(value))return errorResponse(400,'invalid_workflow_range');
        forwarded[lower]=value;
      }
    }catch{return errorResponse(400,'invalid_workflow_headers');}
    if(!this.#cookie){
      if(this.#state==='session-expired')return errorResponse(401,'session_expired');
      if(this.#state==='access-denied')return errorResponse(403,'access_denied');
      return errorResponse(503,'session_required');
    }
    const generation=this.#generation;
    const changed=()=>generation!==this.#generation;
    const controller=new AbortController();this.#controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),180000);
    let streamOwned=false;
    const cleanup=()=>{clearTimeout(timer);controller.abort();this.#controllers.delete(controller)};
    try{
      const response=await this.#fetch(resolved.target.href,{method:resolved.method,redirect:'manual',credentials:'omit',cache:'no-store',
        headers:{...forwarded,cookie:this.#cookie,origin:ORIGIN,referer:ORIGIN+'/write'},
        ...(resolved.method==='GET'?{}:{body}),signal:controller.signal});
      if(changed())return errorResponse(409,'session_changed');
      if(response.status===401){
        this.clear();
        return this.#failure(401,'session_expired','session-expired');
      }
      if(response.status>=300&&response.status<400){
        this.clear();
        return this.#failure(502,'upstream_workflow_redirect_rejected','upstream-error');
      }
      const outgoing={'cache-control':'no-store','x-content-type-options':'nosniff','x-rea-body-representation':'live-original-workflow'};
      for(const name of ['content-type','content-language','content-disposition','vary','content-range','accept-ranges','etag','last-modified']){
        const value=response.headers.get(name);
        if(value&&value.length<=2048&&!/[\x00-\x1F\x7F]/.test(value))outgoing[name]=value;
      }
      outgoing['content-type']??='application/octet-stream';
      const declared=response.headers.get('content-length');
      if(declared&&Number(declared)>limit)return this.#failure(502,'upstream_workflow_body_too_large','upstream-error');
      if(/^text\/event-stream(?:\s*;|$)/i.test(outgoing['content-type'])&&response.body){
        const reader=response.body.getReader();let size=0,finished=false;
        const finish=async()=>{
          if(finished)return;finished=true;
          cleanup();await reader.cancel().catch(()=>{});
        };
        const stream=new ReadableStream({
          pull:async output=>{
            try{
              const {done,value}=await reader.read();
              if(changed())throw new Error('session_changed');
              if(done){output.close();await finish();return}
              size+=value.byteLength;
              if(size>limit)throw new Error('upstream_workflow_body_too_large');
              output.enqueue(value);
            }catch(error){
              const code=changed()?'session_changed':controller.signal.aborted?'upstream_workflow_timeout':
                error.message==='upstream_workflow_body_too_large'?'upstream_workflow_body_too_large':'upstream_workflow_unavailable';
              if(!changed())this.#failure(502,code,'upstream-error');
              output.error(new Error(code));await finish();
            }
          },
          cancel:finish
        });
        streamOwned=true;
        return {status:response.status,stream,headers:outgoing};
      }
      const chunks=[];let size=0;
      const reader=response.body?.getReader();
      if(reader){
        try{
          while(true){
            const {done,value}=await reader.read();
            if(changed())return errorResponse(409,'session_changed');
            if(done)break;
            size+=value.byteLength;
            if(size>limit)return this.#failure(502,'upstream_workflow_body_too_large','upstream-error');
            chunks.push(Buffer.from(value));
          }
        }finally{await reader.cancel().catch(()=>{});}
      }
      if(changed())return errorResponse(409,'session_changed');
      return {status:response.status,body:Buffer.concat(chunks),headers:outgoing};
    }catch{
      if(changed())return errorResponse(409,'session_changed');
      return this.#failure(502,controller.signal.aborted?'upstream_workflow_timeout':'upstream_workflow_unavailable','upstream-error');
    }finally{
      if(!streamOwned)cleanup();
    }
  }

  clear() {
    this.#generation++;
    this.#cookie=null;
    this.#cache.clear();
    this.#inflight.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#state='awaiting-session';
    this.#lastSuccessAt=null;
    this.#lastError=null;
    this.#lastStatus=null;
  }

  async configure(input) {
    this.clear();
    const generation=this.#generation;
    let cookie;
    try { cookie=sessionHeader(input); }
    catch {
      this.#lastError='invalid_session_cookie';
      this.#lastStatus=400;
      return {status:400,body:{error:'invalid_session_cookie',...this.status()}};
    }
    this.#state='connecting';
    const target=new URL('/api/trends/google',ORIGIN);
    const response=await this.#perform(target,cookie,generation);
    if (response.status !== 200)
      return {status:response.status,body:{...JSON.parse(response.body),...this.status()}};
    if (generation !== this.#generation) return {status:409,body:{error:'session_changed',...this.status()}};
    this.#cookie=cookie;
    this.#remember(target.href,response,generation);
    return {status:200,body:this.status()};
  }

  async request(local) {
    const parsed=destination(local);
    if (parsed.error) return errorResponse(parsed.status,parsed.error);
    if (!this.#cookie) {
      if (this.#state === 'session-expired') return errorResponse(401,'session_expired');
      if (this.#state === 'access-denied') return errorResponse(403,'access_denied');
      return errorResponse(503,'session_required');
    }
    const target=parsed.target;
    const generation=this.#generation;
    for (const [key,value] of this.#cache) if (value.expiresAt <= this.#now()) this.#cache.delete(key);
    const cached=this.#cache.get(target.href);
    if (cached?.generation === generation) {
      this.#cache.delete(target.href);
      this.#cache.set(target.href,cached);
      return copyResponse(cached.response,'hit');
    }
    const existing=this.#inflight.get(target.href);
    if (existing) {
      const response=await existing;
      return generation !== this.#generation && response.status === 200
        ? errorResponse(409,'session_changed') : copyResponse(response,'coalesced');
    }
    const pending=this.#perform(target,this.#cookie,generation);
    this.#inflight.set(target.href,pending);
    try {
      const response=await pending;
      if (response.status === 200 && generation !== this.#generation) return errorResponse(409,'session_changed');
      if (response.status === 200 && generation === this.#generation) this.#remember(target.href,response,generation);
      return copyResponse(response,'miss');
    } finally {
      if (this.#inflight.get(target.href) === pending) this.#inflight.delete(target.href);
    }
  }

  #remember(key,response,generation) {
    this.#cache.delete(key);
    this.#cache.set(key,{response:copyResponse(response),generation,expiresAt:this.#now()+CACHE_MS});
    while (this.#cache.size > CACHE_KEYS) this.#cache.delete(this.#cache.keys().next().value);
  }

  #failure(status,error,state) {
    this.#state=state;
    this.#lastStatus=status;
    this.#lastError=error;
    return errorResponse(status,error);
  }

  async #perform(target,cookie,generation) {
    const controller=new AbortController();
    this.#controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),15000);
    const changed=()=>generation !== this.#generation;
    try {
      const response=await this.#fetch(target.href,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',
        headers:{accept:'application/json',cookie},signal:controller.signal});
      if (changed()) return errorResponse(409,'session_changed');
      if (response.status === 401) {
        this.clear();
        return this.#failure(401,'session_expired','session-expired');
      }
      if (response.status === 403) {
        return this.#failure(403,'access_denied','access-denied');
      }
      if (response.status >= 300 && response.status < 400)
        return this.#failure(502,'upstream_redirect_rejected','upstream-error');
      if (response.status !== 200)
        return this.#failure(502,'upstream_http_error','upstream-error');
      const type=response.headers.get('content-type') ?? '';
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(type) || type.length > 128 || /[\r\n]/.test(type))
        return this.#failure(502,'upstream_invalid_json','upstream-error');
      const declared=response.headers.get('content-length');
      if (declared && Number(declared) > MAX_BYTES)
        return this.#failure(502,'upstream_body_too_large','upstream-error');
      const chunks=[];
      let size=0;
      const reader=response.body?.getReader();
      if (!reader) return this.#failure(502,'upstream_invalid_json','upstream-error');
      try {
        while (true) {
          const {done,value}=await reader.read();
          if (changed()) return errorResponse(409,'session_changed');
          if (done) break;
          size+=value.byteLength;
          if (size > MAX_BYTES) return this.#failure(502,'upstream_body_too_large','upstream-error');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(()=>{});
      }
      if (changed()) return errorResponse(409,'session_changed');
      const bytes=Buffer.concat(chunks);
      let data;
      try { data=JSON.parse(bytes.toString('utf8')); } catch { return this.#failure(502,'upstream_invalid_json','upstream-error'); }
      if (!validSchema(target.pathname,data)) return this.#failure(502,'upstream_schema_mismatch','upstream-error');
      this.#state='connected';
      this.#lastStatus=200;
      this.#lastError=null;
      this.#lastSuccessAt=new Date(this.#now()).toISOString();
      return {status:200,body:bytes,headers:{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',
        'x-rea-body-representation':'live-original-api'}};
    } catch {
      if (changed()) return errorResponse(409,'session_changed');
      return this.#failure(502,controller.signal.aborted?'upstream_timeout':'upstream_unavailable','upstream-error');
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.#controllers.delete(controller);
    }
  }
}
