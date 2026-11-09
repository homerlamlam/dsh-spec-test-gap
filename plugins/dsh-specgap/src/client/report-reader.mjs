import {validateReportSelection} from './report-navigation.mjs';
const failure=code=>Object.assign(new Error(code),{code});
// Read-only, per-tab lifetime. Never shares the Workbench mutation/consent client.
export function createReportReader({selection,request,intervalMs=30000,readTimeoutMs=20000,now=Date.now,isVisible=()=>true,setTimer=setTimeout,clearTimer=clearTimeout}){
 const {workspaceId,sessionId,runId}=validateReportSelection(selection),payload={workspaceId,sessionId,runId};
 let state={view:null,markdown:null,filename:null,syncedAt:null,busy:false,error:null},disposed=false,timer=null,inFlight=null,controller=null,visible=isVisible();
 const listeners=new Set();
 function publish(patch){if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();}
 function clear(){if(timer!==null){clearTimer(timer);timer=null;}}
 function schedule(){clear();if(!disposed&&visible&&isVisible())timer=setTimer(()=>{timer=null;void refresh();},Math.max(10000,intervalMs));}
 function assertScope(view){if(view?.workspaceId!==workspaceId||view?.runId!==runId)throw failure('REPORT_SCOPE_MISMATCH');}
 function refresh(){
  if(disposed)return Promise.resolve();
  if(inFlight)return inFlight;
  clear();controller=new AbortController();const current=controller;
  publish({busy:true,error:null});
  inFlight=(async()=>{
   let deadline,removeAbort=()=>{};
   try{
    const reads=(async()=>{
     const before=await request('run',payload,current.signal);current.signal.throwIfAborted();assertScope(before);
     const report=await request('report',payload,current.signal);current.signal.throwIfAborted();
     const after=await request('run',payload,current.signal);current.signal.throwIfAborted();assertScope(after);
     // Host report has no revision field. Do not claim synchronization if the
     // public view (including stale reasons and attempts) changed around it.
     if(JSON.stringify(before)!==JSON.stringify(after))throw failure('REPORT_CHANGED');
     if(typeof report?.markdown!=='string')throw failure('REPORT_INVALID_RESPONSE');
     return {view:after,markdown:report.markdown,filename:report.filename||null,syncedAt:now(),error:null};
    })();
    const timeout=new Promise((_,reject)=>{const abort=()=>reject(current.signal.reason);current.signal.addEventListener('abort',abort,{once:true});removeAbort=()=>current.signal.removeEventListener('abort',abort);deadline=setTimeout(()=>current.abort(failure('REPORT_TIMEOUT')),readTimeoutMs);});
    const next=await Promise.race([reads,timeout]);
    if(controller===current)publish(next);
   }catch(e){if(!disposed&&controller===current&&(!current.signal.aborted||e?.code==='REPORT_TIMEOUT'))publish({error:{code:e?.code||'UNAVAILABLE',requestId:e?.requestId}});}
   finally{clearTimeout(deadline);removeAbort();if(!disposed&&controller===current){publish({busy:false});inFlight=null;schedule();}}
  })();
  return inFlight;
 }
 return {getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},refresh,
  activate(){if(disposed){disposed=false;controller=null;inFlight=null;publish({busy:false});}},
  setVisible(next){visible=!!next;if(!visible){clear();return Promise.resolve();}return refresh();},
  dispose(){if(disposed)return;disposed=true;clear();controller?.abort();listeners.clear();}
 };
}
