import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,prepareInput,code} from './service-fixtures.mjs';
import {createRunStore,hashRequest} from '../src/host/runs.mjs';
const {createRequestAudit}=await import('../src/host/request-audit.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
async function setup(t,io) {
  assert.equal(typeof createRequestAudit,'function','private durable request-audit factory must exist');
  const f=await fixture(t),store=createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),run=await store.create('w',prepareInput());await store.update('w',run.runId,{phase:'ready',error:null});
  const payload={workspaceId:'w',runId:run.runId,sessionId:'s',materialHash:hashRequest({system:'exact',user:'source 中文'}),route:{provider:'offline',model:'scripted',reasoningEffort:null},budget:{outputTokens:100,timeoutSeconds:300},request:{provider:'offline',model:'scripted',maxTokens:100,system:'exact',messages:[{role:'user',content:[{type:'text',text:'source 中文'}]}]},template:{findings:[]}};
  const attempt={schemaVersion:1,attemptId:'attempt_'+'a'.repeat(32),workspaceId:'w',runId:run.runId,sessionId:'s',requestHash:hashRequest(payload),modelRoute:payload.route,phase:'running',jobId:'specgap-test',startedAt:new Date().toISOString(),endedAt:null,error:null};await store.attempt('w',run.runId,attempt);
  const p=await store.paths('w',run.runId),directory=path.join(p.directory,`audit-${attempt.attemptId}`),file=path.join(directory,'request.json');
  return {...f,store,run,p,payload,attempt,directory,file,audit:createRequestAudit({store,runtime:f.runtime,...(io?{io}:{})})};
}
test('exclusive immutable audit survives reopened store; fsync finishes before acknowledgement',async t=>{
  let syncs=0;const io={...fs,async open(...args){const h=await fs.open(...args),sync=h.sync.bind(h);h.sync=async()=>{await sync();syncs++;};return h;}};
  const f=await setup(t,io);await f.audit.commit(f.attempt,f.payload);assert.ok(syncs>=1);
  const reopened=createRequestAudit({store:createRunStore({root:f.runtime.dataRoot,runtime:f.runtime}),runtime:f.runtime});
  const disk=await reopened.read(f.attempt);assert.deepEqual(disk,{schemaVersion:1,...f.payload,attemptId:f.attempt.attemptId,requestHash:f.attempt.requestHash});
  const original=await fs.readFile(f.file,'utf8');await assert.rejects(f.audit.commit(f.attempt,f.payload),code('CONFLICT'));assert.equal(await fs.readFile(f.file,'utf8'),original);
});
test('audit write, flush and atomic finalize failures reject and preserve failed artifacts',async t=>{
  for(const phase of ['writeFile','sync','close','link','unlink'])await t.test(phase,async t=>{
    const io={...fs,async open(...args){const h=await fs.open(...args);if(args[1]==='wx' && ['writeFile','sync','close'].includes(phase)){const close=h.close.bind(h);h[phase]=async()=>{if(phase==='close')await close();throw Error('private failure secret');};}return h;},async link(...args){if(phase==='link')throw Error('private failure secret');return fs.link(...args);},async unlink(...args){if(phase==='unlink')throw Error('private failure secret');return fs.unlink(...args);}};
    const f=await setup(t,io);await assert.rejects(f.audit.commit(f.attempt,f.payload),e=>e.code==='ENVIRONMENT' && !e.message.includes('secret'));
    const artifacts=await fs.readdir(f.directory);assert.ok(artifacts.length>0);await assert.rejects(f.audit.commit(f.attempt,f.payload),code(phase==='unlink'?'FORBIDDEN':'CONFLICT'));assert.deepEqual(await fs.readdir(f.directory),artifacts);
  });
});
test('wrong attempt workspace/run/session, route or input hash fails without creating audit',async t=>{
  for(const change of ['workspaceId','runId','sessionId','input','route'])await t.test(change,async t=>{
    const f=await setup(t);const payload=structuredClone(f.payload);
    if(change==='input')payload.request.system+=' changed';else if(change==='route')payload.route.model='other';else payload[change]='wrong';
    await assert.rejects(f.audit.commit(f.attempt,payload),code('INTEGRITY'));await assert.rejects(fs.stat(f.directory),{code:'ENOENT'});
  });
});
test('unknown occupied audit slot, symlink/junction and hardlinked final artifact are never repaired',async t=>{
  const f=await setup(t);await fs.mkdir(f.directory);await fs.writeFile(path.join(f.directory,'unknown.lock'),'keep');
  await assert.rejects(f.audit.commit(f.attempt,f.payload),code('CONFLICT'));assert.equal(await fs.readFile(path.join(f.directory,'unknown.lock'),'utf8'),'keep');
  const g=await setup(t);await fs.symlink(g.other,g.directory,'junction');await assert.rejects(g.audit.commit(g.attempt,g.payload),code('FORBIDDEN'));assert.deepEqual(await fs.readdir(g.other),[]);
  const h=await setup(t);await h.audit.commit(h.attempt,h.payload);await fs.link(h.file,path.join(h.other,'copy'));await assert.rejects(h.audit.read(h.attempt),code('FORBIDDEN'));
});
test('reopened audit detects corrupt JSON, mismatched content and substituted final record',async t=>{
  for(const value of ['not json','{"schemaVersion":1}',null])await t.test(String(value),async t=>{
    const f=await setup(t);await f.audit.commit(f.attempt,f.payload);
    if(value===null){const disk=JSON.parse(await fs.readFile(f.file,'utf8'));disk.request.system+=' changed';await fs.writeFile(f.file,JSON.stringify(disk));}else await fs.writeFile(f.file,value);
    await assert.rejects(f.audit.read(f.attempt),code('INTEGRITY'));assert.equal((await fs.stat(f.file)).isFile(),true);
  });
});
