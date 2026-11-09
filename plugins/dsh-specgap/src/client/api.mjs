import {readRecovery} from './recovery.mjs';
/** Cookie-authenticated owner transport. Selectors never confer authority. */
export async function action(operation,payload={},signal) {
  const response=await fetch('/api/specgap/v1/action',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({operation,payload}),signal});
  const result=await response.json();
  if(!response.ok || result.ok!==true){
    const error=new Error(result.error?.code ?? 'UNAVAILABLE');
    error.code=error.message;error.requestId=result.requestId;error.definitive=true;throw error;
  }
  return result.data;
}
export const bootstrap=(payload,signal)=>action('bootstrap',payload,signal);
export const bytes=text=>new TextEncoder().encode(text).length;
export const validInput=(text,units=12000,limit=Infinity)=>typeof text==='string' && !!text.trim() && text.length<=units && text.isWellFormed() && !text.includes('\0') && bytes(text)<=limit;
export const relativePath=text=>validInput(text,4096) && !/^[\\/]|:/.test(text) && !text.split(/[\\/]/).includes('..');
export function physicalLines(text){if(!text)return [];const lines=text.split(/\r\n|\r|\n/);if(/[\r\n]$/.test(text))lines.pop();return lines;}
export function reviewFlags(view){
  if(!view)return [];
  return [...(!view.review?['noReview']:view.review.findings.length===0?['zeroFindings']:[]),
    ...(view.bundle?.limitations?.length?['partial']:[]),
    ...(view.bundle?.warnings?.some(x=>x.startsWith('Worktree status unknown:'))?['dirtyUnknown']:[]),
    ...(view.bundle?.warnings?.some(x=>x.startsWith('Uncommitted/untracked'))?['dirtyIgnored']:[]),
    ...(view.status?.stale?['stale']:[])];
}
const storageKey='specgap.pending-intent.v1';
const empty={view:null,history:null,refs:null,catalog:null,preview:null,confirmation:null,report:null,analysis:null,analysisStarted:false};
const same=(a,b)=>['workspaceId','sessionId','runId'].every(k=>(a[k]||'')===(b[k]||''));
const issue=e=>({code:e.code||'UNAVAILABLE',requestId:e.requestId||null});
/** One active intent per tab; up to seven explicitly parked unresolved human intents.
 * Exact payloads are saved BEFORE dispatch. No automatic recovery/retry. */
