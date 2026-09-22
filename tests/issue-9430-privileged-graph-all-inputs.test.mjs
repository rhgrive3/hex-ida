import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertPrivilegedGraph } from '../scripts/auth-build-policy.mjs';

const REQUIRED = {
  parent: [
    'js/userscript/dev/parent-worker-runtime.js',
    'js/userscript/dev/parent-rpc.js',
    'js/userscript/dev/bootstrap-host.js',
  ],
  child: [
    'js/ai/dev/supervisor/dev-supervisor-v0.js',
    'js/ai/dev/ui/settings.js',
    'js/ai/dev/ui/engine-router.js',
    'js/ai/dev/ui/controls.js',
  ],
};

function makeRoot(kind, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const rel of REQUIRED[kind]) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const fixture = ${JSON.stringify(rel)};\n`);
  }
  return root;
}

function graph(kind, extras = []) {
  return {
    inputs: Object.fromEntries([...REQUIRED[kind], ...extras].map((rel) => [rel, {}])),
  };
}

test('contained optional privileged inputs remain accepted', () => {
  for (const kind of ['parent', 'child']) {
    const root = makeRoot(kind, `auth-9430-${kind}-ok-`);
    try {
      const extra = kind === 'parent'
        ? 'js/userscript/shared/extra.js'
        : 'js/ai/shared/extra.js';
      const file = path.join(root, extra);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export const EXTRA = true;\n');
      assert.doesNotThrow(() => assertPrivilegedGraph(graph(kind, [extra]), kind, { repoRoot: root }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('optional privileged leaf symlink escaping repository is rejected for parent and child', () => {
  if (process.platform === 'win32') return;
  for (const kind of ['parent', 'child']) {
    const root = makeRoot(kind, `auth-9430-${kind}-leaf-`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-9430-outside-'));
    try {
      const extra = kind === 'parent'
        ? 'js/userscript/shared/extra.js'
        : 'js/ai/shared/extra.js';
      const external = path.join(outside, 'extra.js');
      fs.writeFileSync(external, 'export const EXTERNAL = true;\n');
      const file = path.join(root, extra);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(external, file);

      assert.throws(
        () => assertPrivilegedGraph(graph(kind, [extra]), kind, { repoRoot: root }),
        /bundle input escapes repository/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('optional privileged input below escaping symlinked ancestor is rejected', () => {
  if (process.platform === 'win32') return;
  const root = makeRoot('parent', 'auth-9430-ancestor-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-9430-ancestor-outside-'));
  try {
    const externalDir = path.join(outside, 'shared');
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'extra.js'), 'export const EXTERNAL = true;\n');

    fs.mkdirSync(path.join(root, 'js', 'userscript'), { recursive: true });
    fs.symlinkSync(externalDir, path.join(root, 'js', 'userscript', 'shared'), 'dir');
    const extra = 'js/userscript/shared/extra.js';

    assert.throws(
      () => assertPrivilegedGraph(graph('parent', [extra]), 'parent', { repoRoot: root }),
      /bundle input escapes repository/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('absolute optional input outside repository is rejected', () => {
  const root = makeRoot('parent', 'auth-9430-absolute-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-9430-absolute-outside-'));
  try {
    const external = path.join(outside, 'extra.js');
    fs.writeFileSync(external, 'export const EXTERNAL = true;\n');

    assert.throws(
      () => assertPrivilegedGraph(graph('parent', [external]), 'parent', { repoRoot: root }),
      /bundle input escapes repository/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolver failure for optional privileged input fails closed', () => {
  const root = makeRoot('child', 'auth-9430-resolver-');
  try {
    const extra = 'js/ai/shared/extra.js';
    const file = path.join(root, extra);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const EXTRA = true;\n');

    const resolver = (value) => {
      if (path.resolve(value) === path.resolve(file)) {
        throw Object.assign(new Error('simulated I/O failure'), { code: 'EIO' });
      }
      return fs.realpathSync(value);
    };

    assert.throws(
      () => assertPrivilegedGraph(graph('child', [extra]), 'child', { repoRoot: root, realpathSync: resolver }),
      /cannot establish source identity/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
