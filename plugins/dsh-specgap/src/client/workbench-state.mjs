// Bounded, in-memory navigation only. Never store review content, requests, or consent here.
const selections=new Map();
const tabs=new Set(['findings','requirements','changes']);
const key=view=>JSON.stringify([view.workspaceId,view.runId]);
export function reviewSelection(view){return {...(selections.get(key(view))||{})};}
export function rememberReviewSelection(view,patch){
  const id=key(view),old=selections.get(id)||{},next={...old};
  if(typeof patch.findingId==='string')next.findingId=patch.findingId;
  if(tabs.has(patch.tab))next.tab=patch.tab;
  selections.delete(id);selections.set(id,next);
  while(selections.size>32)selections.delete(selections.keys().next().value);
}
export function priorityFindings(findings=[]){
  const rank={critical:4,high:3,medium:2,low:1};
  return [...findings].sort((a,b)=>(rank[b.severity]||0)-(rank[a.severity]||0));
}
export function readableDate(value,locale){
  const date=new Date(value);
  return Number.isNaN(date.getTime())?String(value||'—'):new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(date);
}
