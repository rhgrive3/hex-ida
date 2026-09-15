// Regression for #8804: `snapshotId` is provenance authority for the canonical
// MemorySSA artifact and for every ownership/staleness boundary, not display
// text. The compat producer, the direct builder and the query consumer all used a
// generic `String()` coercion, so an Array, a custom `toString()` object, a
// String wrapper, a number or a boolean collapsed onto the same canonical snapshot
// as a real primitive id, and a stale/structured snapshot matched a current one.
// All three boundaries now share one primitive non-empty-string policy that never
// invokes a caller-controlled `toString()`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createAnalysisSurface } from '../../js/analysis/index.js';
import { buildFixture } from '../phase7/corpus/fixtures.mjs';

const SNAPSHOT_REJECT = 'memory-ssa-snapshot-id-invalid';
const IDENTITY_SNAPSHOT_REJECT = 'memory-ssa-identity-snapshot-id-invalid';

// ---------------------------------------------------------------------------
// Producer: Semantic v2 compat pipeline
// ---------------------------------------------------------------------------

const plugin = Object.freeze({
  id: 'issue-8804-architecture',
  semanticVersion: 'issue-8804-semantics-v1',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'issue-8804-architecture',
      mode: decoded.mode,
      operations: [],
      controlEffect: { kind: 'return' },
      possibleFaults: [],
      origin: decoded.origin,
      completeness: 'exact',
    });
  },
});

function compatInput(overrides = {}) {
  return {
    architecturePlugin: plugin,
    decoderSemanticVersion: 'issue-8804-decoder-v1',
    binaryId: 'binary-issue-8804',
    sliceId: 'slice-issue-8804',
    addressWidthBits: 64,
    blocks: [{
      key: 'entry',
      startAddress: 0x1000n,
      instructions: [{ decoded: { address: 0x1000n, mode: 'a64' } }],
      successors: [],
    }],
    ...overrides,
  };
}

test('#8804 compat pipeline accepts a primitive non-empty snapshot id', () => {
  const result = buildSemanticV2CompatibilityPipeline(compatInput(), { snapshotId: 'S-1' });
  assert.equal(result.memorySsa.snapshotId, 'S-1');
  // identity and artifact carry the exact same canonical primitive token (case 8).
  assert.equal(result.memorySsa.identity.snapshotId, 'S-1');
  assert.equal(result.memorySsa.identity.snapshotId, result.memorySsa.snapshotId);
});

test('#8804 compat pipeline binds the unbound sentinel for a primitive default', () => {
  const result = buildSemanticV2CompatibilityPipeline(compatInput(), {});
  assert.equal(result.memorySsa.snapshotId, 'snapshot-unbound');
});

test('#8804 compat pipeline rejects structured / non-primitive snapshots without coercion (cases 2-5)', () => {
  let hookCalls = 0;
  const coercible = { toString() { hookCalls += 1; return 'S-1'; } };
  const cases = [
    ['1-element array', ['S-1']],
    ['custom toString object', coercible],
    ['String wrapper', new String('S-1')],
    ['number', 1],
    ['boolean', true],
    ['whitespace-only', '   '],
    ['empty', ''],
  ];
  for (const [label, value] of cases) {
    assert.throws(
      () => buildSemanticV2CompatibilityPipeline(compatInput(), { snapshotId: value }),
      (error) => error instanceof TypeError && error.message === SNAPSHOT_REJECT,
      `structured snapshot ${label} was accepted at the compat boundary`,
    );
  }
  // case 3: no caller-controlled toString() may run inside provenance validation.
  assert.equal(hookCalls, 0, 'provenance validation must not invoke a toString() hook');
});

test('#8804 typed inputs do not collapse onto one canonical snapshot (case 6)', () => {
  const primitive = buildSemanticV2CompatibilityPipeline(compatInput(), { snapshotId: 'S-1' });
  assert.equal(primitive.memorySsa.snapshotId, 'S-1');
  // ['S-1'] and { toString(): 'S-1' } would previously coerce to the same 'S-1'.
  const isReject = (error) => error instanceof TypeError && error.message === SNAPSHOT_REJECT;
  assert.throws(() => buildSemanticV2CompatibilityPipeline(compatInput(), { snapshotId: ['S-1'] }), isReject);
  assert.throws(
    () => buildSemanticV2CompatibilityPipeline(compatInput(), { snapshotId: { toString: () => 'S-1' } }),
    isReject,
  );
});

