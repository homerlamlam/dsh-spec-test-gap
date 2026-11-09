import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath,mkdir,open,rename,unlink,opendir} from 'node:fs/promises';
import {fail,SpecGapError,RUN_ID,ATTEMPT_ID,validText,parseStrictJSON,ERROR_CODES} from '../shared/contract.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
const phases=new Set(['queued','running','validating',...terminal]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const hashRequest=value=>hash(JSON.stringify(canonical(value)));
const inside=(root,target)=>{const rel=path.relative(root,target);return rel==='' || (!rel.startsWith(`..${path.sep}`) && rel!=='..' && !path.isAbsolute(rel));};
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const date=value=>typeof value==='string' && Number.isFinite(Date.parse(value));
const nullableCode=value=>value===null || ERROR_CODES.includes(value);
const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);

/** Check every existing ancestor; never follow links in owned storage. */
export async function safePath(target) {
  if(!path.isAbsolute(target))fail('ENVIRONMENT','Private storage root is unavailable.');
  const parent=path.dirname(target);
  if(parent!==target)await safePath(parent);
  try {
    const info=await lstat(target);
    if(info.isSymbolicLink() || (!info.isDirectory() && info.nlink!==1))fail('FORBIDDEN','Linked private storage is not permitted.');
    if(!samePath(await realpath(target),path.normalize(target)))fail('FORBIDDEN','Private storage was redirected.');
  }catch(e){if(e.code!=='ENOENT')throw e;}
  return target;
}
export async function readJSON(file,max=4*1024*1024) {
  await safePath(file);
  let handle;
  try {
    const before=await lstat(file);if(!before.isFile() || before.size>max)fail('INTEGRITY','Invalid stored record.');
    handle=await open(file,'r');const opened=await handle.stat();
    if(before.ino!==opened.ino || before.dev!==opened.dev)fail('INTEGRITY','Stored record changed while opening.');
    const chunks=[];let bytes=0;
    while(true){const buffer=Buffer.alloc(Math.min(65536,max+1-bytes)),{bytesRead}=await handle.read(buffer);if(!bytesRead)break;bytes+=bytesRead;if(bytes>max)fail('INTEGRITY','Stored record exceeds limit.');chunks.push(buffer.subarray(0,bytesRead));}
    await safePath(file);
    return parseStrictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(e){if(e instanceof SpecGapError && e.code==='FORBIDDEN')throw e;if(e.code==='ENOENT')throw e;fail('INTEGRITY','Stored record cannot be validated.');}
  finally{await handle?.close();}
}
async function atomicJSON(file,value) {
  await safePath(file);
  const temp=path.join(path.dirname(file),`.tmp-${randomUUID()}`);let handle,owned=false;
  try {
    handle=await open(temp,'wx',0o600);owned=true;
    await handle.writeFile(JSON.stringify(value),'utf8');await handle.sync();await handle.close();handle=null;
    await safePath(file);await safePath(path.dirname(file));await rename(temp,file);owned=false;
  }catch(e){if(e instanceof SpecGapError)throw e;fail('ENVIRONMENT','Private metadata could not be committed.');}
  finally {
    await handle?.close();
    // Only our unique temporary file, never a core lock or failed run directory.
    if(owned){try{await safePath(temp);await unlink(temp);}catch{}}
  }
}
function validateAttempt(a,workspaceId,runId) {
  if(!exact(a,['schemaVersion','attemptId','runId','workspaceId','sessionId','phase','modelRoute','requestHash','jobId','startedAt','endedAt','error']) || a.schemaVersion!==1 || !ATTEMPT_ID.test(a.attemptId) || a.runId!==runId || a.workspaceId!==workspaceId || !validText(a.sessionId) || !phases.has(a.phase) || !digest(a.requestHash) || !date(a.startedAt) || !(a.endedAt===null || date(a.endedAt)) || !nullableCode(a.error) || !(a.jobId===null || validText(a.jobId)) || !exact(a.modelRoute,['provider','model','reasoningEffort']) || !validText(a.modelRoute.provider) || !validText(a.modelRoute.model) || !(a.modelRoute.reasoningEffort===null || validText(a.modelRoute.reasoningEffort)))fail('INTEGRITY','Invalid stored attempt.');
}
function validateMetadata(m,workspaceId,runId) {
  if(!exact(m,['schemaVersion','runId','workspaceId','workspaceRoot','repoLabel','kind','requestHash','createdAt','phase','error','attempts']) || m.schemaVersion!==1 || m.runId!==runId || m.workspaceId!==workspaceId || !path.isAbsolute(m.workspaceRoot || '') || !validText(m.repoLabel,256) || !['prepare','demo'].includes(m.kind) || !digest(m.requestHash) || !date(m.createdAt) || !['preparing','ready','failed','interrupted'].includes(m.phase) || !nullableCode(m.error) || !Array.isArray(m.attempts) || m.attempts.length>1000)fail('INTEGRITY','Invalid run metadata.');
  const seen=new Set();for(const attempt of m.attempts){validateAttempt(attempt,workspaceId,runId);if(seen.has(attempt.attemptId))fail('INTEGRITY','Duplicate stored attempt.');seen.add(attempt.attemptId);}
}

/** All paths are derived; persisted IDs never confer authority or supply paths. */
export function createRunStore({root,runtime}) {
  const queues=new Map(),recovered=new Set();
  let pinnedRoot;
  function serial(key,fn) {
    const previous=queues.get(key) || Promise.resolve(),pending=previous.catch(()=>{}).then(fn);
    queues.set(key,pending);pending.finally(()=>{if(queues.get(key)===pending)queues.delete(key);}).catch(()=>{});return pending;
  }
  async function roots(workspaceId) {
    if(!validText(workspaceId))fail('INVALID_INPUT','Invalid workspace ID.');
    const w=runtime.workspace(workspaceId);
    if(typeof root!=='string' || !path.isAbsolute(root) || typeof w.path!=='string' || !path.isAbsolute(w.path))fail('UNAVAILABLE','Native private storage or workspace is unavailable.');
    const workspaceRoot=await realpath(w.path);await safePath(root);
    const dataRoot=path.resolve(root);
    if(inside(workspaceRoot,dataRoot) || inside(dataRoot,workspaceRoot))fail('FORBIDDEN','Plugin storage and audited workspace must be separate.');
    if(pinnedRoot && !samePath(dataRoot,pinnedRoot))fail('FORBIDDEN','Private storage was redirected.');pinnedRoot=dataRoot;
    // Keep owned Git fixtures below Windows' ordinary path limit; IDs retain 128-bit namespaces.
    const directory=path.join(dataRoot,'w_'+hash(workspaceId).slice(0,32));await safePath(directory);
    return {workspaceRoot,dataRoot,directory};
  }
  function checkId(runId){if(typeof runId!=='string' || !RUN_ID.test(runId))fail('INVALID_INPUT','Invalid run ID.');}
  async function location(workspaceId,runId) {checkId(runId);const r=await roots(workspaceId);const directory=path.join(r.directory,runId);await safePath(directory);return {...r,directory};}
  async function load(workspaceId,runId) {
    const p=await location(workspaceId,runId);let m;
    try{m=await readJSON(path.join(p.directory,'metadata.json'));}catch(e){if(e.code==='ENOENT')fail('NOT_FOUND','Run is not registered in this workspace.');throw e;}
    validateMetadata(m,workspaceId,runId);
    if(!samePath(m.workspaceRoot,p.workspaceRoot))fail('STALE','Workspace root changed since this run was created.');
    const key=workspaceId+':'+runId;
    if(!recovered.has(key)) {
      let changed=false;
      for(const a of m.attempts)if(!terminal.has(a.phase)){a.phase='interrupted';a.endedAt=new Date().toISOString();a.error='UNAVAILABLE';changed=true;}
      if(m.phase==='preparing'){m.phase='interrupted';m.error='UNAVAILABLE';changed=true;}
      if(changed)await atomicJSON(path.join(p.directory,'metadata.json'),m);
      recovered.add(key);
    }
    return {p,m};
  }
  const get=(workspaceId,runId)=>serial('meta:'+workspaceId+':'+runId,async()=>structuredClone((await load(workspaceId,runId)).m));
  async function create(workspaceId,input) {
    if(!exact(input,['kind','idempotencyKey','requestHash','repoLabel']) || !['prepare','demo'].includes(input.kind) || !validText(input.idempotencyKey,128) || !digest(input.requestHash) || !validText(input.repoLabel,256))fail('INVALID_INPUT','Invalid run creation.');
    return serial('create:'+workspaceId,async()=>{
      const runId='run_'+hashRequest([workspaceId,input.kind,input.idempotencyKey]).slice(0,32),p=await location(workspaceId,runId);
      await mkdir(path.dirname(p.directory),{recursive:true,mode:0o700});await safePath(p.directory);
      try{await mkdir(p.directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')fail('ENVIRONMENT','Private run could not be created.');const existing=await get(workspaceId,runId);if(existing.requestHash!==input.requestHash || existing.kind!==input.kind)fail('CONFLICT','Idempotency key has a different request.');return existing;}
      const m={schemaVersion:1,runId,workspaceId,workspaceRoot:p.workspaceRoot,repoLabel:input.repoLabel,kind:input.kind,requestHash:input.requestHash,createdAt:new Date().toISOString(),phase:'preparing',error:null,attempts:[]};
      await atomicJSON(path.join(p.directory,'metadata.json'),m);recovered.add(workspaceId+':'+runId);return structuredClone(m);
    });
  }
  async function update(workspaceId,runId,patch) {
    if(!exact(patch,['phase','error']) || !['ready','failed','interrupted'].includes(patch.phase) || !nullableCode(patch.error))fail('INVALID_INPUT','Invalid run state update.');
    return serial('meta:'+workspaceId+':'+runId,async()=>{
      const {p,m}=await load(workspaceId,runId);
      if(m.phase!=='preparing' && (m.phase!==patch.phase || m.error!==patch.error))fail('CONFLICT','Run creation is immutable.');
      Object.assign(m,patch);await atomicJSON(path.join(p.directory,'metadata.json'),m);return structuredClone(m);
    });
  }
  async function paths(workspaceId,runId) {
    const m=await get(workspaceId,runId),p=await location(workspaceId,runId);
    if(!samePath(m.workspaceRoot,p.workspaceRoot))fail('STALE','Workspace changed while resolving the run.');
    const runPath=path.join(p.directory,m.kind==='demo'?'demo/run':'core');await safePath(runPath);
    return {...p,runPath,demoPath:path.join(p.directory,'demo')};
  }
  async function list(workspaceId,{limit=25,offset=0}={}) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0 || offset>10000)fail('INVALID_INPUT','Invalid history page.');
    const p=await roots(workspaceId),records=[];let dir;
    try{dir=await opendir(p.directory);}catch(e){if(e.code==='ENOENT')return {items:[],nextOffset:null};throw e;}
    for await(const entry of dir){
      if(!RUN_ID.test(entry.name))continue;
      if(records.length===10000)fail('UNAVAILABLE','Run history exceeds its bounded scan limit.');
      const {workspaceRoot,requestHash,attempts,...summary}=await get(workspaceId,entry.name);
      records.push({...summary,attemptCount:attempts.length,lastAttemptPhase:attempts.at(-1)?.phase ?? null});
    }
    records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || a.runId.localeCompare(b.runId));
    return {items:records.slice(offset,offset+limit),nextOffset:offset+limit<records.length?offset+limit:null};
  }
  async function attempt(workspaceId,runId,record) {
    validateAttempt(record,workspaceId,runId);
    return serial('meta:'+workspaceId+':'+runId,async()=>{
      const {p,m}=await load(workspaceId,runId),index=m.attempts.findIndex(a=>a.attemptId===record.attemptId),previous=m.attempts[index];
      if(previous){
        if(['requestHash','sessionId','startedAt'].some(k=>previous[k]!==record[k]) || hashRequest(previous.modelRoute)!==hashRequest(record.modelRoute))fail('CONFLICT','Attempt identity is immutable.');
        if(terminal.has(previous.phase)){if(hashRequest(previous)!==hashRequest(record))fail('CONFLICT','Attempt result is immutable.');return structuredClone(previous);}
        m.attempts[index]=record;
      }else {if(m.attempts.length>=1000)fail('CONFLICT','Attempt history limit reached.');m.attempts.push(record);}
      await atomicJSON(path.join(p.directory,'metadata.json'),m);return structuredClone(record);
    });
  }
  async function record(workspaceId,runId,key,value) {
    if(!digest(key))fail('INVALID_INPUT','Invalid operation record key.');
    const p=await paths(workspaceId,runId),file=path.join(p.directory,`operation-${key}.json`);
    if(value===undefined){try{return await readJSON(file,20*1024*1024);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
    await atomicJSON(file,value);return value;
  }
  return {create,get,list,paths,update,attempt,record,roots,exclusive:(workspaceId,runId,fn)=>serial('operation:'+workspaceId+':'+runId,fn)};
}
