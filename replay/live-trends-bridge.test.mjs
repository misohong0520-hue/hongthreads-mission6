import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveTrendsBridge,matchesLiveTrendRoute} from './live-trends-bridge.mjs';

const SESSION_A='fixture-session-alpha';
const SESSION_B='fixture-session-beta';
const local=path=>new URL(path,'http://127.0.0.1:9248');
const json=(value,init={})=>new Response(JSON.stringify(value),{...init,headers:{'content-type':'application/json',...init.headers}});
const google=()=>json({google:[{keyword:'fixture keyword'}]});
const datalab=()=>json({datalab:[{categoryName:'fixture category',keywords:['fixture keyword']}]});
const configure=(bridge,cookieValue=SESSION_A,cookieName='next-auth.session-token')=>bridge.configure({cookieName,cookieValue});
const error=result=>JSON.parse(result.body).error;
const noSessionValues=value=>{
  const text=JSON.stringify(value);
  assert.ok(!text.includes(SESSION_A));
  assert.ok(!text.includes(SESSION_B));
};

test('session validation uses a fixed HTTPS GET, preserves bytes, and exposes no credentials',async()=>{
  const bytes=Buffer.from('  { "google": [{"keyword":"fixture keyword"}] }\n');
  const calls=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return new Response(bytes,{headers:{'content-type':'application/json; charset=utf-8','set-cookie':'next-auth.session-token=fixture-rotation; Secure'}});
  },now:()=>1700000000000});
  assert.equal(bridge.status().configured,false);
  const configured=await configure(bridge);
  assert.equal(configured.status,200);
  assert.equal(configured.body.configured,true);
  assert.equal(configured.body.state,'connected');
  assert.equal(configured.body.refreshSeconds,60);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://drt.agczero.com/api/trends/google');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.headers.cookie,'next-auth.session-token='+SESSION_A);
  const served=await bridge.request(local('/api/trends/google'));
  assert.deepEqual(served.body,bytes);
  assert.equal(served.headers['x-rea-live-cache'],'hit');
  assert.equal(served.headers['set-cookie'],undefined);
  assert.equal(calls.length,1);
  noSessionValues(configured);
  noSessionValues(bridge.status());
  noSessionValues(bridge);
  served.body.fill(0);
  assert.deepEqual((await bridge.request(local('/api/trends/google'))).body,bytes);
});

test('Cookie and Set-Cookie inputs forward only one supported session, including ordered chunks',async()=>{
  const cases=[
    ['_ga=fixture-analytics; next-auth.session-token='+SESSION_A+'; next-auth.csrf-token=fixture-csrf','next-auth.session-token='+SESSION_A],
    ['Set-Cookie: __Secure-next-auth.session-token='+SESSION_A+'; Path=/; HttpOnly; Secure; SameSite=Lax','__Secure-next-auth.session-token='+SESSION_A],
    ['Cookie: authjs.session-token.1=fixture-part-one; _ga=fixture-analytics; authjs.session-token.0=fixture-part-zero','authjs.session-token.0=fixture-part-zero; authjs.session-token.1=fixture-part-one']
  ];
  for(const [input,expected] of cases){
    let sent;
    const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{sent=options.headers.cookie;return google();}});
    assert.equal((await configure(bridge,input)).status,200);
    assert.equal(sent,expected);
    noSessionValues(bridge.status());
  }
});

test('invalid cookie input disables the previous session without any upstream request',async()=>{
  const invalid=[
    SESSION_A+'\r\nX-Injected: fixture',
    'next-auth.session-token='+SESSION_A+'; authjs.session-token='+SESSION_B,
    'next-auth.session-token.1=fixture-missing-zero',
    'next-auth.session-token.0=fixture-a; next-auth.session-token.0=fixture-b',
    'next-auth.session-token='+SESSION_A+'; next-auth.session-token.0=fixture-part',
    'next-auth.session-token.00=fixture-invalid-index',
    'next-auth.session-token="fixture-quoted"',
    'next-auth.session-token=fixture,comma',
    'Cookie: _ga=fixture-only-analytics',
    'x'.repeat(32769)
  ];
  for(const input of invalid){
    let calls=0;
    const bridge=new LiveTrendsBridge({fetchImpl:async()=>{calls++;return google();}});
    await configure(bridge);
    const result=await configure(bridge,input);
    assert.equal(result.status,400);
    assert.equal(bridge.status().configured,false);
    assert.equal(calls,1);
    assert.equal((await bridge.request(local('/api/trends/google'))).status,503);
    noSessionValues(result);
  }
});

