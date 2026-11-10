import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(join(process.env.REA_PACKAGE_ROOT ?? 'C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents', 'package.json'));
const { parse: parseJavaScript } = require('@babel/parser');
const { parse: parseHtml } = require('parse5');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sensitiveQueryName = /^(?:key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|authorization|code)$/i;

const evidenceLocation = node => ({ start_utf16: node.start, end_utf16: node.end,
  line: node.loc?.start.line ?? null, column_zero_based: node.loc?.start.column ?? null });
const keyName = node => node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : null;
const lastCallee = node => node?.type === 'SequenceExpression' ? node.expressions.at(-1) : node;
const memberName = node => (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') &&
  (!node.computed || node.property.type === 'StringLiteral') ? keyName(node.property) : null;

// This renders syntax only; identifiers and other expressions are never evaluated.
const renderTarget = (node, depth = 0) => {
  if (!node || depth > 30) return { value: '{expression}', dynamic: true };
  if (node.type === 'StringLiteral') return { value: node.value, dynamic: false };
  if (node.type === 'TemplateLiteral') return {
    value: node.quasis.map((part,index) => (part.value.cooked ?? part.value.raw) + (index < node.expressions.length ? '{expression}' : '')).join(''),
    dynamic: node.expressions.length > 0
  };
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = renderTarget(node.left,depth+1), right = renderTarget(node.right,depth+1);
    return { value: left.value+right.value, dynamic: left.dynamic || right.dynamic };
  }
  if (node.type === 'CallExpression' && memberName(node.callee) === 'concat') {
    const parts = [node.callee.object,...node.arguments].map(part => renderTarget(part,depth+1));
    return { value: parts.map(part => part.value).join(''), dynamic: parts.some(part => part.dynamic) };
  }
  return { value: '{expression}', dynamic: true };
};

const sanitizeCandidate = value => {
  const queryAt = value.indexOf('?');
  if (queryAt < 0) return value;
  const fragmentAt = value.indexOf('#',queryAt);
  const query = value.slice(queryAt+1,fragmentAt < 0 ? undefined : fragmentAt);
  const sanitized = query.split('&').map(pair => {
    const equals = pair.indexOf('=');
    const name = equals < 0 ? pair : pair.slice(0,equals);
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { decoded = name; }
    return sensitiveQueryName.test(decoded) ? name+'={redacted}' : pair;
  }).join('&');
  return value.slice(0,queryAt+1)+sanitized+(fragmentAt < 0 ? '' : value.slice(fragmentAt));
};

