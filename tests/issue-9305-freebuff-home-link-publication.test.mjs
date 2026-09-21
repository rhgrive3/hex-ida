import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureHomeLinks, replaceWithSymlinkAtomically } from '../scripts/freebuff-setup.mjs';

function injectedRenameFailure(linkPath, code = 'ENOSPC') {
  return {
    ...fs,
    renameSync(src, dst) {
      if (path.basename(dst) === path.basename(linkPath) && path.basename(src).includes('.link-')) {
        const error = new Error(`${code}: injected publication failure`);
        error.code = code;
        throw error;
      }
      return fs.renameSync(src, dst);
    },
  };
}

for (const name of ['message-history.json', 'projects', 'rg']) {
  test(`#9305 failed replacement preserves the old ${name} entry and reports failure`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9305-'));
    try {
      const linkPath = path.join(root, name);
      if (name === 'projects') {
        fs.mkdirSync(linkPath);
        fs.writeFileSync(path.join(linkPath, 'sentinel'), 'KEEP\n');
      } else {
        fs.writeFileSync(linkPath, 'KEEP\n');
      }
      const fsImpl = injectedRenameFailure(linkPath);
      assert.throws(
        () => replaceWithSymlinkAtomically(linkPath, '../target', { fsImpl }),
        (error) => error?.code === 'ENOSPC',
      );
      const entry = fs.lstatSync(linkPath);
      assert.equal(entry.isSymbolicLink(), false);
      if (name === 'projects') assert.equal(fs.readFileSync(path.join(linkPath, 'sentinel'), 'utf8'), 'KEEP\n');
      else assert.equal(fs.readFileSync(linkPath, 'utf8'), 'KEEP\n');
    } finally {
      fs.rmSync(root, { recursive:true, force:true });
    }
  });
}

test('#9305 successful HOME reconciliation atomically replaces stale entries and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9305-success-'));
  try {
    const home = path.join(root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive:true });
    fs.writeFileSync(path.join(manicode, 'message-history.json'), 'stale\n');
    fs.mkdirSync(path.join(manicode, 'projects'));
    fs.writeFileSync(path.join(manicode, 'rg'), 'stale\n');

    ensureHomeLinks(home);
    const expected = {
      'message-history.json':'../../../../shared/history/message-history.json',
      projects:'../../../../shared/history/projects',
      rg:'../../../../shared/manicode/rg',
    };
    for (const [name, target] of Object.entries(expected)) {
      const p = path.join(manicode, name);
      assert.equal(fs.lstatSync(p).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(p), target);
    }
    ensureHomeLinks(home);
    for (const [name, target] of Object.entries(expected)) {
      assert.equal(fs.readlinkSync(path.join(manicode, name)), target);
    }
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9305 non-ENOENT inspection errors are not swallowed as successful reconciliation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9305-inspect-'));
  try {
    const home = path.join(root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive:true });
    const real = fs.lstatSync.bind(fs);
    const fsImpl = {
      ...fs,
      lstatSync(p, ...args) {
        if (path.basename(p) === 'message-history.json') {
          const error = new Error('EIO: injected inspection failure');
          error.code = 'EIO';
          throw error;
        }
        return real(p, ...args);
      },
    };
    assert.throws(() => ensureHomeLinks(home, { fsImpl }), (error) => error?.code === 'EIO');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