test('only exact trend paths and whitelisted business queries reach the fixed origin',async()=>{
  const urls=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url)=>{
    urls.push(url);
    return new URL(url).pathname.endsWith('categories')?json({categories:['fixture']}):google();
  }});
  await configure(bridge);
  const bad=[
    ['/api/trends/google?url=https://fixture.invalid',400],
    ['/api/trends/google?type=ISSUE',400],
    ['/api/trends/shopping/categories?type=ISSUE&type=NEW',400],
    ['/api/trends/shopping/keywords?type=issue',400],
    ['/api/trends/shopping/keywords?type=ISSUE&category1=fixture&secret=fixture',400],
    ['/api/trends/shopping/keywords?type=ISSUE&category1=%0a',400],
    ['/api/auth/session',404],
    ['/api/trends/google/extra',404],
    ['/__origin/fixture/api/trends/google',404]
  ];
  for(const [path,status] of bad)assert.equal((await bridge.request(local(path))).status,status);
  assert.equal(urls.length,1);
  assert.equal(matchesLiveTrendRoute(local('/api/auth/session')),false);
  assert.equal(bridge.match(local('/api/trends/google?bad=fixture')),true);
  const response=await bridge.request(new URL('https://fixture.invalid/api/trends/shopping/categories?category1=fixture%20category&type=POPULAR&_rsc=fixture'));
  assert.equal(response.status,200);
  assert.equal(urls.at(-1),'https://drt.agczero.com/api/trends/shopping/categories?type=POPULAR&category1=fixture+category');
  assert.equal((await bridge.request(local('/api/trends/google?_rsc=fixture'))).status,200);
});

test('401 clears session and cached data; upstream error bodies never escape',async()=>{
  let clock=1000;
  let calls=0;
  const bridge=new LiveTrendsBridge({now:()=>clock,fetchImpl:async()=>{
    calls++;
    return calls===1?google():json({sensitive:SESSION_A},{status:401});
  }});
  await configure(bridge);
  clock+=15001;
  const result=await bridge.request(local('/api/trends/google'));
  assert.equal(result.status,401);
  assert.equal(error(result),'session_expired');
  assert.equal(bridge.status().configured,false);
  assert.equal(bridge.status().state,'session-expired');
  assert.equal((await bridge.request(local('/api/trends/datalab'))).status,401);
  assert.equal(calls,2);
  noSessionValues(result);
  noSessionValues(bridge.status());
});

test('403 preserves the session but cannot fall back to expired cached data for the denied route',async()=>{
  let clock=1000,denied=false;
  const bridge=new LiveTrendsBridge({now:()=>clock,fetchImpl:async url=>{
    if(new URL(url).pathname.endsWith('google'))return google();
    return denied?json({sensitive:SESSION_A},{status:403}):datalab();
  }});
  await configure(bridge);
  assert.equal((await bridge.request(local('/api/trends/datalab'))).status,200);
  clock+=15001;denied=true;
  const result=await bridge.request(local('/api/trends/datalab'));
  assert.equal(result.status,403);
  assert.equal(error(result),'access_denied');
  assert.equal(bridge.status().state,'access-denied');
  assert.equal(bridge.status().configured,true);
  assert.equal((await bridge.request(local('/api/trends/datalab'))).status,403);
  assert.equal((await bridge.request(local('/api/trends/google'))).status,200);
  noSessionValues(result);
  noSessionValues(bridge.status());
});

test('403 leaves unrelated inflight requests and their authenticated success intact',async()=>{
  let release,signal;
  let calls=0;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    calls++;
    const path=new URL(url).pathname;
    if(path.endsWith('google'))return google();
    if(path.endsWith('datalab')){signal=options.signal;return new Promise(resolve=>{release=resolve;});}
    return json({sensitive:SESSION_A},{status:403});
  }});
  await configure(bridge);
  const pending=bridge.request(local('/api/trends/datalab'));
  assert.equal((await bridge.request(local('/api/trends/realtime'))).status,403);
  assert.equal(signal.aborted,false);
  assert.equal(bridge.status().state,'access-denied');
  assert.equal(bridge.status().configured,true);
  release(datalab());
  assert.equal((await pending).status,200);
  assert.equal(bridge.status().state,'connected');
  assert.equal(bridge.status().configured,true);
  assert.equal((await bridge.request(local('/api/trends/google'))).status,200);
  assert.equal(calls,3);
});

test('redirects, transport exceptions, unexpected MIME, malformed schemas, and oversized bodies fail closed',async()=>{
  const cases=[
    [()=>new Response(null,{status:302,headers:{location:'https://fixture.invalid/'+SESSION_A}}),'upstream_redirect_rejected'],
    [()=>{throw new Error(SESSION_A);},'upstream_unavailable'],
    [()=>new Response('<html>fixture</html>',{headers:{'content-type':'text/html'}}),'upstream_invalid_json'],
    [()=>new Response('{fixture-invalid',{headers:{'content-type':'application/json'}}),'upstream_invalid_json'],
    [()=>json({google:[42]}),'upstream_schema_mismatch'],
    [()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(8*1024*1024+1)}}),'upstream_body_too_large'],
    [()=>new Response(new Uint8Array(8*1024*1024+1),{headers:{'content-type':'application/json'}}),'upstream_body_too_large']
  ];
  for(const [response,expected] of cases){
    const bridge=new LiveTrendsBridge({fetchImpl:async()=>response()});
    const result=await configure(bridge);
    assert.equal(result.status,502);
    assert.equal(result.body.error,expected);
    assert.equal(bridge.status().configured,false);
    noSessionValues(result);
  }
});

