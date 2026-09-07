import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';

function model(classes, runtimeCompleteness = { complete: true, categories: { complete: true } }) {
  return { classes, categories: [], protocols: [], runtimeCompleteness };
}

const unique = buildObjcRuntimeIndex(model([
  { name: 'LocalThing', methods: [{ sel: 'description', addr: 0x1000n }] },
]));

const unknownReceiver = resolveObjcDispatch(unique, {
  receiverType: null,
  selector: 'description',
});
assert.equal(unknownReceiver.resolved, null, 'current-image uniqueness must not exact-resolve an unknown receiver');
assert.equal(unknownReceiver.candidates.length, 1, 'the local implementation should remain available as a candidate');
assert.equal(unknownReceiver.candidates[0].imp, 0x1000n);
assert.equal(unknownReceiver.partial, true, 'open runtime-world coverage must block exact verification');
assert.match(unknownReceiver.reason, /runtime universe is open/);

const knownReceiver = resolveObjcDispatch(unique, {
  receiverType: 'LocalThing',
  selector: 'description',
});
assert.equal(knownReceiver.resolved?.imp, 0x1000n, 'a proven receiver class with complete category coverage may still resolve');
assert.equal(knownReceiver.partial, false);

const multiple = buildObjcRuntimeIndex(model([
  { name: 'A', methods: [{ sel: 'work', addr: 0x2000n }] },
  { name: 'B', methods: [{ sel: 'work', addr: 0x3000n }] },
]));
const ambiguous = resolveObjcDispatch(multiple, { selector: 'work' });
assert.equal(ambiguous.resolved, null);
assert.equal(ambiguous.candidates.length, 2);

console.log('issue #2394 Objective-C open-world dispatch regression: ok');
