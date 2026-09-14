import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const src = await readFile(new URL('../../js/ui/product-hardened.js', import.meta.url), 'utf8');
const match = src.match(/function verdictBadge\(verdict\) \{[\s\S]*?\n\}/);
assert.ok(match, 'product-hardened must still define verdictBadge');
const verdictBadge = new Function(`${match[0]}; return verdictBadge;`)();

test('contradicted verdict keeps its badge instead of collapsing to unverified', () => {
  assert.equal(verdictBadge('contradicted'), 'contradicted');
  assert.equal(verdictBadge('CONTRADICTED'), 'contradicted');
});

test('established verdict mapping is preserved', () => {
  assert.equal(verdictBadge('confirmed'), 'confirmed');
  assert.equal(verdictBadge('supported'), 'likely');
  assert.equal(verdictBadge('likely'), 'likely');
  assert.equal(verdictBadge('unverified'), 'unverified');
  assert.equal(verdictBadge('unknown'), 'unverified');
  assert.equal(verdictBadge(null), 'unverified');
});
