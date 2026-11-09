// Opt-in installed-runtime integration, never imports credentials or calls a provider.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {apply as applyHost,inject as hostInject} from '../src/host/index.mjs';
const root=process.env.DSH_NATIVE_MODULES;
if(!root)throw Error('Set DSH_NATIVE_MODULES to the installed @deepseek-ai module directory.');
const load=name=>import(pathToFileURL(path.join(root,name,'lib/index.js')));
const {Context}=await load('cordis');
const ctx=new Context();
try {
 for(const name of ['dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-llm','dsh-agent-loop','dsh-jobs-local']){
   const m=await load(name);await ctx.plugin(m.default).await();
 }
 const tools=await load('dsh-tool-jobs');await ctx.plugin(tools,{completionDelivery:'quiet'}).await();
 const handle=await ctx.agents.create({sessionId:'specgap-native-test',meta:{cwd:process.cwd()}});
 assert.equal(ctx.agents.get(handle.agent.id),handle.agent);
 let cancel;
 const done=new Promise(resolve=>{cancel=()=>resolve({status:'cancelled'});});
 const id=ctx.jobs.start({kind:'specgap',label:'No-model lifecycle proof',owner:handle.agent.id,run(job){job.append('native lifecycle\n');return {cancel,done};}});
 assert.equal(ctx.jobs.read(id,handle.agent.id).job.owner,handle.agent.id);
 assert.throws(()=>ctx.jobs.get(id,'other-session'));
 ctx.jobs.kill(id,handle.agent.id,'integration cleanup');
 await ctx.jobs.wait(id,1000,handle.agent.id);
 await handle.dispose();
 assert.equal(ctx.agents.get('specgap-native-test'),undefined);
 assert.throws(()=>ctx.jobs.get(id,'specgap-native-test'));
 console.log('PASS real AgentLoop/Session/AgentRegistry + tool-jobs controller + native Job ownership/cancel/dispose; no model calls.');
 const {HostConnectionService}=await load('dsh-client-connection');
 // Exercise native already-authenticated dispatcher only; HTTP cookie admission is Lead integration work.
 await ctx.plugin(c=>{new HostConnectionService(c,[],undefined);}).await();
 const plugin=ctx.plugin({name:'specgap-integration',inject:hostInject,apply:applyHost});await plugin.await();
 const dispatch=ctx.connection.createSharedFetchHandler('/api');
 const request=()=>new Request('http://localhost/api/specgap/v1/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'bootstrap',payload:{}})});
 const response=await dispatch.fetch(request(),ctx.connection.browserPeer);
 assert.equal(response.status,200);assert.equal((await response.json()).data.models,null);
 const guest=ctx.connection.createPeer({principal:{kind:'specgap-test-non-owner'}});
 assert.equal((await dispatch.fetch(request(),guest)).status,403);
 await plugin.dispose();
 assert.equal((await dispatch.fetch(request(),ctx.connection.browserPeer)).status,404);
 console.log('PASS real native Connection owner round-trip, non-owner rejection, unload route removal. HTTP/browser auth not tested.');
} finally {await ctx.fiber.dispose();}
