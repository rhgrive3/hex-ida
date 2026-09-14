import assert from 'node:assert/strict';
import { normalizeLegacyRuntimeEvent } from '../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'session-legacy',
  providerId: 'provider-legacy',
  providerVersion: '1',
  sessionEpoch: 1,
};

assert.equal(normalizeLegacyRuntimeEvent({ kind: 'call' }, context).kind, 'call');
assert.equal(normalizeLegacyRuntimeEvent({ type: 'branch' }, context).kind, 'basic-block');
assert.equal(normalizeLegacyRuntimeEvent({ type: 'warning' }, context).kind, 'provider-warning');

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
