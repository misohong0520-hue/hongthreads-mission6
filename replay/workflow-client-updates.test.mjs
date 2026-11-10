import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadClientUpdates} from './workflow-client-updates.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{path='/_next/static/chunks/app/write/page-abcd.js',sourceFile='objects/source'}={}){
  const root=await mkdtemp(join(tmpdir(),'dreaths-client-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const release='2026-11-06',directory=join(root,release),source=Buffer.from('/*original*/'),development=Buffer.from('/*explicit WIF adaptation*/');
  await mkdir(join(directory,'objects'),{recursive:true});await mkdir(join(directory,'development/objects'),{recursive:true});
  await writeFile(join(directory,'objects/source'),source);await writeFile(join(directory,'development/objects/output'),development);
  const manifest=Buffer.from(JSON.stringify({records:[{path,status:200,object_sha256:sha(source),file:sourceFile}]}));
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
