import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail,LIMITS,relativePath} from '../shared/contract.mjs';
const exec=promisify(execFile);
const inside=(root,target)=>{const rel=path.relative(root,target);return rel==='' || (!rel.startsWith(`..${path.sep}`) && rel!=='..' && !path.isAbsolute(rel));};
const checkSignal=signal=>{if(signal?.aborted) fail('CANCELLED','Request cancelled.');};
const capability=(ctx,name)=>typeof ctx.get==='function'?ctx.get(name):ctx[name];
// Resolve every existing ancestor, including junctions, without creating data directories.
async function canonicalProspective(target) {
  try{return await realpath(target);}catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(target);if(parent===target)throw error;
    return path.join(await canonicalProspective(parent),path.basename(target));
  }
}
// Shared absolute-only resolver: never search Host/workspace cwd or PATH aliases
// resolving into those roots. Used by bootstrap and the subprocess bridge.
async function trustedSearch(workspacePaths=[]) {
  const roots=await Promise.all([process.cwd(),...workspacePaths.filter(p=>typeof p==='string')].map(canonicalProspective));
  const directories=[];
  const hostPath=Object.entries(process.env).find(([key])=>key.toUpperCase()==='PATH')?.[1] ?? '';
  for(const entry of hostPath.split(path.delimiter)) {
    if(!path.isAbsolute(entry) || (process.platform==='win32' && /^[\\/]$/.test(path.parse(entry).root)))continue;
    try {
      const dir=await realpath(entry);
      if(!roots.some(root=>inside(root,dir)) && (await stat(dir)).isDirectory() && !directories.includes(dir))directories.push(dir);
    } catch {}
  }
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PATH'));
  env.PATH=directories.join(path.delimiter);
  async function absolute(file) {
    if(typeof file!=='string' || !path.isAbsolute(file))return null;
    try {
      const candidate=await realpath(file);
      if(!roots.some(root=>inside(root,candidate)) && (await stat(candidate)).isFile())return candidate;
    } catch {}
    return null;
  }
  async function find(command) {
    for(const dir of directories){const result=await absolute(path.join(dir,command+(process.platform==='win32'?'.exe':'')));if(result)return result;}
    return null;
  }
  return {env,absolute,find};
}

