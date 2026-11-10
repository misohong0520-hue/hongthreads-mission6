import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire('C:/Users/misoh/AppData/Local/nvm/v24.15.0/node_modules/rea-agents/package.json');
const {parse}=require('@babel/parser');
const sourceSha='a03ece8dea90f47f6b274bb090f567c8ada7fa86b37eb29f335281a7d07b0c80';
const nodes=(node,predicate)=>{
  const matches=[];
  const visit=value=>{
    if(!value?.type)return;
    if(predicate(value))matches.push(value);
    for(const [key,child]of Object.entries(value)){
      if(['loc','extra','start','end','comments','tokens'].includes(key))continue;
      if(Array.isArray(child))child.forEach(visit);else if(child?.type)visit(child);
    }
  };
  visit(node);return matches;
};

// Render the existing analysis tools in the local development client and load
// the selected account's history. Original API authorization remains intact.
export function threadsManageUiEdits(base){
  if(createHash('sha256').update(base).digest('hex')!==sourceSha)
    throw new Error('Threads management source changed; capture and review it before patching.');
  const matches=nodes(parse(base),node=>node.type==='ConditionalExpression'&&
    node.test.type==='Identifier'&&node.test.name==='W'&&
    node.alternate.type==='CallExpression'&&node.alternate.arguments[0]?.value==='div'&&
    nodes(node.alternate,child=>child.type==='ObjectProperty'&&child.key.name==='className'&&
      child.value.value==='mt-10 border-t border-neutral-100 pt-10 relative').length===1&&
    nodes(node.alternate,child=>child.type==='StringLiteral'&&
      child.value==='상세 분석 및 AI 컨설팅 잠금 해제').length===1);
  if(matches.length!==1)throw new Error('Expected one Threads management lock preview.');
  const historyGuards=nodes(parse(base),node=>node.type==='LogicalExpression'&&node.operator==='&&'&&
    node.left.type==='Identifier'&&node.left.name==='W'&&
    node.right.type==='CallExpression'&&node.right.callee.name==='tN'&&
    node.right.arguments.length===1&&node.right.arguments[0].name==='eR');
  if(historyGuards.length!==1)throw new Error('Expected one Threads management initial history UI guard.');
  return[
    {node:matches[0],replacement:base.slice(matches[0].consequent.start,matches[0].consequent.end),id:'development-threads-manage-show-details'},
    {node:historyGuards[0],replacement:base.slice(historyGuards[0].right.start,historyGuards[0].right.end),id:'development-threads-manage-load-history'}
  ];
}
