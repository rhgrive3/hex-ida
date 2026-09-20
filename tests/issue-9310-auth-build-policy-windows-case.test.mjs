import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPrivilegedGraph } from '../scripts/auth-build-policy.mjs';

function parentInputs(root) {
  return { inputs:Object.fromEntries([
    'js/userscript/dev/parent-worker-runtime.js',
    'js/userscript/dev/parent-rpc.js',
    'js/userscript/dev/bootstrap-host.js',
  ].map((rel) => [`${root}/${rel}`, {}])) };
}
function childInputs(root) {
  return { inputs:Object.fromEntries([
    'js/ai/dev/supervisor/dev-supervisor-v0.js',
    'js/ai/dev/ui/settings.js',
    'js/ai/dev/ui/engine-router.js',
    'js/ai/dev/ui/controls.js',
  ].map((rel) => [`${root}/${rel}`, {}])) };
}

test('#9310 Windows privileged graph accepts equivalent path casing', () => {
  assert.doesNotThrow(() => assertPrivilegedGraph(parentInputs('c:/work/hex-ida'), 'parent', {
    repoRoot:'C:/Work/Hex-IDA', platform:'win32',
  }));
  assert.doesNotThrow(() => assertPrivilegedGraph(childInputs('C:/WORK/HEX-IDA'), 'child', {
    repoRoot:'c:/work/hex-ida', platform:'win32',
  }));
});

test('#9310 Windows case folding does not admit sibling roots', () => {
  assert.throws(() => assertPrivilegedGraph(parentInputs('c:/work/hex-ida-other'), 'parent', {
    repoRoot:'C:/Work/Hex-IDA', platform:'win32',
  }), /omits/);
});

test('#9310 POSIX path identity remains case-sensitive', () => {
  assert.throws(() => assertPrivilegedGraph(parentInputs('/work/hex-ida'), 'parent', {
    repoRoot:'/work/Hex-IDA', platform:'linux',
  }), /omits/);
});
