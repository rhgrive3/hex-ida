import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertStandardGraph } from '../scripts/auth-build-policy.mjs';

test('#9362 standard graph rejects allowed-looking symlinks to privileged sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9362-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  fs.mkdirSync(path.join(root, 'js/public'), { recursive:true });
  fs.mkdirSync(path.join(root, 'js/auth/server'), { recursive:true });
  fs.writeFileSync(path.join(root, 'js/auth/admin-app.js'), 'export const privileged = true;\n');
  fs.writeFileSync(path.join(root, 'js/auth/server/router.js'), 'export const server = true;\n');
  fs.writeFileSync(path.join(root, 'js/public/ordinary.js'), 'export const ordinary = true;\n');

  try {
    fs.symlinkSync('../auth/admin-app.js', path.join(root, 'js/public/admin-alias.js'));
    fs.symlinkSync('../auth/server', path.join(root, 'js/public/server-alias'), 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => assertStandardGraph({ inputs:{ 'js/public/admin-alias.js':{} } }, 'standard', { repoRoot:root }),
    /leaks privileged implementation/,
  );
  assert.throws(
    () => assertStandardGraph({ inputs:{ 'js/public/server-alias/router.js':{} } }, 'standard', { repoRoot:root }),
    /leaks privileged implementation/,
  );
  assert.doesNotThrow(() => assertStandardGraph({ inputs:{ 'js/public/ordinary.js':{} } }, 'standard', { repoRoot:root }));
});
