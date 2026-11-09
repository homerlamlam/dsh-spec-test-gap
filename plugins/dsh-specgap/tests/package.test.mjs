import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildPackage} from '../scripts/build.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.resolve(root,'../../src/specgap');
async function fixture(t,scratchRoot=tmpdir()){
  await mkdir(scratchRoot,{recursive:true});
  const scratch=await mkdtemp(path.join(scratchRoot,'sg-package-'));
  t.after(async()=>{assert.equal(path.dirname(scratch),scratchRoot);assert.ok(path.basename(scratch).startsWith('sg-package-'));await rm(scratch,{recursive:true,force:true});});
  const target=path.join(scratch,'package');await mkdir(target);
  for(const name of ['dist','python','locale','docs','README.md','package.json','LICENSE','icon.svg','cordis.patch.yml'])await cp(path.join(root,name),path.join(target,name),{recursive:true,filter:p=>!p.includes('__pycache__')});
  return target;
}
test('isolated build writes the selected distribution and removes stale generated modules',async t=>{
  // Keep native compiler output under the authorized checkout, not OS temp.
  // This is a unique isolated tree and never the shared dist/core directories.
  const parent=path.join(root,'build');await mkdir(parent,{recursive:true});
  const target=await mkdtemp(path.join(parent,'sg-package-'));
  t.after(async()=>{assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('sg-package-'));await rm(target,{recursive:true,force:true});});
  await buildPackage(target); // Establish ownership of this initially empty child.
  await writeFile(path.join(target,'dist/stale.mjs'),'stale');await writeFile(path.join(target,'python/specgap/stale.py'),'stale');
  await buildPackage(target); // Only this process can reuse its owned populated child.
  const reuse=spawnSync(process.execPath,[path.join(root,'scripts/build.mjs'),'--out-root',target],{cwd:root,encoding:'utf8',timeout:30000});
  assert.notEqual(reuse.status,0);assert.match(reuse.stderr,/unowned populated build directory/);
  await assert.rejects(access(path.join(target,'dist/stale.mjs')),{code:'ENOENT'});
  await assert.rejects(access(path.join(target,'python/specgap/stale.py')),{code:'ENOENT'});
  assert.equal(check(target).status,0,check(target).stderr);
});
test('valid copied distribution exposes only native entrypoints and identical core',async t=>{
  const result=check(await fixture(t));assert.equal(result.status,0,result.stderr);
  const evidence=JSON.parse(result.stdout);assert.equal(evidence.version,'0.2.0-alpha.4');assert.equal(evidence.core.length,14);
});
for(const [label,file,change,message] of [
  ['core byte drift','python/specgap/__init__.py',s=>s+'\n# drift\n',/core hash/],
  ['unsupported host','package.json',s=>s.replace('0.2.2-rc.1','0.0.0'),/proven DSH/],
  ['baked installation path','dist/host/bridge.mjs',s=>s+'\n// C:/developer/install/runtime\n',/installation path/]
])test(`package acceptance rejects ${label}`,async t=>{
  const target=await fixture(t),name=path.join(target,file);await writeFile(name,change(await readFile(name,'utf8')));
  const result=check(target);assert.notEqual(result.status,0);assert.match(result.stderr,message);
});
function check(target){return spawnSync(process.execPath,[path.join(root,'scripts/check-package.mjs'),'--root',target,'--source-root',source],{cwd:target,encoding:'utf8',timeout:30000});}
test('package acceptance rejects an extra stale core module in the selected distribution',async t=>{
  const target=await fixture(t);await writeFile(path.join(target,'python/specgap/stale.py'),'# stale module\n');
  const result=check(target);assert.notEqual(result.status,0,'checker silently accepted extra core file');assert.match(result.stderr,/core file set/);
});
test('package acceptance rejects bilingual key drift even when locale aliases match',async t=>{
  const target=await fixture(t),file=path.join(target,'locale/en-US.json'),locale=JSON.parse(await readFile(file,'utf8'));locale.missing_translation='test';
  for(const name of ['en-US','en'])await writeFile(path.join(target,`locale/${name}.json`),JSON.stringify(locale));
  const result=check(target);assert.notEqual(result.status,0,'checker silently accepted locale drift');assert.match(result.stderr,/locale key parity/);
});
