import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const paths=new Set(['/font/lexend/Lexend-Black.ttf','/font/lexend/Lexend-SemiBold.ttf',
  '/font/lexend/Lexend-Regular.ttf','/font/pretendard/Pretendard-SemiBold.ttf']);
export async function loadWorkflowFonts(root=join(import.meta.dirname,'font-assets')){
  const manifest=JSON.parse(await readFile(join(root,'manifest.json')));
  if(manifest.schema!=='rea-original-fonts-v1'||manifest.origin!=='https://drt.agczero.com'||manifest.records?.length!==paths.size)
    throw new Error('Original font manifest mismatch');
  const seen=new Set(),assets=[];
  for(const record of manifest.records){
    if(!paths.has(record.path)||seen.has(record.path)||record.status!==200||record.media_type!=='font/ttf'||
      !/^[a-f0-9]{64}$/.test(record.source_sha256)||record.file!=='objects/'+record.source_sha256)
      throw new Error('Invalid original font record');
    const bytes=await readFile(join(root,record.file));
    if(bytes.length!==record.bytes||bytes.length<4||bytes.readUInt32BE(0)!==0x10000||
      createHash('sha256').update(bytes).digest('hex')!==record.source_sha256)
      throw new Error('Original font digest mismatch');
    seen.add(record.path);assets.push({bytes,record:{...record,changed:false}});
  }
  return assets;
}
