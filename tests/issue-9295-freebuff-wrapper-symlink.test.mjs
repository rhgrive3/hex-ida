import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureWrappers, wrapperScript } from '../scripts/freebuff-setup.mjs';

test('#9295 wrapper reconciliation replaces symlink leaves without touching their targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9295-'));
  try {
    const victim1 = path.join(root, 'victim-one.txt');
    fs.writeFileSync(victim1, 'KEEP\n', { mode: 0o640 });
    const victim1Mode = fs.statSync(victim1).mode & 0o777;
    fs.symlinkSync(victim1, path.join(root, 'freebuff-1'));

    const victim2 = path.join(root, 'victim-two.txt');
    fs.writeFileSync(victim2, wrapperScript('2'), { mode: 0o600 });
    const victim2Mode = fs.statSync(victim2).mode & 0o777;
    fs.symlinkSync(victim2, path.join(root, 'freebuff-2'));

    const wrote = ensureWrappers(root);
    assert.equal(wrote, 8);
    assert.equal(fs.readFileSync(victim1, 'utf8'), 'KEEP\n');
    assert.equal(fs.statSync(victim1).mode & 0o777, victim1Mode);
    assert.equal(fs.readFileSync(victim2, 'utf8'), wrapperScript('2'));
    assert.equal(fs.statSync(victim2).mode & 0o777, victim2Mode);

    for (let n = 1; n <= 8; n += 1) {
      const wrapper = path.join(root, `freebuff-${n}`);
      const entry = fs.lstatSync(wrapper);
      assert.equal(entry.isSymbolicLink(), false, `freebuff-${n} must not remain a symlink`);
      assert.equal(entry.isFile(), true, `freebuff-${n} must be a regular file`);
      assert.notEqual(entry.mode & 0o111, 0, `freebuff-${n} must be executable`);
      assert.equal(fs.readFileSync(wrapper, 'utf8'), wrapperScript(String(n)));
    }

    assert.equal(ensureWrappers(root), 0, 'canonical regular wrappers must be idempotent');

    fs.chmodSync(path.join(root, 'freebuff-3'), 0o644);
    assert.equal(ensureWrappers(root), 1, 'canonical but non-executable wrapper must be republished safely');
    assert.notEqual(fs.lstatSync(path.join(root, 'freebuff-3')).mode & 0o111, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
