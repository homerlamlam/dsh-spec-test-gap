// Element-tree interactions using production components, not browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const built=await build({stdin:{contents:`export * from './src/client/Review.jsx';export {seed,rewind,render} from 'react';`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'source-fixture',setup(b){b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
let values=[],index=0;
export function seed(v=[]){values=[...v];index=0;}
export function rewind(){index=0;}
export function useState(initial){const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;const owner=values;return [owner[i],v=>{owner[i]=typeof v==='function'?v(owner[i]):v;}];}
export const useEffect=()=>{};
const createElement=(type,props,...children)=>({type,props:{...props,children}});
export default {createElement,Fragment:'fragment',useState,useEffect};
export function render(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(render);if(typeof node.type==='function'){const old=values,idx=index;seed();const result=render(node.type(node.props));values=old;index=idx;return result;}return {...node,props:{...node.props,children:node.props.children.map(render)}};}
`,loader:'js'}));}}]});
const ui=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const zh=JSON.parse(await readFile(new URL('../locale/zh-CN.json',import.meta.url),'utf8'));
const t=key=>{assert.ok(Object.hasOwn(zh,key),`missing locale: ${key}`);return zh[key];};
const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.props?.children)]:[];
const text=n=>Array.isArray(n)?n.map(text).join(''):n==null||typeof n==='boolean'?'':typeof n==='object'?text(n.props?.children):String(n);
const button=(tree,key)=>nodes(tree).find(n=>n.type==='button'&&text(n)===t(key));
const mount=(name,props,seeds=[])=>{ui.seed(seeds);return ()=>{ui.rewind();return ui.render(ui[name]({t,...props}));};};
const citation={side:'head',path:'src/取消.py',start_line:2,end_line:2,quote:'    return True'};
const bundle={snapshot_id:'frozen-1',repo:{head_sha:'a'.repeat(40),base_sha:'b'.repeat(40)},requirements:{path:'C:/项目/需求说明.md',sha256:'c'.repeat(64),text:'# 取消订单\r\n\r\n[REQ-1] 仅订单所有者可以取消。\r\n\r\n第二段说明。\r\n',clauses:[{id:'REQ-1',text:'[REQ-1] 仅订单所有者可以取消。',start_line:3,end_line:3}]},sources:[{side:'head',path:'src/取消.py',sha256:'d'.repeat(64),content:'def cancel():\r\n    return True\r\n\r\n# 保留的上下文\r\n',line_count:4},{side:'base',path:'src/取消.py',sha256:'e'.repeat(64),content:'def cancel():\n    return False\n',line_count:2}],changes:[],budgets:{},warnings:[],limitations:[]};
const finding={id:'F1',severity:'high',kind:'contradiction',title:'缺少所有者校验',description:'缺少权限判断。',requirement_ids:['REQ-1'],change_ids:[],evidence:[citation],question:'权限在哪里检查？',suggested_role:'qa',test_ideas:[]};
const view={workspaceId:'w',runId:'r',expectedSequence:0,bundle,review:{findings:[finding],requirements:[{id:'REQ-1',assessment:'partial',reason:'缺少校验。',evidence:[citation]}],changes:[]},status:{findings:{}},events:[]};

test('requirement association opens its recorded original path and highlights the clause',()=>{
 const before=JSON.stringify(bundle),draw=mount('Review',{state:{view}});
 let tree=draw();const link=nodes(tree).find(n=>n.type==='a'&&text(n).includes('查看冻结原文'));
 assert.ok(link,'requirement needs an original-source link');
 assert.ok(text(tree).includes('C:/项目/需求说明.md:3–3'));
 link.props.onClick({preventDefault(){},currentTarget:{focus(){}}});tree=draw();
 const viewer=nodes(tree).find(n=>n.props.id==='sg-frozen-source');assert.ok(viewer);
 assert.ok(text(viewer).includes('第二段说明。'));assert.ok(text(viewer).includes('c'.repeat(64)));
 const highlighted=nodes(viewer).filter(n=>n.props['data-cited']);assert.equal(highlighted.length,1);assert.ok(text(highlighted[0]).includes('[REQ-1]'));
 assert.equal(JSON.stringify(bundle),before);
});

test('evidence exposes frozen context and opens head rather than same-path base content',()=>{
 let selected;const tree=mount('Evidence',{bundle,citations:[citation],expanded:true,onOpen:s=>{selected=s;}})();
 assert.ok(text(tree).includes('# 保留的上下文'),'surrounding frozen code is inspectable');
 const link=nodes(tree).find(n=>n.type==='a'&&text(n).includes('查看冻结全文'));assert.ok(link);
 link.props.onClick({preventDefault(){}});
 assert.equal(selected.content,bundle.sources[0].content);assert.equal(selected.commit,'a'.repeat(40));
 assert.equal(selected.start_line,2);assert.equal(selected.end_line,2);
});

test('base evidence stays on base and unavailable or mismatched sources never invent a link',()=>{
 let selected;let tree=mount('Evidence',{bundle,citations:[{...citation,side:'base',quote:'    return False'}],onOpen:s=>{selected=s;}})();
 nodes(tree).find(n=>n.type==='a').props.onClick({preventDefault(){}});
 assert.equal(selected.content,bundle.sources[1].content);assert.equal(selected.commit,'b'.repeat(40));
 for(const c of [{...citation,path:'absent.py'},{...citation,start_line:0},{...citation,end_line:9},{...citation,quote:'other text'}]){
  tree=mount('Evidence',{bundle,citations:[c],onOpen(){}})();assert.equal(nodes(tree).some(n=>n.type==='a'),false);assert.ok(text(tree).includes('未保存可定位的完整来源'));assert.ok(text(tree).includes(c.quote));
 }
});

test('original viewer paginates long files and returns to cited lines without altering text',()=>{
 assert.equal(typeof ui.FrozenSourceView,'function');
 const content=Array.from({length:405},(_,i)=>`代码行 ${i+1}`).join('\r\n')+'\r\n';
 const source={kind:'source',side:'head',path:'长文件.py',content,sha256:'f'.repeat(64),commit:'a'.repeat(40),snapshotId:'frozen-1',start_line:205,end_line:206};
 const draw=mount('FrozenSourceView',{source,onClose(){}});let tree=draw();
 const lines=()=>nodes(tree).filter(n=>n.props.className==='sg-line');
 assert.equal(lines().length,200);assert.ok(text(lines()[0]).includes('代码行 201'));assert.equal(nodes(tree).filter(n=>n.props['data-cited']).length,2);
 button(tree,'sourceNext').props.onClick();tree=draw();assert.equal(lines().length,5);assert.equal(button(tree,'sourceNext').props.disabled,true);
 button(tree,'sourcePrevious').props.onClick();tree=draw();assert.equal(lines().length,200);
 button(tree,'sourcePrevious').props.onClick();tree=draw();assert.ok(text(lines()[0]).includes('代码行 1'));assert.equal(button(tree,'sourcePrevious').props.disabled,true);
 button(tree,'sourceLocate').props.onClick();tree=draw();assert.equal(nodes(tree).filter(n=>n.props['data-cited']).length,2);
 assert.equal(source.content,content);
});

test('context is bounded, original text is inert, and requirement-direction links also work',()=>{
 const content=Array.from({length:60},(_,i)=>i===29?'<img src=x onerror=alert(1)>':`line ${i+1}`).join('\n');
 const b={...bundle,sources:[{...bundle.sources[0],content}]};
 let tree=mount('Evidence',{bundle:b,citations:[{...citation,start_line:30,end_line:30,quote:'<img src=x onerror=alert(1)>'}],onOpen(){}})();
 const context=nodes(tree).find(n=>n.props.className==='sg-source-context');
 const lines=nodes(context).filter(n=>n.props.className==='sg-line');assert.equal(lines.length,21);assert.ok(text(lines[0]).includes('line 20'));assert.ok(text(lines.at(-1)).includes('line 40'));assert.equal(nodes(tree).some(n=>n.type==='img'||n.props.dangerouslySetInnerHTML),false);
 const draw=mount('Review',{state:{view}});tree=draw();nodes(tree).find(n=>n.props.id==='sg-tab-requirements').props.onClick();tree=draw();
 assert.ok(nodes(tree).some(n=>n.type==='a'&&text(n)==='查看冻结原文'));assert.ok(text(tree).includes('C:/项目/需求说明.md:3–3'));
});

test('change associations link to requirements, and closing the reader returns focus',()=>{
 const changed={...view,review:{...view.review,changes:[{id:'C1',assessment:'partial',reason:'需要确认。',requirement_ids:['REQ-1'],evidence:[]}]}};
 const draw=mount('Review',{state:{view:changed}});let tree=draw();nodes(tree).find(n=>n.props.id==='sg-tab-changes').props.onClick();tree=draw();
 const link=nodes(tree).find(n=>n.type==='a'&&text(n)==='查看冻结原文');assert.ok(link);let focused=false;
 link.props.onClick({preventDefault(){},currentTarget:{focus(){focused=true;}}});tree=draw();assert.ok(nodes(tree).some(n=>n.props.id==='sg-frozen-source'));
 button(tree,'sourceClose').props.onClick();tree=draw();assert.equal(nodes(tree).some(n=>n.props.id==='sg-frozen-source'),false);assert.equal(focused,true);
});

test('requirement excerpts preserve a final empty line inside an unclosed code fence',()=>{
 const b={...bundle,requirements:{...bundle.requirements,text:'```\n\n',clauses:[{id:'REQ-1',text:'```\n',start_line:1,end_line:2}]}};
 const tree=mount('Review',{state:{view:{...view,runId:'fenced-test',bundle:b}}})();
 assert.ok(nodes(tree).some(n=>n.type==='a'&&text(n)==='查看冻结原文'));
});
