import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const src = await readFile(new URL('../../js/ui/panels/navigation.js', import.meta.url), 'utf8');
const showStrings = src.match(/export function showStrings\(app\) \{[\s\S]*?(?=\/\*\* Canonical xref sheet:)/)?.[0] ?? '';

function pageBoundaries(total, pageSize = 120) {
  let shown = 0;
  const boundaries = [];
  while (shown < total) {
    shown = Math.min(total, shown + pageSize);
    boundaries.push(shown);
  }
  return boundaries;
}

test('showStrings keeps the first DOM render bounded without terminally slicing matches', () => {
  assert.ok(showStrings, 'showStrings source must be discoverable');
  assert.doesNotMatch(showStrings, /filtered\.slice\(0,\s*120\)/);
  assert.match(showStrings, /const pageSize = 120;/);
  assert.match(showStrings, /let shown = 0;/);
  assert.match(showStrings, /const end = Math\.min\(filtered\.length, shown \+ pageSize\);/);
  assert.match(showStrings, /for \(; shown < end; shown\+\+\)/);
  assert.match(showStrings, /if \(shown < filtered\.length\)/);
  assert.match(showStrings, /t\('search\.showMore', \{/);
});

test('showStrings discloses visible progress separately from the 600-result search cap', () => {
  assert.match(showStrings, /shown\.toLocaleString\(\)\}\/\$\{filtered\.length\.toLocaleString\(\)\}件表示/);
  assert.match(showStrings, /filtered\.length >= 600 \? ' · 検索結果は先頭600件'/);
});

test('120/121/599/600 match boundaries remain reachable in 120-row increments', () => {
  assert.deepEqual(pageBoundaries(120), [120]);
  assert.deepEqual(pageBoundaries(121), [120, 121]);
  assert.deepEqual(pageBoundaries(599), [120, 240, 360, 480, 599]);
  assert.deepEqual(pageBoundaries(600), [120, 240, 360, 480, 600]);
});

test('filter rerenders retain stale-result suppression and collection completeness disclosure', () => {
  assert.match(showStrings, /const serial = \+\+renderSerial;/);
  assert.match(showStrings, /serial !== renderSerial/);
  assert.match(showStrings, /collection\.complete === false \|\| collection\.truncated \? '一部' : '完全'/);
  assert.match(showStrings, /results\.replaceChildren\(\);/);
});
