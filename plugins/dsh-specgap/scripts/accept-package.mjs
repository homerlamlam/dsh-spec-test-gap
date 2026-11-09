// Sequential release gate, intentionally separate from the unit-test matrix.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,readFile,writeFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {version as esbuildVersion} from 'esbuild';
import {buildPackage} from './build.mjs';
import {checkPackage,files,sha256} from './check-package.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
assert.ok(args.length===2 && args[0]==='--output','Usage: node scripts/accept-package.mjs --output NEW_ABSOLUTE_DIRECTORY');
assert.ok(path.isAbsolute(args[1]),'output must be absolute');
const output=path.join(await realpath(path.dirname(path.resolve(args[1]))),path.basename(args[1]));
const checkout=await realpath(path.resolve(root,'../..'));
const inside=(base,target)=>{const relative=path.relative(base,target);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));};
assert.ok(!inside(checkout,output) && !inside(output,checkout),'final extraction/output must be outside the source checkout');
const tools={python:process.env.SPECGAP_TEST_PYTHON,git:process.env.SPECGAP_TEST_GIT,npm:process.env.SPECGAP_TEST_NPM};
for(const [name,value] of Object.entries(tools))assert.ok(value && path.isAbsolute(value) && (await stat(value)).isFile(),`Explicit absolute ${name} executable/npm-cli.js required; see verification guide`);
await mkdir(output); // Refuse reuse: never erase another run's evidence.
// Only compiler staging stays inside the checkout; extracted runtime proof does not.
const stageParent=path.join(root,'build');await mkdir(stageParent,{recursive:true});
assert.equal(await realpath(stageParent),path.resolve(stageParent),'build staging parent must not be linked');
const stage=await mkdtemp(path.join(stageParent,'sg-stage-'));
const extracted=path.join(output,'extracted'),outside=path.join(output,'outside');
await mkdir(outside);await mkdir(extracted);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('PYTHON') && !key.toUpperCase().startsWith('GIT_')));
env.PATH=[path.dirname(tools.git),path.dirname(tools.python),path.dirname(process.execPath),process.env.SystemRoot&&path.join(process.env.SystemRoot,'System32')].filter(Boolean).join(path.delimiter);
const commands=[];
async function run(label,executable,argv,{cwd=outside,input}={}){
  const result=spawnSync(executable,argv,{cwd,env,input,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,windowsHide:true});
  const record={label,executable,argv,cwd,exit:result.status,signal:result.signal,error:result.error?.message};commands.push(record);
  await writeFile(path.join(output,`${label}.log`),JSON.stringify(record)+'\n'+result.stdout+'\n'+result.stderr);
  assert.equal(result.status,0,`${label} failed; inspect ${path.join(output,`${label}.log`)}`);return result.stdout;
}
await buildPackage(stage);
await writeFile(path.join(output,'stage-check.json'),JSON.stringify(await checkPackage(stage),null,2));
const packed=JSON.parse(await run('pack',process.execPath,[tools.npm,'pack','--ignore-scripts','--offline','--json','--pack-destination',output],{cwd:stage}));
assert.equal(packed.length,1);const tarball=path.join(output,packed[0].filename);
await run('extract',tools.python,['-I','-S',path.join(root,'scripts/extract-package.py'),tarball,extracted]);
const installed=path.join(extracted,'package');
await run('extracted-check',process.execPath,[path.join(root,'scripts/check-package.mjs'),'--root',installed,'--source-root',path.resolve(root,'../../src/specgap')]);
const checked=await checkPackage(installed);
const inventory=await files(installed);
const allowed=/^(package\.json|LICENSE|icon\.svg|cordis\.patch\.yml|README\.md|docs\/dsh-plugin(?:\.zh-CN|-verification)?\.md|dist\/(client\.js|host\/(index|bridge)\.mjs)|locale\/(en|en-US|zh|zh-CN)\.json|python\/(bridge|operations)\.py|python\/specgap\/[A-Za-z_]+\.py)$/;
for(const file of inventory)assert.match(file,allowed,`unexpected package file: ${file}`);
for(const file of ['src','tests','node_modules','scripts','.env'])assert.ok(!inventory.some(f=>f===file || f.startsWith(file+'/')));
async function bridge(operation,payload){
  const result=JSON.parse(await run(operation,tools.python,['-I','-S',path.join(installed,'python/bridge.py'),tools.git],{input:JSON.stringify({version:1,operation,payload})}));
  assert.equal(result.ok,true,JSON.stringify(result));return result.data;
}
const health=await bridge('health',{});assert.equal(health.isolated,true);assert.equal(health.coreVersion,'0.1.0');
const workspace=path.join(outside,'workspace'),data=path.join(outside,'data');await mkdir(workspace);await mkdir(data);
const demo=await bridge('demo',{workspaceRoot:workspace,dataRoot:data,demoPath:path.join(data,'demo')});
assert.equal(demo.semantic_review,'scripted_fixture_not_model_evaluation');assert.equal(demo.release_approval,false);
const payload={workspaceRoot:workspace,dataRoot:data,runPath:demo.run};
const view=await bridge('read',payload);assert.equal(view.review.findings.length,3);
const chinese=/[\u4e00-\u9fff]/;
for(const text of [...view.review.requirements.map(r=>r.reason),...view.review.changes.map(c=>c.summary),...view.review.findings.flatMap(f=>[f.title,f.description,f.question,...f.test_ideas])])assert.match(text,chinese,'packaged demo prose must be Chinese');
const material=await bridge('material',payload);assert.match(material.system,/简体中文/);
const report=await bridge('report',payload);assert.equal(typeof report.markdown,'string');assert.match(report.markdown,/^# .*?[\u4e00-\u9fff]/);
await writeFile(path.join(output,'demo-report.md'),report.markdown);
const versions={node:process.version,esbuild:esbuildVersion,python:health.python,git:(await run('git-version',tools.git,['--version'])).trim(),npm:(await run('npm-version',process.execPath,[tools.npm,'--version'])).trim()};
const artifacts=[];for(const file of inventory)artifacts.push({file,sha256:sha256(await readFile(path.join(installed,file)))});
const manifest={...checked,versions,commands,stage,output,package:{file:tarball,sha256:sha256(await readFile(tarball)),bytes:(await stat(tarball)).size},artifacts,demo:{semantic_review:demo.semantic_review,release_approval:demo.release_approval,findings:view.review.findings.length,reportSha256:sha256(await readFile(path.join(output,'demo-report.md')))},limitations:['No installation or GUI acceptance','Scripted fixture, no real provider or semantic effectiveness measurement','Node/Python/Git supplied explicitly; no developer PYTHONPATH used']};
await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
