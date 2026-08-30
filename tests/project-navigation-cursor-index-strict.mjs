import assert from 'node:assert/strict';
import {
  createHexProject,
  normalizeNavigation,
  parseHexProject,
  serializeHexProject,
} from '../js/project/index.js';

assert.equal(normalizeNavigation({ cursorIndex: null }).cursorIndex, null);
assert.equal(normalizeNavigation({ cursorIndex: 0 }).cursorIndex, 0);
assert.equal(normalizeNavigation({ cursorIndex: 42 }).cursorIndex, 42);

for (const cursorIndex of [
  [], {}, true, false, '0', '42', NaN, Infinity, -Infinity, -1, 1.5,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  assert.throws(
    () => normalizeNavigation({ cursorIndex }),
    /navigation\.cursorIndex must be a non-negative safe integer or null/,
    `expected cursorIndex ${String(cursorIndex)} to be rejected`,
  );
}

const project = createHexProject({ navigation: { cursorIndex: 3 } });
const roundTrip = parseHexProject(serializeHexProject(project));
assert.equal(roundTrip.navigation.cursorIndex, 3);

assert.throws(
  () => createHexProject({ navigation: { cursorIndex: {} } }),
  /navigation\.cursorIndex must be a non-negative safe integer or null/,
);

console.log('project navigation cursorIndex strict validation: ok');
