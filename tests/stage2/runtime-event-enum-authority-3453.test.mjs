import assert from 'node:assert/strict';

import {
  createRuntimeEvent,
  createRuntimeEventBatch,
  normalizeLegacyRuntimeEvent,
} from '../../js/runtime/events.js';
import { DebugAdapterError } from '../../js/debug/adapter.js';

const base = Object.freeze({
  runtimeSessionId: 'session-1',
  providerId: 'provider-1',
  kind: 'trace-marker',
});

// Canonical primitive enums and nullish fallbacks remain unchanged.
{
  const event = createRuntimeEvent({
    ...base,
    completeness: 'complete',
    observationMode: 'intervened',
  });
  assert.equal(event.completeness, 'complete');
  assert.equal(event.observationMode, 'intervened');

  const fallback = createRuntimeEvent(base);
  assert.equal(fallback.completeness, 'partial');
  assert.equal(fallback.observationMode, 'observed');
}

// #3453: structured/scalar schema violations must never be laundered into
// authority-bearing enum strings by JavaScript String() coercion.
{
  for (const completeness of [['complete'], { toString: () => 'complete' }, true, 4]) {
    assert.throws(
      () => createRuntimeEvent({ ...base, completeness }),
      (error) => error instanceof DebugAdapterError && error.code === 'runtime-invalid-completeness',
    );
  }
  for (const observationMode of [['intervened'], { toString: () => 'intervened' }, true, 1]) {
    assert.throws(
      () => createRuntimeEvent({ ...base, observationMode }),
      (error) => error instanceof DebugAdapterError && error.code === 'runtime-invalid-observation-mode',
    );
  }
}

// The strict boundary must also cover legacy normalization and batch authority.
{
  assert.throws(
    () => normalizeLegacyRuntimeEvent(
      { type: 'trace-marker', completeness: ['complete'] },
      { runtimeSessionId: 'session-1', providerId: 'provider-1' },
    ),
    (error) => error instanceof DebugAdapterError && error.code === 'runtime-invalid-completeness',
  );

  assert.throws(
    () => createRuntimeEventBatch({
      runtimeSessionId: 'session-1',
      providerId: 'provider-1',
      events: [{ ...base, completeness: 'partial' }],
      completeness: ['partial'],
    }),
    (error) => error instanceof DebugAdapterError && error.code === 'runtime-invalid-completeness',
  );
}

console.log('runtime event enum authority regression #3453: PASS');
