import assert from 'node:assert/strict';

import { resolvePhase3DualMode } from '../support/phase3-dual-mode.mjs';

assert.deepEqual(resolvePhase3DualMode({ env:{}, availableParallelism:4 }), {
  enabled:false, available:4, perCorpusConcurrency:1, reason:'insufficient-parallelism',
});
assert.deepEqual(resolvePhase3DualMode({ env:{}, availableParallelism:8 }), {
  enabled:true, available:8, perCorpusConcurrency:3, reason:'local-wide-host',
});
assert.deepEqual(resolvePhase3DualMode({ env:{}, availableParallelism:10 }), {
  enabled:true, available:10, perCorpusConcurrency:4, reason:'local-wide-host',
});
assert.deepEqual(resolvePhase3DualMode({ env:{ HEX_PHASE3_DUAL_MODE_PARALLEL:'0' }, availableParallelism:32 }), {
  enabled:false, available:32, perCorpusConcurrency:1, reason:'disabled',
});
assert.deepEqual(resolvePhase3DualMode({ env:{ HEX_PHASE3_DUAL_MODE_PARALLEL:'1' }, availableParallelism:6 }), {
  enabled:true, available:6, perCorpusConcurrency:2, reason:'explicit',
});
assert.deepEqual(resolvePhase3DualMode({ env:{ GITHUB_ACTIONS:'true', HEX_PHASE3_DUAL_MODE_PARALLEL:'1' }, availableParallelism:32 }), {
  enabled:false, available:32, perCorpusConcurrency:1, reason:'hosted-ci',
}, 'hosted CI must stay conservative even if a generic local override leaks into the environment');

console.log('Phase 3 dual-mode local scheduling contract: PASS');
