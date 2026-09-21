import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copyIfMissing,
  ensureHomeLinks,
  ensureMetadata,
  moveDirectoryIfMissing,
  publishExecutableAtomically,
} from '../scripts/freebuff-setup.mjs';

function swapDirectoryWhenOpened(targetDir, outsideDir) {
  let swapped = false;
  return {
    ...fs,
    openSync(candidate, flags, mode) {
      if (!swapped && path.resolve(candidate) === path.resolve(targetDir)) {
        swapped = true;
        fs.renameSync(targetDir, `${targetDir}.validated`);
        fs.symlinkSync(outsideDir, targetDir, 'dir');
      }
      return fs.openSync(candidate, flags, mode);
    },
  };
}

function tempFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hex-9352-${name}-`));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `hex-9352-outside-${name}-`));
  fs.writeFileSync(path.join(outside, 'sentinel'), 'KEEP\n');
  return { root, outside };
}

function cleanup({ root, outside }) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

test('#9352 copy publication cannot follow a parent swapped after validation', () => {
  const fixture = tempFixture('copy');
  try {
    const home = path.join(fixture.root, 'home');
    const config = path.join(home, '.config');
    fs.mkdirSync(config, { recursive: true });
    const src = path.join(fixture.root, 'settings.json');
    fs.writeFileSync(src, '{}\n');
    const fsImpl = swapDirectoryWhenOpened(config, fixture.outside);
    assert.throws(
      () => copyIfMissing(src, path.join(config, 'settings.json'), false, home, { fsImpl }),
      /ELOOP|ENOTDIR|directory identity changed|stable directory handle unavailable/,
    );
    assert.equal(fs.existsSync(path.join(fixture.outside, 'settings.json')), false);
    assert.equal(fs.readFileSync(path.join(fixture.outside, 'sentinel'), 'utf8'), 'KEEP\n');
  } finally { cleanup(fixture); }
});

test('#9352 HOME-link publication cannot follow a manicode ancestor swap', () => {
  const fixture = tempFixture('links');
  try {
    const home = path.join(fixture.root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive: true });
    const fsImpl = swapDirectoryWhenOpened(manicode, fixture.outside);
    assert.throws(
      () => ensureHomeLinks(home, { fsImpl }),
      /ELOOP|ENOTDIR|directory identity changed|stable directory handle unavailable/,
    );
    for (const name of ['message-history.json', 'projects', 'rg']) {
      assert.equal(fs.existsSync(path.join(fixture.outside, name)), false);
    }
    assert.equal(fs.readFileSync(path.join(fixture.outside, 'sentinel'), 'utf8'), 'KEEP\n');
  } finally { cleanup(fixture); }
});

test('#9352 HOME-link reads stay on the opened directory after pathname replacement', () => {
  const fixture = tempFixture('link-read');
  try {
    const home = path.join(fixture.root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive: true });
    fs.symlinkSync('../../../../shared/history/message-history.json', path.join(fixture.outside, 'message-history.json'));

    let swapped = false;
    const fsImpl = {
      ...fs,
      readdirSync(candidate, options) {
        const result = fs.readdirSync(candidate, options);
        if (!swapped && String(candidate).startsWith('/proc/self/fd/')) {
          swapped = true;
          fs.renameSync(manicode, `${manicode}.validated`);
          fs.symlinkSync(fixture.outside, manicode, 'dir');
        }
        return result;
      },
    };

    ensureHomeLinks(home, { fsImpl });
    const validated = `${manicode}.validated`;
    assert.equal(fs.readlinkSync(path.join(validated, 'message-history.json')), '../../../../shared/history/message-history.json');
    assert.equal(fs.readlinkSync(path.join(validated, 'projects')), '../../../../shared/history/projects');
    assert.equal(fs.readlinkSync(path.join(validated, 'rg')), '../../../../shared/manicode/rg');
    assert.equal(fs.readlinkSync(path.join(fixture.outside, 'message-history.json')), '../../../../shared/history/message-history.json');
  } finally { cleanup(fixture); }
});

test('#9352 metadata publication cannot follow a validated parent swap', () => {
  const fixture = tempFixture('metadata');
  try {
    const home = path.join(fixture.root, 'home');
    const manicode = path.join(home, '.config', 'manicode');
    fs.mkdirSync(manicode, { recursive: true });
    const fsImpl = swapDirectoryWhenOpened(manicode, fixture.outside);
    assert.throws(
      () => ensureMetadata(manicode, { version: '1.2.3' }, home, { fsImpl }),
      /ELOOP|ENOTDIR|directory identity changed|stable directory handle unavailable/,
    );
    assert.equal(fs.existsSync(path.join(fixture.outside, 'freebuff-metadata.json')), false);
  } finally { cleanup(fixture); }
});

test('#9352 executable publication cannot follow a validated parent swap', () => {
  const fixture = tempFixture('binary');
  try {
    const shared = path.join(fixture.root, 'shared');
    const manicode = path.join(shared, 'manicode');
    fs.mkdirSync(manicode, { recursive: true });
    const candidate = path.join(fixture.root, 'candidate');
    fs.writeFileSync(candidate, 'BINARY\n');
    const fsImpl = swapDirectoryWhenOpened(manicode, fixture.outside);
    assert.throws(
      () => publishExecutableAtomically(candidate, path.join(manicode, 'freebuff'), '1.2.3', {
        versionProbe: () => '1.2.3',
        fsImpl,
        containmentRoot: shared,
      }),
      /ELOOP|ENOTDIR|directory identity changed|stable directory handle unavailable/,
    );
    assert.equal(fs.existsSync(path.join(fixture.outside, 'freebuff')), false);
  } finally { cleanup(fixture); }
});

test('#9352 directory migration keeps its source when destination parent is swapped', () => {
  const fixture = tempFixture('move');
  try {
    const src = path.join(fixture.root, 'repo-home');
    const persistent = path.join(fixture.root, 'persistent');
    const dstParent = path.join(persistent, '1');
    const dst = path.join(dstParent, 'home');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'sentinel'), 'SOURCE\n');
    fs.mkdirSync(dstParent, { recursive: true });
    const fsImpl = swapDirectoryWhenOpened(dstParent, fixture.outside);
    assert.throws(
      () => moveDirectoryIfMissing(src, dst, { containmentRoot: persistent, fsImpl }),
      /ELOOP|ENOTDIR|directory identity changed|stable directory handle unavailable/,
    );
    assert.equal(fs.existsSync(src), true);
    assert.equal(fs.existsSync(path.join(fixture.outside, 'home')), false);
  } finally { cleanup(fixture); }
});
