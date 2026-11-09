// Element-tree localization regressions, not a browser/DOM acceptance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {reportCopy} from '../src/client/report-copy.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=await build({stdin:{contents:`export {OriginalText,repositoryLabel} from './src/client/presentation.jsx';export {Review,Plain,Evidence} from './src/client/Review.jsx';export {Workbench} from './src/client/Workbench.jsx';export {Attempts} from './src/client/History.jsx';export {ModelReview} from './src/client/ModelReview.jsx';export {SafeMarkdown,JsonTree,ReportContent,ReportError} from './src/client/ReportPane.jsx';export {seed,render} from 'react';`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'chinese-fixture',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`let values=[],index=0;export function seed(v=[]){values=v;index=0;}export function useState(initial){const i=index++;return [i<values.length?values[i]:(typeof initial==='function'?initial():initial),()=>{}];}export const useEffect=()=>{};export const useRef=v=>({current:v});export const useSyncExternalStore=(s,g)=>g();const createElement=(type,props,...children)=>({type,props:{...props,children}});export default {createElement,Fragment:'fragment',useState,useEffect,useRef,useSyncExternalStore};export function render(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(render);if(typeof node.type==='function'){const old=values,idx=index;seed();const result=render(node.type(node.props));values=old;index=idx;return result;}return {...node,props:{...node.props,children:node.props.children.map(render)}};}`,loader:'js'}));}}]});
const ui=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const en={...JSON.parse(await readFile(new URL('../locale/en-US.json',import.meta.url),'utf8')),...reportCopy.en};
const zh={...JSON.parse(await readFile(new URL('../locale/zh-CN.json',import.meta.url),'utf8')),...reportCopy.zh};
const translate=copy=>key=>{assert.ok(Object.hasOwn(copy,key),`missing locale key: ${key}`);return copy[key];};
const t=translate(zh),english=translate(en);
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.props?.children)]:[];
const text=n=>Array.isArray(n)?n.map(text).join(''):n==null||typeof n==='boolean'?'':typeof n==='object'?text(n.props?.children):String(n);
const prose=n=>Array.isArray(n)?n.map(prose).join(''):n==null||typeof n==='boolean'?'':typeof n==='object'?n.type==='code'?'':prose(n.props?.children):String(n);
const codeBlocks=tree=>nodes(tree).filter(n=>n.type==='pre'&&nodes(n).some(c=>c.type==='code')).map(text);
const render=(name,props,seeds=[])=>{ui.seed(seeds);return ui.render(ui[name]({t,...props}));};
const evidence={side:'head',path:'src/check.py',start_line:8,end_line:9,quote:'if allowed:\r\n    return True\r'};
const finding={id:'F1',kind:'contradiction',severity:'high',title:'Missing owner check',description:'An unrelated user can cancel.',question:'Where is the ownership check?',suggested_role:'qa',test_ideas:['Reject cancellation by another user.'],requirement_ids:['R1'],change_ids:['C1'],evidence:[evidence]};
const view={workspaceId:'w',runId:'r',repoLabel:'sample',expectedSequence:3,bundle:{snapshot_id:'snapshot',repo:{head_sha:'abc',base_sha:'def'},requirements:{text:'Only owners can cancel.',clauses:[{id:'R1',text:'Only owners can cancel.'}]},changes:[{id:'C1',status:'M',old_path:'a.py',new_path:'a.py'}],budgets:{max_files:100},limitations:['Context budget omitted: src/extra.py','Unknown limitation from an imported review.'],warnings:['Static context only: no audited application or tests were executed.']},status:{review_state:'ready_for_review',stale:false,findings:{F1:{assessment:'contradiction',intent:'unconfirmed',disposition:'undecided',verification:'unverified'}}},policy:{actors:{Alex:['qa']}},review:{findings:[finding],requirements:[{id:'R1',assessment:'contradicted',reason:'The guard is absent.',evidence:[evidence]}],changes:[{id:'C1',assessment:'behavior_changed',summary:'Allows unrelated users.',requirement_ids:['R1'],evidence:[evidence]}]},events:[{sequence:1,kind:'response',finding_id:'F1',actor:'Alex',created_at:'2026-11-08T00:00:00Z',text:'Checking the guard now.'}],attempts:[]};
const state={selection:{workspaceId:'w',sessionId:'s',runId:'r'},view,busy:{},mutation:null,foreignPending:false};
const client={getSnapshot:()=>state,query(){},mutate(){},invalidateConsent(){}};

