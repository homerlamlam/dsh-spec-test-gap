import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture,deferred,code} from './service-fixtures.mjs';
import {createBridge} from '../src/host/bridge.mjs';
import {createRuntime} from '../src/host/runtime.mjs';
import {createService} from '../src/host/service.mjs';
import {createRunStore} from '../src/host/runs.mjs';
import {testTools} from './test-tools.mjs';
const {pythonPath,gitPath}=testTools();
const exec=promisify(execFile);
async function seed(f) {
  const repo=path.join(f.workspace,'repo 中文');await mkdir(repo);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('GIT_')));
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
  const git=(...args)=>exec(gitPath,['-c','init.templateDir=','-c',`core.hooksPath=${path.join(f.profile,'no-hooks')}`,'-c','user.name=SpecGap Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-C',repo,...args],{env,windowsHide:true,timeout:30000});
  await git('init','-b','main');await writeFile(path.join(repo,'app.py'),'def retry_limit():\n    return 3\n');await git('add','--','app.py');await git('commit','-m','base');
  await git('switch','-c','feature');await writeFile(path.join(repo,'app.py'),'def retry_limit():\n    return 5\n');await git('add','--','app.py');await git('commit','-m','head');
  await writeFile(path.join(f.workspace,'需求.md'),'[REQ-1] Retry limit must be at most 3.\n');
  return {workspaceId:'w',repoPath:'repo 中文',requirementsPath:'需求.md',target:'main',idempotencyKey:'prepare-once'};
}
function reviewFrom(material) {
  const review=structuredClone(material.template),cite=side=>({side,path:'app.py',start_line:2,end_line:2,quote:`    return ${side==='base'?3:5}`});
  for(const item of review.requirements)Object.assign(item,{assessment:'contradicted',reason:'Scripted static test: 5 exceeds 3; not executed.',evidence:[cite('head')]});
  for(const item of review.changes)Object.assign(item,{assessment:'behavior_changed',summary:'Scripted change from 3 to 5.',requirement_ids:['REQ-1'],evidence:[cite('base'),cite('head')]});
  review.findings=[{id:'F-1',kind:'contradiction',title:'Retry limit differs',description:'Scripted static candidate, not a model evaluation.',severity:'medium',requirement_ids:['REQ-1'],change_ids:[review.changes[0].id],evidence:[cite('head')],question:'Is this an authorized requirement change?',suggested_role:'product',test_ideas:['Count retries under failure.']}];
  return review;
}
function serviceFor(f){return createService({runtime:createRuntime(f.ctx,{pythonPath,gitPath})});}

