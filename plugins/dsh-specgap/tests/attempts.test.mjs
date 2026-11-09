import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {fixture,deferred,prepareInput,code} from './service-fixtures.mjs';
import * as runs from '../src/host/runs.mjs';
import * as attemptsModule from '../src/host/attempts.mjs';
const nativeRoot=process.env.DSH_NATIVE_MODULES;
async function setup(t) {
  assert.equal(typeof attemptsModule.createAttempts,'function','owned attempt factory must exist');
  const f=await fixture(t),load=name=>import(pathToFileURL(path.join(nativeRoot,name,'lib/index.js'))),{Context}=await load('cordis'),native=new Context();
  for(const name of ['dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-llm','dsh-agent-loop','dsh-jobs-local'])await native.plugin((await load(name)).default).await();
  await native.plugin(await load('dsh-tool-jobs'),{completionDelivery:'quiet'}).await();
  const handle=await native.agents.create({sessionId:'s',meta:{cwd:f.workspace}});
  f.ctx.jobs=native.jobs;f.agents.set('s',handle.agent);
  t.after(()=>native.fiber.dispose());
  const store=runs.createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),run=await store.create('w',prepareInput());await store.update('w',run.runId,{phase:'ready',error:null});
  const manager=attemptsModule.createAttempts({store,runtime:f.runtime});t.after(()=>manager.dispose());
  const binding={session:await f.runtime.bindSession('w','s'),runId:run.runId,idempotencyKey:'analyze-once',requestHash:'a'.repeat(64),modelRoute:{provider:'test-only',model:'no-model',reasoningEffort:null}};
  return {...f,store,run,manager,binding,native};
}

