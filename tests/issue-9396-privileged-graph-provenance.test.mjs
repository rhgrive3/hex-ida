import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertPrivilegedGraph } from '../scripts/auth-build-policy.mjs';

const required = [
  'js/userscript/dev/parent-worker-runtime.js',
  'js/userscript/dev/parent-rpc.js',
  'js/userscript/dev/bootstrap-host.js',
];

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const rel of required) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const fixture = ${JSON.stringify(rel)};\n`);
  }
  return root;
}

function metafile() {
  return { inputs: Object.fromEntries(required.map((rel) => [rel, {}])) };
}

test('privileged graph accepts regular required files inside repository', () => {
  const root = makeRoot('auth-9396-ok-');
  try {
    assert.doesNotThrow(() => assertPrivilegedGraph(metafile(), 'parent', { repoRoot: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('privileged graph rejects a required leaf symlink escaping repository', () => {
  const root = makeRoot('auth-9396-root-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-9396-outside-'));
  try {
    const rel = required[0];
    const external = path.join(outside, 'parent-worker-runtime.js');
    fs.writeFileSync(external, 'export const EXTERNAL = true;\n');
    fs.rmSync(path.join(root, rel));
    fs.symlinkSync(external, path.join(root, rel));

    assert.throws(
      () => assertPrivilegedGraph(metafile(), 'parent', { repoRoot: root }),
      /(?:required )?input escapes repository/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('privileged graph fails closed when required source identity cannot be established', () => {
  const root = makeRoot('auth-9396-realpath-');
  try {
    const target = path.join(root, required[1]);
    const resolver = (value) => {
      if (path.resolve(value) === path.resolve(target)) {
        throw Object.assign(new Error('simulated I/O failure'), { code: 'EIO' });
      }
      return fs.realpathSync(value);
    };
    assert.throws(
      () => assertPrivilegedGraph(metafile(), 'parent', { repoRoot: root, realpathSync: resolver }),
      /cannot establish source identity/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
