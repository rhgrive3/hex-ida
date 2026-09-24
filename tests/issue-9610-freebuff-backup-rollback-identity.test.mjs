import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { replaceWithSymlinkAtomically } from '../scripts/freebuff-setup.mjs';

function injectedSubstitution(linkPath, kind) {
  return {
    ...fs,
    renameSync(src, dst) {
      if (path.basename(dst) === path.basename(linkPath) && path.basename(src).includes('.link-')) {
        const parent = path.dirname(dst);
        const backupName = fs.readdirSync(parent).find((name) => name.startsWith(`.${path.basename(linkPath)}.backup-`));
        assert.ok(backupName, 'operation backup must exist before publication');
        const backup = path.join(parent, backupName);
        fs.rmSync(backup, { recursive: true, force: true });
        if (kind === 'symlink') fs.symlinkSync('../attacker-target', backup);
        else fs.writeFileSync(backup, 'ATTACKER');
        throw Object.assign(new Error('publication failed'), { code: 'EIO' });
      }
      return fs.renameSync(src, dst);
    },
  };
}

for (const kind of ['file', 'symlink']) {
  test(`#9610 substituted backup ${kind} is never promoted during rollback`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `freebuff-9610-${kind}-`));
    try {
      const linkPath = path.join(root, 'rg');
      fs.writeFileSync(linkPath, 'ORIGINAL');
      let error;
      try {
        replaceWithSymlinkAtomically(linkPath, '../target', { fsImpl: injectedSubstitution(linkPath, kind) });
      } catch (caught) { error = caught; }
      assert.equal(error?.code, 'EIO');
      assert.equal(error?.cause?.code, 'FREEBUFF_BACKUP_IDENTITY_CHANGED');
      assert.equal(fs.existsSync(linkPath), false, 'unverified backup must not become canonical linkPath');
      const backup = fs.readdirSync(root).find((name) => name.startsWith('.rg.backup-'));
      assert.ok(backup, 'substituted backup remains quarantined at the backup pathname');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('#9610 unchanged backup still restores the exact original on publication failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-9610-restore-'));
  try {
    const linkPath = path.join(root, 'rg');
    fs.writeFileSync(linkPath, 'ORIGINAL');
    const injected = {
      ...fs,
      renameSync(src, dst) {
        if (path.basename(dst) === path.basename(linkPath) && path.basename(src).includes('.link-')) {
          throw Object.assign(new Error('publication failed'), { code: 'EIO' });
        }
        return fs.renameSync(src, dst);
      },
    };
    assert.throws(() => replaceWithSymlinkAtomically(linkPath, '../target', { fsImpl: injected }), (error) => error?.code === 'EIO');
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'ORIGINAL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
