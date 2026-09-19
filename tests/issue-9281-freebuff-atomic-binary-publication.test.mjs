import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishExecutableAtomically } from '../scripts/freebuff-setup.mjs';

function tempEntries(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.freebuff.tmp-'));
}

test('#9281 staging failure leaves an existing shared executable byte-for-byte intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9281-fail-'));
  const originalCopy = fs.copyFileSync;
  try {
    const candidate = path.join(root, 'candidate');
    const live = path.join(root, 'freebuff');
    fs.writeFileSync(candidate, 'NEW-COMPLETE\n');
    fs.writeFileSync(live, 'OLD-COMPLETE\n');

    fs.copyFileSync = (src, staged) => {
      assert.equal(src, candidate);
      assert.notEqual(staged, live, 'copy destination must be a staging path, never the live executable');
      fs.writeFileSync(staged, 'PARTIAL');
      assert.equal(fs.readFileSync(live, 'utf8'), 'OLD-COMPLETE\n');
      throw Object.assign(new Error('injected copy failure'), { code: 'EIO' });
    };

    assert.throws(
      () => publishExecutableAtomically(candidate, live, '1.2.3', { versionProbe: () => '1.2.3' }),
      /injected copy failure/,
    );
    assert.equal(fs.readFileSync(live, 'utf8'), 'OLD-COMPLETE\n');
    assert.deepEqual(tempEntries(root), []);
  } finally {
    fs.copyFileSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9281 final path appears only after a complete validated stage is ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9281-success-'));
  const originalCopy = fs.copyFileSync;
  try {
    const candidate = path.join(root, 'candidate');
    const live = path.join(root, 'freebuff');
    fs.writeFileSync(candidate, 'NEW-COMPLETE\n');
    let sawLiveDuringCopy = null;

    fs.copyFileSync = (src, staged, flags) => {
      assert.equal(fs.existsSync(live), false);
      sawLiveDuringCopy = false;
      originalCopy(src, staged, flags);
    };

    const version = publishExecutableAtomically(candidate, live, '2.0.0', { versionProbe: () => '2.0.0' });
    assert.equal(version, '2.0.0');
    assert.equal(sawLiveDuringCopy, false);
    assert.equal(fs.readFileSync(live, 'utf8'), 'NEW-COMPLETE\n');
    assert.notEqual(fs.statSync(live).mode & 0o111, 0, 'published executable must already be executable');
    assert.deepEqual(tempEntries(root), []);
  } finally {
    fs.copyFileSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9281 staged version mismatch never replaces the live executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9281-version-'));
  try {
    const candidate = path.join(root, 'candidate');
    const live = path.join(root, 'freebuff');
    fs.writeFileSync(candidate, 'NEW\n');
    fs.writeFileSync(live, 'OLD\n');
    assert.throws(
      () => publishExecutableAtomically(candidate, live, '3.0.0', { versionProbe: () => '2.9.9' }),
      /version mismatch/,
    );
    assert.equal(fs.readFileSync(live, 'utf8'), 'OLD\n');
    assert.deepEqual(tempEntries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
