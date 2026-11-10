import { createServer } from 'node:http';
import { createHash,randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {homedir} from 'node:os';
import {runtimeIdentity} from './desktop-contract.mjs';

const root = dirname(fileURLToPath(import.meta.url));
// Packaged resources are read-only; generated documents and logs live in user data.
const runtimeRoot = process.env.DREATHS_RUNTIME_DIR ? resolve(process.env.DREATHS_RUNTIME_DIR) : root;
await mkdir(runtimeRoot,{recursive:true});
const host = '127.0.0.1';
const development = process.argv.includes('--dev');
const brandingLogo=development?await readFile(join(root,'../development/branding/h-logo.png')):null;
const liveTrends = process.argv.includes('--live-trends');
const originalWorkflows = process.argv.includes('--original-workflows');
const vertexWif = process.argv.includes('--vertex-wif');
const localBenchmarkEnabled=process.argv.includes('--local-benchmark');
const threadsAuthFixture=process.argv.includes('--threads-auth-fixture');
if (liveTrends && !development) throw new Error('--live-trends requires --dev.');
if(originalWorkflows&&!liveTrends)throw new Error('--original-workflows requires --dev --live-trends.');
if(vertexWif&&!originalWorkflows)throw new Error('--vertex-wif requires --original-workflows.');
if(localBenchmarkEnabled&&!originalWorkflows)throw new Error('--local-benchmark requires --original-workflows.');
if(threadsAuthFixture&&!originalWorkflows)throw new Error('--threads-auth-fixture requires --original-workflows.');
const liveBridge = liveTrends ? new (await import('./live-trends-bridge.mjs')).LiveTrendsBridge() : null;
const vertexBridge=vertexWif?new (await import('./vertex-wif-bridge.mjs')).VertexWifBridge():null;
if(vertexBridge){try{await vertexBridge.authenticate()}catch(error){if(!localBenchmarkEnabled)throw error;console.error('VERTEX_STARTUP_UNAVAILABLE',error.code??'VERTEX_AUTH')}}
const workflowToken=randomBytes(32).toString('hex');
const setupToken = randomBytes(32).toString('hex');
const sessionRoutes = liveTrends ? await (await import('./session-routes.mjs')).createSessionRoutes({bridge:liveBridge,setupToken}) : null;
const liveClient = liveTrends ? await readFile(join(root,'live-client.js')) : null;
const benchmarkClient=originalWorkflows?await readFile(join(root,'benchmark-client.js')):null;
const port = Number(process.env.PORT ?? (development ? 9248 : 9247));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local replay port.');
const localOrigin = 'http://' + host + ':' + port;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyHash = hash(Buffer.alloc(0));
const manifestBytes = await readFile(join(root, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const desktopRuntimeIdentity=process.env.DREATHS_DESKTOP==='1'?await runtimeIdentity(resolve(root,'..')):null;
if (manifest.schema !== 'rea-http-replay-manifest-v1') throw new Error('Unknown replay manifest.');
const objects = new Map();
for (const digest of manifest.objects) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid content object digest.');
  const bytes = await readFile(join(root, 'objects', digest));
  if (hash(bytes) !== digest) throw new Error('Stored original object digest mismatch.');
  objects.set(digest, bytes);
}
const canonicalUrl = value => { const u = new URL(value); u.hash = ''; u.searchParams.delete('_rsc'); return u.href; };
const key = (method, url, body, rsc) => JSON.stringify([method, canonicalUrl(url), body, rsc]);
const index = new Map();
for (const record of manifest.records.filter(r => r.replayable))
  index.set(key(record.method, record.original_url, record.request_body.sha256, record.rsc), record);
const capturedTrendJson = (pathname, search = '') => {
  const record = manifest.records.find(candidate => candidate.replayable && candidate.method === 'GET' &&
    candidate.pathname === pathname && (candidate.search ?? '') === search && !candidate.rsc);
  if (!record) return null;
  try { return JSON.parse(objects.get(record.response.object_sha256).toString('utf8')); }
  catch { return null; }
};
const capturedTrendAggregate = development && originalWorkflows ? (() => {
  const datalab = capturedTrendJson('/api/trends/datalab');
  const google = capturedTrendJson('/api/trends/google');
  const realtime = capturedTrendJson('/api/trends/realtime');
  const shoppingKeywords = capturedTrendJson('/api/trends/shopping/keywords', '?type=ISSUE');
  const shoppingCategories = capturedTrendJson('/api/trends/shopping/categories', '?type=ISSUE');
  if (!datalab || !google || !realtime || !shoppingKeywords || !shoppingCategories) return null;
  return {datalab:datalab.datalab,google:google.google,realtime,shopping:{
    keywords:shoppingKeywords.keywords,categories:shoppingCategories.categories}};
})() : null;
// Only explicit development mode serves the separately patched client assets.
// Retained objects and all recorded API responses remain byte-for-byte unchanged.
const developmentOverrides = new Map();
let developmentManifestSha256 = null;
const patchDevelopmentMarkup = development
  ? (await import('../development/patch-server-markup.mjs')).patchDevelopmentMarkup : null;
if (development) {
  const developmentRoot = resolve(root, '../development');
  const filesRoot = resolve(developmentRoot, 'files');
  const patchBytes = await readFile(join(developmentRoot, 'patch-manifest.json'));
  const patch = JSON.parse(patchBytes);
  if (patch.removed_local_tab_guard_count !== 1) throw new Error('Generate the current development patch before starting --dev.');
  developmentManifestSha256 = hash(patchBytes);
  for (const file of patch.files.filter(file => file.changed)) {
    const path = resolve(filesRoot, file.path);
    if (!path.startsWith(filesRoot + sep)) throw new Error('Development asset path escapes its root.');
    const bytes = await readFile(path);
    if (hash(bytes) !== file.development_sha256) throw new Error('Development asset digest mismatch.');
    const records = manifest.records.filter(record => record.replayable && record.method === 'GET' &&
      record.origin === manifest.primary_origin && file.path.endsWith(record.pathname) &&
      record.response.object_sha256 === file.source_sha256 && /javascript/.test(record.response.media_type ?? ''));
    if (!records.length) throw new Error('Development asset has no matching original captured script.');
    for (const record of records) developmentOverrides.set(record.id, bytes);
  }
  if (developmentOverrides.size !== 3) throw new Error('Expected exactly three development script overrides.');
}
const adapter = await readFile(join(root, 'relocate.js'));
const loopbackMedia=localBenchmarkEnabled?' http://127.0.0.1:'+port+' http://localhost:'+port:'';
const csp = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:"+(originalWorkflows?' https:':'')+loopbackMedia+"; media-src 'self' data: blob:"+(originalWorkflows?' https:':'')+loopbackMedia+"; font-src 'self' data:; connect-src 'self'"+(originalWorkflows?' https://*.amazonaws.com https://cdn.agczero.com':'')+loopbackMedia+"; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'none'; frame-ancestors 'none'";
const encodeOrigin = value => Buffer.from(value).toString('base64url');
const localReference = value => {
  let url;
  try { url = new URL(value, manifest.primary_origin); } catch { return value; }
  if (!['http:', 'https:'].includes(url.protocol)) return value;
  if (!/^https?:\/\//i.test(value) && !value.startsWith('//')) return value;
  if(originalWorkflows&&url.origin!==manifest.primary_origin)return value;
  const prefix = url.origin === manifest.primary_origin ? '' : '/__origin/' + encodeOrigin(url.origin);
  return prefix + url.pathname + url.search + url.hash;
};
const localSrcset = value => value.includes('data:') ? value : value.split(',').map(part => {
  const text = part.trim(); const position = text.search(/\s/);
  return position < 0 ? localReference(text) : localReference(text.slice(0,position)) + text.slice(position);
}).join(', ');
const rewriteDocument = bytes => {
  let text = bytes.toString('utf8');
  text = text.replace(/\b(src|href|action|poster|srcset)\s*=\s*(["'])(.*?)\2/gi,
    (all, name, quote, value) => name + '=' + quote + (name.toLowerCase() === 'srcset' ? localSrcset(value) : localReference(value)) + quote);
  const config = JSON.stringify({ primaryOrigin: manifest.primary_origin, manifestSha256: hash(manifestBytes),liveTrends,
    originalWorkflows,desktop:process.env.DREATHS_DESKTOP==='1',...(originalWorkflows?{workflowToken,developmentDraftView:true,developmentArchiveImport:development,benchmarkLive:true,benchmarkLocal:localBenchmarkEnabled,threadsAuthFixture}:{}),...(vertexBridge?{vertex:vertexBridge.status()}:{} ) }).replace(/</g, '\\u003c');
  const injection = '<script>window.__REA_REPLAY__=' + config + ';</script><script src="/__replay/relocate.js"></script>' + (originalWorkflows?'<script src="/__workflow/benchmark-client.js"></script>':'') + (liveTrends ? '<script src="/__live/client.js" defer></script>' : '');
  if (/<head(?:\s[^>]*)?>/i.test(text)) text = text.replace(/<head(?:\s[^>]*)?>/i, match => match + injection);
  else text = injection + text;
  return Buffer.from(text, 'utf8');
};
const rewriteCss = bytes => Buffer.from(bytes.toString('utf8').replace(/url\(\s*(["']?)([^)'"]+)\1\s*\)/gi,
  (all, quote, value) => 'url(' + quote + localReference(value) + quote + ')'), 'utf8');
await mkdir(join(runtimeRoot, 'derived'), { recursive: true });
const derived = new Map(), relocationRecords = [];
for (const record of manifest.records.filter(r => r.replayable)) {
  const original = objects.get(record.response.object_sha256);
  const type = record.response.media_type ?? '';
  const markupPatch = development && /^text\/html\b/i.test(type) ? patchDevelopmentMarkup(original) : null;
  const output = /^text\/html\b/i.test(type) ? rewriteDocument(markupPatch?.bytes ?? original) : /^text\/css\b/i.test(type) ? rewriteCss(original) : original;
  if (output.equals(original)) continue;
  const digest = hash(output);
  derived.set(record.id, output);
  const file = digest + (/^text\/html\b/i.test(type) ? '.html' : '.css');
  try { await writeFile(join(runtimeRoot, 'derived', file), output, { flag: 'wx' }); }
  catch(error) { if (error.code !== 'EEXIST') throw error; }
  relocationRecords.push({ record_id: record.id, original_sha256: record.response.object_sha256,
    derived_sha256: digest, file, development_removed_ui_nodes:markupPatch?.removed_nodes ?? [], operations: /^text\/html\b/i.test(type)
      ? ['URL-attribute relocation', 'generic local HTTP destination adapter injection', 'self-only CSP header']
      : ['CSS URL relocation'] });
}
await writeFile(join(runtimeRoot,development ? 'development-relocation-manifest.json' : 'relocation-manifest.json'), JSON.stringify({
  schema:'rea-http-replay-relocation-v1', source_manifest_sha256:hash(manifestBytes),
  adapter_sha256:hash(adapter), derived:relocationRecords,
  untouched_javascript:!development, api_response_values_unchanged:!liveTrends, retained_objects_unchanged:true,liveTrends,
  development, development_patch_manifest_sha256:developmentManifestSha256
},null,2)+'\n');
const misses = [], served = [];
let server;
const sendJson = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':body.length, 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  res.end(body);
};
const sourceUrl = local => {
  if (local.pathname.startsWith('/__origin/')) {
    const remaining = local.pathname.slice('/__origin/'.length); const slash = remaining.indexOf('/');
    if (slash < 1) throw new Error('Invalid relocated origin path.');
    const encoded = remaining.slice(0,slash);
    const origin = Buffer.from(encoded,'base64url').toString('utf8');
    if (!/^https?:\/\/[^/]+$/.test(origin) || new URL(origin).origin !== origin) throw new Error('Invalid relocated origin.');
    return origin + remaining.slice(slash) + local.search;
  }
  return manifest.primary_origin + local.pathname + local.search;
};
const recordEvent = async value => {
  await appendFile(join(runtimeRoot, development ? 'development-traffic.jsonl' : 'replay-traffic.jsonl'), JSON.stringify(value)+'\n');
};
const localBenchmark=localBenchmarkEnabled?await(await import('./local-benchmark-service.mjs')).createLocalBenchmarkService({
  directory:process.env.DREATHS_LOCAL_DATA_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'AppData/Local'),'DreathsLocal/benchmark'),
  nonce:workflowToken,recordEvent}):null;
const workflowRoutes=originalWorkflows?await(await import('./workflow-routes.mjs')).createWorkflowRoutes({bridge:liveBridge,
  vertex:vertexBridge,nonce:workflowToken,csp,rewriteDocument,rewriteCss,patchMarkup:patchDevelopmentMarkup,recordEvent,localBenchmark,threadsAuthFixture}):null;
server = createServer(async (req,res) => {
  try {
    const expectedHosts = new Set([host+':'+port, 'localhost:'+port]);
    if (!expectedHosts.has(req.headers.host)) return sendJson(res,421,{error:'loopback_host_required'});
    const local = new URL(req.url, localOrigin);
    if(local.pathname.startsWith('/__desktop/')){
      if(req.method!=='GET')return sendJson(res,405,{error:'get_required'});
      if(req.headers['sec-fetch-site']==='cross-site')return sendJson(res,403,{error:'same_site_required'});
      if(local.pathname==='/__desktop/identity')return sendJson(res,200,{app:'dreaths-local',protocol:2,manifestSha256:hash(manifestBytes),runtimeSha256:desktopRuntimeIdentity,capabilities:{collect:true},managed:process.env.DREATHS_DESKTOP==='1'});
      if(local.pathname==='/__desktop/collect'||local.pathname==='/__desktop/collect.js'){
        const script=local.pathname.endsWith('.js');
        const output=await readFile(join(root,script?'desktop-collect.js':'desktop-collect.html'));
        res.writeHead(200,{'content-type':script?'application/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
          'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"});
        return res.end(output);
      }
      return sendJson(res,404,{error:'desktop_route_not_found'});
    }
    if(localBenchmark&&await localBenchmark.handle(req,res,local))return;
    if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res,403,{error:'cross_site_request_rejected'});
    if (sessionRoutes && await sessionRoutes(req,res,local)) return;
    if (liveBridge && local.pathname === '/__workflow/resource') {
      if (req.method !== 'GET') return sendJson(res,405,{error:'resource_get_required'});
      if (req.headers['x-rea-setup-token'] !== setupToken) return sendJson(res,403,{error:'setup_token_invalid'});
      if (req.headers.origin && req.headers.origin !== 'http://'+req.headers.host) return sendJson(res,403,{error:'same_origin_required'});
      if (local.searchParams.size !== 1 || !local.searchParams.has('path')) return sendJson(res,400,{error:'resource_path_required'});
      const response = await liveBridge.readOriginalResource({path:local.searchParams.get('path')});
      res.writeHead(response.status,{'cache-control':'no-store','content-security-policy':csp,'x-content-type-options':'nosniff',
        ...response.headers,'content-length':response.body.length,'x-rea-served-sha256':hash(response.body)});
      return res.end(response.body);
    }
    if (liveTrends && local.pathname === '/__live/client.js' && req.method === 'GET') {
      res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','content-length':liveClient.length,'cache-control':'no-store','content-security-policy':csp});
      return res.end(liveClient);
    }
    if(benchmarkClient&&local.pathname==='/__workflow/benchmark-client.js'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','content-length':benchmarkClient.length,'cache-control':'no-store','content-security-policy':csp});
      return res.end(benchmarkClient);
    }
    if(originalWorkflows&&threadsAuthFixture&&capturedTrendAggregate&&liveBridge&&req.method==='GET'&&
      local.pathname==='/api/trends'&&!local.search&& !liveBridge.status().configured){
      const bytes=Buffer.from(JSON.stringify(capturedTrendAggregate));
      await recordEvent({method:'GET',pathname:'/api/trends',status:200,developmentFixture:'captured-trend-aggregate'});
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,
        'cache-control':'no-store','content-security-policy':csp,'x-content-type-options':'nosniff',
        'x-rea-body-representation':'captured-trend-aggregate','x-rea-served-sha256':hash(bytes)});
      return res.end(bytes);
    }
    if(workflowRoutes&&await workflowRoutes(req,res,local))return;
    if (brandingLogo&&local.pathname==='/__replay/brand.png'&&['GET','HEAD'].includes(req.method)) {
      res.writeHead(200,{'content-type':'image/png','content-length':brandingLogo.length,'cache-control':'no-store','x-content-type-options':'nosniff'});
      return res.end(req.method==='HEAD'?undefined:brandingLogo);
    }
    if (local.pathname === '/__replay/relocate.js' && req.method === 'GET') {
      res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','content-length':adapter.length,'cache-control':'no-store','content-security-policy':csp});
      return res.end(adapter);
    }
    if (local.pathname === '/__replay/coverage' && req.method === 'GET')
      return sendJson(res,200,{...manifest.summary, served:served.length, misses:misses.length,
        development, live_trends:liveTrends, original_workflows:originalWorkflows, vertex:vertexBridge?.status()??null, development_script_overrides:developmentOverrides.size,
        primary_origin:manifest.primary_origin, recorded_api_routes:[...new Set(manifest.records.filter(r=>r.pathname.startsWith('/api/')).map(r=>r.method+' '+r.pathname+r.search))],
        limitations:manifest.limitations});
    if (local.pathname === '/__replay/misses' && req.method === 'GET') return sendJson(res,200,misses);
    if (local.pathname === '/__shutdown' && ['GET','POST'].includes(req.method)) {
      if(process.env.DREATHS_DESKTOP==='1')return sendJson(res,403,{error:'desktop_ipc_shutdown_required'});
      sendJson(res,200,{stopping:true});
      setTimeout(()=>server.close(()=>process.exit(0)),50);
      return;
    }
    let size=0; const chunks=[];
    for await (const chunk of req) {
      size+=chunk.length;
      if(size>8*1024*1024) return sendJson(res,413,{error:'replay_request_body_limit'});
      chunks.push(chunk);
    }
    const body=Buffer.concat(chunks);
    const originalUrl=sourceUrl(local);
    const method=req.method.toUpperCase();
    const rsc=req.headers.rsc !== undefined;
    const bodyHash=hash(body);
    let record=index.get(key(method,originalUrl,bodyHash,rsc));
    if (!record && method === 'HEAD') record=index.get(key('GET',originalUrl,emptyHash,rsc));
    // The captured logo has one Next image width. High-DPI app windows may ask
    // for its 2x variant; serve the retained image for the exact same static
    // input and quality rather than showing a broken image while offline.
    let retainedImageVariant=false;
    if(!record&&method==='GET'&&!body.length&&!rsc&&local.pathname==='/_next/image'&&local.searchParams.size===3&&
      /^\/_next\/static\/media\/[^/]+\.[a-f0-9]+\.(?:png|jpe?g|webp)$/i.test(local.searchParams.get('url')??'')&&
      /^(?:[1-9][0-9]{0,3})$/.test(local.searchParams.get('w')??'')){
      record=manifest.records.find(candidate=>candidate.replayable&&candidate.method==='GET'&&candidate.pathname==='/_next/image'&&
        new URL(candidate.original_url).searchParams.get('url')===local.searchParams.get('url')&&new URL(candidate.original_url).searchParams.get('q')===local.searchParams.get('q'));
      retainedImageVariant=Boolean(record);
    }
    const event={method,pathname:new URL(originalUrl).pathname,query_parameter_names:[...new URL(originalUrl).searchParams.keys()],rsc};
    if (liveBridge && new URL(originalUrl).origin === manifest.primary_origin && liveBridge.match(new URL(originalUrl))) {
      if (method !== 'GET') return sendJson(res,405,{error:'live_trends_get_only'});
      if (body.length || rsc) return sendJson(res,400,{error:'invalid_live_trends_representation'});
      const response = await liveBridge.request(new URL(originalUrl));
      // A disconnected development session still needs a useful first render.
      // Use the exact retained trend response only for the captured request;
      // once a real session is configured, upstream status and errors win.
      const useCapturedTrend=development&&originalWorkflows&&!liveBridge.status().configured&&
        response.status===503&&record&&response.headers['x-rea-body-representation']==='live-api-error';
      if(!useCapturedTrend){
        await recordEvent({...event,status:response.status,live:true});
        res.writeHead(response.status,{'cache-control':'no-store','content-security-policy':csp,'x-content-type-options':'nosniff',
          ...response.headers,'content-length':response.body.length,'x-rea-served-sha256':hash(response.body)});
        return res.end(response.body);
      }
      await recordEvent({...event,status:record.response.status,developmentFixture:'captured-trend-fallback'});
    }
    if (!record) {
      const miss={...event,status:501,reason:'No exact retained HTTP request/response matches this method, URL, body digest and RSC representation.'};
      misses.push(miss); await recordEvent(miss);
      return sendJson(res,501,{error:'capture_required',method,pathname:event.pathname,query_parameter_names:event.query_parameter_names,
        message:liveTrends ? 'This request was not recorded. Only configured read-only trend routes can contact the original server.' : 'This request was not recorded by REA. No original server or proxy fallback is connected.'});
    }
    const original=objects.get(record.response.object_sha256);
    const output=developmentOverrides.get(record.id)??derived.get(record.id)??original;
    const exactBody=output.equals(original);
    const headers={
      'content-type':record.response.media_type??'application/octet-stream','content-length':output.length,
      'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':csp,
      'x-rea-record-id':record.id,'x-rea-original-sha256':record.response.object_sha256,
      'x-rea-body-representation':retainedImageVariant?'retained-static-image-width-variant':developmentOverrides.has(record.id)?'development-patched-script':derived.has(record.id)?'derived-document-or-css':'exact-retained-body',
      'x-rea-served-sha256':hash(output)
    };
    if(record.response.headers['content-language']) headers['content-language']=record.response.headers['content-language'];
    if(record.response.headers.location) headers.location=localReference(record.response.headers.location);
    served.push(record.id); await recordEvent({...event,status:record.response.status,record_id:record.id,exact_body:exactBody});
    res.writeHead(record.response.status,headers);
    res.end(method==='HEAD'||[204,304].includes(record.response.status)?undefined:output);
  } catch(error) {
    console.error('REPLAY_ERROR',error.name);
    if(!res.headersSent) sendJson(res,500,{error:'replay_transport_error'});
    else res.destroy();
  }
});
server.requestTimeout=30000;
server.listen(port,host,()=>{
  console.log('REA_HTTP_REPLAY_READY '+localOrigin+'/dashboard/insights '+JSON.stringify({...manifest.summary,development,liveTrends,originalWorkflows,vertex:vertexBridge?.status()??null,development_script_overrides:developmentOverrides.size}));
  process.send?.({type:'dreaths-ready',protocol:2,origin:localOrigin,manifestSha256:hash(manifestBytes)});
});
if(process.env.DREATHS_DESKTOP==='1'&&process.send){
  const stop=()=>{liveBridge?.clear();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),4000).unref()};
  process.on('message',message=>{if(message?.type==='dreaths-stop')stop()});
  process.once('disconnect',stop);
}
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
