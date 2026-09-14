import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../js/ui/panels/field-access.js', import.meta.url), 'utf8');

assert.match(source, /const FIELD_ACCESS_PAGE_SIZE = 60;/, 'field access UI must keep a bounded first render');
assert.doesNotMatch(source, /grouped\.slice\(0,\s*60\)/, 'field access UI must not silently discard groups after the first 60');
assert.match(source, /grouped\.slice\(shownGroups,\s*end\)/, 'additional pages must continue from the prior group boundary');
assert.match(source, /shownGroups < grouped\.length/, 'pagination control must remain while undisplayed groups exist');
assert.match(source, /\$\{shownGroups\}\/\$\{grouped\.length\} functions/, 'pagination control must disclose shown/total function groups');
assert.match(source, /grouped\.length > FIELD_ACCESS_PAGE_SIZE\) host\.append\(paging\)/, 'pagination affordance must be present whenever the bounded first render omits groups');

function visibleCounts(total, pageSize = 60) {
  const counts = [];
  let shown = 0;
  do {
    shown = Math.min(shown + pageSize, total);
    counts.push(shown);
  } while (shown < total);
  return counts;
}

assert.deepEqual(visibleCounts(60), [60], '60 groups fit without truncation');
assert.deepEqual(visibleCounts(61), [60, 61], '61st group must be reachable');
assert.deepEqual(visibleCounts(121), [60, 120, 121], '120+ groups must remain reachable without gaps');

console.log('issue-4878-field-access-pagination: ok');
