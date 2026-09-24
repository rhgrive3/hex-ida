import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrivilegedGraph } from '../scripts/auth-build-policy.mjs';

const digest = 'a'.repeat(64);
const sets = {
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

function graph(kind) {
  return { inputs: Object.fromEntries(sets[kind].map((path) => [path, {}])) };
}
function provenance(kind) {
  return new Map(sets[kind].map((path) => [path, { effectivePath: path, loadedDigest: digest }]));
}

test('#9599 parent required anchor must resolve to its exact provenance path', () => {
  const p = provenance('parent');
  p.set(sets.parent[0], { effectivePath: 'js/public/innocent.js', loadedDigest: digest });
  assert.throws(
    () => assertPrivilegedGraph(graph('parent'), 'parent', { repoRoot: '/', provenance: p }),
    /required anchor .* resolves to js\/public\/innocent\.js/,
  );
});

test('#9599 child required anchor alias is rejected', () => {
  const p = provenance('child');
  p.set(sets.child[2], { effectivePath: 'js/ai/dev/ui/settings.js', loadedDigest: digest });
  assert.throws(
    () => assertPrivilegedGraph(graph('child'), 'child', { repoRoot: '/', provenance: p }),
    /required anchor/,
  );
});

test('#9599 exact required provenance continues to pass', () => {
  assert.doesNotThrow(() => assertPrivilegedGraph(graph('parent'), 'parent', { repoRoot: '/', provenance: provenance('parent') }));
  assert.doesNotThrow(() => assertPrivilegedGraph(graph('child'), 'child', { repoRoot: '/', provenance: provenance('child') }));
});

test('#9599 missing required-anchor provenance fails closed when provenance is supplied', () => {
  const p = provenance('parent');
  p.delete(sets.parent[1]);
  assert.throws(
    () => assertPrivilegedGraph(graph('parent'), 'parent', { repoRoot: '/', provenance: p }),
    /cannot establish bundled source provenance/,
  );
});
