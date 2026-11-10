import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// This source stylesheet is also needed before a visitor connects an account.
export async function loadWorkflowStyles(root=join(import.meta.dirname,'style-assets')){
  const manifest=JSON.parse(await readFile(join(root,'manifest.json')));
  const record=manifest.records?.[0];
  if(manifest.schema!=='rea-original-styles-v1'||manifest.origin!=='https://drt.agczero.com'||manifest.records.length!==1||
    record.path!=='/_next/static/css/8efd17712e15569c.css'||record.file!=='8efd17712e15569c.css'||
    record.source_sha256!=='7d36401b7128bacef7402df0f46c4ef847e07356b87ff488e9a122ce7d5450e9'||!/^text\/css\b/.test(record.media_type))
    throw new Error('Original style manifest mismatch');
  const bytes=await readFile(join(root,record.file));
  if(bytes.length!==record.bytes||createHash('sha256').update(bytes).digest('hex')!==record.source_sha256)
    throw new Error('Original style digest mismatch');
  return[{bytes,record:{...record,changed:false}}];
}