test('raw payloads and physical evidence use explicit pre/code boundaries without rewriting bytes',()=>{
 const raw='English system prompt\r\n原始内容 <script>\r';
 const tree=render('Plain',{value:raw});assert.deepEqual(codeBlocks(tree),[raw]);
 const quote=render('Evidence',{citations:[evidence],expanded:true});assert.equal(codeBlocks(quote).length,1);assert.ok(codeBlocks(quote)[0].includes('if allowed:'));assert.equal(prose(quote).includes('return True'),false);
 const preview={request:{system:raw,messages:[{role:'user',content:raw}]},previewHash:'hash',expiresAt:'2099-01-01T00:00:00Z',bytes:123};
 const model=render('ModelReview',{client,state:{...state,view:{...view,review:null},preview},enabled:true});assert.ok(codeBlocks(model).includes(JSON.stringify(preview,null,2)));assert.equal(nodes(model).find(n=>n.type==='button'&&text(n)===zh.confirmSend).props.disabled,true);
});
test('Chinese review keeps original English narratives only in labeled code blocks and translates fixed limitations',()=>{
 const before=JSON.stringify(view);
 for(const tab of ['findings','requirements','changes']){
  const tree=render('Review',{client,state},['','','F1',tab,'']);
  assert.ok(prose(tree).includes('仅有静态上下文，未执行被审应用或测试。'));
  assert.ok(prose(tree).includes('上下文预算不足，已省略'));
  assert.ok(codeBlocks(tree).includes('Unknown limitation from an imported review.'));
  for(const original of [finding.title,finding.description,finding.question,...finding.test_ideas,'Only owners can cancel.','Checking the guard now.','The guard is absent.','Allows unrelated users.'])if(text(tree).includes(original)){assert.equal(prose(tree).includes(original),false,original);assert.ok(codeBlocks(tree).some(block=>block.includes(original)),original);}
  assert.ok(prose(tree).includes('原文（未翻译）'));
 }
 assert.equal(JSON.stringify(view),before);
 const native=render('Review',{client,state:{...state,view:{...view,review:{...view.review,findings:[{...finding,title:'缺少归属检查',description:'其他用户能够取消。'}]}}}});
 assert.ok(prose(native).includes('缺少归属检查'));assert.ok(prose(native).includes('其他用户能够取消。'));
 const originalEnglish=render('Review',{t:english,client,state});assert.ok(prose(originalEnglish).includes(finding.description));
});
test('attempt errors and environment capabilities have Chinese explanations, not raw enum prose',()=>{
 const attempts=render('Attempts',{client,state:{...state,view:{...view,attempts:[{attemptId:'a',phase:'failed',error:{code:'INVALID_REVIEW',message:'Invalid output from provider'}}]}}});
 assert.ok(prose(attempts).includes(zh.error_INVALID_REVIEW));assert.equal(prose(attempts).includes('INVALID_REVIEW'),false);assert.ok(codeBlocks(attempts).some(value=>value.includes('Invalid output from provider')));
 const current={...state,bootstrap:{ready:true,dataRootAvailable:true,workspaces:[{id:'w',title:'工作区',liveSessionIds:['s']}],environment:{node:{available:true,version:'v24.9.0'},git:{available:true,version:'git version 2.49.0'},python:{available:true,version:'Python 3.13.0'}},diagnostics:[{capability:'workspaceRegistry',available:true},{capability:'modelDispatch',available:false}]},error:{code:'ENVIRONMENT',requestId:'req-1'}};
 const tree=render('Workbench',{},[{...client,getSnapshot:()=>current},'new']);
 assert.ok(prose(tree).includes('工作区注册'));assert.ok(prose(tree).includes('模型调用'));assert.equal(prose(tree).includes('workspaceRegistry'),false);assert.equal(prose(tree).includes('ENVIRONMENT'),false);
});
test('workbench heading follows the localized navigation label instead of a stale hardcoded brand',()=>{
 const label='dsh-spec-test-gap';
 const tree=render('Workbench',{t:key=>key==='panel'?label:t(key)},[client,'new']);
 assert.equal(text(nodes(tree).find(node=>node.type==='h1')),label);
});
test('Chinese report reader isolates legacy English but keeps native Chinese and English locale readable',()=>{
 const markdown='# Legacy review report\n\nThe owner check is missing.\n\n| Actor | Result |\n| --- | --- |\n| Alex | passed |\n\n```py\nreturn True\n```';
 const tree=render('SafeMarkdown',{markdown});assert.equal(prose(tree).includes('Legacy review report'),false);assert.equal(prose(tree).includes('The owner check is missing.'),false);assert.ok(text(tree).includes('The owner check is missing.'));assert.ok(codeBlocks(tree).includes('return True'));assert.ok(prose(tree).includes('原文（未翻译）'));
 const native=render('SafeMarkdown',{markdown:'# 审查报告\n\n仅为审查辅助，不是发布批准。'});assert.ok(prose(native).includes('审查报告'));assert.ok(prose(native).includes('仅为审查辅助'));
 const original=render('SafeMarkdown',{t:english,markdown});assert.ok(prose(original).includes('Legacy review report'));
});
test('mixed physical-line originals and unknown error codes remain labeled data, with only the known demo name mapped',()=>{
 const original='Legacy English explanation.\r中文备注';const tree=render('OriginalText',{value:original});assert.deepEqual(codeBlocks(tree),[original]);assert.equal(prose(tree).includes('Legacy English'),false);
 const native=render('OriginalText',{value:'接口返回 API 结果。'});assert.equal(prose(native),'接口返回 API 结果。');
 assert.equal(ui.repositoryLabel(t,'SpecGap demo'),'需求对照示例');assert.equal(ui.repositoryLabel(english,'SpecGap demo'),'SpecGap demo');assert.equal(ui.repositoryLabel(t,'real-product-api'),'real-product-api');
 const error=render('ReportError',{error:{code:'REPORT_NEW_UNKNOWN',requestId:'request-1'}});assert.ok(prose(error).includes(zh.error_INTERNAL));assert.equal(prose(error).includes('REPORT_NEW_UNKNOWN'),false);assert.ok(codeBlocks(error).some(value=>value.includes('REPORT_NEW_UNKNOWN')));
});
test('report source and public JSON keys stay inside code while copy remains exact',async()=>{
 const markdown='# Legacy report\r\n\r\nUntouched original.\r\n';
 const snapshot={view,markdown,syncedAt:1234,busy:false,error:null};const reader={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
 const props={selection:{...state.selection,format:'markdown'},tab:{visible:true,signal:new AbortController().signal,navigation:{revision:1}},navigation:{}};
 const source=render('ReportContent',props,[reader,'markdown',true,'','']);assert.ok(codeBlocks(source).includes(markdown));
 const json=render('JsonTree',{value:{actor:'Alex',verification:'unverified'},label:zh.reportTree});for(const original of ['actor','Alex','verification','unverified'])assert.equal(prose(json).includes(original),false,original);
 const search=render('ReportContent',props,[reader,'json',false,'actor','']);assert.equal(prose(search).includes('$.events[0].actor'),false);assert.ok(codeBlocks(search).some(value=>value.includes('Alex')));
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let copied;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(value){copied=value;}}}});
 try{await nodes(source).find(n=>n.type==='button'&&text(n)===zh.reportCopy).props.onClick();assert.equal(copied,markdown);}finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;}
});
