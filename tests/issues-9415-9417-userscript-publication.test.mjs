import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishUserscriptFiles, writeFileVerified } from '../scripts/userscript-publication.mjs';

async function makePair(root) {
  const directory = path.join(root, 'pair');
  await fs.mkdir(directory, { recursive: true });
  const entries = ['loader', 'release'].map((name) => ({
    path: path.join(directory, name),
    expected: Buffer.from('old-' + name),
    content: 'new-' + name,
  }));
  for (const entry of entries) await fs.writeFile(entry.path, entry.expected);
  return { directory, entries };
}

test('backup identity failure retains recovery lock and the unverified backup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9415-'));
  try {
    const { directory, entries } = await makePair(root);
    let linkedBackup = null;
    let injected = false;
    const io = {
      ...fs,
      async link(from, to) {
        await fs.link(from, to);
        if (!linkedBackup) linkedBackup = to;
      },
      async lstat(target) {
        if (!injected && linkedBackup && target === linkedBackup) {
          injected = true;
          throw Object.assign(new Error('injected-backup-identity-EIO'), { code: 'EIO' });
        }
        return fs.lstat(target);
      },
    };

    await assert.rejects(
      () => publishUserscriptFiles(entries, { io, containmentRoot: directory }),
      (error) => {
        const text = String(error) + ' ' + (error instanceof AggregateError ? error.errors.map(String).join(' ') : '');
        assert.match(text, /injected-backup-identity-EIO/);
        return true;
      },
    );
    assert.equal(injected, true);
    const names = await fs.readdir(directory);
    assert.ok(names.includes('.userscript-publication.lock'));
    assert.ok(names.some((name) => name.endsWith('.backup')));
    await assert.rejects(() => publishUserscriptFiles(entries, { containmentRoot: directory }), { code: 'EEXIST' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('verified write rejects an immediate symlinked output directory before staging', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9417-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9417-out-'));
  try {
    const output = path.join(root, 'userscript');
    await fs.symlink(outside, output);
    const file = path.join(output, 'hex.user.template.js');
    await assert.rejects(
      () => writeFileVerified(file, 'SENTINEL\n', { containmentRoot: root }),
      /unsafe-directory/,
    );
    assert.equal(await fs.readdir(outside).then((x) => x.length), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('verified write rejects a nested ancestor symlink and accepts real directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9417-nested-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'userscript-9417-nested-out-'));
  try {
    await fs.mkdir(path.join(root, 'generated'));
    await fs.mkdir(path.join(outside, 'deep'));
    await fs.symlink(outside, path.join(root, 'generated', 'redirect'));
    await assert.rejects(
      () => writeFileVerified(path.join(root, 'generated', 'redirect', 'deep', 'x.js'), 'bad\n', { containmentRoot: root }),
      /unsafe-directory/,
    );
    assert.equal(await fs.readdir(path.join(outside, 'deep')).then((x) => x.length), 0);

    const real = path.join(root, 'generated', 'real');
    await fs.mkdir(real);
    const good = path.join(real, 'ok.js');
    await writeFileVerified(good, 'good\n', { containmentRoot: root });
    assert.equal(await fs.readFile(good, 'utf8'), 'good\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
