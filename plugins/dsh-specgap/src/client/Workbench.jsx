import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {createClient} from './api.mjs';
import {NewReview,Field,ReviewSteps} from './NewReview.jsx';
import {Review} from './Review.jsx';
import {History,Downloads,Attempts} from './History.jsx';
import {ModelReview} from './ModelReview.jsx';
import {Plain,localizedKey,errorLabel,repositoryLabel} from './presentation.jsx';

// Report navigation is intentionally separate from model dispatch and never creates a Session.
export function ReportPreview({t,state,live,openReport}){
  const [opened,setOpened]=useState(false),[session,setSession]=useState(()=>live.includes(state.selection.sessionId)?state.selection.sessionId:''),[format,setFormat]=useState('markdown');
  const [pending,setPending]=useState(false),[error,setError]=useState(false),[lifetime]=useState(()=>({active:true,pending:false}));
  useEffect(()=>{lifetime.active=true;return()=>{lifetime.active=false;};},[lifetime]);
  const canOpen=!!openReport&&!!state.selection.workspaceId&&!!state.selection.runId&&!!state.view?.bundle&&state.view.runId===state.selection.runId&&state.view.workspaceId===state.selection.workspaceId;
  async function confirm(){
    if(!canOpen||!live.includes(session)||lifetime.pending)return;
    lifetime.pending=true;setPending(true);setError(false);
    try{await openReport({workspaceId:state.selection.workspaceId,sessionId:session,runId:state.selection.runId,format});if(lifetime.active)setOpened(false);}
    catch{if(lifetime.active)setError(true);}
    finally{lifetime.pending=false;if(lifetime.active)setPending(false);}
  }
  return <div className="sg-report-entry"><button className="sg-primary" disabled={!canOpen||pending} onClick={()=>{setOpened(true);setError(false);}}>{t('previewReport')}</button>
    {opened&&<section className="sg-report-confirm" aria-labelledby="sg-report-confirm"><h3 id="sg-report-confirm">{t('openInConversation')}</h3><p>{t('conversationSwitchHelp')}</p>
      <div className="sg-grid"><Field label={t('reportSession')} hint={t('sessionHelp')}><select value={session} disabled={pending} onChange={e=>setSession(e.target.value)}><option value="">{t('choose')}</option>{live.map(id=><option key={id} value={id}>{id}</option>)}</select></Field>
        <Field label={t('reportFormat')}><select value={format} disabled={pending} onChange={e=>setFormat(e.target.value)}><option value="markdown">{t('formatMarkdown')}</option><option value="json">{t('formatJson')}</option></select></Field></div>
      {!live.length&&<p className="sg-warning">{t('reportNoSession')}</p>}
      <div className="sg-actions"><button className="sg-primary" disabled={!canOpen||!live.includes(session)||pending} onClick={confirm}>{t('confirmOpenReport')}</button><button disabled={pending} onClick={()=>setOpened(false)}>{t('stayInWorkbench')}</button></div>
      {pending&&<p role="status">{t('openingReport')}</p>}{error&&<p className="sg-error" role="alert">{t('reportOpenFailed')}</p>}
    </section>}
  </div>;
}

