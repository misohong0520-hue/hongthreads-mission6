import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';

const release=process.argv[2]??'2026-11-06';
if(!/^\d{4}-\d{2}-\d{2}$/.test(release))throw new Error('Invalid release');
const root=join(import.meta.dirname,'client-updates',release);
const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {parse}=require('@babel/parser');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceBytes=await readFile(join(root,'manifest.json'));
const source=JSON.parse(sourceBytes);
if(source.schema!=='rea-current-editor-source-capture-v1')throw new Error('Unexpected capture schema');
const baseline=JSON.parse(await readFile(join(import.meta.dirname,'workflow-development/manifest.json'),'utf8'));
const V='(typeof window!=="undefined"&&window.__REA_REPLAY__?.vertex?.provider==="VERTEX_WIF"&&window.__REA_REPLAY__.vertex.credentialReady)';
const nodes=(node,predicate)=>{
  const matches=[];const visit=n=>{if(!n||typeof n!=='object')return;if(n.type&&predicate(n))matches.push(n);
    for(const[key,value]of Object.entries(n)){if(['loc','extra','start','end','comments','tokens'].includes(key))continue;
      if(Array.isArray(value))value.forEach(child=>{if(child?.type)visit(child)});else if(value?.type)visit(value)}};visit(node);return matches;
};
const one=(items,label)=>{if(items.length!==1)throw new Error(label+': expected one node, got '+items.length);return items[0]};
const moduleNode=(ast,id)=>one(nodes(ast,n=>n.type==='ObjectProperty'&&n.key.type==='NumericLiteral'&&n.key.value===id),'module '+id).value;
const ands=node=>node.type==='LogicalExpression'&&node.operator==='&&'?[...ands(node.left),...ands(node.right)]:[node];
const eligible=path=>/^\/_next\/static\/chunks\/(?:app\/(?:write|multi-write|smart-multi-write)\/page|9465|webpack)-[a-f0-9]+\.js$/.test(path);
const inputs=source.records.filter(record=>record.status===200&&eligible(record.path));
if(inputs.length!==5||new Set(inputs.map(record=>record.path)).size!==5)throw new Error('Expected five distinct current editor/transport/runtime assets');
const records=[];
await mkdir(join(root,'development/objects'),{recursive:true});
for(const entry of inputs){
  if(!/^objects\/[a-f0-9]{64}$/.test(entry.file))throw new Error('Invalid source object path');
  const original=await readFile(join(root,entry.file));if(sha(original)!==entry.object_sha256)throw new Error('Current source digest mismatch');
  const base=original.toString('utf8'),ast=parse(base),edits=[];
  const add=(node,replacement,id)=>edits.push({id,start_utf16:node.start,end_utf16:node.end,replacement,original_sha256:sha(base.slice(node.start,node.end))});
  const protect=(id,names)=>{
    const factory=moduleNode(ast,id);
    for(const name of names){
      const branch=one(nodes(factory,n=>n.type==='IfStatement'&&n.test.type==='UnaryExpression'&&n.test.operator==='!'&&n.test.argument.name===name&&
        nodes(n.consequent,c=>c.type==='StringLiteral'&&c.value.includes('404_NO_KEY')).length>0),'key guard '+id+'/'+name);
      add(branch.test,'('+base.slice(branch.test.start,branch.test.end)+'&&!'+V+')','wif-key-alternative-'+name);
    }
  };
  let expected=0;
  if(entry.path.includes('/app/multi-write/page-')){protect(77872,['v']);expected=1;}
  if(entry.path.includes('/app/smart-multi-write/page-')){
    const factory=moduleNode(ast,93272);
    const variable=one(nodes(factory,n=>n.type==='VariableDeclarator'&&n.init?.type==='ConditionalExpression'&&
      nodes(n.init,c=>c.type==='StringLiteral'&&c.value==='primary').length>0&&
      nodes(n.init,c=>c.type==='MemberExpression'&&c.object.name==='b'&&c.property.name==='keys').length>0),'smart-multi credential pool');
    add(variable.init,'('+V+'&&b.provider==="VERTEX_WIF"&&b.credentialReady?b.credentials:'+base.slice(variable.init.start,variable.init.end)+')','wif-smart-multi-credential-pool');expected=1;
  }
  if(entry.path.includes('/app/write/page-')){
    const call=one(nodes(ast,n=>n.type==='CallExpression'&&n.callee.name==='eL'&&n.arguments.length===1&&
      n.arguments[0].type==='MemberExpression'&&n.arguments[0].property.name==='hasKey'),'editor credential status');
    const member=call.arguments[0],object=base.slice(member.object.start,member.object.end);
    add(member,'('+base.slice(member.start,member.end)+'||('+object+'.provider==="VERTEX_WIF"&&'+object+'.credentialReady))','wif-smart-editor-credential-status');expected=1;
  }
  if(/\/9465-[a-f0-9]+\.js$/.test(entry.path)){
    protect(68114,['C','O']);const factory=moduleNode(ast,68114);
    for(const[name,replacement]of [['R','window.__REA_REPLAY__.vertex.model'],['b','"/__vertex/generate"']]){
      const variable=one(nodes(factory,n=>n.type==='VariableDeclarator'&&n.id.name===name),'transport variable '+name);
      add(variable.init,'('+V+'?'+replacement+':'+base.slice(variable.init.start,variable.init.end)+')','wif-'+(name==='R'?'model':'destination'));
    }
    const branches=nodes(moduleNode(ast,89465),n=>n.type==='IfStatement').map(n=>ands(n.test)).filter(parts=>
      parts.length>=2&&parts[0].type==='BinaryExpression'&&parts[0].operator==='==='&&
      ((parts[0].left.type==='StringLiteral'&&parts[0].left.value==='GEMINI')||(parts[0].right.type==='StringLiteral'&&parts[0].right.value==='GEMINI'))&&parts[1].type==='Identifier');
    if(branches.length!==9)throw new Error('Expected nine auxiliary AI provider/key branches');
    for(const[index,parts]of branches.entries()){
      const range={start:parts[0].start,end:parts[1].end};
      add(range,'(('+base.slice(range.start,range.end)+')||'+V+')','wif-auxiliary-'+index);
    }
    expected=13;
  }
  if(edits.length!==expected)throw new Error('Unexpected Vertex AST patch count for '+entry.path);
  const descending=[...edits].sort((a,b)=>b.start_utf16-a.start_utf16);let output=base;
  for(let index=0;index<descending.length;index++){
    const edit=descending[index];if(index&&edit.end_utf16>descending[index-1].start_utf16)throw new Error('Overlapping AST patches');
    output=output.slice(0,edit.start_utf16)+edit.replacement+output.slice(edit.end_utf16);
  }
  parse(output);const bytes=Buffer.from(output,'utf8'),digest=sha(bytes),file='development/objects/'+digest;
  await writeFile(join(root,file),bytes);
  const identity=entry.path.includes('/app/write/')?'/app/write/page-':entry.path.includes('/app/multi-write/')?'/app/multi-write/page-':entry.path.includes('/app/smart-multi-write/')?'/app/smart-multi-write/page-':entry.path.includes('/9465-')?'/9465-':'/webpack-';
  const prior=baseline.records.find(record=>record.path.includes(identity));
  records.push({path:entry.path,media_type:entry.media_type,source_sha256:entry.object_sha256,development_sha256:digest,file,patches:edits,
    source_uri:entry.source_uri,evidence_id:entry.evidence_id??source.evidence_id,
    baseline_comparison:prior?{path:prior.path,source_sha256:prior.source_sha256,development_sha256:prior.development_sha256,
      source_bytes_equal:entry.object_sha256===prior.source_sha256,development_bytes_equal:digest===prior.development_sha256}:null});
  if(sha(await readFile(join(root,entry.file)))!==entry.object_sha256)throw new Error('Current original source changed while patching');
}
const patches=records.flatMap(record=>record.patches);
if(patches.length!==16)throw new Error('Expected three editor and thirteen transport patches');
const manifest={schema:'rea-client-update-overlay-v1',release,source_manifest_sha256:sha(sourceBytes),provider:'VERTEX_WIF',patch_count:16,
  editor_patch_count:3,transport_patch_count:13,original_sources_untouched:true,
  patch_provenance:'Same AST-asserted Vertex alternatives as replay/patch-workflow-vertex.mjs; original methods and content retained',records};
const developmentBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(root,'development.json'),developmentBytes);
const pointer={schema:'rea-client-update-pointer-v1',release,source_manifest_sha256:sha(sourceBytes),development_manifest_sha256:sha(developmentBytes)};
await writeFile(join(import.meta.dirname,'client-updates/active.json'),JSON.stringify(pointer,null,2)+'\n');
console.log(JSON.stringify({release,records:records.length,editor_patch_count:3,transport_patch_count:13,source_manifest_sha256:pointer.source_manifest_sha256,
  development_manifest_sha256:pointer.development_manifest_sha256,original_sources_untouched:true,
  comparisons:records.map(({path,baseline_comparison})=>({path,baseline_comparison}))}));
