import React from 'react';
import en from '../../locale/en-US.json';
// Presentation only: never translate or rewrite a stored review, event or request.
export const chinese=t=>t?.('contentLocale')==='zh-CN';
export const originalText=(t,value)=>chinese(t)&&String(value??'').split(/\r\n|\r|\n/).some(line=>/[A-Za-z]/.test(line)&&!/[\p{Script=Han}]/u.test(line));
export function localizedKey(t,key,fallback='unknown'){return t(Object.hasOwn(en,key)?key:fallback);}
export function Plain({value}){return <pre className="sg-plain"><code>{typeof value==='string'?value:JSON.stringify(value,null,2)}</code></pre>;}
export function OriginalText({t,value,as:Tag='p',...props}){
  return originalText(t,value)?<><Tag {...props}>{t('originalText')}</Tag><Plain value={value}/></>:<Tag {...props}>{value}</Tag>;
}
const warnings={
  'Static context only: no audited application or tests were executed.':'limitationStatic',
  'Target integration/merge-result analysis was not performed.':'limitationMerge',
  'Secret filtering is best-effort: inspect all content before sharing with an agent/provider.':'limitationSecrets',
  'Requirement paragraphs are intake units, not automatically approved semantic clauses.':'limitationClauses',
  'Worktree status unknown: configured Git clean/process filters prevent safe status checking; uncommitted content is ignored.':'limitationWorktreeUnknown',
  'Uncommitted/untracked worktree changes ignored; only committed B/H objects were read.':'dirtyIgnored',
  'Repository location differs from frozen snapshot':'limitationRepoMoved',
  'Repository or tracked ref unavailable; freshness unknown':'limitationRepoUnavailable',
  'Requirements content changed since snapshot':'limitationRequirementsChanged',
  'Requirements unavailable; freshness unknown':'limitationRequirementsUnavailable',
  'head ref moved since snapshot':'limitationHeadMoved',
  'target ref moved since snapshot':'limitationTargetMoved',
  'base ref moved since snapshot':'limitationBaseMoved'
};
const prefixes={
  'Python syntax/AST parse failed: ':'limitationParse',
  'Python AST traversal limit; file-level fallback: ':'limitationTraversal',
  'Not followed (symlink/submodule/non-regular): ':'limitationNonRegular',
  'Potential secret path excluded: ':'limitationSecretPath',
  'Context budget omitted: ':'limitationBudget',
  'Binary source omitted: ':'limitationBinary',
  'Non-UTF-8 source omitted: ':'limitationEncoding',
  'Unsupported language; file-level fallback only: ':'limitationLanguage'
};
export function Limitation({t,value}){
  if(chinese(t)){
    if(Object.hasOwn(warnings,value))return t(warnings[value]);
    const prefix=Object.keys(prefixes).find(key=>typeof value==='string'&&value.startsWith(key));
    if(prefix)return <>{t(prefixes[prefix])}：<Plain value={value.slice(prefix.length)}/></>;
  }
  return <OriginalText t={t} value={value} as="span"/>;
}
export function repositoryLabel(t,value){return chinese(t)&&value==='SpecGap demo'?t('demoRepository'):value;}
export function errorLabel(t,error){const code=typeof error==='string'?error:error?.code;return localizedKey(t,'error_'+code,'error_INTERNAL');}
