import test from 'node:test';
import assert from 'node:assert/strict';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { checkBitvectorViewRelation } from '../../js/core/evidence/bv-view-proof.js';
import { checkMemoryViewFrame, MEMORY_VIEW_FRAME_SCHEMA } from '../../js/core/evidence/memory-transform-frame.js';
import { checkNativeTransformRelation, explainNativeTransformProjection } from '../../js/core/evidence/native-transform.js';
import { beginScopedTransformCapture, finishScopedTransformCapture } from '../../js/decompiler/phase8/scoped-transform-capture.js';
import { decompileScopedCanonicalOwner } from '../../js/analysis/semantic-function.js';
import { projectScopedTransformOwners } from '../../js/analysis/scoped-transform-projection.js';
import { captured, scope } from './native-owner-fixture.mjs';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
import { workFor } from './helpers.mjs';
const variable = (bits = 64) => expr.variable('x', bits, false, { ssaDefs: [1] }, { ssaId: 1, range: null });
const cast = (op, arg, bits, signed = false) => expr.unary(op, arg, bits, signed, null, { fromBits: arg.bits });
const nested = root => cast('trunc', cast('trunc', root, 32), 8);
const collapsed = root => cast('trunc', root, 8);
const result = (expression, text = 'return x;') => ({ semanticAst: { conditions: [] }, lines: [{ text }],
  cAst: { body: [{ kind: 'statement', text, source: { rows: [0] }, semantic: { op: 'return', expression } }] } });
const relation = (before, after) => finishScopedTransformCapture(beginScopedTransformCapture(result(before), true), result(after, 'return y;')).relations[0];
function frame() {
  const f = { version: 'v1', functionId: 'f', entities: [{ definition: 'store-v1', size: 1, volatile: true }],
    accesses: [{ offset: 1n, width: 8, endian: 'little' }], effects: [{ event: 'load', mayFault: true }],
    control: [{ exceptionalSuccessor: 'fault' }] };
  return { schema: MEMORY_VIEW_FRAME_SCHEMA, worldId: 'w', snapshotId: 's', functionId: 'f',
    before: f, after: structuredClone(f), unknowns: [], scope: 'phase8-expression-view-only' };
}
const frameContext = { worldId: 'w', snapshotId: 's', functionId: 'f' };
function relationContext(r, memoryFrame = frame()) {
  return { ...frameContext, memoryFrame, finalStatements: [{ index: 0, text: r.afterStatement.text,
    statementKind: 'return', source: r.afterStatement.source, location: null }] };
}

