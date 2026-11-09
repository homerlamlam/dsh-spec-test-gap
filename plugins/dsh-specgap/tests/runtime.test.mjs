import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntime} from '../src/host/runtime.mjs';
import {apply} from '../src/host/index.mjs';

const signal = () => new AbortController().signal;
test('bootstrap liveSessionIds projects registered resident IDs only without resolving cold Sessions',async()=>{
  let resolutions=0;const resident={private:'never project'};
  const workspace={id:'w',title:'Workspace',path:process.cwd(),sessionIds:['live','cold']};
  const ctx={workspaceRegistry:{list:()=>[workspace],get:()=>workspace},agents:{get:id=>['live','foreign'].includes(id)?resident:undefined},sessionController:{resolveAgent(){resolutions++;}}};
  const runtime=createRuntime(ctx,{});
  try {const result=await runtime.bootstrap({}, {signal:signal()});assert.deepEqual(result.workspaces,[{id:'w',title:'Workspace',sessionIds:['live','cold'],liveSessionIds:['live']}]);assert.equal(resolutions,0);
    ctx.agents.get=undefined;assert.deepEqual((await runtime.bootstrap({}, {signal:signal()})).workspaces[0].liveSessionIds,[]);
  }finally{runtime.dispose();}
});
test('present but incompatible services cannot claim bootstrap readiness', async () => {
  const runtime=createRuntime({workspaceRegistry:{},sessionController:{},jobs:{},profileContext:{dir:tmpdir()}},{});
  const result=await runtime.bootstrap({}, {signal:signal()});
  assert.equal(result.ready,false);
  for(const name of ['workspaceRegistry','sessionController','jobs','agents'])assert.equal(result.diagnostics.find(d=>d.capability===name)?.available,false);
});
test('non-callable workspace list reports unavailable instead of throwing', async () => {
  const runtime=createRuntime({workspaceRegistry:{get(){},list:true}},{});
  try {
    const result=await runtime.bootstrap({}, {signal:signal()});
    assert.equal(result.ready,false);
    assert.equal(result.diagnostics.find(d=>d.capability==='workspaceRegistry')?.available,false);
    assert.deepEqual(result.workspaces,[]);
  } finally {runtime.dispose();}
});
test('profile-root junction into audited workspace is refused',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'specgap-profile-'));
  try {
    const workspacePath=path.join(root,'workspace');await mkdir(workspacePath);
    const profile=path.join(root,'profile');await mkdir(profile);
    await symlink(workspacePath,path.join(profile,'data'),'junction');
    const runtime=createRuntime({profileContext:{dir:profile},workspaceRegistry:{get:()=>({path:workspacePath,sessionIds:[]})}},{});
    await assert.rejects(runtime.bootstrap({workspaceId:'w'},{signal:signal()}),{code:'ENVIRONMENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('missing required native capabilities gives visible diagnostics, never a fabricated ready state', async () => {
  const runtime = createRuntime({}, {});
  const result = await runtime.bootstrap({}, {signal:signal()});
  assert.equal(result.ready, false);
  for (const service of ['workspaceRegistry','sessionController','jobs','profileContext']) {
    assert.ok(result.diagnostics.some(d=>d.capability === service && !d.available));
  }
  assert.deepEqual(result.workspaces, []);
  assert.equal(result.models, null);
});
test('bootstrap advertises implemented human and model operations without claiming missing native readiness',async()=>{
  const runtime=createRuntime({},{});
  try{const result=await runtime.bootstrap({}, {signal:signal()});assert.deepEqual(result.implemented,['bootstrap','refs','runs','run','material','models','report','prepare','demo','confirmAnalysis','analyze','cancel','importReview','respond','decide','verify']);assert.equal(result.diagnostics.find(d=>d.capability==='modelDispatch').available,false);assert.match(result.auditLocation,/not the native Session log/);}
  finally{runtime.dispose();}
});
test('binding rejects cross-workspace and cold/fabricated ownership before jobs', async () => {
  let resolved = 0, started = 0;
  const workspace = {id:'w',path:process.cwd(),sessionIds:['s']};
  const agent = {session:{id:'s'}};
  const ctx = {workspaceRegistry:{get:id=>id==='w'?workspace:undefined},sessionController:{resolveAgent:async()=>{resolved++;return {agent};}},agents:{get:()=>agent},jobs:{start:spec=>{started++;return spec;}}};
  const runtime = createRuntime(ctx,{});
  await assert.rejects(runtime.bindSession('w','other',signal()),{code:'FORBIDDEN'});
  assert.equal(resolved,0);
  const binding = await runtime.bindSession('w','s',signal());
  assert.equal(binding.sessionId,'s');
  assert.equal(runtime.startJob(binding,{kind:'specgap',label:'test',run(){}}).owner,'s');
  assert.equal(started,1);
  assert.throws(()=>runtime.startJob({...binding},{kind:'specgap'}),{code:'FORBIDDEN'});
  ctx.agents.get=()=>undefined;
  assert.throws(()=>runtime.startJob(binding,{kind:'specgap'}),{code:'STALE'});
});
test('canonical path resolution rejects traversal and symlink escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'specgap-'));
  try {
    await mkdir(path.join(root,'inside'));
    await mkdir(path.join(root,'outside'));
    await symlink(path.join(root,'outside'),path.join(root,'inside','escape'),'junction');
    const runtime=createRuntime({},{});
    assert.equal(await runtime.resolveInside(root,'inside',signal()),path.join(root,'inside'));
    await assert.rejects(runtime.resolveInside(path.join(root,'inside'),'..',signal()),{code:'FORBIDDEN'});
    await assert.rejects(runtime.resolveInside(path.join(root,'inside'),'escape',signal()),{code:'FORBIDDEN'});
  } finally {await rm(root,{recursive:true,force:true});}
});
test('native routes are exact, buffered, disposable and never trust JSON authority', async () => {
  const routes=[], effects=[];
  const ctx={connection:{fetch:{register:route=>{routes.push(route);return async()=>{routes.splice(routes.indexOf(route),1);};}}},effect:fn=>effects.push(fn()),get(){}};
  apply(ctx,{});
  assert.deepEqual(routes.map(r=>r.path),['/api/specgap/v1/action','/api/specgap/v1/report']);
  assert.ok(routes.every(r=>r.requestBody==='buffered'));
  const route=routes[0];
  const response=await route.fetch(new Request('http://localhost/api/specgap/v1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'bootstrap',payload:{},isOwner:true})}));
  assert.equal(response.status,400);
  const data=await response.json();
  assert.equal(data.error.code,'INVALID_INPUT');
  assert.equal(typeof data.requestId,'string');
  const ok=await route.fetch(new Request('http://localhost/api/specgap/v1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'bootstrap',payload:{}})}));
  assert.equal((await ok.json()).data.ready,false);
  for(const dispose of effects.reverse()) await dispose?.();
  assert.equal(routes.length,0);
});
