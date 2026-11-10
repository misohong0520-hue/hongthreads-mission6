import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {patchDevelopmentMarkup,patchDevelopmentScript} from './patch-server-markup.mjs';
import {parse} from 'parse5';
import {loadRuntimeAssets,rewriteDocument,ORIGINAL_PAGES} from '../mission6/render.mjs';

const button='<button class="mr-1.5 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider text-white bg-indigo-600 hover:bg-indigo-700 transition-all rounded-sm shadow-sm">구독</button>';
const expiry='<span class="text-[9px] font-bold text-rose-600 mt-0.5 truncate w-full">사용기한 만료</span>';
const markup=inside=>Buffer.from('<html><body><aside>'+inside+'</aside><main>원본 본문</main><script>window.original=true</script></body></html>');

test('only exact source-known sidebar nodes are removed and unrelated bytes remain intact',()=>{
  const source=markup('<div>원본 계정</div>'+button+expiry);
  const result=patchDevelopmentMarkup(source);
  assert.equal(result.removed_nodes.length,2);
  assert.equal(result.bytes.toString(),markup('<div>원본 계정</div>').toString());
});

test('active account, missing UI and already-patched markup do not break original HTML rendering',()=>{
  for(const inside of [button+expiry.replace('사용기한 만료','2027년 1월 1일까지 사용'),expiry,'<div>유효한 계정</div>','']){
    const result=patchDevelopmentMarkup(markup(inside));
    assert.ok(result.bytes.toString().includes('원본 본문'));
    if(inside.includes('2027년'))assert.ok(result.bytes.toString().includes('2027년'));
    assert.deepEqual(patchDevelopmentMarkup(result.bytes).bytes,result.bytes);
  }
});

test('unrecognised classes, duplicate matches and multiple sidebars are preserved conservatively',()=>{
  for(const source of [markup(button.replace('mr-1.5','mr-2')),markup(button+button),Buffer.from('<aside>'+button+'</aside><aside>'+expiry+'</aside>')])
    assert.deepEqual(patchDevelopmentMarkup(source).bytes,source);
});

const capturedLayout=async name=>{
  const root=new URL('../replay/workflow-development/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',root)));
  const record=manifest.records.find(item=>new RegExp('/app/'+name+'/layout-[a-f0-9]+\\.js$').test(item.path));
  assert.ok(record,'captured '+name+' layout must be available');
  return readFile(new URL(record.file,root));
};

// Exercise the retained layout function, including evaluation of its JSX props.
// A string/syntax assertion alone would miss an injected free route variable.
const renderCapturedLayout=(bytes,moduleId,pathname)=>{
  let modules;
  runInNewContext(bytes.toString(),{self:{webpackChunk_N_E:{push:chunk=>{modules=chunk[1]}}}},{timeout:1000});
  assert.equal(typeof modules?.[moduleId],'function');
  const jsx=(type,props)=>({type,props});
  const imports={
    3827:{jsx,jsxs:jsx,Fragment:'fragment'},
    64090:{useState:value=>[typeof value==='function'?value():value,()=>{}],useEffect:()=>{}},
    47907:{useRouter:()=>({push:()=>{}}),usePathname:()=>pathname,useSearchParams:()=>({get:()=>null})},
    31441:{Z:'sidebar'},16112:{Z:'footer'},7489:{r:'tutorial'},71560:{M:'mobile-tutorial'},
    41919:{TUTORIAL_VIDEOS:{}}
  };
  const require=id=>{
    assert.ok(Object.hasOwn(imports,id),'unexpected layout dependency '+id);
    return imports[id];
  };
  require.r=()=>{};
  require.d=(exports,getters)=>{
    for(const [name,get] of Object.entries(getters))Object.defineProperty(exports,name,{get});
  };
  const exports={};
  modules[moduleId]({},exports,require);
  return exports.default({children:'retained page content'});
};
const renderedNodes=node=>[
  ...(node&&typeof node==='object'&&Object.hasOwn(node,'props')?[node]:[]),
  ...[node?.props?.children].flat(Infinity).filter(child=>child&&typeof child==='object').flatMap(renderedNodes)
];

test('captured mypage layout renders after branding without a dashboard-only route variable',async()=>{
  const output=patchDevelopmentScript(await capturedLayout('mypage'));
  const tree=renderCapturedLayout(output,17472,'/mypage');
  const heading=renderedNodes(tree).find(node=>node.type==='h2');
  assert.ok(heading,'mypage heading remains present');
  assert.equal(heading.props['data-hongthreads-archive'],undefined);
  assert.ok(heading.props.children.includes('마이페이지관리'));
  assert.deepEqual(patchDevelopmentScript(output),output,'branding must be idempotent');
});

test('captured dashboard applies the archive case marker only on the videos page',async()=>{
  const output=patchDevelopmentScript(await capturedLayout('dashboard'));
  const videos=renderCapturedLayout(output,90253,'/dashboard/videos');
  const archiveHeading=renderedNodes(videos).find(node=>node.type==='h2');
  assert.equal(archiveHeading?.props['data-hongthreads-archive'],'true');
  assert.ok(archiveHeading.props.children.includes('Threads Archive'));
  const insights=renderCapturedLayout(output,90253,'/dashboard/insights');
  const insightsHeading=renderedNodes(insights).find(node=>node.type==='h2');
  assert.equal(insightsHeading?.props['data-hongthreads-archive'],undefined);
  assert.ok(insightsHeading.props.children.includes('트렌드 & 인사이트'));
  assert.deepEqual(patchDevelopmentScript(output),output,'branding must be idempotent');
});

test('every public original page resolves its styles without an original account session',async()=>{
  const runtime=await loadRuntimeAssets();
  const ctx={csrfToken:'test-browser-token',bridge:{status:()=>({configured:false})}};
  for(const path of ORIGINAL_PAGES){
    const document=runtime.documents.get(path);
    assert.ok(document,'retained document missing: '+path);
    const html=rewriteDocument(document.bytes,{ctx,profile:null,vertex:{},publicOrigin:'https://hongthreads.example'}).toString();
    assert.ok(html.includes('property="og:image" content="https://hongthreads.example/social/hongthreads-v1.png"'));
    const tree=parse(html);
    const links=[];
    const walk=node=>{if(node.tagName==='link'&&node.attrs?.some(a=>a.name==='rel'&&a.value==='stylesheet'))links.push(node.attrs.find(a=>a.name==='href')?.value);for(const child of node.childNodes??[])walk(child)};
    walk(tree);
    assert.ok(links.length,'styles missing: '+path);
    for(const href of links){
      const asset=runtime.assets.get(new URL(href,'https://drt.agczero.com').pathname);
      assert.ok(asset&&/text\/css/.test(asset.type)&&asset.bytes.length,path+' cannot load '+href+' before account connection');
    }
  }
});
