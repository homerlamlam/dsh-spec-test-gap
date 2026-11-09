// Browser-only validation of untrusted tab storage. Never repair or normalize an intent.
// Reuse pure contract primitives, not validateRequest (which uses Host Buffer APIs).
import {ERROR_CODES,LIMITS,RUN_ID,validText,relativePath,parseStrictJSON} from '../shared/contract.mjs';
const bytes=text=>new TextEncoder().encode(text).length;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const shape=(v,required,optional=[])=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const check=ok=>{if(!ok)throw new Error('invalid recovery');};
const human=['respond','decide','verify'];
const phases=['sending','ambiguous','committed','committedRefreshFailed','conflict','rejected'];
const fields={prepare:['repoPath'],demo:[],respond:['runId','finding','actor','attestLocal','expectedSequence','text'],decide:['runId','finding','actor','attestLocal','expectedSequence','outcome','reason'],verify:['runId','finding','actor','attestLocal','expectedSequence','result','evidenceText','note']};
const prepareFields=['requirementsPath','requirementsText','head','target','base','maxFiles','maxBytes','policy'];

function payload(operation,p){
  check(shape(p,['workspaceId','idempotencyKey',...fields[operation]],['sessionId',...(operation==='prepare'?prepareFields:[])]));
  check(validText(p.workspaceId)&&validText(p.idempotencyKey,128));
  if(Object.hasOwn(p,'sessionId'))check(validText(p.sessionId));
  if(operation==='prepare'){
    check(relativePath(p.repoPath)&&Object.hasOwn(p,'requirementsPath')!==Object.hasOwn(p,'requirementsText'));
    if(Object.hasOwn(p,'requirementsPath'))check(relativePath(p.requirementsPath));
    if(Object.hasOwn(p,'requirementsText'))check(validText(p.requirementsText,LIMITS.requirementsBytes)&&bytes(p.requirementsText)<=LIMITS.requirementsBytes);
    for(const k of ['head','target','base'])if(Object.hasOwn(p,k))check(validText(p[k]));
    for(const [k,max] of [['maxFiles',LIMITS.maxContextFiles],['maxBytes',LIMITS.maxContextBytes]])if(Object.hasOwn(p,k))check(Number.isSafeInteger(p[k])&&p[k]>0&&p[k]<=max);
    if(Object.hasOwn(p,'policy')){
      check(shape(p.policy,['actors'])&&object(p.policy.actors)&&bytes(JSON.stringify(p.policy))<=16384);
      for(const [name,roles] of Object.entries(p.policy.actors))check(validText(name,120)&&Array.isArray(roles)&&roles.length>0&&new Set(roles).size===roles.length&&roles.every(r=>['developer','product','qa','security'].includes(r)));
    }
  }
  if(human.includes(operation)){
    check(typeof p.runId==='string'&&RUN_ID.test(p.runId)&&validText(p.finding,120)&&validText(p.actor,120)&&p.attestLocal===true&&Number.isSafeInteger(p.expectedSequence)&&p.expectedSequence>=0);
    for(const k of ['text','reason','note'])if(Object.hasOwn(p,k))check(validText(p[k],12000));
    if(operation==='decide')check(['confirm_defect','not_an_issue','approve_intent_change','accept_risk'].includes(p.outcome));
    if(operation==='verify')check(['passed','failed'].includes(p.result)&&validText(p.evidenceText,LIMITS.verificationBytes)&&bytes(p.evidenceText)<=LIMITS.verificationBytes);
  }
}
function record(r,parked){
  check(shape(r,['operation','phase','selection','payload'],['error','result','refreshed']));
  check(typeof r.operation==='string'&&Object.hasOwn(fields,r.operation)&&phases.includes(r.phase));
  payload(r.operation,r.payload);
  const s=r.selection,p=r.payload,committed=['committed','committedRefreshFailed'].includes(r.phase);
  check(shape(s,['workspaceId','sessionId','runId'])&&validText(s.workspaceId)&&typeof s.sessionId==='string'&&typeof s.runId==='string');
  check(s.workspaceId===p.workspaceId&&s.sessionId===(p.sessionId??''));
  if(human.includes(r.operation)){
    check(s.runId===p.runId);
    if(Object.hasOwn(r,'result'))check(r.result===null);
  }else if(committed){
    // Creation gains a displayed result run; its immutable original payload has no runId.
    check(shape(r.result,['runId'])&&typeof r.result.runId==='string'&&RUN_ID.test(r.result.runId)&&s.runId===r.result.runId);
  }else{
    check(s.runId===''&&!Object.hasOwn(r,'result'));
  }
  if(committed)check(Object.hasOwn(r,'result'));
  if(Object.hasOwn(r,'error'))check(shape(r.error,['code','requestId'])&&ERROR_CODES.includes(r.error.code)&&(r.error.requestId===null||validText(r.error.requestId)));
  if(Object.hasOwn(r,'refreshed'))check(r.phase==='conflict'&&typeof r.refreshed==='boolean');
  if(r.phase==='conflict')check(r.error?.code==='CONFLICT');
  if(r.phase==='rejected')check(r.error&&!['STALE','CONFLICT','CANCELLED','TIMEOUT','UNAVAILABLE','INTERNAL'].includes(r.error.code));
  if(parked)check(human.includes(r.operation)&&r.phase==='ambiguous'&&['STALE','CONFLICT'].includes(r.error?.code));
}
export function readRecovery(raw){
  check(typeof raw==='string'&&bytes(raw)<=8*1024*1024);
  const saved=parseStrictJSON(raw);check(object(saved));
  let active,parked;
  if(Object.hasOwn(saved,'version')){
    check(shape(saved,['version','active','parked'])&&saved.version===1&&Array.isArray(saved.parked)&&saved.parked.length<=7);
    active=saved.active;parked=saved.parked;
  }else{active=saved;parked=[];} // Legacy single-intent format, with the same strict validation.
  if(active!==null)record(active,false);
  for(const r of parked)record(r,true);
  const runs=new Set(),receipts=new Set();
  for(const r of [active,...parked].filter(Boolean)){
    const p=r.payload,key=JSON.stringify([r.operation,p.workspaceId,p.runId??'',p.idempotencyKey]);
    check(!receipts.has(key));receipts.add(key);
    if(r.selection.runId){
      const run=JSON.stringify([r.selection.workspaceId,r.selection.runId]);
      check(!runs.has(run));runs.add(run); // Switching Sessions must not bypass the old-run lock.
    }
  }
  return {active,parked};
}
