import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Verify that trailing whitespace in untracked file is not trimmed
const testFile = 'userscript/hex.user.template.js ';
try {
  fs.writeFileSync(testFile, 'unexpected\n');
  const res = spawnSync('node', ['scripts/sync-generated-userscript.mjs'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('non-canonical changes present') || res.stderr.includes('userscript/hex.user.template.js '));
} finally {
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
}

console.log('issue-9230-sync-generated-userscript-names: PASS');