export function Workbench({t,back,openReport,initialSelection,onSelectionChange}){
  const [client]=useState(()=>{const c=createClient();if(initialSelection)c.select({workspaceId:initialSelection.workspaceId||'',sessionId:initialSelection.sessionId||'',runId:initialSelection.runId||''});return c;}),state=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot);
  const [page,setPage]=useState(()=>initialSelection?.runId?'review':'new'),{workspaceId,sessionId,runId}=state.selection;
  const data=state.bootstrap,workspace=data?.workspaces.find(w=>w.id===workspaceId),live=workspace?.liveSessionIds||[];
  const offlineReady=!!workspace&&data?.dataRootAvailable&&Object.values(data.environment||{}).every(v=>v.available);
  const modelReady=live.includes(sessionId)&&!!data?.diagnostics.find(d=>d.capability==='modelDispatch')?.available;
  useEffect(()=>{client.activate();return()=>client.dispose();},[client]);
  useEffect(()=>{client.query('bootstrap','bootstrap');if(runId){setPage('review');client.refresh();}},[client,workspaceId,sessionId,runId]);
  useEffect(()=>{onSelectionChange?.({workspaceId,sessionId,runId});},[onSelectionChange,workspaceId,sessionId,runId]);
  useEffect(()=>{if(page==='history'&&workspaceId)client.query('history','runs',{offset:0});},[client,page,workspaceId,sessionId]);
  const selectionKey=JSON.stringify(state.selection),busy=Object.entries(state.busy).filter(([,v])=>v).map(([k])=>k),m=state.mutation;
  const locked=!!m||state.foreignPending,view=state.view;
  return <section className="specgap" aria-labelledby="specgap-title">
    <header className="sg-header"><div className="sg-brand"><span className="sg-brand-mark" aria-hidden="true">S</span><div><h1 id="specgap-title">SpecGap</h1><span className="sg-muted">{t('workbenchLabel')}</span></div></div>
      <div className="sg-header-context"><Field label={t('workspace')}><select value={workspaceId} onChange={e=>{client.select({workspaceId:e.target.value});setPage('new');}}><option value="">{t('choose')}</option>{workspaceId&&!workspace&&<option value={workspaceId}>{workspaceId} · {t('unavailable')}</option>}{data?.workspaces.map(w=><option key={w.id} value={w.id}>{w.title||w.id}</option>)}</select></Field></div>
      <button onClick={back}>{t('back')}</button>
    </header>
    <div className="sg-body">
      <div className="sg-page-heading"><div><p className="sg-eyebrow">{t('workbenchLabel')}</p><h2>{t(page==='new'?'welcomeTitle':page==='history'?'history':view?.repoLabel?'review':'loading')}</h2><p className="sg-muted">{t('subtitle')}</p></div>
        <nav aria-label={t('navigation')} className="sg-actions"><button aria-current={page==='history'?'page':undefined} disabled={!workspaceId} onClick={()=>{client.select({runId:''});setPage('history');}}>{t('history')}</button><button className="sg-primary" aria-current={page==='new'?'page':undefined} onClick={()=>{client.select({runId:''});setPage('new');}}>{t('newReview')}</button></nav>
      </div>
      {page==='new'&&<aside className="sg-demo"><div><strong>{t('tryDemo')}</strong><p>{t('demoHelp')}</p></div><button disabled={!offlineReady||locked} onClick={()=>{if(offlineReady&&!locked)client.mutate('demo',{});}}>{t('startDemo')}</button></aside>}
      {data&&!data.workspaces.length&&<p className="sg-warning">{t('empty')}</p>}
      <details className="sg-environment" open={!data||!data.ready}><summary>{t('environment')} · {t(data?.ready?'bootstrapReady':'notReady')}</summary>
        <div className="sg-toolbar"><Field label={t('session')} hint={t('sessionHelp')}><select value={sessionId} disabled={!workspace} onChange={e=>client.select({sessionId:e.target.value})}><option value="">{t('noSession')}</option>{sessionId&&!live.includes(sessionId)&&<option value={sessionId}>{sessionId} · {t('unavailable')}</option>}{live.map(id=><option key={id} value={id}>{id}</option>)}</select></Field>
          <button disabled={state.busy.bootstrap} onClick={()=>{client.invalidateConsent();client.query('bootstrap','bootstrap');}}>{t('refresh')}</button></div>
        {data&&<div className="sg-grid"><dl>{Object.entries(data.environment).map(([name,value])=><React.Fragment key={name}><dt>{localizedKey(t,'environment_'+name)}</dt><dd>{t(value.available?'available':'unavailable')}{value.version&&<Plain value={value.version}/>}</dd></React.Fragment>)}</dl><dl>{data.diagnostics.map(d=><React.Fragment key={d.capability}><dt>{localizedKey(t,'capability_'+d.capability)}</dt><dd>{t(d.available?'available':'unavailable')}</dd></React.Fragment>)}</dl></div>}
      </details>
      {!!busy.length&&<p className="sg-loading" role="status">{t('loading')} · {busy.map(k=>t('stage_'+k)).join(', ')}</p>}
      {state.error&&<div className="sg-error" role="alert"><strong>{errorLabel(t,state.error)}</strong><details><summary>{t('technicalDetails')}</summary><Plain value={{code:state.error.code,...(state.error.requestId?{requestId:state.error.requestId}:{})}}/></details></div>}
      {state.foreignPending&&<aside className="sg-warning"><p>{t('foreignPending')}</p><button onClick={()=>client.returnToPending()}>{t('returnPending')}</button></aside>}
      {!!state.parkedCount&&<aside className="sg-warning"><p>{t('parkedIntent')}</p><button onClick={()=>client.returnToPending()}>{t('returnPending')}</button></aside>}
      {m&&<aside className="sg-warning" role="status"><p>{t('mutation_'+m.phase)}</p><p>{t('recoveryHelp')}</p>
        {['ambiguous','committedRefreshFailed'].includes(m.phase)&&<button onClick={()=>client.recover()}>{t(m.phase==='ambiguous'?'recoverExact':'refreshRun')}</button>}
        {m.phase==='ambiguous'&&['STALE','CONFLICT'].includes(m.error?.code)&&['respond','decide','verify'].includes(m.operation)&&<button disabled={state.parkedCount>=7} onClick={()=>{if(client.parkForNewSnapshot())setPage('new');}}>{t('parkForSnapshot')}</button>}
        {['committed','rejected','conflict'].includes(m.phase)&&<button onClick={()=>client.acknowledge()}>{t('acknowledge')}</button>}
      </aside>}
      {page==='new'&&<NewReview key={workspaceId+':'+sessionId} t={t} client={client} state={state} enabled={offlineReady}/>}
      {page==='history'&&<History t={t} client={client} state={state} onOpen={id=>client.select({runId:id})}/>}
      {page==='review'&&runId&&!view&&!state.busy.view&&<div className="sg-empty"><p>{t('runUnavailable')}</p><button onClick={()=>client.refresh()}>{t('refreshRun')}</button></div>}
      {page==='review'&&view&&<div key={selectionKey}>
        {!view.review&&<><ReviewSteps t={t} current={3}/><div className="sg-prepared"><div><h2>{t('preparedTitle')}</h2><p>{t('preparedHelp')}</p></div><span className="sg-badge">{t('offlineOnly')}</span></div></>}
        <div className="sg-review-bar"><div><strong><code>{repositoryLabel(t,view.repoLabel)}</code></strong><small>{t('sequence')} · {view.expectedSequence??t('unavailable')}</small></div><div className="sg-actions"><button disabled={state.busy.view} onClick={()=>client.refresh()}>{t('refreshRun')}</button><ReportPreview t={t} state={state} live={live} openReport={openReport}/></div></div>
        <Review t={t} client={client} state={state}/>
        {!view.review&&<div className="sg-model-stage"><Field label={t('session')} hint={t('sessionHelp')}><select value={sessionId} disabled={!workspace} onChange={e=>client.select({sessionId:e.target.value})}><option value="">{t('noSession')}</option>{sessionId&&!live.includes(sessionId)&&<option value={sessionId}>{sessionId} · {t('unavailable')}</option>}{live.map(id=><option key={id} value={id}>{id}</option>)}</select></Field><ModelReview t={t} client={client} state={state} enabled={modelReady}/></div>}
        <Attempts t={t} client={client} state={state}/><Downloads t={t} client={client} state={state}/>
      </div>}
      <footer><p>{t('releaseDisclaimer')}</p><details><summary>{t('recoveryDetails')}</summary><p>{t('recoveryPrivacy')}</p></details></footer>
    </div>
  </section>;
}
