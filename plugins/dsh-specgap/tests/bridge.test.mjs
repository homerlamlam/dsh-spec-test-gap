import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBridge} from '../src/host/bridge.mjs';
import {resolveBridgeEnvironment} from '../src/host/runtime.mjs';

import {testTools} from './test-tools.mjs';
const {pythonPath,gitPath}=testTools();
const shipped=fileURLToPath(new URL('../python/bridge.py',import.meta.url));
const environment=()=>resolveBridgeEnvironment({pythonPath,gitPath});
async function scratch(t){const root=await mkdtemp(path.join(tmpdir(),'specgap 中文 & bridge-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function fixture(t,source){const root=await scratch(t);await writeFile(path.join(root,'bridge.py'),source);const bridge=createBridge({environment:await environment(),pythonRoot:root});t.after(()=>bridge.dispose());return {root,bridge};}
const success='import sys\nsys.stdout.buffer.write(\'{"version":1,"ok":true,"data":{"literal":"中文 & $()"}}\\n\'.encode("utf-8"))\n';
async function pids(file){
  const end=Date.now()+10000;
  while(Date.now()<end){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;}await new Promise(r=>setTimeout(r,20));}
  throw Error('Worker never reached the subprocess gate');
}
function gone(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},`owned process ${pid} survived cancellation`);}

test('real isolated bridge handles Chinese/spaced paths and leaves shell metacharacters inert',async t=>{
  const root=await scratch(t),workspace=path.join(root,'workspace');await mkdir(workspace);
  const bridge=createBridge({environment:await environment()});t.after(()=>bridge.dispose());
  assert.equal((await bridge.callBridge('health',{})).isolated,true);
  const result=await bridge.callBridge('demo',{workspaceRoot:workspace,dataRoot:path.join(root,'owned'),demoPath:path.join(root,'owned','demo & echo BAD')});
  assert.equal(result.semantic_review,'scripted_fixture_not_model_evaluation');
  assert.equal(result.view.status.release_approval,false);
  assert.equal(result.view.review.findings.length,3);
  await assert.rejects(bridge.callBridge('health',{pythonPath:process.execPath}),{code:'INVALID_INPUT'});
  await assert.rejects(bridge.callBridge('health',{command:'echo BAD'}),{code:'INVALID_INPUT'});
});

test('hostile PYTHON startup variables and repository executable shadowing are ignored',async t=>{
  const root=await scratch(t),workspace=path.join(root,'workspace');await mkdir(workspace);
  const marker=path.join(root,'EXECUTED');
  await writeFile(path.join(workspace,'sitecustomize.py'),`open(${JSON.stringify(marker)},'w').write('bad')`);
  await copyFile(process.execPath,path.join(workspace,process.platform==='win32'?'git.exe':'git'));
  const safe=await resolveBridgeEnvironment({pythonPath,gitPath,workspacePaths:[workspace]});
  const bridge=createBridge({environment:{...safe,env:{...safe.env,PYTHONHOME:workspace,PYTHONPATH:workspace,PYTHONSTARTUP:path.join(workspace,'sitecustomize.py'),GIT_EXEC_PATH:workspace,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:workspace}}});
  t.after(()=>bridge.dispose());
  const result=await bridge.callBridge('demo',{workspaceRoot:workspace,dataRoot:path.join(root,'owned'),demoPath:path.join(root,'owned','demo')});
  assert.equal(result.view.review.findings.length,3);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  await assert.rejects(resolveBridgeEnvironment({pythonPath:path.join(workspace,process.platform==='win32'?'git.exe':'git'),gitPath,workspacePaths:[workspace]}),{code:'ENVIRONMENT'});
});

test('default bridge tool lookup excludes the operation workspace without extra configuration',async t=>{
  const root=await scratch(t),workspace=path.join(root,'workspace');await mkdir(workspace);
  for(const name of ['python','git'])await copyFile(process.execPath,path.join(workspace,name+(process.platform==='win32'?'.exe':'')));
  const previous=process.env.PATH;
  process.env.PATH=[workspace,path.dirname(pythonPath),path.dirname(gitPath),...(process.platform==='win32'?[path.join(process.env.SystemRoot,'System32')]:[])].join(path.delimiter);
  const bridge=createBridge();
  try {
    const result=await bridge.callBridge('demo',{workspaceRoot:workspace,dataRoot:path.join(root,'owned'),demoPath:path.join(root,'owned','demo')});
    assert.equal(result.semantic_review,'scripted_fixture_not_model_evaluation');
  } finally {process.env.PATH=previous;await bridge.dispose();}
});

