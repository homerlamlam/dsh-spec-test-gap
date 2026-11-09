import {physicalLines} from './api.mjs';

export const SOURCE_PAGE_SIZE=200;
function located(source,reference,quote){
  if(typeof source?.content!=='string')return null;
  const lines=physicalLines(source.content),{start_line:start,end_line:end}=reference;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>lines.length)return null;
  if(typeof quote!=='string')return null;
  // Clauses are already joined physical lines; a final empty fenced line is significant.
  const excerpt=source.kind==='requirements'?quote:physicalLines(quote).join('\n');
  if(excerpt!==lines.slice(start-1,end).join('\n'))return null;
  return {...source,start_line:start,end_line:end};
}
export function requirementSource(bundle,id){
  const requirement=bundle?.requirements,clause=requirement?.clauses?.find(c=>c.id===id);
  if(!clause)return null;
  return located({kind:'requirements',path:requirement.path,content:requirement.text,sha256:requirement.sha256,snapshotId:bundle.snapshot_id},clause,clause.text);
}
export function evidenceSource(bundle,citation){
  if(!['head','base'].includes(citation.side))return null;
  const frozen=bundle?.sources?.find(s=>s.side===citation.side&&s.path===citation.path);
  if(!frozen)return null;
  return located({...frozen,kind:'source',commit:bundle.repo?.[`${citation.side}_sha`],snapshotId:bundle.snapshot_id},citation,citation.quote);
}
export function sourceWindow(source,{page,context=false}={}){
  const lines=physicalLines(source.content);
  const start=context?Math.max(1,source.start_line-10):Math.max(0,Math.min(Math.floor((lines.length-1)/SOURCE_PAGE_SIZE),page??Math.floor((source.start_line-1)/SOURCE_PAGE_SIZE)))*SOURCE_PAGE_SIZE+1;
  const end=Math.min(lines.length,start+SOURCE_PAGE_SIZE-1,context?source.end_line+10:Infinity);
  return {lines:lines.slice(start-1,end),start,end,total:lines.length};
}
