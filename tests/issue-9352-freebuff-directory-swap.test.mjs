import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copyIfMissing,
  moveDirectoryIfMissing,
  publishTextAtomically,
  replaceWithSymlinkAtomically,
} from '../scripts/freebuff-setup.mjs';

function swapDirectory(directory, outside) {
  const saved = `${directory}.saved`;
  fs.renameSync(directory, saved);
  fs.symlinkSync(outside, directory);
  return saved;
}

function restoreDirectory(directory, saved) {
  try { fs.unlinkSync(directory); } catch {}
  try { fs.renameSync(saved, directory); } catch {}
}

function externalNames(outside) {
  return fs.readdirSync(outside).sort();
}

test('#9352 copyIfMissing stays bound to the opened destination directory across an ancestor swap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9352-copy-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const src = path.join(root, 'settings.json');
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  fs.writeFileSync(src, '{"safe":true}\n');
  fs.writeFileSync(path.join(outside, 'sentinel'), 'KEEP\n');
  let saved = null;
  const fsImpl = {
    ...fs,
    copyFileSync(from, to, flags) {
      if (!saved) saved = swapDirectory(home, outside);
      return fs.copyFileSync(from, to, flags);
    },
  };
  try {
    assert.throws(
      () => copyIfMissing(src, path.join(home, 'settings.json'), false, home, { fsImpl }),
      /directory identity changed/,
    );
    assert.deepEqual(externalNames(outside), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'KEEP\n');
    assert.equal(fs.existsSync(path.join(saved, 'settings.json')), false, 'exclusive copied leaf is rolled back after identity loss');
  } finally {
    if (saved) restoreDirectory(home, saved);
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9352 text publication never follows a swapped parent into an external directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9352-text-'));
  const directory = path.join(root, 'state');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'KEEP\n');
  let saved = null;
  const fsImpl = {
    ...fs,
    writeFileSync(file, content, options) {
      if (!saved && path.basename(file).includes('.tmp-')) saved = swapDirectory(directory, outside);
      return fs.writeFileSync(file, content, options);
    },
  };
  try {
    assert.throws(
      () => publishTextAtomically(path.join(directory, 'metadata.json'), 'NEW\n', 0o600, { fsImpl, containmentRoot:root }),
      /directory identity changed/,
    );
    assert.deepEqual(externalNames(outside), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'KEEP\n');
  } finally {
    if (saved) restoreDirectory(directory, saved);
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9352 symlink reconciliation rolls back in the opened directory instead of touching a swapped external target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9352-link-'));
  const directory = path.join(root, 'manicode');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  const linkPath = path.join(directory, 'rg');
  fs.writeFileSync(linkPath, 'OLD\n');
  fs.writeFileSync(path.join(outside, 'rg'), 'EXTERNAL\n');
  let saved = null;
  const fsImpl = {
    ...fs,
    symlinkSync(target, staged, type) {
      if (!saved) saved = swapDirectory(directory, outside);
      return fs.symlinkSync(target, staged, type);
    },
  };
  try {
    assert.throws(
      () => replaceWithSymlinkAtomically(linkPath, '../shared/rg', { fsImpl }),
      /directory identity changed/,
    );
    assert.equal(fs.readFileSync(path.join(outside, 'rg'), 'utf8'), 'EXTERNAL\n');
    assert.equal(fs.readFileSync(path.join(saved, 'rg'), 'utf8'), 'OLD\n', 'old entry is restored in the original directory object');
  } finally {
    if (saved) restoreDirectory(directory, saved);
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9352 directory migration restores the source when the validated destination parent is swapped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9352-move-'));
  const dataRoot = path.join(root, 'data');
  const parent = path.join(dataRoot, '1');
  const outside = path.join(root, 'outside');
  const src = path.join(root, 'repo-home');
  const dst = path.join(parent, 'home');
  fs.mkdirSync(parent, { recursive:true });
  fs.mkdirSync(outside);
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'sentinel'), 'SOURCE\n');
  fs.writeFileSync(path.join(outside, 'sentinel'), 'EXTERNAL\n');
  let saved = null;
  let injected = false;
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (!injected && from === src) {
        injected = true;
        saved = swapDirectory(parent, outside);
      }
      return fs.renameSync(from, to);
    },
  };
  try {
    assert.throws(
      () => moveDirectoryIfMissing(src, dst, { containmentRoot:dataRoot, fsImpl }),
      /directory identity changed/,
    );
    assert.equal(fs.readFileSync(path.join(src, 'sentinel'), 'utf8'), 'SOURCE\n');
    assert.deepEqual(externalNames(outside), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'EXTERNAL\n');
  } finally {
    if (saved) restoreDirectory(parent, saved);
    fs.rmSync(root, { recursive:true, force:true });
  }
});
