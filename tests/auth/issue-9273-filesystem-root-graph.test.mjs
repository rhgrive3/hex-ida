import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPrivilegedGraph } from '../../scripts/auth-build-policy.mjs';

const parentRequired = [
  'js/userscript/dev/parent-worker-runtime.js',
  'js/userscript/dev/parent-rpc.js',
  'js/userscript/dev/bootstrap-host.js',
];
const childRequired = [
  'js/ai/dev/supervisor/dev-supervisor-v0.js',
  'js/ai/dev/ui/settings.js',
  'js/ai/dev/ui/engine-router.js',
  'js/ai/dev/ui/controls.js',
];

function graph(paths) {
  return { inputs: Object.fromEntries(paths.map((input) => [input, {}])) };
}

test('issue #9273: POSIX filesystem root preserves complete privileged graphs', () => {
  assert.doesNotThrow(() => assertPrivilegedGraph(
    graph(parentRequired.map((input) => `/${input}`)),
    'parent',
    { repoRoot: '/' },
  ));
  assert.doesNotThrow(() => assertPrivilegedGraph(
    graph(childRequired.map((input) => `/${input}`)),
    'child',
    { repoRoot: '/' },
  ));
});

test('issue #9273: filesystem-root graphs still fail closed when required inputs are missing', () => {
  assert.throws(
    () => assertPrivilegedGraph(
      graph(parentRequired.slice(1).map((input) => `/${input}`)),
      'parent',
      { repoRoot: '/' },
    ),
    /parent bundle omits js\/userscript\/dev\/parent-worker-runtime\.js/,
  );
  assert.throws(
    () => assertPrivilegedGraph(
      graph(childRequired.slice(0, -1).map((input) => `/${input}`)),
      'child',
      { repoRoot: '/' },
    ),
    /child bundle omits js\/ai\/dev\/ui\/controls\.js/,
  );
});

test('issue #9273: non-root trailing separators still normalize to repository-relative inputs', () => {
  const repoRoot = '/tmp/hex-ida///';
  assert.doesNotThrow(() => assertPrivilegedGraph(
    graph(parentRequired.map((input) => `/tmp/hex-ida/${input}`)),
    'parent',
    { repoRoot },
  ));
});
