import React,{useEffect,useState} from 'react';
import {physicalLines} from './api.mjs';
import {OriginalText} from './presentation.jsx';
import {evidenceSource,requirementSource,sourceWindow,SOURCE_PAGE_SIZE} from './source-view.mjs';

function CodeLines({lines,start=1,source,anchors=false}){
  return <pre><code>{lines.map((line,i)=>{const number=start+i,cited=source&&number>=source.start_line&&number<=source.end_line;return <span className="sg-line" key={number} id={anchors?`sg-source-line-${number}`:undefined} data-cited={cited||undefined}><span className="sg-line-number" aria-hidden="true">{number}</span><span>{line||'\u200b'}</span>{'\n'}</span>;})}</code></pre>;
}
function SourceLink({t,source,onOpen,label}){
  return source&&onOpen?<a className="sg-source-link" href="#sg-frozen-source" onClick={event=>{event.preventDefault();onOpen(source,event.currentTarget);}}>{t(label)}</a>:null;
}
export function RequirementReference({t,bundle,id,onOpen}){
  const clause=bundle?.requirements?.clauses?.find(c=>c.id===id),source=requirementSource(bundle,id);
  return <><code>{id}</code><OriginalText t={t} value={clause?.text||t('notSupplied')}/><div className="sg-source-reference"><span>{t('sourceOrigin')}</span> <code>{bundle?.requirements?.path||t('sourceSavedRequirements')}{source?`:${source.start_line}–${source.end_line}`:''}</code>{source?<SourceLink t={t} source={source} onOpen={onOpen} label="sourceOpenRequirement"/>:<small>{t('sourceUnavailable')}</small>}</div></>;
}
export function Evidence({t,bundle,citations=[],expanded=false,onOpen}){
  return <div className="sg-evidence">{!citations.length&&<p className="sg-muted">{t('noEvidence')}</p>}{citations.map((citation,i)=>{
    const source=evidenceSource(bundle,citation),context=source&&sourceWindow(source,{context:true});
    return <details key={i} open={expanded}><summary><span className="sg-badge">{t(citation.side)}</span> <code>{citation.path}:{citation.start_line}–{citation.end_line}</code></summary>
      <CodeLines lines={physicalLines(citation.quote)} start={citation.start_line}/>
      {source?<><div className="sg-source-actions"><SourceLink t={t} source={source} onOpen={onOpen} label="sourceOpenFile"/><small>{t('sourceCommit')} <code>{source.commit||t('notSupplied')}</code></small></div><details className="sg-source-context"><summary>{t('sourceContext')} <code>{context.start}–{context.end} / {context.total}</code></summary><CodeLines lines={context.lines} start={context.start} source={source}/></details></>:<p className="sg-muted">{t('sourceUnavailable')}</p>}
    </details>;
  })}</div>;
}
export function FrozenSourceView({t,source,onClose}){
  const initialPage=Math.floor((source.start_line-1)/SOURCE_PAGE_SIZE);
  const [page,setPage]=useState(initialPage),[locate,setLocate]=useState(0);
  const window=sourceWindow(source,{page});
  useEffect(()=>{setPage(initialPage);},[source]);
  useEffect(()=>{
    const panel=globalThis.document?.getElementById('sg-frozen-source');
    panel?.focus({preventScroll:true});
    (panel?.querySelector('[data-cited]')||panel)?.scrollIntoView({block:'nearest'});
  },[source,page,locate]);
  return <section id="sg-frozen-source" className="sg-source-view" tabIndex="-1" aria-labelledby="sg-source-heading">
    <div className="sg-detail-heading"><h3 id="sg-source-heading">{t('sourceTitle')}</h3><button type="button" onClick={onClose}>{t('sourceClose')}</button></div>
    <p className="sg-source-path"><code>{source.path||t('sourceSavedRequirements')}</code></p><p className="sg-muted">{t('sourceFrozenHelp')}</p>
    <dl className="sg-hashes"><dt>{t('sourceOrigin')}</dt><dd>{t(source.kind==='requirements'?'sourceRequirements':source.side)}</dd>{source.kind==='source'&&<><dt>{t('sourceCommit')}</dt><dd><code>{source.commit||t('notSupplied')}</code></dd></>}<dt>{t('sourceHash')}</dt><dd><code>{source.sha256||t('notSupplied')}</code></dd><dt>{t('sourceCitedLines')}</dt><dd><code>{source.start_line}–{source.end_line}</code></dd></dl>
    <nav className="sg-source-actions" aria-label={t('sourcePages')}><button type="button" disabled={window.start===1} onClick={()=>setPage(value=>value-1)}>{t('sourcePrevious')}</button><span>{t('sourceDisplayed')} <code>{window.start}–{window.end} / {window.total}</code></span><button type="button" disabled={window.end===window.total} onClick={()=>setPage(value=>value+1)}>{t('sourceNext')}</button><button type="button" onClick={()=>{setPage(initialPage);setLocate(value=>value+1);}}>{t('sourceLocate')}</button></nav>
    <div className="sg-source-code"><CodeLines lines={window.lines} start={window.start} source={source} anchors/></div>
  </section>;
}
