import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmpDir = path.resolve('tests/.graft-test-9260');
const candA = path.join(tmpDir, 'candA');
const candB = path.join(tmpDir, 'candB');

fs.mkdirSync(path.join(candA, 'statusline.js'), { recursive: true });
fs.mkdirSync(candB, { recursive: true });
fs.writeFileSync(path.join(candB, 'statusline.js'), 'export function main() { console.log("CAND_B_CALLED"); }');

try {
  const res = spawnSync('node', ['.claude/helpers/graft-statusline.cjs'], {
    env: {
      ...process.env,
      GRAFT_CLAUDE_DIR: candA,
      CLAUDE_PROJECT_DIR: candB,
    },
    encoding: 'utf8',
  });
  // candA was a directory, so it fell through to candB (via fromPkg or fallback) or did not crash
  assert.equal(res.status, 0);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('issue-9260-graft-statusline-directory: PASS');
