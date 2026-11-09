import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// These regressions break if bootstrap delegates executable lookup to the Host
// cwd, accepts relative/empty PATH entries, or trusts a junction into a project.
// The fixtures are copies of the running, trusted Node binary (--version only).
test('Windows bootstrap never invokes same-named executables from Host/project cwd', {skip:process.platform!=='win32'}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'specgap-probe-'));
  const repo=path.join(root,'repo'), trusted=path.join(root,'tools'), alias=path.join(root,'alias');
  try {
    await mkdir(repo);await mkdir(trusted);
    for(const name of ['python.exe','py.exe','git.exe'])await copyFile(process.execPath,path.join(repo,name));
    for(const name of ['python.exe','git.exe'])await copyFile(process.execPath,path.join(trusted,name));
    await symlink(repo,alias,'junction');
    const source=`
      import childProcess from 'node:child_process';
      import {promisify} from 'node:util';
      import {syncBuiltinESMExports} from 'node:module';
      const original=childProcess.execFile, execute=promisify(original), calls=[];
      function traced(...args){return original(...args);}
      traced[promisify.custom]=(...args)=>{
        const [file,argv,options]=args;
        calls.push({file,argv,cwd:options.cwd,path:options.env?.PATH});
        return execute(...args); // Real execFile and real Windows resolution; no stubbed result.
      };
      childProcess.execFile=traced;syncBuiltinESMExports();
      const {createRuntime}=await import(${JSON.stringify(new URL('../src/host/runtime.mjs',import.meta.url).href)});
      const runtime=createRuntime({workspaceRegistry:{get(){},list:()=>[{id:'w',title:'test',path:${JSON.stringify(repo)},sessionIds:[]}]}});
      try {
        const result=await runtime.bootstrap({},{});
        console.log(JSON.stringify({environment:result.environment,calls}));
      } finally {runtime.dispose();}
    `;
    const baseEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PATH' && key.toUpperCase()!=='NODE_OPTIONS'));
    function probe(value) {
      const child=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:repo,env:{...baseEnv,PATH:value},encoding:'utf8',timeout:20000});
      assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
      return JSON.parse(child.stdout.trim());
    }
    for(const [label,value] of [['empty',''],['relative','.;bin;C:tools'],['project absolute',repo],['project junction',alias]]) {
      await t.test(`${label} PATH cannot cause project tool execution`,()=>{
        const result=probe(value);
        assert.deepEqual(result.calls,[],'unsafe or implicit search must not start any executable');
        assert.deepEqual(result.environment.python,{available:false,version:null});
        assert.deepEqual(result.environment.git,{available:false,version:null});
      });
    }
    await t.test('trusted absolute tools win over cwd and unsafe PATH entries',()=>{
      const result=probe(['','.',repo,alias,trusted].join(';'));
      assert.deepEqual(result.calls.map(call=>call.file),[path.join(trusted,'python.exe'),path.join(trusted,'git.exe')]);
      for(const call of result.calls) {
        assert.ok(path.isAbsolute(call.cwd));
        assert.notEqual(call.cwd,repo);
        assert.equal(call.path,trusted);
      }
      assert.deepEqual(result.environment.python,{available:true,version:process.version});
      assert.deepEqual(result.environment.git,{available:true,version:process.version});
    });
    await t.test('missing Python must not fall back to project-local py.exe',async()=>{
      await rm(path.join(repo,'python.exe')); // Only the fixture created above.
      const result=probe('');
      assert.deepEqual(result.calls,[]);
      assert.deepEqual(result.environment.python,{available:false,version:null});
    });
  } finally {await rm(root,{recursive:true,force:true});}
});
