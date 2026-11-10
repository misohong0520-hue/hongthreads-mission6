import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=import.meta.dirname;
const load=async path=>JSON.parse((await readFile(join(root,path),'utf8')).replace(/^\uFEFF/,''));
const metadata=await load('tutorial-video/metadata.json');
const captions=await load('tutorial-video/transcript.json');
const browser=await load('tutorial-frames-final-evidence.json');
const capture=browser.normalized_result;
assert.equal(metadata.id,'Rl3tFrgSLXY');
assert.equal(metadata.duration,118);
assert.equal(captions.length,47);
const frames=[];
for(const step of capture.steps.filter(step=>step.step_id.startsWith('frame-'))) {
  const screenshot=step.artifacts.screenshot;
  if(screenshot.state!=='captured')continue;
  const bytes=Buffer.from(screenshot.value.data_base64,'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),screenshot.value.sha256);
  await writeFile(join(root,'tutorial-video',step.step_id+'.png'),bytes);
  const text=step.artifacts.accessibility?.value?.text ?? '';
  frames.push({step_id:step.step_id,
    player_time_lines:text.split('\n').filter(line=>line.includes('button ')&&line.includes('분')&&line.includes('초')),
    playback_problem_lines:text.split('\n').filter(line=>/오류가 발생|재생할 수|로그인.*확인/.test(line)),
    screenshot_sha256:screenshot.value.sha256});
}
const summary={video:{id:metadata.id,title:metadata.title,uploader:metadata.uploader,upload_date:metadata.upload_date,duration:metadata.duration},
  caption_source:'YouTube original Korean automatic captions (ko-orig)',caption_segments:captions.length,
  original_client_comparison_evidence_ids:['ev_deef65e72fbead2d2fac1046983bfba8f0f870913efb3aee4b3c162141c88c3e','ev_1437f8e8ea9f628fc7072d093c816ff15fd998b173fc35860c80604849c3f1cf','ev_1ca6da5f64266ec8e123c4a20b0cdfd942d91ac0f8f4968586cb48080dec26fd'],
  last_caption_start:captions.at(-1).start,browser_evidence_id:browser.evidence_id,
  browser_steps:capture.steps.map(step=>({id:step.step_id,status:step.status,error:step.error})),frames,
  limitations:['Automatic captions can contain recognition errors.','A downloaded video file was not obtained (HTTP 403).','Selected player screenshots were visually inspected. Later seeks showed the earlier Google frame and buffering, so Shopping/News narration is analyzed from complete captions and compared with original client code; decoded video frames for those sections were not established.']};
await writeFile(join(root,'tutorial-video/evidence-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