test('real packaged bridge: prepare/read/material/scripted import/report/history survive service recreation without model or audited execution',async t=>{
  const f=await fixture(t),input=await seed(f);let service=serviceFor(f);t.after(()=>service.dispose());
  const refs=await service.dispatch('refs',{workspaceId:'w',repoPath:input.repoPath},f.authority);assert.ok(refs.refs.some(r=>r.name==='refs/heads/main'));
  const prepared=await service.dispatch('prepare',input,f.authority),selector={workspaceId:'w',runId:prepared.runId};
  assert.equal(prepared.review,null);assert.equal(prepared.status.release_approval,false);assert.deepEqual(prepared.attempts,[]);
  assert.deepEqual(await service.dispatch('prepare',input,f.authority),prepared);
  const material=await service.dispatch('material',selector,f.authority);assert.equal(typeof material.hash,'string');assert.ok(material.bytes>0);
  assert.equal(JSON.stringify(material).includes(f.workspace),false);
  const review=reviewFrom(material),mutation={...selector,idempotencyKey:'review-once',review};
  const invalid=structuredClone(review);invalid.findings[0].evidence[0].quote='invented';
  await assert.rejects(service.dispatch('importReview',{...mutation,idempotencyKey:'bad-review',review:invalid},f.authority),{code:'INVALID_REVIEW'});
  const imported=await service.dispatch('importReview',mutation,f.authority);assert.deepEqual(imported.review,review);assert.equal(imported.status.release_approval,false);
  assert.deepEqual(await service.dispatch('importReview',mutation,f.authority),imported);
  await assert.rejects(service.dispatch('importReview',{...mutation,idempotencyKey:'overwrite'},f.authority),{code:'CONFLICT'});
  const report=await service.dispatch('report',selector,f.authority);assert.match(report.markdown,/Retry limit differs/);assert.equal(report.filename,`specgap-${prepared.runId}.md`);
  await service.dispose();service=serviceFor(f);
  assert.deepEqual((await service.dispatch('run',selector,f.authority)).review,review);
  assert.deepEqual(await service.dispatch('prepare',input,f.authority),prepared,'replay is original creation result, not a mutable current view');
  const history=await service.dispatch('runs',{workspaceId:'w',limit:10},f.authority);assert.equal(history.items[0].runId,prepared.runId);assert.equal(history.items[0].phase,'ready');assert.equal('bundle' in history.items[0],false);
  await assert.rejects(service.dispatch('run',{workspaceId:'other',runId:prepared.runId},f.authority),{code:'NOT_FOUND'});
  const store=createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),p=await store.paths('w',prepared.runId);await writeFile(path.join(p.runPath,'state.json'),'corrupted');
  await assert.rejects(service.dispatch('importReview',mutation,f.authority),{code:'INTEGRITY'},'cached success must not mask corrupt authoritative core');
});

test('failed preparation, unknown core lock and corrupt core are preserved and never repaired',async t=>{
  const f=await fixture(t),input=await seed(f);let service=serviceFor(f);t.after(()=>service.dispose());
  await assert.rejects(service.dispatch('prepare',{...input,target:'missing-ref',idempotencyKey:'bad-prepare'},f.authority),{code:'INVALID_INPUT'});
  const prepared=await service.dispatch('prepare',input,f.authority),selector={workspaceId:'w',runId:prepared.runId};
  const material=await service.dispatch('material',selector,f.authority),review=reviewFrom(material);
  const store=createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),paths=await store.paths('w',prepared.runId);
  const lock=path.join(paths.runPath,'.mutation.lock');await writeFile(lock,'unknown owner');
  await assert.rejects(service.dispatch('importReview',{...selector,idempotencyKey:'locked',review},f.authority),{code:'CONFLICT'});assert.equal(await readFile(lock,'utf8'),'unknown owner');
  const bundle=path.join(paths.runPath,'bundle.json');await writeFile(bundle,'{"corrupt":true}');
  for(const operation of ['run','material','report'])await assert.rejects(service.dispatch(operation,selector,f.authority),{code:'INTEGRITY'});
  assert.equal(await readFile(bundle,'utf8'),'{"corrupt":true}');assert.equal(await readFile(lock,'utf8'),'unknown owner');
  assert.equal((await readdir(paths.directory)).some(n=>n.startsWith('.tmp-')),false);
  await service.dispose();service=serviceFor(f);
  const history=await service.dispatch('runs',{workspaceId:'w'},f.authority);assert.equal(history.items.length,2);assert.ok(history.items.some(r=>r.phase==='failed'));
  await assert.rejects(service.dispatch('run',selector,f.authority),{code:'INTEGRITY'});
});

