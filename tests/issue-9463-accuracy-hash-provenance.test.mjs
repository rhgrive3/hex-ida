import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { partitionDigest, partitionFiles } from '../scripts/accuracy-partition-cache-key.mjs';

function makeRoot(prefix = 'accuracy-9463-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js', 'main.js'), 'export const inside = true;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"inside":true}\n');
  return root;
}

function mutateAfterSelection(mutator) {
  return (root, partition) => {
    const selected = partitionFiles(root, partition);
    mutator(root);
    return selected;
  };
}

test('#9463 rejects selected package.json retargeted outside after selection', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9463-outside-'));
  try {
    const external = path.join(outside, 'package.json');
    fs.writeFileSync(external, '{"outside":true}\n');
    assert.throws(
      () => partitionDigest(root, 'core', {
        partitionFilesImpl: mutateAfterSelection((selectedRoot) => {
          const selected = path.join(selectedRoot, 'package.json');
          fs.unlinkSync(selected);
          fs.symlinkSync(external, selected);
        }),
      }),
      /escapes repository while hashing|identity changed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9463 rejects contained symlink retargeted outside after selection', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9463-contained-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9463-contained-outside-'));
  try {
    const insideTarget = path.join(root, 'package-inside.json');
    const external = path.join(outside, 'package.json');
    fs.writeFileSync(insideTarget, '{"inside-target":true}\n');
    fs.writeFileSync(external, '{"outside-target":true}\n');
    fs.unlinkSync(path.join(root, 'package.json'));
    fs.symlinkSync('package-inside.json', path.join(root, 'package.json'));

    assert.throws(
      () => partitionDigest(root, 'core', {
        partitionFilesImpl: mutateAfterSelection((selectedRoot) => {
          const selected = path.join(selectedRoot, 'package.json');
          fs.unlinkSync(selected);
          fs.symlinkSync(external, selected);
        }),
      }),
      /escapes repository while hashing|identity changed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9463 rejects selected js file replaced by external symlink', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9463-js-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9463-js-outside-'));
  try {
    const external = path.join(outside, 'main.js');
    fs.writeFileSync(external, 'export const outside = true;\n');
    assert.throws(
      () => partitionDigest(root, 'core', {
        partitionFilesImpl: mutateAfterSelection((selectedRoot) => {
          const selected = path.join(selectedRoot, 'js', 'main.js');
          fs.unlinkSync(selected);
          fs.symlinkSync(external, selected);
        }),
      }),
      /escapes repository while hashing|identity changed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9463 rejects pseudoc common input retargeted outside after selection', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9463-pseudoc-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-9463-pseudoc-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    const selected = path.join(root, 'tests', 'accuracy-pseudoc-parallel.mjs');
    const external = path.join(outside, 'accuracy-pseudoc-parallel.mjs');
    fs.writeFileSync(selected, 'export const inside = true;\n');
    fs.writeFileSync(external, 'export const outside = true;\n');

    assert.throws(
      () => partitionDigest(root, 'pseudoc-0', {
        partitionFilesImpl: mutateAfterSelection(() => {
          fs.unlinkSync(selected);
          fs.symlinkSync(external, selected);
        }),
      }),
      /escapes repository while hashing|identity changed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('#9463 stable regular and contained symlink inputs remain deterministic', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9463-stable-');
  try {
    const target = path.join(root, 'package-target.json');
    fs.writeFileSync(target, '{"stable":true}\n');
    fs.unlinkSync(path.join(root, 'package.json'));
    fs.symlinkSync('package-target.json', path.join(root, 'package.json'));
    const first = partitionDigest(root, 'core');
    const second = partitionDigest(root, 'core');
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('#9463 broken symlink remains an explicitly represented stable state', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('accuracy-9463-broken-');
  try {
    fs.symlinkSync('../missing.js', path.join(root, 'js', 'broken.js'));
    assert.match(partitionDigest(root, 'core'), /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
