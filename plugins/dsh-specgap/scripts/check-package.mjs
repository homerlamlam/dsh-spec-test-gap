import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function files(root,prefix='') {
  const result=[];
  for(const e of await readdir(path.join(root,prefix),{withFileTypes:true})){
    assert.ok(!e.isSymbolicLink(),'distribution must not contain links');
    const relative=path.posix.join(prefix,e.name);
    if(e.isDirectory())result.push(...await files(root,relative));else result.push(relative);
  }
  return result.sort();
}
function keys(value,prefix='') {return Object.entries(value).flatMap(([k,v])=>v && typeof v==='object'?keys(v,`${prefix}${k}.`):[`${prefix}${k}`]).sort();}
export async function checkPackage(root=defaultRoot,sourceRoot=path.resolve(defaultRoot,'../../src/specgap')) {
  root=path.resolve(root);
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'@specgap/dsh-plugin');assert.equal(pkg.license,'MIT');
  assert.equal(pkg.engines.dsh,'0.2.2-rc.1','only the proven DSH version is supported');
  assert.equal(pkg.engines.node,'>=24.9.0');
  assert.equal(pkg.dependencies,undefined,'no runtime npm dependencies');
  assert.deepEqual(pkg.exports,{'.':'./dist/host/index.mjs','./client':'./dist/client.js','./locale/*.json':'./locale/*.json','./icon':'./icon.svg'},'native export map');
  assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
  assert.deepEqual(pkg.dsh.client,{platform:'web',immediately:true,inject:['@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-sidebar','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-sidebar-right','@deepseek-ai/dsh-client-ui-workspace']},'native client metadata');
  const targets=[...Object.values(pkg.exports),pkg.dsh.bundle.patch,'LICENSE','icon.svg','python/bridge.py','python/operations.py','dist/host/bridge.mjs','README.md','docs/dsh-plugin.md','docs/dsh-plugin.zh-CN.md','docs/dsh-plugin-verification.md'];
  for(const target of targets){
    assert.ok(!path.isAbsolute(target) && !target.split(/[\\/]/).includes('..'),'exports must stay package-relative');
    if(target.includes('*')){assert.equal(target,'./locale/*.json');continue;}
    assert.ok((await lstat(path.join(root,target))).isFile(),`missing regular file: ${target}`);
  }
  const locales={};
  for(const name of ['en-US','zh-CN','en','zh'])locales[name]=JSON.parse(await readFile(path.join(root,`locale/${name}.json`),'utf8'));
  assert.deepEqual(keys(locales['en-US']),keys(locales['zh-CN']),'locale key parity');
  assert.deepEqual(locales.en,locales['en-US']);assert.deepEqual(locales.zh,locales['zh-CN']);
  const license=await readFile(path.join(root,'LICENSE'));
  assert.deepEqual(license,await readFile(path.resolve(sourceRoot,'../../LICENSE')),'MIT license identity');
  assert.match(license.toString(),/MIT License/);assert.match(await readFile(path.join(root,'icon.svg'),'utf8'),/<svg\b/);
  const sourceFiles=(await files(sourceRoot)).filter(f=>f.endsWith('.py'));
  const coreFiles=await files(path.join(root,'python/specgap'));
  assert.deepEqual(coreFiles,sourceFiles,'core file set');
  const core=[];
  for(const file of sourceFiles){
    const sourceHash=sha256(await readFile(path.join(sourceRoot,file))),packagedHash=sha256(await readFile(path.join(root,'python/specgap',file)));
    assert.equal(packagedHash,sourceHash,`core hash: ${file}`);core.push({file,sourceHash,packagedHash});
  }
  for(const file of await files(path.join(root,'dist'))){
    const text=await readFile(path.join(root,'dist',file),'utf8');
    // The accepted Windows SystemRoot fallback is an OS path, not an installation path.
    const installationText=text.replaceAll('"C:\\\\Windows"','');
    assert.ok(!/[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/usr\/local\/|file:\/\/\//.test(installationText),`runtime absolute installation path: ${file}`);
  }
  let registration;
  vm.runInNewContext(await readFile(path.join(root,pkg.exports['./client']),'utf8'),{window:{__ModuleLoader__:{load:value=>{registration=value;}}}});
  assert.equal(registration.id,pkg.name);
  const imports=[];
  const client=registration.factory(name=>{imports.push(name);if(name==='react')return {createElement(){}};throw Error(name);});
  assert.deepEqual([...new Set(imports)],['react']);assert.equal(typeof client.apply,'function');assert.ok(client.inject.includes('slots'));
  const host=await import(pathToFileURL(path.join(root,pkg.exports['.'])));assert.equal(typeof host.apply,'function');
  const bridge=await import(pathToFileURL(path.join(root,'dist/host/bridge.mjs')));
  assert.equal(typeof bridge.callBridge,'function');assert.equal(typeof bridge.createBridge,'function');
  return {name:pkg.name,version:pkg.version,engines:pkg.engines,core};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let root=defaultRoot,sourceRoot=path.resolve(defaultRoot,'../../src/specgap');
  while(args.length){const key=args.shift(),value=args.shift();assert.ok(value,'option needs a path');if(key==='--root')root=value;else if(key==='--source-root')sourceRoot=value;else throw Error(`Unknown option: ${key}`);}
  console.log(JSON.stringify(await checkPackage(root,sourceRoot),null,2));
}
