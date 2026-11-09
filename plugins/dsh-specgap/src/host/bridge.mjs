import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stat,realpath} from 'node:fs/promises';
import {SpecGapError,fail,LIMITS,validateBridgeRequest,parseStrictJSON,validateBridgeResponse} from '../shared/contract.mjs';
import {resolveBridgeEnvironment} from './runtime.mjs';

const installedRoot=fileURLToPath(new URL('../../python/',import.meta.url));
const error=(code,message)=>new SpecGapError(code,message);
const allowedEnv=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PATHEXT','LANG','LC_ALL','LC_CTYPE']);
function cleanEnvironment(env){return Object.fromEntries(Object.entries(env).filter(([key])=>allowedEnv.has(key.toUpperCase())));}

async function killTree(child,environment) {
  if(!child.pid)return;
  if(process.platform!=='win32'){
    try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
    return;
  }
  // The real entrypoint owns a Windows kill-on-close Job before any Git call.
  // taskkill is an absolute trusted fallback for early startup/fixture processes.
  await new Promise((resolve,reject)=>{
    const killer=spawn(environment.taskkill,['/PID',String(child.pid),'/T','/F'],{cwd:path.dirname(environment.taskkill),env:cleanEnvironment(environment.env),shell:false,windowsHide:true,stdio:'ignore'});
    killer.once('error',reject);
    killer.once('close',code=>{
      if(code===0 || child.exitCode!==null || child.signalCode!==null)resolve();
      else reject(error('ENVIRONMENT','Unable to terminate bridge process tree.'));
    });
  });
}

/** Constructor options are trusted Host configuration, never browser payloads. */
export function createBridge({environment,pythonRoot=installedRoot,workspacePaths=[]}={}) {
  const lifetime=new AbortController(),active=new Set();
  async function callBridge(operation,payload,{signal,timeoutMs=LIMITS.bridgeTimeoutMs}={}) {
    if(lifetime.signal.aborted || signal?.aborted)fail('CANCELLED','Bridge operation cancelled.');
    if(!Number.isSafeInteger(timeoutMs) || timeoutMs<=0 || timeoutMs>2147483647)fail('INVALID_INPUT','Invalid bridge deadline.');
    validateBridgeRequest(operation,payload);
    let request;
    try{request=Buffer.from(JSON.stringify({version:1,operation,payload})+'\n','utf8');}catch{fail('INVALID_INPUT','Payload must be finite JSON.');}
    if(request.length>LIMITS.bridgeRequestBytes)fail('INVALID_INPUT','Bridge request exceeds input limit.');
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(),timeoutMs);
    const combined=AbortSignal.any([lifetime.signal,deadline.signal,...(signal?[signal]:[])]);
    const cancelled=()=>error(deadline.signal.aborted?'TIMEOUT':'CANCELLED',deadline.signal.aborted?'Bridge deadline exceeded.':'Bridge operation cancelled.');
    const execute=async()=>{
      let tools,root;
      try {
        tools=typeof environment==='function'?await environment(combined):environment || await resolveBridgeEnvironment({signal:combined,workspacePaths:[...workspacePaths,payload.workspaceRoot].filter(p=>typeof p==='string')});
        root=await realpath(pythonRoot);
        if(!path.isAbsolute(tools.python) || !path.isAbsolute(tools.git) || (process.platform==='win32' && !path.isAbsolute(tools.taskkill)) || !(await stat(path.join(root,'bridge.py'))).isFile())throw Error('Invalid installed environment');
      }catch{if(combined.aborted)throw cancelled();fail('ENVIRONMENT','Trusted bridge environment is unavailable.');}
      if(combined.aborted)throw cancelled();
      return new Promise((resolve,reject)=>{
        let child,forced=null,cleanup=null,stdoutBytes=0,stderrBytes=0;
        const chunks=[];
        const stop=reason=>{
          if(forced)return;
          forced=reason;
          cleanup=killTree(child,tools).catch(()=>{forced=error('ENVIRONMENT','Unable to terminate bridge process tree.');child.kill('SIGKILL');});
        };
        const onAbort=()=>stop(cancelled());
        try {
          child=spawn(tools.python,[...(tools.pythonArgs || []),'-I','-S','-B',path.join(root,'bridge.py'),tools.git],{
            cwd:root,env:cleanEnvironment(tools.env),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],
          });
        }catch{reject(error('ENVIRONMENT','Bridge process could not start.'));return;}
        combined.addEventListener('abort',onAbort,{once:true});
        child.once('error',()=>{forced ||= error('ENVIRONMENT','Bridge process could not start.');});
        child.stdin.on('error',()=>stop(error('ENVIRONMENT','Bridge input was not accepted.')));
        child.stdout.on('data',chunk=>{
          stdoutBytes+=chunk.length;
          if(stdoutBytes>LIMITS.bridgeStdoutBytes)stop(error('ENVIRONMENT','Bridge stdout exceeded limit.'));
          else if(!forced)chunks.push(chunk);
        });
        child.stderr.on('data',chunk=>{
          stderrBytes+=chunk.length;
          if(stderrBytes>LIMITS.bridgeStderrBytes)stop(error('ENVIRONMENT','Bridge stderr exceeded limit.'));
          // Never retain or expose diagnostics that could contain source/secrets.
        });
        child.once('exit',()=>{
          if(process.platform!=='win32' && !cleanup)cleanup=killTree(child,tools).catch(()=>{forced ||= error('ENVIRONMENT','Bridge process cleanup failed.');});
        });
        child.once('close',async code=>{
          combined.removeEventListener('abort',onAbort);
          if(cleanup)await cleanup;
          if(forced){reject(forced);return;}
          if(combined.aborted){reject(cancelled());return;}
          if(code!==0 || stderrBytes){reject(error('ENVIRONMENT','Bridge process failed.'));return;}
          try{
            const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,stdoutBytes));
            const response=validateBridgeResponse(parseStrictJSON(text));
            if(!response.ok)throw error(response.error.code,response.error.message);
            resolve(response.data);
          }catch(e){reject(e instanceof SpecGapError?e:error('ENVIRONMENT','Invalid bridge response.'));}
        });
        if(combined.aborted)onAbort();
        if(!forced)child.stdin.end(request);
      });
    };
    const pending=execute();active.add(pending);
    try{return await pending;}finally{clearTimeout(timer);active.delete(pending);}
  }
  async function dispose(){lifetime.abort();await Promise.allSettled([...active]);}
  return {callBridge,dispose};
}

const defaultBridge=createBridge();
export const callBridge=(operation,payload,options)=>defaultBridge.callBridge(operation,payload,options);
