import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequest,LIMITS,ACTION_BODY_BYTES} from '../src/shared/contract.mjs';
const host=await import('../src/host/index.mjs');
const runId='run_'+'a'.repeat(32);
function handler(service,report=false){assert.equal(typeof host.createFetchHandler,'function','admitted transport handler must exist');return host.createFetchHandler(service,{report});}
const request=body=>new Request('http://localhost/api/specgap/v1/action',{method:'POST',headers:{'content-type':'application/json'},body});

test('requirements and imported review have independent UTF-8 byte limits, not a bootstrap-sized cap',async()=>{
  let calls=0;const fetch=handler({dispatch:async()=>{calls++;return {accepted:true};}});
  const review={note:'中'.repeat(10000)};
  assert.equal((await fetch(request(JSON.stringify({operation:'importReview',payload:{workspaceId:'w',runId,idempotencyKey:'large',review}})))).status,200);
  assert.equal(calls,1);
  for(const [operation,payload] of [
    ['prepare',{workspaceId:'w',repoPath:'.',idempotencyKey:'p',requirementsText:'中'.repeat(Math.floor(LIMITS.requirementsBytes/3)+1)}],
    ['importReview',{workspaceId:'w',runId,idempotencyKey:'i',review:{note:'x'.repeat(LIMITS.reviewOutputBytes)}}],
  ])assert.throws(()=>validateRequest({operation,payload}),e=>['INVALID_INPUT','INVALID_REVIEW'].includes(e.code));
});
test('human transport accepts maximum UTF-8 manual evidence and escaped text but refuses excess before dispatch',async()=>{
  let calls=0;const fetch=handler({dispatch:async()=>{calls++;return {accepted:true};}});
  const common={workspaceId:'w',runId,idempotencyKey:'manual',finding:'F-1',actor:'qa',attestLocal:true,expectedSequence:0};
  const evidenceText='界'.repeat(21845)+'a';
  assert.equal((await fetch(request(JSON.stringify({operation:'verify',payload:{...common,result:'failed',note:'manual',evidenceText}})))).status,200);
  assert.equal((await fetch(request(JSON.stringify({operation:'respond',payload:{...common,text:'界'.repeat(12000)}})))).status,200);
  assert.equal((await fetch(request(JSON.stringify({operation:'decide',payload:{...common,outcome:'confirm_defect',reason:'\n'.repeat(11999)+'x'}})))).status,200);
  assert.equal(calls,3);
  assert.equal((await fetch(request(JSON.stringify({operation:'verify',payload:{...common,result:'failed',note:'manual',evidenceText:evidenceText+'a'}})))).status,400);
  assert.equal(calls,3);
});
test('oversize body, duplicate keys, malformed UTF-8 and unknown fields never dispatch',async()=>{
  let calls=0;const fetch=handler({dispatch:async()=>{calls++;}});
  for(const body of [JSON.stringify({operation:'bootstrap',payload:{},authority:{isOwner:true}}),'{"operation":"bootstrap","operation":"demo","payload":{}}',Buffer.from([0xff]),' '.repeat(ACTION_BODY_BYTES+1)])assert.equal((await fetch(request(body))).status,400);
  assert.equal(calls,0);
});
test('report attachment uses only opaque run ID and never a browser-selected filesystem destination',async()=>{
  let received;const fetch=handler({dispatch:async(...args)=>{received=args;return {markdown:'# 中文 report\n',filename:'../../evil\r\nSet-Cookie: bad'};}},true);
  const response=await fetch(new Request(`http://localhost/api/specgap/v1/report?workspaceId=w&runId=${runId}`));
  assert.equal(response.status,200);assert.equal(await response.text(),'# 中文 report\n');
  assert.equal(response.headers.get('content-disposition'),`attachment; filename="specgap-${runId}.md"`);
  assert.equal(response.headers.get('content-type'),'text/markdown; charset=utf-8');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(received[0],'report');assert.deepEqual(received[1],{workspaceId:'w',runId});assert.equal(received[2].isOwner,true);
  for(const query of [`workspaceId=w&runId=${runId}&path=C:/outside`,`workspaceId=w&workspaceId=other&runId=${runId}`])assert.equal((await fetch(new Request('http://localhost/api/specgap/v1/report?'+query))).status,400);
});
