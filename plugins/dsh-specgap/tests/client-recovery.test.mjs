import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../src/client/api.mjs';

const storageKey='specgap.pending-intent.v1';
const runId='run_'+'a'.repeat(32),newRun='run_'+'b'.repeat(32);
const selection={workspaceId:'w',sessionId:'s',runId};
const human={finding:'F1',actor:'qa',attestLocal:true,text:'original intent',expectedSequence:7};
const view={workspaceId:'w',runId,expectedSequence:8,bundle:{},status:{},review:null,events:[],attempts:[]};
const memory=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const conflict=()=>Object.assign(new Error('CONFLICT'),{code:'CONFLICT',definitive:true});
const retained=storage=>JSON.parse(storage.getItem(storageKey));
const receipt=(operation='respond')=>({operation,phase:'ambiguous',selection:{...selection},payload:{workspaceId:'w',sessionId:'s',runId,idempotencyKey:'original',...human},error:{code:'STALE',requestId:null}});
const envelope=active=>({version:1,active,parked:[]});
async function refuses(saved){
 const storage=memory(),raw=typeof saved==='string'?saved:JSON.stringify(saved);storage.setItem(storageKey,raw);let calls=0;
 const c=createClient({storage,transport:async()=>{calls++;return view;},newKey:()=> 'new-key'});
 assert.equal(c.getSnapshot().error?.code,'RECOVERY_STORAGE');
 c.returnToPending();assert.deepEqual(c.getSnapshot().selection,{workspaceId:'',sessionId:'',runId:''});
 c.select(selection);await c.recover();c.acknowledge();assert.equal(c.parkForNewSnapshot(),false);await c.mutate('demo',{});
 assert.equal(calls,0);assert.equal(storage.getItem(storageKey),raw);assert.equal(c.getSnapshot().error?.code,'RECOVERY_STORAGE');c.dispose();
}

test('interrupted exact replay remains unresolved after read, selection changes, remount and repeated recovery',async()=>{
 const storage=memory(),calls=[];let key=0;
 const transport=async(op,p)=>{calls.push([op,structuredClone(p)]);if(op==='run')return view;if(calls.filter(([o])=>o==='respond').length===1)throw new TypeError('lost reply');throw conflict();};
 let c=createClient({storage,transport,newKey:()=>`key-${++key}`});c.select(selection);await c.mutate('respond',human);
 const original=retained(storage).active.payload;
 await c.recover();await c.refresh();c.acknowledge();
 assert.equal(c.getSnapshot().mutation?.phase,'ambiguous');assert.deepEqual(retained(storage).active.payload,original);
 c.select({workspaceId:'other'});c.returnToPending();assert.deepEqual(c.getSnapshot().selection,selection);c.dispose();
 c=createClient({storage,transport,newKey:()=>`key-${++key}`});c.returnToPending();await c.refresh();c.acknowledge();await c.recover();
 assert.equal(c.getSnapshot().mutation?.phase,'ambiguous');await c.mutate('respond',{...human,expectedSequence:8});
 assert.deepEqual(calls.filter(([op])=>op==='respond').map(([,p])=>p),[original,original,original]);assert.equal(key,1);c.dispose();
});

test('late recovery conflict preserves the receipt without populating another selection',async()=>{
 const storage=memory(),r=receipt();storage.setItem(storageKey,JSON.stringify(envelope(r)));let reject,reads=0,signal;
 const c=createClient({storage,transport:async(op,p,s)=>{if(op==='run'){reads++;return view;}signal=s;return new Promise((_,no)=>{reject=no;});}});
 c.returnToPending();const pending=c.recover();c.select({workspaceId:'other'});assert.equal(signal.aborted,true);reject(conflict());await pending;
 assert.equal(reads,0);assert.equal(c.getSnapshot().view,null);assert.equal(c.getSnapshot().mutation,null);assert.equal(c.getSnapshot().foreignPending,true);
 assert.deepEqual(retained(storage).active.payload,r.payload);assert.equal(retained(storage).active.phase,'ambiguous');c.returnToPending();c.acknowledge();assert.equal(c.getSnapshot().mutation.phase,'ambiguous');c.dispose();
});

test('initial sequence conflict still allows explicit reviewed new intent, never an automatic retry',async()=>{
 const storage=memory(),calls=[];let key=0;
 const c=createClient({storage,newKey:()=>`key-${++key}`,transport:async(op,p)=>{calls.push([op,p]);if(op==='run')return view;if(p.idempotencyKey==='key-1')throw conflict();return {sequence:9};}});
 c.select(selection);await c.mutate('respond',human);assert.equal(c.getSnapshot().mutation.phase,'conflict');
 await c.mutate('respond',{...human,expectedSequence:8});assert.equal(calls.filter(([op])=>op==='respond').length,1);
 c.acknowledge();await c.mutate('respond',{...human,expectedSequence:8});
 assert.deepEqual(calls.filter(([op])=>op==='respond').map(([,p])=>[p.idempotencyKey,p.expectedSequence]),[['key-1',7],['key-2',8]]);c.dispose();
});

