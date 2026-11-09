import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import {createRequestAudit} from '../src/host/request-audit.mjs';
import {createAttempts} from '../src/host/attempts.mjs';
import path from 'node:path';
import {setup,route,budget,chunks} from './model-fixtures.mjs';
import {deferred,code,prepareInput} from './service-fixtures.mjs';
import {hashRequest,createRunStore} from '../src/host/runs.mjs';
import {createService} from '../src/host/service.mjs';
const {createModelReview}=await import('../src/host/models.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

// All model services are scripted. No credentials, providers or source transmission.
test('bootstrap discloses native-dispatch readiness and private-only audit without preparing a model',async t=>{
  const f=await setup(t,createModelReview),result=await f.runtime.bootstrap({},f.authority);
  assert.equal(result.diagnostics.find(d=>d.capability==='modelDispatch').available,true);assert.match(result.auditLocation,/not the native Session log/);assert.equal(f.calls.prepare,0);assert.equal(f.calls.stream,0);
  delete f.ctx.llm;assert.equal((await f.runtime.bootstrap({},f.authority)).diagnostics.find(d=>d.capability==='modelDispatch').available,false);
});
test('catalog/preview never stream; effective lower native budget and full input are shown',async t=>{
  const f=await setup(t,createModelReview);const models=await f.models.catalog(f.authority);assert.equal(models.groups[0].models[0].reasoning.efforts[0].id,'low');
  const preview=await f.models.preview(f.run.runId,route,budget,f.authority);
  assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);assert.equal(preview.request.maxTokens,4096);
  assert.equal(preview.request.system,f.state.material.system);assert.equal(preview.request.messages[0].content[0].text,f.state.material.user);
  assert.deepEqual(preview.template,f.state.material.template);assert.match(preview.auditLocation,/plugin-private/);
  assert.equal(JSON.stringify(preview).includes('DO-NOT-LOG'),false);
});
test('actual dispatch equals confirmed input and reopened immutable audit; routing is not global config',async t=>{
  const f=await setup(t,createModelReview),consent=await f.consent();
  f.ctx.sessionController.modelCatalog=async()=>{throw Error('global selection changed');};
  f.state.onStream=async request=>{
    const attempt=(await f.store.get('w',f.run.runId)).attempts[0],p=await f.store.paths('w',f.run.runId);
    const disk=JSON.parse(await readFile(path.join(p.directory,`audit-${attempt.attemptId}`,'request.json'),'utf8'));
    assert.equal(disk.workspaceId,'w');assert.equal(disk.sessionId,'s');assert.equal(disk.runId,f.run.runId);assert.equal(disk.attemptId,attempt.attemptId);
    assert.deepEqual(disk.request,consent.preview.request);assert.deepEqual(disk.template,consent.preview.template);
    const {signal,...sent}=request;assert.ok(signal instanceof AbortSignal);assert.deepEqual(sent,{...disk.request,sessionId:'s'});
    assert.equal(disk.requestHash,consent.preview.previewHash);assert.equal(JSON.stringify(disk).includes('DO-NOT-LOG'),false);
    assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.messages[0].content));
  };
  const result=await f.finish(consent);assert.equal(result.phase,'completed');assert.equal(f.calls.stream,1);assert.equal(f.calls.imports,1);
  assert.ok(f.calls.progress.length>0);assert.equal(JSON.stringify(f.calls.progress).includes('consented source'),false);
  await assert.rejects(f.models.start(consent.confirmationId,f.authority),code('CONFLICT'));
  await assert.rejects(f.models.preview(f.run.runId,route,budget,f.authority),code('CONFLICT'));
});
test('missing model, nonexistent effort, invalid budget, oversized material and lower context fail before dispatch',async t=>{
  const f=await setup(t,createModelReview);
  for(const selected of [{...route,model:'missing'},{...route,provider:'missing'},{...route,reasoningEffort:'imaginary'}])await assert.rejects(f.models.preview(f.run.runId,selected,budget,f.authority),code('INVALID_INPUT'));
  for(const limits of [{outputTokens:8193},{timeoutSeconds:301},{outputTokens:0},{apiKey:'forbidden'}])await assert.rejects(f.models.preview(f.run.runId,route,limits,f.authority),code('INVALID_INPUT'));
  f.state.model.context.contextWindow=32;await assert.rejects(f.models.preview(f.run.runId,route,budget,f.authority),code('INVALID_INPUT'));
  f.state.material.user='x'.repeat(8388609);await assert.rejects(f.models.preview(f.run.runId,route,budget,f.authority),code('INVALID_INPUT'));assert.equal(f.calls.stream,0);
});
test('confirmation is single issue, expires after ten minutes and double start admits at most one attempt',async t=>{
  const f=await setup(t,createModelReview);const preview=await f.models.preview(f.run.runId,route,budget,f.authority);
  const confirmation=await f.models.confirm(preview.previewHash,f.authority);
  await assert.rejects(f.models.confirm(preview.previewHash,f.authority),code('CONFLICT'));
  const results=await Promise.allSettled([f.models.start(confirmation.confirmationId,f.authority),f.models.start(confirmation.confirmationId,f.authority)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await f.attempts.wait(results.find(r=>r.status==='fulfilled').value.attemptId);assert.equal(f.calls.stream,1);
  const g=await setup(t,createModelReview),expired=await g.consent(),now=Date.now;
  t.mock.method(Date,'now',()=>now()+600001);
  await assert.rejects(g.models.start(expired.confirmationId,g.authority),code('CONFLICT'));assert.equal(g.calls.stream,0);
});
test('wrong workspace/run/session, changed live Agent or material invalidate consent without model calls',async t=>{
  for(const change of ['workspace','session','run','agent','material','stale'])await t.test(change,async t=>{
    const f=await setup(t,createModelReview),c=await f.consent();let authority=f.authority;
    if(change==='workspace')authority={...authority,workspaceId:'other'};
    if(change==='session')authority={...authority,sessionId:'other-s'};
    if(change==='run')authority={...authority,runId:'run_'+'e'.repeat(32)};
    if(change==='agent')f.agents.set('s',{});
    if(change==='material'){f.state.material.user+=' changed';f.state.material.hash=hashRequest({system:f.state.material.system,user:f.state.material.user});f.state.material.bytes=Buffer.byteLength(f.state.material.system)+Buffer.byteLength(f.state.material.user);}
    if(change==='stale')f.state.stale=true;
    await assert.rejects(f.models.start(c.confirmationId,authority),e=>['STALE','CONFLICT'].includes(e.code));assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);
  });
});
test('new preview invalidates prior model/reasoning/budget selection and cannot reuse an old token',async t=>{
  const f=await setup(t,createModelReview),c=await f.consent();await f.models.preview(f.run.runId,{...route,reasoningEffort:null},{...budget,outputTokens:1024},f.authority);
  await assert.rejects(f.models.start(c.confirmationId,f.authority),code('CONFLICT'));assert.equal(f.calls.stream,0);
});
test('audit failure, cancellation before dispatch and hash mismatch never call stream or import',async t=>{
  for(const kind of ['audit','cancel','hash'])await t.test(kind,async t=>{
    const controller=new AbortController();const f=await setup(t,createModelReview,kind==='audit'?{audit:{commit:async()=>{throw Object.assign(Error('secret audit details'),{code:'ENVIRONMENT'});}}}:{});
    const c=await f.consent();
    if(kind==='cancel'){controller.abort();await assert.rejects(f.models.start(c.confirmationId,{...f.authority,signal:controller.signal}),code('CANCELLED'));}
    else if(kind==='hash'){f.state.material.hash='b'.repeat(64);await assert.rejects(f.models.start(c.confirmationId,f.authority),code('INTEGRITY'));}
    else {const result=await f.finish(c);assert.equal(result.phase,'failed');assert.equal(result.error,'ENVIRONMENT');}
    assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);
  });
});
test('oversize, empty, malformed, duplicate JSON, truncation, tool calls and missing finish fail without import',async t=>{
  for(const [name,events] of Object.entries({oversize:chunks('x'.repeat(1048577)),empty:chunks(''),invalid:chunks('not json'),duplicate:chunks('{"findings":[],"findings":[]}'),truncated:[...chunks('{}').slice(0,-1),{type:'finish',reason:{kind:'max-tokens'}}],tool:[{type:'tool-call-delta',index:0,name:'exec',argumentsDelta:'{}'}],unfinished:chunks('{}').slice(0,-1)}))await t.test(name,async t=>{
    const f=await setup(t,createModelReview);f.state.events=events;const result=await f.finish(await f.consent());assert.equal(result.phase,'failed');assert.equal(f.calls.stream,1);assert.equal(f.calls.imports,0);
  });
});
test('provider failure is redacted, never retried; explicit retry needs new preview/confirmation',async t=>{
  const f=await setup(t,createModelReview);f.state.stream=async function*(){throw Error('apiKey=secret raw source');};
  const c=await f.consent(),failed=await f.finish(c);assert.equal(failed.phase,'failed');assert.equal(failed.error,'UNAVAILABLE');assert.equal(f.calls.stream,1);
  assert.equal(JSON.stringify(await f.store.get('w',f.run.runId)).includes('apiKey'),false);
  f.state.stream=null;const completed=await f.finish(await f.consent());assert.equal(completed.phase,'completed');assert.equal(f.calls.stream,2);
});
test('freshness after generation and immutable existing review prevent import',async t=>{
  for(const conflict of ['stale','review'])await t.test(conflict,async t=>{
    const f=await setup(t,createModelReview);f.state.onStream=async()=>{if(conflict==='stale')f.state.stale=true;else f.state.review={already:'present'};};
    const result=await f.finish(await f.consent());assert.equal(result.phase,'failed');assert.equal(f.calls.imports,0);assert.equal(f.calls.stream,1);
  });
});
test('cancel/dispose do not settle while native stream cleanup remains resident',async t=>{
  for(const action of ['cancel','dispose'])await t.test(action,async t=>{
    const f=await setup(t,createModelReview),entered=deferred(),aborted=deferred(),cleanup=deferred();
    f.state.stream=async function*({signal}){try{entered.resolve();await new Promise(r=>signal.addEventListener('abort',()=>{aborted.resolve();r();},{once:true}));}finally{await cleanup.promise;}};
    const a=await f.models.start((await f.consent()).confirmationId,f.authority);await entered.promise;
    let settled=false;const pending=(action==='cancel'?f.attempts.cancel(a.attemptId,f.authority):f.models.dispose()).then(()=>{settled=true;});
    await aborted.promise;assert.equal(settled,false);cleanup.resolve();await pending;assert.equal((await f.attempts.wait(a.attemptId)).phase,'cancelled');assert.equal(f.calls.imports,0);
  });
});
test('timeout aborts and awaits provider cleanup with one invocation',async t=>{
  const f=await setup(t,createModelReview);f.state.stream=async function*({signal}){await new Promise(r=>signal.addEventListener('abort',r,{once:true}));};
  const result=await f.finish(await f.consent(route,{timeoutSeconds:1,outputTokens:100}));assert.equal(result.phase,'failed');assert.equal(result.error,'TIMEOUT');assert.equal(f.calls.stream,1);assert.equal(f.calls.imports,0);
});
test('browser contracts route model actions and reject caller authority/config injection',async t=>{
  const f=await setup(t,createModelReview),service=createService({runtime:f.runtime,store:f.store,bridge:f.bridge,attempts:f.attempts});t.after(()=>service.dispose());
  const selector={workspaceId:'w',sessionId:'s',runId:f.run.runId};
  const preview=await service.dispatch('material',{...selector,route,budget},f.authority);
  const c=await service.dispatch('confirmAnalysis',{...selector,previewHash:preview.previewHash},f.authority);
  await assert.rejects(service.dispatch('analyze',{...selector,...c,route},f.authority),code('INVALID_INPUT'));
  const a=await service.dispatch('analyze',{...selector,confirmationId:c.confirmationId},f.authority);await f.attempts.wait(a.attemptId);assert.equal(f.calls.stream,1);
});
test('unroutable catalog entries cannot become prepared requests',async t=>{
  const f=await setup(t,createModelReview),catalog=f.ctx.sessionController.modelCatalog;
  f.ctx.sessionController.modelCatalog=async()=>({...await catalog(),routableProviders:[]});
  await assert.rejects(f.models.preview(f.run.runId,route,budget,f.authority),code('INVALID_INPUT'));assert.equal(f.calls.prepare,0);assert.equal(f.calls.stream,0);
});
test('bounded preview capacity still allows replacing the same run selection',async t=>{
  const f=await setup(t,createModelReview);await f.models.preview(f.run.runId,route,budget,f.authority);
  for(let i=0;i<7;i++){const run=await f.store.create('w',prepareInput('capacity-'+i));await f.store.update('w',run.runId,{phase:'ready',error:null});await f.models.preview(run.runId,route,budget,{...f.authority,runId:run.runId});}
  const replacement=await f.models.preview(f.run.runId,route,{outputTokens:128},f.authority);assert.equal(replacement.budget.outputTokens,128);assert.equal(f.calls.stream,0);
});
test('write, fsync, atomic finalization and reopen mismatch prevent any model dispatch',async t=>{
  for(const fault of ['writeFile','sync','link','reopen'])await t.test(fault,async t=>{
    let f;const io={...fs};
    if(fault==='link')io.link=async()=>{throw Error('private fs detail');};
    else if(fault!=='reopen')io.open=async(...args)=>{const handle=await fs.open(...args);if(args[1]==='wx')return {writeFile:async(...a)=>{if(fault==='writeFile')throw Error('private write detail');return handle.writeFile(...a);},sync:async()=>{if(fault==='sync')throw Error('private flush detail');return handle.sync();},close:()=>handle.close()};return handle;};
    const audit={commit:(a,p)=>createRequestAudit({store:f.store,io}).commit(a,p),async read(a){const value=await createRequestAudit({store:f.store}).read(a);return fault==='reopen'?{...value,materialHash:'0'.repeat(64)}:value;}};
    f=await setup(t,createModelReview,{audit});const result=await f.finish(await f.consent());assert.equal(result.phase,'failed');assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);
    const p=await f.store.paths('w',f.run.runId);assert.ok((await fs.readdir(p.directory)).includes(`audit-${result.attemptId}`));
  });
});
test('cancellation during flushed audit prevents stream and retains the committed artifact',async t=>{
  let f;const written=deferred(),release=deferred(),audit={async commit(a,p){const result=await createRequestAudit({store:f.store}).commit(a,p);written.resolve(a);await release.promise;return result;},read:a=>createRequestAudit({store:f.store}).read(a)};
  f=await setup(t,createModelReview,{audit});const a=await f.models.start((await f.consent()).confirmationId,f.authority),persisted=await written.promise;
  const cancelling=f.attempts.cancel(a.attemptId,f.authority);release.resolve();assert.equal((await cancelling).phase,'cancelled');assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);
  assert.equal((await audit.read(persisted)).requestHash,persisted.requestHash);
});
test('restart recovers interrupted request and immutable audit without replaying its invocation',async t=>{
  const f=await setup(t,createModelReview),c=await f.consent();await f.models.dispose();
  // Construct the exact durable checkpoint of a process lost after audit, before stream.
  const a={schemaVersion:1,attemptId:'attempt_'+'b'.repeat(32),workspaceId:'w',runId:f.run.runId,sessionId:'s',phase:'running',modelRoute:c.preview.route,requestHash:c.preview.previewHash,jobId:'specgap-lost-process',startedAt:new Date().toISOString(),endedAt:null,error:null};
  await f.store.attempt('w',f.run.runId,a);const {previewHash,expiresAt,bytes,auditLocation,...payload}=c.preview;await createRequestAudit({store:f.store}).commit(a,payload);
  const store=createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),attempts=createAttempts({store,runtime:f.runtime}),models=createModelReview({store,runtime:f.runtime,attempts,bridge:f.bridge});t.after(()=>models.dispose());
  assert.equal((await store.get('w',f.run.runId)).attempts[0].phase,'interrupted');assert.equal((await createRequestAudit({store}).read(a)).requestHash,c.preview.previewHash);
  await assert.rejects(models.start(c.confirmationId,f.authority),code('CONFLICT'));assert.equal(f.calls.stream,0);assert.equal(f.calls.imports,0);
});
