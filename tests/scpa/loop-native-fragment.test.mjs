import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArm64ScalarLoop, checkArm64ScalarLoop } from '../../js/core/evidence/arm64-loop-fragment.js';
import { synthesizeScalarLoopInvariant } from '../../js/core/evidence/loop-synthesis.js';
import { fixture, workFor } from './helpers.mjs';
import { queryLoopInvariant } from '../../js/analysis/query/semantic/loop-evidence.js';
import { replayPortableChecks } from '../../js/core/evidence/portable-replay.js';

function bytes({ bits = 64, entry = 0, limit = 10, step = 1, condition = 2, register = 0 } = {}) {
  const width = bits === 64 ? 0x80000000 : 0;
  const words = [(width | 0x52800000 | (entry << 5) | register) >>> 0,
    (width | 0x7100001f | (limit << 10) | (register << 5)) >>> 0,
    (0x54000060 | condition) >>> 0,
    (width | 0x11000000 | (step < 0 ? 0x40000000 : 0) | (Math.abs(step) << 10) | (register << 5) | register) >>> 0,
    0x17fffffd, 0xd65f03c0];
  const result = new Uint8Array(24), view = new DataView(result.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true)); return result;
}
const iv = (lower, upper = lower) => ({ lower: String(lower), upper: String(upper) });
function check(t, data, post) {
  const profile = fixture().world.profile, work = workFor(t), extracted = extractArm64ScalarLoop(data, { profile, work });
  assert.equal(extracted.status, 'correspondence-checked');
  const synthesis = synthesizeScalarLoopInvariant(extracted.model, post, { work });
  assert.equal(synthesis.status, 'candidate-checked');
  return checkArm64ScalarLoop(data, extracted.model, synthesis.candidate, { profile, work });
}
test('native counted loop independently connects entry, NZCV branch, backedge, induction and exit', t => {
  const r = check(t, bytes(), iv(10));
  assert.equal(r.status, 'verified-fragment'); assert.ok(Object.values(r.obligations).every(Boolean));
  assert.equal(r.induction.ranking.maximumIterations, '10');
  assert.deepEqual(r.flags, { kind: 'a64-subtract-nzcv', bits: 64, left: { kind: 'exit-register', register: 'x0' }, right: '10' });
  assert.equal(r.wholeFunctionProof, false); assert.equal(r.rewriteAuthorized, false);
});
for (const bits of [32, 64]) test(`native ${bits}-bit descending loop preserves explicit unsigned semantics`, t => {
  assert.equal(check(t, bytes({ bits, entry: 10, limit: 0, step: -1, condition: 9, register: 7 }), iv(0)).status, 'verified-fragment');
});
test('HI and LO exit conditions retain their strict unsigned endpoints', t => {
  assert.equal(check(t, bytes({ limit: 9, condition: 8 }), iv(10)).status, 'verified-fragment');
  assert.equal(check(t, bytes({ entry: 10, limit: 1, step: -1, condition: 3 }), iv(0)).status, 'verified-fragment');
});
test('finite execution oracle agrees for 800 independently simulated counted loops', t => {
  const profile = fixture().world.profile, work = workFor(t, { workUnits: 300000 });
  for (const bits of [32, 64]) for (let entry = 0; entry < 10; entry++) for (let limit = 1; limit <= 10; limit++) for (let step = 1; step <= 4; step++) {
    // Scalar oracle implements the source while-condition, not checker intervals
    // or decoder helpers. Every concrete execution must lie in the proved post.
    let value = entry, iterations = 0;
    while (value < limit) { value += step; iterations++; assert.ok(iterations <= 20); }
    const data = bytes({ bits, entry, limit, step }), { model } = extractArm64ScalarLoop(data, { profile, work });
    const post = entry >= limit ? iv(entry) : iv(limit, limit + step - 1);
    const { candidate } = synthesizeScalarLoopInvariant(model, post, { work });
    assert.ok(candidate); const r = checkArm64ScalarLoop(data, model, candidate, { profile, work });
    assert.equal(r.status, 'verified-fragment'); assert.ok(value >= Number(post.lower) && value <= Number(post.upper));
    assert.ok(iterations <= Number(r.induction.ranking.maximumIterations ?? '0'));
  }
});
for (const [name, offset, word] of [
  ['memory instruction', 12, 0xf9000000], ['flag-setting update', 12, 0xb1000400],
  ['wrong backedge', 16, 0x17fffffe], ['wrong exit branch', 8, 0x54000082],
  ['signed condition', 8, 0x5400006a], ['other compared register', 4, 0xf100283f],
  ['wrong width', 4, 0x7100281f], ['indirect exit', 20, 0xd61f0000], ['SP initialization', 0, 0xd280001f],
]) test(`native loop rejects unsupported ${name} without treating it as an inert instruction`, t => {
  const data = bytes(); new DataView(data.buffer).setUint32(offset, word, true);
  const r = extractArm64ScalarLoop(data, { profile: fixture().world.profile, work: workFor(t) }); assert.equal(r.status, 'unknown');
});
test('mutated transition model cannot borrow byte correspondence or termination', t => {
  const data = bytes(), profile = fixture().world.profile, work = workFor(t), r = extractArm64ScalarLoop(data, { profile, work });
  const model = structuredClone(r.model); model.step = '2';
  assert.equal(checkArm64ScalarLoop(data, model, { invariant: iv(0, 11), postcondition: iv(10, 11) }, { profile, work }).status, 'rejected');
});
test('zero step never yields total fragment completion', t => {
  assert.equal(check(t, bytes({ step: 0 }), iv(10)).status, 'unknown');
});