const classifyCandidate = (rendered, origin) => {
  if (typeof rendered.value !== 'string' || rendered.value.length > 8192 || /[\x00-\x20\x7f]/.test(rendered.value)) return null;
  let value = rendered.value;
  if (/^https?:\/\//i.test(value)) {
    let absolute;
    try { absolute = new URL(value); } catch { return null; }
    if (absolute.origin !== origin) return null;
    value = absolute.pathname+absolute.search+absolute.hash;
  }
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith('/api/')) return { kind: 'endpoint', value: sanitizeCandidate(value), dynamic: rendered.dynamic };
  if (value.startsWith('/_next/') || /\.[A-Za-z0-9]{1,8}(?:[?#]|$)/.test(value)) return null;
  if (!/^\/[\p{L}\p{N}_\-/{}]*(?:[?#].*)?$/u.test(value)) return null;
  return { kind: 'internal-route', value: sanitizeCandidate(value), dynamic: rendered.dynamic };
};

const directProperty = (node,name) => node?.type === 'ObjectExpression'
  ? node.properties.filter(item => item.type === 'ObjectProperty' && (!item.computed || item.key.type === 'StringLiteral') && keyName(item.key) === name).at(-1)?.value : null;
const objectKeys = node => node?.type === 'ObjectExpression'
  ? node.properties.filter(item => item.type === 'ObjectProperty' && (!item.computed || item.key.type === 'StringLiteral')).map(item => keyName(item.key)).filter(Boolean) : null;
const requestOptions = (argument, options, depth=0) => {
  if(depth>20)return {target:argument,options,requestObject:true,inheritedMethod:'unknown'};
  if (argument?.type === 'NewExpression' && argument.callee.type === 'Identifier' && argument.callee.name === 'Request') {
    const inherited = requestOptions(argument.arguments[0],argument.arguments[1],depth+1);
    const inheritedMethod = fetchMethod(inherited.options,inherited.requestObject,inherited.inheritedMethod);
    return { target: inherited.target, options: options ?? inherited.options, requestObject: options?false:inherited.requestObject,
      inheritedMethod:options ? inheritedMethod : inherited.inheritedMethod };
  }
  const knownString = argument && (['StringLiteral','TemplateLiteral'].includes(argument.type) ||
    argument.type === 'BinaryExpression' && argument.operator === '+' ||
    argument.type === 'CallExpression' && memberName(argument.callee) === 'concat');
  return { target: argument, options, requestObject: !knownString, inheritedMethod:knownString?'GET':'unknown' };
};
const fetchMethod = (options,requestObject,inheritedMethod='GET') => {
  if (!options) return requestObject ? 'unknown' : inheritedMethod;
  if (options.type !== 'ObjectExpression') return 'unknown';
  let result = inheritedMethod;
  for (const item of options.properties) {
    if (item.type === 'SpreadElement') result = 'unknown';
    else if(item.type==='ObjectProperty'&&item.computed&&item.key.type!=='StringLiteral')result='unknown';
    else if (item.type === 'ObjectProperty' && (!item.computed || item.key.type === 'StringLiteral') && keyName(item.key) === 'method') {
      const rendered = renderTarget(item.value);
      result = !rendered.dynamic && /^[A-Za-z]+$/.test(rendered.value) ? rendered.value.toUpperCase() : 'unknown';
    }
  }
  return result;
};

export const inspectJavaScript = (source,{ origin = 'https://drt.agczero.com' } = {}) => {
  const ast = parseJavaScript(source,{ sourceType:'unambiguous', errorRecovery:false });
  const endpoints = [], internalRoutes = [], fetchCalls = [];
  const seen = new Set();
  const pending = [{node:ast,parent:null,moduleId:null}];
  while (pending.length) {
    const {node,parent,moduleId:inheritedModule} = pending.pop();
    if (!node || typeof node.type !== 'string') continue;
    const moduleId = node.type === 'ObjectProperty' && node.key.type === 'NumericLiteral' && node.value?.type === 'FunctionExpression'
      ? node.key.value : inheritedModule;
    if (['StringLiteral','TemplateLiteral','BinaryExpression','CallExpression'].includes(node.type)) {
      const candidate = classifyCandidate(renderTarget(node),origin);
      if (candidate) {
        const key = candidate.kind+':'+node.start+':'+node.end;
        if (!seen.has(key)) {
          seen.add(key);
          const item = {...candidate,...evidenceLocation(node),node_type:node.type,parent_type:parent?.type ?? null,enclosing_numeric_factory_id:moduleId};
          (candidate.kind === 'endpoint' ? endpoints : internalRoutes).push(item);
        }
      }
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = lastCallee(node.callee);
      const isFetch = callee?.type === 'Identifier' && callee.name === 'fetch' ||
        memberName(callee) === 'fetch' && ['window','globalThis','self'].includes(callee.object?.name);
      if (isFetch) {
        const request = requestOptions(node.arguments[0],node.arguments[1]);
        const rendered = renderTarget(request.target);
        let candidate = classifyCandidate(rendered,origin);
        if(!candidate&&/^https?:\/\//i.test(rendered.value)&&rendered.value.length<=8192) {
          try {
            const targetUrl=new URL(rendered.value);
            candidate={kind:'external-http',value:sanitizeCandidate(targetUrl.origin+targetUrl.pathname+targetUrl.search+targetUrl.hash),dynamic:rendered.dynamic};
          } catch {}
        }
        const body = directProperty(request.options,'body');
        const bodyKeys = body?.type === 'CallExpression' && memberName(body.callee) === 'stringify' && body.callee.object?.name === 'JSON'
          ? objectKeys(body.arguments[0]) : objectKeys(body);
        fetchCalls.push({target:candidate?.value ?? null,target_kind:candidate?.kind ?? 'unresolved',dynamic:rendered.dynamic,
          target_expression_type:request.target?.type ?? null,method:fetchMethod(request.options,request.requestObject,request.inheritedMethod),
          body_property_names:bodyKeys,header_names:objectKeys(directProperty(request.options,'headers')),
          ...evidenceLocation(node),enclosing_numeric_factory_id:moduleId});
      }
    }
    for (const [key,value] of Object.entries(node)) {
      if (['loc','start','end','extra','tokens','comments'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (let index=value.length-1;index>=0;index--) if(value[index]?.type) pending.push({node:value[index],parent:node,moduleId});
      } else if (value?.type) pending.push({node:value,parent:node,moduleId});
    }
  }
  const order = values => values.sort((a,b)=>a.start_utf16-b.start_utf16);
  return {endpoints:order(endpoints),internal_routes:order(internalRoutes),fetch_calls:order(fetchCalls)};
};

export const inspectHtmlAssets = (source,{origin='https://drt.agczero.com',documentPath='/'} = {}) => {
  const ast = parseHtml(source,{sourceCodeLocationInfo:true});
  const pending = [ast], assets = [];
  while(pending.length) {
    const node=pending.pop();
    const attributeName=node.tagName==='script'?'src':node.tagName==='link'?'href':null;
    const attribute=attributeName&&node.attrs?.find(attribute=>attribute.name===attributeName);
    if(attribute) {
      let url;
      try { url=new URL(attribute.value,new URL(documentPath,origin)); } catch {}
      const kind=url&&/\.js$/i.test(url.pathname)?'javascript':url&&/\.css$/i.test(url.pathname)?'css':null;
      if(url?.origin===origin&&url.pathname.startsWith('/_next/static/')&&kind) {
        const location=node.sourceCodeLocation?.attrs?.[attributeName]??node.sourceCodeLocation;
        assets.push({url:url.href,path:url.pathname+url.search,kind,tag:node.tagName,attribute:attributeName,
          start_utf16:location?.startOffset??null,end_utf16:location?.endOffset??null,
          line:location?.startLine??null,column_zero_based:location?.startCol==null?null:location.startCol-1});
      }
    }
    for(const child of node.childNodes??[])pending.push(child);
    if(node.content)pending.push(node.content);
  }
  return assets.sort((a,b)=>(a.start_utf16??0)-(b.start_utf16??0));
};

export const indexWorkflowCapture = async (captureRoot,{outputPath=join(captureRoot,'client-inventory.json')} = {}) => {
  captureRoot=resolve(captureRoot);
  const manifestBytes=await readFile(join(captureRoot,'manifest.json'));
  const manifest=JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/,''));
  const origin=new URL(manifest.primary_origin??manifest.origin??'https://drt.agczero.com').origin;
  if(!Array.isArray(manifest.records))throw new Error('Capture manifest records must be an array');
  const sources=[],verificationFailures=[],parseFailures=[],byDigest=new Map();
  const records=manifest.records.filter(record=>(record.status??record.response?.status)===200&&(!record.method||record.method==='GET'));
  for(const record of records) {
    const digest=record.object_sha256??record.response?.object_sha256;
    const mediaType=record.media_type??record.response?.media_type??'';
    if(!/javascript|ecmascript|text\/html|text\/css/i.test(mediaType))continue;
    const recordPath=record.path??record.original_url??record.pathname??null;
    if(!/^[a-f0-9]{64}$/.test(digest??'')) { verificationFailures.push({record_path:recordPath,error:'invalid_object_digest'});continue; }
    if(byDigest.has(digest)) { byDigest.get(digest).record_paths.push(recordPath);continue; }
    const file=resolve(captureRoot,record.file??join('objects',digest));
    if(!file.startsWith(captureRoot+sep)) {verificationFailures.push({record_path:recordPath,error:'source_file_outside_capture_root'});continue;}
    let bytes;
    try {bytes=await readFile(file);}catch(error){verificationFailures.push({record_path:recordPath,error:error.code??'source_read_failed'});continue;}
    if(sha256(bytes)!==digest) {verificationFailures.push({record_path:recordPath,error:'source_digest_mismatch'});continue;}
    const entry={object_sha256:digest,bytes:bytes.length,file,media_type:mediaType,record_paths:[recordPath],parse_status:'not-applicable',
      assets:[],endpoints:[],internal_routes:[],fetch_calls:[]};
    sources.push(entry);byDigest.set(digest,entry);
    try {
      const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(/text\/html/i.test(mediaType))entry.assets=inspectHtmlAssets(source,{origin,documentPath:recordPath??'/'});
      else if(/javascript|ecmascript/i.test(mediaType))Object.assign(entry,inspectJavaScript(source,{origin}));
      entry.parse_status=/text\/css/i.test(mediaType)?'not-applicable':'parsed';
    } catch(error) {
      entry.parse_status='failed';
      parseFailures.push({object_sha256:digest,record_path:recordPath,file,error:error.reasonCode??error.code??error.name,
        line:error.loc?.line??null,column_zero_based:error.loc?.column??null});
    }
  }
  const assetMap=new Map();
  for(const source of sources)for(const asset of source.assets) {
    const {url,path,kind,...reference}=asset;
    if(!assetMap.has(url))assetMap.set(url,{url,path,kind,references:[]});
    assetMap.get(url).references.push({...reference,source_sha256:source.object_sha256,source_file:source.file,record_paths:source.record_paths});
  }
  const flatten=key=>sources.flatMap(source=>source[key].map(item=>({...item,source_sha256:source.object_sha256,source_file:source.file,record_paths:source.record_paths})));
  const report={schema:'rea-workflow-client-inventory-v1',source_manifest_sha256:sha256(manifestBytes),origin,
    scope:'Static analysis of retained response bytes only; no captured JavaScript was executed and no remote requests were made.',
    coordinate_unit:'UTF-16 code units; lines are one-based and columns zero-based',sources,
    assets:[...assetMap.values()].sort((a,b)=>a.path.localeCompare(b.path)),endpoints:flatten('endpoints'),internal_routes:flatten('internal_routes'),fetch_calls:flatten('fetch_calls'),
    parse_failures:parseFailures,verification_failures:verificationFailures,
    limitations:['Dynamic expressions are placeholders, not evaluated values.','Endpoint and route literals are candidates; static presence does not prove invocation or authorization.','Numeric factory identities are lexical containing properties, not an independently verified module graph.','CSS is retained and verified but not parsed for additional imports.','Only top-level successful GET captures classified as HTML, JavaScript or CSS are indexed.']};
  await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
  return report;
};

const isMain=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url;
if(isMain) {
  try {
    const captureRoot=resolve(process.argv[2]??join(dirname(fileURLToPath(import.meta.url)),'workflow-capture'));
    const report=await indexWorkflowCapture(captureRoot);
    console.log(JSON.stringify({sources:report.sources.length,assets:report.assets.length,endpoints:report.endpoints.length,
      internal_routes:report.internal_routes.length,fetch_calls:report.fetch_calls.length,parse_failures:report.parse_failures,
      verification_failures:report.verification_failures,output:join(captureRoot,'client-inventory.json')}));
    if(report.parse_failures.length||report.verification_failures.length)process.exitCode=1;
  } catch(error) {
    console.error(JSON.stringify({error:error.code==='ENOENT'?'capture_manifest_or_source_missing':error.name}));
    process.exitCode=1;
  }
}
