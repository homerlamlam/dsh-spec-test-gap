import React,{useState} from 'react';
import {bytes,relativePath,validInput} from './api.mjs';
export const ROLES=['developer','product','qa','security'];
export function Field({label,children,hint}){return <label className="sg-field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>;}
export function ReviewSteps({t,current}){
  return <ol className="sg-steps" aria-label={t('reviewSteps')}>{['stepComparison','stepRequirements','stepReview'].map((key,i)=><li key={key} aria-current={current===i+1?'step':undefined} className={current>i+1?'sg-step-done':''}><span className="sg-step-number">{i+1}</span><span>{t(key)}</span></li>)}</ol>;
}
export function NewReview({t,client,state,enabled}){
  const [repoPath,setRepo]=useState('.'),[mode,setMode]=useState('text'),[requirements,setRequirements]=useState('');
  const [head,setHead]=useState('HEAD'),[target,setTarget]=useState(''),[base,setBase]=useState('');
  const [maxFiles,setFiles]=useState(100),[maxBytes,setBytes]=useState(524288);
  const [actors,setActors]=useState([{name:'',roles:['developer']}]);
  const [step,setStep]=useState(1),[actorsConfirmed,setActorsConfirmed]=useState(false);
  const locked=!!state.mutation||state.foreignPending;
  const policy={actors:Object.fromEntries(actors.map(a=>[a.name,a.roles]))};
  const validActors=actors.length>0&&actors.every(a=>validInput(a.name,120)&&a.roles.length)&&new Set(actors.map(a=>a.name)).size===actors.length&&bytes(JSON.stringify(policy))<=16384;
  const validComparison=relativePath(repoPath)&&validInput(head,4096)&&Number.isInteger(maxFiles)&&maxFiles>0&&maxFiles<=2000&&Number.isInteger(maxBytes)&&maxBytes>0&&maxBytes<=2097152;
  const valid=validComparison&&validActors&&actorsConfirmed&&(mode==='text'?validInput(requirements,1048576,1048576):relativePath(requirements));
  const refs=state.refs?.refs||[];
  function changeRepo(value){setRepo(value);setHead('HEAD');setTarget('');setBase('');client.select({});}
  function changeActors(value){setActors(value);setActorsConfirmed(false);}
  function branch(label,value,update,optional=false){return <Field label={label}><select value={value} onChange={e=>update(e.target.value)}><option value={optional?'':'HEAD'}>{optional?t('automaticBase'):t('head')}</option>{refs.filter(r=>r.name!=='HEAD').map(r=><option key={r.name} value={r.name}>{r.name} · {r.oid.slice(0,12)}</option>)}</select></Field>;}
  return <section className="sg-new" aria-labelledby="sg-new"><ReviewSteps t={t} current={step}/>
    <div className="sg-wizard-card"><p className="sg-eyebrow">{t('newReview')}</p><h2 id="sg-new">{t(step===1?'comparisonTitle':'requirementsTitle')}</h2><p className="sg-muted">{t('offline')}</p>
      <form onSubmit={e=>{e.preventDefault();if(step!==2||!enabled||!valid||locked)return;client.mutate('prepare',{repoPath,[mode==='text'?'requirementsText':'requirementsPath']:requirements,head,...(target?{target}:{}),...(base?{base}:{}),maxFiles,maxBytes,policy});}}>
        {step===1&&<fieldset className="sg-plain-fieldset" disabled={!enabled||locked}><legend className="sg-sr-only">{t('snapshot')}</legend>
          <Field label={t('repoPath')} hint={t('relativeOnly')}><input value={repoPath} onChange={e=>changeRepo(e.target.value)} required/></Field>
          <div className="sg-actions"><button type="button" disabled={!relativePath(repoPath)||state.busy.refs} onClick={()=>client.query('refs','refs',{repoPath})}>{t('loadRefs')}</button>{state.refs&&<small className="sg-mono">HEAD · {state.refs.head}</small>}</div>
          <div className="sg-grid">{branch(t('head'),head,setHead)}{branch(t('target'),target,setTarget,true)}</div>
          <details className="sg-advanced"><summary>{t('advancedComparison')}</summary>{branch(t('base'),base,setBase,true)}<p className="sg-muted">{t('baseHelp')}</p>
            <div className="sg-grid"><Field label={t('maxFiles')}><input type="number" min="1" max="2000" value={maxFiles} onChange={e=>setFiles(Number(e.target.value))}/></Field><Field label={t('maxBytes')}><input type="number" min="1" max="2097152" value={maxBytes} onChange={e=>setBytes(Number(e.target.value))}/></Field></div>
          </details>
          <div className="sg-form-actions"><small>{t('comparisonHelp')}</small><button className="sg-primary" type="button" disabled={!enabled||locked||!validComparison} onClick={()=>{if(enabled&&!locked&&validComparison)setStep(2);}}>{t('nextRequirements')}</button></div>
        </fieldset>}
        {step===2&&<>
          <fieldset className="sg-plain-fieldset" disabled={!enabled||locked}><legend className="sg-sr-only">{t('requirements')}</legend>
            <Field label={t('requirementsMode')}><select value={mode} onChange={e=>{setMode(e.target.value);setRequirements('');}}><option value="text">{t('paste')}</option><option value="path">{t('workspaceFile')}</option></select></Field>
            <Field label={t('requirements')} hint={t(mode==='text'?'requirementsLimit':'relativeOnly')}>{mode==='text'?<textarea rows="7" value={requirements} onChange={e=>setRequirements(e.target.value)} required/>:<input value={requirements} onChange={e=>setRequirements(e.target.value)} required/>}</Field>
          </fieldset>
          <fieldset className="sg-policy" disabled={!enabled||locked}><legend>{t('localPolicy')}</legend><p className="sg-muted">{t('attestationDisclaimer')}</p>
            {actors.map((actor,i)=><div className="sg-actor" key={i}><Field label={`${t('actor')} ${i+1}`}><input value={actor.name} maxLength="120" required onChange={e=>changeActors(actors.map((a,j)=>j===i?{...a,name:e.target.value}:a))}/></Field>
              <div className="sg-role-options">{ROLES.map(role=><label className="sg-check" key={role}><input type="checkbox" checked={actor.roles.includes(role)} onChange={e=>changeActors(actors.map((a,j)=>j===i?{...a,roles:e.target.checked?[...a.roles,role]:a.roles.filter(r=>r!==role)}:a))}/>{t(role)}</label>)}</div>
              <button type="button" disabled={actors.length===1} onClick={()=>changeActors(actors.filter((_,j)=>j!==i))}>{t('removeActor')}</button></div>)}
            <button type="button" disabled={actors.length>=24} onClick={()=>changeActors([...actors,{name:'',roles:[]}])}>{t('addActor')}</button>
            <label className="sg-check sg-ack"><input type="checkbox" data-role-ack checked={actorsConfirmed} disabled={!validActors} onChange={e=>setActorsConfirmed(e.target.checked)}/>{t('confirmActors')}</label>
          </fieldset>
          <div className="sg-form-actions"><button type="button" disabled={locked} onClick={()=>setStep(1)}>{t('previousStep')}</button><button className="sg-primary" disabled={!enabled||locked||!valid}>{t('prepare')}</button></div>
        </>}
      </form>
    </div>
  </section>;
}