test('real owner service human lifecycle uses coherent tokens, frozen roles and latest decision linkage without release approval',async t=>{
  const f=await fixture(t),input=await seed(f),service=serviceFor(f);t.after(()=>service.dispose());
  input.policy={actors:{dev:['developer'],qa:['qa'],pm:['product'],sec:['security']}};
  const prepared=await service.dispatch('prepare',input,f.authority),selector={workspaceId:'w',runId:prepared.runId};
  const material=await service.dispatch('material',selector,f.authority);
  await service.dispatch('importReview',{...selector,idempotencyKey:'review',review:reviewFrom(material)},f.authority);
  const get=()=>service.dispatch('run',selector,f.authority);
  let view=await get();assert.equal(view.expectedSequence,0);
  const action={...selector,finding:'F-1',actor:'dev',attestLocal:true,expectedSequence:0,idempotencyKey:'reply',text:'Intentional, not approved.'};
  await assert.rejects(service.dispatch('respond',action,{isOwner:false}),code('FORBIDDEN'));
  await assert.rejects(service.dispatch('respond',{...action,role:'qa'},f.authority),code('INVALID_INPUT'));
  const [reply,duplicate]=await Promise.all([service.dispatch('respond',action,f.authority),service.dispatch('respond',action,f.authority)]);
  assert.deepEqual(duplicate,reply);assert.equal(reply.sequence,1);
  view=await get();assert.equal(view.events.length,view.expectedSequence);assert.equal(view.status.event_count,1);
  assert.equal(view.status.findings['F-1'].disposition,'undecided');assert.equal(view.status.findings['F-1'].verification,'unverified');assert.equal(view.status.release_approval,false);
  const common={...selector,finding:'F-1',actor:'qa',attestLocal:true,expectedSequence:view.expectedSequence};
  const verification={...common,idempotencyKey:'too-early',result:'passed',evidenceText:'人类观察',note:'manual'};
  await assert.rejects(service.dispatch('verify',verification,f.authority),code('CONFLICT'));
  await assert.rejects(service.dispatch('decide',{...common,actor:'dev',idempotencyKey:'wrong-role',outcome:'confirm_defect',reason:'Not QA'},f.authority),code('FORBIDDEN'));
  await assert.rejects(service.dispatch('respond',{...action,idempotencyKey:'old-view'},f.authority),e=>e.code==='CONFLICT' && /refresh/i.test(e.message));
  const decision=await service.dispatch('decide',{...common,idempotencyKey:'decision',outcome:'confirm_defect',reason:'Reviewed'},f.authority);assert.equal(decision.sequence,2);
  view=await get();assert.equal(view.status.release_approval,false);
  const verified=await service.dispatch('verify',{...verification,idempotencyKey:'verified',expectedSequence:view.expectedSequence},f.authority);assert.equal(verified.decision_sequence,2);assert.equal(verified.evidence_content,'人类观察');
  view=await get();assert.equal(view.status.findings['F-1'].verification,'passed');assert.equal(view.status.release_approval,false);
  await service.dispatch('decide',{...common,actor:'pm',idempotencyKey:'new-decision',expectedSequence:view.expectedSequence,outcome:'approve_intent_change',reason:'Changed intent'},f.authority);
  view=await get();assert.equal(view.expectedSequence,4);assert.deepEqual(view.events.map(e=>e.sequence),[1,2,3,4]);assert.equal(view.events[2].decision_sequence,2);
  assert.equal(view.status.findings['F-1'].verification,'unverified');assert.equal(view.status.release_approval,false);assert.equal(view.status.assurance,'local_attestation_only');
  await service.dispose();const restarted=serviceFor(f);t.after(()=>restarted.dispose());
  assert.deepEqual(await restarted.dispatch('respond',action,f.authority),reply,'completed replay retains original event even when its token is old');
  assert.equal((await restarted.dispatch('run',selector,f.authority)).events.length,4);
});

