import React from 'react';
import {download} from './api.mjs';
import {Plain,errorLabel,localizedKey,repositoryLabel} from './presentation.jsx';
import {readableDate} from './workbench-state.mjs';
export function Downloads({t,client,state}){
  const view=state.view;
  return <details className="sg-exports"><summary>{t('exportReport')}</summary><div className="sg-actions"><button disabled={!view?.bundle||state.busy.report} onClick={()=>client.query('report','report',{},result=>download(result.markdown,result.filename,'text/markdown;charset=utf-8'))}>{t('downloadMarkdown')}</button>
    <button disabled={!view} onClick={()=>{if(client.getSnapshot().view===view)download(JSON.stringify(view,null,2),`specgap-${view.runId}-view.json`,'application/json;charset=utf-8');}}>{t('downloadView')}</button></div><p className="sg-muted">{t('viewExportHelp')}</p></details>;
}
export function Attempts({t,client,state}){
  const attempts=state.view?.attempts||[],active=attempts.some(a=>['queued','running','validating'].includes(a.phase)),failed=attempts.some(a=>a.error);
  return <details className="sg-attempts" open={active||failed||undefined}><summary>{t('attempts')} · {attempts.length}</summary>{!attempts.length&&<p>{t('noAttempts')}</p>}{attempts.map(a=><div className="sg-attempt" key={a.attemptId}><strong>{localizedKey(t,a.phase)}</strong>{a.error&&<div className="sg-warning" role="alert"><p>{t('attemptFailure')}</p><p>{errorLabel(t,a.error)}</p><details><summary>{t('technicalDetails')}</summary><Plain value={a.error}/></details></div>}<details><summary>{t('attemptDetails')}</summary><Plain value={a}/></details>
    {['queued','running','validating'].includes(a.phase)&&<><button disabled={!state.selection.sessionId||state.selection.sessionId!==a.sessionId||state.busy.cancel} onClick={()=>client.query('cancel','cancel',{attemptId:a.attemptId})}>{t('cancelNative')}</button><p>{t('cancelHelp')}</p></>}</div>)}<button disabled={!state.selection.runId||state.busy.view} onClick={()=>client.refresh()}>{t('refreshRun')}</button>
  </details>;
}
export function History({t,client,state,onOpen}){
  const data=state.history;
  return <section className="sg-history-panel" aria-labelledby="sg-history"><div className="sg-section-heading"><div><h2 id="sg-history">{t('savedReviews')}</h2><p className="sg-muted">{t('historyHelp')}</p></div><button disabled={!state.selection.workspaceId||state.busy.history} onClick={()=>client.query('history','runs',{offset:0})}>{t('refreshHistory')}</button></div>
    {data&&!data.items.length&&<div className="sg-empty"><h3>{t('noHistory')}</h3><p>{t('historyEmptyHelp')}</p></div>}
    <ul className="sg-history">{data?.items.map(item=><li key={item.runId}><div className="sg-history-title"><span className="sg-history-icon" aria-hidden="true">≡</span><div><button className="sg-text-button" onClick={()=>onOpen(item.runId)}><code>{repositoryLabel(t,item.repoLabel)}</code></button><time dateTime={item.createdAt} title={item.createdAt}>{readableDate(item.createdAt,t('contentLocale'))}</time></div></div><div className="sg-history-state"><span className="sg-badge">{t(item.phase)}</span><small>{t('attemptCount')}: {item.attemptCount} · {item.lastAttemptPhase?t(item.lastAttemptPhase):t('noAttempts')}</small></div><button onClick={()=>onOpen(item.runId)} aria-label={`${t('openReview')}: ${item.repoLabel}`}>{t('openReview')}</button><details className="sg-history-id"><summary>{t('recordReference')}</summary><p className="sg-mono">{item.runId}</p></details></li>)}</ul>
    {data?.nextOffset!=null&&<button disabled={state.busy.history} onClick={()=>client.query('history','runs',{offset:data.nextOffset})}>{t('nextPage')}</button>}
  </section>;
}
