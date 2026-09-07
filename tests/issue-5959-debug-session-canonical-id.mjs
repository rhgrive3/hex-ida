// Regression for #5959: debugSessionId() validated the trimmed value but kept
// the raw string as the identity, so ' session-1 ' and 'session-1' coexisted
// as two sessions while trimmed lookups found neither. The trimmed form is now
// the canonical identity for storage, lookup and duplicate detection.
import assert from 'node:assert/strict';
import { DebugSessionManager } from '../js/runtime/session.js';

const manager = new DebugSessionManager();

const padded = manager.create({ kind: 'stub-a' }, { id: ' session-1 ' });
assert.equal(padded.id, 'session-1', 'the stored identity must be the trimmed canonical id');
assert.equal(manager.get('session-1'), padded, 'trimmed lookups must find the padded-input session');
assert.equal(manager.get(' session-1 '), padded, 'padded lookups canonicalize to the same session');

assert.throws(
  () => manager.create({ kind: 'stub-b' }, { id: 'session-1' }),
  (error) => error.code === 'duplicate-session-id',
  'a whitespace-only difference must not mint a second session',
);

assert.throws(
  () => manager.create({ kind: 'stub-c' }, { id: '   ' }),
  (error) => error.code === 'session-id',
  'whitespace-only ids stay invalid',
);

const plain = manager.create({ kind: 'stub-d' }, { id: 'plain' });
assert.equal(plain.id, 'plain', 'unpadded ids are untouched');
