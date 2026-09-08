import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeEscape, invalidatesNonEscapeProof } from '../../../js/analysis/summary/escape.js';

// #6146: transitive containment propagation re-scanned a root only the first
// time it became escaped. A stronger escape reason arriving later at an
// already-escaped intermediate root never reached that root's children, and
// invalidatesNonEscapeProof() is reason-dependent — so a contained root could
// end up with only `passed-to-known-call` while the container was also
// `stored-to-global`.

const target = (rootKey, rootKind = 'rooted') => ({ rootKey, rootKind });
const setFor = (rootKey) => ({ top:false, targets:[target(rootKey)] });
const setGlobal = () => ({ top:false, targets:[target('global:G', 'absolute')] });

const strongEscape = () => (
  { id:'store-a-global', kind:'store', inputs:['vG','vA'], memory:{ addressExpr:{ valueId:'vG' } }, origin:{ instructionIds:['insn:global'] } }
);
const weakEscape = () => (
  { id:'call-b', kind:'call', inputs:['vB'], call:{ completeness:'complete', arguments:[] }, origin:{ instructionIds:['insn:call'] } }
);
const containmentChain = () => [
  { id:'store-b-into-a', kind:'store', inputs:['vA','vB'], memory:{ addressExpr:{ valueId:'vA' } }, origin:{ instructionIds:[] } },
  { id:'store-c-into-b', kind:'store', inputs:['vB','vC'], memory:{ addressExpr:{ valueId:'vB' } }, origin:{ instructionIds:[] } },
];

// Containment chain A -> B -> C over three local allocations, with direct
// escapes recorded in exactly the order the issue describes: A observes
// stored-to-global first, then B observes passed-to-known-call. escapedRoots
// insertion order is [A, B], so main's LIFO worklist processes B (propagating
// only the weak reason to C) before A's strong reason lands on B — and B is
// never re-scanned on main.
const buildIr = ({ reverseDirectEscapes = false } = {}) => ({
  nodes: reverseDirectEscapes
    ? [weakEscape(), strongEscape(), ...containmentChain()]
    : [strongEscape(), weakEscape(), ...containmentChain()],
});

const buildPointsTo = () => new Map([
  ['vA', setFor('alloc:A')],
  ['vB', setFor('alloc:B')],
  ['vC', setFor('alloc:C')],
  // An absolute root classifies as global, so storing into it records
  // stored-to-global on the stored value's roots.
  ['vG', setGlobal()],
]);

const runIr = (ir, allocationRootKeys = new Set(['alloc:A', 'alloc:B', 'alloc:C']), pointsTo = buildPointsTo()) => analyzeEscape(
  ir,
  {},
  {},
  { status:{ completeness:'complete' }, pointsTo },
  { snapshotId:'snap', allocationRootKeys },
);

const run = (options = {}) => runIr(buildIr(options));

const factIdentity = (record) => JSON.stringify([
  record.rootKey,
  record.rootOrigin,
  record.reason,
  record.boundary,
  record.siteId ?? null,
  record.evidenceIds ?? [],
]);

const canonicalFacts = (result) => [...new Set(result.escapes.map(factIdentity))].sort();

test('a late strong escape reason propagates through an already-escaped intermediate root (#6146)', () => {
  const result = run();
  const reasonsFor = (rootKey) => result.escapes.filter((esc) => esc.rootKey === rootKey).map((esc) => esc.reason);
  assert.ok(reasonsFor('alloc:B').includes('stored-to-global'),
    'B must carry the strong global-publication reason (direct + propagated)');
  assert.ok(reasonsFor('alloc:C').includes('stored-to-global'),
    'the strong reason must reach B\'s child C through the already-escaped intermediate root (#6146)');
  assert.ok(reasonsFor('alloc:C').includes('passed-to-known-call'),
    'the weak reason also propagates');
});

test('proof invalidation for the contained root sees the strong reason (#6146)', () => {
  const result = run();
  const cRecords = result.escapes.filter((esc) => esc.rootKey === 'alloc:C');
  assert.ok(cRecords.some((esc) => invalidatesNonEscapeProof(esc)),
    'C must have at least one record that invalidates non-escape proofs (stored-to-global), not only passed-to-known-call');
});

test('direct escape observation order does not change the canonical fixed point (#6146)', () => {
  assert.deepEqual(
    canonicalFacts(run()),
    canonicalFacts(run({ reverseDirectEscapes:true })),
    'the same containment graph and direct fact set must converge to one canonical escape set regardless of insertion order',
  );
});

test('a containment cycle converges without re-minting the same fact (#6146)', () => {
  const ir = {
    nodes:[
      strongEscape(),
      // A contains B and B contains A.
      { id:'store-b-into-a', kind:'store', inputs:['vA','vB'], memory:{ addressExpr:{ valueId:'vA' } }, origin:{ instructionIds:[] } },
      { id:'store-a-into-b', kind:'store', inputs:['vB','vA'], memory:{ addressExpr:{ valueId:'vB' } }, origin:{ instructionIds:[] } },
    ],
  };
  const pointsTo = new Map([
    ['vA', setFor('alloc:A')],
    ['vB', setFor('alloc:B')],
    ['vG', setGlobal()],
  ]);
  const result = runIr(ir, new Set(['alloc:A', 'alloc:B']), pointsTo);
  const propagatedGlobal = result.escapes.filter(
    (record) => record.reason === 'stored-to-global' && record.siteId === 'store-a-global',
  );

  assert.deepEqual(
    propagatedGlobal.map((record) => record.rootKey).sort(),
    ['alloc:A', 'alloc:B'],
    'one global-publication fact must reach each root in the cycle exactly once',
  );
  assert.equal(result.escapes.length, canonicalFacts(result).length,
    'cycle propagation must not grow duplicate canonical facts');
  assert.equal(result.escapes.length, 2,
    'the two-root cycle with one direct fact has a finite two-fact fixed point');
});
