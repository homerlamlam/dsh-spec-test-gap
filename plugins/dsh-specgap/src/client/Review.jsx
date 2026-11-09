import React,{useState} from 'react';
import {reviewFlags} from './api.mjs';
import {Evidence,RequirementReference,FrozenSourceView} from './SourceView.jsx';
export {Evidence,FrozenSourceView} from './SourceView.jsx';
import {HumanActions} from './HumanActions.jsx';
import {Field} from './NewReview.jsx';
import {priorityFindings,readableDate,rememberReviewSelection,reviewSelection} from './workbench-state.mjs';
import {Plain,OriginalText,Limitation,originalText,localizedKey} from './presentation.jsx';
export {Plain} from './presentation.jsx';
export function Review({t,client,state}){
  const v=state.view,b=v.bundle,r=v.review,remembered=reviewSelection(v);
  const [filter,setFilter]=useState(''),[kind,setKind]=useState(''),[findingId,setFinding]=useState(()=>remembered.findingId||'');
  const [tab,setTab]=useState(()=>remembered.tab||'findings'),[actionFinding,setActionFinding]=useState('');
  const [source,setSource]=useState(null);
  const openSource=(value,trigger)=>setSource({...value,trigger});
  const closeSource=()=>{source?.trigger?.focus();setSource(null);};
  const all=priorityFindings(r?.findings),findings=all.filter(f=>(!kind||f.kind===kind)&&`${f.id} ${f.title} ${f.description}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const finding=findings.find(f=>f.id===findingId)||findings[0],fs=finding&&v.status.findings?.[finding.id];
  const limitations=[...(v.status.stale_reasons||[]),...(b?.limitations||[]),...(b?.warnings||[])];
  const chooseFinding=id=>{setFinding(id);setActionFinding('');setSource(null);rememberReviewSelection(v,{findingId:id,tab:'findings'});};
  const chooseTab=value=>{setTab(value);setActionFinding('');setSource(null);rememberReviewSelection(v,{tab:value,...(finding?{findingId:finding.id}:{})});};
  const tabs=[['findings','findings',r?.findings.length],['requirements','requirementsDirection',r?.requirements.length],['changes','changesDirection',r?.changes.length]];
  return <section className="sg-review" aria-labelledby="sg-review">
    <h2 id="sg-review" className="sg-sr-only">{t('review')}</h2>
    <div className="sg-notices" role="status">{reviewFlags(v).map(flag=><p key={flag}>{t(flag)}</p>)}</div>
    {r&&<div className="sg-review-summary"><div><span className="sg-metric">{all.length}</span><span>{t('findings')}</span></div><div><span className="sg-metric">{all.filter(f=>['critical','high'].includes(f.severity)).length}</span><span>{t('highPriority')}</span></div><div><span className="sg-metric">{r.requirements.length}</span><span>{t('requirement')}</span></div><div className="sg-summary-state"><span>{t('reviewState')}</span><strong>{t(v.status.review_state||v.status.phase||'unavailable')}</strong></div></div>}
    {r&&<>
      <div className="sg-tabs" role="tablist" aria-label={t('reviewViews')}>{tabs.map(([id,label,count],i)=><button key={id} id={`sg-tab-${id}`} type="button" role="tab" aria-selected={tab===id} aria-controls={`sg-panel-${id}`} tabIndex={tab===id?0:-1} onClick={()=>chooseTab(id)} onKeyDown={e=>{const next=e.key==='ArrowRight'?(i+1)%3:e.key==='ArrowLeft'?(i+2)%3:e.key==='Home'?0:e.key==='End'?2:null;if(next!==null){e.preventDefault();chooseTab(tabs[next][0]);e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus();}}}>{t(label)} <span className="sg-count">{count}</span></button>)}</div>
      <div id={`sg-panel-${tab}`} role="tabpanel" aria-labelledby={`sg-tab-${tab}`} tabIndex="0">
        {tab==='findings'&&<div className="sg-findings-layout">
          <aside className="sg-finding-master" aria-label={t('findings')}><div className="sg-findings-tools"><Field label={t('filterFindings')}><input type="search" value={filter} onChange={e=>setFilter(e.target.value)}/></Field><Field label={t('kind')}><select value={kind} onChange={e=>setKind(e.target.value)}><option value="">{t('all')}</option>{[...new Set(all.map(f=>f.kind))].map(k=><option key={k} value={k}>{t(k)}</option>)}</select></Field></div>
            <p className="sg-order-note">{t('priorityOrder')}</p>{!findings.length&&<p className="sg-empty">{t(all.length?'noMatches':'zeroFindings')}</p>}
            <ul className="sg-findings">{findings.map(f=><li key={f.id}><button aria-pressed={f.id===finding?.id} onClick={()=>chooseFinding(f.id)}><span className="sg-finding-meta"><span className={`sg-severity sg-${f.severity}`}>{t(f.severity)}</span><code>{f.id}</code></span><strong>{originalText(t,f.title)?t('originalText'):f.title}</strong><span className="sg-finding-sub">{t(f.kind)} · {t(f.suggested_role)}</span></button>{originalText(t,f.title)&&<Plain value={f.title}/>}</li>)}</ul>
          </aside>
          {finding&&<article className="sg-detail" aria-labelledby="sg-finding-title"><div className="sg-detail-heading"><div><p className="sg-eyebrow"><code>{finding.id}</code> · {t(finding.kind)}</p><OriginalText t={t} as="h3" id="sg-finding-title" value={finding.title}/></div><span className={`sg-severity sg-${finding.severity}`}>{t(finding.severity)}</span></div>
            <OriginalText t={t} value={finding.description}/>
            <div className="sg-linked-requirements"><h4>{t('requirementLinks')}</h4>{finding.requirement_ids.length?finding.requirement_ids.map(id=><blockquote key={id}><RequirementReference t={t} bundle={b} id={id} onOpen={openSource}/></blockquote>):<p className="sg-muted">{t('none')}</p>}</div>
            <h4>{t('evidence')}</h4><Evidence t={t} bundle={b} onOpen={openSource} citations={finding.evidence} expanded/>
            <div className="sg-question"><strong>{t('clarifyQuestion')}</strong><OriginalText t={t} value={finding.question}/><small>{t('suggestedRole')} · {t(finding.suggested_role)}</small></div>
            <dl className="sg-axes">{['assessment','intent','disposition','verification'].map(axis=><React.Fragment key={axis}><dt>{t(axis==='assessment'?'implementation':axis)}</dt><dd>{t(fs?.[axis]||'unknown')}</dd></React.Fragment>)}</dl>
            <p className="sg-disclaimer">{t('releaseDisclaimer')}</p>
            <div className="sg-detail-actions">{actionFinding!==finding.id?<button className="sg-primary" onClick={()=>setActionFinding(finding.id)}>{t('openHumanAction')}</button>:<><button onClick={()=>setActionFinding('')}>{t('closeHumanAction')}</button><HumanActions key={finding.id+':'+v.expectedSequence} t={t} client={client} state={state} finding={finding}/></>}</div>
            <details className="sg-supporting"><summary>{t('testIdeas')} · {finding.test_ideas.length}</summary><ul>{finding.test_ideas.map((idea,i)=><li key={i}><OriginalText t={t} as="span" value={idea}/></li>)}</ul></details>
            <details className="sg-supporting"><summary>{t('changeLinks')} · {finding.change_ids.length}</summary>{finding.change_ids.length?finding.change_ids.map(id=>{const change=b?.changes.find(c=>c.id===id);return <p key={id}><code>{id}</code> · {localizedKey(t,'change_'+change?.status?.[0])} · <code>{change?.old_path} → {change?.new_path}</code></p>;}):<p>{t('none')}</p>}</details>
            <details className="sg-supporting"><summary>{t('eventHistory')} · {v.events.filter(e=>e.finding_id===finding.id).length}</summary>{!v.events.some(e=>e.finding_id===finding.id)&&<p className="sg-muted">{t('noEvents')}</p>}{v.events.filter(e=>e.finding_id===finding.id).map(e=><article className="sg-event" key={e.sequence}><strong>{t(e.kind)} · <code>{e.actor}</code></strong><small>#{e.sequence} · <time dateTime={e.created_at} title={e.created_at}>{readableDate(e.created_at,t('contentLocale'))}</time></small>{(e.text||e.reason||e.note)&&<OriginalText t={t} value={e.text||e.reason||e.note}/>}<details><summary>{t('eventDetails')}</summary><Plain value={e}/></details></article>)}</details>
          </article>}
        </div>}
        {tab==='requirements'&&<div className="sg-table-wrap"><table><thead><tr><th>{t('requirement')}</th><th>{t('assessment')}</th><th>{t('evidence')}</th></tr></thead><tbody>{r.requirements.map(item=><tr key={item.id}><th scope="row"><RequirementReference t={t} bundle={b} id={item.id} onOpen={openSource}/></th><td><span className="sg-badge">{t(item.assessment)}</span><OriginalText t={t} value={item.reason}/></td><td><Evidence t={t} bundle={b} onOpen={openSource} citations={item.evidence}/></td></tr>)}</tbody></table>{!r.requirements.length&&<p className="sg-empty">{t('noMapping')}</p>}</div>}
        {tab==='changes'&&<div className="sg-table-wrap"><table><thead><tr><th>{t('change')}</th><th>{t('assessment')}</th><th>{t('evidence')}</th></tr></thead><tbody>{r.changes.map(item=>{const c=b?.changes.find(c=>c.id===item.id);return <tr key={item.id}><th scope="row"><code>{item.id}</code><p>{localizedKey(t,'change_'+c?.status?.[0])} · <code>{c?.old_path} → {c?.new_path}</code></p></th><td><span className="sg-badge">{t(item.assessment)}</span><OriginalText t={t} value={item.summary}/><p>{t('requirementLinks')}</p>{item.requirement_ids.length?item.requirement_ids.map(id=><div className="sg-change-requirement" key={id}><RequirementReference t={t} bundle={b} id={id} onOpen={openSource}/></div>):<p>{t('none')}</p>}</td><td><Evidence t={t} bundle={b} onOpen={openSource} citations={item.evidence}/></td></tr>;})}</tbody></table>{!r.changes.length&&<p className="sg-empty">{t('noMapping')}</p>}</div>}
      </div>
    </>}
    {source&&source.snapshotId===b?.snapshot_id&&<FrozenSourceView t={t} source={source} onClose={closeSource}/>}
    {b&&<div className="sg-scope"><details open={!r}><summary>{t('frozenScope')}</summary><dl className="sg-hashes">{[['snapshot',b.snapshot_id],['head',b.repo.head_sha],['target',b.repo.target_sha],['mergeBase',b.repo.merge_base_sha],['base',b.repo.base_sha]].map(([key,value])=><React.Fragment key={key}><dt>{t(key)}</dt><dd>{value?<code>{value}</code>:t('notSupplied')}</dd></React.Fragment>)}</dl><details><summary>{t('contextBudgets')}</summary><Plain value={b.budgets}/></details></details>
      <details open={v.status.stale||undefined}><summary>{t('limitations')} · {limitations.length}</summary>{limitations.length?<ul>{limitations.map((value,i)=><li key={i}><Limitation t={t} value={value}/></li>)}</ul>:<p>{t('noRecordedLimitations')}</p>}</details>
      <details><summary>{t('frozenRequirements')}</summary><Plain value={b.requirements.text}/></details>
    </div>}
    {!r&&<p className="sg-disclaimer">{t('releaseDisclaimer')}</p>}
  </section>;
}