test('independent bit-view checker covers nested truncations across widths and concrete witnesses', () => {
  for (const bits of [8, 16, 32, 64, 128]) for (const mid of [4, 8, 16, 32, 64, 128].filter(x => x <= bits)) {
    const out = Math.min(4, mid), root = variable(bits);
    const a = cast('trunc', cast('trunc', root, mid), out), b = cast('trunc', root, out);
    assert.equal(checkBitvectorViewRelation(a, b).status, 'verified');
    for (const n of [0n, 1n, -1n, (1n << BigInt(bits - 1)), (1n << BigInt(bits)) - 1n]) {
      assert.equal(BigInt.asUintN(out, BigInt.asUintN(mid, n)), BigInt.asUintN(out, n));
    }
  }
});
test('extension-under-truncation and composed integer conditions are independently checked', () => {
  const x = variable(8);
  const before = cast('trunc', cast('zext', x, 64), 32), after = cast('zext', x, 32);
  assert.equal(checkBitvectorViewRelation(before, after).status, 'verified');
  const c = expr.constant(7n, 32, false);
  assert.equal(checkBitvectorViewRelation(expr.compare('<', before, c, false), expr.compare('<', after, c, false)).status, 'verified');
  const y = variable(64);
  assert.equal(checkBitvectorViewRelation(cast('trunc', cast('sext', cast('trunc', y, 8), 64), 4), cast('trunc', y, 4)).status, 'verified');
});
for (const [name, mutate] of Object.entries({
  width: x => { x.bits = 16; }, signed: x => { x.signed = true; },
  fromBits: x => { x.fromBits = 32; }, flags: x => { x.flags = 'changed'; },
  trap: x => { x.mayTrap = true; }, operator: x => { x.op = 'divide'; },
  input: x => { x.arg.name = 'other'; }, ssa: x => { x.arg.ssaId = 9; },
  lineage: x => { x.arg.source.ssaDefs = [8]; }, effect: x => { x.effect = 'volatile'; },
})) test(`view checker never verifies ${name} mutant`, () => {
  const a = nested(variable()), b = collapsed(variable()); mutate(b);
  assert.notEqual(checkBitvectorViewRelation(a, b).status, 'verified');
});
test('unknown operators and FP comparisons remain UNKNOWN rather than semantic counterexamples', () => {
  const fp = expr.compare('==', expr.floatConstant(1), expr.floatConstant(1));
  const r = checkBitvectorViewRelation(fp, fp); assert.equal(r.status, 'unknown'); assert.equal(r.semanticCounterexample, false);
  const divide = expr.binary('/', variable(), variable()); assert.equal(checkBitvectorViewRelation(divide, divide).status, 'unknown');
});
test('unsupported extra fields, cycles and oversized input cannot evade expression bounds', () => {
  const a = variable(); a.arg = a; assert.throws(() => checkBitvectorViewRelation(a, a));
  const b = variable(129); assert.equal(checkBitvectorViewRelation(b, b).status, 'unknown');
  const c = variable(); c.name = 'x'.repeat(257); assert.equal(checkBitvectorViewRelation(c, c).status, 'unknown');
});
test('proof work cancellation/budget is not swallowed as UNKNOWN', t => {
  const work = workFor(t, { workUnits: 0 });
  assert.throws(() => checkBitvectorViewRelation(nested(variable()), collapsed(variable()), { work }), e => e.code === 'budget-exhausted');
});
test('memory view proof requires full frame and preserves volatile/faulting load events', () => {
  const load = expr.load({ key: 'p', size: 8 }, 64, { ssaDefs: [3] }, { volatile: true, memoryVersion: 'm1', mayFault: true });
  const r = relation(nested(load), collapsed(load));
  assert.equal(checkBitvectorViewRelation(r.before, r.after).reason, 'memory-frame-required');
  assert.equal(checkNativeTransformRelation(r, relationContext(r)).status, 'verified');
  assert.notEqual(checkNativeTransformRelation(r, relationContext(r, null)).status, 'verified');
});
for (const [name, mutate] of Object.entries({
  'partial-store-width': x => { x.after.entities[0].size = 2; },
  'byte-offset': x => { x.after.accesses[0].offset = 2n; },
  'offset-type': x => { x.after.accesses[0].offset = '1'; },
  endian: x => { x.after.accesses[0].endian = 'big'; },
  volatile: x => { x.after.entities[0].volatile = false; },
  fault: x => { x.after.effects[0].mayFault = false; },
  exception: x => { x.after.control[0].exceptionalSuccessor = 'normal'; },
  clobber: x => { x.unknowns = ['unknown-call-clobber']; },
  stale: x => { x.snapshotId = 'other'; },
})) test(`memory frame cannot verify ${name} mutant`, () => {
  const f = frame(); mutate(f); assert.notEqual(checkMemoryViewFrame(f, frameContext).status, 'verified');
});
test('load events cannot be removed, reordered, widened or made nonvolatile', () => {
  const a = expr.load({ key: 'p' }, 64, null, { volatile: true, memoryVersion: 'm1' });
  const b = expr.load({ key: 'q' }, 64, null, { volatile: true, memoryVersion: 'm2' });
  const before = expr.binary('&', a, b, 64);
  for (const after of [a, expr.binary('&', b, a, 64), expr.binary('&', { ...a, volatile: false }, b, 64)]) {
    assert.notEqual(checkBitvectorViewRelation(before, after, { allowMemory: true }).status, 'verified');
  }
});
test('capture is opt-in, immutable and rejects ambiguous condition mapping', () => {
  const a = result(nested(variable())); assert.equal(beginScopedTransformCapture(a, false), null);
  const start = beginScopedTransformCapture(a, true); a.cAst.body[0].semantic.expression = collapsed(variable());
  const out = finishScopedTransformCapture(start, a); assert.equal(out.relations.length, 1); assert.equal(Object.isFrozen(out), true);
  const condition = expr.compare('==', nested(variable()), expr.constant(1n, 8));
  const ambiguous = { semanticAst: { conditions: [{ row: 0, expression: condition }, { row: 0, expression: condition }] },
    lines: [], cAst: { body: [{ text: 'if (x) {', kind: 'if', source: { rows: [0] } }] } };
  const capture = finishScopedTransformCapture(beginScopedTransformCapture(ambiguous, true), ambiguous);
  assert.deepEqual(capture.relations, []); assert.ok(capture.remaining.includes('condition-mapping-ambiguous'));
});
for (const [name, mutate] of Object.entries({
  index: r => { r.statementIndex = 1; }, kind: r => { r.afterStatement.statementKind = 'store'; },
  source: r => { r.afterStatement.source.rows = [99]; }, location: r => { r.afterStatement.location = { key: 'other' }; },
  expression: r => { r.afterStatement.expression = expr.constant(0n); },
})) test(`final statement map rejects ${name} mutant`, () => {
  const r = structuredClone(relation(nested(variable()), collapsed(variable()))), c = relationContext(r);
  mutate(r); assert.equal(checkNativeTransformRelation(r, c).status, 'rejected');
});
test('canonical decompiler does not accept a serialized owner as authority', () => {
  assert.throws(() => decompileScopedCanonicalOwner({ pipeline: {} }, { scopedTransformEvidence: true }), /issued-owner/);
});
test('actual native worker route captures and checks a real ARM64 view transformation without upgrading partial cache eligibility', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': [['uxtb', 'w0, w0', 0x53001c00], ['ret', '', 0xd65f03c0]] } });
  const r = await f.invoke('explainTransformChain', { functionId: '0x1000' });
  assert.equal(r.status, 'completed'); assert.equal(r.verifiedStatementCount, 1); assert.equal(r.exact, false);
  assert.equal(r.wholeFunctionProof, false); assert.equal(r.releaseQualified, false);
  assert.match(r.statements[0].beforeText, /uint32_t/); assert.doesNotMatch(r.statements[0].afterText, /uint32_t/);
  assert.equal(r.statements[0].chain.minimumCheck, 'derivation-checked');
  const workers = f.counters.workers; const again = await f.invoke('explainTransformChain', { functionId: '0x1000', includePremises: true });
  assert.equal(again.statements[0].chain.id, r.statements[0].chain.id); assert.equal(f.counters.workers, workers + 1, 'partial artifacts are intentionally recomputed by the canonical scheduler');
  await assert.rejects(() => f.invoke('explainTransformChain', { functionId: '0x1000', includePremises: 'yes' }), /premises-option/);
});
test('native capture binds artifact/world and honors work stop before publication', async t => {
  const f = scope(), { owner, result: semantic } = captured(0x1000n, [['uxtb', 'w0, w0', 0x53001c00], ['ret', '', 0xd65f03c0]]);
  const request = { kind: 'transforms', ...f, worldId: f.world.id, snapshotId: 'snap', producerArtifactId: 'artifact' };
  const view = await projectScopedTransformOwners(owner, semantic, request, { limits: { deadlineMs: 10000 } });
  assert.ok(view.capture.relations.length);
  const ctx = { ...f, snapshotId: 'snap', functionId: owner.pipeline.functionId, producerArtifactId: 'artifact', isCurrent: () => true, work: workFor(t) };
  await assert.rejects(() => explainNativeTransformProjection({ ...view, producerArtifactId: 'forged' }, ctx), /projection-binding/);
  await assert.rejects(() => explainNativeTransformProjection(view, { ...ctx, isCurrent: () => false }), /owner-stale/);
  await assert.rejects(() => projectScopedTransformOwners(owner, semantic, request, { work: workFor(t, { workUnits: 0 }) }), e => e.code === 'budget-exhausted');
});
test('native memory-view capture retains open canonical clobber/fault obligations instead of promoting a cast identity', async t => {
  const f = await nativeWorkerFixture(t, { rowsByLocator: { '0x1000': [['ldr', 'x0, [x1]', 0xf9400020],
    ['uxtb', 'w0, w0', 0x53001c00], ['ret', '', 0xd65f03c0]] } });
  const r = await f.invoke('explainTransformChain', { functionId: '0x1000', includePremises: true });
  assert.equal(r.statements.length, 1); assert.equal(r.verifiedStatementCount, 0);
  assert.equal(r.statements[0].chain.status, 'unknown'); assert.equal(r.exact, false);
  assert.ok(r.remaining.includes('open-memory-clobber-or-exception'));
  assert.equal(r.statements[0].chain.checks[0].reason, 'open-memory-clobber-or-exception');
});
test('native transform production stops within the pass budget without yielding a partial proof', async t => {
  const f = scope(), { owner, result: semantic } = captured(0x1000n, [['uxtb', 'w0, w0', 0x53001c00], ['ret', '', 0xd65f03c0]]);
  const request = { kind: 'transforms', ...f, worldId: f.world.id, snapshotId: 'snap', producerArtifactId: 'artifact' };
  for (const workUnits of [1, 2, 4, 8, 16]) await assert.rejects(() => projectScopedTransformOwners(owner, semantic, request,
    { work: workFor(t, { workUnits }) }), e => e.code === 'budget-exhausted');
});