test('inflight requests coalesce, successful bodies cache for 15 seconds, and cache keys stay bounded',async()=>{
  let clock=1000;
  let calls=0;
  let release;
  const bridge=new LiveTrendsBridge({now:()=>clock,fetchImpl:async url=>{
    calls++;
    if(new URL(url).pathname.endsWith('google'))return google();
    if(calls===2)return new Promise(resolve=>{release=resolve;});
    return datalab();
  }});
  await configure(bridge);
  const first=bridge.request(local('/api/trends/datalab'));
  const second=bridge.request(local('/api/trends/datalab'));
  assert.equal(calls,2);
  release(datalab());
  assert.equal((await first).status,200);
  assert.equal((await second).headers['x-rea-live-cache'],'coalesced');
  assert.equal((await bridge.request(local('/api/trends/datalab'))).headers['x-rea-live-cache'],'hit');
  assert.equal(calls,2);
  clock+=15001;
  assert.equal((await bridge.request(local('/api/trends/datalab'))).status,200);
  assert.equal(calls,3);
  let listCalls=0;
  const bounded=new LiveTrendsBridge({fetchImpl:async url=>{
    if(new URL(url).pathname.endsWith('google'))return google();
    listCalls++;
    return json({categories:['fixture']});
  }});
  await configure(bounded);
  for(let n=0;n<65;n++)await bounded.request(local('/api/trends/shopping/categories?type=ISSUE&category1='+n));
  await bounded.request(local('/api/trends/shopping/categories?type=ISSUE&category1=0'));
  assert.equal(listCalls,66);
});

test('clearing or replacing a session invalidates old inflight replies and cannot repopulate the cache',async()=>{
  let release;
  let oldSignal;
  const sent=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    sent.push(options.headers.cookie);
    if(new URL(url).pathname.endsWith('google'))return google();
    if(options.headers.cookie.endsWith(SESSION_A)){
      oldSignal=options.signal;
      return new Promise(resolve=>{release=resolve;});
    }
    return datalab();
  }});
  await configure(bridge);
  const pending=bridge.request(local('/api/trends/datalab'));
  bridge.clear();
  assert.equal(oldSignal.aborted,true);
  await configure(bridge,SESSION_B);
  release(datalab());
  const old=await pending;
  assert.equal(old.status,409);
  assert.equal(error(old),'session_changed');
  const fresh=await bridge.request(local('/api/trends/datalab'));
  assert.equal(fresh.status,200);
  assert.equal(fresh.headers['x-rea-live-cache'],'miss');
  assert.equal(sent.at(-1),'next-auth.session-token='+SESSION_B);
  assert.equal(bridge.status().configured,true);
  noSessionValues(old);
  noSessionValues(bridge.status());
});

test('a slower previous configuration cannot replace the most recently validated session',async()=>{
  let release;
  let finalCookie;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(options.headers.cookie.endsWith(SESSION_A))return new Promise(resolve=>{release=resolve;});
    finalCookie=options.headers.cookie;
    return new URL(url).pathname.endsWith('google')?google():datalab();
  }});
  const earlier=configure(bridge);
  assert.equal((await configure(bridge,SESSION_B)).status,200);
  release(google());
  const old=await earlier;
  assert.equal(old.status,409);
  assert.equal(old.body.error,'session_changed');
  assert.equal((await bridge.request(local('/api/trends/datalab'))).status,200);
  assert.equal(finalCookie,'next-auth.session-token='+SESSION_B);
  noSessionValues(old);
});

test('original resource reads preserve bytes and RSC/query values using only the private session',async()=>{
  const bytes=Buffer.from('\ufeff<script>/* fixture original */</script>\n');
  const calls=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls.push({url,options});
    return new Response(bytes,{headers:{'content-type':'text/x-component; charset=utf-8','set-cookie':'unrelated=fixture; Secure'}});
  }});
  assert.equal((await bridge.readOriginalResource({path:'/write'})).status,503);
  await configure(bridge);
  const path='/write?mode=realtime&keyword=fixture%20word&source=first%0Asecond&imageUrl=https%3A%2F%2Ffixture.invalid%2Fimage.png&_rsc=fixture';
  const result=await bridge.readOriginalResource({path,headers:{RSC:'1','Next-Router-State-Tree':'fixture-tree','Next-Router-Prefetch':'1','Next-Url':'/write',Accept:'text/x-component',Cookie:'untrusted=fixture',Origin:'https://fixture.invalid',Referer:'https://fixture.invalid','X-Unrelated':'fixture'}});
  assert.equal(result.status,200);
  assert.deepEqual(result.body,bytes);
  assert.equal(result.headers['set-cookie'],undefined);
  assert.equal(result.headers['x-rea-body-representation'],'live-original-resource');
  assert.equal(calls[0].url,'https://drt.agczero.com'+path);
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.headers.cookie,'next-auth.session-token='+SESSION_A);
  assert.equal(calls[0].options.headers.referer,'https://drt.agczero.com/dashboard/insights');
  assert.equal(calls[0].options.headers.rsc,'1');
  assert.equal(calls[0].options.headers['next-router-state-tree'],'fixture-tree');
  assert.equal(calls[0].options.headers['next-router-prefetch'],'1');
  assert.equal(calls[0].options.headers['next-url'],'/write');
  assert.equal(calls[0].options.headers.accept,'text/x-component');
  assert.equal(calls[0].options.headers.origin,undefined);
  assert.equal(calls[0].options.headers['x-unrelated'],undefined);
  noSessionValues(result);
  noSessionValues(bridge.status());
});

