import React,{useState} from 'react';
import {validInput} from './api.mjs';
import {Field} from './NewReview.jsx';
const roles={confirm_defect:'qa',not_an_issue:'qa',approve_intent_change:'product',accept_risk:'security'};
export function HumanActions({t,client,state,finding}){
  const view=state.view,actors=view.policy?.actors||{};
  const [actor,setActor]=useState(''),[operation,setOperation]=useState('respond'),[text,setText]=useState(''),[evidence,setEvidence]=useState(''),[outcome,setOutcome]=useState(''),[result,setResult]=useState('failed'),[attest,setAttest]=useState(false);
  const actorRoles=actors[actor]||[],decisions=Object.keys(roles).filter(k=>actorRoles.includes(roles[k]));
  const priorDecision=view.events.some(e=>e.kind==='decision'&&e.finding_id===finding.id);
  const allowed=actor&&validInput(actor,120)&&validInput(finding.id,120)&&validInput(text)&&attest&&Number.isSafeInteger(view.expectedSequence)&&view.expectedSequence>=0&&!view.status.stale&&!state.mutation&&!state.foreignPending&&!state.busy.view&&
    (operation==='respond'||operation==='decide'&&decisions.includes(outcome)||operation==='verify'&&actorRoles.includes('qa')&&validInput(evidence,65536,65536)&&(result!=='passed'||priorDecision));
  return <form className="sg-human" onSubmit={e=>{e.preventDefault();if(!allowed)return;
    client.mutate(operation,{finding:finding.id,actor,attestLocal:true,expectedSequence:view.expectedSequence,...(operation==='respond'?{text}:operation==='decide'?{outcome,reason:text}:{result,evidenceText:evidence,note:text})});}}>
    <h3>{t('humanActions')}</h3><p>{t('attestationDisclaimer')}</p><p>{t('sequence')} · {view.expectedSequence??t('unavailable')}</p>
    <fieldset disabled={!!state.mutation||state.foreignPending||view.status.stale||state.busy.view}><legend>{t('newHumanAction')}</legend>
      <Field label={t('actor')}><select value={actor} onChange={e=>{setActor(e.target.value);setOutcome('');setOperation('respond');setAttest(false);}}><option value="">{t('chooseActor')}</option>{Object.entries(actors).map(([id,rs])=><option key={id} value={id}>{id} · {rs.map(r=>t(r)).join(', ')}</option>)}</select></Field>
      <Field label={t('action')}><select value={operation} onChange={e=>{setOperation(e.target.value);setAttest(false);}}><option value="respond">{t('respond')}</option><option value="decide" disabled={!decisions.length}>{t('decide')}</option><option value="verify" disabled={!actorRoles.includes('qa')}>{t('verify')}</option></select></Field>
      {operation==='decide'&&<Field label={t('outcome')}><select value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="">{t('choose')}</option>{decisions.map(d=><option key={d} value={d}>{t(d)}</option>)}</select></Field>}
      {operation==='verify'&&<><p>{t('manualOnly')}</p><Field label={t('verification')}><select value={result} onChange={e=>setResult(e.target.value)}><option value="failed">{t('failed')}</option><option value="passed" disabled={!priorDecision}>{t('passed')}</option></select></Field><Field label={t('manualEvidence')} hint={t('evidenceLimit')}><textarea rows="6" value={evidence} onChange={e=>setEvidence(e.target.value)} required/></Field></>}
      <Field label={t(operation==='respond'?'responseText':operation==='decide'?'reason':'note')} hint={t('textLimit')}><textarea rows="4" maxLength="12000" value={text} onChange={e=>setText(e.target.value)} required/></Field>
      <label className="sg-check"><input type="checkbox" checked={attest} onChange={e=>setAttest(e.target.checked)}/>{t('attestLocal')}</label>
      <button disabled={!allowed}>{t('recordAction')}</button>
    </fieldset>
  </form>;
}
