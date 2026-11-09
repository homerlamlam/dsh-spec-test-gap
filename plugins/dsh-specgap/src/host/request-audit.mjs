import fs from 'node:fs/promises';
import path from 'node:path';
import {hashRequest,safePath,readJSON} from './runs.mjs';
import {fail,SpecGapError,ATTEMPT_ID,LIMITS,validText} from '../shared/contract.mjs';

const fields=['workspaceId','runId','sessionId','materialHash','route','budget','request','template'];
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const maximum=6*LIMITS.modelInputBytes+2*LIMITS.reviewOutputBytes+16384;
function validate(attempt,payload) {
  if(!exact(payload,fields) || !ATTEMPT_ID.test(attempt.attemptId) || fields.slice(0,3).some(k=>payload[k]!==attempt[k]) || hashRequest(payload)!==attempt.requestHash || hashRequest(payload.route)!==hashRequest(attempt.modelRoute))fail('INTEGRITY','Audit request identity does not match the attempt.');
  const r=payload.request,b=payload.budget;
  if(!r || Object.keys(r).some(k=>!['provider','model','reasoningEffort','temperature','maxTokens','stop','system','messages'].includes(k)) || r.provider!==payload.route.provider || r.model!==payload.route.model || (r.reasoningEffort ?? null)!==payload.route.reasoningEffort || !exact(b,['outputTokens','timeoutSeconds']) || r.maxTokens!==b.outputTokens)fail('INTEGRITY','Invalid audited model options.');
  if(!Number.isSafeInteger(b.outputTokens) || b.outputTokens<1 || b.outputTokens>LIMITS.outputTokens || !Number.isSafeInteger(b.timeoutSeconds) || b.timeoutSeconds<1 || b.timeoutSeconds>LIMITS.modelTimeoutSeconds || !validText(r.system,LIMITS.modelInputBytes) || !Array.isArray(r.messages) || r.messages.length!==1 || !exact(r.messages[0],['role','content']) || r.messages[0].role!=='user' || !Array.isArray(r.messages[0].content) || r.messages[0].content.length!==1)fail('INTEGRITY','Invalid audited request.');
  const block=r.messages[0].content[0];
  if(!exact(block,['type','text']) || block.type!=='text' || !validText(block.text,LIMITS.modelInputBytes) || Buffer.byteLength(r.system)+Buffer.byteLength(block.text)>LIMITS.modelInputBytes || hashRequest({system:r.system,user:block.text})!==payload.materialHash || !payload.template || typeof payload.template!=='object' || Array.isArray(payload.template))fail('INTEGRITY','Audit material or hash does not match.');
}

/** Dedicated source-bearing audit, NOT a native Session log or a diagnostic stream. */
export function createRequestAudit({store,io=fs}) {
  async function location(attempt) {
    if(!ATTEMPT_ID.test(attempt.attemptId))fail('INTEGRITY','Invalid audit attempt.');
    const run=await store.get(attempt.workspaceId,attempt.runId),stored=run.attempts.find(a=>a.attemptId===attempt.attemptId);
    if(!stored || ['workspaceId','runId','sessionId','requestHash'].some(k=>stored[k]!==attempt[k]) || hashRequest(stored.modelRoute)!==hashRequest(attempt.modelRoute))fail('INTEGRITY','Audit is not bound to a registered attempt.');
    const p=await store.paths(attempt.workspaceId,attempt.runId),directory=path.join(p.directory,`audit-${attempt.attemptId}`),file=path.join(directory,'request.json');
    await safePath(directory);await safePath(file);return {directory,file,stored};
  }
  async function read(attempt) {
    const {file}=await location(attempt);let record;
    try{record=await readJSON(file,maximum);}catch(e){if(e instanceof SpecGapError)throw e;fail('INTEGRITY','Audit cannot be reopened.');}
    if(!exact(record,['schemaVersion',...fields,'attemptId','requestHash']) || record.schemaVersion!==1 || record.attemptId!==attempt.attemptId || record.requestHash!==attempt.requestHash)fail('INTEGRITY','Invalid audit record.');
    const payload=Object.fromEntries(fields.map(k=>[k,record[k]]));validate(attempt,payload);return record;
  }
  async function commit(attempt,payload) {
    validate(attempt,payload);
    const {directory,file,stored}=await location(attempt);
    if(stored.phase!=='running')fail('CONFLICT','Only a running attempt can commit its first request audit.');
    const record={schemaVersion:1,...structuredClone(payload),attemptId:attempt.attemptId,requestHash:attempt.requestHash},text=JSON.stringify(record);
    if(Buffer.byteLength(text)>maximum)fail('INTEGRITY','Audit exceeds its bounded storage limit.');
    let handle;
    try {
      // The directory is a permanent one-use reservation, including after any failure.
      // No stale-lock repair, record replacement or cleanup of unknown artifacts.
      try{await io.mkdir(directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('CONFLICT','The attempt audit slot is already occupied.');throw e;}
      await safePath(directory);
      const pending=path.join(directory,'request.pending');
      handle=await io.open(pending,'wx',0o600);await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;
      await safePath(pending);await safePath(file);
      // link is atomic and fails if the final name already exists; rename would overwrite.
      await io.link(pending,file);await io.unlink(pending);
      await safePath(file);
      // POSIX can flush the new directory entry. Node/Windows cannot fsync directories;
      // the file flush is awaited there, but no power-loss directory guarantee is claimed.
      if(process.platform!=='win32')for(const dir of [directory,path.dirname(directory)]){handle=await io.open(dir,'r');await handle.sync();await handle.close();handle=null;}
    }catch(e){if(e instanceof SpecGapError)throw e;fail('ENVIRONMENT','Private request audit could not be durably finalized.');}
    finally{try{await handle?.close();}catch{fail('ENVIRONMENT','Private request audit handle could not be closed.');}}
    const reopened=await read(attempt);
    if(hashRequest(reopened)!==hashRequest(record))fail('INTEGRITY','Reopened audit differs from the confirmed request.');
    return reopened;
  }
  return {commit,read};
}
