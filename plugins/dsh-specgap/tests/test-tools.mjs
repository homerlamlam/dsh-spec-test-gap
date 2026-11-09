import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import path from 'node:path';
// Explicit test-only paths avoid silently selecting a developer's installation.
export function testTools(env=process.env) {
  for(const name of ['SPECGAP_TEST_PYTHON','SPECGAP_TEST_GIT']) {
    assert.ok(env[name] && path.isAbsolute(env[name]),`Set ${name} to an absolute installed executable path (see docs/dsh-plugin-verification.md).`);
    assert.ok(statSync(env[name]).isFile(),`${name} must name a regular file.`);
  }
  return {pythonPath:env.SPECGAP_TEST_PYTHON,gitPath:env.SPECGAP_TEST_GIT};
}
