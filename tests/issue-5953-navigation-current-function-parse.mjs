// Regression for #5953: .hexproj navigation.currentFunction must be validated
// as an integer representation at parse time. Before the fix it was consumed
// as BigInt only after notes/patches were persisted, so a malformed value left
// the project partially applied.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHexProject } from '../js/project/index.js';

const projectWith = (currentFunction) => JSON.stringify({
  format: 'hexproj',
  version: 2,
  binary: { hash: 'h' },
  navigation: { currentFunction },
  user: { names: [{ address: '4096', value: 'fn1' }] },
  embedded: false,
});

test('#5953 malformed currentFunction is rejected at parse time', () => {
  for (const bad of [{ malicious: true }, 'not-an-address', [], true]) {
    assert.throws(
      () => parseHexProject(projectWith(bad)),
      (error) => /currentFunction/.test(error?.message ?? ''),
      `expected parse rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('#5953 unsafe numeric currentFunction is rejected', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => parseHexProject(projectWith(unsafe)),
    (error) => /currentFunction/.test(error?.message ?? ''),
  );
});

test('#5953 valid currentFunction representations still parse', () => {
  for (const good of [4352, '4352', '0x1100']) {
    const parsed = parseHexProject(projectWith(good));
    assert.equal(parsed.navigation.currentFunction, 4352n);
  }
  assert.equal(parseHexProject(projectWith(null)).navigation.currentFunction, null);
  assert.equal(parseHexProject(JSON.stringify({
    format: 'hexproj', version: 2, binary: { hash: 'h' }, embedded: false,
  })).navigation.currentFunction, null);
});