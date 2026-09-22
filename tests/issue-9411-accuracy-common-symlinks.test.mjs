import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionFiles, partitionDigest } from '../scripts/accuracy-partition-cache-key.mjs';

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js', 'core.js'), 'export const x = 1;\n');
  return root;
}

test('common cache input symlink escaping repository is rejected', () => {
  const root = makeRoot('accuracy-9411-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9411-out-'));
  try {
    const external = path.join(outside, 'package.json');
    fs.writeFileSync(external, '{"outside":1}\n');
    fs.symlinkSync(external, path.join(root, 'package.json'));
    assert.throws(() => partitionFiles(root, 'core'), /selected input escapes repository/);
    assert.throws(() => partitionDigest(root, 'core'), /selected input escapes repository/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('pseudoc-specific cache input symlink escaping repository is rejected', () => {
  const root = makeRoot('accuracy-9411-pseudoc-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9411-pseudoc-out-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    const external = path.join(outside, 'accuracy-pseudoc-eval.mjs');
    fs.writeFileSync(external, 'export {};\n');
    fs.symlinkSync(external, path.join(root, 'tests', 'accuracy-pseudoc-eval.mjs'));
    assert.throws(() => partitionFiles(root, 'pseudoc-0'), /selected input escapes repository/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('in-repository common symlink retains deterministic supported policy', () => {
  const root = makeRoot('accuracy-9411-inside-');
  try {
    const target = path.join(root, 'package.real.json');
    fs.writeFileSync(target, '{"inside":1}\n');
    fs.symlinkSync('package.real.json', path.join(root, 'package.json'));
    const files = partitionFiles(root, 'core');
    assert.ok(files.includes('package.json'));
    assert.equal(partitionDigest(root, 'core'), partitionDigest(root, 'core'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
