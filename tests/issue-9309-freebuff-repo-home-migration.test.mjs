import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { moveDirectoryIfMissing } from '../scripts/freebuff-setup.mjs';

for (const targetKind of ['directory', 'file']) {
  test(`#9309 symlinked repo HOME to ${targetKind} is rejected before rename`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9309-'));
    try {
      const sourceParent = path.join(root, 'repo');
      const persistent = path.join(root, 'persistent');
      const victim = path.join(root, 'victim');
      fs.mkdirSync(sourceParent);
      fs.mkdirSync(persistent);
      if (targetKind === 'directory') fs.mkdirSync(victim);
      else fs.writeFileSync(victim, 'KEEP');
      const src = path.join(sourceParent, 'home');
      const dst = path.join(persistent, '1', 'home');
      fs.symlinkSync(victim, src);
      assert.throws(
        () => moveDirectoryIfMissing(src, dst, { containmentRoot:persistent }),
        /migration source is not a real directory/,
      );
      assert.equal(fs.lstatSync(src).isSymbolicLink(), true);
      assert.equal(fs.existsSync(dst), false);
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
  });
}

test('#9309 real repo HOME migrates once and existing persistent HOME wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9309-real-'));
  try {
    const sourceParent = path.join(root, 'repo');
    const persistent = path.join(root, 'persistent');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(persistent);
    const src = path.join(sourceParent, 'home');
    const dst = path.join(persistent, '1', 'home');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'sentinel'), 'MIGRATE');
    assert.equal(moveDirectoryIfMissing(src, dst, { containmentRoot:persistent }), true);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(path.join(dst, 'sentinel'), 'utf8'), 'MIGRATE');

    const src2 = path.join(sourceParent, 'home2');
    fs.mkdirSync(src2);
    assert.equal(moveDirectoryIfMissing(src2, dst, { containmentRoot:persistent }), false);
    assert.equal(fs.existsSync(src2), true);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9309 symlinked destination ancestor is rejected before source mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9309-dst-'));
  try {
    const sourceParent = path.join(root, 'repo');
    const persistent = path.join(root, 'persistent');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(persistent);
    fs.mkdirSync(outside);
    const src = path.join(sourceParent, 'home');
    fs.mkdirSync(src);
    fs.symlinkSync(outside, path.join(persistent, '1'));
    const dst = path.join(persistent, '1', 'home');
    assert.throws(() => moveDirectoryIfMissing(src, dst, { containmentRoot:persistent }), /unsafe directory ancestor/);
    assert.equal(fs.lstatSync(src).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(outside, 'home')), false);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
