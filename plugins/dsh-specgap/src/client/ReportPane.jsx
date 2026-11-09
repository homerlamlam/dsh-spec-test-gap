import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {action,download,reviewFlags} from './api.mjs';
import {validateReportSelection} from './report-navigation.mjs';
import {createReportReader} from './report-reader.mjs';
import {inlineParts,markdownBlocks,searchJson,safeFilename} from './report-content.mjs';
import {reportCopy} from './report-copy.mjs';
import {Plain,OriginalText,originalText,errorLabel,repositoryLabel} from './presentation.jsx';
export function ReportIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></svg>;}
export function ReportTitle({t,useTabInfo}){const {tab}=useTabInfo();return <span className="sg-report-tab-title"><ReportIcon/>{t('reportTitle')}{typeof tab.navigation.params?.runId==='string'&&<span> · {tab.navigation.params.runId.slice(0,8)}</span>}</span>;}
function Inline({text}){return inlineParts(text).map((part,index)=>part.type==='code'?<code key={index}>{part.text}</code>:part.type==='strong'?<strong key={index}>{part.text}</strong>:part.text);}
function ReportText({t,text}){return originalText(t,text)?<OriginalText t={t} value={text} as="span"/>:<Inline text={text}/>;}
export function SafeMarkdown({markdown,t}){return <article className="sg-report-markdown">{markdownBlocks(markdown).map((block,index)=>{
 if(block.type==='code')return <pre key={index}><code>{block.text}</code></pre>;
 if(block.type==='heading')return originalText(t,block.text)?<OriginalText key={index} t={t} value={block.text} as={'h'+block.level}/>:React.createElement('h'+block.level,{key:index},<Inline text={block.text}/>);
 if(block.type==='quote')return <blockquote key={index}><ReportText t={t} text={block.text}/></blockquote>;
 if(block.type==='list')return <ul key={index}>{block.items.map((item,i)=><li key={i}><ReportText t={t} text={item}/></li>)}</ul>;
 if(block.type==='rule')return <hr key={index}/>;
 if(block.type==='table')return <div className="sg-report-table" key={index}><table><thead><tr>{block.header.map((cell,i)=><th key={i}><ReportText t={t} text={cell}/></th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}><ReportText t={t} text={cell}/></td>)}</tr>)}</tbody></table></div>;
 return originalText(t,block.text)?<OriginalText key={index} t={t} value={block.text}/>:<p key={index}><Inline text={block.text}/></p>;
 })}</article>;}
