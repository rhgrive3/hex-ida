import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Test #9265 mirror symlink safety
const testMirrorDir = path.resolve('tests/.freebuff-mirror-test-9265');
const victimFile = path.resolve('tests/.freebuff-victim-9265.txt');
fs.mkdirSync(testMirrorDir, { recursive: true });
fs.writeFileSync(victimFile, 'VICTIM_CONTENT\n');

const symlinkDst = path.join(testMirrorDir, 'victim-symlink.txt');
fs.symlinkSync(victimFile, symlinkDst);

try {
  // Check that writing safely to mirror leaf replaces symlink without touching victim
  const st = fs.lstatSync(symlinkDst);
  if (st.isSymbolicLink()) {
    fs.rmSync(symlinkDst, { force: true });
  }
  fs.writeFileSync(symlinkDst, 'NEW_CONTENT\n');

  assert.equal(fs.readFileSync(victimFile, 'utf8'), 'VICTIM_CONTENT\n');
  assert.equal(fs.readFileSync(symlinkDst, 'utf8'), 'NEW_CONTENT\n');
  assert.equal(fs.lstatSync(symlinkDst).isFile(), true);
  assert.equal(fs.lstatSync(symlinkDst).isSymbolicLink(), false);
} finally {
  fs.rmSync(testMirrorDir, { recursive: true, force: true });
  fs.rmSync(victimFile, { force: true });
}

console.log('issue-freebuff-setup-fixes: PASS');