export function createClient({transport=action,storage,newKey=()=>crypto.randomUUID()}={}){
  let state={selection:{workspaceId:'',sessionId:'',runId:''},...empty,bootstrap:null,busy:{},error:null,mutation:null,foreignPending:false};
  let generation=0,consent=0,disposed=false,record=null,parked=[],flight=null,storageFault=false;
  const listeners=new Set(),requests=new Map();
  try{
    storage??=globalThis.sessionStorage;
    const raw=storage.getItem(storageKey);
    if(raw!==null){
      const saved=readRecovery(raw); // Validate the whole envelope before adopting any receipt.
      record=saved.active;parked=saved.parked;
      if(record?.phase==='sending')record.phase='ambiguous';
    }
  }catch{storageFault=true;state.error={code:'RECOVERY_STORAGE'};}
  const notify=patch=>{state={...state,...patch};if(!disposed)for(const fn of listeners)fn();};
  const expose=()=>notify({mutation:record&&same(record.selection,state.selection)?{phase:record.phase,operation:record.operation,error:record.error}:null,foreignPending:!!record&&!same(record.selection,state.selection),parkedCount:parked.length});
  function persist(){try{if(record||parked.length){const text=JSON.stringify({version:1,active:record,parked});if(bytes(text)>8*1024*1024)throw new Error('bounded recovery');storage.setItem(storageKey,text);}else storage.removeItem(storageKey);return true;}catch{notify({error:{code:'RECOVERY_STORAGE'}});return false;}}
  const selectors=()=>Object.fromEntries(Object.entries(state.selection).filter(([,v])=>v));
  function abort(){for(const req of requests.values())req.controller.abort();requests.clear();}
  function select(patch){generation++;consent++;abort();const selection={...state.selection,...patch};
    if(patch.workspaceId!==undefined&&patch.workspaceId!==state.selection.workspaceId){selection.sessionId=patch.sessionId||'';selection.runId=patch.runId||'';}
    if(!record){const retained=parked.find(r=>r.selection.workspaceId===selection.workspaceId&&r.selection.runId===selection.runId);if(retained){record=retained;parked=parked.filter(r=>r!==retained);persist();}}
    notify({selection,...empty,busy:{},error:null});expose();
  }
  async function query(channel,operation,extra={},consume){
    if(disposed)return;
    if(channel==='view'){invalidateConsent();notify({view:null});}
    if(['confirmAnalysis','analyze','cancel'].includes(operation)&&state.busy[channel])return;
    requests.get(channel)?.controller.abort();const controller=new AbortController(),g=generation,c=consent;
    const entry={controller};requests.set(channel,entry);notify({busy:{...state.busy,[channel]:true},error:null});
    const current=()=>!disposed&&!controller.signal.aborted&&g===generation&&requests.get(channel)===entry&&(!['preview','confirmation'].includes(channel)||c===consent);
    try{
      const selected=selectors();if(['bootstrap','refs','runs','models'].includes(operation))delete selected.runId;
      const value=await transport(operation,{...selected,...extra},controller.signal);
      if(current()){notify({[channel]:value});consume?.(value);return value;}
    }catch(e){if(current())notify({error:issue(e)});}
    finally{if(current()){requests.delete(channel);notify({busy:{...state.busy,[channel]:false}});}}
  }
  function invalidateConsent(){consent++;for(const key of ['preview','confirmation']){requests.get(key)?.controller.abort();requests.delete(key);}notify({preview:null,confirmation:null,busy:{...state.busy,preview:false,confirmation:false}});}
  async function refreshRecord(r,g,controller){
    if(g!==generation||disposed)return false;
    requests.get('view')?.controller.abort();
    const entry={controller};requests.set('view',entry);
    invalidateConsent();notify({view:null,busy:{...state.busy,view:true}});
    const current=()=>g===generation&&!disposed&&!controller.signal.aborted&&requests.get('view')===entry;
    try{
      const value=await transport('run',Object.fromEntries(Object.entries({...r.selection,runId:r.result?.runId||r.selection.runId}).filter(([,v])=>v)),controller.signal);
      if(!current())return false;
      notify({view:value});return true;
    }catch(e){if(current())notify({error:issue(e)});return false;}
    finally{if(requests.get('view')===entry){requests.delete('view');notify({busy:{...state.busy,view:false}});}}
  }
  async function execute(r){
    if(flight)return flight;
    const recovering=r.phase==='ambiguous',g=generation,controller=new AbortController();requests.set('mutation',{controller});
    const work=async()=>{
      if(r.phase==='committedRefreshFailed'){
        if(await refreshRecord(r,g,controller))r.phase='committed';persist();expose();return;
      }
      r.phase='sending';if(!persist()){r.phase='ambiguous';expose();return;}expose();
      try{
        const result=await transport(r.operation,r.payload,controller.signal);r.result=result?.runId?{runId:result.runId}:null;
        if(['prepare','demo'].includes(r.operation))r.selection={...r.selection,runId:result.runId};
        r.phase='committed';persist();
        if(g===generation&&!disposed){
          if(['prepare','demo'].includes(r.operation)){notify({selection:{...state.selection,runId:result.runId},...empty,view:result});r.selection={...state.selection};}
          else if(!await refreshRecord(r,g,controller))r.phase='committedRefreshFailed';
        }
      }catch(e){
        r.error=issue(e);
        // STALE can follow commit. A recovery CONFLICT can be an interrupted receipt,
        // not a rejected event: a successful run read cannot settle that original key.
        r.phase=!e.definitive||['STALE','CANCELLED','TIMEOUT','UNAVAILABLE','INTERNAL'].includes(e.code)||recovering&&e.code==='CONFLICT'?'ambiguous':e.code==='CONFLICT'?'conflict':'rejected';
        if(g===generation&&!disposed){notify({error:issue(e)});if(r.phase==='conflict'&&r.selection.runId)r.refreshed=await refreshRecord(r,g,controller);}
      }finally{persist();expose();requests.delete('mutation');}
    };
    flight=work();try{await flight;}finally{flight=null;requests.delete('mutation');}
  }
  function mutate(operation,extra){
    if(disposed)return Promise.resolve();
    if(storageFault){notify({error:{code:'RECOVERY_STORAGE'}});return Promise.resolve();}
    if(record)return flight||Promise.resolve();
    record={operation,selection:{...state.selection},payload:{...selectors(),...structuredClone(extra),idempotencyKey:newKey()},phase:'sending'};
    if(!persist()){record=null;return Promise.resolve();}return execute(record);
  }
  async function recover(){if(record&&same(record.selection,state.selection)&&['ambiguous','committedRefreshFailed'].includes(record.phase))await execute(record);}
  function acknowledge(){if(!record||flight)return;if(['committed','rejected'].includes(record.phase)||record.phase==='conflict'&&record.refreshed){record=null;persist();expose();}}
  expose();
  return {getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},select,query,invalidateConsent,mutate,recover,acknowledge,
    refresh:()=>query('view','run',{},()=>{if(record&&same(record.selection,state.selection)&&record.phase==='conflict'){record.refreshed=true;persist();expose();}}),
    sendAnalysis(){const token=state.confirmation;if(!token||state.analysisStarted||Date.parse(token.expiresAt)<=Date.now())return;invalidateConsent();notify({analysisStarted:true});return query('analysis','analyze',{confirmationId:token.confirmationId});},
    parkForNewSnapshot(){
      if(flight||!record||record.phase!=='ambiguous'||!['STALE','CONFLICT'].includes(record.error?.code)||!['respond','decide','verify'].includes(record.operation)||parked.length>=7)return false;
      const original=record;parked.push(original);record=null;
      if(!persist()){record=original;parked.pop();expose();return false;}
      select({runId:''});return true;
    },
    returnToPending(){const pending=record||parked[0];if(pending)select(pending.selection);},
    activate(){disposed=false;},
    dispose(){disposed=true;generation++;abort();listeners.clear();notify({...empty,busy:{}});},
  };
}
export function download(text,filename,type){
  // Only owned Blob URLs, never a URL from reviewed material. Immediate revocation
  // after the click keeps URLs effect-free and does not leave timers/listeners.
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');
  try{a.href=url;a.download=filename;a.click();}finally{URL.revokeObjectURL(url);}
}
