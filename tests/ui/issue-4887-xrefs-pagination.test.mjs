import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const src = await readFile(new URL('../../js/ui/panels/navigation.js', import.meta.url), 'utf8');
const showXrefs = src.match(/export function showXrefs\(app, target\) \{[\s\S]*$/)?.[0] ?? '';

function requestedOffsets(total, pageSize = 400) {
  const offsets = [];
  let offset = 0;
  while (offset < total || offset === 0) {
    offsets.push(offset);
    const returned = Math.min(pageSize, Math.max(0, total - offset));
    if (returned < pageSize || offset + returned >= total) break;
    offset += returned;
  }
  return offsets;
}

function canonicalNext(offset, returned, rawNext) {
  if (rawNext == null) return null;
  const next = Number(rawNext);
  const expected = offset + returned;
  return Number.isSafeInteger(next) && next > offset && next === expected ? next : null;
}

test('showXrefs follows canonical page.next lazily with the original snapshot and target', () => {
  assert.ok(showXrefs, 'showXrefs source must be discoverable');
  assert.match(showXrefs, /const pageSize = 400;/);
  assert.match(showXrefs, /let nextOffset = 0;/);
  assert.match(showXrefs, /const requestedOffset = nextOffset;/);
  assert.match(showXrefs, /api\.xrefs\([\s\S]*snapshot,[\s\S]*BigInt\(target\),[\s\S]*\{ offset:requestedOffset, limit:pageSize \}/);
  assert.match(showXrefs, /const rawNext = pageInfo\.next;/);
  assert.match(showXrefs, /const expectedNext = requestedOffset \+ rows\.length;/);
  assert.match(showXrefs, /candidateNext !== expectedNext/);
  assert.match(showXrefs, /t\('search\.showMore', \{ n:remaining \}\)/);
});

test('399/400 stay single-page while 401 and 800+ remain reachable without gaps', () => {
  assert.deepEqual(requestedOffsets(399), [0]);
  assert.deepEqual(requestedOffsets(400), [0]);
  assert.deepEqual(requestedOffsets(401), [0, 400]);
  assert.deepEqual(requestedOffsets(801), [0, 400, 800]);
  assert.deepEqual(requestedOffsets(1201), [0, 400, 800, 1200]);
});

test('continuations fail closed on stalled, skipped, malformed, or unproven pagination', () => {
  assert.equal(canonicalNext(0, 400, 400), 400);
  assert.equal(canonicalNext(400, 400, 800), 800);
  assert.equal(canonicalNext(400, 400, 400), null);
  assert.equal(canonicalNext(400, 400, 900), null);
  assert.equal(canonicalNext(400, 400, 'not-an-offset'), null);
  assert.match(showXrefs, /!rowsValid \|\| !pageInfo \|\| !Object\.hasOwn\(pageInfo, 'next'\)/);
  assert.match(showXrefs, /function markPaginationPartial|const markPaginationPartial/);
  assert.match(showXrefs, /completeness = 'partial';/);
});

test('pagination authority is primitive safe integer or null without coercion laundering', () => {
  for (const raw of ['401', [401], { value:401 }, true]) {
    assert.notEqual(Number(raw), null, 'precondition: raw value is coercible, so it must be type-rejected');
  }
  assert.match(showXrefs, /typeof rawTotal !== 'number' \|\| !Number\.isSafeInteger\(rawTotal\)/);
  assert.match(showXrefs, /typeof candidateNext !== 'number' \|\| !Number\.isSafeInteger\(candidateNext\)/);
  assert.doesNotMatch(showXrefs, /Number\(rawTotal\)/);
  assert.doesNotMatch(showXrefs, /Number\(rawNext\)/);
});

test('trusted total exhaustion contradiction cannot claim complete (401 total, next:null after 400 rows)', () => {
  assert.match(showXrefs, /if \(rawNext == null\) \{\s*\n\s*nextOffset = null;\s*\n\s*if \(exactTotal != null && loaded < exactTotal\) \{\s*\n\s*markPaginationPartial\(\);/);
  assert.equal(requestedOffsets(401).length, 2, 'a 401-row set must have a second reachable page while continuation exists');
});

test('producer non-completeness stays sticky and only trustworthy complete totals are disclosed', () => {
  assert.match(showXrefs, /completeness === 'complete' \|\| completeness === 'unknown' \|\| pageCompleteness === 'truncated'/);
  assert.match(showXrefs, /pageCompleteness !== 'complete'/);
  assert.match(showXrefs, /let totalTrusted = true;/);
  assert.match(showXrefs, /exactTotal = null;/);
  assert.match(showXrefs, /\$\{loaded\.toLocaleString\(\)\}\/\$\{exactTotal\.toLocaleString\(\)\} 件表示/);
});

test('sheet close aborts snapshot and every xref continuation request', () => {
  assert.match(showXrefs, /onClose:\(\) => controller\.abort\('xrefs-sheet-closed'\)/);
  assert.match(showXrefs, /api\.snapshot\(\{ signal:controller\.signal \}\)/);
  assert.match(showXrefs, /\{ signal:controller\.signal \},\n\s*\);/);
  assert.match(showXrefs, /controller\.signal\.aborted \|\| !sheet\.root\.isConnected/);
});
