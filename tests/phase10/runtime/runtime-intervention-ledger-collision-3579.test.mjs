import assert from 'node:assert/strict';
import test from 'node:test';

import { InterventionLedger } from '../../../js/runtime/evidence-bridge.js';

function intervention(overrides = {}) {
  return {
    interventionId: 'i-1',
    runtimeSessionId: 'session-1',
    providerId: 'debugger',
    kind: 'memory-write',
    target: { address: '0x1000' },
    requestedChange: { value: 1 },
    sequence: 1,
    parentInterventionIds: [],
    ...overrides,
  };
}

function expectCollision(overrides) {
  const ledger = new InterventionLedger();
  const first = ledger.add(intervention());
  assert.throws(
    () => ledger.add(intervention(overrides)),
    (error) => error?.code === 'runtime-intervention-id-collision'
      && error?.details?.interventionId === 'i-1',
  );
  assert.equal(ledger.get('i-1'), first);
  assert.equal(ledger.all().length, 1);
}

test('P10 intervention duplicate is idempotent only for the same canonical identity (#3579)', () => {
  const ledger = new InterventionLedger();
  const first = ledger.add(intervention({ acknowledgedResult: { ok: true }, evidenceIds: ['e-1'] }));
  const second = ledger.add(intervention({ acknowledgedResult: { ok: false }, evidenceIds: ['e-2'] }));
  assert.equal(second, first);
  assert.deepEqual(second.acknowledgedResult, { ok: true });
  assert.deepEqual(second.evidenceIds, ['e-1']);
});

test('P10 intervention id rejects target/requested-change collisions (#3579)', () => {
  expectCollision({ target: { address: '0x2000' } });
  expectCollision({ requestedChange: { value: 2 } });
});

test('P10 intervention id rejects session/provider/kind/sequence collisions (#3579)', () => {
  expectCollision({ runtimeSessionId: 'session-2' });
  expectCollision({ providerId: 'other-debugger' });
  expectCollision({ kind: 'register-write' });
  expectCollision({ sequence: 2 });
});

test('P10 intervention id rejects parent-chain collisions (#3579)', () => {
  const ledger = new InterventionLedger();
  ledger.add(intervention({
    interventionId: 'parent-1',
    kind: 'probe-install',
    target: { address: '0x900' },
    requestedChange: null,
    sequence: 0,
  }));
  const first = ledger.add(intervention());
  assert.throws(
    () => ledger.add(intervention({ parentInterventionIds: ['parent-1'] })),
    (error) => error?.code === 'runtime-intervention-id-collision',
  );
  assert.equal(ledger.get('i-1'), first);
});

test('P10 automatically generated intervention ids remain idempotent (#3579)', () => {
  const ledger = new InterventionLedger();
  const input = intervention({ interventionId: undefined });
  const first = ledger.add(input);
  const second = ledger.add(input);
  assert.equal(second, first);
  assert.match(first.interventionId, /^intervention_[0-9a-f]+$/);
});
