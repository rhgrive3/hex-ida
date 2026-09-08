import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

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


test('known all-scope and fully resolved accesses remain complete (#5752)', () => {
  const all = buildLocalFunctionSummary(
    intrinsicIr({ scope:'all', addressSpaces:['memory'] }, { scope:'all', addressSpaces:['memory'] }),
    {}, { definitions:[], uses:[] }, null, { snapshotId:'snapshot:test' },
  );
  assert.equal(all.status.completeness, 'complete');
  assert.equal(all.summary.memoryReadRegions[0].broad, true);
  assert.equal(all.summary.memoryWriteRegions[0].broad, true);

  const region = deriveMemoryRegion({
    binaryId:'binary:test', widthBits:64, origin:{ instructionIds:['insn:0'] },
    regionEvidence:{ kind:'global-absolute', address:0x1000n },
  });
  const accesses = buildLocalFunctionSummary(
    intrinsicIr({ scope:'accesses', accesses:[{ regionId:region.id, addressSpace:'memory' }] }, { scope:'none' }),
    {}, { definitions:[], uses:[] }, null, {
      snapshotId:'snapshot:test',
      resolveRegion: (memory) => memory.regionId === region.id ? region : null,
    },
  );
  assert.equal(accesses.status.completeness, 'complete');
  assert.equal(accesses.status.stopReason, null);
  assert.deepEqual(accesses.summary.memoryReadRegions.map((effect) => effect.regionId), [region.id]);
  assert.equal(accesses.summary.memoryReadRegions[0].broad, false);
});

test('unresolved accesses and unknown scope tokens stay broad and incomplete (#5752)', () => {
  const unresolved = buildLocalFunctionSummary(
    intrinsicIr({ scope:'accesses', accesses:[{ regionId:'missing', addressSpace:'memory' }] }, { scope:'none' }),
    {}, { definitions:[], uses:[] }, null, {
      snapshotId:'snapshot:test',
      resolveRegion: () => null,
    },
  );
  assert.equal(unresolved.status.completeness, 'partial');
  assert.equal(unresolved.status.stopReason, 'evidence-missing');
  assert.ok(unresolved.summary.memoryReadRegions.some((effect) => effect.broad));

  const unknownToken = buildLocalFunctionSummary(
    intrinsicIr({ scope:'unmodeled-scope' }, { scope:'none' }),
    {}, { definitions:[], uses:[] }, null, { snapshotId:'snapshot:test' },
  );
  assert.equal(unknownToken.status.completeness, 'partial');
  assert.equal(unknownToken.status.stopReason, 'evidence-missing');
  assert.ok(unknownToken.summary.memoryReadRegions.some((effect) => effect.broad));
});

test('unknown call memory scope and partial callee composition stay incomplete (#5752)', () => {
  const callerIr = {
    functionId:'fn:caller',
    nodes:[{
      id:'call0', kind:'call', inputs:[], outputs:[],
      origin:{ instructionIds:['call:0'] },
      call:{
        completeness:'complete',
        targetEntityIds:['fn:callee'],
        memoryRead:{ scope:'none' },
        memoryWrite:{ scope:'unknown' },
        noreturn:false, mayThrow:false,
      },
    }],
    values:[],
  };
  const partialCallee = createFunctionSummary({
    functionId:'fn:callee',
    memoryWriteRegions:[{
      regionKind:'unknown', broad:true, addressSpaces:['memory'], source:'unknown-call-fallback',
    }],
    unknownCallEffects:[{
      callSiteId:'inner-call', reason:'summary-missing', targetEntityIds:['fn:missing'],
    }],
    status:{
      snapshotId:'snapshot:test',
      analyzerId:'phase7.summary.local',
      analyzerVersion:'1.1.1',
      completeness:'partial',
      stopReason:'evidence-missing',
    },
  });
  const composed = buildLocalFunctionSummary(
    callerIr, {}, { definitions:[], uses:[] }, null, {
      snapshotId:'snapshot:test',
      calleeSummaries:new Map([['fn:callee', partialCallee]]),
    },
  );
  assert.equal(composed.status.completeness, 'partial');
  assert.ok(composed.summary.unknownCallEffects.some((effect) => effect.callSiteId === 'inner-call'));
});
