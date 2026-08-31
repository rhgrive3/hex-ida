import assert from 'node:assert/strict';
import { normalizeLegacyRuntimeEvent } from '../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'session-legacy',
  providerId: 'provider-legacy',
  providerVersion: '1',
  sessionEpoch: 1,
};

// Valid legacy string kinds and aliases remain supported.
assert.equal(normalizeLegacyRuntimeEvent({ kind: 'call' }, context).kind, 'call');
assert.equal(normalizeLegacyRuntimeEvent({ type: 'branch' }, context).kind, 'basic-block');
assert.equal(normalizeLegacyRuntimeEvent({ type: 'warning' }, context).kind, 'provider-warning');

// #3062: structured/non-string kind evidence must never launder into a canonical kind.
for (const input of [
  { kind: ['call'] },
  { type: ['return'] },
  { kind: { toString() { return 'call'; } } },
  { type: true },
  { kind: 1 },
]) {
  assert.equal(normalizeLegacyRuntimeEvent(input, context).kind, 'trace-marker');
}

console.log('runtime legacy event strict kind: PASS');