test('human committed bridge result and replay retain ORIGINAL authority outside failure bookkeeping',async t=>{
  for(const operation of ['respond','decide','verify'])for(const boundary of ['bridge','commit','replay'])for(const changed of boundary==='bridge'?['Agent']:boundary==='commit'?['Agent','workspace']:['Agent','workspace','Session'])await t.test(`${operation} ${boundary} ${changed}`,async t=>{
    const f=await fixture(t),input=await seed(f),runtime=createRuntime(f.ctx,{pythonPath,gitPath}),store=createRunStore({root:runtime.dataRoot,runtime});
    const real=createBridge({environment:signal=>runtime.bridgeEnvironment(signal)}),entered=deferred(),release=deferred();
    let hold=false,mutations=0,pending,committed,selection;const states=[],record=store.record,exclusive=store.exclusive,originalAgent=f.agents.get('s');
    const bridge={async callBridge(op,p,opts){const result=await real.callBridge(op,p,opts);if(op===operation){mutations++;if(hold && boundary==='bridge'){entered.resolve();await release.promise;}}return result;},dispose:()=>real.dispose()};
    store.record=async(...args)=>{const result=await record(...args);if(hold && args[3])states.push(args[3].state);if(hold && args[3]?.state==='completed'){committed=structuredClone(args[3]);selection=args.slice(0,3);if(boundary==='commit'){entered.resolve();await release.promise;}}return result;};
    const service=createService({runtime,store,bridge});t.after(()=>service.dispose());
    const prepared=await service.dispatch('prepare',{...input,policy:{actors:{qa:['qa']}}},f.authority),selector={workspaceId:'w',runId:prepared.runId};
    const material=await service.dispatch('material',selector,f.authority);await service.dispatch('importReview',{...selector,idempotencyKey:'review',review:reviewFrom(material)},f.authority);
    const content={respond:{text:'Reply'},decide:{outcome:'confirm_defect',reason:'Reviewed'},verify:{result:'failed',evidenceText:'Manual observation',note:'manual'}}[operation];
    const payload={...selector,sessionId:'s',idempotencyKey:'human-once',finding:'F-1',actor:'qa',attestLocal:true,expectedSequence:0,...content};
    const restore=()=>{f.agents.set('s',originalAgent);f.workspaces.get('w').path=f.workspace;f.workspaces.get('w').sessionIds=['s'];store.exclusive=exclusive;};
    hold=true;
    try{
      if(boundary==='replay'){await service.dispatch(operation,payload,f.authority);store.exclusive=async(...args)=>{const result=await exclusive(...args);entered.resolve();await release.promise;return result;};}
      pending=service.dispatch(operation,payload,f.authority);await Promise.race([entered.promise,pending.then(()=>{throw Error('Expected gated action boundary');})]);
      // Replacement with the same Agent ID must not freshly authorize the reply.
      if(changed==='Agent')f.agents.set('s',{id:'s',replacement:true});
      else if(changed==='workspace')f.workspaces.get('w').path=f.other;
      else f.workspaces.get('w').sessionIds=[];
      release.resolve();await assert.rejects(pending,code('STALE'));
      restore();
      assert.equal(committed.state,'completed');assert.deepEqual(states,['running','completed']);assert.deepEqual(await record(...selection),committed);
      assert.deepEqual(await service.dispatch(operation,payload,f.authority),committed.result);assert.equal(mutations,1);
      await assert.rejects(service.dispatch(operation,{...payload,expectedSequence:1},f.authority),code('CONFLICT'));
      assert.equal(mutations,1,'changed payload with same key must not redispatch');
      const view=await service.dispatch('run',selector,f.authority);assert.equal(view.events.length,1);assert.equal(view.expectedSequence,1);assert.equal(view.status.release_approval,false);
    }finally{release.resolve();await pending?.catch(()=>{});restore();}
  });
});

test('demo is explicitly scripted, independently stored, and keeps release approval false',async t=>{
  const f=await fixture(t),service=serviceFor(f);t.after(()=>service.dispose());
  const payload={workspaceId:'w',idempotencyKey:'scripted-demo'};
  const demo=await service.dispatch('demo',payload,f.authority);assert.equal(demo.review.findings.length,3);assert.equal(demo.status.release_approval,false);assert.equal(demo.repoLabel,'需求对照示例');
  assert.deepEqual(await service.dispatch('demo',payload,f.authority),demo);
  assert.deepEqual(await readdir(f.workspace),[],'demo writes only private plugin storage');
});
