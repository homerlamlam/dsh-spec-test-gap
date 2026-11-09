import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateRequest, validateBridgeRequest, OPERATIONS} from '../src/shared/contract.mjs';
import {createService} from '../src/host/service.mjs';

test('package publishes native Host, Client, locales, icon and bundle patch', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.exports['.'], './dist/host/index.mjs');
  assert.equal(pkg.exports['./client'], './dist/client.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.engines.dsh, '0.2.2-rc.1');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});
test('strict request validation rejects unknown operation, keys and forged authority', () => {
  for (const body of [null, [], {operation:'exec',payload:{}}, {operation:'bootstrap',payload:{},isOwner:true}, {operation:'bootstrap',payload:{isOwner:true}}, {operation:'bootstrap',payload:{workspaceId:42}}]) {
    assert.throws(() => validateRequest(body), {code:'INVALID_INPUT'});
  }
  assert.deepEqual(validateRequest({operation:'bootstrap',payload:{}}), {operation:'bootstrap',payload:{}});
});
test('selectors reject coercible arrays instead of silently treating them as opaque IDs',()=>{
  for(const [operation,payload] of [
    ['run',{workspaceId:'w',runId:['run_'+'a'.repeat(32)]}],
    ['cancel',{workspaceId:'w',sessionId:'s',runId:'run_'+'a'.repeat(32),attemptId:['attempt_'+'b'.repeat(32)]}],
  ])assert.throws(()=>validateRequest({operation,payload}),{code:'INVALID_INPUT'});
});
test('human schemas require exact nonnegative event tokens at UI and bridge boundaries',()=>{
  const ui={workspaceId:'w',runId:'run_'+'a'.repeat(32),idempotencyKey:'human'};
  const bridge={workspaceRoot:'C:/workspace',dataRoot:'C:/private',runPath:'C:/private/run'};
  for(const [operation,fields] of [['respond',{text:'Reply'}],['decide',{outcome:'confirm_defect',reason:'Reviewed'}],['verify',{result:'failed',note:'manual',evidenceText:'Observed'}]]) {
    const action={finding:'F-1',actor:'qa',attestLocal:true,expectedSequence:0,...fields};
    for(const [base,validate] of [[ui,payload=>validateRequest({operation,payload})],[bridge,payload=>validateBridgeRequest(operation,payload)]]) {
      assert.doesNotThrow(()=>validate({...base,...action}));
      for(const expectedSequence of [undefined,null,true,false,-1,0.5,'0',Number.MAX_SAFE_INTEGER+1]) {
        const payload={...base,...action,expectedSequence};if(expectedSequence===undefined)delete payload.expectedSequence;
        assert.throws(()=>validate(payload),{code:'INVALID_INPUT'});
      }
      for(const extra of [{role:'qa'},{isOwner:true},{command:'execute'},{expected_sequence:0}])assert.throws(()=>validate({...base,...action,...extra}),{code:'INVALID_INPUT'});
    }
    for(const key of ['actor','finding','attestLocal','idempotencyKey']) {
      const payload={...ui,...action};delete payload[key];assert.throws(()=>validateRequest({operation,payload}),{code:'INVALID_INPUT'});
    }
    for(const attestLocal of [false,1,'true',null])assert.throws(()=>validateRequest({operation,payload:{...ui,...action,attestLocal}}),{code:'FORBIDDEN'});
  }
});
test('human content uses frozen enums and bounded well formed UTF-8 text',()=>{
  const common={workspaceId:'w',runId:'run_'+'a'.repeat(32),idempotencyKey:'human',finding:'F-1',actor:'qa',attestLocal:true,expectedSequence:0};
  for(const [operation,fields] of [['respond',{text:' '}],['respond',{text:'\ud800'}],['decide',{outcome:'approve_release',reason:'No'}],['verify',{result:'approved',note:'manual',evidenceText:'No'}],['verify',{result:'failed',note:'manual',evidenceText:'界'.repeat(21846)}]])assert.throws(()=>validateRequest({operation,payload:{...common,...fields}}),{code:'INVALID_INPUT'});
});
test('owner gate precedes bootstrap and all later operations', async () => {
  let reads = 0;
  const service = createService({runtime:{bootstrap:async()=>{reads++; return {};}}});
  for (const operation of OPERATIONS) {
    await assert.rejects(service.dispatch(operation, {}, {isOwner:false}), {code:'FORBIDDEN'});
  }
  assert.equal(reads, 0);
  await service.dispose();
});
test('human routes require complete input and disposal still denies calls', async () => {
  const service = createService({runtime:{bootstrap:async()=>({ready:true})}});
  assert.deepEqual(await service.dispatch('bootstrap',{}, {isOwner:true}), {ready:true});
  for (const op of ['respond','decide','verify']) {
    await assert.rejects(service.dispatch(op,{}, {isOwner:true}), {code:'INVALID_INPUT'});
  }
  await service.dispose();
  await assert.rejects(service.dispatch('bootstrap',{}, {isOwner:true}), {code:'UNAVAILABLE'});
});
