import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const original=await readFile(new URL('./extension-inspection/original/content.js',import.meta.url),'utf8');
const selectors=original.slice(original.indexOf('function findOriginalPostContainer(target) {'),original.indexOf('async function handleScrapClick() {'));
const selection=original.slice(original.indexOf('async function handleScrapClick() {'),original.indexOf('function hasActionButtonInScope(scopeEl) {'));
const bridge=await readFile(new URL('./extension-local-post-bridge.js',import.meta.url),'utf8');

// Exercise the retained original selector and selection handler. These minimal
// DOM objects record capture/selection; they do not replace the scraper logic.
async function fixture({page='https://www.threads.com/@author/post/target',target=page,codes=['target']}={}){
  const listeners=new Map(),nodes=new Map(),captures=[],alerts=[];
  let listener,buttonClicks=0;
  const addEventListener=(type,handler)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler)};
  const removeEventListener=(type,handler)=>listeners.get(type)?.delete(handler);
  const dispatch=event=>{for(const handler of [...(listeners.get(event.type)??[])])handler(event);return !event.defaultPrevented};
  const containers=codes.map(code=>{
    const classes=new Set();
    return {code,classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)},
      querySelectorAll:()=>[],closest:()=>null,parentElement:null};
  });
  const links=containers.map(container=>({
    isConnected:true,getAttribute:()=>'/@author/post/'+container.code,
    closest:selector=>selector==='[data-pressable-container="true"], article, div[role="article"]'?container:null,
    dispatchEvent(event){event.target=this;return dispatch(event)}
  }));
  const document={readyState:'complete',body:{},documentElement:{},
    getElementById:id=>nodes.get(id)??null,
    querySelectorAll:selector=>selector==='.drt-highlight'?containers.filter(row=>row.classList.contains('drt-highlight')):links,
    querySelector:selector=>selector==='.drt-highlight'?containers.find(row=>row.classList.contains('drt-highlight'))??null:null,
    createElement:()=>({set id(value){this.nodeId=value},remove(){nodes.delete(this.nodeId)}}),
    head:{appendChild(node){nodes.set(node.nodeId,node)}},addEventListener,removeEventListener,dispatchEvent:dispatch};
  const button={dataset:{},style:{},innerHTML:'스크랩',disabled:false,click(){buttonClicks++;context.handleScrapClick()}};
  nodes.set('dreaths-scrap-btn',button);
  class Event{constructor(type,options){this.type=type;Object.assign(this,options)}preventDefault(){this.defaultPrevented=true}stopPropagation(){}}
  const context=vm.createContext({document,location:new URL(page),URL,MouseEvent:Event,KeyboardEvent:Event,
    window:{alert:message=>alerts.push(message)},chrome:{runtime:{onMessage:{addListener(value){listener=value}}}},
    setTimeout:callback=>{queueMicrotask(callback);return 0},
    processContainer:container=>captures.push(container.code),updateScrapButtonCountUI:()=>{}});
  vm.runInContext('let isSelectionMode=false;\n'+selectors+'\n'+selection+'\n'+bridge,context);
  const response=await new Promise(resolve=>listener({action:'DREATHS_LOCAL_SCRAP_PAGE',url:target},null,resolve));
  return{response,captures,buttonClicks,button,alerts,context};
}

test('link collection selects the requested post through the original handler',async()=>{
  const result=await fixture({codes:['unrelated','target','other']});
  assert.equal(result.response.success,true);
  assert.deepEqual(result.captures,['target']);
  assert.equal(result.buttonClicks,1);
  assert.equal(result.button.dataset.inSelection,'false');
});

test('canonical Threads hostname redirects retain the same shortcode',async()=>{
  const result=await fixture({page:'https://www.threads.com/@author/post/target',target:'https://www.threads.net/t/target'});
  assert.equal(result.response.success,true);assert.deepEqual(result.captures,['target']);
});

test('an absent matching post never clicks or extracts an unrelated post',async()=>{
  const result=await fixture({codes:['unrelated']});
  assert.equal(result.response.success,false);assert.deepEqual(result.captures,[]);assert.equal(result.buttonClicks,0);
  assert.equal(result.context.window.__DREATHS_LOCAL_AUTOSCRAP__,false);
});

test('navigation to another post is rejected before selection',async()=>{
  const result=await fixture({target:'https://www.threads.com/@author/post/another'});
  assert.equal(result.response.success,false);assert.deepEqual(result.captures,[]);assert.equal(result.buttonClicks,0);
});

test('a non Threads target is rejected even when shortcode matches',async()=>{
  const result=await fixture({target:'https://example.com/@author/post/target'});
  assert.equal(result.response.success,false);assert.deepEqual(result.captures,[]);assert.equal(result.buttonClicks,0);
});
