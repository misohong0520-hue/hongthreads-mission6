import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {benchmarkWorkflowEdits} from './patch-benchmark-workflow.mjs';
import {threadsManageUiEdits} from './patch-threads-manage-ui.mjs';
const root=import.meta.dirname,sourceRoot=join(root,'workflow-capture'),outputRoot=join(root,'workflow-development');
const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {parse}=require('@babel/parser');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await readFile(join(sourceRoot,'manifest.json'),'utf8'));
const prior=JSON.parse(await readFile(join(root,'../development/patch-manifest.json'),'utf8'));
const V='(typeof window!=="undefined"&&window.__REA_REPLAY__?.vertex?.provider==="VERTEX_WIF"&&window.__REA_REPLAY__.vertex.credentialReady)';
const nodes=(node,predicate)=>{
  const matches=[];const visit=n=>{if(!n||typeof n!=='object')return;if(n.type&&predicate(n))matches.push(n);
    for(const [key,value]of Object.entries(n)){if(['loc','extra','start','end','comments','tokens'].includes(key))continue;
      if(Array.isArray(value))value.forEach(child=>{if(child?.type)visit(child)});else if(value?.type)visit(value)}};visit(node);return matches;
};
const one=(items,label)=>{if(items.length!==1)throw new Error(label+': expected one node, got '+items.length);return items[0]};
const moduleNode=(ast,id)=>one(nodes(ast,n=>n.type==='ObjectProperty'&&n.key.type==='NumericLiteral'&&n.key.value===id),'module '+id).value;
const ands=node=>node.type==='LogicalExpression'&&node.operator==='&&'?[...ands(node.left),...ands(node.right)]:[node];
const records=[];
await mkdir(join(outputRoot,'objects'),{recursive:true});
for(const entry of manifest.records.filter(record=>record.status===200)){
  const original=await readFile(join(sourceRoot,entry.file));if(sha(original)!==entry.object_sha256)throw new Error('Captured object hash mismatch');
  let bytes=original;
  const old=prior.files.find(file=>file.source_sha256===entry.object_sha256&&file.path.endsWith(entry.path));
  if(old){bytes=await readFile(resolve(root,'../development/files',old.path));if(sha(bytes)!==old.development_sha256)throw new Error('Development base changed');}
  const base=bytes.toString('utf8'),edits=[];
  const add=(node,replacement,label)=>edits.push({id:label,start_utf16:node.start,end_utf16:node.end,replacement,original_sha256:sha(base.slice(node.start,node.end))});
  const protect=(ast,id,names)=>{
    const factory=moduleNode(ast,id);
    for(const name of names){const branch=one(nodes(factory,n=>n.type==='IfStatement'&&n.test.type==='UnaryExpression'&&n.test.operator==='!'&&n.test.argument.name===name&&
      nodes(n.consequent,c=>c.type==='StringLiteral'&&c.value.includes('404_NO_KEY')).length>0),'key guard '+id+'/'+name);
      add(branch.test,'('+base.slice(branch.test.start,branch.test.end)+'&&!'+V+')','wif-key-alternative-'+name);}
  };
  if(entry.path.endsWith('/6548-52cbf177130e4bef.js')){const ast=parse(base);protect(ast,10279,['d','u']);}
  if(entry.path.endsWith('/9465-7e4b5afa9614460c.js')){
    const ast=parse(base);protect(ast,68114,['C','O']);const factory=moduleNode(ast,68114);
    for(const [name,replacement]of [['R','window.__REA_REPLAY__.vertex.model'],['b','"/__vertex/generate"']]){
      const variable=one(nodes(factory,n=>n.type==='VariableDeclarator'&&n.id.name===name),'transport variable '+name);
      add(variable.init,'('+V+'?'+replacement+':'+base.slice(variable.init.start,variable.init.end)+')','wif-'+(name==='R'?'model':'destination'));
    }
    const branches=nodes(moduleNode(ast,89465),n=>n.type==='IfStatement').map(n=>ands(n.test)).filter(parts=>
      parts.length>=2&&parts[0].type==='BinaryExpression'&&parts[0].operator==='==='&&
      ((parts[0].left.type==='StringLiteral'&&parts[0].left.value==='GEMINI')||(parts[0].right.type==='StringLiteral'&&parts[0].right.value==='GEMINI'))&&parts[1].type==='Identifier');
    if(branches.length!==9)throw new Error('Expected nine auxiliary AI provider/key branches');
    for(const [index,parts]of branches.entries()){
      const range={start:parts[0].start,end:parts[1].end};add(range,'(('+base.slice(range.start,range.end)+')||'+V+')','wif-auxiliary-'+index);
    }
  }
  if(entry.path.includes('/app/multi-write/page-'))protect(parse(base),77872,['v']);
  if(entry.path.includes('/app/smart-multi-write/page-')){
    const factory=moduleNode(parse(base),93272);
    const variable=one(nodes(factory,n=>n.type==='VariableDeclarator'&&n.id.name==='g'&&n.init?.type==='ConditionalExpression'&&
      nodes(n.init,c=>c.type==='StringLiteral'&&c.value==='primary').length>0),'smart-multi credential pool');
    add(variable.init,'('+V+'&&b.provider==="VERTEX_WIF"&&b.credentialReady?b.credentials:'+base.slice(variable.init.start,variable.init.end)+')','wif-smart-multi-credential-pool');
  }
  if(entry.path.includes('/app/write/page-')){
    const ast=parse(base);const call=one(nodes(ast,n=>n.type==='CallExpression'&&n.callee.name==='eL'&&n.arguments.length===1&&
      n.arguments[0].type==='MemberExpression'&&n.arguments[0].property.name==='hasKey'),'smart editor credential status');
    const member=call.arguments[0],object=base.slice(member.object.start,member.object.end);
    add(member,'('+base.slice(member.start,member.end)+'||('+object+'.provider==="VERTEX_WIF"&&'+object+'.credentialReady))','wif-smart-editor-credential-status');
  }
  if(entry.path.endsWith('/1441-8b7f896123fa0f27.js')){
    const ast=parse(base);const call=one(nodes(moduleNode(ast,31441),n=>n.type==='CallExpression'&&n.callee.name==='O'&&
      nodes(n,c=>c.type==='MemberExpression'&&c.property.name==='hasKey').length===1),'sidebar AI status');
    const member=one(nodes(call,n=>n.type==='MemberExpression'&&n.property.name==='hasKey'),'sidebar key flag');
    const object=base.slice(member.object.start,member.object.end);
    add(member,'('+base.slice(member.start,member.end)+'||('+object+'.provider==="VERTEX_WIF"&&'+object+'.credentialReady))','wif-sidebar-credential-status');
  }
  if(entry.path.includes('/app/dashboard/threads/page-')){
    if(entry.object_sha256!=='1d7812379de1dd9b3d4c1559c351478bac6fe106323e1ee394147770f12a48b9')throw new Error('Draft view source changed');
    const ast=parse(base);
    const branch=one(nodes(ast,n=>n.type==='ConditionalExpression'&&nodes(n.alternate,c=>c.type==='StringLiteral'&&c.value==='내 게시물 보관함 이용 불가').length>0),'draft subscription view');
    const owner=one(nodes(ast,n=>n.type==='FunctionDeclaration'&&n.id?.name==='C'&&n.start<branch.start&&n.end>branch.end),'draft page component');
    // Match original SSR on the first render; enable the explicitly requested local
    // development view in an effect. Actual subscription/API authorization stays intact.
    add({start:owner.body.start+1,end:owner.body.start+1},'let[__reaDraftsView,__reaSetDraftsView]=(0,n.useState)(false);(0,n.useEffect)(()=>{window.__REA_REPLAY__?.developmentDraftView&&__reaSetDraftsView(true)},[]);','development-drafts-view-after-hydration');
    add(branch.test,'('+base.slice(branch.test.start,branch.test.end)+'||__reaDraftsView)','development-drafts-subscription-ui');
  }
  if(entry.path.includes('/app/dashboard/benchmark/page-')){
    for(const edit of benchmarkWorkflowEdits(base))add(edit.node,edit.replacement,edit.id);
  }
  if(entry.path.includes('/app/dashboard/threads-manage/page-')){
    for(const edit of threadsManageUiEdits(base))add(edit.node,edit.replacement,edit.id);
  }
  let output=base;
  const descending=[...edits].sort((a,b)=>b.start_utf16-a.start_utf16);
  for(let index=0;index<descending.length;index++){
    const edit=descending[index];if(index&&edit.end_utf16>descending[index-1].start_utf16)throw new Error('Overlapping workflow patches');
    output=output.slice(0,edit.start_utf16)+edit.replacement+output.slice(edit.end_utf16);
  }
  if(edits.length){parse(output);bytes=Buffer.from(output,'utf8');}
  const digest=sha(bytes),file='objects/'+digest;await writeFile(join(outputRoot,file),bytes);
  records.push({path:entry.path,media_type:entry.media_type,source_sha256:entry.object_sha256,base_sha256:sha(old?await readFile(resolve(root,'../development/files',old.path)):original),
    development_sha256:digest,file,changed:digest!==entry.object_sha256,patches:edits});
}
const patches=records.flatMap(record=>record.patches);
if(patches.length!==38)throw new Error('Expected nineteen Vertex, two draft-view, fifteen benchmark and two Threads UI patches, got '+patches.length);
const report={schema:'rea-workflow-development-overlay-v1',provider:'VERTEX_WIF',model:'gemini-3.8-flash',
  source_manifest_sha256:sha(await readFile(join(sourceRoot,'manifest.json'))),patch_count:patches.length,vertex_patch_count:19,development_view_patch_count:4,benchmark_patch_count:15,threads_manage_ui_patch_count:2,records,
  preserved:['Original prompt construction, media parts, generation configuration and response parsing','Original queue and retry logic','Original draft/storage/schedule/publish requests','Actual upstream subscription and account status'],
  changed:['Explicit local WIF authentication alternative and generateContent destination/model','AI readiness UI reads the explicit WIF credential state; hasKey is not falsified','Requested development draft view renders after hydration; server permission and subscription values stay unchanged','Render the existing Threads management detailed charts and AI controls in the local client; request account history through the original authorized API'],
  original_files_unchanged:true};
await writeFile(join(outputRoot,'manifest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({records:records.length,patch_count:patches.length,changed_assets:records.filter(record=>record.changed).map(record=>record.path)}));
