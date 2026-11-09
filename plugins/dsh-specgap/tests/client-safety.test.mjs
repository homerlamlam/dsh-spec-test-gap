import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,action} from '../src/client/api.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const view={runId:'r',workspaceId:'w',bundle:{},status:{},events:[],expectedSequence:3,review:null};
const make=transport=>createClient({transport,storage:storage(),newKey:()=> 'key'});
test('refresh clears actionable old run and consent before transport completes',async()=>{
 const gate=deferred();let wait=false;const c=make(async op=>wait?gate.promise:op==='run'?view:{previewHash:'hash'});c.select({workspaceId:'w',runId:'r'});await c.refresh();await c.query('preview','material');wait=true;const p=c.refresh();assert.equal(c.getSnapshot().view,null);assert.equal(c.getSnapshot().preview,null);gate.reject(new TypeError('offline'));await p;c.dispose();
});
test('report download callback cannot fire after Session switches',async()=>{
 const gate=deferred(),c=make(()=>gate.promise);let downloaded=0;c.select({workspaceId:'w',runId:'r',sessionId:'s'});const p=c.query('report','report',{},()=>downloaded++);c.select({sessionId:'new'});gate.resolve({markdown:'private'});await p;assert.equal(downloaded,0);c.dispose();
});
test('late confirmation does not survive consent edit or changed Session',async()=>{
 for(const change of [c=>c.invalidateConsent(),c=>c.select({sessionId:'new'})]){const gate=deferred(),c=make(()=>gate.promise);c.select({workspaceId:'w',runId:'r',sessionId:'s'});const p=c.query('confirmation','confirmAnalysis',{previewHash:'h'});change(c);gate.resolve({confirmationId:'secret'});await p;assert.equal(c.getSnapshot().confirmation,null);c.dispose();}
});
test('single-use send requires current unexpired confirmation and cannot double dispatch',async()=>{
 const gate=deferred(),calls=[];const c=make(async(op,p)=>{calls.push(op);if(op==='analyze')return gate.promise;return {confirmationId:'confirmed',expiresAt:new Date(Date.now()+10000).toISOString()};});c.select({workspaceId:'w',runId:'r',sessionId:'s'});await c.sendAnalysis();assert.equal(calls.length,0);await c.query('confirmation','confirmAnalysis');const a=c.sendAnalysis(),b=c.sendAnalysis();assert.equal(calls.filter(x=>x==='analyze').length,1);assert.equal(c.getSnapshot().confirmation,null);gate.resolve({attemptId:'a'});await Promise.all([a,b]);c.dispose();
});
test('read-after-commit uses owned AbortSignal and selection change cancels that read',async()=>{
 const gate=deferred();let signal;const c=make(async(op,p,s)=>{if(op==='run'){signal=s;return gate.promise;}return {sequence:4};});c.select({workspaceId:'w',runId:'r'});const p=c.mutate('respond',{expectedSequence:3});await Promise.resolve();assert.ok(signal);c.select({workspaceId:'other'});assert.equal(signal.aborted,true);gate.resolve(view);await p;assert.equal(c.getSnapshot().view,null);c.dispose();
});
test('failed conflict refresh can be explicitly refreshed then acknowledged without mutation replay',async()=>{
 let reads=0,mutations=0;const c=make(async op=>{if(op==='respond'){mutations++;throw Object.assign(new Error('CONFLICT'),{definitive:true,code:'CONFLICT'});}if(++reads===1)throw new TypeError('offline');return view;});c.select({workspaceId:'w',runId:'r'});await c.mutate('respond',{expectedSequence:2});c.acknowledge();assert.equal(c.getSnapshot().mutation.phase,'conflict');await c.refresh();c.acknowledge();assert.equal(c.getSnapshot().mutation,null);assert.equal(mutations,1);c.dispose();
});
test('read started before commit cannot overwrite authoritative post-commit view',async()=>{
 const old=deferred(),commit=deferred();let reads=0;const c=make(async op=>op==='respond'?commit.promise:++reads===1?old.promise:{...view,expectedSequence:4});c.select({workspaceId:'w',runId:'r'});const read=c.refresh(),write=c.mutate('respond',{expectedSequence:3});commit.resolve({sequence:4});await write;assert.equal(c.getSnapshot().view.expectedSequence,4);old.resolve({...view,expectedSequence:3});await read;assert.equal(c.getSnapshot().view.expectedSequence,4);c.dispose();
});
test('unavailable recovery storage refuses mutation before transport',async()=>{
 let calls=0;const c=createClient({transport:async()=>{calls++;},storage:{getItem(){return null;},setItem(){throw new Error('quota');}},newKey:()=> 'key'});c.select({workspaceId:'w'});await c.mutate('demo',{});assert.equal(calls,0);assert.equal(c.getSnapshot().error.code,'RECOVERY_STORAGE');c.dispose();
});
test('corrupt retained intent fails closed and cannot be overwritten by a new action',async()=>{
 let calls=0,writes=0;const c=createClient({transport:async()=>{calls++;},storage:{getItem:()=>'{broken',setItem:()=>writes++},newKey:()=> 'key'});c.select({workspaceId:'w'});await c.mutate('demo',{});assert.equal(calls,0);assert.equal(writes,0);assert.equal(c.getSnapshot().error.code,'RECOVERY_STORAGE');c.dispose();
});
test('ambiguous STALE can be parked only for a new snapshot while retaining exact old-run recovery',async()=>{
 const saved=storage(),calls=[];let stale=true;const transport=async(op,p)=>{calls.push([op,p]);if(op==='respond'&&stale)throw Object.assign(new Error('STALE'),{code:'STALE',definitive:true});return op==='prepare'?{...view,runId:'new'}:op==='run'?view:{sequence:4};};
 let c=createClient({transport,storage:saved,newKey:()=> 'old-key'});c.select({workspaceId:'w',runId:'run_'+'a'.repeat(32)});await c.mutate('respond',{finding:'F1',actor:'qa',attestLocal:true,text:'original',expectedSequence:3});assert.equal(c.getSnapshot().mutation.phase,'ambiguous');assert.equal(c.parkForNewSnapshot(),true);assert.equal(c.getSnapshot().selection.runId,'');await c.mutate('prepare',{repoPath:'.',requirementsText:'new snapshot'});c.acknowledge();c.dispose();
 c=createClient({transport,storage:saved,newKey:()=> 'different-key'});c.select({workspaceId:'w',runId:'run_'+'a'.repeat(32)});assert.equal(c.getSnapshot().mutation.phase,'ambiguous');await c.mutate('respond',{text:'fresh duplicate',expectedSequence:4});assert.equal(calls.filter(([op])=>op==='respond').length,1);stale=false;await c.recover();assert.deepEqual(calls.filter(([op])=>op==='respond')[1],calls[0]);c.dispose();
});
test('transport preserves authenticated POST envelope and safe code/request ID',async()=>{
 const before=globalThis.fetch;let call;try{globalThis.fetch=async(url,init)=>{call={url,...init};return {ok:false,json:async()=>({ok:false,error:{code:'CONFLICT'},requestId:'request-1'})};};await assert.rejects(action('run',{workspaceId:'w',runId:'r'}),e=>e.code==='CONFLICT'&&e.requestId==='request-1'&&e.definitive);assert.equal(call.credentials,'same-origin');assert.equal(call.method,'POST');assert.deepEqual(JSON.parse(call.body),{operation:'run',payload:{workspaceId:'w',runId:'r'}});}finally{globalThis.fetch=before;}
});