export function JsonTree({value,label='$',depth=0}){
 const [open,setOpen]=useState(depth===0);
 if(value===null||typeof value!=='object')return <pre className="sg-report-json-leaf"><code>{label}: {JSON.stringify(value)}</code></pre>;
 const entries=Object.entries(value);
 return <details className="sg-report-json-node" open={open} onToggle={e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open);}}><summary><strong><code>{label}</code></strong> <span>{Array.isArray(value)?`[${entries.length}]`:`{${entries.length}}`}</span></summary>{open&&<div>{entries.map(([key,item])=><JsonTree key={key} label={key} value={item} depth={depth+1}/>)}</div>}</details>;
}
export function ReportError({t,error}){const code=error?.code||'UNAVAILABLE';return <div className="sg-report-error" role="alert"><strong>{Object.hasOwn(reportCopy.en,'reportError_'+code)?t('reportError_'+code):errorLabel(t,{code})}</strong><Plain value={{code,...(error?.requestId?{requestId:error.requestId}:{})}}/></div>;}
export function ReportPane({t,sessionId,useTabInfo,navigation}){
 const {tab}=useTabInfo();let selection;
 try{selection=validateReportSelection(tab.navigation.params);if(selection.sessionId!==sessionId)throw new Error('scope');}
 catch{return <section className="sg-report"><ReportError t={t} error={{code:'REPORT_INVALID_SELECTION'}}/><button onClick={()=>navigation.returnToWorkbench(navigation.getSelection())}>{t('reportBack')}</button></section>;}
 return <ReportContent key={JSON.stringify([selection.workspaceId,selection.sessionId,selection.runId])} t={t} selection={selection} tab={tab} navigation={navigation}/>;
}
export function ReportContent({t,selection,tab,navigation}){
 const visible=useRef(tab.visible);visible.current=tab.visible;
 const scroll=useRef(null),positions=useRef({}),alive=useRef(true);
 const [reader]=useState(()=>createReportReader({selection,request:action,isVisible:()=>visible.current&&document.visibilityState!=='hidden'}));
 const state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot);
 const [format,setFormat]=useState(selection.format),[source,setSource]=useState(false),[query,setQuery]=useState(''),[notice,setNotice]=useState('');
 const contentKey=format+':'+source;
 useEffect(()=>{alive.current=true;reader.activate();const refresh=()=>{void reader.setVisible(visible.current&&document.visibilityState!=='hidden');};const stop=()=>reader.dispose();document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);tab.signal.addEventListener('abort',stop,{once:true});if(tab.signal.aborted)stop();else refresh();return()=>{alive.current=false;document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);tab.signal.removeEventListener('abort',stop);reader.dispose();};},[reader,tab.signal]);
 useEffect(()=>{void reader.setVisible(tab.visible&&document.visibilityState!=='hidden');},[reader,tab.visible]);
 useEffect(()=>{setFormat(selection.format);setNotice('');},[selection.format,tab.navigation.revision]);
 useEffect(()=>{if(scroll.current)scroll.current.scrollTop=positions.current[contentKey]||0;},[contentKey]);
 const flags=reviewFlags(state.view),fresh=!!state.view&&state.markdown!==null&&!state.busy&&!state.error&&!state.view.status?.stale;
 const canExport=()=>fresh&&reader.getSnapshot()===state&&!tab.signal.aborted&&alive.current;
 const getText=()=>format==='json'?JSON.stringify(state.view,null,2):state.markdown;
 const search=searchJson(state.view,query);
 async function copy(){if(!canExport())return;try{await navigator.clipboard.writeText(getText());if(alive.current&&reader.getSnapshot()===state)setNotice('reportCopied');}catch{if(alive.current)setNotice('reportCopyFailed');}}
 function save(){if(!canExport())return;try{download(getText(),safeFilename(format==='markdown'?state.filename:`specgap-${selection.runId}-view.json`,format),format==='json'?'application/json;charset=utf-8':'text/markdown;charset=utf-8');}catch{setNotice('reportExportFailed');}}
 return <section className="sg-report" aria-label={t('reportTitle')}>
  <header className="sg-report-header"><div className="sg-report-heading"><ReportIcon/><h2>{t('reportTitle')}</h2><button className="sg-report-back" onClick={()=>navigation.returnToWorkbench(selection)}>{t('reportBack')} ↗</button></div><p className="sg-report-run" title={selection.runId}><code>{repositoryLabel(t,state.view?.repoLabel)||selection.runId}</code></p></header>
  <div className="sg-report-toolbar"><div className="sg-report-segment" role="group" aria-label={t('reportTitle')}><button aria-pressed={format==='markdown'} onClick={()=>setFormat('markdown')}>{t('reportMarkdown')}</button><button aria-pressed={format==='json'} onClick={()=>setFormat('json')}>{t('reportJson')}</button></div>{format==='markdown'&&<div className="sg-report-segment" role="group" aria-label={t('reportMarkdown')}><button aria-pressed={!source} onClick={()=>setSource(false)}>{t('reportRendered')}</button><button aria-pressed={source} onClick={()=>setSource(true)}>{t('reportSource')}</button></div>}<div className="sg-report-actions"><button disabled={!fresh} onClick={copy}>{t('reportCopy')}</button><button disabled={!fresh} onClick={save}>{t('reportDownload')}</button><button disabled={state.busy} onClick={()=>{setNotice('');void reader.refresh();}}>{t('reportRefresh')}</button></div></div>
  <div className="sg-report-status"><p role="status">{state.busy?t('reportReading'):state.syncedAt?`${t('reportSynced')} · ${new Date(state.syncedAt).toLocaleTimeString()} · ${t('reportSequence')} ${state.view?.expectedSequence??'—'}`:t('reportWaiting')}</p><p>{t('reportRefreshHelp')}</p></div>
  {state.error&&<><ReportError t={t} error={state.error}/>{state.view&&<p className="sg-report-warning">{t('reportOld')}</p>}</>}
  {!!flags.length&&<aside className="sg-report-warning">{flags.map(flag=><p key={flag}>{t(flag)}</p>)}</aside>}
  {state.view?.status?.stale&&<p className="sg-report-warning">{t('reportStaleExport')}</p>}
  {notice&&<p className="sg-report-notice" role="status">{t(notice)}</p>}
  {format==='json'&&<label className="sg-report-search">{t('reportSearch')}<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('reportSearchPlaceholder')}/></label>}
  <div className="sg-report-scroll" ref={scroll} tabIndex={0} onScroll={e=>{positions.current[contentKey]=e.currentTarget.scrollTop;}} aria-busy={state.busy}>
   {state.view&&format==='json'&&(query.trim()?<section className="sg-report-search-results">{search.truncated&&<p>{t('reportSearchLimit')}</p>}{!search.matches.length&&<p>{t('reportSearchEmpty')}</p>}{search.matches.map(match=><div key={match.path}><Plain value={match.path+'\n'+JSON.stringify(match.value,null,2)}/></div>)}</section>:<JsonTree value={state.view} label={t('reportTree')}/>)}
   {state.markdown!==null&&format==='markdown'&&(source?<pre className="sg-report-source"><code>{state.markdown}</code></pre>:<SafeMarkdown t={t} markdown={state.markdown}/>)}
  </div>
  <footer className="sg-report-footer"><p>{t('reportReadOnly')}</p><p>{t(format==='json'?'reportJsonHelp':'reportSafeHelp')}</p></footer>
 </section>;
}
