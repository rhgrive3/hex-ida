import assert from 'node:assert/strict';
import { createPatternProducer } from '../../../js/analysis/discovery/producers.js';

function producer(overrides = {}) {
  return createPatternProducer({
    id: 'pattern-test',
    architectureId: 'arm64',
    patterns: [{ id:'p0', bytes:[0xaa, 0xbb], mask:[0xff, 0xff] }],
    ...overrides,
  });
}

assert.equal(producer().id, 'pattern-test');
assert.equal(producer().architectureId, 'arm64');

for (const bad of [['pattern-test'], 1, true, { toString(){ return 'pattern-test'; } }, '']) {
  assert.throws(() => producer({ id:bad }), /discovery-pattern-invalid-id/);
}
for (const bad of [['arm64'], 1, true, { toString(){ return 'arm64'; } }, '']) {
  assert.throws(() => producer({ architectureId:bad }), /discovery-pattern-invalid-architecture-id/);
}
for (const bad of [['p0'], 1, true, { toString(){ return 'p0'; } }, '']) {
  assert.throws(() => producer({ patterns:[{ id:bad, bytes:[0xaa] }] }), /discovery-pattern-invalid-id/);
}

const sparse = new Array(2);
sparse[1] = 0xbb;
for (const badBytes of [
  '170,187',
  [0xaa, '187'],
  [0xaa, true],
  [0xaa, -1],
  [0xaa, 256],
  [0xaa, 1.5],
  sparse,
  [],
]) {
  assert.throws(() => producer({ patterns:[{ id:'p0', bytes:badBytes }] }), /discovery-pattern-invalid-bytes/);
}
for (const badMask of [
  '255,255',
  [0xff, '255'],
  [0xff, true],
  [0xff, -1],
  [0xff, 256],
  new Array(2),
  [],
]) {
  assert.throws(() => producer({ patterns:[{ id:'p0', bytes:[0xaa, 0xbb], mask:badMask }] }), /discovery-pattern-invalid-mask/);
}
assert.throws(
  () => producer({ patterns:[{ id:'p0', bytes:[0xaa, 0xbb], mask:[0xff] }] }),
  /discovery-pattern-mask-length-mismatch/,
);

const ownedBytes = new Uint8Array([0xaa, 0xbb]);
const typed = producer({ patterns:[{ id:'typed', bytes:ownedBytes }] });
ownedBytes[0] = 0;
const matches = typed.produce({ image:{ code:new Uint8Array([0xaa, 0xbb]), codeBaseAddress:0x1000n } });
assert.equal(matches.length, 1, 'typed pattern bytes are copied at construction');
assert.equal(matches[0].start, '4096');

console.log('pattern producer strict boundaries #3080/#3081: PASS');
