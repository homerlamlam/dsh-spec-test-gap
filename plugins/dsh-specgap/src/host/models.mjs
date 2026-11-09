import {randomBytes} from 'node:crypto';
import {fail,ERROR_CODES,LIMITS,validText,validateModelInput,parseStrictJSON} from '../shared/contract.mjs';
import {hashRequest} from './runs.mjs';
import {createRequestAudit} from './request-audit.mjs';

const tenMinutes=600000;
const freeze=value=>{if(value && typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const key=authority=>JSON.stringify([authority.workspaceId,authority.sessionId,authority.runId]);
const stopped=signal=>{if(signal?.aborted)fail('CANCELLED','SpecGap analysis was cancelled.');};
function owner(authority) {
  if(authority?.isOwner!==true)fail('FORBIDDEN','Owner access required.');
  if(!validText(authority.workspaceId) || !validText(authority.sessionId))fail('INVALID_INPUT','A workspace and live Session are required.');
}
function sameAuthority(entry,authority) {
  owner(authority);
  if(authority.workspaceId!==entry.payload.workspaceId || authority.sessionId!==entry.payload.sessionId || authority.runId && authority.runId!==entry.payload.runId)fail('STALE','The confirmation belongs to another workspace, run or Session.');
}
function safeFailure(error,signal,timeout) {
  if(signal?.aborted)fail(timeout?.aborted?'TIMEOUT':'CANCELLED',timeout?.aborted?'SpecGap analysis timed out.':'SpecGap analysis was cancelled.');
  const code=ERROR_CODES.includes(error?.code)?error.code:'UNAVAILABLE';
  fail(code,'SpecGap model operation failed; no automatic retry was made.');
}
function validateMaterial(material) {
  if(!validText(material?.system,LIMITS.modelInputBytes) || !validText(material?.user,LIMITS.modelInputBytes))fail('INVALID_INPUT','Frozen input is empty or oversized.');
  const bytes=Buffer.byteLength(material.system)+Buffer.byteLength(material.user);
  if(bytes>LIMITS.modelInputBytes)fail('INVALID_INPUT','Frozen input exceeds 8 MiB.');
  if(material.bytes!==bytes || material.hash!==hashRequest({system:material.system,user:material.user}) || !material.template || typeof material.template!=='object' || Array.isArray(material.template) || Buffer.byteLength(JSON.stringify(material.template))>LIMITS.reviewOutputBytes)fail('INTEGRITY','Frozen material does not match its hash or schema.');
  return material;
}
async function collect(stream,signal,progress) {
  const blocks=new Map();let bytes=0,events=0,finished=false;
  const add=text=>{if(typeof text!=='string' || !text.isWellFormed())fail('INVALID_REVIEW','Invalid model output text.');bytes+=Buffer.byteLength(text);if(bytes>LIMITS.reviewOutputBytes)fail('INVALID_REVIEW','Model output exceeds 1 MiB.');progress?.(bytes);};
  for await(const event of stream) {
    stopped(signal);
    if(++events>100000 || !event || typeof event!=='object')fail('INVALID_REVIEW','Invalid model stream.');
    if(event.type==='usage')continue; // no raw output or provider-private replay data enters diagnostics
    if(finished)fail('INVALID_REVIEW','Output followed the terminal model response.');
    if(event.type==='finish'){
      if(event.reason?.kind!=='stop')fail(event.reason?.kind==='max-tokens'?'INVALID_REVIEW':'UNAVAILABLE','Model response did not finish normally.');finished=true;continue;
    }
    if(!Number.isSafeInteger(event.index) || event.index<0 || event.index>=64)fail('INVALID_REVIEW','Unsupported output block.');
    if(event.type==='block-start'){
      if(blocks.has(event.index) || !['text','reasoning'].includes(event.blockType))fail('INVALID_REVIEW','Tools and non-text outputs are not permitted.');
      blocks.set(event.index,{type:event.blockType,text:'',ended:false});continue;
    }
    const block=blocks.get(event.index);
    if(!block || block.ended)fail('INVALID_REVIEW','Invalid output block ordering.');
    if(event.type==='text-delta' || event.type==='reasoning-delta'){
      if(block.type!==(event.type==='text-delta'?'text':'reasoning'))fail('INVALID_REVIEW','Invalid output block type.');add(event.text);block.text+=event.text;
    }else if(event.type==='block-end'){
      if(event.block?.type!==block.type || typeof event.block.text!=='string')fail('INVALID_REVIEW','Invalid completed output block.');
      if(block.text===''){add(event.block.text);block.text=event.block.text;}else if(block.text!==event.block.text)fail('INVALID_REVIEW','Completed output differs from its stream.');
      block.ended=true;
    }else fail('INVALID_REVIEW','Tools and unknown model output are not permitted.');
  }
  stopped(signal);
  if(!finished || [...blocks.values()].some(b=>!b.ended))fail('INVALID_REVIEW','Model output is incomplete.');
  const text=[...blocks].sort((a,b)=>a[0]-b[0]).filter(([,b])=>b.type==='text').map(([,b])=>b.text).join('');
  let review;try{review=parseStrictJSON(text);}catch{fail('INVALID_REVIEW','Model output must be complete strict JSON.');}
  if(!review || typeof review!=='object' || Array.isArray(review))fail('INVALID_REVIEW','Model review must be an object.');
  return review;
}

/** One-shot auxiliary requests, never Agent turns, tool execution or global model changes. */
export function createModelReview({runtime,bridge,attempts,store,audit=createRequestAudit({store})}) {
  const lifetime=new AbortController(),previews=new Map(),confirmations=new Map(),latest=new Map(),active=new Set();let disposed=false,disposing;
  function purge() {
    for(const [id,entry] of latest)if(entry.expires<=Date.now()){latest.delete(id);previews.delete(entry.hash);confirmations.delete(entry.confirmationId);}
  }
  async function check(entry,signal) {
    stopped(signal);runtime.checkBinding(entry.session);
    const roots=await store.roots(entry.payload.workspaceId);
    if(roots.workspaceRoot!==entry.workspaceRoot)fail('STALE','The original workspace changed.');
    stopped(signal);runtime.checkBinding(entry.session);
  }
  async function scope(authority,signal,runId) {
    owner(authority);stopped(signal);
    if(authority.runId && runId && authority.runId!==runId)fail('STALE','The selected run changed.');
    const roots=await store.roots(authority.workspaceId),session=await runtime.bindSession(authority.workspaceId,authority.sessionId,signal);
    const entry={workspaceRoot:roots.workspaceRoot,session,payload:{workspaceId:authority.workspaceId,sessionId:authority.sessionId,...(runId?{runId}:{})}};
    await check(entry,signal);return entry;
  }
  async function bridgePaths(entry,signal) {
    await check(entry,signal);const p=await store.paths(entry.payload.workspaceId,entry.payload.runId);await check(entry,signal);
    return {workspaceRoot:p.workspaceRoot,dataRoot:p.dataRoot,runPath:p.runPath};
  }
  async function call(entry,operation,signal,extra={}) {
    const p=await bridgePaths(entry,signal);
    const result=await bridge.callBridge(operation,{...p,...extra},{signal});
    // A committed import is a success, even if the old UI authority disappears while
    // the bridge returns. Never reclassify a committed mutation as failed or replay it.
    if(operation!=='import_review')await check(entry,signal);
    return result;
  }
  async function material(entry,signal) {
    const run=await store.get(entry.payload.workspaceId,entry.payload.runId);
    if(run.phase!=='ready')fail('CONFLICT','Run preparation is not complete.');
    // Finish async path/root preparation before material, then observe freshness last.
    // No post-read root await may turn this final freshness result into an older snapshot.
    const p=await bridgePaths(entry,signal);
    const source=validateMaterial(await bridge.callBridge('material',p,{signal}));
    stopped(signal);runtime.checkBinding(entry.session);
    const view=await bridge.callBridge('read',p,{signal});
    stopped(signal);runtime.checkBinding(entry.session);
    if(view.status?.stale!==false)fail('STALE','The frozen run is stale. Prepare a new run.');
    if(view.review!==null || run.attempts.some(a=>a.phase==='completed'))fail('CONFLICT','A successful review is immutable.');
    return source;
  }
  async function unchanged(entry,signal) {
    const current=await material(entry,signal);
    if(current.hash!==entry.payload.materialHash || hashRequest(current.template)!==hashRequest(entry.payload.template))fail('STALE','Frozen model material changed after preview.');
  }
  async function catalogFor(entry,signal) {
    await check(entry,signal);const raw=await runtime.modelCatalog();await check(entry,signal);
    if(!Array.isArray(raw?.groups) || !Array.isArray(raw?.failures) || !Array.isArray(raw?.routableProviders))fail('UNAVAILABLE','Native model catalog is unavailable.');
    const text=value=>{if(!validText(value,256))fail('UNAVAILABLE','Invalid native model catalog.');return value;};
    const routableProviders=raw.routableProviders.map(text);
    const groups=raw.groups.filter(g=>routableProviders.includes(g.id)).map(g=>({
      id:text(g.id),name:text(g.name),models:g.models.map(m=>{
        const model={id:text(m.id),name:text(m.name)};
        if(m.reasoning){
          model.reasoning={efforts:m.reasoning.efforts.map(e=>({id:text(e.id),name:text(e.name)}))};
          if(m.reasoning.defaultEffort)model.reasoning.defaultEffort=text(m.reasoning.defaultEffort);
        }
        return model;
      }),
    }));
    const failures=raw.failures.map(f=>({id:text(f.id),name:text(f.name),message:'Native model catalog lookup failed.'}));
    const selected=raw.default && groups.find(g=>g.id===raw.default.provider)?.models.find(m=>m.id===raw.default.model)?{provider:raw.default.provider,model:raw.default.model,...(raw.default.reasoningEffort?{reasoningEffort:text(raw.default.reasoningEffort)}:{})}:null;
    return {default:selected,routableProviders,groups,failures,limits:LIMITS};
  }
  function ensureCurrent(entry,authority) {
    sameAuthority(entry,authority);
    if(entry.expires<=Date.now() || latest.get(entry.key)!==entry)fail('CONFLICT','Preview or confirmation expired or was replaced.');
  }
  const operations={
    async catalog(authority,signal){return catalogFor(await scope(authority,signal),signal);},
    async preview(runId,route,budget,authority,signal) {
      const selected=validateModelInput(route,budget),entry=await scope(authority,signal,runId);
      const source=await material(entry,signal),data=await catalogFor(entry,signal),model=data.groups.find(g=>g.id===selected.route.provider)?.models.find(m=>m.id===selected.route.model);
      if(!model || selected.route.reasoningEffort!==null && !model.reasoning?.efforts.some(e=>e.id===selected.route.reasoningEffort))fail('INVALID_INPUT','Select an available model and advertised reasoning effort.');
      const prepared=await runtime.prepareModel(entry.session,selected.route,selected.budget,source.bytes,signal);
      await check(entry,signal);
      const c=prepared.config;
      if(c.provider!==selected.route.provider || c.model!==selected.route.model || !Number.isSafeInteger(c.maxTokens) || c.maxTokens<1 || c.maxTokens>selected.budget.outputTokens || (c.reasoningEffort!==undefined && !model.reasoning?.efforts.some(e=>e.id===c.reasoningEffort)) || selected.route.reasoningEffort!==null && c.reasoningEffort!==selected.route.reasoningEffort)fail('INTEGRITY','Prepared model route or budget differs from the selected route.');
      const config={provider:c.provider,model:c.model,maxTokens:c.maxTokens};
      // Copy only documented model-visible controls, never an opaque prepared object.
      if(c.reasoningEffort!==undefined)config.reasoningEffort=c.reasoningEffort;
      if(c.temperature!==undefined){if(!Number.isFinite(c.temperature))fail('INTEGRITY','Invalid native sampling control.');config.temperature=c.temperature;}
      if(c.stop!==undefined){if(!Array.isArray(c.stop) || c.stop.length>16 || c.stop.some(s=>!validText(s,4096)))fail('INTEGRITY','Invalid native stop control.');config.stop=[...c.stop];}
      const request={...config,system:source.system,messages:[{role:'user',content:[{type:'text',text:source.user}]}]};
      entry.payload=freeze({...entry.payload,materialHash:source.hash,route:{provider:c.provider,model:c.model,reasoningEffort:c.reasoningEffort ?? null},budget:{outputTokens:c.maxTokens,timeoutSeconds:selected.budget.timeoutSeconds},request,template:structuredClone(source.template)});
      entry.hash=hashRequest(entry.payload);entry.prepared=prepared;entry.expires=Date.now()+tenMinutes;entry.key=key(entry.payload);
      purge();if(!latest.has(entry.key) && latest.size>=8)fail('CONFLICT','Too many outstanding model previews.');
      const previous=latest.get(entry.key);if(previous){previews.delete(previous.hash);if(previous.confirmationId)confirmations.delete(previous.confirmationId);}
      latest.set(entry.key,entry);previews.set(entry.hash,entry);
      return {...structuredClone(entry.payload),previewHash:entry.hash,expiresAt:new Date(entry.expires).toISOString(),bytes:source.bytes,auditLocation:'plugin-private per-attempt request record; not the native Session log'};
    },
    async confirm(previewHash,authority,signal) {
      purge();const entry=previews.get(previewHash);if(!entry)fail('CONFLICT','Preview is missing, expired or already confirmed.');
      ensureCurrent(entry,authority);previews.delete(previewHash); // reserve synchronously, before any await
      await unchanged(entry,signal);await check(entry,signal);ensureCurrent(entry,authority);
      entry.confirmationId='confirmation_'+randomBytes(16).toString('hex');confirmations.set(entry.confirmationId,entry);
      return {confirmationId:entry.confirmationId,expiresAt:new Date(entry.expires).toISOString()};
    },
    async start(confirmationId,authority,signal) {
      purge();const entry=confirmations.get(confirmationId);if(!entry)fail('CONFLICT','Confirmation is missing, expired or already used.');
      ensureCurrent(entry,authority);confirmations.delete(confirmationId); // no automatic or duplicate billable dispatch
      await unchanged(entry,signal);await check(entry,signal);ensureCurrent(entry,authority);latest.delete(entry.key);
      const result=await attempts.start({session:entry.session,runId:entry.payload.runId,idempotencyKey:confirmationId,requestHash:entry.hash,modelRoute:entry.payload.route,signal},async({attempt,signal:attemptSignal,validating,progress})=>{
        const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),entry.payload.budget.timeoutSeconds*1000),execution=AbortSignal.any([attemptSignal,lifetime.signal,timeout.signal]);
        try {
          await unchanged(entry,execution);await audit.commit(attempt,entry.payload);
          const persisted=await audit.read(attempt);
          if(hashRequest(persisted)!==hashRequest({schemaVersion:1,...entry.payload,attemptId:attempt.attemptId,requestHash:entry.hash}))fail('INTEGRITY','Audited input differs from the frozen dispatch.');
          await unchanged(entry,execution);
          const request=Object.freeze({...entry.payload.request,sessionId:entry.payload.sessionId,signal:execution});
          stopped(execution);runtime.checkBinding(entry.session); // synchronous original authority at dispatch
          const review=await collect(entry.prepared.stream(request),execution,progress);
          await validating();
          await store.exclusive(entry.payload.workspaceId,entry.payload.runId,async()=>{
            await unchanged(entry,execution);await check(entry,execution);
            // Python rechecks freshness under its lock and validates every assessment/quote.
            await call(entry,'import_review',execution,{review});
          });
        }catch(e){safeFailure(e,execution,timeout.signal);}finally{clearTimeout(timer);}
      });
      // This is a response barrier, not mutation failure bookkeeping. Do not cancel or
      // rewrite an admitted attempt merely because its initiating UI response is stale.
      await check(entry,signal);return {attemptId:result.attemptId,jobId:result.jobId};
    },
  };
  const api=Object.fromEntries(Object.entries(operations).map(([name,fn])=>[name,async(...args)=>{
    if(disposed)fail('UNAVAILABLE','Model review service is disposed.');
    const authority=args.at(-1),signal=AbortSignal.any([lifetime.signal,...(authority?.signal?[authority.signal]:[])]);
    const pending=(async()=>{try{owner(authority);stopped(signal);return await fn(...args,signal);}catch(e){safeFailure(e,signal);}})();active.add(pending);
    try{return await pending;}finally{active.delete(pending);}
  }]));
  return {...api,dispose(){
    if(disposing)return disposing;disposed=true;lifetime.abort();previews.clear();confirmations.clear();latest.clear();
    disposing=(async()=>{await Promise.allSettled([...active]);await attempts.dispose();})();return disposing;
  }};
}