test('original resource allowlist rejects path normalization escapes and invalid forwarded headers before fetching',async()=>{
  let calls=0;
  const bridge=new LiveTrendsBridge({fetchImpl:async()=>{calls++;return google();}});
  await configure(bridge);
  const invalid=['https://fixture.invalid/write','//fixture.invalid/write','/write#fixture','/write/../api/auth/session',
    '/_next/static/../fixture.js','/_next/static/%2e%2e/fixture.js','/_next/static/%252e%252e/fixture.js',
    '/_next/static/fixture%2fescape.js','/_next/static/fixture%5cescape.js','/_next/static/fixture\\escape.js',
    '/_next/static/fixture.json','/_next/static/fixture.js.map','/write/','/api/keys/status?provider=INVALID',
    '/api/keys/status?provider=COUPANG&provider=TOSS','/api/auth/session?update=1','/api/keys/accounts?url=https://fixture.invalid',
    '/api/subscription/status?fixture=1','/dashboard/personas/extra','/dashboard/fixture','/write?source='+'x'.repeat(65536)];
  for(const path of invalid)assert.equal((await bridge.readOriginalResource({path})).status,400);
  for(const headers of [{RSC:'1\r\nCookie: fixture'},{Accept:['text/html']},{'Next-Url':'/write\0fixture'}])
    assert.equal((await bridge.readOriginalResource({path:'/write',headers})).status,400);
  assert.equal(calls,1);
});

test('original resource allowlist includes editor/dashboard pages, selected bootstrap GETs and JS/CSS/fonts',async()=>{
  const calls=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls.push(url);return new Response('fixture original',{headers:{'content-type':'application/octet-stream'}});
  }});
  await configure(bridge);
  const paths=['/write','/multi-write','/smart-multi-write','/mypage','/dashboard/insights','/dashboard/benchmark',
    '/dashboard/threads','/dashboard/personas','/dashboard/threads-manage','/dashboard/videos','/dashboard/revenue',
    '/onboarding/coupang','/onboarding/toss',
    '/api/auth/session','/api/subscription/status','/api/keys/accounts','/api/keys/status',
    ...['COUPANG','TOSS','THREADS','WDRB'].map(provider=>'/api/keys/status?provider='+provider),
    '/_next/static/chunks/fixture.js','/_next/static/css/fixture.css','/_next/static/media/fixture.woff2',
    '/_next/static/media/fixture.ttf','/_next/static/chunks/app/%5Bfixture%5D/page.js'];
  for(const path of paths)assert.equal((await bridge.readOriginalResource({path})).status,200);
  assert.equal(calls.length,paths.length);
  assert.ok(calls.every(url=>new URL(url).origin==='https://drt.agczero.com'));
});

test('original resource redirects remain manual and only same-origin Location values are relayed',async()=>{
  for(const location of ['/purchaseMonth/dreath-m-30?fixture=1','https://drt.agczero.com/write?fixture=1']){
    let calls=0;
    const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
      calls++;if(new URL(url).pathname==='/api/trends/google')return google();
      assert.equal(options.redirect,'manual');
      return new Response('fixture redirect body',{status:307,headers:{location,'set-cookie':'fixture=rotation'}});
    }});
    await configure(bridge);
    const result=await bridge.readOriginalResource({path:'/write'});
    assert.equal(result.status,307);assert.equal(result.body.toString(),'fixture redirect body');
    assert.equal(result.headers.location,new URL(location,'https://drt.agczero.com').pathname+new URL(location,'https://drt.agczero.com').search);
    assert.equal(result.headers['set-cookie'],undefined);assert.equal(calls,2);
  }
  for(const location of ['https://fixture.invalid/write','//fixture.invalid/write','https://fixture-user@drt.agczero.com/write']){
    let calls=0;
    const bridge=new LiveTrendsBridge({fetchImpl:async url=>{
      calls++;return new URL(url).pathname==='/api/trends/google'?google():new Response(null,{status:302,headers:{location}});
    }});
    await configure(bridge);
    const result=await bridge.readOriginalResource({path:'/write'});
    assert.equal(result.status,502);assert.equal(error(result),'upstream_resource_redirect_rejected');
    assert.equal(result.headers.location,undefined);assert.equal(calls,2);noSessionValues(result);
  }
});

