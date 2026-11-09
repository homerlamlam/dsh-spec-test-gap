import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,readlink,lstat,symlink,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPackage} from '../scripts/build.mjs';
import {prepareBuildRoot} from '../scripts/build-paths.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const parent=path.join(root,'build');
async function fixture(t){
  await mkdir(parent,{recursive:true});
  const scratch=await mkdtemp(path.join(parent,'sg-paths-'));
  t.after(async()=>{assert.equal(path.dirname(scratch),parent);assert.ok(path.basename(scratch).startsWith('sg-paths-'));await rm(scratch,{recursive:true,force:true});});
  return scratch;
}
async function snapshot(directory){
  const entries=[];
  async function visit(name){
    const full=path.join(directory,name),stat=await lstat(full);
    if(stat.isSymbolicLink())entries.push([name,'link',await readlink(full)]);
    else if(stat.isDirectory()){entries.push([name,'directory']);for(const child of (await readdir(full)).sort())await visit(path.join(name,child));}
    else entries.push([name,'file',createHash('sha256').update(await readFile(full)).digest('hex')]);
  }
  await visit('');return entries;
}
async function populatedTarget(scratch){
  const target=path.join(scratch,'existing-plugin');
  await mkdir(path.join(target,'dist'),{recursive:true});
  await mkdir(path.join(target,'python'));
  await writeFile(path.join(target,'package.json'),JSON.stringify({name:'@specgap/dsh-plugin'}));
  await writeFile(path.join(target,'dist/sentinel.txt'),'must not delete or overwrite');
  const held=path.join(scratch,'held-core');await mkdir(held);await writeFile(path.join(held,'sentinel.py'),'# must remain unchanged');
  // Disposable tripwire: the old builder stops here AFTER deleting dist,
  // before esbuild can run. This never aliases real source/shared outputs.
  await symlink(held,path.join(target,'python/specgap'),'junction');
  return target;
}
test('custom build rejects an ancestor junction before any output mutation',async t=>{
  const scratch=await fixture(t),target=await populatedTarget(scratch),alias=path.join(scratch,'alias');
  await symlink(scratch,alias,'junction');
  const before=await snapshot(scratch);
  let error;try{await buildPackage(path.join(alias,path.basename(target)));}catch(caught){error=caught;}
  assert.deepEqual(await snapshot(scratch),before,'ancestor alias changed output before rejection');
  assert.match(error?.message??'',/linked build directory/);
});
test('custom build rejects populated matching-name output without mutation',async t=>{
  const scratch=await fixture(t),target=await populatedTarget(scratch),before=await snapshot(scratch);
  let error;try{await buildPackage(target);}catch(caught){error=caught;}
  assert.deepEqual(await snapshot(scratch),before,'package name was incorrectly treated as ownership');
  assert.match(error?.message??'',/unowned populated build directory/);
});
test('custom build rejects an ordinary populated matching-name tree without mutation',async t=>{
  const scratch=await fixture(t),target=path.join(scratch,'unowned');await mkdir(target);
  await writeFile(path.join(target,'package.json'),JSON.stringify({name:'@specgap/dsh-plugin'}));
  await writeFile(path.join(target,'sentinel.txt'),'not owned');const before=await snapshot(scratch);
  await assert.rejects(buildPackage(target),/unowned populated build directory/);
  assert.deepEqual(await snapshot(scratch),before);
});
test('custom build rejects a nonexistent child through a linked ancestor without creating it',async t=>{
  const scratch=await fixture(t),alias=path.join(scratch,'alias');await symlink(scratch,alias,'junction');
  const before=await snapshot(scratch);
  await assert.rejects(buildPackage(path.join(alias,'missing','child')),/linked build directory/);
  assert.deepEqual(await snapshot(scratch),before);
});
test('owned custom build checks all linked descendants before deleting any generated tree',async t=>{
  const scratch=await fixture(t),target=path.join(scratch,'owned');
  await prepareBuildRoot(target,root);
  await mkdir(path.join(target,'dist'));await writeFile(path.join(target,'dist/sentinel.txt'),'keep');
  const held=path.join(scratch,'held');await mkdir(held);await writeFile(path.join(held,'sentinel.txt'),'also keep');
  await symlink(held,path.join(target,'docs'),'junction');const before=await snapshot(scratch);
  await assert.rejects(buildPackage(target),/linked build directory/);
  assert.deepEqual(await snapshot(scratch),before);
});
test('custom build does not retain ownership when its output directory is replaced',async t=>{
  const scratch=await fixture(t),target=path.join(scratch,'owned'),preserved=path.join(scratch,'preserved');
  await prepareBuildRoot(target,root);
  assert.equal(path.dirname(target),scratch);assert.equal(path.dirname(preserved),scratch);
  await rename(target,preserved);await mkdir(target);await writeFile(path.join(target,'sentinel.txt'),'replacement is not owned');
  const before=await snapshot(scratch);
  await assert.rejects(buildPackage(target),/unowned populated build directory/);
  assert.deepEqual(await snapshot(scratch),before);
});
test('preflight rejects an outside ancestor alias into a synthetic checkout without mutation',async t=>{
  const scratch=await fixture(t),checkout=path.join(scratch,'checkout'),sourceRoot=path.join(checkout,'plugins','plugin');
  await mkdir(path.join(sourceRoot,'dist'),{recursive:true});await writeFile(path.join(sourceRoot,'dist/sentinel.txt'),'shared fixture, not actual checkout');
  await writeFile(path.join(sourceRoot,'package.json'),JSON.stringify({name:'@specgap/dsh-plugin'}));
  const alias=path.join(scratch,'stage-alias');await symlink(path.join(checkout,'plugins'),alias,'junction');
  const before=await snapshot(scratch);
  await assert.rejects(prepareBuildRoot(path.join(alias,'plugin'),sourceRoot),/linked build directory/);
  assert.deepEqual(await snapshot(scratch),before);
});
test('preflight permits fresh, empty and same-process owned custom children',async t=>{
  const scratch=await fixture(t),fresh=path.join(scratch,'missing','fresh'),empty=path.join(scratch,'empty');await mkdir(empty);
  for(const target of [fresh,empty]){
    assert.equal(await prepareBuildRoot(target,root),target);
    await writeFile(path.join(target,'sentinel.txt'),'owned');
    assert.equal(await prepareBuildRoot(target,root),target);
    assert.equal(await readFile(path.join(target,'sentinel.txt'),'utf8'),'owned');
  }
});
test('preflight separates intentional shared mode from explicit source and staging-parent selections',async t=>{
  // Synthetic checkout only: never try destructive invalid selections against real source.
  const scratch=await fixture(t),checkout=path.join(scratch,'checkout'),sourceRoot=path.join(checkout,'plugins','plugin');
  await mkdir(path.join(sourceRoot,'build'),{recursive:true});const before=await snapshot(scratch);
  for(const target of [sourceRoot,checkout,scratch,path.join(sourceRoot,'build'),path.join(checkout,'src','missing')])
    await assert.rejects(prepareBuildRoot(target,sourceRoot),/isolated build must use/);
  assert.deepEqual(await snapshot(scratch),before);
  assert.equal(await prepareBuildRoot(undefined,sourceRoot),sourceRoot);
  assert.deepEqual(await snapshot(scratch),before);
});