/** Only native Host configuration may supply explicit executable candidates. */
export async function resolveBridgeEnvironment({signal,workspacePaths=[],pythonPath,gitPath}={}) {
  checkSignal(signal);
  const search=await trustedSearch(workspacePaths);
  let python=pythonPath?await search.absolute(pythonPath):await search.find('python');
  const pythonArgs=[];
  if(!python && !pythonPath)python=await search.find('python3');
  if(!python && !pythonPath && process.platform==='win32'){python=await search.find('py');pythonArgs.push('-3');}
  const git=gitPath?await search.absolute(gitPath):await search.find('git');
  const taskkill=process.platform==='win32'?await search.absolute(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe')):null;
  if(!python || !git || (process.platform==='win32' && !taskkill))fail('ENVIRONMENT','Trusted Python, Git and process cleanup tools are required.');
  const env=Object.fromEntries(Object.entries(search.env).filter(([key])=>!key.toUpperCase().startsWith('PYTHON') && !key.toUpperCase().startsWith('GIT_')));
  for(const [file,args,minimum] of [[python,[...pythonArgs,'-I','-S','--version'],[3,11]],[git,['--version'],[2,31]]]) {
    try {
      const {stdout,stderr}=await exec(file,args,{cwd:path.dirname(file),env,shell:false,signal,timeout:5000,maxBuffer:16384,windowsHide:true});
      const match=(stdout+stderr).match(/(\d+)\.(\d+)\.(\d+)/);
      if(!match || (+match[1]<minimum[0] || (+match[1]===minimum[0] && +match[2]<minimum[1])))throw Error('Unsupported version');
    } catch {checkSignal(signal);fail('ENVIRONMENT','Python 3.11+ and Git 2.31+ are required.');}
  }
  checkSignal(signal);
  return {python,pythonArgs,git,taskkill,env};
}

/** Native API adapter. No provider dispatch, credentials, or repository writes. */
export function createRuntime(ctx,config={}) {
  const bindings=new WeakSet();
  const lifetime=new AbortController();
  const get=name=>capability(ctx,name);
  const profile=get('profileContext');
  const dataRoot=typeof profile?.dir==='string' && path.isAbsolute(profile.dir)?path.join(profile.dir,'data','specgap'):null;
  function workspace(id) {const w=get('workspaceRegistry')?.get(id);if(!w) fail('NOT_FOUND','Workspace is not registered.');return w;}
  async function resolveInside(root,relative,signal) {
    checkSignal(signal);
    if(!relativePath(relative)) fail('FORBIDDEN','Only workspace-relative paths are permitted.');
    const canonical=await realpath(root), target=path.resolve(canonical,relative);
    if(!inside(canonical,target)) fail('FORBIDDEN','Path escapes workspace.');
    const resolved=await realpath(target);
    checkSignal(signal);
    if(!inside(canonical,resolved)) fail('FORBIDDEN','Resolved path escapes workspace.');
    return resolved;
  }
  async function bindSession(workspaceId,sessionId,signal) {
    checkSignal(signal);
    const w=workspace(workspaceId);
    if(!w.sessionIds.includes(sessionId)) fail('FORBIDDEN','Session is not a member of this workspace.');
    const controller=get('sessionController');
    if(!controller?.resolveAgent) fail('UNAVAILABLE','Native session controller unavailable.');
    const result=await controller.resolveAgent(sessionId);
    checkSignal(signal);
    if(!result.agent || result.agent!==get('agents')?.get(sessionId)) fail('UNAVAILABLE','Session has no registered live Agent.');
    if(!workspace(workspaceId).sessionIds.includes(sessionId)) fail('STALE','Session workspace changed.');
    const binding=Object.freeze({workspaceId,sessionId,agent:result.agent,workspacePath:w.path});
    bindings.add(binding);
    return binding;
  }
  function checkBinding(binding) {
    if(!bindings.has(binding))fail('FORBIDDEN','Unrecognized session binding.');
    if(lifetime.signal.aborted)fail('UNAVAILABLE','Runtime disposed.');
    const w=workspace(binding.workspaceId);
    if(get('agents')?.get(binding.sessionId)!==binding.agent || !w.sessionIds.includes(binding.sessionId) || w.path!==binding.workspacePath)fail('STALE','Session binding is stale.');
    return binding;
  }
  function startJob(binding,spec) {
    checkBinding(binding);
    if(!get('jobs')?.start)fail('UNAVAILABLE','Native jobs unavailable.');
    // The native registry enforces a real owner-scoped controller. Never attach a dummy one.
    return get('jobs').start({...spec,owner:binding.sessionId});
  }
  function jobService(binding,method) {
    // Cleanup keeps the original opaque token, even after workspace membership changes.
    if(!bindings.has(binding))fail('FORBIDDEN','Unrecognized session binding.');
    if(typeof get('jobs')?.[method]!=='function')fail('UNAVAILABLE','Native job lifecycle unavailable.');
    return get('jobs');
  }
  function killJob(binding,id,reason='SpecGap cancellation') {return jobService(binding,'kill').kill(id,binding.sessionId,reason);}
  async function waitJob(binding,id) {
    const result=await jobService(binding,'wait').wait(id,5000,binding.sessionId);
    if(!['completed','killed','failed'].includes(result.status))fail('ENVIRONMENT','Native job cleanup has not settled.');
    return result;
  }
  async function modelCatalog() {
    if(!get('sessionController')?.modelCatalog) fail('UNAVAILABLE','Model catalog unavailable.');
    return get('sessionController').modelCatalog();
  }
  async function prepareModel(binding,route,budget,inputBytes,signal) {
    checkBinding(binding);checkSignal(signal);
    const llm=get('llm');if(typeof llm?.prepareCall!=='function')fail('UNAVAILABLE','Native prepared model calls are unavailable.');
    const proposed={provider:route.provider,model:route.model,...(route.reasoningEffort===null?{}:{reasoningEffort:route.reasoningEffort})};
    const prepared=await llm.prepareCall(proposed,signal,(controls,model)=>{
      const cap=model.defaultMaxTokens,window=model.context?.contextWindow;
      if(cap!==undefined && (!Number.isSafeInteger(cap) || cap<1) || window!==undefined && (!Number.isSafeInteger(window) || window<1))fail('UNAVAILABLE','Native model limits are invalid.');
      const maxTokens=Math.min(budget.outputTokens,cap ?? budget.outputTokens);
      // No tokenizer is exposed by this seam. Refuse conservatively using UTF-8 bytes
      // as input-token allowance; this is not an exact provider billing estimate.
      if(window!==undefined && inputBytes+maxTokens>window)fail('INVALID_INPUT','Frozen request exceeds the advertised model context allowance.');
      return {...controls,maxTokens};
    });
    checkSignal(signal);checkBinding(binding);
    return {config:prepared.config,context:prepared.context,stream(options){checkSignal(options.signal);checkBinding(binding);return prepared.stream(options);}};
  }
  async function environment(signal,workspacePaths) {
    const [major,minor]=process.versions.node.split('.').map(Number);
    const node={available:major>24 || (major===24 && minor>=9),version:process.versions.node};
    const unavailable={available:false,version:null};
    let search;
    try {search=await trustedSearch(workspacePaths);} catch {checkSignal(signal);return {node,git:unavailable,python:unavailable};}
    const {env}=search;
    const run=async(command,args,minimum)=>{
      try {
        const executable=await search.find(command);
        if(!executable)return unavailable;
        checkSignal(signal);
        // Absolute file + its validated non-project directory: no OS cwd/PATH lookup.
        const {stdout,stderr}=await exec(executable,args,{cwd:path.dirname(executable),env,shell:false,signal,timeout:5000,maxBuffer:16384,windowsHide:true});
        const version=(stdout+stderr).trim();
        const match=version.match(/(\d+)\.(\d+)\.(\d+)/);
        const available=!!match && (+match[1]>minimum[0] || (+match[1]===minimum[0] && +match[2]>=minimum[1]));
        return {available,version:version.slice(0,160)};
      } catch {checkSignal(signal);return {available:false,version:null};}
    };
    let python=await run('python',['--version'],[3,11]);
    if(!python.available && process.platform==='win32') python=await run('py',['-3','--version'],[3,11]);
    return {node,git:await run('git',['--version'],[2,31]),python};
  }
  return {
    workspace,resolveInside,dataRoot,modelCatalog,prepareModel,bindSession,checkBinding,startJob,killJob,waitJob,
    bridgeEnvironment(signal){return resolveBridgeEnvironment({signal:signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal,workspacePaths:(get('workspaceRegistry')?.list?.() ?? []).map(w=>w.path)});},
    async bootstrap(payload,authority) {
      const signal=authority.signal?AbortSignal.any([authority.signal,lifetime.signal]):lifetime.signal;
      checkSignal(signal);
      const required={workspaceRegistry:['get','list'],sessionController:['resolveAgent','modelCatalog'],agents:['get'],jobs:['start']};
      const diagnostics=Object.entries(required).map(([name,methods])=>({capability:name,available:methods.every(method=>typeof get(name)?.[method]==='function')}));
      diagnostics.push({capability:'profileContext',available:!!dataRoot});
      if(!dataRoot) diagnostics.push({capability:'dataRoot',available:false});
      const registry=get('workspaceRegistry');
      const registeredWorkspaces=typeof registry?.list==='function'?(registry.list() ?? []):[];
      const agents=get('agents');
      const workspaces=registeredWorkspaces.map(w=>({id:w.id,title:w.title,sessionIds:[...w.sessionIds],liveSessionIds:typeof agents?.get==='function'?w.sessionIds.filter(id=>!!agents.get(id)):[]}));
      if(payload.workspaceId) {
        const w=workspace(payload.workspaceId);
        if(payload.sessionId && !w.sessionIds.includes(payload.sessionId)) fail('FORBIDDEN','Session is not a member of this workspace.');
        if(dataRoot && inside(await realpath(w.path),await canonicalProspective(dataRoot))) fail('ENVIRONMENT','Plugin data root must be outside the audited workspace.');
      }
      const env=await environment(signal,registeredWorkspaces.map(w=>w.path));
      // Explicit catalog/preview actions may resolve configured routes; bootstrap never does.
      diagnostics.push({capability:'modelDispatch',available:!!dataRoot && typeof get('llm')?.prepareCall==='function' && diagnostics.every(d=>d.available) && ['kill','wait'].every(method=>typeof get('jobs')?.[method]==='function')});
      return {version:1,ready:diagnostics.filter(d=>d.capability!=='modelDispatch').every(d=>d.available)&&Object.values(env).every(v=>v.available),diagnostics,environment:env,workspaces,models:null,limits:LIMITS,implemented:['bootstrap','refs','runs','run','material','models','report','prepare','demo','confirmAnalysis','analyze','cancel','importReview','respond','decide','verify'],auditLocation:'plugin-private per-attempt request record; not the native Session log',dataRootAvailable:!!dataRoot};
    },
    dispose(){lifetime.abort();},
  };
}
