import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/client/api.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
function client(transport){return api.createClient({transport,storage:storage(),newKey:()=> 'intent-1'});}
const view=(review=null)=>({runId:'run_a',workspaceId:'w',bundle:{warnings:[],limitations:[]},status:{stale:false,findings:{}},review,expectedSequence:7,events:[]});
for(const field of ['workspaceId','sessionId','runId'])test(`late ${field} response cannot populate new selection or download`,async()=>{
 const gate=deferred(), c=client(()=>gate.promise);c.select({workspaceId:'w',sessionId:'s',runId:'r'});
 const task=c.query('view','run');c.select({[field]:'other'});gate.resolve(view());await task;
 assert.equal(c.getSnapshot().view,null);assert.equal(c.getSnapshot().preview,null);c.dispose();
});
test('history material clears synchronously across workspace switch even when next query fails',async()=>{
 const c=client(async()=>({items:[{runId:'private'}]}));c.select({workspaceId:'w'});await c.query('history','runs');assert.equal(c.getSnapshot().history.items.length,1);
 c.select({workspaceId:'other'});assert.equal(c.getSnapshot().history,null);c.dispose();
});
test('rapid human submits share one complete durable intent and refresh coherent run',async()=>{
 const gate=deferred(),calls=[], c=client(async(op,p)=>{calls.push([op,p]);return op==='respond'?gate.promise:view({findings:[]});});c.select({workspaceId:'w',runId:'run_a'});
 const payload={finding:'F-1',actor:'qa',text:'reply',attestLocal:true,expectedSequence:7};
 const a=c.mutate('respond',payload),b=c.mutate('respond',payload);assert.equal(calls.length,1);assert.equal(c.getSnapshot().mutation.phase,'sending');
 gate.resolve({sequence:8});await Promise.all([a,b]);assert.equal(calls[0][1].idempotencyKey,'intent-1');assert.equal(c.getSnapshot().view.expectedSequence,7);assert.equal(c.getSnapshot().mutation.phase,'committed');c.dispose();
});
test('ambiguous human outcome retains exact payload through remount and explicit recovery',async()=>{
 const saved=storage(),calls=[];let fail=true;
 const transport=async(op,p)=>{calls.push([op,p]);if(op==='respond'&&fail)throw new TypeError('network');return op==='run'?view():{sequence:8};};
 let c=api.createClient({transport,storage:saved,newKey:()=> 'original'});c.select({workspaceId:'w',runId:'run_'+'a'.repeat(32)});await c.mutate('respond',{finding:'F1',actor:'qa',attestLocal:true,text:'original text',expectedSequence:7});assert.equal(c.getSnapshot().mutation.phase,'ambiguous');c.dispose();
 c=api.createClient({transport,storage:saved,newKey:()=> 'different'});c.select({workspaceId:'w',runId:'run_'+'a'.repeat(32)});fail=false;await c.recover();assert.deepEqual(calls[0],calls[1]);assert.equal(c.getSnapshot().mutation.phase,'committed');c.dispose();
});
test('committed action with failed refresh is not rejected or duplicated',async()=>{
 let mutations=0;const c=client(async op=>{if(op==='run')throw new TypeError('offline');mutations++;return {sequence:8};});c.select({workspaceId:'w',runId:'r'});await c.mutate('respond',{expectedSequence:7});assert.equal(c.getSnapshot().mutation.phase,'committedRefreshFailed');await c.recover();assert.equal(mutations,1);c.dispose();
});
test('conflict refresh requires explicit review acknowledgement, never token substitution',async()=>{
 const calls=[], c=client(async(op,p)=>{calls.push([op,p]);if(op==='respond')throw Object.assign(new Error('CONFLICT'),{code:'CONFLICT',definitive:true});return view();});c.select({workspaceId:'w',runId:'r'});await c.mutate('respond',{expectedSequence:6});assert.equal(c.getSnapshot().mutation.phase,'conflict');assert.equal(c.getSnapshot().view.expectedSequence,7);await c.mutate('respond',{expectedSequence:7});assert.equal(calls.filter(x=>x[0]==='respond').length,1);c.acknowledge();assert.equal(c.getSnapshot().mutation,null);c.dispose();
});
test('any consent edit invalidates preview and late confirmation, even if values change back',async()=>{
 const gate=deferred();const c=client(()=>gate.promise);c.select({workspaceId:'w',sessionId:'s',runId:'r'});const p=c.query('preview','material');c.invalidateConsent();gate.resolve({previewHash:'old'});await p;assert.equal(c.getSnapshot().preview,null);c.dispose();
});
test('honest independent null, zero, partial, dirty unknown and stale states',()=>{
 assert.deepEqual(api.reviewFlags(view()),['noReview']);const v=view({findings:[]});assert.deepEqual(api.reviewFlags(v),['zeroFindings']);v.bundle.limitations=['omitted'];v.bundle.warnings=['Worktree status unknown: filters'];v.status.stale=true;assert.deepEqual(api.reviewFlags(v),['zeroFindings','partial','dirtyUnknown','stale']);
});
test('physical lines preserve Unicode separators and ignore only final physical newline',()=>{assert.deepEqual(api.physicalLines('一\u2028二\r\nthree\r'),['一\u2028二','three']);});
test('text limits enforce Unicode, UTF16 scalar caps and UTF8 evidence bytes',()=>{
 assert.equal(api.validInput('😀'.repeat(32768),120000,65536),false);assert.equal(api.validInput('😀'.repeat(16384),65536,65536),true);assert.equal(api.validInput('\ud800',120,1000),false);assert.equal(api.validInput('a\0',120,1000),false);assert.equal(api.validInput('😀'.repeat(61),120,1000),false);
});