// ---------------------------------------------------------------------------
// Producer: direct canonical builder (must have the same strictness)
// ---------------------------------------------------------------------------

function canonicalPair(functionId = 'f') {
  const origin = { instructionIds: ['i'] };
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [], origin }],
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  return { ir, cfg };
}

test('#8804 direct buildMemorySsa publishes a primitive snapshot verbatim (case 7)', () => {
  const { ir, cfg } = canonicalPair();
  const artifact = buildMemorySsa(ir, cfg, { snapshotId: 'S-1' });
  assert.equal(artifact.snapshotId, 'S-1');
  // a padded primitive is canonicalised to the same token as its trimmed form,
  // never published verbatim with stray whitespace.
  const padded = buildMemorySsa(ir, cfg, { snapshotId: '  S-1  ' });
  assert.equal(padded.snapshotId, 'S-1');
});

test('#8804 direct buildMemorySsa rejects structured snapshots without coercion (case 7)', () => {
  const { ir, cfg } = canonicalPair();
  let hookCalls = 0;
  const coercible = { toString() { hookCalls += 1; return 'S-1'; } };
  for (const value of [['S-1'], coercible, new String('S-1'), 1, true, '   ', '']) {
    assert.throws(
      () => buildMemorySsa(ir, cfg, { snapshotId: value }),
      (error) => error instanceof TypeError && error.message === SNAPSHOT_REJECT,
      'a structured or non-primitive snapshot was published by the direct builder',
    );
  }
  assert.equal(hookCalls, 0, 'direct builder must not invoke a toString() hook');
});

test('#8804 buildMemorySsa rejects a structured identity snapshot id before jsonSafe', () => {
  const { ir, cfg } = canonicalPair();
  assert.throws(
    () => buildMemorySsa(ir, cfg, {
      snapshotId: 'S-1',
      identity: { functionId: 'f', snapshotId: ['S-1'], memorySsaBuildVersion: 'x', analyzerVersion: 'x' },
    }),
    (error) => error instanceof TypeError && error.message === IDENTITY_SNAPSHOT_REJECT,
  );
});

// ---------------------------------------------------------------------------
// Consumer: the ownership / staleness boundary fails closed
// ---------------------------------------------------------------------------

test('#8804 a structured binding snapshot never authenticates a current binding (case 9)', async () => {
  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-old',
    options: {
      memorySsaBinding: {
        memorySsa: built.memorySsa,
        snapshotId: ['S-old'],
        functionId: built.ir.functionId,
        semanticIrVersion: built.ir.contractVersion,
        memorySsaBuildVersion: built.memorySsa.buildVersion,
        completeness: 'complete',
      },
    },
  });
  const run = surface.pointsTo();
  assert.equal(run.recovery?.bindingState, 'stale', 'a structured snapshot must not be repaired into a match');
  assert.equal(run.recovery?.bindingReason, 'memoryssa-stale-snapshot');
  assert.equal(run.recovery?.publicationAllowed, false);
});

test('#8804 a matching primitive binding still authenticates as current (positive path)', async () => {
  const built = buildFixture('stack-disjoint');
  const surface = createAnalysisSurface({
    ir: built.ir,
    cfg: built.cfg,
    ssa: built.ssa,
    memorySsa: built.memorySsa,
    snapshotId: 'S-new',
    options: {
      memorySsaBinding: {
        memorySsa: built.memorySsa,
        snapshotId: 'S-new',
        functionId: built.ir.functionId,
        semanticIrVersion: built.ir.contractVersion,
        memorySsaBuildVersion: built.memorySsa.buildVersion,
        completeness: 'complete',
      },
    },
  });
  const run = surface.pointsTo();
  assert.equal(run.recovery?.bindingState, 'current');
  assert.equal(run.recovery?.publicationAllowed, true);
});
