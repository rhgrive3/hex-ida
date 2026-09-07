// Regression test for #5897: graft-hooks.cjs must distinguish
// "graft unavailable" (fail-open no-op) from "hook execution failed" (non-zero).
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../.claude/helpers/graft-hooks.cjs', import.meta.url));

// Case 1: real graft installed, main runs -> exit 0.
{
  const result = spawnSync(process.execPath, [helper, 'post-edit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `real graft main() should succeed: ${result.stderr}`);
}

// Case 2: module missing entirely -> fail-open exit 0.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hook-'));
  const result = spawnSync(process.execPath, [helper, 'post-edit'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_TEST_NO_FALLBACK: '1' },
  });
  assert.equal(result.status, 0, 'graft not installed must stay a no-op');
}

// Case 3: main() rejects -> non-zero exit with stderr evidence.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hook-'));
  const dist = path.join(dir, 'dist', 'claude');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'hooks.js'), 'export async function main() { throw new Error("post-edit verification failed"); }\n');
  const result = spawnSync(process.execPath, [helper, 'post-edit'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_TEST_NO_FALLBACK: '1', NODE_PATH: '' },
  });
  assert.equal(result.status, 1, 'a failing hook main() must not convert to success');
  assert.match(result.stderr, /post-edit verification failed/, 'failure evidence must reach stderr');
}

// Case 4: module loads but has no main() export -> non-zero exit.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hook-'));
  const dist = path.join(dir, 'dist', 'claude');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'hooks.js'), 'export const notMain = () => {};\n');
  const result = spawnSync(process.execPath, [helper, 'post-edit'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_TEST_NO_FALLBACK: '1' } });
  assert.equal(result.status, 1, 'incompatible export shape is a hook failure, not "unavailable"');
  assert.match(result.stderr, /no main\(\) export/);
}

console.log('graft-hooks error-boundary regression: PASS');

// Case 5: an installed but syntactically invalid hook is not "unavailable".
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hook-'));
  const dist = path.join(dir, 'dist', 'claude');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'hooks.js'), 'export function main( {\n');
  const result = spawnSync(process.execPath, [helper, 'post-edit'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_TEST_NO_FALLBACK: '1', NODE_PATH: '' },
  });
  assert.equal(result.status, 1, 'an installed syntax error must not become a no-op');
  assert.match(result.stderr, /graft hook unavailable:/);
}

console.log('graft-hooks import-error regression: PASS');
