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

// Containment chain A -> B -> C over three local allocations, with direct
// escapes recorded in exactly the order the issue describes: A observes
// stored-to-global first, then B observes passed-to-known-call. escapedRoots
// insertion order is [A, B], so main's LIFO worklist processes B (propagating
// only the weak reason to C) before A's strong reason lands on B — and B is
// never re-scanned on main.
const buildIr = () => ({
  nodes:[
    // 1. A stored-to-global: direct strong escape on A (escapedRoots #1).
    { id:'store-a-global', kind:'store', inputs:['vG','vA'], memory:{ addressExpr:{ valueId:'vG' } }, origin:{ instructionIds:[] } },
    // 2. B passed-to-known-call: direct weak escape on B (escapedRoots #2).
    { id:'call-b', kind:'call', inputs:['vB'], call:{ completeness:'complete', arguments:[] }, origin:{ instructionIds:[] } },
    // 3. B stored into A (A local → containment edge A->B).
    { id:'store-b-into-a', kind:'store', inputs:['vA','vB'], memory:{ addressExpr:{ valueId:'vA' } }, origin:{ instructionIds:[] } },
    // 4. C stored into B (B local → containment edge B->C).
    { id:'store-c-into-b', kind:'store', inputs:['vB','vC'], memory:{ addressExpr:{ valueId:'vB' } }, origin:{ instructionIds:[] } },
  ],
});

const buildPointsTo = () => new Map([
  ['vA', setFor('alloc:A')],
  ['vB', setFor('alloc:B')],
  ['vC', setFor('alloc:C')],
  // An absolute root classifies as global, so storing into it records
  // stored-to-global on the stored value's roots.
  ['vG', setGlobal()],
]);

const run = () => analyzeEscape(buildIr(), {}, {}, {
  status:{ completeness:'complete' },
  pointsTo:buildPointsTo(),
}, {
  snapshotId:'snap',
  allocationRootKeys:new Set(['alloc:A', 'alloc:B', 'alloc:C']),
});

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
