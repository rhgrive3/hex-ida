import assert from 'node:assert/strict';
import {
  createFunctionCandidate,
  hasExactStart,
} from '../../../js/analysis/discovery/candidates.js';
import {
  createDebugEvidenceProducer,
  createPatternProducer,
  exportProducer,
  loaderProducer,
} from '../../../js/analysis/discovery/producers.js';

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

const sparsePatterns = new Array(2);
sparsePatterns[1] = { id:'p1', bytes:[0xaa] };
assert.throws(
  () => producer({ patterns:sparsePatterns }),
  /discovery-pattern-invalid-bytes/,
);

for (const badConflicts of [
  'start',
  [null],
  [[{ kind:'start' }]],
  [{ kind:['start'] }],
  [{ kind:'' }],
  [{ kind:' start' }],
]) {
  assert.throws(
    () => createFunctionCandidate({ start:0n, startState:'exact', conflicts:badConflicts }),
    /discovery-candidate-invalid-conflict/,
  );
}
const typedConflict = new Uint8Array(1);
typedConflict.kind = 'start';
assert.throws(
  () => createFunctionCandidate({ start:0n, startState:'exact', conflicts:[typedConflict] }),
  /discovery-candidate-invalid-conflict/,
);
const inheritedKindPrototype = {};
Object.defineProperty(inheritedKindPrototype, 'kind', {
  get() { throw new Error('prototype kind getter must not be evaluated'); },
});
const inheritedKindConflict = Object.create(inheritedKindPrototype);
assert.throws(
  () => createFunctionCandidate({ start:0n, startState:'exact', conflicts:[inheritedKindConflict] }),
  /discovery-candidate-invalid-conflict/,
);
const accessorKindConflict = {};
Object.defineProperty(accessorKindConflict, 'kind', {
  enumerable:true,
  get() { throw new Error('own kind getter must not be evaluated'); },
});
assert.throws(
  () => createFunctionCandidate({ start:0n, startState:'exact', conflicts:[accessorKindConflict] }),
  /discovery-candidate-invalid-conflict-kind/,
);
const exactCandidate = createFunctionCandidate({ start:0n, startState:'exact' });
assert.equal(hasExactStart(exactCandidate), true);
const contradictedCandidate = createFunctionCandidate({
  start:0n,
  startState:'exact',
  conflicts:[{ kind:'start' }],
});
assert.equal(hasExactStart(contradictedCandidate), false);

for (const blank of ['', '   ']) {
  assert.deepEqual(exportProducer.produce({
    image:{ exports:[{ address:blank, isFunction:true, name:'bad' }], symbols:[] },
  }), []);
  assert.deepEqual(loaderProducer.produce({
    image:{ functions:[], functionStarts:[blank], unwindEntries:[] },
  }), []);
  assert.deepEqual(createDebugEvidenceProducer([
    { address:blank, name:'bad', evidenceIds:[] },
  ]).produce(), []);
}

const ownedBytes = new Uint8Array([0xaa, 0xbb]);
const typed = producer({ patterns:[{ id:'typed', bytes:ownedBytes }] });
ownedBytes[0] = 0;
const matches = typed.produce({ image:{ code:new Uint8Array([0xaa, 0xbb]), codeBaseAddress:0x1000n } });
assert.equal(matches.length, 1, 'typed pattern bytes are copied at construction');
assert.equal(matches[0].start, '4096');

console.log('pattern producer strict boundaries #3080/#3081: PASS');
