import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture} from './service-fixtures.mjs';
import {catalog,route,budget,chunks} from './model-fixtures.mjs';
import {createRuntime} from '../src/host/runtime.mjs';
import {createService} from '../src/host/service.mjs';
import {createRunStore} from '../src/host/runs.mjs';
import {createAttempts} from '../src/host/attempts.mjs';
import {createBridge} from '../src/host/bridge.mjs';
const nativeRoot=process.env.DSH_NATIVE_MODULES;
import {testTools} from './test-tools.mjs';
const {pythonPath,gitPath}=testTools();
const exec=promisify(execFile);
async function setup(t) {
  const f=await fixture(t),load=name=>import(pathToFileURL(path.join(nativeRoot,name,'lib/index.js'))),{Context}=await load('cordis'),native=new Context();
  for(const name of ['dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-llm','dsh-agent-loop','dsh-jobs-local'])await native.plugin((await load(name)).default).await();
  await native.plugin(await load('dsh-tool-jobs'),{completionDelivery:'quiet'}).await();
  const handle=await native.agents.create({sessionId:'s',meta:{cwd:f.workspace}});f.agents.set('s',handle.agent);f.ctx.jobs=native.jobs;f.ctx.llm=native.llm;
  t.after(()=>native.fiber.dispose());
  const {LlmAdapter}=await load('dsh-llm'),calls={streams:0},state={text:'',onStream:null,afterImport:null};
  class ScriptedAdapter extends LlmAdapter {
    async resolveModel(provider,model){return {provider,id:model,name:'Scripted offline',context:{contextWindow:262144},defaultMaxTokens:4096,reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}};}
    async *stream(request){calls.streams++;calls.request=request;await state.onStream?.(request);yield* chunks(state.text);}
  }
  native.llm.registerAdapter(['offline'],new ScriptedAdapter());
  f.ctx.sessionController.modelCatalog=async()=>structuredClone(catalog);
  const repo=path.join(f.workspace,'repo 中文');await mkdir(repo);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('GIT_')));
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  const git=(...args)=>exec(gitPath,['-c','init.templateDir=','-c',`core.hooksPath=${path.join(f.profile,'no-hooks')}`,'-c','user.name=SpecGap Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-C',repo,...args],{env,windowsHide:true,timeout:30000});
  await git('init','-b','main');await writeFile(path.join(repo,'app.py'),'def retry_limit():\n    return 3\n');await git('add','--','app.py');await git('commit','-m','base');
  await git('switch','-c','feature');await writeFile(path.join(repo,'app.py'),'def retry_limit():\n    return 5\n');await git('add','--','app.py');await git('commit','-m','head');
  await writeFile(path.join(f.workspace,'需求.md'),'[REQ-1] 重试次数不得超过 3 次。\n');
  const runtime=createRuntime(f.ctx,{pythonPath,gitPath}),store=createRunStore({runtime,root:runtime.dataRoot}),attempts=createAttempts({runtime,store}),realBridge=createBridge({environment:signal=>runtime.bridgeEnvironment(signal)});
  const bridge={async callBridge(...args){const result=await realBridge.callBridge(...args);if(args[0]==='import_review')await state.afterImport?.();return result;},dispose:()=>realBridge.dispose()};
  const service=createService({runtime,store,attempts,bridge});t.after(()=>service.dispose());
  const run=await service.dispatch('prepare',{workspaceId:'w',sessionId:'s',repoPath:'repo 中文',requirementsPath:'需求.md',target:'main',idempotencyKey:'prepare-native-model'},f.authority),selector={workspaceId:'w',sessionId:'s',runId:run.runId};
  const material=await service.dispatch('material',selector,f.authority),review=structuredClone(material.template),cite=side=>({side,path:'app.py',start_line:2,end_line:2,quote:`    return ${side==='base'?3:5}`});
  for(const item of review.requirements)Object.assign(item,{assessment:'contradicted',reason:'预设静态审查候选，未执行代码。',evidence:[cite('head')]});
  for(const item of review.changes)Object.assign(item,{assessment:'behavior_changed',summary:'预设变更将重试次数由 3 次增加到 5 次。',requirement_ids:['REQ-1'],evidence:[cite('base'),cite('head')]});
  review.findings=[{id:'F-1',kind:'contradiction',title:'重试次数与需求不符',description:'预设审查候选，不代表真实模型效果。',severity:'medium',requirement_ids:['REQ-1'],change_ids:[review.changes[0].id],evidence:[cite('head')],question:'这项需求变更是否已获授权？',suggested_role:'product',test_ideas:['在失败场景下统计重试次数。']}];
  state.text=JSON.stringify(review);
  return {...f,native,calls,state,store,attempts,service,selector,review,material,
    async preview(){return service.dispatch('material',{...selector,route,budget},f.authority);},
    async start(preview){const c=await service.dispatch('confirmAnalysis',{...selector,previewHash:preview.previewHash},f.authority);return service.dispatch('analyze',{...selector,confirmationId:c.confirmationId},f.authority);}};
}
test('real native prepareCall/jobs plus real Python bridge: frozen audit equals exact dispatched request and valid review imports',{skip:!nativeRoot},async t=>{
  const f=await setup(t),preview=await f.preview();assert.equal(f.calls.streams,0);assert.equal(preview.request.maxTokens,4096);assert.match(preview.request.system,/简体中文/);
  f.state.onStream=async request=>{
    const attempt=(await f.store.get('w',f.selector.runId)).attempts[0],p=await f.store.paths('w',f.selector.runId),disk=JSON.parse(await readFile(path.join(p.directory,`audit-${attempt.attemptId}`,'request.json'),'utf8'));
    assert.deepEqual(disk.request,preview.request);const {signal,...wire}=request;assert.deepEqual(wire,{...disk.request,sessionId:'s'});
    assert.equal(f.native.jobs.get(attempt.jobId,'s').owner,'s');assert.equal(request.tools,undefined);assert.equal(request.toolHistory,undefined);
  };
  const a=await f.start(preview),result=await f.attempts.wait(a.attemptId);assert.equal(result.phase,'completed');assert.equal(f.calls.streams,1);
  const run=await f.service.dispatch('run',f.selector,f.authority);assert.deepEqual(run.review,f.review);assert.equal(run.status.release_approval,false);
  const report=await f.service.dispatch('report',f.selector,f.authority);assert.match(report.markdown,/重试次数与需求不符/);assert.match(report.markdown,/不构成发布批准/);
  assert.equal(f.native.jobs.get(a.jobId,'s').status,'completed');
});
test('real Python validation rejects invented quotes and missing assessments from native scripted stream',{skip:!nativeRoot},async t=>{
  for(const change of ['quote','assessment'])await t.test(change,async t=>{
    const f=await setup(t),review=structuredClone(f.review);
    if(change==='quote')review.findings[0].evidence[0].quote='invented source quote';else review.requirements=[];
    f.state.text=JSON.stringify(review);const a=await f.start(await f.preview()),result=await f.attempts.wait(a.attemptId);
    assert.equal(result.phase,'failed');assert.equal(result.error,'INVALID_REVIEW');assert.equal(f.calls.streams,1);
    const run=await f.service.dispatch('run',f.selector,f.authority);assert.equal(run.review,null);assert.equal(run.status.release_approval,false);
  });
});
test('real changed requirements after generation prevent import; committed import survives final authority loss',{skip:!nativeRoot},async t=>{
  for(const change of ['stale','committed'])await t.test(change,async t=>{
    const f=await setup(t);
    if(change==='stale')f.state.onStream=()=>writeFile(path.join(f.workspace,'需求.md'),'[REQ-1] Changed requirement.\n');else f.state.afterImport=async()=>f.agents.set('s',{});
    const a=await f.start(await f.preview()),result=await f.attempts.wait(a.attemptId);
    assert.equal(result.phase,change==='stale'?'failed':'completed');assert.equal(f.calls.streams,1);
    const run=await f.service.dispatch('run',{workspaceId:'w',runId:f.selector.runId},f.authority);assert.equal(run.review===null,change==='stale');
  });
});
