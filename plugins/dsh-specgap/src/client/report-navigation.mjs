// Only this module crosses from the global Workbench into a native Conversation.
export const REPORT_KIND='specgap.report';
export const REPORT_ID='@specgap/dsh-plugin/report';
const error=code=>Object.assign(new Error(code),{code});
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
export function validateReportSelection(value){
 if(!value||!['workspaceId','sessionId','runId'].every(key=>identity(value[key]))||!['markdown','json'].includes(value.format))throw error('REPORT_INVALID_SELECTION');
 return {workspaceId:value.workspaceId,sessionId:value.sessionId,runId:value.runId,format:value.format};
}
export function createReportNavigation({bootstrap,layout,uiWorkspace,sidebarRight,waitMs=6000,frame=fn=>requestAnimationFrame(fn),cancelFrame=id=>cancelAnimationFrame(id)}){
 let selected={workspaceId:'',sessionId:'',runId:''},lastError=null,pending=null,disposed=false;
 const listeners=new Set();
 const publish=()=>{for(const fn of listeners)fn();};
 const remember=value=>{selected={workspaceId:value?.workspaceId||'',sessionId:value?.sessionId||'',runId:value?.runId||''};};
 async function openReport(input){
  const selection=validateReportSelection(input);
  if(disposed)throw error('REPORT_NAVIGATION_CANCELLED');
  pending?.abort(error('REPORT_NAVIGATION_CANCELLED'));
  const controller=new AbortController();pending=controller;lastError=null;publish();
  const {signal}=controller;let switched=false,stop=()=>{};
  const originPanel=layout.panelInfo.getSnapshot().activePanelId;
  const stopOrigin=layout.panelInfo.subscribe(()=>{if(!switched&&layout.panelInfo.getSnapshot().activePanelId!==originPanel)controller.abort(error('REPORT_NAVIGATION_CANCELLED'));});
  const timer=setTimeout(()=>controller.abort(error('REPORT_SIDEBAR_UNAVAILABLE')),waitMs);
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});});
  try{
   const data=await Promise.race([bootstrap({},signal),aborted]);
   signal.throwIfAborted();
   if(!data?.workspaces?.find(w=>w.id===selection.workspaceId)?.liveSessionIds?.includes(selection.sessionId))throw error('REPORT_SESSION_UNAVAILABLE');
   remember(selection);switched=true;
   uiWorkspace.openSession(selection.sessionId);
   await Promise.race([new Promise((resolve,reject)=>{
    let frameId,done=false;
    const finish=reason=>{if(done)return;done=true;stop();reason?reject(reason):resolve();};
    const check=()=>{
     frameId=undefined;
     if(signal.aborted)return finish(signal.reason);
     if(layout.panelInfo.getSnapshot().activePanelId!==null)return finish(error('REPORT_NAVIGATION_CANCELLED'));
     const mounted=sidebarRight.mounted.getSnapshot();
     if(mounted&&mounted!==selection.sessionId)return finish(error('REPORT_NAVIGATION_CANCELLED'));
     if(mounted===selection.sessionId){
      try{
       const existing=sidebarRight.openTabs.getSnapshot().find(tab=>tab.sessionId===selection.sessionId&&tab.kind===REPORT_KIND);
       // Reuse the occurrence's pane, including when it was floated, instead of
       // multiplying one singleton page across the Session's panes.
       sidebarRight.openTab(REPORT_KIND,{params:selection,...existing?{replaceTab:existing.tabId}:{}});
       return finish();
      }catch(e){if(e?.message!=='sidebarRight: no session surface is mounted')return finish(error('REPORT_SIDEBAR_UNAVAILABLE'));}
     }
     frameId=frame(check);
    };
    const schedule=()=>{if(frameId===undefined&&!done)frameId=frame(check);};
    const offMounted=sidebarRight.mounted.subscribe(schedule);
    const offPanel=layout.panelInfo.subscribe(()=>{if(layout.panelInfo.getSnapshot().activePanelId!==null)finish(error('REPORT_NAVIGATION_CANCELLED'));else schedule();});
    stop=()=>{offMounted();offPanel();if(frameId!==undefined)cancelFrame(frameId);};
    schedule();
   }),aborted]);
  }catch(e){
   if(pending===controller&&!disposed){lastError={code:e?.code||'REPORT_SIDEBAR_UNAVAILABLE'};publish();
    // Do not steal a later user navigation. A failed mount returns to a visible
    // Workbench error, whose state is not owned by the now-unmounted caller.
    if(switched&&e?.code!=='REPORT_NAVIGATION_CANCELLED'&&layout.panelInfo.getSnapshot().activePanelId===null&&[undefined,selection.sessionId].includes(sidebarRight.mounted.getSnapshot()))layout.selectPanel('specgap');
   }
   throw e;
  }finally{clearTimeout(timer);stopOrigin();stop();signal.removeEventListener('abort',rejectAbort);if(pending===controller)pending=null;}
 }
 return {openReport,remember,getSelection:()=>({...selected}),getError:()=>lastError,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  returnToWorkbench(value){pending?.abort(error('REPORT_NAVIGATION_CANCELLED'));remember(value);lastError=null;publish();layout.selectPanel('specgap');},
  dispose(){if(disposed)return;disposed=true;pending?.abort(error('REPORT_NAVIGATION_CANCELLED'));listeners.clear();for(const tab of sidebarRight.openTabs.getSnapshot())if(tab.kind===REPORT_KIND)sidebarRight.closeIn(tab.sessionId,tab.tabId);}
 };
}
