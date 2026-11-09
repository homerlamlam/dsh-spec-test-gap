import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readdir,copyFile,rm} from 'node:fs/promises';
import {prepareBuildRoot} from './build-paths.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildPackage(selected) {
  const outRoot=await prepareBuildRoot(selected,root);
  // Preflight has validated every cleanup path; only these generated trees are removed.
  for(const relative of ['dist','python/specgap'])await rm(path.join(outRoot,relative),{recursive:true,force:true});
  await mkdir(path.join(outRoot,'dist'),{recursive:true});
  await build({absWorkingDir:root,entryPoints:['src/host/index.mjs','src/host/bridge.mjs'],outdir:path.join(outRoot,'dist/host'),outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
  await build({absWorkingDir:root,entryPoints:['src/client/index.jsx'],outfile:path.join(outRoot,'dist/client.js'),bundle:true,platform:'browser',target:'es2022',format:'cjs',external:['react'],loader:{'.css':'text'},banner:{js:'window.__ModuleLoader__.load({id:"dsh-spec-test-gap",factory(require){const module={exports:{}};const exports=module.exports;'},footer:{js:'return module.exports;}});'}});
  async function copyPython(from,to){await mkdir(to,{recursive:true});for(const e of await readdir(from,{withFileTypes:true})){if(e.name==='__pycache__')continue;const src=path.join(from,e.name),dst=path.join(to,e.name);if(e.isDirectory())await copyPython(src,dst);else if(e.name.endsWith('.py'))await copyFile(src,dst);}}
  await copyPython(path.resolve(root,'../../src/specgap'),path.join(outRoot,'python/specgap'));
  await copyFile(path.resolve(root,'../../LICENSE'),path.join(outRoot,'LICENSE'));
  await mkdir(path.join(outRoot,'locale'),{recursive:true});
  if(outRoot!==path.resolve(root))for(const file of ['package.json','icon.svg','cordis.patch.yml','python/bridge.py','python/operations.py','locale/en-US.json','locale/zh-CN.json'])await copyFile(path.join(root,file),path.join(outRoot,file));
  for(const [alias,source] of [['en','en-US'],['zh','zh-CN']])await copyFile(path.join(root,`locale/${source}.json`),path.join(outRoot,`locale/${alias}.json`));
  await mkdir(path.join(outRoot,'docs'),{recursive:true});
  for(const name of ['dsh-plugin.md','dsh-plugin.zh-CN.md','dsh-plugin-verification.md'])await copyFile(path.resolve(root,'../../docs',name),path.join(outRoot,'docs',name));
  if(outRoot!==path.resolve(root))await copyFile(path.join(root,'README.md'),path.join(outRoot,'README.md'));
  console.log(`Built native Host + Client and exact MIT Python core in ${outRoot}`);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.ok(!args.length || (args.length===2 && args[0]==='--out-root'),'Usage: build.mjs [--out-root DIRECTORY]');
  await buildPackage(args[1]);
}
