import assert from 'node:assert/strict';
import {lstat,realpath,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
// Ownership is local to this builder process, never inferred from package metadata.
const owned=new Map();
const inside=(base,target)=>{const relative=path.relative(base,target);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));};
const maybeStat=async target=>lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
async function canonicalDirectory(target){
  const parent=path.dirname(target);
  const canonicalParent=parent===target?target:await canonicalDirectory(parent);
  const stat=await maybeStat(target);
  assert.ok(!stat?.isSymbolicLink(),`refusing linked build directory: ${target}`);
  assert.ok(!stat || stat.isDirectory(),`build directory is not a directory: ${target}`);
  return stat?await realpath(target):path.join(canonicalParent,path.basename(target));
}
async function rejectLinks(target){
  const stat=await maybeStat(target);
  assert.ok(!stat?.isSymbolicLink(),`refusing linked build directory: ${target}`);
  if(stat?.isDirectory())for(const name of await readdir(target))await rejectLinks(path.join(target,name));
}
export async function prepareBuildRoot(selected,sourceRoot){
  const shared=selected===undefined;
  const root=await realpath(sourceRoot),checkout=await realpath(path.resolve(root,'../..'));
  const outRoot=await canonicalDirectory(path.resolve(shared?sourceRoot:selected));
  if(!shared){
    const staging=path.join(root,'build');
    assert.ok((inside(staging,outRoot) && outRoot!==staging) || (!inside(checkout,outRoot) && !inside(outRoot,checkout)),
      'isolated build must use a child of build/ or a directory outside the checkout');
    const stat=await maybeStat(outRoot),owner=owned.get(outRoot);
    const sameOwner=owner && stat && owner.dev===stat.dev && owner.ino===stat.ino;
    assert.ok(sameOwner || !stat || !(await readdir(outRoot)).length,`refusing unowned populated build directory: ${outRoot}`);
    // Even owned rebuilds must not follow links inserted since the initial build.
    await rejectLinks(outRoot);
  }
  // Complete all preflight checks before mkdir, rm, compilation or copying.
  for(const relative of ['dist','python/specgap'])await canonicalDirectory(path.join(outRoot,relative));
  await mkdir(outRoot,{recursive:true});
  if(!shared){const {dev,ino}=await lstat(outRoot);owned.set(outRoot,{dev,ino});}
  return outRoot;
}
