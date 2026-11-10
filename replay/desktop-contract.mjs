import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const DESKTOP_PROTOCOL=2;
// Runtime behaviour and its source-bound manifests, not personal data/logs.
// Both the owning server and app hash the same closed inventory.
export const RUNTIME_IDENTITY_FILES=Object.freeze([
  'replay/server.mjs','replay/desktop-contract.mjs','replay/workflow-routes.mjs','replay/workflow-client-updates.mjs',
  'replay/workflow-policy.mjs','replay/live-trends-bridge.mjs','replay/relocate.js',
  'replay/live-client.js','replay/benchmark-client.js','replay/benchmark-events.mjs','replay/ui-visibility.css',
  'replay/desktop-collect.html','replay/desktop-collect.js',
  'replay/local-benchmark-service.mjs','replay/local-benchmark-store.mjs',
  'replay/vertex-wif-bridge.mjs','replay/session-routes.mjs',
  'replay/session-setup.html','replay/session-setup.js',
  'development/patch-server-markup.mjs',
  'replay/manifest.json','replay/workflow-capture/manifest.json',
  'replay/workflow-capture/client-inventory.json',
  'replay/workflow-development/manifest.json','development/patch-manifest.json'
]);

export async function runtimeIdentity(root){
  const files=await Promise.all(RUNTIME_IDENTITY_FILES.map(async path=>[
    path,createHash('sha256').update(await readFile(join(root,path))).digest('hex')
  ]));
  try{
    const pointerBytes=await readFile(join(root,'replay/client-updates/active.json')),pointer=JSON.parse(pointerBytes);
    files.push(['replay/client-updates/active.json',createHash('sha256').update(pointerBytes).digest('hex')]);
    for(const release of pointer.releases??[pointer]){
      if(!/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/.test(release.release??''))throw new Error('Invalid runtime release.');
      for(const name of ['manifest.json','development.json']){
        const path='replay/client-updates/'+release.release+'/'+name;
        const bytes=await readFile(join(root,path));files.push([path,createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  }catch(error){if(error.code!=='ENOENT')throw error}
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
