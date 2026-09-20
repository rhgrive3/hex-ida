import assert from 'node:assert/strict';
import test from 'node:test';

import { cmpVersions, newerVersionCandidate } from '../scripts/freebuff-setup.mjs';

for (const [older, newer] of [
  ['1.9007199254740992.0', '1.9007199254740993.0'],
  ['9007199254740992.1.0', '9007199254740993.1.0'],
  ['1.2.9007199254740992', '1.2.9007199254740993'],
  ['0.0.175', '0.0.176'],
  ['1.2.9', '1.3.0'],
]) {
  test(`#9304 exact version ordering: ${older} < ${newer}`, () => {
    assert.equal(cmpVersions(older, newer), -1);
    assert.equal(cmpVersions(newer, older), 1);
    assert.equal(cmpVersions(older, older), 0);
  });
}

test('#9304 shared-vs-HOME candidate selection keeps the exact newer accepted version', () => {
  const shared = { path:'/shared/freebuff', version:'1.9007199254740992.0' };
  const home = { path:'/home/freebuff', version:'1.9007199254740993.0' };
  assert.equal(newerVersionCandidate(shared, home), home);
  assert.equal(newerVersionCandidate(home, shared), home);
  assert.equal(newerVersionCandidate(null, home), home);
});
