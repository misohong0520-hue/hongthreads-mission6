import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadClientUpdates} from './workflow-client-updates.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{path='/_next/static/chunks/app/write/page-abcd.js',sourceFile='objects/source',
  release='2026-11-06',source=Buffer.from('/*original*/'),development=Buffer.from('/*explicit WIF adaptation*/'),sourceSchema,origin}={}){
  const root=await mkdtemp(join(tmpdir(),'dreaths-client-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,release);
  await mkdir(join(directory,'objects'),{recursive:true});await mkdir(join(directory,'development/objects'),{recursive:true});
  await writeFile(join(directory,'objects/source'),source);await writeFile(join(directory,'development/objects/output'),development);
  const manifest=Buffer.from(JSON.stringify({schema:sourceSchema,origin,records:[{path,status:200,object_sha256:sha(source),file:sourceFile}]}));
  const overlay=Buffer.from(JSON.stringify({schema:'rea-client-update-overlay-v1',source_manifest_sha256:sha(manifest),records:[{path,media_type:'application/javascript',source_sha256:sha(source),development_sha256:sha(development),file:'development/objects/output'}]}));
  await writeFile(join(directory,'manifest.json'),manifest);await writeFile(join(directory,'development.json'),overlay);
  await writeFile(join(root,'active.json'),JSON.stringify({schema:'rea-client-update-pointer-v1',release,source_manifest_sha256:sha(manifest),development_manifest_sha256:sha(overlay)}));
  return{root,directory,source,development};
}
test('source-bound editor update loads without replacing the baseline',async t=>{
  const f=await fixture(t),assets=await loadClientUpdates(f.root);assert.equal(assets.length,1);assert.deepEqual(assets[0].bytes,f.development);assert.equal(assets[0].record.changed,true);
});
test('original affiliate registration pages and their shared layout are accepted without enabling other onboarding routes',async t=>{
  for(const path of ['/_next/static/chunks/app/onboarding/coupang/page-abcd.js','/_next/static/chunks/app/onboarding/toss/page-abcd.js','/_next/static/chunks/app/onboarding/layout-abcd.js']){
    const f=await fixture(t,{path});assert.equal((await loadClientUpdates(f.root)).length,1);
  }
  const f=await fixture(t,{path:'/_next/static/chunks/app/onboarding/unknown/page-abcd.js'});await assert.rejects(loadClientUpdates(f.root),/verification failed/);
});
test('source or execution bytes cannot change after the update is approved',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'development/objects/output'),'modified after approval');await assert.rejects(loadClientUpdates(f.root),/verification failed/);
});
test('unknown runtime modules and file traversal are rejected',async t=>{
  for(const options of [{path:'/_next/static/chunks/app/unknown/page-abcd.js'},{sourceFile:'../../outside'}]){const f=await fixture(t,options);await assert.rejects(loadClientUpdates(f.root),/verification failed/)}
});

const supplementalPath='/_next/static/chunks/2897.1b32fc00e21c9a61.js';
const supplementalHash='b422fb80d58e05d28162c2bdf1eecd2386667f4eb7e69f2956361b60d6fb2cd7';
const supplementalSource=()=>readFile(new URL('./client-updates/2026-11-11-assets/objects/'+supplementalHash,import.meta.url));

test('the source-bound public lazy chunk loads byte-for-byte without a development patch',async()=>{
  const bytes=await supplementalSource();
  assert.equal(sha(bytes),supplementalHash);
  const asset=(await loadClientUpdates()).find(item=>item.record.path===supplementalPath);
  assert.ok(asset,'the captured editor lazy chunk must be active');
  assert.equal(asset.release,'2026-11-11-assets');
  assert.equal(asset.record.changed,false);
  assert.deepEqual(asset.bytes,bytes);
});

test('supplemental lazy chunks reject different paths, release context and recomputed patched bytes',async t=>{
  const bytes=await supplementalSource(),options={path:supplementalPath,release:'2026-11-11-assets',
    sourceSchema:'rea-supplemental-client-assets-v1',origin:'https://drt.agczero.com',source:bytes,development:bytes};
  const accepted=await fixture(t,options);
  assert.equal((await loadClientUpdates(accepted.root))[0].record.changed,false);
  for(const change of [
    {path:'/_next/static/chunks/2897.0000000000000000.js'},
    {release:'2026-11-06'},
    {origin:'https://unapproved.invalid'},
    {development:Buffer.concat([bytes,Buffer.from('\n/* unapproved runtime patch */')])}
  ]){
    const f=await fixture(t,{...options,...change});
    await assert.rejects(loadClientUpdates(f.root),/verification failed/);
  }
});
