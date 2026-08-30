import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeProviderDescriptor } from '../../../js/runtime/provider.js';
import { createInterventionRecord, InterventionLedger } from '../../../js/runtime/evidence-bridge.js';

for (const bad of [["debugger"], {}, 7, true]) {
  test(`P10.9 runtime facet rejects ${typeof bad} coercion`, () => {
    assert.throws(
      () => createRuntimeProviderDescriptor({ id: 'provider', facets: [bad] }),
      /runtime facet|unsupported runtime facet/,
    );
  });
}

test('P10.9 valid runtime facet strings are preserved', () => {
  const descriptor = createRuntimeProviderDescriptor({ id: 'provider', facets: ['debugger', 'trace', 'debugger'] });
  assert.deepEqual(descriptor.facets, ['debugger', 'trace']);
});

for (const bad of [[], {}, 7, true]) {
  test(`P10.9 intervention id rejects ${typeof bad} coercion`, () => {
    assert.throws(() => createInterventionRecord({
      runtimeSessionId: 'session',
      providerId: 'provider',
      kind: 'probe-install',
      interventionId: bad,
    }), /intervention id|runtime-intervention-id-invalid/);
  });

  test(`P10.9 intervention provenance rejects ${typeof bad} coercion`, () => {
    assert.throws(() => createInterventionRecord({
      runtimeSessionId: 'session',
      providerId: 'provider',
      kind: 'probe-install',
      parentInterventionIds: [bad],
    }), /must contain only non-empty strings/);
  });
}

test('P10.9 intervention ledger does not coerce lookup identities', () => {
  const ledger = new InterventionLedger();
  const record = ledger.add({
    runtimeSessionId: 'session',
    providerId: 'provider',
    kind: 'probe-install',
    interventionId: '[object Object]',
  });
  assert.equal(ledger.get('[object Object]'), record);
  assert.equal(ledger.get({}), null);
});
