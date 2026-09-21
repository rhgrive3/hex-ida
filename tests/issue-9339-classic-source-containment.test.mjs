import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectClassic } from '../scripts/build-userscript.mjs';

function mkroot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('#9339 rejects a classic dependency whose leaf symlink resolves outside root', async () => {
  const root = mkroot('hex-9339-root-');
  const outside = mkroot('hex-9339-out-');
  try {
    fs.mkdirSync(path.join(root, 'js'));
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), "importScripts('./external-helper.js');\n");
    fs.writeFileSync(path.join(outside, 'external-helper.js'), 'globalThis.EXTERNAL_SENTINEL = 1;\n');
    fs.symlinkSync(path.join(outside, 'external-helper.js'), path.join(root, 'js', 'external-helper.js'));
    const sources = new Map();
    await assert.rejects(() => collectClassic('js/worker.js', sources, { rootDir:root }), /escapes repository/);
    assert.equal(sources.has('js/external-helper.js'), false);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
    fs.rmSync(outside, { recursive:true, force:true });
  }
});

test('#9339 rejects a classic dependency through an external symlinked ancestor', async () => {
  const root = mkroot('hex-9339-root-');
  const outside = mkroot('hex-9339-out-');
  try {
    fs.mkdirSync(path.join(root, 'js'));
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), "importScripts('./external/helper.js');\n");
    fs.writeFileSync(path.join(outside, 'helper.js'), 'globalThis.EXTERNAL_SENTINEL = 1;\n');
    fs.symlinkSync(outside, path.join(root, 'js', 'external'));
    const sources = new Map();
    await assert.rejects(() => collectClassic('js/worker.js', sources, { rootDir:root }), /escapes repository/);
    assert.equal(sources.has('js/external/helper.js'), false);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
    fs.rmSync(outside, { recursive:true, force:true });
  }
});

test('#9339 ordinary in-root classic dependencies are collected recursively', async () => {
  const root = mkroot('hex-9339-normal-');
  try {
    fs.mkdirSync(path.join(root, 'js'));
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), "importScripts('./helper.js');\n");
    fs.writeFileSync(path.join(root, 'js', 'helper.js'), 'globalThis.OK = 1;\n');
    const sources = new Map();
    await collectClassic('js/worker.js', sources, { rootDir:root });
    assert.deepEqual([...sources.keys()].sort(), ['js/helper.js', 'js/worker.js']);
    assert.match(sources.get('js/helper.js'), /globalThis\.OK/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('#9339 an in-repository symlink remains contained and is allowed', async () => {
  const root = mkroot('hex-9339-inroot-');
  try {
    fs.mkdirSync(path.join(root, 'js'));
    fs.mkdirSync(path.join(root, 'shared'));
    fs.writeFileSync(path.join(root, 'js', 'worker.js'), "importScripts('./helper.js');\n");
    fs.writeFileSync(path.join(root, 'shared', 'helper.js'), 'globalThis.OK = 2;\n');
    fs.symlinkSync(path.join('..', 'shared', 'helper.js'), path.join(root, 'js', 'helper.js'));
    const sources = new Map();
    await collectClassic('js/worker.js', sources, { rootDir:root });
    assert.match(sources.get('js/helper.js'), /globalThis\.OK = 2/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