test('original resource 401 clears the session and cannot disclose the upstream error or cached trend data',async()=>{
  let release,signal;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/api/trends/google')return google();
    if(path==='/api/trends/datalab'){signal=options.signal;return new Promise(resolve=>{release=resolve;});}
    return json({sensitive:SESSION_A},{status:401});
  }});
  await configure(bridge);
  const pending=bridge.request(local('/api/trends/datalab'));
  const result=await bridge.readOriginalResource({path:'/write'});
  assert.equal(result.status,401);assert.equal(error(result),'session_expired');assert.equal(bridge.status().configured,false);
  assert.equal(signal.aborted,true);
  release(datalab());assert.equal((await pending).status,409);
  assert.equal((await bridge.request(local('/api/trends/google'))).status,401);
  assert.equal((await bridge.readOriginalResource({path:'/write'})).status,401);
  noSessionValues(result);noSessionValues(bridge.status());
});

test('original resource 403 preserves credentials and unrelated inflight reads without disclosing the upstream error',async()=>{
  let release,signal;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/api/trends/google')return google();
    assert.equal(options.headers.cookie,'next-auth.session-token='+SESSION_A);
    if(path==='/write'){signal=options.signal;return new Promise(resolve=>{release=resolve;});}
    return json({sensitive:SESSION_A},{status:403});
  }});
  await configure(bridge);
  const pending=bridge.readOriginalResource({path:'/write'});
  const result=await bridge.readOriginalResource({path:'/mypage'});
  assert.equal(result.status,403);assert.equal(error(result),'access_denied');
  assert.equal(bridge.status().configured,true);assert.equal(bridge.status().state,'access-denied');
  assert.equal(signal.aborted,false);
  release(new Response('fixture original document',{headers:{'content-type':'text/html'}}));
  const allowed=await pending;assert.equal(allowed.status,200);assert.equal(allowed.body.toString(),'fixture original document');
  assert.equal((await bridge.request(local('/api/trends/google'))).status,200);
  assert.equal((await bridge.readOriginalResource({path:'/mypage'})).status,403);
  noSessionValues(result);noSessionValues(bridge.status());
});

test('cleared resource reads discard late bytes and resource failures contain no submitted secrets',async()=>{
  let release,signal;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    signal=options.signal;return new Promise(resolve=>{release=resolve;});
  }});
  await configure(bridge);
  const pending=bridge.readOriginalResource({path:'/write'});bridge.clear();
  assert.equal(signal.aborted,true);
  release(new Response('fixture old document',{headers:{'content-type':'text/html'}}));
  assert.equal((await pending).status,409);assert.equal(bridge.status().configured,false);
  for(const makeResponse of [()=>{throw new Error(SESSION_A);},()=>new Response('fixture',{headers:{'content-length':String(16*1024*1024+1)}}),()=>new Response(new Uint8Array(16*1024*1024+1))]){
    const failing=new LiveTrendsBridge({fetchImpl:async url=>new URL(url).pathname==='/api/trends/google'?google():makeResponse()});
    await configure(failing);
    const result=await failing.readOriginalResource({path:'/write'});
    assert.equal(result.status,502);noSessionValues(result);noSessionValues(failing.status());
  }
});

test('workflow policy permits source-observed workflows and excludes unrelated routes',async()=>{
  const {matchesWorkflowRequest,workflowPolicySource}=await import('./workflow-policy.mjs');
  assert.ok(workflowPolicySource.rules.length>0);
  for(const [path,method] of [['/api/threads','POST'],['/api/threads?id=fixture','PATCH'],['/api/threads/schedule','POST'],
    ['/api/threads-manage/publish-single','POST'],['/api/batch-sessions?sessionId=fixture','DELETE'],
    ['/api/personas?_t=fixture','GET'],['/api/mypage/format-settings?_t=fixture','GET'],['/api/templates/comment','GET'],
    ['/api/keys/status?provider=AI','GET'],['/api/keys/active-decrypted','GET'],['/api/auth/threads?returnTo=/dashboard/threads-manage','GET'],
    ['/api/auth/threads/disconnect?accountId=fixture-account','DELETE'],['/api/keys/accounts','PATCH'],['/api/keys/accounts','PUT'],
    ['/api/keys/provider','POST'],['/api/keys/provider?keyId=fixture&provider=GEMINI','DELETE'],['/api/keys/wdrb','GET'],['/api/generate','POST'],
    ['/api/wdrb/links','POST'],['/api/errors/report','POST'],
    ['/api/coupang/deeplink','POST'],['/api/shopping/toss/search?q=fixture','GET'],['/api/billingMonth/userBilling','POST'],['/api/billingMonth/cancel','POST'],['/api/keys/extension','POST']])
    assert.equal(matchesWorkflowRequest(path,method),true);
  for(const [path,method] of [['/api/__workflow_unknown','GET'],['/api/keys/accounts','POST'],['/api/auth/session','POST'],
    ['/api/keys/status?provider=INVALID','GET'],['/api/keys/extension?rotate=true','POST'],['/api/keys/extension','GET'],
    ['/api/billing','POST'],['/api/billingMonth/pay','POST'],['/api/billingMonth/register','POST'],['/api/threads','HEAD'],['https://fixture.invalid/api/threads','POST'],
    ['//fixture.invalid/api/threads','POST'],['/api/threads/../keys/accounts','POST'],['/api/%2e%2e/threads','POST'],
    ['/api/threads%2fschedule','POST'],['/api/threads?source=fixture#fragment','POST']])
    assert.equal(matchesWorkflowRequest(path,method),false);
  assert.equal(matchesWorkflowRequest('/api/threads?id=fixture&source=first%0Asecond','PATCH'),true);
});

