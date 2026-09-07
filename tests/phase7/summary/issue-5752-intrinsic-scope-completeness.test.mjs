import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

// #5752: the intrinsic branch of the local summary builder discarded
// applyScope()'s verdict, so an intrinsic whose memory scope was unknown or
// missing produced a broad effect while the summary still published as
// `complete` with an empty unknownCallEffects list.

const intrinsicIr = (memoryRead, memoryWrite) => ({
  functionId:'fn:test',
  nodes:[{
    id:'i0',
    kind:'intrinsic',
    intrinsic:{ memoryRead, memoryWrite },
    origin:{ instructionIds:['insn:0'] },
  }],
  values:[],
});

test('an intrinsic with an unknown memory scope cannot publish a complete summary (#5752)', () => {
  const { summary, status } = buildLocalFunctionSummary(
    intrinsicIr({ scope:'unknown' }, { scope:'none' }),
    {},
    { definitions:[], uses:[] },
    null,
    { snapshotId:'snapshot:test' },
  );
  assert.equal(summary.memoryReadRegions[0].broad, true, 'the unknown scope still degrades to a broad effect');
  assert.equal(status.completeness, 'partial', 'unknown intrinsic scope must weaken completeness (#5752)');
  assert.equal(status.stopReason, 'evidence-missing');
  assert.equal(summary.unknownCallEffects.length, 0, 'unknownCallEffects stays call-specific');
});

test('a missing intrinsic memory scope is also incomplete, a fully described one stays complete (#5752)', () => {
  const missing = buildLocalFunctionSummary(
    intrinsicIr(null, { scope:'none' }),
    {},
    { definitions:[], uses:[] },
    null,
    { snapshotId:'snapshot:test' },
  );
  assert.equal(missing.status.completeness, 'partial');

  const described = buildLocalFunctionSummary(
    intrinsicIr({ scope:'none' }, { scope:'none' }),
    {},
    { definitions:[], uses:[] },
    null,
    { snapshotId:'snapshot:test' },
  );
  assert.equal(described.status.completeness, 'complete');
  assert.equal(described.status.stopReason, null);
});
