import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),source=join(root,'extension-local'),target=join(root,'extension-cloud');
await mkdir(target,{recursive:true});
for(const file of await readdir(source)){
  if(!/\.(?:js|json|html|png)$/.test(file))continue;
  if(file.endsWith('.png')){await copyFile(join(source,file),join(target,file));continue}
  let text=await readFile(join(source,file),'utf8');
  text=text.replaceAll('http://127.0.0.1:9248','https://hongthreads.hongsik.blog').replaceAll('http://localhost:9248','https://hongthreads.hongsik.blog').replaceAll('DReaThs Scraper Local','HongThreads Scraper').replaceAll('DReaThs Settings','HongThreads Settings');
  if(file==='manifest.json'){
    const manifest=JSON.parse(text);delete manifest.key;manifest.name='HongThreads Scraper';manifest.version='1.136.0.2';manifest.description='HongThreads의 개인 Supabase 보관함에 Threads 자료를 저장합니다.';
    manifest.host_permissions=[...new Set(manifest.host_permissions)];for(const script of manifest.content_scripts)script.matches=[...new Set(script.matches)];text=JSON.stringify(manifest,null,2)+'\n';
  }
  await writeFile(join(target,file),text);
}
await copyFile(join(root,'development/branding/h-logo.png'),join(target,'icon.png'));
await writeFile(join(target,'README.md'),'# HongThreads 확장 프로그램\n\nZIP 압축을 푼 뒤 chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램을 로드합니다. hongthreads.hongsik.blog/workspace/connect에서 발급한 확장 프로그램 키를 확장 설정에 입력하세요. 기존 로컬 확장과 별도 설치되며 개인 보관함에만 연결됩니다. 원본 계정 세션 값을 확장 프로그램에 넣지 않습니다.\n');
const python="import pathlib,zipfile; p=pathlib.Path('extension-cloud'); z=zipfile.ZipFile('extension-cloud.zip','w',zipfile.ZIP_DEFLATED); [z.write(f,f.relative_to(p)) for f in sorted(p.iterdir()) if f.is_file()]; z.close()";
const result=spawnSync('py',['-3.11','-c',python],{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(result.stderr||'Extension ZIP failed');
console.log(JSON.stringify({extension:'extension-cloud',archive:'extension-cloud.zip',separateInstallation:true}));
