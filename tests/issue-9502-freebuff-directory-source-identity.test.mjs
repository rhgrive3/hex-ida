import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { moveDirectoryIfMissing } from '../scripts/freebuff-setup.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9502-dst-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9502-src-'));
  const src = path.join(sourceRoot, 'home');
  const dst = path.join(root, '1', 'home');
  fs.mkdirSync(src);
  fs.mkdirSync(path.dirname(dst), { recursive:true });
  fs.writeFileSync(path.join(src, 'sentinel'), 'validated\n');
  return { root, sourceRoot, src, dst };
}
function cleanup(f) { fs.rmSync(f.root,{recursive:true,force:true}); fs.rmSync(f.sourceRoot,{recursive:true,force:true}); }

function swappingFs(f, replacementKind) {
  let swapped = false;
  return {
    ...fs,
    renameSync(from, to) {
      if (!swapped && String(from).startsWith('/proc/self/fd/') && path.basename(String(from)) === 'home') {
        swapped = true;
        fs.renameSync(f.src, `${f.src}.validated`);
        if (replacementKind === 'symlink') fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9502-victim-')), f.src, 'dir');
        else if (replacementKind === 'file') fs.writeFileSync(f.src, 'replacement\n');
        else fs.mkdirSync(f.src);
      }
      return fs.renameSync(from, to);
    },
  };
}

for (const kind of ['symlink', 'file', 'directory']) {
  test(`#9502 rejects ${kind} substituted after source validation`, () => {
    const f = fixture();
    try {
      assert.throws(() => moveDirectoryIfMissing(f.src, f.dst, { containmentRoot:f.root, fsImpl:swappingFs(f, kind) }), /migration source identity changed/);
      assert.equal(fs.existsSync(f.dst), false);
    } finally { cleanup(f); }
  });
}

test('#9502 ordinary validated directory migration still succeeds', () => {
  const f = fixture();
  try {
    assert.equal(moveDirectoryIfMissing(f.src, f.dst, { containmentRoot:f.root }), true);
    assert.equal(fs.readFileSync(path.join(f.dst, 'sentinel'), 'utf8'), 'validated\n');
    assert.equal(fs.existsSync(f.src), false);
  } finally { cleanup(f); }
});
