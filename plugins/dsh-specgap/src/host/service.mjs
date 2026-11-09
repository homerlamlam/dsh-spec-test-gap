import path from 'node:path';
import {fail,validateRequest,ERROR_CODES} from '../shared/contract.mjs';
import {createBridge} from './bridge.mjs';
import {createRunStore,hashRequest} from './runs.mjs';
import {createAttempts} from './attempts.mjs';
import {createModelReview} from './models.mjs';

const safeCode=e=>ERROR_CODES.includes(e?.code)?e.code:'INTERNAL';
const corePayload=p=>({workspaceRoot:p.workspaceRoot,dataRoot:p.dataRoot,runPath:p.runPath});
const view=(m,core)=>({runId:m.runId,workspaceId:m.workspaceId,repoLabel:m.repoLabel,createdAt:m.createdAt,bundle:core?.bundle ?? null,policy:core?.policy ?? null,status:core?.status ?? {phase:m.phase,error:m.error},review:core?.review ?? null,events:core?.events ?? [],expectedSequence:core?.expectedSequence ?? null,attempts:m.attempts});

/** Authority is supplied by the admitted native Host route, never decoded from JSON. */
export function createService({runtime,bridge=createBridge({environment:signal=>runtime.bridgeEnvironment(signal)}),store=createRunStore({root:runtime.dataRoot,runtime}),attempts=createAttempts({store,runtime})}) {
  const lifetime=new AbortController(),active=new Set(),models=createModelReview({runtime,bridge,attempts,store});let disposed=false,disposing;
  async function scope(payload,authority) {
    if(authority.workspaceId && authority.workspaceId!==payload.workspaceId || authority.sessionId && authority.sessionId!==payload.sessionId)fail('STALE','UI workspace or session changed.');
    const roots=await store.roots(payload.workspaceId);
    const session=payload.sessionId?await runtime.bindSession(payload.workspaceId,payload.sessionId,authority.signal):null;
    return {...roots,session};
  }
  async function check(payload,context,signal) {
    if(signal.aborted)fail('CANCELLED','Request cancelled.');
    const current=await store.roots(payload.workspaceId);
    if(current.workspaceRoot!==context.workspaceRoot)fail('STALE','Workspace changed during the operation.');
    if(context.session)runtime.checkBinding(context.session);
  }
  async function checkedBridge(operation,wire,payload,context,signal) {
    await check(payload,context,signal);
    const result=await bridge.callBridge(operation,wire,{signal});
    await check(payload,context,signal);
    return result;
  }
  async function call(operation,payload,context,signal,extra={}) {
    const p=await store.paths(payload.workspaceId,payload.runId);
    return checkedBridge(operation,{...corePayload(p),...extra},payload,context,signal);
  }
  async function readRun(payload,context,signal) {
    const m=await store.get(payload.workspaceId,payload.runId);
    const core=m.phase==='ready'?await call('read',payload,context,signal):null;
    await check(payload,context,signal);return view(m,core);
  }
  async function remembered(operation,payload,fn,verifyReplay) {
    const key=hashRequest([operation,payload.idempotencyKey]),requestHash=hashRequest({operation,payload});
    return store.exclusive(payload.workspaceId,payload.runId,async()=>{
      const previous=await store.record(payload.workspaceId,payload.runId,key);
      if(previous) {
        if(Object.keys(previous).sort().join(',')!=='error,requestHash,result,schemaVersion,state' || previous.schemaVersion!==1 || !['running','completed','failed'].includes(previous.state) || !ERROR_CODES.includes(previous.error) && previous.error!==null)fail('INTEGRITY','Invalid stored operation.');
        if(previous.requestHash!==requestHash)fail('CONFLICT','Idempotency key has a different request.');
        if(previous.state==='completed'){await verifyReplay?.();return structuredClone(previous.result);}
        if(previous.state==='failed')fail(previous.error || 'INTERNAL','The original operation failed; use a new key for a new operation.');
        fail('CONFLICT','The original operation was interrupted; its artifacts are preserved.');
      }
      const record={schemaVersion:1,requestHash,state:'running',result:null,error:null};
      await store.record(payload.workspaceId,payload.runId,key,record);
      try {
        const result=await fn();
        await store.record(payload.workspaceId,payload.runId,key,{...record,state:'completed',result});
        return result;
      }catch(e){await store.record(payload.workspaceId,payload.runId,key,{...record,state:'failed',error:safeCode(e)});throw e;}
    });
  }
  async function perform(operation,payload,authority) {
    if(operation==='bootstrap')return runtime.bootstrap(payload,authority);
    const signal=authority.signal,context=await scope(payload,authority);
    const result=await performScoped(operation,payload,context,signal);
    // Admission must still hold after the final durable write or replay await.
    // Keep this outside mutation error handling: a stale reply cannot undo a committed result.
    await check(payload,context,signal);
    return result;
  }
  async function performScoped(operation,payload,context,signal) {
    const modelAuthority={isOwner:true,workspaceId:payload.workspaceId,sessionId:payload.sessionId,runId:payload.runId,signal};
    if(operation==='models')return models.catalog(modelAuthority);
    if(operation==='confirmAnalysis')return models.confirm(payload.previewHash,modelAuthority);
    if(operation==='analyze')return models.start(payload.confirmationId,modelAuthority);
    if(operation==='material' && payload.route)return models.preview(payload.runId,payload.route,payload.budget,modelAuthority);
    if(operation==='refs') {
      const repoPath=await runtime.resolveInside(context.workspaceRoot,payload.repoPath || '.',signal);
      return checkedBridge('refs',{workspaceRoot:context.workspaceRoot,repoPath},payload,context,signal);
    }
    if(operation==='runs'){
      const result=await store.list(payload.workspaceId,{limit:payload.limit,offset:payload.offset});
      await check(payload,context,signal);return result;
    }
    if(operation==='prepare' || operation==='demo') {
      const extra={};
      if(operation==='prepare') {
        extra.repoPath=await runtime.resolveInside(context.workspaceRoot,payload.repoPath,signal);
        if(payload.requirementsPath)extra.requirementsPath=await runtime.resolveInside(context.workspaceRoot,payload.requirementsPath,signal);
        for(const key of ['requirementsText','head','target','base','maxFiles','maxBytes','policy'])if(Object.hasOwn(payload,key))extra[key]=payload[key];
      }
      await check(payload,context,signal);
      const m=await store.create(payload.workspaceId,{kind:operation,idempotencyKey:payload.idempotencyKey,requestHash:hashRequest({operation,payload}),repoLabel:operation==='demo'?'需求对照示例':path.basename(extra.repoPath).slice(0,256) || '代码仓库'});
      const selected={...payload,runId:m.runId};
      return remembered(operation,selected,async()=>{
        if(m.phase!=='preparing')fail('CONFLICT','Run preparation cannot be restarted.');
        try {
          await check(selected,context,signal);const p=await store.paths(payload.workspaceId,m.runId);
          const core=operation==='demo'?(await checkedBridge('demo',{workspaceRoot:p.workspaceRoot,dataRoot:p.dataRoot,demoPath:p.demoPath},selected,context,signal)).view:await call('prepare',selected,context,signal,extra);
          const ready=await store.update(payload.workspaceId,m.runId,{phase:'ready',error:null});
          return view(ready,core);
        }catch(e){const current=await store.get(payload.workspaceId,m.runId);if(current.phase==='preparing')await store.update(payload.workspaceId,m.runId,{phase:'failed',error:safeCode(e)});throw e;}
      },()=>call('read',selected,context,signal));
    }
    if(operation==='cancel')return attempts.cancel(payload.attemptId,{isOwner:true,workspaceId:payload.workspaceId,sessionId:payload.sessionId,runId:payload.runId});
    if(operation==='run')return readRun(payload,context,signal);
    const m=await store.get(payload.workspaceId,payload.runId);
    if(m.phase!=='ready')fail('CONFLICT','Run preparation is not complete.');
    if(operation==='material')return call('material',payload,context,signal);
    if(operation==='report')return {...await call('report',payload,context,signal),filename:`specgap-${m.runId}.md`};
    if(['respond','decide','verify'].includes(operation))return remembered(operation,payload,async()=>{
      const fields={respond:['text'],decide:['outcome','reason'],verify:['result','evidenceText','note']}[operation];
      const extra=Object.fromEntries(['finding','actor','attestLocal','expectedSequence',...fields].map(key=>[key,payload[key]]));
      const p=await store.paths(payload.workspaceId,payload.runId);
      await check(payload,context,signal);
      // The bridge result is the committed event. Do not re-read or run an
      // authority check here that could misclassify success as failed. Persist
      // it first; perform() checks the ORIGINAL context outside bookkeeping.
      return bridge.callBridge(operation,{...corePayload(p),...extra},{signal});
    },()=>call('read',payload,context,signal));
    if(operation==='importReview')return remembered(operation,payload,async()=>{
      const current=await call('read',payload,context,signal);
      if(current.review!==null)fail('CONFLICT','A successful review is immutable.');
      await call('import_review',payload,context,signal,{review:payload.review});
      return readRun(payload,context,signal);
    },()=>call('read',payload,context,signal));
    fail('UNAVAILABLE','Operation is not implemented.');
  }
  return {
    async dispatch(operation,payload,authority) {
      if(authority?.isOwner!==true)fail('FORBIDDEN','Owner access required.');
      if(disposed)fail('UNAVAILABLE','SpecGap is disposed.');
      if(authority.signal?.aborted)fail('CANCELLED','Request cancelled.');
      validateRequest({operation,payload});
      const signal=AbortSignal.any([lifetime.signal,...(authority.signal?[authority.signal]:[])]);
      const pending=perform(operation,structuredClone(payload),{...authority,signal});active.add(pending);
      try{return await pending;}finally{active.delete(pending);}
    },
    dispose() {
      if(disposing)return disposing;
      disposed=true;lifetime.abort();
      disposing=(async()=>{
        const results=await Promise.allSettled([Promise.resolve().then(()=>models.dispose()),Promise.resolve().then(()=>attempts.dispose()),Promise.resolve().then(()=>bridge.dispose?.())]);
        await Promise.allSettled([...active]);
        results.push(...await Promise.allSettled([Promise.resolve().then(()=>runtime.dispose?.())]));
        const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
      })();
      return disposing;
    },
  };
}
