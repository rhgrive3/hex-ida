// Issue #5381 regression: scanStrings() stored only MAX_STRING_CHARS*4 bytes
// (~1600) of a longer run and returned the prefix as if it were the complete
// string. The per-result entry must carry truncated:true so callers can never
// treat a display-budget prefix as full string identity.
import assert from 'node:assert/strict';
import { NodeBackend } from './harness.mjs';

const longString = 'A'.repeat(1600) + 'UNIQUE_SUFFIX';
const bytes = new TextEncoder().encode(longString + '\0' + 'B'.repeat(1600) + 'TYPE_TWO' + '\0');
const file = {
  name: 'issue-5381.bin',
  size: bytes.length,
  slice(start, end) {
    const part = bytes.subarray(start, end);
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  },
};

const backend = new NodeBackend();
const info = await backend.open(file);
const regionId = info.raw.id;
const res = await backend.strings({ regionId, min: 4, limit: 20 });
assert.equal(res.cancelled, false);
assert.equal(res.capped, false, 'a per-string cap is not a result-count cap');
assert.equal(res.results.length, 2, 'both NUL-terminated runs are found');

const [first, second] = res.results;
assert.equal(first.text, 'A'.repeat(1600), 'only the stored prefix is returned');
assert.equal(first.truncated, true, 'the prefix entry must be flagged truncated, not passed off as the complete string');
assert.equal(first.text.includes('UNIQUE_SUFFIX'), false);
assert.equal(second.truncated, true, 'the second over-cap run is flagged too');
assert.equal(second.text, 'B'.repeat(1600));

console.log('issue #5381 scanStrings per-string truncation flag regressions: PASS');
