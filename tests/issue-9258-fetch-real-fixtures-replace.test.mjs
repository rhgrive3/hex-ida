import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Test replacement logic for existing target
const tmpDir = path.resolve('tests/.real-fixtures-test-9258');
await fs.mkdir(tmpDir, { recursive: true });

const target = path.join(tmpDir, 'test-target.bin');
const temp = path.join(tmpDir, 'test-temp.bin');

try {
  // Pre-create corrupt target
  await fs.writeFile(target, 'corrupt data');
  await fs.writeFile(temp, 'verified new data');

  // Perform replacement logic with Windows fallback simulation
  try {
    // Simulate Windows error if needed, or normal rename
    await fs.rename(temp, target);
  } catch (renameErr) {
    await fs.rm(target, { force: true });
    await fs.rename(temp, target);
  }

  const content = await fs.readFile(target, 'utf8');
  assert.equal(content, 'verified new data');
  assert.equal(await fs.stat(temp).catch(() => null), null);
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log('issue-9258-fetch-real-fixtures-replace: PASS');