test('affiliate and provider key writes use fixed original destinations and reject malformed credentials before fetching',async()=>{
  const calls=[];let refused=false;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls.push({url,options});return new Response(refused?'{"error":"original-denial"}':'{"success":true}',{status:refused?403:200,headers:{'content-type':'application/json'}});
  }});await configure(bridge);
  for(const provider of ['coupang','toss']){
    const body=Buffer.from(JSON.stringify({accessKey:'fixture-access',secretKey:'fixture-secret',...(provider==='toss'?{publisherId:'fixture-id'}:{})}));
    const result=await bridge.forwardOriginalRequest({path:'/api/keys/'+provider,method:'POST',headers:{'content-type':'application/json'},body});
    assert.equal(result.status,200);assert.equal(calls.at(-1).url,'https://drt.agczero.com/api/keys/'+provider);assert.deepEqual(calls.at(-1).options.body,body);
    assert.equal(calls.at(-1).options.headers.cookie,'next-auth.session-token='+SESSION_A);
  }
  const before=calls.length;
  for(const [path,body]of [['/api/keys/coupang',Buffer.from('{}')],['/api/keys/toss',Buffer.from('{}')]])
    assert.equal((await bridge.forwardOriginalRequest({path,method:'POST',body})).status,400);
  assert.equal(calls.length,before);
  const provider=await bridge.forwardOriginalRequest({path:'/api/keys/provider',method:'POST',body:Buffer.from('{}')});
  assert.equal(provider.status,200);assert.equal(calls.length,before+1);
  refused=true;const denial=await bridge.forwardOriginalRequest({path:'/api/keys/coupang',method:'POST',body:Buffer.from('{"accessKey":"fixture","secretKey":"fixture"}')});
  assert.equal(denial.status,403);assert.equal(JSON.parse(denial.body).error,'original-denial');assert.ok(!JSON.stringify(bridge.status()).includes('fixture-secret'));
});

test('extension key requests retain upstream credentials and 403 decisions without logging or fabricating a token',async()=>{
  const calls=[];let refused=false;
  const responseBytes=Buffer.from('{"token":"fixture-extension-sensitive-value"}');
  const denial=Buffer.from('{"error":"premium_required"}');
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls.push({url,options});return new Response(refused?denial:responseBytes,{status:refused?403:200,headers:{'content-type':'application/json'}});
  }});
  await configure(bridge);
  assert.equal((await bridge.forwardOriginalRequest({path:'/api/keys/extension',method:'POST',body:Buffer.from('{}')})).status,400);
  assert.equal(calls.length,0);
  const issued=await bridge.forwardOriginalRequest({path:'/api/keys/extension',method:'POST'});
  assert.equal(issued.status,200);assert.deepEqual(issued.body,responseBytes);
  assert.equal(calls[0].options.headers.cookie,'next-auth.session-token='+SESSION_A);
  assert.ok(!JSON.stringify(bridge.status()).includes('fixture-extension-sensitive-value'));
  refused=true;const result=await bridge.forwardOriginalRequest({path:'/api/keys/extension',method:'POST'});
  assert.equal(result.status,403);assert.deepEqual(result.body,denial);assert.equal(bridge.status().configured,true);
});

test('original media proxy retains byte ranges and response metadata without forwarding credentials to media hosts',async()=>{
  let seen,calls=0;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls++;seen={url,options};return new Response(new Uint8Array([1,2,3]),{status:206,
      headers:{'content-type':'video/mp4','content-range':'bytes 0-2/100','accept-ranges':'bytes',etag:'"fixture"'}});
  }});
  await configure(bridge);
  const path='/api/proxy-media?url='+encodeURIComponent('https://media.fixture.invalid/video.mp4');
  const result=await bridge.forwardOriginalRequest({path,headers:{range:'bytes=0-2','if-range':'"fixture"'}});
  assert.equal(result.status,206);assert.deepEqual(result.body,Buffer.from([1,2,3]));
  assert.equal(result.headers['content-range'],'bytes 0-2/100');assert.equal(result.headers['accept-ranges'],'bytes');
  assert.equal(new URL(seen.url).origin,'https://drt.agczero.com');assert.equal(seen.options.headers.range,'bytes=0-2');
  assert.equal((await bridge.forwardOriginalRequest({path,headers:{range:'bytes=0-2,7-9'}})).status,400);assert.equal(calls,1);
});

