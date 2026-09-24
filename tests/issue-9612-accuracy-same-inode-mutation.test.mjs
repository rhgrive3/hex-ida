import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  return root;
}

function mutatingFs(target, replacement) {
  let mutated = false;
  return {
    ...fs,
    readFileSync(file, ...args) {
      const bytes = fs.readFileSync(file, ...args);
      if (!mutated && typeof file === 'number') {
        mutated = true;
        fs.writeFileSync(target, replacement);
      }
      return bytes;
    },
  };
}

test('#9612 rejects same-inode same-size mutation while hashing a regular input', () => {
  const root = makeRoot('accuracy-9612-regular-');
  try {
    const file = path.join(root, 'js', 'example.js');
    fs.writeFileSync(file, 'AAAA');
    const before = fs.lstatSync(file);
    assert.throws(
      () => partitionDigest(root, 'core', {
        fsImpl: mutatingFs(file, 'BBBB'),
        partitionFilesImpl: () => ['js/example.js'],
      }),
      /selected input changed during hashing/,
    );
    const after = fs.lstatSync(file);
    assert.equal(String(after.dev), String(before.dev));
    assert.equal(String(after.ino), String(before.ino));
    assert.equal(after.size, before.size);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('#9612 rejects same-inode mutation through an in-repository symlink target', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9612-symlink-');
  try {
    const target = path.join(root, 'js', 'target.js');
    const link = path.join(root, 'js', 'link.js');
    fs.writeFileSync(target, 'AAAA');
    fs.symlinkSync('target.js', link);
    assert.throws(
      () => partitionDigest(root, 'core', {
        fsImpl: mutatingFs(target, 'BBBB'),
        partitionFilesImpl: () => ['js/link.js'],
      }),
      /selected input changed during hashing/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('#9612 unchanged selected input remains deterministic', () => {
  const root = makeRoot('accuracy-9612-stable-');
  try {
    const file = path.join(root, 'js', 'example.js');
    fs.writeFileSync(file, 'AAAA');
    const options = { partitionFilesImpl: () => ['js/example.js'] };
    assert.equal(partitionDigest(root, 'core', options), partitionDigest(root, 'core', options));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