test('unresolved replay conflict can explicitly park, preserve the receipt and block the old run across Sessions',async()=>{
 const storage=memory(),calls=[];let key=0;
 const transport=async(op,p)=>{calls.push([op,structuredClone(p)]);if(op==='run')return view;if(op==='demo')return {...view,runId:newRun};if(calls.filter(([o])=>o==='respond').length===1)throw new TypeError('lost');throw conflict();};
 let c=createClient({storage,transport,newKey:()=>`key-${++key}`});c.select(selection);await c.mutate('respond',human);await c.recover();
 const original=retained(storage).active;
 assert.equal(c.parkForNewSnapshot(),true);assert.equal(c.getSnapshot().selection.runId,'');assert.equal(c.getSnapshot().confirmation,null);
 await c.mutate('demo',{});assert.deepEqual(retained(storage).parked,[original]);assert.equal(retained(storage).active.payload.idempotencyKey,'key-2');
 c.acknowledge();c.dispose();c=createClient({storage,transport,newKey:()=>`key-${++key}`});c.select({...selection,sessionId:'another'});
 await c.mutate('respond',{...human,expectedSequence:8});await c.recover();assert.equal(calls.filter(([op])=>op==='respond').length,2);
 c.returnToPending();assert.deepEqual(c.getSnapshot().selection,selection);await c.recover();assert.deepEqual(calls.filter(([op])=>op==='respond')[2][1],original.payload);c.dispose();
});

const invalidRecords=[
 ['workspace mismatch',r=>r.payload.workspaceId='other'],
 ['run mismatch',r=>r.payload.runId=newRun],
 ['Session mismatch',r=>r.payload.sessionId='other'],
 ['missing original Session',r=>delete r.payload.sessionId],
 ['unexpected original Session',r=>r.selection.sessionId=''],
 ['present empty Session',r=>{r.selection.sessionId='';r.payload.sessionId='';}],
 ['null Session',r=>r.payload.sessionId=null],
 ['unknown record field',r=>r.authority={isOwner:true}],
 ['unknown selection field',r=>r.selection.workspaceRoot='C:/private'],
 ['unknown payload field',r=>r.payload.isOwner=true],
 ['unknown operation',r=>r.operation='importReview'],
 ['model start is not a retained idempotent operation',r=>r.operation='analyze'],
 ['unknown phase',r=>r.phase='done'],
 ['invalid selection type',r=>r.selection.runId=3],
 ['invalid workspace',r=>{r.selection.workspaceId=' ';r.payload.workspaceId=' ';}],
 ['invalid run format',r=>{r.selection.runId='r';r.payload.runId='r';}],
 ['invalid key type',r=>r.payload.idempotencyKey=1],
 ['empty key',r=>r.payload.idempotencyKey=''],
 ['oversized key',r=>r.payload.idempotencyKey='k'.repeat(129)],
 ['bad key Unicode',r=>r.payload.idempotencyKey='\ud800'],
 ['missing token',r=>delete r.payload.expectedSequence],
 ['string token',r=>r.payload.expectedSequence='7'],
 ['negative token',r=>r.payload.expectedSequence=-1],
 ['fractional token',r=>r.payload.expectedSequence=1.5],
 ['unsafe token',r=>r.payload.expectedSequence=Number.MAX_SAFE_INTEGER+1],
 ['missing attestation',r=>r.payload.attestLocal=false],
 ['oversized actor',r=>r.payload.actor='😀'.repeat(61)],
 ['empty finding',r=>r.payload.finding=''],
 ['missing text',r=>delete r.payload.text],
 ['invalid text type',r=>r.payload.text={}],
 ['blank text',r=>r.payload.text=' \n'],
 ['NUL text',r=>r.payload.text='x\0'],
 ['invalid Unicode text',r=>r.payload.text='\ud800'],
 ['oversized text',r=>r.payload.text='x'.repeat(12001)],
 ['malformed error',r=>r.error={code:3,requestId:null}],
 ['extra error field',r=>r.error.authority=true],
 ['invalid error request ID',r=>r.error.requestId={}],
 ['malformed result',r=>r.result={runId:'bad'}],
 ['human result cannot change run',r=>r.result={runId:newRun}],
 ['invalid refresh flag',r=>r.refreshed='yes'],
 ['ambiguous cannot be marked refreshed',r=>r.refreshed=true],
];
for(const [name,change] of invalidRecords)for(const location of ['active','parked'])test(`invalid ${location} recovery: ${name}`,async()=>{
 const r=receipt();change(r);await refuses(location==='active'?envelope(r):{version:1,active:null,parked:[r]});
});