test('workflow writes preserve raw body/error bytes and never forward caller credentials or auth response headers',async()=>{
  const body=Buffer.from(' { "main_content": "fixture text", "status": "DRAFT" }\n');
  const responseBytes=Buffer.from(' { "error": "fixture validation" }\n');
  const calls=[];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls.push({url,options});
    return new Response(responseBytes,{status:422,headers:{'content-type':'application/json','set-cookie':'fixture=rotation','www-authenticate':'fixture challenge','authorization':'fixture private'}});
  }});
  await configure(bridge);
  const result=await bridge.forwardOriginalRequest({path:'/api/threads?fixture=1',method:'POST',body,
    headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:SESSION_B,Authorization:SESSION_B,Origin:'https://fixture.invalid',Referer:'https://fixture.invalid','X-Rea-Workflow-Token':'fixture-local-token'}});
  assert.equal(result.status,422);assert.deepEqual(result.body,responseBytes);
  assert.equal(result.headers['x-rea-body-representation'],'live-original-workflow');
  for(const name of ['set-cookie','authorization','www-authenticate','proxy-authenticate'])assert.equal(result.headers[name],undefined);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://drt.agczero.com/api/threads?fixture=1');
  assert.equal(calls[0].options.method,'POST');assert.deepEqual(calls[0].options.body,body);
  assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.headers.cookie,'next-auth.session-token='+SESSION_A);
  assert.equal(calls[0].options.headers.origin,'https://drt.agczero.com');
  assert.equal(calls[0].options.headers.referer,'https://drt.agczero.com/write');
  assert.equal(calls[0].options.headers['content-type'],'application/json');
  assert.equal(calls[0].options.headers.authorization,undefined);assert.equal(calls[0].options.headers['x-rea-workflow-token'],undefined);
  noSessionValues(result);noSessionValues(bridge.status());
});

test('workflow SSE and file responses retain bytes and workflow GETs are not cached',async()=>{
  let calls=0;
  const chunks=['data: {"fixture":1}\n\n','data: {"fixture":2}\n\n','data: [DONE]\n\n'];
  const bridge=new LiveTrendsBridge({fetchImpl:async(url)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    calls++;
    if(new URL(url).pathname==='/api/generate/rewrite')return new Response(new ReadableStream({start(controller){
      for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();
    }}),{headers:{'content-type':'text/event-stream'}});
    return new Response(new Uint8Array([0,255,128,65]),{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="fixture.bin"'}});
  }});
  await configure(bridge);
  const streamed=await bridge.forwardOriginalRequest({path:'/api/generate/rewrite',method:'POST',body:Buffer.from('{}')});
  assert.equal(Buffer.from(await new Response(streamed.stream).arrayBuffer()).toString(),chunks.join(''));assert.equal(streamed.headers['content-type'],'text/event-stream');
  const first=await bridge.forwardOriginalRequest({path:'/api/videos'});
  assert.deepEqual(first.body,Buffer.from([0,255,128,65]));
  assert.equal(first.headers['content-disposition'],'attachment; filename="fixture.bin"');
  await bridge.forwardOriginalRequest({path:'/api/videos'});assert.equal(calls,3);
});

test('workflow SSE exposes the first chunk before upstream EOF and consumer cancellation aborts upstream', {timeout:3000}, async()=>{
  let source,signal,cancelled=false;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    signal=options.signal;
    return new Response(new ReadableStream({
      start(controller){source=controller;controller.enqueue(new TextEncoder().encode('data: first\n\n'))},
      cancel(){cancelled=true}
    }),{headers:{'content-type':'text/event-stream; charset=utf-8','set-cookie':'fixture-secret'}});
  }});
  await configure(bridge);
  const result=await bridge.forwardOriginalRequest({path:'/api/generate/rewrite',method:'POST'});
  assert.equal(result.status,200);assert.equal(result.body,undefined);assert.equal(result.headers['set-cookie'],undefined);
  const reader=result.stream.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'data: first\n\n');
  assert.equal(signal.aborted,false);
  await reader.cancel();assert.equal(signal.aborted,true);assert.equal(cancelled,true);
  assert.ok(source);
});

test('clearing a session terminates an active workflow stream without returning further old-session bytes', {timeout:3000}, async()=>{
  let source;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    return new Response(new ReadableStream({start(controller){source=controller}}),{headers:{'content-type':'text/event-stream'}});
  }});
  await configure(bridge);
  const result=await bridge.forwardOriginalRequest({path:'/api/generate/rewrite',method:'POST'});
  const reader=result.stream.getReader();const pending=reader.read();
  bridge.clear();source.enqueue(new TextEncoder().encode('old session payload'));
  await assert.rejects(pending,/session_changed/);
  assert.equal(bridge.status().configured,false);
});

test('workflow request bounds and unsupported methods cannot perform any upstream call',async()=>{
  let calls=0;
  const bridge=new LiveTrendsBridge({fetchImpl:async()=>{calls++;return google();}});await configure(bridge);
  for(const input of [
    {path:'/api/threads',method:'OPTIONS'},
    {path:'/api/auth/session',method:'POST'},
    {path:'/api/threads',method:'POST',body:'fixture-not-a-buffer'},
    {path:'/api/threads',method:'GET',body:Buffer.from('fixture')},
    {path:'/api/threads',method:'POST',headers:{'Content-Type':'application/json\r\nX-Injected: fixture'}},
    {path:'/api/threads?source='+'x'.repeat(65536),method:'POST'}
  ])assert.equal((await bridge.forwardOriginalRequest(input)).status,400);
  assert.equal((await bridge.forwardOriginalRequest({path:'/api/upload',method:'POST',body:Buffer.alloc(64*1024*1024+1)})).status,413);
  assert.equal(calls,1);
});

