// Focused element-tree interactions. Not DOM/browser acceptance; no shared dist output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({stdin:{contents:`export * from './src/client/Workbench.jsx';export * from './src/client/NewReview.jsx';export * from './src/client/Review.jsx';export {seed,rewind,render} from 'react';`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'workbench-fixture',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
let values=[],index=0;
export function seed(v=[]){values=[...v];index=0;}
export function rewind(){index=0;}
export function useState(initial){const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;const owner=values;return [owner[i],v=>{owner[i]=typeof v==='function'?v(owner[i]):v;}];}
export const useEffect=()=>{};export const useSyncExternalStore=(s,g)=>g();
const createElement=(type,props,...children)=>({type,props:{...props,children}});
export default {createElement,Fragment:'fragment',useState,useEffect,useSyncExternalStore};
export function render(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(render);if(typeof node.type==='function'){const old=values,idx=index;seed();const result=render(node.type(node.props));values=old;index=idx;return result;}return {...node,props:{...node.props,children:node.props.children.map(render)}};}
`,loader:'js'}));}}]});
const ui=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const en=JSON.parse(await readFile(new URL('../locale/en-US.json',import.meta.url),'utf8')),zh=JSON.parse(await readFile(new URL('../locale/zh-CN.json',import.meta.url),'utf8'));
const t=k=>{assert.ok(Object.hasOwn(en,k),`missing English: ${k}`);assert.ok(Object.hasOwn(zh,k),`missing Chinese: ${k}`);return en[k];};
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.props?.children)]:[];
const text=n=>Array.isArray(n)?n.map(text).join(''):n==null||typeof n==='boolean'?'':typeof n==='object'?text(n.props?.children):String(n);
const button=(tree,key)=>nodes(tree).find(n=>n.type==='button'&&text(n)===t(key));
const field=(tree,key)=>nodes(nodes(tree).find(n=>n.type==='label'&&text(n.props.children[0])===t(key))).find(n=>['input','select','textarea'].includes(n.type));
const mount=(name,props,seeds=[])=>{ui.seed(seeds);return ()=>{ui.rewind();return ui.render(ui[name]({t,...props}));};};
const makeView=(id='run-workbench')=>({runId:id,workspaceId:'w',repoLabel:'sample',createdAt:'2026-11-08T00:00:00Z',expectedSequence:3,bundle:{snapshot_id:'snapshot',repo:{head_sha:'abc',base_sha:'def'},requirements:{text:'Only the owner can cancel',clauses:[{id:'R1',text:'Only the owner can cancel'}]},changes:[],budgets:{},limitations:[],warnings:[]},policy:{actors:{alex:['developer'],qa:['qa']}},status:{review_state:'ready_for_review',stale:false,findings:{}},review:{requirements:[],changes:[],findings:[{id:'F-low',severity:'low',kind:'test_gap',title:'Low priority',description:'Low detail',requirement_ids:[],change_ids:[],evidence:[],question:'Question',suggested_role:'qa',test_ideas:[]},{id:'F-high',severity:'critical',kind:'contradiction',title:'Missing ownership check',description:'Needs evidence review',requirement_ids:['R1'],change_ids:[],evidence:[{side:'head',path:'src/cancel.ts',start_line:12,end_line:12,quote:'cancel(order.id);'}],question:'Where is the owner check?',suggested_role:'qa',test_ideas:[]}]},events:[],attempts:[]});
const makeState=(view=makeView())=>({selection:{workspaceId:'w',sessionId:'s',runId:view.runId},view,busy:{},mutation:null,foreignPending:false,bootstrap:{ready:true,dataRootAvailable:true,environment:{node:{available:true}},diagnostics:[],workspaces:[{id:'w',title:'Workspace',liveSessionIds:['s','same-workspace']} ]}});
const controller=state=>({getSnapshot:()=>state,subscribe:()=>()=>{},query(){},select(){},mutate(){},invalidateConsent(){},refresh(){}});

test('initial selection is restored and main actions are prominent without automatic model dispatch',()=>{
 const draw=mount('Workbench',{initialSelection:{workspaceId:'remembered',sessionId:'session',runId:''}}),tree=draw();
 assert.equal(field(tree,'workspace').props.value,'remembered');
 assert.ok(button(tree,'startDemo'),'offline demo should be a top-level action');
 assert.ok(button(tree,'newReview').props.className?.includes('sg-primary'));
 assert.equal(nodes(tree).some(n=>n.type==='button'&&text(n)===t('sendOnce')),false);
});

test('comparison and requirements are separate steps; named roles require fresh acknowledgment before prepare',()=>{
 const calls=[],state={...makeState(),selection:{workspaceId:'w',sessionId:'',runId:''},view:null};
 const client={...controller(state),mutate:(...args)=>calls.push(args)};
 const draw=mount('NewReview',{state,client,enabled:true});let tree=draw();
 assert.equal(nodes(tree).filter(n=>n.props['aria-current']==='step').length,1);
 assert.ok(button(tree,'nextRequirements'));assert.equal(field(tree,'requirements'),undefined);
 button(tree,'nextRequirements').props.onClick();tree=draw();
 assert.ok(field(tree,'requirements'));field(tree,'requirements').props.onChange({target:{value:'Only the owner can cancel'}});
 tree=draw();const actor=nodes(tree).find(n=>n.type==='input'&&n.props.maxLength==='120');actor.props.onChange({target:{value:'Alex'}});
 tree=draw();assert.equal(button(tree,'prepare').props.disabled,true);
 nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(calls.length,0);
 const acknowledge=()=>nodes(draw()).find(n=>n.type==='input'&&n.props['data-role-ack']);
 assert.ok(acknowledge());acknowledge().props.onChange({target:{checked:true}});assert.equal(button(draw(),'prepare').props.disabled,false);
 nodes(draw()).find(n=>n.type==='input'&&n.props.maxLength==='120').props.onChange({target:{value:'Alex QA'}});
 assert.equal(button(draw(),'prepare').props.disabled,true,'editing the policy invalidates acknowledgment');
 acknowledge().props.onChange({target:{checked:true}});nodes(draw()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(calls,[['prepare',{repoPath:'.',requirementsText:'Only the owner can cancel',head:'HEAD',maxFiles:100,maxBytes:524288,policy:{actors:{'Alex QA':['developer']}}}]]);
});

test('prepared offline run is step three, not a fabricated reviewed result',()=>{
 const view={...makeView('prepared'),review:null},state=makeState(view),draw=mount('Workbench',{},[controller(state),'review']);
 const tree=draw();assert.ok(nodes(tree).some(n=>n.props['aria-current']==='step'&&text(n).includes(t('stepReview'))));
 assert.ok(text(tree).includes(t('preparedHelp')));assert.ok(text(tree).includes(t('noReview')));
 assert.ok(button(tree,'previewReport'));assert.equal(button(tree,'confirmSend'),undefined);
});

test('review defaults to highest severity with linked requirement and open evidence before human forms',()=>{
 const state=makeState(makeView('finding-first')),draw=mount('Review',{state,client:controller(state)}),tree=draw();
 const detail=nodes(tree).find(n=>n.type==='article'&&n.props.className==='sg-detail');
 assert.ok(detail,'a finding is selected initially');assert.ok(text(detail).includes('Missing ownership check'));
 assert.ok(text(detail).includes('Only the owner can cancel'));
 assert.ok(nodes(detail).some(n=>n.type==='details'&&n.props.open===true&&text(n).includes('cancel(order.id);')));
 assert.equal(nodes(detail).some(n=>n.type==='form'),false);
 assert.ok(button(detail,'openHumanAction'));button(detail,'openHumanAction').props.onClick();
 assert.ok(nodes(draw()).some(n=>n.type==='form'&&n.props.className==='sg-human'));
 const list=nodes(tree).find(n=>n.props.className==='sg-findings');assert.ok(text(list).indexOf('F-high')<text(list).indexOf('F-low'));
});

test('mapping tabs and selected finding survive returning without caching authoritative data',()=>{
 const state=makeState(makeView('remember-tabs')),props={state,client:controller(state)};let draw=mount('Review',props),tree=draw();
 const low=nodes(tree).find(n=>n.type==='button'&&text(n).includes('Low priority'));assert.ok(low);low.props.onClick();
 tree=draw();const requirements=nodes(tree).find(n=>n.props.role==='tab'&&text(n).includes(t('requirementsDirection')));assert.ok(requirements);requirements.props.onClick();
 tree=draw();assert.equal(nodes(tree).filter(n=>n.props.role==='tabpanel').length,1);
 draw=mount('Review',props);tree=draw();assert.ok(nodes(tree).some(n=>n.props.role==='tab'&&n.props['aria-selected']===true&&text(n).includes(t('requirementsDirection'))));
 nodes(tree).find(n=>n.props.role==='tab'&&text(n).includes(t('findings'))).props.onClick();
 assert.ok(text(nodes(draw()).find(n=>n.type==='article'&&n.props.className==='sg-detail')).includes('Low priority'));
 const other=mount('Review',{state:makeState(makeView('another-run')),client:controller(state)})();
 assert.ok(text(nodes(other).find(n=>n.type==='article'&&n.props.className==='sg-detail')).includes('Missing ownership check'));
});

test('report confirmation refuses absent or foreign live Sessions and mismatched run content',async()=>{
  const state=makeState(),calls=[],props={state,live:[],openReport:async p=>calls.push(p)},draw=mount('ReportPreview',props);
  button(draw(),'previewReport').props.onClick();let tree=draw();assert.ok(text(tree).includes(t('reportNoSession')));assert.equal(button(tree,'confirmOpenReport').props.disabled,true);
  field(tree,'reportSession').props.onChange({target:{value:'foreign-session'}});await button(draw(),'confirmOpenReport').props.onClick();assert.deepEqual(calls,[]);
  props.live=['s'];field(draw(),'reportSession').props.onChange({target:{value:'s'}});props.state={...state,view:{...state.view,runId:'another-run'}};tree=draw();assert.equal(button(tree,'confirmOpenReport').props.disabled,true);await button(tree,'confirmOpenReport').props.onClick();assert.deepEqual(calls,[]);
  props.state={...state,view:{...state.view,workspaceId:'another-workspace'}};tree=draw();assert.equal(button(tree,'confirmOpenReport').props.disabled,true);await button(tree,'confirmOpenReport').props.onClick();assert.deepEqual(calls,[]);
});

test('report handoff is single-flight, explicit format is retained, and success closes confirmation',async()=>{
  let done;const gate=new Promise(resolve=>done=resolve),calls=[],state=makeState(),props={state,live:['s'],openReport:p=>{calls.push(p);return gate;}},draw=mount('ReportPreview',props);
  button(draw(),'previewReport').props.onClick();field(draw(),'reportFormat').props.onChange({target:{value:'json'}});const confirm=button(draw(),'confirmOpenReport');const pending=confirm.props.onClick();await confirm.props.onClick();assert.equal(calls.length,1);assert.equal(calls[0].format,'json');assert.equal(button(draw(),'confirmOpenReport').props.disabled,true);done();await pending;assert.equal(button(draw(),'confirmOpenReport'),undefined);
});

test('remembered selection cannot revive old finding content in another workspace or refreshed run',()=>{
  const state=makeState(makeView('memory-boundary')),props={state,client:controller(state)};let draw=mount('Review',props),tree=draw();nodes(tree).find(n=>n.type==='button'&&text(n).includes('Low priority')).props.onClick();
  const refreshed={...state,view:{...state.view,review:{...state.view.review,findings:state.view.review.findings.filter(f=>f.id!=='F-low').map(f=>({...f,title:'Fresh authoritative finding'}))}}};
  tree=mount('Review',{state:refreshed,client:controller(refreshed)})();assert.ok(text(tree).includes('Fresh authoritative finding'));assert.equal(text(tree).includes('Low priority'),false);
  const other={...state,view:{...state.view,workspaceId:'other-workspace'}};tree=mount('Review',{state:other,client:controller(other)})();assert.ok(text(nodes(tree).find(n=>n.props.className==='sg-detail')).includes('Missing ownership check'));
});

test('report opening requires explicit same-workspace Conversation confirmation; rejection is visible',async()=>{
 assert.equal(typeof ui.ReportPreview,'function','separate testable explicit report-switch control');
 const state=makeState(),calls=[],draw=mount('ReportPreview',{state,live:['s','same-workspace'],openReport:async p=>{calls.push(p);throw new Error('Not mounted');}});
 let tree=draw();button(tree,'previewReport').props.onClick();tree=draw();
 assert.ok(text(tree).includes(t('conversationSwitchHelp')));assert.equal(calls.length,0);
 const session=field(tree,'reportSession');assert.deepEqual(nodes(session).filter(n=>n.type==='option').map(n=>n.props.value),['','s','same-workspace']);
 session.props.onChange({target:{value:'same-workspace'}});tree=draw();await button(tree,'confirmOpenReport').props.onClick();
 assert.deepEqual(calls,[{workspaceId:'w',sessionId:'same-workspace',runId:state.selection.runId,format:'markdown'}]);
 assert.ok(nodes(draw()).some(n=>n.props.role==='alert'&&text(n).includes(t('reportOpenFailed'))));
});