for(const [name,change] of [
 ['extra envelope field',s=>s.authority=true],['unsupported version',s=>s.version=2],['missing active',s=>delete s.active],
 ['missing parked',s=>delete s.parked],['nonarray parked',s=>s.parked={}],['nonobject active',s=>s.active=[]],
 ['parked committed',s=>s.parked=[{...receipt(),phase:'committed',result:null}]],
 ['parked sending',s=>s.parked=[{...receipt(),phase:'sending'}]],
 ['parked rejected',s=>s.parked=[{...receipt(),phase:'rejected'}]],
 ['parked nonrecoverable reason',s=>s.parked=[{...receipt(),error:{code:'UNAVAILABLE',requestId:null}}]],
 ['duplicate active/parked',s=>s.parked=[structuredClone(s.active)]],
 ['duplicate parked',s=>{s.active=null;s.parked=[receipt(),receipt()];}],
 ['same old run under different Session',s=>{const r=receipt();r.selection.sessionId='other';r.payload.sessionId='other';r.payload.idempotencyKey='other';s.parked=[r];}],
 ['eight parked records',s=>{s.active=null;s.parked=Array.from({length:8},(_,i)=>{const r=receipt();r.selection.runId=r.payload.runId='run_'+String(i).padStart(32,'0');return r;});}],
])test(`invalid recovery envelope: ${name}`,async()=>{const s=envelope(receipt());change(s);await refuses(s);});

for(const raw of ['', 'null', '[]', 'true', '1', '"text"'])test(`non-envelope storage ${JSON.stringify(raw)} fails closed`,async()=>{await refuses(raw);});

test('duplicate JSON keys and oversized raw storage fail closed without rewriting bytes',async()=>{
 await refuses(JSON.stringify(envelope(receipt())).replace('"version":1','"version":1,"version":1'));
 await refuses(' '.repeat(8*1024*1024+1));
});

const creation=(operation='prepare')=>({operation,phase:'ambiguous',selection:{workspaceId:'w',sessionId:'',runId:''},payload:{workspaceId:'w',idempotencyKey:'create-key',...(operation==='prepare'?{repoPath:'.',requirementsText:'Requirement',head:'HEAD',target:'main',base:'base',maxFiles:100,maxBytes:524288,policy:{actors:{qa:['qa']}}}:{})}});
for(const [name,change] of [
 ['creation payload includes run',r=>r.payload.runId=runId],['creation selection run before result',r=>r.selection.runId=runId],
 ['creation result does not match selected run',r=>{r.phase='committed';r.result={runId};r.selection.runId=newRun;}],
 ['committed creation missing result',r=>r.phase='committed'],['creation result has extra fields',r=>{r.phase='committed';r.result={runId,authority:true};r.selection.runId=runId;}],
 ['absolute repo path',r=>r.payload.repoPath='C:/private'],['parent requirements path',r=>{delete r.payload.requirementsText;r.payload.requirementsPath='../private';}],
 ['both requirements sources',r=>r.payload.requirementsPath='requirements.md'],['neither requirements source',r=>delete r.payload.requirementsText],
 ['oversized requirements bytes',r=>r.payload.requirementsText='😀'.repeat(262145)],['invalid reference',r=>r.payload.head='\0'],
 ['invalid maxFiles',r=>r.payload.maxFiles=2001],['invalid maxBytes',r=>r.payload.maxBytes=0],
 ['invalid policy type',r=>r.payload.policy=[]],['extra policy authority',r=>r.payload.policy.authority=true],
 ['invalid policy role',r=>r.payload.policy.actors.qa=['owner']],['duplicate policy role',r=>r.payload.policy.actors.qa=['qa','qa']],
 ['oversized policy',r=>r.payload.policy.actors=Object.fromEntries(Array.from({length:200},(_,i)=>['x'.repeat(110)+i,['qa']]))],
])test(`invalid creation recovery: ${name}`,async()=>{const r=creation();change(r);await refuses(envelope(r));});

test('operation must be a string, not an array coercible to demo',async()=>{const r=creation('demo');r.operation=['demo'];await refuses(envelope(r));});

test('parked creation is invalid even with an otherwise legal ambiguous STALE receipt',async()=>{
 const r=creation('demo');r.error={code:'STALE',requestId:null};await refuses({version:1,active:null,parked:[r]});
});

