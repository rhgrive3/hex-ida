import test from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY_REUSE_BUDGETS as budget } from '../../js/core/identity/reuse-budgets.js';
import { canonicalAnalysisIdentity as current } from '../../js/decompiler/phase8/analysis-identity.js';
import { canonicalAnalysisIdentity as original } from '../helpers/mobile-final-baseline/js/decompiler/phase8/analysis-identity.js';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { stableStringify, stableDigest, deepFreeze } from '../../js/core/identity/index.js';
import { stableStringify as oldStringify, stableDigest as oldDigest } from '../helpers/mobile-final-baseline/js/core/identity/index.js';
import { isDeeplyFrozenPlainData } from '../../js/core/identity/immutable-data.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

function graph(label, origins, size = 3) {
  const f = fixture(label); f.block(0);
  for (let i = 0; i < size; i++) f.constant(BigInt(i), 32);
  f.ret(); const ir = f.build(); let index = 0;
  ir.origin = origins[index++ % origins.length];
  for (const block of ir.blocks) {
    block.origin = origins[index++ % origins.length];
    for (const inst of block.insts) inst.origin = origins[index++ % origins.length];
  }
  for (const value of ir.values) value.origin = origins[index++ % origins.length];
  return ir;
}
function compare(ir) {
  const expected = original({ ir }), actual = current({ ir });
  assert.deepEqual(actual, expected);
  assert.equal(actual.valid, true);
  return actual;
}

test('mobile final: reuse policy has explicit small per-realm and per-request ceilings', () => {
  const payload = ['immutableDigest', 'immutableJson', 'frozenIdentityText', 'graphDigest']
    .reduce((sum, key) => sum + budget[key].bytes, 0);
  assert.ok(payload <= 896 * 1024);
  assert.ok(budget.immutableMetadataEntries + budget.frozenMetadataEntries <= 24576);
  assert.ok(budget.originTableNodes <= 1024);
  assert.ok(budget.passiveText.bytes <= 256 * 1024);
  assert.ok(budget.passiveText.entries <= 1024);
  assert.ok(Object.isFrozen(budget));
  for (const value of Object.values(budget)) {
    if (typeof value === 'object') assert.ok(Object.isFrozen(value));
  }
});

test('mobile final: eviction with many live immutable keys never changes a digest', () => {
  const values = Array.from({ length: 5500 }, (_, i) => {
    const value = deepFreeze({ index: i, label: `live-${i}`, payload: '日本語'.repeat(32) });
    assert.equal(isDeeplyFrozenPlainData(value), true);
    stableDigest(value);
    return value;
  });
  for (const i of [0, 1, 510, 1024, 4095, 4096, 5499]) {
    assert.equal(stableStringify(values[i]), oldStringify(values[i]));
    assert.equal(stableDigest(values[i]), oldDigest(values[i]));
  }
});

test('mobile final: origin-table generation churn preserves prefixes and earlier live sequences', () => {
  const origins = Array.from({ length: 1250 }, (_, i) => createOriginSet({ instructionIds: [`live:${i}`] }));
  const first = graph('sequence-first', origins.slice(0, 4));
  const before = compare(first);
  for (let i = 4; i < origins.length; i += 4) compare(graph(`sequence-${i}`, origins.slice(i, i + 4)));
  assert.deepEqual(compare(first), before);
  compare(graph('sequence-reverse', origins.slice(0, 4).reverse()));
  compare(graph('sequence-prefix', origins.slice(0, 2)));
});

test('mobile final: oversized origin sequences bypass retention without truncating identity', () => {
  const origins = Array.from({ length: budget.originTableNodes + 8 }, (_, i) => createOriginSet({ instructionIds: [`wide:${i}`] }));
  const ir = graph('oversized-table', origins, origins.length);
  const before = compare(ir);
  ir.values.at(-1).origin = createOriginSet({ instructionIds: ['wide:changed-last'] });
  assert.notDeepEqual(compare(ir).identity, before.identity);
});

test('mobile final: large shared and nested metadata retain exact typed spelling across text limits', () => {
  const ir = graph('bounded-passive-text', [createOriginSet({ instructionIds: ['large'] })]);
  const shared = { value: 'あ😀'.repeat(5000), signed: -0, big: 18446744073709551617n };
  let deep = shared;
  for (let i = 0; i < 96; i++) deep = { child: deep, tag: `depth:${i}` };
  const metadata = { deep, repeated: Array(20).fill(shared), sparse: Object.assign([1, , 3], { extra: 'kept' }) };
  for (const value of ir.values) value.def.extra.metadata = metadata;
  const before = compare(ir);
  metadata.sparse[1] = undefined;
  assert.notDeepEqual(compare(ir).identity, before.identity);
  shared.value += 'mutation';
  compare(ir);
});

test('mobile final: per-call text accounting cannot invoke inherited counter accessors', () => {
  const ir = graph('counter-descriptors', [createOriginSet({ instructionIds: ['counters'] })]);
  const expected = compare(ir);
  try {
    for (const key of ['payloadBytes', 'entryCount']) Object.defineProperty(Object.prototype, key, {
      configurable: true, get() { throw new Error('inherited counter must not be read'); },
    });
    assert.deepEqual(current({ ir }), expected);
  } finally {
    delete Object.prototype.payloadBytes;
    delete Object.prototype.entryCount;
  }
});
