import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishUserscriptFiles } from '../scripts/userscript-publication.mjs';

async function makeEntries(directory) {
  const paths = [path.join(directory, 'hex.user.js'), path.join(directory, 'hex-release.user.js')];
  const expected = [Buffer.from('OLD_LOADER'), Buffer.from('OLD_RELEASE')];
  const content = [Buffer.from('NEW_LOADER'), Buffer.from('NEW_RELEASE')];
  for (let i = 0; i < paths.length; i++) await fs.writeFile(paths[i], expected[i]);
  return paths.map((file, i) => ({ path:file, expected:expected[i], content:content[i] }));
}

test('#9311 immediate symlinked publication directory is rejected before external mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9311-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9311-outside-'));
  try {
    const realEntries = await makeEntries(outside);
    const publicationDirectory = path.join(root, 'userscript');
    await fs.symlink(outside, publicationDirectory);
    const entries = realEntries.map((entry) => ({ ...entry, path:path.join(publicationDirectory, path.basename(entry.path)) }));
    await assert.rejects(
      () => publishUserscriptFiles(entries, { containmentRoot:root }),
      /unsafe-directory/,
    );
    assert.equal(await fs.readFile(realEntries[0].path, 'utf8'), 'OLD_LOADER');
    assert.equal(await fs.readFile(realEntries[1].path, 'utf8'), 'OLD_RELEASE');
    assert.deepEqual((await fs.readdir(outside)).sort(), ['hex-release.user.js', 'hex.user.js']);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
    await fs.rm(outside, { recursive:true, force:true });
  }
});

test('#9311 nested ancestor symlink is rejected against the repository containment root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9311-nested-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9311-nested-outside-'));
  try {
    const outsideUserscript = path.join(outside, 'userscript');
    await fs.mkdir(outsideUserscript);
    const realEntries = await makeEntries(outsideUserscript);
    await fs.symlink(outside, path.join(root, 'generated'));
    const publicationDirectory = path.join(root, 'generated', 'userscript');
    const entries = realEntries.map((entry) => ({ ...entry, path:path.join(publicationDirectory, path.basename(entry.path)) }));
    await assert.rejects(() => publishUserscriptFiles(entries, { containmentRoot:root }), /unsafe-directory/);
    assert.equal(await fs.readFile(realEntries[0].path, 'utf8'), 'OLD_LOADER');
    assert.equal(await fs.readFile(realEntries[1].path, 'utf8'), 'OLD_RELEASE');
    assert.deepEqual((await fs.readdir(outsideUserscript)).sort(), ['hex-release.user.js', 'hex.user.js']);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
    await fs.rm(outside, { recursive:true, force:true });
  }
});

test('#9311 normal real publication directory still publishes both files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-9311-normal-'));
  try {
    const publicationDirectory = path.join(root, 'userscript');
    await fs.mkdir(publicationDirectory);
    const entries = await makeEntries(publicationDirectory);
    await publishUserscriptFiles(entries, { containmentRoot:root });
    assert.equal(await fs.readFile(entries[0].path, 'utf8'), 'NEW_LOADER');
    assert.equal(await fs.readFile(entries[1].path, 'utf8'), 'NEW_RELEASE');
    assert.deepEqual((await fs.readdir(publicationDirectory)).sort(), ['hex-release.user.js', 'hex.user.js']);
  } finally {
    await fs.rm(root, { recursive:true, force:true });
  }
});
