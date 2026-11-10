import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {parse}=require('@babel/parser');
const SOURCE='8318610e57c69f041f5d2573bd45ef90eb78f518ac2222ddd50b2eb927f881b8';
const LIVE='(typeof window!=="undefined"&&window.__REA_REPLAY__?.benchmarkLive)';
const LOCAL='(typeof window!=="undefined"&&window.__REA_REPLAY__?.benchmarkLocal)';
const walk=(node,visit,parents=[])=>{
  if(!node?.type)return;visit(node,parents);
  for(const[key,value]of Object.entries(node)){
    if(['loc','extra','start','end','comments','tokens'].includes(key))continue;
    if(Array.isArray(value))value.forEach(child=>walk(child,visit,[...parents,node]));
    else if(value?.type)walk(value,visit,[...parents,node]);
  }
};
const one=(items,label)=>{if(items.length!==1)throw new Error(label+': expected one, got '+items.length);return items[0]};
export function benchmarkWorkflowEdits(source){
  if(createHash('sha256').update(source).digest('hex')!==SOURCE)throw new Error('Benchmark source witness changed');
  const ast=parse(source),all=[];walk(ast,(node,parents)=>all.push({node,parents}));
  const find=predicate=>all.filter(entry=>predicate(entry.node,entry.parents));
  const key=one(find(n=>n.type==='VariableDeclarator'&&n.id.name==='td'&&n.init?.type==='ArrowFunctionExpression'),'original key handler');
  const owner=key.parents.toReversed().find(n=>n.type==='FunctionDeclaration');
  const scrap=one(find(n=>n.type==='VariableDeclarator'&&n.id.name==='tF'&&n.start>owner.start&&n.end<owner.end),'original URL handler');
  const edits=[];
  const add=(node,replacement,id)=>edits.push({node,replacement,id});
  const originalKeyBody=source.slice(key.node.init.body.start+1,key.node.init.body.end-1);
  const receive='token=>{te(token);if('+LOCAL+'){localStorage.setItem("drt_ext_token_local",token)}else{localStorage.setItem(ti(),token);localStorage.removeItem("drt_ext_token")}}';
  add(key.node.init,'async(__reaRotate=false)=>{if('+LIVE+'){e7(true);return window.__REA_BENCHMARK__.issueKey(tr,'+receive+',__reaRotate===true)}'+originalKeyBody+'}','benchmark-key-response-and-errors');
  const initial=one(find(n=>n.type==='CallExpression'&&n.callee.name==='td'),'automatic first key issuance');
  const open=initial.parents.toReversed().find(n=>n.type==='ArrowFunctionExpression');
  const permissions=find(n=>n.type==='CallExpression'&&n.callee.name==='k'&&
    ['benchmark_jwt','benchmark_url_scrap'].includes(n.arguments[0]?.value)&&!(n.start>=key.node.start&&n.end<=key.node.end)&&!(n.start>=open.start&&n.end<=open.end));
  if(permissions.length!==2)throw new Error('Expected two URL UI permission checks');
  for(const[index,{node}]of permissions.entries())
    add(node,'('+LIVE+'||'+source.slice(node.start,node.end)+')','benchmark-development-request-'+index);
  if(source.slice(initial.node.start,initial.node.end)!=='td()')throw new Error('Original automatic key issuance changed');
  const cached=initial.parents.toReversed().find(n=>n.type==='ConditionalExpression').consequent;
  const fallbackOpen=source.slice(open.body.start+1,open.body.end-1).replace('k("benchmark_jwt")','('+LIVE+'||k("benchmark_jwt"))')
    .replace(source.slice(cached.start,cached.end),'('+source.slice(cached.start,cached.end)+',window.__REA_BENCHMARK__.trace("key_reused","OK"))');
  add(open,'async()=>{if('+LOCAL+'){e7(true);return window.__REA_BENCHMARK__.openLocalKey(tr,'+receive+',localStorage.getItem("drt_ext_token_local"))}'+fallbackOpen+'}','benchmark-key-reuse-log');
  const reissue=one(find(n=>n.type==='ObjectExpression'&&n.properties.some(p=>p.key?.name==='onClick'&&p.value.name==='td')&&
    source.slice(n.start,n.end).includes('새 연동 키 재발급')),'explicit key rotation button');
  add(reissue.node.properties.find(p=>p.key?.name==='onClick').value,'()=>td(true)','benchmark-local-key-rotation');
  const clipboard=one(find(n=>n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.property.name==='writeText'&&n.arguments[0]?.name==='e9'),'key clipboard');
  const callback=clipboard.parents.toReversed().find(n=>n.type==='ArrowFunctionExpression');
  add(callback,'async()=>{if('+LIVE+')return window.__REA_BENCHMARK__.copyKey(e9);'+source.slice(callback.body.start+1,callback.body.end-1)+'}','benchmark-clipboard-feedback');
  const input=one(find(n=>n.type==='ObjectExpression'&&n.properties.some(p=>p.key?.name==='value'&&p.value.name==='e9')&&
    n.properties.some(p=>p.key?.name==='readOnly'&&p.value.type==='UnaryExpression')),'key input');
  add({start:input.node.start+1,end:input.node.start+1},'"aria-label":"Chrome 확장 프로그램 JWT 연동 키",','benchmark-key-input-label');
  const install=one(find(n=>n.type==='StringLiteral'&&n.value.startsWith('https://chromewebstore.google.com/detail/dreaths-scraper/')),'original extension install link');
  add(install.node,'('+LOCAL+'?"/__local_benchmark/install":'+source.slice(install.node.start,install.node.end)+')','benchmark-local-install-link');
  const installLabel=one(find(n=>n.type==='ConditionalExpression'&&n.consequent?.value==='Chrome 웹스토어에서 설치'),'original extension install label');
  add(installLabel.node,'('+LOCAL+'?"로컬 확장 프로그램 설치":'+source.slice(installLabel.node.start,installLabel.node.end)+')','benchmark-local-install-label');
  const account=one(find(n=>n.type==='ArrayExpression'&&n.elements[0]?.value==='#'&&n.elements[1]?.name==='y'),'original key target account');
  add(account.node,'('+LOCAL+'?["내 PC"]:'+source.slice(account.node.start,account.node.end)+')','benchmark-local-key-target');
  const alerts=find(n=>n.type==='CallExpression'&&n.callee.name==='alert'&&n.start>scrap.node.start&&n.end<scrap.node.end);
  if(alerts.length!==3)throw new Error('Expected original URL result alerts');
  alerts.forEach(({node},index)=>add(node,'('+LIVE+'?void 0:'+source.slice(node.start,node.end)+')','benchmark-internal-url-result-'+index));
  const returned=one(owner.body.body.filter(n=>n.type==='ReturnStatement'),'benchmark component return');
  const navigation=one(find(n=>n.type==='VariableDeclarator'&&n.id.name==='tT'&&n.start>owner.start&&n.end<owner.end),'benchmark query navigation');
  const push=one(find(n=>n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.name==='r'&&n.callee.property.name==='push'&&n.start>navigation.node.start&&n.end<navigation.node.end),'benchmark router push');
  const destination=source.slice(push.node.arguments[0].start,push.node.arguments[0].end);
  // Next's native history integration updates useSearchParams without requesting
  // an incompatible upstream RSC tree for this locally retained document.
  add(push.node,'('+LOCAL+'?window.history.pushState(null,"",'+destination+'):'+source.slice(push.node.start,push.node.end)+')','benchmark-local-query-navigation');
  add({start:returned.start,end:returned.start},'(0,l.useEffect)(()=>{if(!'+LIVE+')return;let refresh=()=>{tu();tE($,et,Z,C,D)};window.addEventListener("rea:refresh-benchmark",refresh);return()=>window.removeEventListener("rea:refresh-benchmark",refresh)},[$,et,Z,C,D]);','benchmark-refresh-current-view');
  if(edits.length!==15)throw new Error('Expected fifteen source-bound benchmark patches');
  return edits;
}