test('workflow auth failures clear credentials without exposing original errors or redirect targets',async()=>{
  let calls=0;
  const bridge=new LiveTrendsBridge({fetchImpl:async url=>{
    calls++;
    return new URL(url).pathname==='/api/trends/google'?google():new Response(SESSION_A,{status:401,headers:{location:'https://fixture.invalid/'+SESSION_A}});
  }});
  await configure(bridge);
  const result=await bridge.forwardOriginalRequest({path:'/api/threads',method:'POST'});
  assert.equal(result.status,401);assert.equal(bridge.status().configured,false);
  assert.equal(result.headers.location,undefined);assert.equal(calls,2);noSessionValues(result);
  assert.equal((await bridge.forwardOriginalRequest({path:'/api/threads',method:'POST'})).status,401);
  assert.equal(calls,2);
});

test('workflow redirects fail closed without clearing credentials or cancelling unrelated inflight replies',async()=>{
  for(const [method,status]of [['GET',302],['POST',307]]){
    let release,signal,started;
    const ready=new Promise(resolve=>{started=resolve});
    const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
      assert.equal(options.headers.cookie,'next-auth.session-token='+SESSION_A);
      const path=new URL(url).pathname;
      if(path==='/api/trends/google')return google();
      if(path==='/api/personas'){signal=options.signal;started();return new Promise(resolve=>{release=resolve})}
      if(path==='/api/threads')return new Response(SESSION_A,{status,headers:{location:'https://fixture.invalid/'+SESSION_A,'set-cookie':'next-auth.session-token='+SESSION_B}});
      return json({data:[]});
    }});
    await configure(bridge);
    const pending=bridge.forwardOriginalRequest({path:'/api/personas'});await ready;
    const result=await bridge.forwardOriginalRequest({path:'/api/threads',method});
    assert.equal(result.status,502);assert.equal(error(result),'upstream_workflow_redirect_rejected');
    assert.equal(result.headers.location,undefined);assert.equal(result.headers['set-cookie'],undefined);
    assert.equal(bridge.status().configured,true);assert.equal(signal.aborted,false);
    noSessionValues(result);noSessionValues(bridge.status());
    release(json({personas:[]}));assert.equal((await pending).status,200);
    assert.equal((await bridge.forwardOriginalRequest({path:'/api/templates/comment'})).status,200);
    assert.equal(bridge.status().configured,true);
  }
});

test('workflow permission refusal preserves original 403 bytes, session, and other pending replies',async()=>{
  let release;
  const refused=Buffer.from('{"error":"subscription_required","feature":"save"}');
  const bridge=new LiveTrendsBridge({fetchImpl:async(url)=>{
    const path=new URL(url).pathname;
    if(path==='/api/trends/google')return google();
    if(path==='/api/personas')return new Promise(resolve=>{release=resolve});
    return new Response(refused,{status:403,headers:{'content-type':'application/json'}});
  }});
  await configure(bridge);
  const pending=bridge.forwardOriginalRequest({path:'/api/personas'});
  await new Promise(resolve=>setImmediate(resolve));
  const result=await bridge.forwardOriginalRequest({path:'/api/threads',method:'POST'});
  assert.equal(result.status,403);assert.deepEqual(result.body,refused);
  assert.equal(bridge.status().configured,true);assert.equal(bridge.status().state,'connected');
  release(json({personas:[]}));assert.equal((await pending).status,200);
  assert.equal((await bridge.request(local('/api/trends/google'))).status,200);
});

test('workflow clear invalidates pending replies and oversized/network failures return sanitized errors',async()=>{
  let release,signal;
  const bridge=new LiveTrendsBridge({fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/trends/google')return google();
    signal=options.signal;return new Promise(resolve=>{release=resolve;});
  }});
  await configure(bridge);
  const pending=bridge.forwardOriginalRequest({path:'/api/threads',method:'POST'});
  await new Promise(resolve=>setImmediate(resolve));
  bridge.clear();assert.equal(signal.aborted,true);
  release(new Response('fixture old reply'));
  assert.equal((await pending).status,409);assert.equal(bridge.status().configured,false);
  for(const makeResponse of [()=>{throw new Error(SESSION_A);},
    ()=>new Response('fixture',{headers:{'content-length':String(64*1024*1024+1)}}),
    ()=>new Response(new Uint8Array(64*1024*1024+1))]){
    const failing=new LiveTrendsBridge({fetchImpl:async url=>new URL(url).pathname==='/api/trends/google'?google():makeResponse()});
    await configure(failing);
    const result=await failing.forwardOriginalRequest({path:'/api/threads',method:'POST'});
    assert.equal(result.status,502);noSessionValues(result);noSessionValues(failing.status());
  }
});