test('transport requires exactly one strict UTF-8 response and successful process exit',async t=>{
  for(const [label,source] of [
    ['duplicate key','print(\'{"version":1,"ok":true,"ok":true,"data":{}}\')'],
    ['extra envelope',success+success],
    ['nonfinite','print(\'{"version":1,"ok":true,"data":1e999}\')'],
    ['invalid utf8','import sys\nsys.stdout.buffer.write(b"\\xff")'],
    ['wrong version','print(\'{"version":true,"ok":true,"data":{}}\')'],
    ['unknown field','print(\'{"version":1,"ok":true,"data":{},"debug":"private"}\')'],
    ['bad error','print(\'{"version":1,"ok":false,"error":{"code":"EXEC","message":"private"}}\')'],
    ['nonzero',success+'raise SystemExit(3)'],
  ])await t.test(label,async t=>{const {bridge}=await fixture(t,source);await assert.rejects(bridge.callBridge('health',{}),e=>e.code==='ENVIRONMENT' && !e.message.includes('private'));});
  const {bridge}=await fixture(t,success);
  assert.deepEqual(await bridge.callBridge('health',{}),{literal:'中文 & $()'});
});

test('running stdout and stderr caps stop the process before buffering unbounded output',async t=>{
  for(const stream of ['stdout','stderr'])await t.test(stream,async t=>{
    const {bridge}=await fixture(t,`import sys,time\nwhile True:\n sys.${stream}.buffer.write(b'x'*65536)\n sys.${stream}.flush()\n`);
    await assert.rejects(bridge.callBridge('health',{}, {timeoutMs:10000}),{code:'ENVIRONMENT'});
  });
});

test('pre-abort, invalid deadlines and oversize requests never launch the entrypoint',async t=>{
  const root=await scratch(t),marker=path.join(root,'STARTED');
  await writeFile(path.join(root,'bridge.py'),`open(${JSON.stringify(marker)},'w').write('bad')\n${success}`);
  const bridge=createBridge({environment:await environment(),pythonRoot:root});t.after(()=>bridge.dispose());
  const controller=new AbortController();controller.abort();
  await assert.rejects(bridge.callBridge('health',{}, {signal:controller.signal}),{code:'CANCELLED'});
  for(const timeoutMs of [0,-1,true,NaN,Infinity])await assert.rejects(bridge.callBridge('health',{}, {timeoutMs}),{code:'INVALID_INPUT'});
  await assert.rejects(bridge.callBridge('prepare',{workspaceRoot:root,dataRoot:path.join(root,'owned'),runPath:path.join(root,'owned/run'),repoPath:root,requirementsText:'x'.repeat(8*1024*1024)}),{code:'INVALID_INPUT'});
  await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('abort, timeout and disposal await owned parent and descendant termination',async t=>{
  for(const mode of ['abort','timeout','dispose'])await t.test(mode,async t=>{
    const root=await scratch(t),pidFile=path.join(root,'pids.json');
    await writeFile(path.join(root,'bridge.py'),`import subprocess,sys,os,json,time\nchild=subprocess.Popen([sys.executable,'-I','-S','-c','import time; time.sleep(300)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwith open(${JSON.stringify(pidFile)},'w') as f: json.dump([os.getpid(),child.pid],f)\ntime.sleep(300)\n`);
    const bridge=createBridge({environment:await environment(),pythonRoot:root});t.after(()=>bridge.dispose());
    const controller=new AbortController();
    const pending=assert.rejects(bridge.callBridge('health',{}, {signal:controller.signal,timeoutMs:mode==='timeout'?2000:20000}),{code:mode==='timeout'?'TIMEOUT':'CANCELLED'});
    const ids=await pids(pidFile);
    if(mode==='abort')controller.abort();
    if(mode==='dispose')await bridge.dispose();
    await pending;ids.forEach(gone);
    if(mode==='dispose')await assert.rejects(bridge.callBridge('health',{}),{code:'CANCELLED'});
  });
});

test('cancellation inside the real adapter Git boundary kills Git and cannot report success',async t=>{
  const root=await scratch(t),workspace=path.join(root,'workspace'),pidFile=path.join(root,'pids.json');await mkdir(workspace);
  // A trusted test-only gate holds a real Git process at stdin. The actual shipped
  // entrypoint installs its Windows job and runs dispatch before reaching the gate.
  const source=`import subprocess,sys,os,json,runpy\noriginal=subprocess.run\ndef gate(args,*a,**kw):\n if '-C' in args:\n  child=subprocess.Popen([${JSON.stringify(gitPath)},'hash-object','--stdin'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd=${JSON.stringify(root)})\n  with open(${JSON.stringify(pidFile)},'w') as f: json.dump([os.getpid(),child.pid],f)\n  child.wait()\n return original(args,*a,**kw)\nsubprocess.run=gate\nsys.argv=[${JSON.stringify(shipped)},${JSON.stringify(gitPath)}]\nrunpy.run_path(${JSON.stringify(shipped)},run_name='__main__')\n`;
  await writeFile(path.join(root,'bridge.py'),source);
  const bridge=createBridge({environment:await environment(),pythonRoot:root});t.after(()=>bridge.dispose());
  const controller=new AbortController();
  const pending=assert.rejects(bridge.callBridge('refs',{workspaceRoot:workspace,repoPath:workspace},{signal:controller.signal}),{code:'CANCELLED'});
  const ids=await pids(pidFile);controller.abort();await pending;ids.forEach(gone);
});