test('attempt implementation exposes lifecycle entrypoint',()=>assert.equal(typeof attemptsModule.createAttempts,'function'));
test('real native jobs: persistence precedes dispatch, duplicates join and completed result is immutable',{skip:!nativeRoot},async t=>{
  const f=await setup(t),gate=deferred(),entered=deferred();let executions=0;
  const execute=async({attempt,validating})=>{
    executions++;const persisted=(await f.store.get('w',f.run.runId)).attempts[0];
    assert.equal(persisted.phase,'running');assert.equal(persisted.jobId,attempt.jobId);
    assert.equal(f.native.jobs.get(attempt.jobId,'s').owner,'s');
    entered.resolve();await gate.promise;await validating();
  };
  const [a,b]=await Promise.all([f.manager.start(f.binding,execute),f.manager.start(f.binding,execute)]);await entered.promise;
  assert.equal(a.attemptId,b.attemptId);assert.equal(executions,1);
  await assert.rejects(f.manager.start({...f.binding,requestHash:'b'.repeat(64)},execute),code('CONFLICT'));
  await assert.rejects(f.manager.start({...f.binding,idempotencyKey:'second'},execute),code('CONFLICT'));
  gate.resolve();await f.manager.wait(a.attemptId);
  const completed=await f.manager.start(f.binding,execute);assert.equal(completed.phase,'completed');assert.equal(executions,1);
  assert.equal((await f.manager.cancel(a.attemptId,{isOwner:true,workspaceId:'w',sessionId:'s',runId:f.run.runId})).phase,'completed');
  assert.equal(f.native.jobs.get(a.jobId,'s').status,'completed');
});
test('cancel and dispose wait for executor cleanup, not a bounded native wait timeout',{skip:!nativeRoot},async t=>{
  const f=await setup(t),entered=deferred(),aborted=deferred(),cleanup=deferred();
  const a=await f.manager.start(f.binding,async({signal})=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',()=>{aborted.resolve();r();},{once:true}));await cleanup.promise;throw Object.assign(Error('aborted'),{code:'CANCELLED'});});
  await entered.promise;
  let settled=false;const cancelling=f.manager.cancel(a.attemptId,{isOwner:true,workspaceId:'w',sessionId:'s',runId:f.run.runId}).then(v=>{settled=true;return v;});
  await aborted.promise;
  assert.equal((await f.native.jobs.wait(a.jobId,10,'s')).status,'stopping');assert.equal(settled,false);
  const disposing=f.manager.dispose();cleanup.resolve();
  assert.equal((await cancelling).phase,'cancelled');await disposing;
  assert.equal(f.native.jobs.get(a.jobId,'s').status,'killed');
  await assert.rejects(f.manager.start({...f.binding,idempotencyKey:'later'},async()=>{}),code('UNAVAILABLE'));
});
test('cancellation rejects changed UI workspace or session before touching the owned native job',{skip:!nativeRoot},async t=>{
  const f=await setup(t),gate=deferred(),a=await f.manager.start(f.binding,async()=>gate.promise);
  for(const authority of [{isOwner:false},{isOwner:true,workspaceId:'other',sessionId:'s',runId:f.run.runId},{isOwner:true,workspaceId:'w',sessionId:'other-s',runId:f.run.runId}])await assert.rejects(f.manager.cancel(a.attemptId,authority),e=>['FORBIDDEN','STALE'].includes(e.code));
  assert.equal(f.native.jobs.get(a.jobId,'s').status,'running');gate.resolve();await f.manager.wait(a.attemptId);
});
test('stale live Agent binding is rejected before job creation',{skip:!nativeRoot},async t=>{
  const f=await setup(t);f.agents.set('s',{id:'s'});
  await assert.rejects(f.manager.start(f.binding,async()=>assert.fail('stale binding dispatched')),code('STALE'));
  assert.equal(f.native.jobs.list('s').length,0);
});
test('job start and job-id persistence failures do not execute and release concurrency after cleanup',{skip:!nativeRoot},async t=>{
  const f=await setup(t),original=f.runtime.startJob;let executions=0;
  f.runtime.startJob=()=>{throw Object.assign(Error('native unavailable'),{code:'UNAVAILABLE'});};
  await assert.rejects(f.manager.start(f.binding,async()=>{executions++;}),code('UNAVAILABLE'));f.runtime.startJob=original;
  const persist=f.store.attempt;let failOnce=true;
  f.store.attempt=async(...args)=>{if(args[2]?.jobId && failOnce){failOnce=false;throw Object.assign(Error('disk full'),{code:'ENVIRONMENT'});}return persist(...args);};
  await assert.rejects(f.manager.start({...f.binding,idempotencyKey:'persist-failure'},async()=>{executions++;}),code('ENVIRONMENT'));
  assert.equal(executions,0);assert.ok(f.native.jobs.list('s').every(j=>!['running','stopping'].includes(j.status)));
  f.store.attempt=persist;
  const success=await f.manager.start({...f.binding,idempotencyKey:'retry-new-key'},async()=>{executions++;});await f.manager.wait(success.attemptId);assert.equal(executions,1);
});
test('Agent is rechecked after asynchronous storage validation immediately before executor dispatch',{skip:!nativeRoot},async t=>{
  const f=await setup(t),paths=f.store.paths;let executions=0;
  f.store.paths=async(...args)=>{const result=await paths(...args);f.agents.set('s',{id:'replacement'});return result;};
  const a=await f.manager.start(f.binding,async()=>{executions++;});
  const result=await f.manager.wait(a.attemptId);
  assert.equal(executions,0);assert.equal(result.phase,'failed');assert.equal(result.error,'STALE');assert.equal(f.native.jobs.get(a.jobId,'s').status,'failed');
});
test('native cancellation propagates to the executor and waits for cleanup without a UI cancel call',{skip:!nativeRoot},async t=>{
  const f=await setup(t),entered=deferred();
  const a=await f.manager.start(f.binding,async({signal})=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error('cancelled'),{code:'CANCELLED'});});
  await entered.promise;f.native.jobs.kill(a.jobId,'s','native test cancellation');
  assert.equal((await f.manager.wait(a.attemptId)).phase,'cancelled');assert.equal(f.native.jobs.get(a.jobId,'s').status,'killed');
});
test('committed successful executor result wins a late cancellation and cannot be overwritten',{skip:!nativeRoot},async t=>{
  const f=await setup(t),completed=deferred(),release=deferred(),persist=f.store.attempt;
  f.store.attempt=async(...args)=>{if(args[2].phase==='completed'){completed.resolve();await release.promise;}return persist(...args);};
  const a=await f.manager.start(f.binding,async()=>{});await completed.promise;
  const cancelling=f.manager.cancel(a.attemptId,{isOwner:true,workspaceId:'w',sessionId:'s',runId:f.run.runId});
  release.resolve();assert.equal((await cancelling).phase,'completed');assert.equal(f.native.jobs.get(a.jobId,'s').status,'completed');
});
test('terminal metadata cancellation still joins resident cleanup and native settlement',{skip:!nativeRoot},async t=>{
  const f=await setup(t),written=deferred(),ack=deferred(),cancelRead=deferred(),persist=f.store.attempt,get=f.store.get;let observeRead=false,a,cancelling,kills=0;
  const kill=f.runtime.killJob;f.runtime.killJob=(...args)=>{kills++;return kill(...args);};
  f.store.attempt=async(...args)=>{const result=await persist(...args);if(args[2].phase==='completed'){written.resolve();await ack.promise;}return result;};
  f.store.get=async(...args)=>{const result=await get(...args);if(observeRead)cancelRead.resolve();return result;};
  try {
    a=await f.manager.start(f.binding,async()=>{});await written.promise;
    assert.equal((await get('w',f.run.runId)).attempts[0].phase,'completed');assert.equal(f.native.jobs.get(a.jobId,'s').status,'running');
    observeRead=true;let settled=false;
    cancelling=f.manager.cancel(a.attemptId,{isOwner:true,workspaceId:'w',sessionId:'s',runId:f.run.runId});cancelling.then(()=>{settled=true;},()=>{settled=true;});
    await cancelRead.promise;await new Promise(setImmediate);
    assert.equal(settled,false,'terminal metadata must not bypass producer acknowledgement');assert.equal(kills,0,'committed success must not be killed');
    ack.resolve();assert.equal((await cancelling).phase,'completed');assert.equal(f.native.jobs.get(a.jobId,'s').status,'completed');assert.equal(kills,0);
  }finally{ack.resolve();await cancelling?.catch(()=>{});if(a)await f.manager.wait(a.attemptId);}
});
test('restart marks unfinished persisted attempts interrupted without restarting any executor',{skip:!nativeRoot},async t=>{
  const f=await setup(t),id='attempt_'+'c'.repeat(32);
  await f.store.attempt('w',f.run.runId,{schemaVersion:1,attemptId:id,runId:f.run.runId,workspaceId:'w',sessionId:'s',phase:'running',modelRoute:f.binding.modelRoute,requestHash:'a'.repeat(64),jobId:'specgap-abandoned',startedAt:new Date().toISOString(),endedAt:null,error:null});
  const fresh=runs.createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),run=await fresh.get('w',f.run.runId);
  assert.equal(run.attempts[0].phase,'interrupted');assert.equal(typeof run.attempts[0].endedAt,'string');assert.equal(f.native.jobs.list('s').length,0);
});
