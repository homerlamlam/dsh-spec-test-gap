import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRuntime} from '../src/host/runtime.mjs';

export async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'specgap-service 中文-'));
  t.after(async()=>{assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith('specgap-service 中文-'));await rm(root,{recursive:true,force:true});});
  const workspace=path.join(root,'workspace'),other=path.join(root,'other'),profile=path.join(root,'profile');
  await Promise.all([workspace,other,profile].map(p=>mkdir(p)));
  const workspaces=new Map([['w',{id:'w',path:workspace,sessionIds:['s']}],['other',{id:'other',path:other,sessionIds:['other-s']}]]);
  const agent={id:'s'},agents=new Map([['s',agent]]);
  const ctx={profileContext:{dir:profile},workspaceRegistry:{get:id=>workspaces.get(id),list:()=>[...workspaces.values()]},agents:{get:id=>agents.get(id)},sessionController:{resolveAgent:async id=>({agent:agents.get(id)})}};
  const runtime=createRuntime(ctx);
  t.after(()=>runtime.dispose());
  return {root,workspace,other,profile,ctx,runtime,workspaces,agents,authority:{isOwner:true}};
}
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export const prepareInput=(key='one')=>({kind:'prepare',idempotencyKey:key,requestHash:'a'.repeat(64),repoLabel:'repo'});
export const code=expected=>error=>error?.code===expected;
