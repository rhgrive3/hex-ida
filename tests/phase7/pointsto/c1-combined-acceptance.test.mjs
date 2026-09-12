import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createFunctionSummary, functionSummaryDigest } from '../../../js/analysis/summary/contract.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf } from '../corpus/fixtures.mjs';
import { callerFixture, finiteSummary, RETURN_KINDS, SNAPSHOT } from '../helpers/c1-acceptance.mjs';

const MEMORY_MODES = Object.freeze(['ordinary', 'unknown-call', 'may-alias', 'width-conflict',
  'endian-conflict', 'atomic', 'volatile', 'copied-memoryssa', 'stale-memoryssa']);

// The declaration supplies the expected roots/offsets; production analysis is
// not used as its own oracle. Incoming arg root identity is queried separately.
for (const kind of RETURN_KINDS) for (const exhaustive of [false, true]) {
  for (const endian of ['little', 'big']) for (const memoryMode of MEMORY_MODES) {
    const name = `C1-01/02 spill ${kind}/${exhaustive ? 'exhaustive' : 'direct'}/${endian}/${memoryMode}`;
    test(name, () => {
      const targets = exhaustive ? ['leaf_a', 'leaf_b'] : ['leaf_a'];
      const summaries = new Map(targets.map((id, index) => [id, finiteSummary(kind, id, index)]));
      const f = callerFixture({ targets, endian, memoryMode });
      const before = structuredClone(f);
      const options = { snapshotId:SNAPSHOT, summaries, memorySsa:f.memorySsa,
        ...(memoryMode === 'stale-memoryssa' ? { memorySsaBinding:{ snapshotId:'old-snapshot' } } : {}) };
      const baseline = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT, summaries });
      assert.equal(baseline.pointsTo.get('loaded').top, true, 'absence of MemorySSA cannot recover a pointer');
      const run = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, options);
      const loaded = run.pointsTo.get('loaded'), field = run.pointsTo.get('field');
      if (memoryMode === 'ordinary') {
        assert.equal(run.status.completeness, 'complete');
        assert.equal(loaded.top, false);
        assert.equal(field.top, false);
        // Two offsets of one incoming arg coalesce into one conservative range.
        const count = kind === 'arg' ? 1 : targets.length;
        assert.equal(loaded.targets.length, count);
        const roots = kind === 'arg' ? [run.pointsTo.get('arg').targets[0].rootEntityId]
          : targets.map((_id, index) => `${kind === 'root' ? 'root' : 'allocation'}_${index}`);
        assert.deepEqual(loaded.targets.map(target => target.rootEntityId).sort(), [...roots].sort());
        for (const target of loaded.targets) {
          const expectedIndex = kind === 'arg' ? 0 : Number(target.rootEntityId.split('_').at(-1));
          assert.equal(target.offsetRange.min, BigInt(16 + 16 * expectedIndex));
          assert.equal(target.offsetRange.max, BigInt(kind === 'arg' && exhaustive ? 32 : 16 + 16 * expectedIndex));
          assert.equal(target.widthBits, 64);
          assert.ok(target.evidenceIds.length > 0);
          const derived = field.targets.find(item => item.rootEntityId === target.rootEntityId);
          assert.equal(derived.offsetRange.min, target.offsetRange.min + 8n);
          assert.equal(derived.offsetRange.max, target.offsetRange.max + 8n);
        }
        for (const summary of summaries.values()) assert.ok(run.calleeSummaryIds.includes(`summary:${functionSummaryDigest(summary)}`));
      } else {
        assert.equal(loaded.top, true, 'incomplete proof must not publish a recovered pointer');
        assert.equal(loaded.targets.length, 0);
        assert.equal(field.top, true, 'downstream field access cannot regain missing provenance');
      }
      const replay = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, options);
      assert.deepEqual(replay.pointsTo.get('loaded'), loaded);
      assert.deepEqual(replay.pointsTo.get('field'), field);
      assert.deepEqual(structuredClone(f), before, 'consumption cannot rewrite the source artifacts');
    });
  }
}

test('C1-03 frozen root corpus retains exact positives and conservative negatives at the canonical consumer', () => {
  assert.equal(ALIAS_QUERIES_V2.length, 30);
  let exact = 0, conservative = 0;
  for (const query of ALIAS_QUERIES_V2) {
    const f = buildFixture(query.fixture);
    const solver = createPhase7AliasSolver({ ir:f.ir, cfg:f.cfg, ssa:f.ssa,
      options:f.rootDescriptors ? { canonicalOptions:{ rootDescriptors:f.rootDescriptors } } : {} });
    const answer = solver.alias(regionOf(f, query.left), regionOf(f, query.right), {
      leftAccess:memoryAccessOf(f, query.left), rightAccess:memoryAccessOf(f, query.right),
    });
    if (['no', 'must'].includes(query.truth)) { assert.equal(answer.relation, query.truth, query.id); exact++; }
    else { assert.ok(['may', 'unknown'].includes(answer.relation), query.id); conservative++; }
    const reverse = solver.alias(regionOf(f, query.right), regionOf(f, query.left), {
      leftAccess:memoryAccessOf(f, query.right), rightAccess:memoryAccessOf(f, query.left),
    });
    assert.equal(reverse.relation, answer.relation, `${query.id} symmetry`);
  }
  assert.equal(exact, 15); assert.equal(conservative, 15);
});

test('C1 combined cancellation and iteration limits withhold recovered field pointers', () => {
  const f = callerFixture();
  const summaries = new Map([['leaf_a', finiteSummary('root', 'leaf_a')]]);
  for (const options of [{ signal:AbortSignal.abort() }, { budget:{ maxIterations:1 } }]) {
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT, memorySsa:f.memorySsa, summaries, ...options });
    assert.notEqual(result.status.completeness, 'complete');
    for (const id of ['loaded', 'field']) assert.equal(result.pointsTo.get(id)?.top, true);
  }
});

for (const argumentBits of [32, 64]) for (const offset of [0, 16]) {
  test(`C1-01/02 arg-return representation ${argumentBits}-to-64/offset-${offset}`, () => {
    const f = callerFixture({ argumentBits });
    const declared = finiteSummary('arg', 'leaf_a');
    const summary = createFunctionSummary({ ...declared,
      returnProvenance:declared.returnProvenance.map(fact => ({ ...fact, offset:String(offset) })) });
    const result = analyzeLocalPointsTo(f.ir, f.cfg, f.ssa, { snapshotId:SNAPSHOT,
      memorySsa:f.memorySsa, summaries:new Map([['leaf_a', summary]]) });
    const returned = result.pointsTo.get('returned'), loaded = result.pointsTo.get('loaded');
    assert.equal(returned.top, false, 'finite root identity and representation width are separate facts');
    const callResult = f.ir.values.find(value => value.id === 'returned');
    for (const id of callResult.origin.instructionIds) assert.ok(returned.targets[0].evidenceIds.includes(id));
    if (argumentBits === 64) {
      assert.equal(returned.targets[0].widthBits, 64);
      assert.equal(loaded.top, false);
      assert.equal(loaded.targets[0].offsetRange.min, BigInt(offset));
    } else {
      assert.notEqual(returned.targets[0].widthBits, 64, 'a narrow argument cannot attest a wide returned pointer');
      assert.equal(loaded.top, true);
      assert.deepEqual(loaded.targets, []);
      assert.equal(result.pointsTo.get('field').top, true);
    }
  });
}
