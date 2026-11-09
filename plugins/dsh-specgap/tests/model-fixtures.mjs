import assert from 'node:assert/strict';
import {fixture,prepareInput} from './service-fixtures.mjs';
import {createRunStore,hashRequest} from '../src/host/runs.mjs';
import {createAttempts} from '../src/host/attempts.mjs';

export const route={provider:'offline',model:'scripted',reasoningEffort:'low'};
export const budget={outputTokens:8192,timeoutSeconds:300};
export const catalog={default:{provider:'offline',model:'scripted'},routableProviders:['offline'],groups:[{id:'offline',name:'Offline',models:[{id:'scripted',name:'Scripted',reasoning:{efforts:[{id:'low',name:'Low'}],defaultEffort:'low'}}]}],failures:[]};
export const chunks=text=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}];
export async function setup(t,createModelReview,options={}) {
  assert.equal(typeof createModelReview,'function','model-review factory must exist');
  const f=await fixture(t),jobs=new Map(),calls={prepare:0,stream:0,imports:0,progress:[],bridge:[]};
  let next=0;
  // Scripted native-boundary double, never a production job implementation.
  f.ctx.jobs={start(spec){const id='specgap-scripted-'+(++next),record={status:'running',owner:spec.owner};jobs.set(id,record);
    const hooks=spec.run({id,append:text=>calls.progress.push(text),updateProgress:text=>calls.progress.push(text)});record.hooks=hooks;
    record.done=Promise.resolve(hooks.done).then(result=>{record.status=result.status;return {status:record.status};});return id;},
    kill(id,owner){const j=jobs.get(id);assert.equal(j.owner,owner);j.hooks.cancel();},
    async wait(id,timeout,owner){const j=jobs.get(id);assert.equal(j.owner,owner);return j.done;}};
  const state={stale:false,review:null,text:JSON.stringify({findings:[]}),events:null,material:null,stream:null,onStream:null,model:{provider:'offline',id:'scripted',defaultMaxTokens:4096,context:{contextWindow:100000},reasoning:{defaultEffort:'low'}}};
  const exact={system:'Review only frozen material. No tools.',user:JSON.stringify({bundle:{source:'consented source 中文'},template:{findings:[]}})};
  state.material={...exact,template:{findings:[]},hash:hashRequest(exact),bytes:Buffer.byteLength(exact.system)+Buffer.byteLength(exact.user)};
  f.ctx.sessionController.modelCatalog=async()=>structuredClone(catalog);
  f.ctx.llm={async prepareCall(config,signal,configure){calls.prepare++;signal?.throwIfAborted();const {provider,model,...controls}=config;
    const configured=configure?configure(controls,state.model):controls;
    const effective={provider,model,reasoningEffort:state.model.reasoning.defaultEffort,...configured};
    let used=false;return {config:effective,context:state.model.context,opaqueTransport:{apiKey:'DO-NOT-LOG'},stream(request){assert.equal(used,false);used=true;calls.stream++;calls.sent=request;
      assert.deepEqual(Object.fromEntries(Object.keys(effective).map(k=>[k,request[k]])),effective);
      return (async function*(){await state.onStream?.(request);if(state.stream){yield* state.stream(request);return;}for(const event of state.events ?? chunks(state.text))yield event;})();}};}};
  const store=createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),run=await store.create('w',prepareInput());await store.update('w',run.runId,{phase:'ready',error:null});
  const bridge={async callBridge(op,p,callOptions){calls.bridge.push(op);callOptions?.signal?.throwIfAborted();if(op==='material')return structuredClone(state.material);if(op==='read')return {status:{stale:state.stale},review:state.review};if(op==='import_review'){calls.imports++;state.review=p.review;return {review:p.review};}throw Error('Unexpected bridge operation.');},dispose(){}};
  const attempts=createAttempts({store,runtime:f.runtime});
  const models=createModelReview({runtime:f.runtime,store,attempts,bridge,...options});
  const authority={isOwner:true,workspaceId:'w',sessionId:'s',runId:run.runId};
  t.after(async()=>{await models.dispose?.();await attempts.dispose();});
  return {...f,jobs,calls,state,store,run,bridge,attempts,models,authority,
    async consent(selected=route,limits=budget){const preview=await models.preview(run.runId,selected,limits,authority);const confirmation=await models.confirm(preview.previewHash,authority);return {preview,...confirmation};},
    async finish(confirmation){const attempt=await models.start(confirmation.confirmationId,authority);return attempts.wait(attempt.attemptId);}};
}
