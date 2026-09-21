import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertStandardGraph } from '../scripts/auth-build-policy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-standard-graph-'));
try {
  fs.mkdirSync(path.join(root, 'js/auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'js/public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js/auth/admin-app.js'), 'export const admin = true;\n');
  fs.writeFileSync(path.join(root, 'js/public/client.js'), 'export const client = true;\n');
  fs.symlinkSync('../auth/admin-app.js', path.join(root, 'js/public/admin-alias.js'));

  assert.throws(
    () => assertStandardGraph({ inputs: { 'js/public/admin-alias.js': {} } }, 'standard', { repoRoot: root }),
    /leaks privileged implementation.*admin-alias\.js -> js\/auth\/admin-app\.js/,
  );
  assert.doesNotThrow(
    () => assertStandardGraph({ inputs: { 'js/public/client.js': {} } }, 'standard', { repoRoot: root }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('issue-9362: ok');