function nativeContext(f) {
  const source = { binaryId: f.world.binarySet[0].binaryId, offset: '64', virtualStart: '4096', length: 24 };
  return { isCurrent: () => true, nativeSource: source, binding: { worldId: f.world.id, assumptionsId: f.assumptions.id,
    snapshotId: 'snap', functionLocator: '0x1000', loopId: 'loop', modelRevision: 'native-v1', artifactId: 'artifact', sourceReferences: ['function-entry'] },
    readNativeBytes: async () => ({ worldId: f.world.id, snapshotId: 'snap', ...source, bytes: bytes() }) };
}
const query = { functionId: '0x1000', loopId: 'loop', synthesize: true, postcondition: iv(10) };
const options = (t, f, context) => ({ ...f, snapshotId: 'snap', work: workFor(t), getContext: async () => context, isCurrent: () => true });
test('live loop query extracts its own model from current host bytes and replays a detached capsule', async t => {
  const f = fixture(), context = nativeContext(f), r = await queryLoopInvariant(query, options(t, f, context));
  assert.equal(r.nativeChecked.status, 'verified-fragment'); assert.equal(r.checked.status, 'verified-model');
  assert.equal(r.sourceBinding, 'current-source-bytes-and-independent-fragment-correspondence');
  const detached = await replayPortableChecks(r.capsule, { work: workFor(t) });
  assert.equal(detached.checks[0].status, 'verified-fragment'); assert.equal(detached.allListedDerivationsChecked, true);
  assert.equal(detached.sourceBinding, 'detached-unverified'); assert.equal(detached.semanticProof, false);
  const rebound = await queryLoopInvariant({ ...query, capsule: r.capsule }, options(t, f, context));
  assert.equal(rebound.capsuleRebound, true);
});
test('current source replacement cannot reuse a previously exported native loop capsule', async t => {
  const f = fixture(), context = nativeContext(f), r = await queryLoopInvariant(query, options(t, f, context));
  const reader = context.readNativeBytes;
  context.readNativeBytes = async () => ({ ...await reader(), bytes: bytes({ limit: 11 }) });
  const rebound = await queryLoopInvariant({ ...query, capsule: r.capsule }, options(t, f, context));
  assert.equal(rebound.status, 'rejected'); assert.equal(rebound.capsuleRebound, false);
});
test('detached native capsule mutants cannot borrow the model proof or checker version', async t => {
  const f = fixture(), r = await queryLoopInvariant(query, options(t, f, nativeContext(f)));
  const changed = structuredClone(r.capsule);
  changed.nativeFragment.bytesHex = [...bytes({ step: 2 })].map(n => n.toString(16).padStart(2, '0')).join('');
  const refuted = await replayPortableChecks(changed, { work: workFor(t) });
  assert.equal(refuted.checks[0].status, 'rejected'); assert.equal(refuted.allListedDerivationsChecked, false);
  const version = structuredClone(r.capsule); version.nativeFragment.checkerVersion = 'unknown';
  assert.equal((await replayPortableChecks(version, { work: workFor(t) })).counts.unknown, 1);
  const source = structuredClone(r.capsule); source.nativeFragment.source.virtualStart = '4097';
  await assert.rejects(replayPortableChecks(source, { work: workFor(t) }), /portable-loop-native-address-range/);
});
for (const field of ['worldId', 'snapshotId', 'binaryId', 'offset', 'virtualStart']) test(`native host byte ${field} mismatch fails before publication`, async t => {
  const f = fixture(), context = nativeContext(f), reader = context.readNativeBytes;
  context.readNativeBytes = async () => ({ ...await reader(), [field]: 'foreign' });
  await assert.rejects(queryLoopInvariant(query, options(t, f, context)), /loop-native-byte-response-binding/);
});
test('native provider ignores query-supplied bytes and honors retirement and cancellation', async t => {
  const f = fixture(), context = nativeContext(f), reader = context.readNativeBytes;
  await assert.rejects(queryLoopInvariant({ ...query, nativeSource: context.nativeSource }, options(t, f, context)), /loop-query-fields/);
  context.readNativeBytes = async () => { context.isCurrent = () => false; return reader(); };
  await assert.rejects(queryLoopInvariant(query, options(t, f, context)), /loop-native-source-stale/);
});
