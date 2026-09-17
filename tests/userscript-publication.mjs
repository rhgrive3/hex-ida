import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishUserscriptFiles, writeFileVerified } from '../scripts/userscript-publication.mjs';

const quota = () => Object.assign(new Error('injected disk quota exceeded'), { code:'EDQUOT' });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-publication-regression-'));
let ordinal = 0;
async function fixture() {
  const directory = path.join(root, String(ordinal++)); await fs.mkdir(directory);
  const entries = ['loader', 'release'].map(name => ({ path:path.join(directory, name), expected:Buffer.from(`old ${name}`), content:`new ${name}` }));
  for (const entry of entries) await fs.writeFile(entry.path, entry.expected);
  return { directory, entries };
}
async function originalPair(entries) {
  for (const entry of entries) assert.deepEqual(await fs.readFile(entry.path), entry.expected);
}
async function cleanDirectory(directory) { assert.deepEqual((await fs.readdir(directory)).sort(), ['loader', 'release']); }

try {
  for (const failure of ['write', 'sync', 'close', 'short-write', 'readback']) {
    const { directory, entries } = await fixture();
    let stageCount = 0;
    const io = { ...fs, async open(file, flags) {
      const handle = await fs.open(file, flags);
      if (!file.endsWith('.stage') || ++stageCount !== 2) return handle;
      return {
        async writeFile(bytes) {
          if (failure === 'write') { await handle.writeFile(bytes.subarray(0, 1)); throw quota(); }
          await handle.writeFile(failure === 'short-write' ? bytes.subarray(0, 1) : bytes);
        },
        async sync() { if (failure === 'sync') throw quota(); await handle.sync(); },
        async close() { await handle.close(); if (failure === 'close') throw quota(); },
      };
    }, async readFile(file, ...args) {
      const bytes = await fs.readFile(file, ...args);
      return failure === 'readback' && file.endsWith('.stage') && stageCount === 2 ? Buffer.alloc(0) : bytes;
    } };
    await assert.rejects(publishUserscriptFiles(entries, { io }), /quota|readback/);
    await originalPair(entries); await cleanDirectory(directory);
  }

  for (const failure of ['second-rename', 'directory-sync']) {
    const { directory, entries } = await fixture(); let renames = 0, syncs = 0;
    const io = { ...fs, async rename(from, to) {
      if (from.endsWith('.stage') && ++renames === 2 && failure === 'second-rename') throw quota();
      await fs.rename(from, to);
    }, async open(file, flags) {
      const handle = await fs.open(file, flags);
      if (file !== directory) return handle;
      return { async sync() { if (++syncs === 2 && failure === 'directory-sync') throw quota(); await handle.sync(); }, close:() => handle.close() };
    } };
    await assert.rejects(publishUserscriptFiles(entries, { io }), /quota/);
    await originalPair(entries); await cleanDirectory(directory);
  }

  {
    const { directory, entries } = await fixture();
    const io = { ...fs, async rename(from, to) {
      if (from.endsWith('.backup') || from.endsWith('.stage') && to === entries[1].path) throw quota();
      await fs.rename(from, to);
    } };
    await assert.rejects(publishUserscriptFiles(entries, { io }), /recovery-required/);
    const names = await fs.readdir(directory);
    assert.ok(names.includes('.userscript-publication.lock'));
    for (const entry of entries) {
      const backup = names.find(name => name.startsWith(`${path.basename(entry.path)}.`) && name.endsWith('.backup'));
      assert.ok(backup); assert.deepEqual(await fs.readFile(path.join(directory, backup)), entry.expected);
    }
    await assert.rejects(publishUserscriptFiles(entries), { code:'EEXIST' });
  }

  {
    const { directory, entries } = await fixture();
    const lockPath = path.join(directory, '.userscript-publication.lock');
    let heldLock;
    const io = { ...fs, async open(file, flags) {
      const handle = await fs.open(file, flags);
      if (file !== lockPath) return handle;
      heldLock = handle;
      return {
        writeFile:(...args) => handle.writeFile(...args),
        sync:(...args) => handle.sync(...args),
        async close() { throw new Error('injected-lock-close-before-release'); },
      };
    } };
    await assert.rejects(publishUserscriptFiles(entries, { io }), /injected-lock-close-before-release/);
    for (const entry of entries) assert.equal(await fs.readFile(entry.path, 'utf8'), entry.content);
    assert.ok((await fs.readdir(directory)).includes('.userscript-publication.lock'));
    await assert.rejects(publishUserscriptFiles(entries), { code:'EEXIST' });
    await heldLock.close();
    await fs.unlink(lockPath);
    for (const name of await fs.readdir(directory)) {
      if (name.endsWith('.stage') || name.endsWith('.backup')) await fs.unlink(path.join(directory, name));
    }
    await cleanDirectory(directory);
  }

  {
    const { directory, entries } = await fixture();
    const lockPath = path.join(directory, '.userscript-publication.lock');
    const stale = entries.map(entry => ({ ...entry, expected:Buffer.from('not the original') }));
    const io = { ...fs, async open(file, flags) {
      const handle = await fs.open(file, flags);
      if (file !== lockPath) return handle;
      return {
        writeFile:(...args) => handle.writeFile(...args),
        sync:(...args) => handle.sync(...args),
        async close() { await handle.close(); throw new Error('injected-lock-close-failure'); },
      };
    } };
    await assert.rejects(publishUserscriptFiles(stale, { io }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /stale-input/);
      assert.match(String(error.errors[1]), /lock-close-failure/);
      return true;
    });
    assert.ok((await fs.readdir(directory)).includes('.userscript-publication.lock'));
    await fs.unlink(lockPath);
    await originalPair(entries); await cleanDirectory(directory);
  }

  {
    const { directory, entries } = await fixture();
    const stale = entries.map(entry => ({ ...entry, expected:Buffer.from('not the original') }));
    await assert.rejects(publishUserscriptFiles(stale), /stale-input/);
    await originalPair(entries); await cleanDirectory(directory);
    await publishUserscriptFiles(entries);
    for (const entry of entries) assert.equal(await fs.readFile(entry.path, 'utf8'), entry.content);
    await cleanDirectory(directory);
  }

  {
    const { directory, entries } = await fixture();
    const file = entries[0].path;
    const io = { ...fs, async open(target, flags) {
      const handle = await fs.open(target, flags);
      return { writeFile:async () => { throw quota(); }, sync:() => handle.sync(), close:() => handle.close() };
    } };
    await assert.rejects(writeFileVerified(file, 'replacement', { io }), /quota/);
    await originalPair(entries); await cleanDirectory(directory);
  }

  const build = await fs.readFile(new URL('../scripts/build-userscript.mjs', import.meta.url), 'utf8');
  assert.match(build, /writeFileVerified as writeFile, publishUserscriptFiles/);
  assert.ok(build.indexOf('await publishUserscriptFiles(') > build.indexOf("await writeFile(resolve(dist, 'runtime-manifest.json')"));
  assert.doesNotMatch(build, /writeFile\((?:committedTemplate|releaseStatePath),/);
  console.log('Userscript publication: write/sync/close/readback/rename/rollback/stale-input regressions PASS');
} finally { await fs.rm(root, { recursive:true, force:true }); }
