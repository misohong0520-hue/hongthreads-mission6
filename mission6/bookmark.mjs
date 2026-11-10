import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseFragment} from 'parse5';

export const BOOKMARK_IMAGE='/social/hongthreads-v1.png';
export const BOOKMARK_ICON='/social/hongthreads-icon-v1.png';
const description='Threads 콘텐츠 작성과 트렌드·벤치마킹 자료를 한곳에서 관리하는 HongThreads입니다.';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bookmarkHead(publicOrigin){
  const origin=new URL(publicOrigin).origin,home=origin+'/',image=origin+BOOKMARK_IMAGE;
  const tags=[['name','description',description],['property','og:title','HongThreads'],['property','og:description',description],
    ['property','og:site_name','HongThreads'],['property','og:type','website'],['property','og:url',home],['property','og:locale','ko_KR'],
    ['property','og:image',image],['property','og:image:secure_url',image],['property','og:image:type','image/png'],
    ['property','og:image:width','1200'],['property','og:image:height','630'],['property','og:image:alt','초록색 H 로고와 HongThreads'],
    ['name','twitter:card','summary_large_image'],['name','twitter:title','HongThreads'],['name','twitter:description',description],
    ['name','twitter:image',image],['name','twitter:image:alt','초록색 H 로고와 HongThreads']];
  return tags.map(([attribute,key,value])=>'<meta '+attribute+'="'+key+'" content="'+escape(value)+'">').join('')+
    '<link rel="canonical" href="'+escape(home)+'"><link rel="icon" type="image/png" sizes="64x64" href="'+escape(origin+BOOKMARK_ICON)+'">';
}

// Only replace head metadata. Application scripts and retained page markup stay intact.
export function applyBookmarkMetadata(bytes,publicOrigin){
  const text=bytes.toString(),match=/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i.exec(text);if(!match)return bytes;
  const head=match[1],tree=parseFragment(head,{sourceCodeLocationInfo:true}),edits=[];
  const walk=node=>{
    const attrs=Object.fromEntries((node.attrs??[]).map(a=>[a.name,a.value]));
    const name=String(attrs.name??'').toLowerCase(),property=String(attrs.property??'').toLowerCase(),rel=String(attrs.rel??'').toLowerCase().split(/\s+/);
    if((node.tagName==='meta'&&(name==='description'||name.startsWith('twitter:')||property.startsWith('og:')))||
      (node.tagName==='link'&&rel.some(value=>['canonical','icon','apple-touch-icon'].includes(value)))){
      const loc=node.sourceCodeLocation;if(loc)edits.push({start:loc.startOffset,end:loc.endOffset});
    }
    for(const child of node.childNodes??[])walk(child);
  };walk(tree);let next=head;
  for(const edit of edits.sort((a,b)=>b.start-a.start))next=next.slice(0,edit.start)+next.slice(edit.end);
  const start=match.index+match[0].indexOf('>')+1;
  return Buffer.from(text.slice(0,start)+bookmarkHead(publicOrigin)+next+text.slice(start+head.length));
}

export async function loadBookmark(publicOrigin){
  const redirect='location.replace("/dashboard/insights"+location.search+location.hash);';
  const document=Buffer.from('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HongThreads</title>'+bookmarkHead(publicOrigin)+
    '</head><body><script>'+redirect+'</script><noscript><a href="/dashboard/insights">HongThreads 열기</a></noscript></body></html>');
  const assets=new Map();
  for(const [path,file]of [[BOOKMARK_IMAGE,'hongthreads-bookmark-v1.png'],[BOOKMARK_ICON,'hongthreads-favicon.png']])assets.set(path,await readFile(new URL('../development/branding/'+file,import.meta.url)));
  return{document,assets,csp:"default-src 'none'; img-src 'self'; script-src 'sha256-"+createHash('sha256').update(redirect).digest('base64')+"'; base-uri 'none'; frame-ancestors 'none'"};
}
