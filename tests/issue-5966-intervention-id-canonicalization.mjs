// Regression for #5966: runtime intervention id collections must follow the
// same canonical string contract as scalar ids — trim, require non-empty,
// dedupe/sort canonicalized values. Padded references must resolve against
// canonical record ids; whitespace-only ids stay rejected.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInterventionRecord, InterventionLedger } from '../js/runtime/evidence-bridge.js';

const base = { runtimeSessionId: 'session-1', providerId: 'provider-1', kind: 'memory-write' };

test('#5966 whitespace-only evidence ids are rejected', () => {
  assert.throws(
    () => createInterventionRecord({ ...base, evidenceIds: ['   ', '\t'] }),
    (error) => /non-empty strings/.test(error?.message ?? ''),
  );
});

test('#5966 padded evidence ids canonicalize and dedupe', () => {
  const record = createInterventionRecord({ ...base, evidenceIds: ['  ev-1  ', 'ev-1'] });
  assert.deepEqual([...record.evidenceIds], ['ev-1']);
});

test('#5966 a padded parent reference resolves against the canonical id', () => {
  const ledger = new InterventionLedger();
  ledger.add({ interventionId: 'parent', ...base });
  ledger.add({ interventionId: 'child', ...base, parentInterventionIds: [' parent '] });
  assert.deepEqual([...ledger.get('child').parentInterventionIds], ['parent']);
});

test('#5966 canonical (already trimmed) input keeps the previous behavior', () => {
  const record = createInterventionRecord({ ...base, evidenceIds: ['b', 'a'], parentInterventionIds: ['p1'] });
  assert.deepEqual([...record.evidenceIds], ['a', 'b']);
  assert.deepEqual([...record.parentInterventionIds], ['p1']);
});
