import { parse } from 'parse5';
const descendants = node => [node, ...(node.childNodes ?? []).flatMap(descendants)];
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
const className = node => node.attrs?.find(attribute => attribute.name === 'class')?.value;
const originalCopyright = 'ⓒ 2026 THREADMATE. DESIGNED FOR Awesome God Corporation.';
const copyright = '© 2026 HongThreads· ALL RIGHTS RESERVED';
const logoImage = '<img src="/__replay/brand.png" alt="H 로고" width="64" height="64" class="h-16 w-16 object-contain shrink-0"/>';
const logoMarkup = '<span class="flex items-center gap-2 min-w-0">'+logoImage+'<span class="text-xl font-bold tracking-tight text-black whitespace-nowrap">HongThreads</span></span>';
const logoScript = '(0,n.jsx)("img",{src:"/__replay/brand.png",alt:"H 로고",width:64,height:64,className:"h-16 w-16 object-contain shrink-0"})';
const renameArchive = source => source.replaceAll('DREATHS 아카이브','Threads Archive').replaceAll('DreaThs Archive','Threads Archive');
const renameLabels = source => renameArchive(source).replaceAll('마이페이지 관리','마이페이지관리').replaceAll('마이페이지 설정','마이페이지관리');
const dashboardHeading = '("h2",{className:"text-lg md:text-2xl font-black uppercase tracking-widest text-black flex items-center gap-2 md:gap-3",children:';

// Apply only the known branding literals after captured assets pass their digest
// checks. Keep retained files and their source-bound manifests unchanged.
export const patchDevelopmentScript = bytes => {
  const source=bytes.toString('utf8');
  if(!source.includes(originalCopyright)&&!source.includes('children:'+logoScript)&&!source.includes('DREATHS 아카이브')&&!source.includes('DreaThs Archive')&&!source.includes('onClick:()=>$("revenue")')&&!source.includes('마이페이지 관리')&&!source.includes('마이페이지 설정'))return bytes;
  // Only the captured dashboard layout owns the route variable x. Mypage has
  // the same heading classes but no such binding, so it must keep its own JSX.
  const dashboard=source.includes('90253:function(')&&source.includes('"videos"===x&&');
  return Buffer.from(renameLabels(source).replaceAll(originalCopyright,copyright).replaceAll('children:'+logoScript,
    'children:(0,n.jsxs)("span",{className:"flex items-center gap-2 min-w-0",children:['+logoScript+',(0,n.jsx)("span",{className:"text-xl font-bold tracking-tight text-black whitespace-nowrap",children:"HongThreads"})]})')
    .replaceAll('("button",{onClick:()=>$("revenue"),','("button",{"data-hongthreads-hidden":"revenue-menu",onClick:()=>$("revenue"),')
    .replaceAll('("button",{onClick:()=>$("videos"),','("button",{"data-hongthreads-archive":"true",onClick:()=>$("videos"),')
    .replaceAll(dashboardHeading,dashboard?
      '("h2",{"data-hongthreads-archive":"videos"===x?"true":undefined,className:"text-lg md:text-2xl font-black uppercase tracking-widest text-black flex items-center gap-2 md:gap-3",children:':dashboardHeading));
};

// Match the same SSR nodes changed in the captured sidebar client module.
// Slice source ranges so unrelated markup and Next.js bootstrap scripts stay intact.
export const patchDevelopmentMarkup = bytes => {
  // Some retained pages reference a stylesheet removed by the upstream build.
  // Use the retained, verified current theme instead of a session-only fallback.
  let source = renameLabels(bytes.toString('utf8')).replaceAll(originalCopyright,copyright)
    .replaceAll('d4dd19e25a332040.css','8efd17712e15569c.css');
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const asides = descendants(tree).filter(node => node.tagName === 'aside');
  // An unrecognised or absent sidebar must remain usable after an upstream
  // account-state/markup change. Only remove the exact known UI nodes.
  if (asides.length !== 1) return { bytes:Buffer.from(source), removed_nodes: [] };
  const nodes = descendants(asides[0]);
  const selectors = [
    { id: 'sidebar-subscribe-button', tag: 'button', text: '구독',
      className: 'mr-1.5 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider text-white bg-indigo-600 hover:bg-indigo-700 transition-all rounded-sm shadow-sm' },
    { id: 'sidebar-subscription-expiry-label', tag: 'span', text: '사용기한 만료',
      className: 'text-[9px] font-bold text-rose-600 mt-0.5 truncate w-full' },
    { id: 'sidebar-profile-avatar', tag: 'div',
      className: 'w-8 h-8 rounded-full bg-black flex items-center justify-center text-xs font-black uppercase text-white shrink-0 shadow-inner' },
    { id: 'sidebar-profile-name', tag: 'span',
      className: 'text-xs font-bold text-black truncate w-full' }
  ];
  const removed = selectors.flatMap(selector => {
    const matches = nodes.filter(node => node.tagName === selector.tag &&
      className(node) === selector.className && (selector.text===undefined||text(node) === selector.text));
    if (matches.length !== 1) return [];
    const location = matches[0].sourceCodeLocation;
    if (!location?.endTag) return [];
    return [{ id: selector.id, start_utf16: location.startOffset, end_utf16: location.endOffset }];
  });
  const logos=nodes.filter(node=>node.tagName==='img'&&node.attrs?.some(attr=>attr.name==='alt'&&attr.value==='DReaThs Logo'));
  const replaced=logos.length===1&&logos[0].sourceCodeLocation?[{id:'sidebar-h-logo',start_utf16:logos[0].sourceCodeLocation.startOffset,end_utf16:logos[0].sourceCodeLocation.endOffset,
    replacement:logoMarkup}]:[];
  for(const node of descendants(tree)){
    const archive=(node.tagName==='h2'||nodes.includes(node)&&node.tagName==='button')&&text(node).trim()==='Threads Archive';
    const revenue=nodes.includes(node)&&node.tagName==='button'&&['수익 인증 라운지','Revenue Certification'].includes(text(node).trim());
    const attribute=archive?'data-hongthreads-archive':revenue?'data-hongthreads-hidden':null;
    if(!attribute||node.attrs?.some(attr=>attr.name===attribute)||!node.sourceCodeLocation?.startTag)continue;
    const offset=node.sourceCodeLocation.startTag.startOffset+node.tagName.length+1;
    replaced.push({id:archive?'threads-archive-label':'hidden-revenue-menu',start_utf16:offset,end_utf16:offset,replacement:' '+attribute+'="'+(archive?'true':'revenue-menu')+'"'});
  }
  for (const node of [...removed,...replaced].sort((a,b) => b.start_utf16 - a.start_utf16))
    source = source.slice(0,node.start_utf16) + (node.replacement??'') + source.slice(node.end_utf16);
  return { bytes: Buffer.from(source, 'utf8'), removed_nodes: removed, replaced_nodes: replaced };
};
