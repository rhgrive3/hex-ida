import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearFieldAccessArtifacts,
  fieldAccessRegion,
} from '../../js/analysis/field-access-artifact.js';

const REGION = Object.freeze({ id:'text' });

function completeResult(source = 'ok') {
  return { results:[{ source }], complete:true };
}

function backendSpy() {
  const calls = [];
  const backend = {
    analysisEpoch:1,
    fieldAccess(params) {
      calls.push(params);
      return Promise.resolve(completeResult(`call-${calls.length}`));
    },
  };
  return { backend, calls };
}

test('field-access canonicalizes allowed numeric forms once for request and cache identity', async (t) => {
  const { backend, calls } = backendSpy();
  t.after(() => clearFieldAccessArtifacts(backend));

  const first = await fieldAccessRegion(backend, REGION, 16, 4n);
  const second = await fieldAccessRegion(backend, REGION, 16n, 4);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { regionId:'text', offset:16n, size:4 });
  assert.equal(first, second);
  assert.equal(second.results[0].source, 'call-1');
});

test('structured region/offset/size values cannot alias canonical field-access requests', async (t) => {
  const { backend, calls } = backendSpy();
  t.after(() => clearFieldAccessArtifacts(backend));

  for (const [label, region, offset, size] of [
    ['region array', { id:['text'] }, 16n, 4],
    ['region object', { id:{ toString:() => 'text' } }, 16n, 4],
    ['offset array', REGION, ['16'], 4],
    ['offset object', REGION, { valueOf:() => 16 }, 4],
    ['offset boolean', REGION, true, 4],
    ['size array', REGION, 16n, [4]],
    ['size object', REGION, 16n, { valueOf:() => 4 }],
    ['size boolean', REGION, 16n, true],
  ]) {
    assert.throws(() => fieldAccessRegion(backend, region, offset, size), TypeError, label);
  }

  assert.equal(calls.length, 0);
  const canonical = await fieldAccessRegion(backend, REGION, 16n, 4);
  assert.equal(calls.length, 1);
  assert.equal(canonical.results[0].source, 'call-1');
});

test('field-access validation does not execute caller coercion hooks', () => {
  const { backend, calls } = backendSpy();
  let coercions = 0;
  const hostile = {
    [Symbol.toPrimitive]() { coercions += 1; return 16; },
    valueOf() { coercions += 1; return 16; },
    toString() { coercions += 1; return '16'; },
  };

  assert.throws(() => fieldAccessRegion(backend, { id:hostile }, 16n, 4), TypeError);
  assert.throws(() => fieldAccessRegion(backend, REGION, hostile, 4), TypeError);
  assert.throws(() => fieldAccessRegion(backend, REGION, 16n, hostile), TypeError);
  assert.equal(coercions, 0);
  assert.equal(calls.length, 0);
});

test('field-access rejects lossy numeric boundaries while preserving exact bigint offsets', async (t) => {
  const { backend, calls } = backendSpy();
  t.after(() => clearFieldAccessArtifacts(backend));

  for (const [label, offset, size] of [
    ['unsafe number offset', Number.MAX_SAFE_INTEGER + 1, 4],
    ['fractional offset', 1.5, 4],
    ['NaN offset', Number.NaN, 4],
    ['unsafe number size', 0n, Number.MAX_SAFE_INTEGER + 1],
    ['oversized bigint size', 0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ['negative size', 0n, -1],
    ['fractional size', 0n, 1.5],
    ['numeric string size', 0n, '4'],
  ]) {
    assert.throws(() => fieldAccessRegion(backend, REGION, offset, size), TypeError, label);
  }

  const largeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 123n;
  await fieldAccessRegion(backend, REGION, largeOffset, null);
  assert.deepEqual(calls[0], { regionId:'text', offset:largeOffset, size:0 });
});
