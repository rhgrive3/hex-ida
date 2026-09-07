/*
 * issue-2482 (PR 2 of 2): the canonical-address proof caches must be
 * transparent.
 *
 * The accuracy lanes proved the same IR over and over per function window,
 * and the identity-graph validation re-walked every value/node/block each
 * time (#2482 quadratic blow-up companion cost). The caches key on graph
 * identity plus structural shape, so a repeated query returns the identical
 * proof and a per-call option (rootDescriptors, ssa) never leaks through the
 * cache into a later call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { deriveCanonicalAddressProof as deriveWithSsaNormalization } from '../../../js/analysis/alias/canonical-address-v2.js';

const entryIr = () => ({
  functionId: 'fn-main',
  values: [{ id: 'v-entry', kind: 'entry', variableKey: 'x0', machineType: { widthBits: 64 } }],
  nodes: [],
  blocks: [],
});

test('proof cache returns identical proofs for repeated queries on one graph', () => {
  const ir = entryIr();
  const base = deriveWithSsaNormalization(ir, 'v-entry');
  assert.equal(base.kind, 'rooted', 'fixture must keep producing a proof');
  assert.deepEqual(deriveWithSsaNormalization(ir, 'v-entry'), base);
});

test('per-call options never leak through the proof cache', () => {
  const ir = entryIr();
  const base = deriveCanonicalAddressProof(ir, 'v-entry');
  deriveCanonicalAddressProof(ir, 'v-entry', { rootDescriptors: { x0: { kind: 'stack-like', baseOffset: 16 } } });
  assert.deepEqual(deriveCanonicalAddressProof(ir, 'v-entry'), base,
    'rootDescriptors on one call must not leak into later cached calls');
  deriveCanonicalAddressProof(ir, 'v-entry', { ssa: { definitions: [], uses: [] } });
  assert.deepEqual(deriveCanonicalAddressProof(ir, 'v-entry'), base,
    'an ssa on one call must not leak into later cached calls');
});

test('a distinct graph object derives independently of the cache', () => {
  const ir = entryIr();
  const other = entryIr();
  assert.notEqual(ir, other);
  assert.deepEqual(deriveCanonicalAddressProof(other, 'v-entry'), deriveCanonicalAddressProof(ir, 'v-entry'));
});

test('implicit-undef ssa normalization stays stable across repeated calls', () => {
  const ir = entryIr();
  const options = {
    ssa: {
      definitions: [{ valueId: 'v-entry', kind: 'undef', proof: { kind: 'implicit-undef' } }],
      uses: [],
    },
  };
  const first = deriveWithSsaNormalization(ir, 'v-entry', options);
  assert.equal(first.kind, 'rooted', 'implicit-undef must be treated as an entry seed');
  assert.deepEqual(deriveWithSsaNormalization(ir, 'v-entry', options), first,
    'the normalized ssa memo must reuse, not diverge, on repeat');
});