for(const [operation,fields] of [['decide',{outcome:'accept_risk',reason:'reason'}],['verify',{result:'passed',evidenceText:'manual evidence',note:'note'}]]){
 const make=()=>{const r=receipt(operation);delete r.payload.text;Object.assign(r.payload,fields);return r;};
 for(const [name,change] of [
  ['invalid enum',r=>r.payload[operation==='decide'?'outcome':'result']='unknown'],
  ['oversized text',r=>r.payload[operation==='decide'?'reason':'note']='x'.repeat(12001)],
  ['missing field',r=>delete r.payload[operation==='decide'?'reason':'evidenceText']],
  ...(operation==='verify'?[['oversized evidence bytes',r=>r.payload.evidenceText='😀'.repeat(16385)]]:[]),
 ])test(`invalid ${operation} recovery: ${name}`,async()=>{const r=make();change(r);await refuses(envelope(r));});
}

for(const operation of ['respond','decide','verify'])for(const sessionId of ['', 's'])test(`valid ${operation} exact recovery preserves ${sessionId?'bound':'absent'} Session`,async()=>{
 const storage=memory(),r=receipt(operation),calls=[];r.selection.sessionId=sessionId;if(!sessionId)delete r.payload.sessionId;
 if(operation!=='respond'){delete r.payload.text;Object.assign(r.payload,operation==='decide'?{outcome:'accept_risk',reason:'reason'}:{result:'passed',evidenceText:'😀'.repeat(16384),note:'note'});}
 storage.setItem(storageKey,JSON.stringify(envelope(r)));
 const c=createClient({storage,transport:async(op,p)=>{calls.push([op,p]);return op==='run'?view:{sequence:8};}});c.returnToPending();await c.recover();
 assert.deepEqual(calls[0],[operation,r.payload]);assert.equal(c.getSnapshot().mutation.phase,'committed');c.dispose();
});

for(const operation of ['prepare','demo'])for(const phase of ['sending','ambiguous','committed','committedRefreshFailed'])test(`valid ${operation} ${phase} recovery keeps creation payload free of result runId`,async()=>{
 const storage=memory(),r=creation(operation),calls=[];r.phase=phase;if(phase.startsWith('committed')){r.result={runId};r.selection.runId=runId;}
 storage.setItem(storageKey,JSON.stringify(envelope(r)));
 const c=createClient({storage,transport:async(op,p)=>{calls.push([op,structuredClone(p)]);return view;}});c.returnToPending();await c.recover();await c.refresh();
 assert.equal(c.getSnapshot().mutation?.phase,'committed');assert.equal(c.getSnapshot().selection.runId,runId);
 const mutations=calls.filter(([op])=>op===operation);assert.equal(mutations.length,phase.startsWith('committed')?0:1);
 if(mutations.length)assert.deepEqual(mutations[0][1],r.payload);
 assert.deepEqual(retained(storage).active.payload,r.payload);assert.equal(Object.hasOwn(retained(storage).active.payload,'runId'),false);c.dispose();
});

test('legacy single receipt remains recoverable and committed-refresh failure never replays the event',async()=>{
 const storage=memory(),r=receipt(),calls=[];r.phase='committedRefreshFailed';r.result=null;storage.setItem(storageKey,JSON.stringify(r));
 const c=createClient({storage,transport:async(op,p)=>{calls.push([op,p]);throw new TypeError('offline');}});c.returnToPending();await c.recover();
 assert.deepEqual(calls.map(([op])=>op),['run']);assert.equal(c.getSnapshot().mutation.phase,'committedRefreshFailed');c.dispose();
});

test('seven parked receipts block another park without evicting any receipt',async()=>{
 const storage=memory(),saved=envelope(receipt());saved.parked=Array.from({length:7},(_,i)=>{const r=receipt();r.selection.runId=r.payload.runId='run_'+String(i).padStart(32,'0');return r;});
 storage.setItem(storageKey,JSON.stringify(saved));const c=createClient({storage});c.returnToPending();const before=storage.getItem(storageKey);
 assert.equal(c.parkForNewSnapshot(),false);assert.equal(storage.getItem(storageKey),before);assert.equal(c.getSnapshot().parkedCount,7);c.dispose();
});

test('parking an unresolved conflict fails closed on quota without losing the active receipt',async()=>{
 const storage=memory();let fail=false;const set=storage.setItem;storage.setItem=(...args)=>{if(fail)throw new Error('quota');set(...args);};
 let first=true;const c=createClient({storage,newKey:()=> 'key',transport:async()=>{if(first){first=false;throw new TypeError('lost');}throw conflict();}});
 c.select(selection);await c.mutate('respond',human);await c.recover();const before=storage.getItem(storageKey);fail=true;
 assert.equal(c.parkForNewSnapshot(),false);assert.equal(c.getSnapshot().error?.code,'RECOVERY_STORAGE');assert.equal(c.getSnapshot().mutation.phase,'ambiguous');assert.equal(storage.getItem(storageKey),before);c.dispose();
});
