import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertStandardGraph } from '../scripts/auth-build-policy.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9362-'));
  fs.mkdirSync(path.join(root, 'js', 'public'), { recursive:true });
  fs.mkdirSync(path.join(root, 'js', 'auth', 'server'), { recursive:true });
  fs.writeFileSync(path.join(root, 'js', 'auth', 'admin-app.js'), 'export const admin = true;\n');
  fs.writeFileSync(path.join(root, 'js', 'auth', 'server', 'router.js'), 'export const server = true;\n');
  fs.writeFileSync(path.join(root, 'js', 'public', 'safe.js'), 'export const safe = true;\n');
  return root;
}

for (const [name, target] of [
  ['admin alias', '../auth/admin-app.js'],
  ['server alias', '../auth/server/router.js'],
]) {
  test(`#9362 standard graph rejects ${name}`, (t) => {
    const root = fixture();
    t.after(() => fs.rmSync(root, { recursive:true, force:true }));
    const alias = path.join(root, 'js', 'public', `${name.replaceAll(' ', '-')}.js`);
    try {
      fs.symlinkSync(target, alias);
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('symlink creation unavailable on this Windows runner');
        return;
      }
      throw error;
    }
    const lexical = path.relative(root, alias).replaceAll(path.sep, '/');
    assert.throws(
      () => assertStandardGraph({ inputs:{ [lexical]:{} } }, 'standard', { repoRoot:root }),
      /leaks privileged implementation/,
    );
  });
}

test('#9362 normal regular public input remains accepted', (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  assert.doesNotThrow(() => assertStandardGraph({ inputs:{ 'js/public/safe.js':{} } }, 'standard', { repoRoot:root }));
});
