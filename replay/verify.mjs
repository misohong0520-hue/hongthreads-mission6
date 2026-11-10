import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const development=process.argv.includes('--dev');
const base='http://127.0.0.1:'+(process.env.PORT??(development?9248:9247));
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=value=>{const u=new URL(value);u.hash='';u.searchParams.delete('_rsc');return u.href;};
const variants=new Map();
for(const record of manifest.records.filter(r=>r.replayable&&r.method==='GET'&&r.origin===manifest.primary_origin))
  variants.set(JSON.stringify([canonical(record.original_url),record.rsc]),record);
const apiResults=[];
for(const record of variants.values()) {
  if(!record.pathname.startsWith('/api/'))continue;
  const url=new URL(record.original_url);
  const response=await fetch(base+url.pathname+url.search,{redirect:'manual',headers:record.rsc?{RSC:'1'}:{}});
  const body=Buffer.from(await response.arrayBuffer());
  const actualSha=hash(body);
  assert.equal(response.status,record.response.status);
  assert.equal(actualSha,record.response.object_sha256);
  assert.equal(response.headers.get('x-rea-body-representation'),'exact-retained-body');
  apiResults.push({method:'GET',path:url.pathname+url.search,status:response.status,bytes:body.length,
    expected_sha256:record.response.object_sha256,actual_sha256:actualSha,matched:true,record_id:record.id});
}
const document=await fetch(base+'/dashboard/insights');
const html=await document.text();
assert.equal(document.status,200);
assert.ok(html.includes('/__replay/relocate.js'));
assert.equal(document.headers.get('x-rea-body-representation'),'derived-document-or-css');
const scripts=[];
if(development) {
  const patch=JSON.parse(await readFile(join(root,'../development/patch-manifest.json'),'utf8'));
  for(const asset of patch.files.filter(file=>file.changed)) {
    const record=[...variants.values()].find(r=>asset.path.endsWith(r.pathname)&&asset.source_sha256===r.response.object_sha256);
    assert.ok(record);
    const response=await fetch(base+record.pathname);
    const digest=hash(Buffer.from(await response.arrayBuffer()));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('x-rea-body-representation'),'development-patched-script');
    assert.equal(digest,asset.development_sha256);
    scripts.push({path:record.pathname,development_sha256:digest,matched:true});
  }
  assert.equal(scripts.length,3);
  assert.ok(!html.includes('>사용기한 만료</span>'));
  assert.ok(!html.includes('>구독</button>'));
} else {
  const jsRecord=[...variants.values()].find(r=>r.pathname.includes('/app/dashboard/insights/page-'));
  assert.ok(jsRecord);
  const js=await fetch(base+jsRecord.pathname+jsRecord.search);
  assert.equal(hash(Buffer.from(await js.arrayBuffer())),jsRecord.response.object_sha256);
}
const missing=await fetch(base+'/api/__rea_uncaptured_probe');
assert.equal(missing.status,501);
const write=await fetch(base+'/api/reference/scrap',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
assert.equal(write.status,501);
assert.equal(new URL(base).hostname,'127.0.0.1');
const report={verified_at:new Date().toISOString(),scope:'Exact retained finite HTTP responses only; no backend-source or future-request equivalence.',
  captures:manifest.sources.map(s=>({evidence_id:s.evidence_id,sha256:s.sha256})),
  api_byte_comparison:{total:apiResults.length,passed:apiResults.length,failed:0,results:apiResults},
  document:{status:document.status,derived_original_sha256:document.headers.get('x-rea-original-sha256'),
    served_sha256:document.headers.get('x-rea-served-sha256'),original_scripts_unchanged:!development},
  development,development_scripts:scripts,
  uncaptured_get_status:missing.status,uncaptured_post_status:write.status,
  no_remote_proxy:true,loopback_only:true};
await writeFile(join(root,development?'development-verification.json':'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({api_routes_verified:apiResults.length,all_bytes_matched:true,document_status:document.status,uncaptured_get_status:missing.status,uncaptured_post_status:write.status}));
