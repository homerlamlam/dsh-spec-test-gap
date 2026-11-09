import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,symlink,rename,chmod} from 'node:fs/promises';
import path from 'node:path';
import {createService} from '../src/host/service.mjs';
import {fixture,prepareInput,code,deferred} from './service-fixtures.mjs';
import * as module from '../src/host/runs.mjs';
function storeFor(runtime){assert.equal(typeof module.createRunStore,'function','durable run factory must exist');return module.createRunStore({root:runtime.dataRoot,runtime});}

test('workspace comes from registry; caller absolute, UNC, drive-relative and traversal paths never reach bridge',async t=>{
  const f=await fixture(t);let calls=0;
  const service=createService({runtime:f.runtime,bridge:{callBridge:async()=>{calls++;return {};},dispose(){}}});t.after(()=>service.dispose());
  for(const repoPath of ['../other','/outside','C:\\outside','C:relative','\\\\server\\share','sub/../file']) {
    await assert.rejects(service.dispatch('refs',{workspaceId:'w',repoPath},f.authority),e=>['FORBIDDEN','INVALID_INPUT'].includes(e.code));
  }
  await assert.rejects(service.dispatch('refs',{workspaceId:'w',repoPath:'.',workspaceRoot:f.other},f.authority),code('INVALID_INPUT'));
  assert.equal(calls,0);
  let payload;
  const good=createService({runtime:f.runtime,bridge:{callBridge:async(op,p)=>{payload=p;return {refs:[]};},dispose(){}}});t.after(()=>good.dispose());
  assert.deepEqual(await good.dispatch('refs',{workspaceId:'w',repoPath:'.'},f.authority),{refs:[]});
  assert.equal(payload.workspaceRoot,f.workspace);assert.equal(payload.repoPath,f.workspace);
});
test('linked repository and requirements escape is denied before preparation',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.other,'requirements.md'),'secret');await symlink(f.other,path.join(f.workspace,'escape'),'junction');
  let calls=0;const service=createService({runtime:f.runtime,bridge:{callBridge:async()=>{calls++;},dispose(){}}});t.after(()=>service.dispose());
  for(const payload of [{repoPath:'escape',requirementsText:'R-1'},{repoPath:'.',requirementsPath:'escape/requirements.md'}]) {
    await assert.rejects(service.dispatch('prepare',{workspaceId:'w',idempotencyKey:'escape',...payload},f.authority),code('FORBIDDEN'));
  }
  assert.equal(calls,0);
});
test('exclusive run creation binds workspace; replay matches payload while a changed request conflicts',async t=>{
  const f=await fixture(t),store=storeFor(f.runtime);
  const [a,b]=await Promise.all([store.create('w',prepareInput()),store.create('w',prepareInput())]);
  assert.equal(a.runId,b.runId);
  await assert.rejects(store.create('w',{...prepareInput(),requestHash:'b'.repeat(64)}),code('CONFLICT'));
  await assert.rejects(store.get('other',a.runId),code('NOT_FOUND'));
  await assert.rejects(store.get('w','../escape'),code('INVALID_INPUT'));
  await assert.rejects(store.get('missing',a.runId),code('NOT_FOUND'));
});
test('metadata cannot redirect core paths; registry remapping and retargeted private directories fail closed',async t=>{
  const f=await fixture(t),store=storeFor(f.runtime),run=await store.create('w',prepareInput());
  const paths=await store.paths('w',run.runId),metadata=path.join(paths.directory,'metadata.json');
  const original=await readFile(metadata,'utf8');
  await writeFile(metadata,JSON.stringify({...JSON.parse(original),runPath:f.other}));
  await assert.rejects(store.paths('w',run.runId),code('INTEGRITY'));await writeFile(metadata,original);
  f.workspaces.get('w').path=f.other;await assert.rejects(store.get('w',run.runId),code('STALE'));f.workspaces.get('w').path=f.workspace;
  await rename(paths.directory,paths.directory+'-saved');await symlink(f.other,paths.directory,'junction');
  await assert.rejects(store.get('w',run.runId),code('FORBIDDEN'));
});
test('private run storage nested in audited root or linked into it is refused',async t=>{
  const f=await fixture(t);
  for(const root of [f.workspace,path.join(f.workspace,'private')]) {
    assert.equal(typeof module.createRunStore,'function');const store=module.createRunStore({root,runtime:f.runtime});
    await assert.rejects(store.create('w',prepareInput()),code('FORBIDDEN'));
  }
  await mkdir(path.join(f.profile,'data'));await symlink(f.workspace,f.runtime.dataRoot,'junction');
  await assert.rejects(storeFor(f.runtime).create('w',prepareInput()),code('FORBIDDEN'));
});
test('history is bounded, omits bundles and survives recreation; failed preparation remains visible',async t=>{
  const f=await fixture(t),store=storeFor(f.runtime);
  for(let i=0;i<3;i++)await store.create('w',prepareInput(String(i)));
  const run=await store.create('w',prepareInput('failed'));await store.update('w',run.runId,{phase:'failed',error:'INVALID_INPUT'});
  const recreated=storeFor(f.runtime),page=await recreated.list('w',{limit:2,offset:0});
  assert.equal(page.items.length,2);assert.equal(page.nextOffset,2);assert.ok(page.items.every(r=>!('bundle' in r)));
  assert.equal((await recreated.get('w',run.runId)).phase,'failed');
  for(const options of [{limit:101},{limit:0},{offset:-1},{offset:10001}])await assert.rejects(recreated.list('w',options),code('INVALID_INPUT'));
});
test('atomic metadata replacement leaves no temp files and never removes an unknown core lock',async t=>{
  const f=await fixture(t),store=storeFor(f.runtime),run=await store.create('w',prepareInput()),p=await store.paths('w',run.runId);
  await mkdir(p.runPath);await writeFile(path.join(p.runPath,'.lock'),'unknown owner');
  const reads=[];await Promise.all([store.update('w',run.runId,{phase:'ready',error:null}),...Array.from({length:10},async()=>reads.push(JSON.parse(await readFile(path.join(p.directory,'metadata.json'),'utf8'))))]);
  assert.ok(reads.every(r=>['preparing','ready'].includes(r.phase)));
  assert.equal(await readFile(path.join(p.runPath,'.lock'),'utf8'),'unknown owner');
  assert.deepEqual((await readdir(p.directory)).sort(),['core','metadata.json']);
  await assert.rejects(store.update('w',run.runId,{runPath:f.other}),code('INVALID_INPUT'));
});
test('offline idempotency joins in-flight prepare, caches original result and conflicts on changed payload',async t=>{
  const f=await fixture(t),gate=deferred(),started=deferred();let prepares=0;
  const view={bundle:{frozen:true},policy:{actors:{}},review:null,events:[],status:{release_approval:false}};
  const bridge={async callBridge(op){if(op==='prepare'){prepares++;started.resolve();await gate.promise;}return structuredClone(view);},dispose(){}};
  const service=createService({runtime:f.runtime,bridge});t.after(()=>service.dispose());
  const payload={workspaceId:'w',repoPath:'.',requirementsText:'R-1',idempotencyKey:'click'};
  const first=service.dispatch('prepare',payload,f.authority);await started.promise;
  const second=service.dispatch('prepare',payload,f.authority);gate.resolve();
  const a=await first,b=await second;assert.deepEqual(a,b);assert.equal(prepares,1);
  await assert.rejects(service.dispatch('prepare',{...payload,requirementsText:'R-2'},f.authority),code('CONFLICT'));
  await service.dispose();
  const next=createService({runtime:f.runtime,bridge});t.after(()=>next.dispose());
  assert.deepEqual(await next.dispatch('prepare',payload,f.authority),a);assert.equal(prepares,1);
});
test('history summaries omit full attempts and expose only their count and last phase',async t=>{
  const f=await fixture(t),store=storeFor(f.runtime),run=await store.create('w',prepareInput());
  await store.update('w',run.runId,{phase:'ready',error:null});
  const summary=(await store.list('w')).items[0];assert.equal('attempts' in summary,false);assert.equal(summary.attemptCount,0);assert.equal(summary.lastAttemptPhase,null);
});
test('Windows atomic replacement failure preserves original metadata and removes only its own temporary file',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),store=storeFor(f.runtime),run=await store.create('w',prepareInput()),p=await store.paths('w',run.runId),file=path.join(p.directory,'metadata.json'),original=await readFile(file,'utf8');
  await chmod(file,0o400);
  try{await assert.rejects(store.update('w',run.runId,{phase:'ready',error:null}),code('ENVIRONMENT'));assert.equal(await readFile(file,'utf8'),original);assert.deepEqual(await readdir(p.directory),['metadata.json']);}
  finally{await chmod(file,0o600);}
});
test('workspace change during an admitted bridge read returns STALE rather than a successful old response',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  const service=createService({runtime:f.runtime,bridge:{async callBridge(){entered.resolve();await release.promise;return {refs:[]};},dispose(){release.resolve();}}});t.after(()=>service.dispose());
  const response=service.dispatch('refs',{workspaceId:'w',repoPath:'.'},f.authority);await entered.promise;
  f.workspaces.get('w').path=f.other;release.resolve();await assert.rejects(response,code('STALE'));
});
test('final durable result authority rejects stale commit and replay without changing committed operations',async t=>{
  for(const operation of ['prepare','demo','importReview'])for(const boundary of ['commit','replay'])for(const changed of ['Agent','workspace'])await t.test(`${operation} ${boundary} after ${changed} replacement`,async t=>{
    const f=await fixture(t),store=storeFor(f.runtime),entered=deferred(),release=deferred(),record=store.record,exclusive=store.exclusive,originalAgent=f.agents.get('s');
    const core={bundle:{frozen:true},policy:{actors:{}},review:null,events:[],status:{release_approval:false}},states=[];let committed,selection,mutations=0,pending;
    const payload={workspaceId:'w',sessionId:'s',idempotencyKey:'final-boundary'};
    if(operation==='prepare')Object.assign(payload,{repoPath:'.',requirementsText:'[REQ-1] frozen fixture'});
    if(operation==='importReview'){
      const run=await store.create('w',prepareInput('seed'));await store.update('w',run.runId,{phase:'ready',error:null});
      Object.assign(payload,{runId:run.runId,review:{findings:[]}});
    }
    store.record=async(...args)=>{
      const result=await record(...args);
      if(args[3])states.push(args[3].state);
      if(args[3]?.state==='completed'){
        committed=structuredClone(args[3]);selection=args.slice(0,3);
        if(boundary==='commit'){entered.resolve();await release.promise;}
      }
      return result;
    };
    const service=createService({runtime:f.runtime,store,bridge:{async callBridge(op,p){
      if(['prepare','demo','import_review'].includes(op))mutations++;
      if(op==='import_review')core.review=structuredClone(p.review);
      return op==='demo'?{view:structuredClone(core)}:structuredClone(core);
    },dispose(){}}});t.after(()=>service.dispose());
    const restore=()=>{f.agents.set('s',originalAgent);f.workspaces.get('w').path=f.workspace;store.exclusive=exclusive;};
    try {
      if(boundary==='replay'){
        await service.dispatch(operation,payload,f.authority);
        store.exclusive=async(...args)=>{const result=await exclusive(...args);entered.resolve();await release.promise;return result;};
      }
      pending=service.dispatch(operation,payload,f.authority);await entered.promise;
      assert.equal(committed.state,'completed');assert.equal(mutations,1);
      if(changed==='Agent')f.agents.set('s',{id:'s',replacement:true});else f.workspaces.get('w').path=f.other;
      release.resolve();await assert.rejects(pending,code('STALE'));
      restore();assert.deepEqual(await record(...selection),committed,'stale response must not rewrite a committed record');
      assert.equal((await store.get('w',selection[1])).phase,'ready');assert.deepEqual(states,['running','completed']);
      assert.deepEqual(await service.dispatch(operation,payload,f.authority),committed.result);assert.equal(mutations,1,'authorized replay must not redispatch committed work');
    }finally{release.resolve();await pending?.catch(()=>{});restore();}
  });
});
test('disposal attempts every cleanup even when one owned component rejects',async()=>{
  let bridgeDisposed=false,runtimeDisposed=false;
  const service=createService({runtime:{dispose(){runtimeDisposed=true;}},attempts:{async dispose(){throw Object.assign(Error('cleanup failed'),{code:'ENVIRONMENT'});}},bridge:{async dispose(){await Promise.resolve();bridgeDisposed=true;}}});
  await assert.rejects(service.dispose(),code('ENVIRONMENT'));assert.equal(bridgeDisposed,true);assert.equal(runtimeDisposed,true);
});
test('human and model routes require selectors; owner and strict fields still win first',async t=>{
  const f=await fixture(t),service=createService({runtime:f.runtime});t.after(()=>service.dispose());
  for(const op of ['analyze','confirmAnalysis','models','respond','decide','verify']) {
    await assert.rejects(service.dispatch(op,{},f.authority),code('INVALID_INPUT'));
    await assert.rejects(service.dispatch(op,{authority:{}},f.authority),code('INVALID_INPUT'));
    await assert.rejects(service.dispatch(op,{}, {isOwner:false}),code('FORBIDDEN'));
  }
});
