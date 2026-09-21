import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureHomeLinks, replaceWithSymlinkAtomically } from '../scripts/freebuff-setup.mjs';

test('#9332 published symlink remains successful when obsolete backup cleanup fails, and retry reclaims it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9332-'));
  try {
    const home = path.join(root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive:true });
    const linkPath = path.join(manicode, 'rg');
    const target = '../../../../shared/manicode/rg';
    fs.writeFileSync(linkPath, 'STALE');
    const injected = {
      ...fs,
      rmSync(file, options) {
        if (path.basename(file).startsWith('.rg.backup-')) throw Object.assign(new Error('cleanup EIO'), { code:'EIO' });
        return fs.rmSync(file, options);
      },
    };
    assert.equal(replaceWithSymlinkAtomically(linkPath, target, { fsImpl:injected }), true);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(linkPath), target);
    assert.ok(fs.readdirSync(manicode).some((name) => name.startsWith('.rg.backup-')));

    ensureHomeLinks(home);
    assert.equal(fs.readlinkSync(linkPath), target);
    assert.equal(fs.readdirSync(manicode).some((name) => name.startsWith('.rg.backup-')), false);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
