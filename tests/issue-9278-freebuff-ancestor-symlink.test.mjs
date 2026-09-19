import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyIfMissing, ensureHomeLinks, ensureSafeDirectory } from '../scripts/freebuff-setup.mjs';

test('#9278 manicode ancestor symlink cannot redirect HOME reconciliation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9278-'));
  try {
    const home = path.join(root, 'home');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    fs.mkdirSync(victim, { recursive: true });
    const sentinel = path.join(victim, 'message-history.json');
    fs.writeFileSync(sentinel, 'KEEP\n');
    fs.symlinkSync(victim, path.join(home, '.config', 'manicode'));

    assert.throws(() => ensureHomeLinks(home), /unsafe directory ancestor/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'KEEP\n');
    assert.equal(fs.existsSync(path.join(victim, 'projects')), false);
    assert.equal(fs.existsSync(path.join(victim, 'rg')), false);
    assert.equal(fs.existsSync(path.join(victim, 'freebuff')), false);
    assert.equal(fs.existsSync(path.join(victim, 'freebuff-metadata.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9278 migration copy rejects any symlinked parent beneath its HOME root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9278-copy-'));
  try {
    const home = path.join(root, 'home');
    const victim = path.join(root, 'victim');
    const src = path.join(root, 'settings.json');
    fs.mkdirSync(home);
    fs.mkdirSync(victim);
    fs.writeFileSync(src, '{"safe":true}\n');
    fs.writeFileSync(path.join(victim, 'settings.json'), 'KEEP\n');
    fs.symlinkSync(victim, path.join(home, '.config'));

    assert.throws(
      () => copyIfMissing(src, path.join(home, '.config', 'settings.json'), false, home),
      /unsafe directory ancestor/,
    );
    assert.equal(fs.readFileSync(path.join(victim, 'settings.json'), 'utf8'), 'KEEP\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9278 genuine HOME directories remain idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9278-normal-'));
  try {
    const home = path.join(root, 'home');
    ensureSafeDirectory(home, home);
    ensureHomeLinks(home);
    ensureHomeLinks(home);
    const manicode = path.join(home, '.config', 'manicode');
    for (const name of ['message-history.json', 'projects', 'rg']) {
      assert.equal(fs.lstatSync(path.join(manicode, name)).isSymbolicLink(), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
