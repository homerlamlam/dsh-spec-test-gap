// Element-tree fixtures, not a DOM/browser or replacement React installation.
// Production still imports DSH's shared React. GUI interaction remains a Task7 gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({stdin:{contents:`export {Review,Evidence} from './src/client/Review.jsx';export {HumanActions} from './src/client/HumanActions.jsx';export {ModelReview} from './src/client/ModelReview.jsx';export {NewReview} from './src/client/NewReview.jsx';export {History,Downloads,Attempts} from './src/client/History.jsx';export {Workbench} from './src/client/Workbench.jsx';export {seed,render} from 'react';`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'fixture-react',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
let values=[],index=0;export function seed(v=[]){values=v;index=0;}
export function useState(initial){const i=index++;return [i<values.length?values[i]:(typeof initial==='function'?initial():initial),()=>{}];}
export const useEffect=()=>{};export const useSyncExternalStore=(s,g)=>g();
const createElement=(type,props,...children)=>({type,props:{...props,children}});
export default {createElement,Fragment:'fragment',useState,useEffect,useSyncExternalStore};
export function render(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(render);if(typeof node.type==='function'){const old=values,idx=index;seed();const result=render(node.type(node.props));values=old;index=idx;return result;}return {...node,props:{...node.props,children:node.props.children.map(render)}};}
`,loader:'js'}));}}]});
const ui=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const en=JSON.parse(await readFile(new URL('../locale/en-US.json',import.meta.url),'utf8')),zh=JSON.parse(await readFile(new URL('../locale/zh-CN.json',import.meta.url),'utf8'));
const t=key=>{assert.ok(Object.hasOwn(en,key),`missing English: ${key}`);assert.ok(Object.hasOwn(zh,key),`missing Chinese: ${key}`);return en[key];};
const hostile='<img src=x onerror=alert(1)> [open](javascript:alert(1))';
const citation={side:'head',path:'src/<script>.py',start_line:8,end_line:9,quote:hostile+'\r\n一\u2028二\r'};
const finding={id:'F1',kind:'contradiction',title:hostile,description:hostile,severity:'high',requirement_ids:['R1'],change_ids:['C1'],evidence:[citation],question:hostile,suggested_role:'qa',test_ideas:[hostile]};
const view={runId:'r',workspaceId:'w',createdAt:'now',repoLabel:'demo',bundle:{snapshot_id:'snapshot',repo:{head_sha:'abc',target_sha:'def',merge_base_sha:'base',base_sha:'base'},requirements:{text:hostile,clauses:[{id:'R1',text:hostile}]},changes:[{id:'C1',status:'M',old_path:'a.py',new_path:'a.py'}],budgets:{max_files:100},limitations:['bounded'],warnings:[]},policy:{actors:{dev:['developer'],qa:['qa'],pm:['product']}},status:{review_state:'partial',stale:false,findings:{F1:{assessment:'contradiction',intent:'unconfirmed',disposition:'undecided',verification:'unverified'}}},review:{requirements:[{id:'R1',assessment:'contradicted',reason:hostile,evidence:[citation]}],changes:[{id:'C1',assessment:'behavior_changed',summary:hostile,requirement_ids:['R1'],evidence:[citation]}],findings:[finding]},events:[],attempts:[],expectedSequence:7};
const state={selection:{workspaceId:'w',sessionId:'s',runId:'r'},busy:{},view,mutation:null,foreignPending:false};
const client={query(){},mutate(){},invalidateConsent(){},getSnapshot:()=>state};
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)];}
function text(tree){if(Array.isArray(tree))return tree.map(text).join('');if(tree==null||typeof tree==='boolean')return '';return typeof tree==='object'?text(tree.props?.children):String(tree);}
function render(name,props,seeds=[]){ui.seed(seeds);return ui.render(ui[name]({t,client,state,...props}));}
test('locale source keys are paired and every stable UI/error copy is localized',()=>{
 assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());for(const [k,v]of Object.entries(en)){if(k!=='meta'){assert.equal(typeof v,'string');assert.ok(v.length);assert.equal(typeof zh[k],'string');}}
});
test('unresolved conflict offers exact recovery and bounded independent snapshot, not acknowledgment',()=>{
 const calls=[],pending={...state,mutation:{phase:'ambiguous',operation:'respond',error:{code:'CONFLICT'}},parkedCount:0};
 const controller={...client,getSnapshot:()=>pending,recover:()=>calls.push('recover'),parkForNewSnapshot:()=>{calls.push('park');return true;}};
 const tree=render('Workbench',{},[controller,'new']),buttons=nodes(tree).filter(n=>n.type==='button');
 assert.equal(buttons.some(n=>text(n)===en.acknowledge),false);assert.ok(text(tree).includes(en.recoveryHelp));
 buttons.find(n=>text(n)===en.recoverExact).props.onClick();buttons.find(n=>text(n)===en.parkForSnapshot).props.onClick();assert.deepEqual(calls,['recover','park']);
 pending.parkedCount=7;assert.equal(nodes(render('Workbench',{},[controller,'new'])).find(n=>n.type==='button'&&text(n)===en.parkForSnapshot).props.disabled,true);
 pending.mutation={phase:'conflict',operation:'respond',error:{code:'CONFLICT'}};const initial=nodes(render('Workbench',{},[controller,'new']));
 assert.ok(initial.some(n=>n.type==='button'&&text(n)===en.acknowledge));assert.equal(initial.some(n=>n.type==='button'&&text(n)===en.parkForSnapshot),false);
});
test('two-direction review exposes four independent axes and inert hostile evidence',()=>{
 const tree=render('Review',{},['','','F1']),all=nodes(tree),copy=text(tree);
 for(const key of ['requirementsDirection','changesDirection','implementation','intent','disposition','verification','releaseDisclaimer'])assert.ok(copy.includes(en[key]));
 assert.ok(copy.includes(hostile));assert.equal(all.some(n=>['script','img','iframe','a'].includes(n.type)),false);assert.equal(all.some(n=>'dangerouslySetInnerHTML'in n.props),false);
 const lineSpans=all.filter(n=>n.props.className==='sg-line');assert.ok(lineSpans.some(n=>text(n).includes('一\u2028二')));assert.ok(copy.includes('src/<script>.py:8–9'));
});
test('null and zero-finding reviews render as different honest states',()=>{
 const nullTree=render('Review',{state:{...state,view:{...view,review:null}}});assert.ok(text(nullTree).includes(en.noReview));assert.ok(!text(nullTree).includes(en.zeroFindings));
 const zeroTree=render('Review',{state:{...state,view:{...view,review:{requirements:[],changes:[],findings:[]}}}});assert.ok(text(zeroTree).includes(en.zeroFindings));assert.ok(!text(zeroTree).includes(en.noReview));
});
test('human form uses only frozen actors, gate roles, same-finding decisions and exact snapshot token',()=>{
 const developer=render('HumanActions',{finding},['dev','respond','reply','','','failed',true]);let options=nodes(developer).filter(n=>n.type==='option');assert.equal(options.find(n=>n.props.value==='decide').props.disabled,true);assert.equal(options.find(n=>n.props.value==='verify').props.disabled,true);
 const qa=render('HumanActions',{finding},['qa','verify','note','evidence','','passed',true]);assert.equal(nodes(qa).find(n=>n.type==='option'&&n.props.value==='passed').props.disabled,true);
 const calls=[],authorized={...state,view:{...view,events:[{kind:'decision',finding_id:'F1'}]}};
 const allowed=render('HumanActions',{finding,state:authorized,client:{...client,mutate:(...args)=>calls.push(args)}},['qa','verify','note','evidence','','passed',true]);const form=nodes(allowed).find(n=>n.type==='form');form.props.onSubmit({preventDefault(){}});assert.deepEqual(calls,[['verify',{finding:'F1',actor:'qa',attestLocal:true,expectedSequence:7,result:'passed',evidenceText:'evidence',note:'note'}]]);
 const stale=render('HumanActions',{finding,state:{...state,view:{...view,status:{...view.status,stale:true}}}},['qa','respond','reply','','','failed',true]);assert.equal(nodes(stale).find(n=>n.type==='button').props.disabled,true);
});
test('model preview renders full payload inertly and no send before explicit consent',()=>{
 const preview={request:{system:hostile,messages:[hostile]},template:{schema:'fixture'},route:{provider:'p',model:'m'},budget:{outputTokens:100,timeoutSeconds:10},materialHash:'material',previewHash:'preview',expiresAt:new Date(Date.now()+100000).toISOString(),bytes:100,auditLocation:'private'},s={...state,view:{...view,review:null},preview,catalog:{groups:[],failures:[]}};
 const tree=render('ModelReview',{state:s,enabled:true}),copy=text(tree);assert.ok(copy.includes(JSON.stringify(preview,null,2)));assert.ok(copy.includes(en.modelDisclosure));const confirm=nodes(tree).find(n=>n.type==='button'&&text(n)===en.confirmSend);assert.equal(confirm.props.disabled,true);assert.equal(nodes(tree).some(n=>n.type==='button'&&text(n)===en.sendOnce),false);
});
test('intake is a labeled ordinary form; policy, branch and Unicode byte limits gate submit',()=>{
 const seeds=['.','text','Requirement','HEAD','','',100,524288,[{name:'qa',roles:['qa']}]];
 const comparison=render('NewReview',{enabled:true});assert.equal(nodes(comparison).some(n=>n.type==='textarea'),false);assert.ok(nodes(comparison).some(n=>n.type==='button'&&text(n)===en.nextRequirements));
 const tree=render('NewReview',{enabled:true},[...seeds,2,false]);assert.ok(nodes(tree).some(n=>n.type==='textarea'));assert.ok(nodes(tree).filter(n=>n.type==='label').length>=8);assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)===en.prepare).props.disabled,true);
 for(const [index,value] of [[0,'../outside'],[2,'\ud800'],[6,2001],[7,2097153],[8,[{name:'qa',roles:[]}]]]){const invalid=[...seeds,2,true];invalid[index]=value;assert.equal(nodes(render('NewReview',{enabled:true},invalid)).find(n=>n.type==='button'&&text(n)===en.prepare).props.disabled,true);}
 const calls=[],valid=render('NewReview',{enabled:true,client:{...client,mutate:(...args)=>calls.push(args)}},[...seeds,2,true]);nodes(valid).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.deepEqual(calls,[['prepare',{repoPath:'.',requirementsText:'Requirement',head:'HEAD',maxFiles:100,maxBytes:524288,policy:{actors:{qa:['qa']}}}]]);
});
test('history and attempt states never turn failed runs into findings',()=>{
 const tree=render('History',{state:{...state,history:{items:[{runId:'r',repoLabel:hostile,createdAt:'today',phase:'failed',attemptCount:1,lastAttemptPhase:'failed'}],nextOffset:null}}});assert.ok(text(tree).includes(en.failed));assert.ok(text(tree).includes(hostile));assert.equal(nodes(tree).some(n=>n.type==='a'),false);
 const attempts=render('Attempts',{state:{...state,view:{...view,review:null,attempts:[{attemptId:'a',phase:'failed',error:'INVALID_REVIEW'}]}}});assert.ok(text(attempts).includes(en.attemptFailure));assert.equal(nodes(attempts).some(n=>n.type==='button'&&text(n)===en.cancelNative),false);
});
