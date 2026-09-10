import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { analyzeEscape, invalidatesNonEscapeProof } from '../../../js/analysis/summary/escape.js';
import { fixture } from '../helpers/fixtures.mjs';

// #5362: full recompute and the incremental invalidation policy must share one
// non-escape authority contract. `analyzeEscape()` revokes a local root's
// non-escape proof when the root is passed to a complete known call (the root
// joins `escapedRoots` through the `passed-to-known-call` record), so
// `invalidatesNonEscapeProof()` must invalidate that record too. An
// invalidation that spared the reason would let artifact reuse keep a proof a
// fresh analysis of the same revision withdraws.

// The corpus root descriptor makes `state:sp` a stack-like frame root, so the
// slot is a locally created root eligible for a non-escape proof (same
// contract as the corpus `frame-non-escaping` fixture).
const FRAME_ROOTS = Object.freeze({
  'variable:state:sp': { kind: 'stack-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
});

function build({ passToKnownCall = false } = {}) {
  const f = fixture('function_frame_known_call_probe');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c0 = f.constant('c0', 0);
  const slot = f.binary('slot', 'add', sp, c0);
  f.store('st_slot', slot, null, { widthBits: 32 });
  if (passToKnownCall) {
    const nodeId = 'node_call_known';
    f.nodes.push({
      id: nodeId, kind: 'call', blockId: 'entry', inputs: [slot], outputs: [],
      call: {
        targetValueIds: [], targetEntityIds: ['function_known_callee'], arguments: [slot], returns: [],
        stateReads: [], stateWrites: [],
        memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, controlEffects: [],
        determinism: 'deterministic', noreturn: false, mayThrow: false, summarySource: 'fixture',
        completeness: 'complete',
      },
      origin: { instructionIds: ['instruction_call_known'] },
    });
    f.blocks[0].nodeIds.push(nodeId);
  }
  f.ret('r');
  return f.build({ rootDescriptors: FRAME_ROOTS });
}

function escapeRun({ passToKnownCall = false } = {}) {
  const built = build({ passToKnownCall });
  const pointsTo = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {
    canonicalOptions: { rootDescriptors: built.rootDescriptors },
  });
  return analyzeEscape(built.ir, built.cfg, built.ssa, pointsTo, {});
}

const slotRootKeyOf = (run) => run.rootOrigins.keys().next().value;

test('#5362 passing a local root to a complete known call revokes its non-escape proof in full recompute', () => {
  const before = escapeRun({ passToKnownCall: false });
  const after = escapeRun({ passToKnownCall: true });
  const rootKey = slotRootKeyOf(before);
  assert.ok(before.nonEscapingRoots.has(rootKey), 'precondition: the slot is proven non-escaping before the call');
  assert.ok(rootFacts(after, rootKey).some((record) => record.reason === 'passed-to-known-call'), 'precondition: the known-call record exists');
  assert.equal(after.nonEscapingRoots.has(rootKey), false, 'full recompute must withdraw the proof');
});

test('#5362 the invalidation policy invalidates exactly what full recompute withdraws', () => {
  const after = escapeRun({ passToKnownCall: true });
  const rootKey = slotRootKeyOf(after);
  const knownCallRecord = rootFacts(after, rootKey).find((record) => record.reason === 'passed-to-known-call');
  assert.equal(invalidatesNonEscapeProof(knownCallRecord), true, 'incremental invalidation must agree with full recompute');
});

test('#5362 metamorphic equality: invalidation and fresh recompute agree on every escape fact', () => {
  const before = escapeRun({ passToKnownCall: false });
  const after = escapeRun({ passToKnownCall: true });
  const rootKey = slotRootKeyOf(before);
  // Fresh-recompute authority for the changed revision: the root is no longer
  // proven non-escaping and carries the known-call escape fact.
  const freshAuthority = {
    proofWithdrawn: !after.nonEscapingRoots.has(rootKey),
    facts: rootFacts(after, rootKey).map((record) => record.reason).sort(),
  };
  // Incremental view: every new record since `before` must be treated as
  // proof-invalidating, so the reused proof is dropped exactly when the fresh
  // run drops it.
  const newRecords = rootFacts(after, rootKey).filter((record) => !rootFacts(before, rootKey).some((prior) => prior.reason === record.reason));
  const incrementalProofWithdrawn = newRecords.some(invalidatesNonEscapeProof);
  assert.equal(incrementalProofWithdrawn, freshAuthority.proofWithdrawn);
  assert.ok(freshAuthority.facts.includes('passed-to-known-call'));
});

function rootFacts(run, rootKey) {
  return run.escapes.filter((record) => record.rootKey === rootKey);
}
