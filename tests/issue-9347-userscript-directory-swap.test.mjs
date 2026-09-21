import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPublicationDirectoryIdentity,
  assertSafePublicationDirectory,
  publishUserscriptFiles,
} from '../scripts/userscript-publication.mjs';

async function makePair(directory, prefix = 'OLD') {
  await fs.mkdir(directory, { recursive:true });
  const files = [path.join(directory, 'hex.user.js'), path.join(directory, 'hex-release.user.js')];
  await fs.writeFile(files[0], `${prefix}1`);
  await fs.writeFile(files[1], `${prefix}2`);
  return files;
}

function entriesFor(files) {
  return [
    { path:files[0], expected:Buffer.from('OLD1'), content:Buffer.from('NEW1') },
    { path:files[1], expected:Buffer.from('OLD2'), content:Buffer.from('NEW2') },
  ];
}

async function swapDirectory(directory, outside) {
  const saved = `${directory}.saved`;
  await fs.rename(directory, saved);
  await fs.symlink(outside, directory);
  return saved;
}

async function restoreDirectory(directory, saved) {
  await fs.unlink(directory).catch(() => {});
  await fs.rename(saved, directory).catch(() => {});
}

test('#9347 swap immediately after initial validation is rejected before external lock creation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9347-initial-'));
  const publication = path.join(root, 'userscript');
  const outside = path.join(root, 'outside');
  const files = await makePair(publication);
  await makePair(outside);
  let swapped = false;
  let saved = null;
  const io = {
    ...fs,
    async lstat(file) {
      const stat = await fs.lstat(file);
      if (!swapped && path.resolve(file) === path.resolve(publication)) {
        swapped = true;
        saved = await swapDirectory(publication, outside);
      }
      return stat;
    },
  };
  try {
    await assert.rejects(() => publishUserscriptFiles(entriesFor(files), { io, containmentRoot:root }), /directory-changed/);
    assert.deepEqual((await fs.readdir(outside)).sort(), ['hex-release.user.js', 'hex.user.js']);
    assert.equal(await fs.readFile(path.join(outside, 'hex.user.js'), 'utf8'), 'OLD1');
  } finally {
    if (saved) await restoreDirectory(publication, saved);
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('#9347 swap at stage open is detected and owned external stage artifact is cleaned safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9347-stage-'));
  const publication = path.join(root, 'userscript');
  const outside = path.join(root, 'outside');
  const files = await makePair(publication);
  await makePair(outside);
  let saved = null;
  let swapped = false;
  const io = {
    ...fs,
    async open(file, flags, ...rest) {
      if (!swapped && String(file).endsWith('.stage')) {
        swapped = true;
        saved = await swapDirectory(publication, outside);
      }
      return fs.open(file, flags, ...rest);
    },
  };
  try {
    await assert.rejects(() => publishUserscriptFiles(entriesFor(files), { io, containmentRoot:root }), /directory-changed|cleanup/);
    assert.deepEqual((await fs.readdir(outside)).sort(), ['hex-release.user.js', 'hex.user.js']);
    assert.equal(await fs.readFile(path.join(outside, 'hex.user.js'), 'utf8'), 'OLD1');
  } finally {
    if (saved) await restoreDirectory(publication, saved);
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('#9347 swap at commit rename leaves matching external leaves unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9347-commit-'));
  const publication = path.join(root, 'userscript');
  const outside = path.join(root, 'outside');
  const files = await makePair(publication);
  await makePair(outside);
  let saved = null;
  let swapped = false;
  const io = {
    ...fs,
    async rename(from, to) {
      if (!swapped && String(from).endsWith('.stage')) {
        swapped = true;
        saved = await swapDirectory(publication, outside);
      }
      return fs.rename(from, to);
    },
  };
  try {
    await assert.rejects(() => publishUserscriptFiles(entriesFor(files), { io, containmentRoot:root }), /ENOENT|directory-changed|cleanup/);
    assert.equal(await fs.readFile(path.join(outside, 'hex.user.js'), 'utf8'), 'OLD1');
    assert.equal(await fs.readFile(path.join(outside, 'hex-release.user.js'), 'utf8'), 'OLD2');
  } finally {
    if (saved) await restoreDirectory(publication, saved);
    await fs.rm(root, { recursive:true, force:true });
  }
});

test('#9347 nested directory identity detects an exchanged intermediate component', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9347-nested-'));
  const publication = path.join(root, 'generated', 'userscript');
  const outside = path.join(root, 'outside');
  await makePair(publication);
  await fs.mkdir(outside);
  let saved;
  try {
    const snapshot = await assertSafePublicationDirectory(publication, { containmentRoot:root });
    saved = await swapDirectory(path.join(root, 'generated'), outside);
    await assert.rejects(() => assertPublicationDirectoryIdentity(snapshot), /directory-changed/);
  } finally {
    if (saved) await restoreDirectory(path.join(root, 'generated'), saved);
    await fs.rm(root, { recursive:true, force:true });
  }
});
