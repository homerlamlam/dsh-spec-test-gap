import React,{useState} from 'react';
import {Field} from './NewReview.jsx';
import {Plain,localizedKey,chinese} from './presentation.jsx';
export function ModelReview({t,client,state,enabled}){
  const [provider,setProvider]=useState(''),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[tokens,setTokens]=useState(8192),[timeout,setTimeout]=useState(300),[consent,setConsent]=useState(false);
  const catalog=state.catalog,groups=catalog?.groups||[],models=groups.find(p=>p.id===provider)?.models||[],selected=models.find(m=>m.id===model),efforts=selected?.reasoning?.efforts||[];
  const preview=state.preview,confirmation=state.confirmation;
  const attempted=state.view?.attempts?.length>0||state.analysisStarted;
  const canPreview=enabled&&state.selection.sessionId&&state.view?.bundle&&!state.view.review&&!state.view.status.stale&&!attempted&&!state.mutation&&!state.foreignPending;
  const valid=provider&&model&&Number.isInteger(tokens)&&tokens>=1&&tokens<=8192&&Number.isInteger(timeout)&&timeout>=1&&timeout<=300;
  const changed=fn=>e=>{client.invalidateConsent();setConsent(false);fn(e.target.value);};
  const expired=preview&&Date.parse(preview.expiresAt)<=Date.now();
  return <section className="sg-model" aria-labelledby="sg-model"><p className="sg-eyebrow">{t('stepReview')}</p><h2 id="sg-model">{t('modelReview')}</h2><p className="sg-warning">{t('modelCostHelp')}</p><p>{t('modelDisclosure')}</p><p className="sg-muted">{t('oneAttempt')}</p>
    {!state.selection.sessionId&&<p>{t('sessionRequired')}</p>}
    {!enabled&&state.selection.sessionId&&<p>{t('modelNotReady')}</p>}
    <button disabled={!canPreview||state.busy.catalog} onClick={()=>{client.invalidateConsent();setConsent(false);setProvider('');setModel('');setEffort('');client.query('catalog','models');}}>{t('loadModels')}</button>
    {catalog?.failures?.length>0&&<><p>{t('catalogFailures')}</p><Plain value={catalog.failures}/></>}
    <fieldset disabled={!canPreview}><legend>{t('routeBudget')}</legend><div className="sg-grid">
      <Field label={t('provider')}><select value={provider} onChange={changed(value=>{setProvider(value);setModel('');setEffort('');})}><option value="">{t('choose')}</option>{groups.filter(g=>catalog.routableProviders?.includes(g.id)).map(g=><option key={g.id} value={g.id}>{g.name} · {g.id}</option>)}</select></Field>
      <Field label={t('model')}><select value={model} onChange={changed(value=>{setModel(value);setEffort('');})}><option value="">{t('choose')}</option>{models.map(m=><option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select></Field>
    </div><details className="sg-advanced"><summary>{t('advancedModel')}</summary><div className="sg-grid">
      <Field label={t('effort')}><select value={effort} onChange={changed(setEffort)}><option value="">{t('modelDefault')}</option>{efforts.map((e,i)=><option key={e.id} value={e.id}>{chinese(t)?`${localizedKey(t,'effort_'+e.id,'customEffort')} · ${i+1}`:`${e.name} · ${e.id}`}</option>)}</select></Field>
      <Field label={t('outputTokens')}><input type="number" min="1" max="8192" value={tokens} onChange={changed(v=>setTokens(Number(v)))}/></Field>
      <Field label={t('timeout')}><input type="number" min="1" max="300" value={timeout} onChange={changed(v=>setTimeout(Number(v)))}/></Field>
    </div></details><button disabled={!valid||state.busy.preview} onClick={()=>{client.invalidateConsent();setConsent(false);client.query('preview','material',{route:{provider,model,reasoningEffort:effort||null},budget:{outputTokens:tokens,timeoutSeconds:timeout}});}}>{t('previewRequest')}</button></fieldset>
    {preview&&<div className="sg-preview"><h3>{t('exactRequest')}</h3><p>{t('modelDisclosure')}</p><p>{t('previewExpiry')} · {preview.expiresAt}</p><p>{t('inputBytes')} · {preview.bytes}</p><p className="sg-mono">{preview.previewHash}</p>
      <Plain value={preview}/>
      <label className="sg-check"><input type="checkbox" checked={consent} disabled={expired||!canPreview} onChange={e=>{setConsent(e.target.checked);if(!e.target.checked)client.invalidateConsent();}}/>{t('sendConsent')}</label>
      <button disabled={!consent||!!confirmation||expired||!canPreview||state.busy.confirmation} onClick={()=>client.query('confirmation','confirmAnalysis',{previewHash:preview.previewHash})}>{t('confirmSend')}</button>
      {confirmation&&<button className="sg-primary" disabled={!consent||!canPreview||Date.parse(confirmation.expiresAt)<=Date.now()||state.busy.analysis} onClick={()=>client.sendAnalysis()}>{t('sendOnce')}</button>}
      {expired&&<p role="alert">{t('expired')}</p>}
    </div>}
    {state.analysisStarted&&<p role="status">{t('analysisSubmitted')}</p>}
  </section>;
}
