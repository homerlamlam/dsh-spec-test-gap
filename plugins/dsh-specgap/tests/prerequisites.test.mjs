import test from 'node:test';
import assert from 'node:assert/strict';
import {testTools} from './test-tools.mjs';
test('test prerequisites fail clearly rather than use a developer machine default',()=>{
  assert.throws(()=>testTools({}),/SPECGAP_TEST_PYTHON.*absolute/);
  assert.throws(()=>testTools({SPECGAP_TEST_PYTHON:'python'}),/SPECGAP_TEST_PYTHON.*absolute/);
  assert.throws(()=>testTools({SPECGAP_TEST_PYTHON:process.execPath}),/SPECGAP_TEST_GIT.*absolute/);
});
test('test prerequisites preserve explicitly selected installed executables',()=>{
  assert.deepEqual(testTools({SPECGAP_TEST_PYTHON:process.execPath,SPECGAP_TEST_GIT:process.execPath}),{pythonPath:process.execPath,gitPath:process.execPath});
});
