import assert from 'node:assert/strict';
import test from 'node:test';

import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createPointsToSet } from '../../../js/analysis/pointsto/lattice.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';
import { FunctionFixture } from '../helpers/fixtures.mjs';

function spillReloadFixture() {
  const fixture = new FunctionFixture('function_issue_5022_memoryssa', { binaryId: 'binary_issue_5022' });
  fixture.block('entry');
  fixture.stateRead('base', 'state:sp');
  fixture.constant('zero', 0, { widthBits: 64 });
  fixture.constant('offset', 32, { widthBits: 64 });
  fixture.binary('slot', 'add', 'base', 'zero');
  fixture.binary('pointer', 'add', 'base', 'offset');
  fixture.store('store', 'slot', 'pointer', { widthBits: 64 });
  fixture.load('loaded', 'slot', { widthBits: 64 });
  fixture.values.find((value) => value.id === 'loaded').machineType = {
    kind: 'address', widthBits: 64, addressSpace: 'memory',
  };

  const ir = fixture.ir();
  const cfg = fixture.cfg();
  const ssa = buildSemanticSsa(ir, cfg);
  const snapshotId = 'snapshot-issue-5022-memoryssa';
  const semanticIrDigest = stableDigest(ir);
  const scalarSsaDigest = stableDigest(ssa);
  const identity = {
    binaryId: 'binary_issue_5022',
    sliceId: 'slice_issue_5022',
    functionId: ir.functionId,
    snapshotId,
    semanticIrId: `ir-${semanticIrDigest}`,
    semanticIrContractVersion: ir.contractVersion,
    semanticIrDigest,
    scalarSsaId: `ssa-${scalarSsaDigest}`,
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest,
    memorySsaId: 'mssa-issue-5022',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'issue-5022-fixture',
  };
  const built = fixture.build({
    queryAliasFactory: ({ ir: builtIr, cfg: builtCfg, ssa: builtSsa }) => createPhase7AliasSolver({
      ir: builtIr, cfg: builtCfg, ssa: builtSsa, options: { snapshotId },
    }).queryAlias,
    memorySsaOptions: {
      identity,
      snapshotId,
      canonicalIrIdentity: {
        functionId: ir.functionId,
        semanticIrId: identity.semanticIrId,
        semanticIrContractVersion: ir.contractVersion,
        semanticIrDigest,
      },
    },
  });
  return { ...built, snapshotId };
}

test('#5022 malformed metadata fail-closes before exact MemorySSA spill/reload forwarding', () => {
  const built = spillReloadFixture();
  const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    snapshotId: built.snapshotId,
    memorySsa: built.memorySsa,
  });
  const stored = result.pointsTo.get('pointer');
  const loaded = result.pointsTo.get('loaded');

  assert.equal(stored.top, false);
  assert.equal(loaded.top, false, 'control must exercise exact MemorySSA spill/reload forwarding');
  assert.deepEqual(loaded.targets, stored.targets);
  assert.equal(result.recovery?.proofs?.loaded?.storeNodeId, 'node_store');

  const target = stored.targets[0];
  for (const [malformed, code] of [
    [{ ...target, widthBits: ['64'] }, 'phase7-pointsto-target-invalid-width-bits'],
    [{ ...target, evidenceIds: [[target.evidenceIds[0]]] }, 'phase7-pointsto-target-invalid-evidence-ids'],
  ]) {
    assert.throws(
      () => createPointsToSet({ targets: [malformed] }),
      (error) => error instanceof TypeError && error.message === code,
      `malformed stored-pointer metadata must fail before spill/reload validation (${code})`,
    );
  }
});
