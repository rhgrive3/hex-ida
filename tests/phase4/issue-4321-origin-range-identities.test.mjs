import assert from 'node:assert/strict';
import test from 'node:test';
import { createOriginSet, mergeOriginSets, createTransformRecord } from '../../js/core/identity/origin.js';

const cases = [
  { list: 'byteRanges', field: 'binaryId', range: { offset: 0n, length: 4n }, code: 'origin-invalid-byte-range' },
  { list: 'virtualRanges', field: 'imageId', range: { address: 0x1000n, length: 4n }, code: 'origin-invalid-virtual-range' },
  { list: 'virtualRanges', field: 'sliceId', range: { address: 0x1000n, length: 4n }, code: 'origin-invalid-virtual-range' },
];

for (const { list, field, range, code } of cases) {
  test(`${field} rejects blank and structured range identities`, () => {
    let coercions = 0;
    for (const value of ['', ' ', '\t\r\n', '\u00a0', 0, false, ['id'], { toString() { coercions++; return 'id'; } }]) {
      assert.throws(() => createOriginSet({ [list]: [{ ...range, [field]: value }] }), { name: 'TypeError', message: code });
    }
    assert.equal(coercions, 0);
  });
  test(`${field} remains optional but normalizes present identity like other core IDs`, () => {
    for (const value of [null, undefined]) {
      const origin = createOriginSet({ [list]: [{ ...range, [field]: value }] });
      assert.equal(Object.hasOwn(origin[list][0], field), false);
    }
    const canonical = createOriginSet({ [list]: [{ ...range, [field]: 'id' }] });
    const padded = createOriginSet({ [list]: [{ ...range, [field]: ' id ' }] });
    assert.deepEqual(padded, canonical);
    assert.equal(Object.isFrozen(canonical[list][0]), true);
    assert.equal(createOriginSet(canonical), canonical);
    assert.equal(mergeOriginSets(canonical, padded)[list].length, 1);
    assert.deepEqual(createOriginSet(JSON.parse(JSON.stringify(canonical))), canonical);
  });
}

test('range identity hardening leaves transform display metadata unchanged', () => {
  const transform = createTransformRecord({ passId: 'p', passVersion: '1', ruleId: 'r', proofKind: 'test', timestampOrBuildId: '' });
  assert.equal(transform.timestampOrBuildId, '');
});
