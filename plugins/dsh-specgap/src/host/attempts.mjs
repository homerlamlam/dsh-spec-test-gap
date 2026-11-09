import {fail,ERROR_CODES,ATTEMPT_ID,validText,LIMITS} from '../shared/contract.mjs';
import {hashRequest} from './runs.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
const safeCode=e=>ERROR_CODES.includes(e?.code)?e.code:'UNAVAILABLE';
const cancelled=()=>Object.assign(new Error('Attempt cancelled.'),{code:'CANCELLED'});

/** Native jobs own execution. This registry only coordinates their durable metadata. */
export function createAttempts({store,runtime}) {
  const lifetime=new AbortController(),entries=new Map();
  let admission=Promise.resolve(),active=null,disposed=false,disposing;
  function stop(entry) {
    if(entry.committed || entry.finished)return;
    entry.controller.abort();
    if(entry.record.jobId)runtime.killJob(entry.session,entry.record.jobId);
  }
  async function initialize(binding,executor) {
    if(disposed)fail('UNAVAILABLE','Attempt manager is disposed.');
    const session=runtime.checkBinding(binding.session),{workspaceId,sessionId}=session;
    if(!validText(binding.idempotencyKey,128) || !/^[a-f0-9]{64}$/.test(binding.requestHash) || typeof executor!=='function')fail('INVALID_INPUT','Invalid attempt request.');
    if(binding.signal?.aborted)throw cancelled();
    const run=await store.get(workspaceId,binding.runId);
    if(run.phase!=='ready')fail('CONFLICT','Run preparation is not complete.');
    const attemptId='attempt_'+hashRequest([workspaceId,binding.runId,binding.idempotencyKey]).slice(0,32);
    const previous=run.attempts.find(a=>a.attemptId===attemptId);
    if(previous) {
      if(previous.requestHash!==binding.requestHash || previous.sessionId!==sessionId || hashRequest(previous.modelRoute)!==hashRequest(binding.modelRoute))fail('CONFLICT','Idempotency key has a different attempt request.');
      return previous;
    }
    if(active || run.attempts.some(a=>a.phase==='completed'))fail('CONFLICT','An analysis is active or this run already has a successful analysis.');
    const record={schemaVersion:1,attemptId,runId:binding.runId,workspaceId,sessionId,phase:'queued',modelRoute:structuredClone(binding.modelRoute),requestHash:binding.requestHash,jobId:null,startedAt:new Date().toISOString(),endedAt:null,error:null};
    await store.attempt(workspaceId,binding.runId,record); // mandatory pre-dispatch persistence
    const controller=new AbortController();let launch;
    const gate=new Promise(resolve=>{launch=resolve;});
    const entry={session,record,controller,committed:false,finished:false,setupError:null,cleanup:null};
    entries.set(attemptId,entry);active=entry;
    const external=AbortSignal.any([lifetime.signal,...(binding.signal?[binding.signal]:[])]);
    const onAbort=()=>{try{stop(entry);}catch(e){entry.cleanupError=e;}};
    external.addEventListener('abort',onAbort,{once:true});
    const persist=async(phase,error=null)=>{
      entry.record={...entry.record,phase,error,endedAt:terminal.has(phase)?new Date().toISOString():null};
      await store.attempt(workspaceId,binding.runId,entry.record);
    };
    const producer=(async()=>{
      await gate;
      try {
        if(entry.setupError)throw entry.setupError;
        if(external.aborted || controller.signal.aborted)throw cancelled();
        await store.paths(workspaceId,binding.runId);runtime.checkBinding(session);
        if(controller.signal.aborted || external.aborted)throw cancelled();
        let reported=-1;
        await executor({attempt:structuredClone(entry.record),signal:controller.signal,
          progress(bytes){if(Number.isSafeInteger(bytes) && bytes>=0 && bytes<=LIMITS.reviewOutputBytes && (reported<0 || bytes-reported>=16384)){entry.job?.updateProgress(`SpecGap received ${bytes} output bytes.`);reported=bytes;}},
          validating:async()=>{if(controller.signal.aborted)throw cancelled();runtime.checkBinding(session);await persist('validating');}});
        // Completion wins cancellation only once the executor has actually settled successfully.
        entry.committed=true;await persist('completed');
        return {status:'completed'};
      }catch(e) {
        const phase=!entry.setupError && (controller.signal.aborted || external.aborted || e?.code==='CANCELLED')?'cancelled':'failed';
        try{await persist(phase,safeCode(e));}catch(persistError){entry.cleanupError=persistError;}
        return {status:phase==='cancelled'?'killed':'failed',detail:'SpecGap attempt '+phase+'.'};
      }finally{external.removeEventListener('abort',onAbort);}
    })();
    entry.cleanup=producer.then(async()=>{
      try {if(entry.record.jobId)await runtime.waitJob(session,entry.record.jobId);if(entry.cleanupError)throw entry.cleanupError;return structuredClone(entry.record);}
      finally{entry.finished=true;if(active===entry)active=null;}
    });
    entry.cleanup.catch(()=>{}); // the caller/owner collects cleanup through wait/cancel/dispose
    try {
      runtime.checkBinding(session);if(external.aborted)throw cancelled();
      const jobId=runtime.startJob(session,{kind:'specgap',label:'SpecGap analysis',run(job){entry.job=job;entry.record.jobId=job.id;return {done:producer,cancel(){if(!entry.committed)controller.abort();}};}});
      entry.record.jobId=jobId;await persist('running');runtime.checkBinding(session);
      if(external.aborted)onAbort();launch();
      return structuredClone(entry.record);
    }catch(e) {
      entry.setupError=e;controller.abort();
      if(entry.record.jobId){try{runtime.killJob(session,entry.record.jobId);}catch{}}
      launch();await entry.cleanup;
      fail(safeCode(e),'Attempt could not start; cleanup has settled.');
    }
  }
  return {
    start(binding,executor) {
      const pending=admission.catch(()=>{}).then(()=>initialize(binding,executor));admission=pending;
      return pending;
    },
    async wait(attemptId) {
      const entry=entries.get(attemptId);if(!entry)fail('NOT_FOUND','Attempt is not active in this service lifetime.');return entry.cleanup;
    },
    async cancel(attemptId,authority) {
      if(authority?.isOwner!==true)fail('FORBIDDEN','Owner access required.');
      if(typeof attemptId!=='string' || !ATTEMPT_ID.test(attemptId))fail('INVALID_INPUT','Invalid attempt ID.');
      const entry=entries.get(attemptId);
      if(entry && (authority.workspaceId!==entry.record.workspaceId || authority.sessionId!==entry.record.sessionId || authority.runId!==entry.record.runId))fail('STALE','UI workspace, run or session changed.');
      const session=await runtime.bindSession(authority.workspaceId,authority.sessionId);
      if(entry && session.agent!==entry.session.agent)fail('STALE','Attempt Agent changed.');
      const run=await store.get(authority.workspaceId,authority.runId),record=run.attempts.find(a=>a.attemptId===attemptId);
      if(!record)fail('NOT_FOUND','Attempt is not registered in this run.');
      if(record.sessionId!==authority.sessionId)fail('STALE','Attempt belongs to another session.');
      if(entry){
        runtime.checkBinding(entry.session);
        // Persisted terminal metadata can precede producer acknowledgement/native settlement.
        if(!terminal.has(record.phase))stop(entry);
        return entry.cleanup;
      }
      if(terminal.has(record.phase))return record;
      fail('UNAVAILABLE','Attempt has no live native owner.');
    },
    dispose() {
      if(disposing)return disposing;
      disposed=true;lifetime.abort();
      disposing=(async()=>{await admission.catch(()=>{});const results=await Promise.allSettled([...entries.values()].map(e=>e.cleanup));const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;})();
      return disposing;
    },
  };
}
