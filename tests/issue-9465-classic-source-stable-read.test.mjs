import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectClassic } from '../scripts/build-userscript.mjs';

function makeRoot(prefix = 'classic-9465-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  return root;
}

test('#9465 rejects contained source replaced by external symlink after validation', async () => {
  if (process.platform === 'win32') return;
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-9465-outside-'));
  try {
    const source = path.join(root, 'js', 'worker.js');
    const external = path.join(outside, 'external.js');
    fs.writeFileSync(source, 'globalThis.REVIEWED = true;\n');
    fs.writeFileSync(external, 'globalThis.EXTERNAL_SENTINEL = true;\n');

    const sources = new Map();
    await assert.rejects(
      () => collectClassic('js/worker.js', sources, {
        rootDir: root,
        async statImpl(target) {
          const info = await fsp.stat(target);
          fs.renameSync(target, `${target}.reviewed`);
          fs.symlinkSync(external, target);
          return info;
        },
      }),
      /source identity could not be established|source identity changed before read/,
    );
    assert.equal(sources.has('js/worker.js'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9465 rejects regular-file replacement after validation', async () => {
  const root = makeRoot('classic-9465-regular-');
  try {
    const source = path.join(root, 'js', 'worker.js');
    fs.writeFileSync(source, 'globalThis.REVIEWED = true;\n');

    const sources = new Map();
    await assert.rejects(
      () => collectClassic('js/worker.js', sources, {
        rootDir: root,
        async statImpl(target) {
          const info = await fsp.stat(target);
          fs.renameSync(target, `${target}.reviewed`);
          fs.writeFileSync(target, 'globalThis.REPLACEMENT = true;\n');
          return info;
        },
      }),
      /source identity changed before read/,
    );
    assert.equal(sources.has('js/worker.js'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9465 applies stable identity binding to transitive importScripts sources', async () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('classic-9465-transitive-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'classic-9465-transitive-outside-'));
  try {
    const worker = path.join(root, 'js', 'worker.js');
    const dependency = path.join(root, 'js', 'dep.js');
    const external = path.join(outside, 'external.js');
    fs.writeFileSync(worker, "importScripts('./dep.js');\nglobalThis.WORKER = true;\n");
    fs.writeFileSync(dependency, 'globalThis.DEP = true;\n');
    fs.writeFileSync(external, 'globalThis.EXTERNAL = true;\n');

    const sources = new Map();
    await assert.rejects(
      () => collectClassic('js/worker.js', sources, {
        rootDir: root,
        async statImpl(target) {
          const info = await fsp.stat(target);
          if (path.resolve(target) === path.resolve(dependency)) {
            fs.renameSync(target, `${target}.reviewed`);
            fs.symlinkSync(external, target);
          }
          return info;
        },
      }),
      /source identity could not be established|source identity changed before read/,
    );
    assert.equal(sources.get('js/worker.js')?.includes('WORKER'), true);
    assert.equal(sources.has('js/dep.js'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9465 stable regular contained source is read through validated handle', async () => {
  const root = makeRoot('classic-9465-stable-');
  try {
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), 'globalThis.STABLE = true;\n');
    const sources = new Map();
    let sawHandle = false;
    await collectClassic('js/worker.js', sources, {
      rootDir: root,
      async readHandleImpl(handle) {
        sawHandle = typeof handle?.stat === 'function' && typeof handle?.readFile === 'function';
        return handle.readFile({ encoding: 'utf8' });
      },
    });
    assert.equal(sawHandle, true);
    assert.equal(sources.get('js/worker.js'), 'globalThis.STABLE = true;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9465 open failures fail closed before inventory publication', async () => {
  const root = makeRoot('classic-9465-open-failure-');
  try {
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), 'globalThis.STABLE = true;\n');
    const sources = new Map();
    const io = Object.assign(new Error('simulated open failure'), { code: 'EIO' });
    await assert.rejects(
      () => collectClassic('js/worker.js', sources, {
        rootDir: root,
        async openImpl() { throw io; },
      }),
      /source identity could not be established/,
    );
    assert.equal(sources.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
