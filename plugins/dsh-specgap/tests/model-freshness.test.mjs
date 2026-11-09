import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './model-fixtures.mjs';
import {deferred,code} from './service-fixtures.mjs';
import {hashRequest} from '../src/host/runs.mjs';
import {createModelReview} from '../src/host/models.mjs';
import {createRequestAudit} from '../src/host/request-audit.mjs';

// Real runtime/store/audit/attempts; only native jobs/model/Python boundaries are scripted.
async function audited(t) {
  let durable;
  const state={committed:false,reopened:false,afterRead:null};
  const f=await setup(t,createModelReview,{audit:{
    async commit(...args){const value=await durable.commit(...args);state.committed=true;return value;},
    async read(...args){const value=await durable.read(...args);state.reopened=true;await state.afterRead?.();return value;},
  }});
  durable=createRequestAudit({store:f.store});return {...f,audit:durable,auditState:state};
}
function changeMaterial(f) {
  f.state.material.user+=' changed during pre-dispatch checkpoint';
  f.state.material.hash=hashRequest({system:f.state.material.system,user:f.state.material.user});
  f.state.material.bytes=Buffer.byteLength(f.state.material.system)+Buffer.byteLength(f.state.material.user);
}

for(const [checkpoint,changes] of [ ['audit-reopen',['freshness','material']], ['root-preflight',['freshness','material']], ['material-response',['freshness']] ]) {
  for(const change of changes)test(`${change} changing during ${checkpoint} prevents dispatch and retains failed audit through native cleanup`,async t=>{
    const f=await audited(t),consent=await f.consent(),entered=deferred(),release=deferred(),nativeTerminal=deferred(),releaseNative=deferred();
    let held=false,settled=false,completion;
    const hold=async()=>{if(held)return;held=true;entered.resolve();await release.promise;};
    if(checkpoint==='audit-reopen')f.auditState.afterRead=hold;
    if(checkpoint==='root-preflight'){
      const roots=f.store.roots;f.store.roots=async(...args)=>{const value=await roots(...args);if(f.auditState.reopened)await hold();return value;};
    }
    if(checkpoint==='material-response'){
      const call=f.bridge.callBridge;f.bridge.callBridge=async(op,...args)=>{const value=await call(op,...args);if(f.auditState.committed && op==='material')await hold();return value;};
    }
    const wait=f.ctx.jobs.wait;
    f.ctx.jobs.wait=async(...args)=>{const result=await wait(...args);nativeTerminal.resolve(result);await releaseNative.promise;return result;};
    try {
      const started=await f.models.start(consent.confirmationId,f.authority);
      completion=f.attempts.wait(started.attemptId).then(value=>{settled=true;return value;});
      await Promise.race([entered.promise,nativeTerminal.promise.then(()=>assert.fail('Expected pre-dispatch checkpoint was not reached.'))]);
      assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);assert.equal(settled,false);
      const running=(await f.store.get('w',f.run.runId)).attempts[0];assert.equal(running.phase,'running');
      const before=await f.audit.read(running);assert.deepEqual(before.request,consent.preview.request);
      if(change==='freshness')f.state.stale=true;else changeMaterial(f);
      release.resolve();await nativeTerminal.promise;
      assert.equal(settled,false,'Resident cleanup must still wait for native terminal acknowledgement.');
      releaseNative.resolve();const result=await completion;
      assert.equal(result.phase,'failed');assert.equal(result.error,'STALE');
      assert.equal(f.calls.stream,0,'A stale pre-dispatch snapshot must never invoke the native stream.');assert.equal(f.calls.imports,0);
      assert.equal(f.jobs.get(started.jobId).status,'failed');assert.equal(f.jobs.size,1);
      assert.deepEqual((await f.store.get('w',f.run.runId)).attempts,[result]);
      assert.deepEqual(await f.audit.read(result),before,'The failed attempt must retain its exact committed audit.');
      await assert.rejects(f.models.start(consent.confirmationId,f.authority),code('CONFLICT'));
      await f.models.dispose();assert.equal(settled,true);
    }finally{release.resolve();releaseNative.resolve();await completion;}
  });
}

test('freshness must be observed again if asynchronous root work follows its last snapshot',async t=>{
  const f=await audited(t),consent=await f.consent();let observed=false,invalidated=false;
  const call=f.bridge.callBridge,roots=f.store.roots;
  f.bridge.callBridge=async(op,...args)=>{const value=await call(op,...args);if(f.auditState.committed && op==='read')observed=true;return value;};
  f.store.roots=async(...args)=>{
    const value=await roots(...args);
    if(observed && f.calls.stream===0){await Promise.resolve();f.state.stale=true;invalidated=true;}
    return value;
  };
  const result=await f.finish(consent);assert.equal(observed,true);
  // Both safe implementations are valid: no post-snapshot root await, or a later fresh read rejecting the change.
  assert.equal(f.calls.stream,invalidated?0:1,'Do not reuse freshness observed before an asynchronous root checkpoint.');
  assert.equal(f.calls.imports,invalidated?0:1);assert.equal(result.phase,invalidated?'failed':'completed');
  if(invalidated)assert.equal(result.error,'STALE');
});

for(const change of ['agent','cancel'])test(`${change} at the final freshness response still prevents native invocation`,async t=>{
  const f=await audited(t),consent=await f.consent(),controller=new AbortController(),call=f.bridge.callBridge;let changed=false;
  f.bridge.callBridge=async(op,...args)=>{
    const value=await call(op,...args);
    if(f.auditState.committed && op==='read' && !changed){changed=true;if(change==='agent')f.agents.set('s',{});else controller.abort();}
    return value;
  };
  const started=await f.models.start(consent.confirmationId,{...f.authority,signal:controller.signal});
  const result=await f.attempts.wait(started.attemptId);assert.equal(changed,true);
  assert.equal(result.phase,change==='agent'?'failed':'cancelled');assert.equal(result.error,change==='agent'?'STALE':'CANCELLED');
  assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);assert.equal(f.jobs.get(started.jobId).status,change==='agent'?'failed':'killed');
  assert.deepEqual((await f.audit.read(result)).request,consent.preview.request);
});
