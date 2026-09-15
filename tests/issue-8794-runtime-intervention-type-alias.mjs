// Issue #8794 regression: the runtime intervention ledger must not alias
// type-distinct mutation provenance. `stableStringify`/`stableDigest` render a
// BigInt and its numeric string (and a typed array vs a plain numeric array)
// identically, so `createInterventionRecord` used to mint the SAME auto
// interventionId for both and `InterventionLedger.add()` silently discarded the
// second record as a "replay", losing that mutation's provenance.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInterventionRecord,
  InterventionLedger,
} from '../js/runtime/evidence-bridge.js';

function base(extra) {
  return {
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    kind: 'register-write',
    target: { register: 'x0' },
    sequence: 7,
    parentInterventionIds: [],
    ...extra,
  };
}

test('#8794 BigInt vs numeric-string change are type-distinct, not aliased', () => {
  const bigint = createInterventionRecord(base({ requestedChange: { value: 1n } }));
  const string = createInterventionRecord(base({ requestedChange: { value: '1' } }));
  assert.notEqual(bigint.interventionId, string.interventionId);

  const ledger = new InterventionLedger();
  const first = ledger.add(base({ requestedChange: { value: 1n } }));
  const second = ledger.add(base({ requestedChange: { value: '1' } }));
  assert.notEqual(first, second);
  assert.equal(ledger.all().length, 2);
  assert.equal(typeof ledger.all()[0].requestedChange.value, 'bigint');
  assert.equal(typeof ledger.all()[1].requestedChange.value, 'string');
});

test('#8794 typed-bytes vs plain numeric array change are not aliased', () => {
  const ledger = new InterventionLedger();
  const bytes = ledger.add(base({ kind: 'memory-write', requestedChange: { bytes: new Uint8Array([1, 2, 3]) } }));
  const arr = ledger.add(base({ kind: 'memory-write', requestedChange: { bytes: [1, 2, 3] } }));
  assert.notEqual(bytes.interventionId, arr.interventionId);
  assert.equal(ledger.all().length, 2);
});

test('#8794 -0 vs 0 and NaN vs 0 are distinct (lossy numeric collisions)', () => {
  assert.notEqual(
    createInterventionRecord(base({ requestedChange: { value: -0 } })).interventionId,
    createInterventionRecord(base({ requestedChange: { value: 0 } })).interventionId,
  );
  assert.notEqual(
    createInterventionRecord(base({ requestedChange: { value: Number.NaN } })).interventionId,
    createInterventionRecord(base({ requestedChange: { value: 0 } })).interventionId,
  );
});

test('#8794 identical replay still dedupes to the same stored record', () => {
  const ledger = new InterventionLedger();
  const a = ledger.add(base({ requestedChange: { value: 1n } }));
  const b = ledger.add(base({ requestedChange: { value: 1n } }));
  assert.equal(a, b);
  assert.equal(ledger.all().length, 1);
});

test('#8794 id derivation stays deterministic for the same record content', () => {
  const one = createInterventionRecord(base({ requestedChange: { value: 42n } }));
  const two = createInterventionRecord(base({ requestedChange: { value: 42n } }));
  assert.equal(one.interventionId, two.interventionId);
});

test('#8794 a caller-supplied interventionId is preserved unchanged', () => {
  const record = createInterventionRecord(base({ interventionId: 'caller-provided', requestedChange: { value: 1n } }));
  assert.equal(record.interventionId, 'caller-provided');
});
