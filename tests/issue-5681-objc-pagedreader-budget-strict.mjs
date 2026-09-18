// Regression for #5681: pagedReader() accepted Array/numeric-string/fractional
// pageBytes/maxPages options through BigInt/relational coercion, laundering
// schema-invalid values into the canonical metadata read/cache budget (or
// leaking a raw SyntaxError from BigInt(['4096.5'])).
// Contract now: only canonical safe-integer numbers are adopted
// (pageBytes >= 1, maxPages >= 0); anything else falls back to the defaults.
import assert from 'node:assert/strict';
import { pagedReader } from '../js/objc-legacy.js';
import { parseObjcExtendedMetadata } from '../js/apple/objc-metadata.js';

function recordingRead(buffer = new Uint8Array(0x80000)) {
  const calls = [];
  const read = async (addr, len, soft) => {
    calls.push({ addr: typeof addr === 'bigint' ? addr : BigInt(addr ?? 0), len });
    const at = Number(addr);
    if (at < 0 || at >= buffer.length) return null;
    const available = buffer.length - at;
    if (available >= len) return buffer.subarray(at, at + len);
    if (soft) return buffer.subarray(at);
    return null;
  };
  return { read, calls };
}

// 1. Structured pageBytes/maxPages must not become the canonical budget.
{
  const { read, calls } = recordingRead();
  const get = pagedReader(read, ['4096'], ['1']);
  await get(0x1000n, 8);
  await get(0x2000n, 8);
  assert.equal(calls[0].len, 65536, 'malformed pageBytes must fall back to the 65536 default');
  assert.equal(calls[0].addr, 0n, 'malformed pageBytes must keep default page alignment');
  assert.equal(calls.length, 1, 'both reads share the default-sized page 0 (cache hit, no second load)');
}

// 1b. Structured maxPages keeps the default cache window across distinct pages.
{
  const { read, calls } = recordingRead();
  const get = pagedReader(read, ['4096'], ['1']);
  await get(0x0n, 8);
  await get(0x10000n, 8);
  assert.equal(calls.length, 2, "malformed maxPages:['1'] must keep the 96-page cache window (both pages load)");
  assert.deepEqual(calls.map((c) => c.len), [65536, 65536]);
}

// 2. Numeric string / boolean / fractional pageBytes never launder into budgets.
for (const malformed of ['4096', true, ['4096.5'], { length: 4096 }]) {
  const { read, calls } = recordingRead();
  const get = pagedReader(read, malformed, 1);
  await get(0x0n, 8);
  assert.equal(calls[0].len, 65536, `malformed pageBytes ${String(malformed)} must fall back to 65536`);
}

// 3. Fractional pageBytes must not leak a raw BigInt SyntaxError.
{
  const { read, calls } = recordingRead();
  const get = pagedReader(read, 4096.5, 1.5);
  await get(0x1000n, 8);
  assert.equal(calls[0].len, 65536, 'fractional budgets must fall back, not throw');
}

// 4. Canonical integer budgets keep the existing read/cache behavior.
{
  const { read, calls } = recordingRead();
  const get = pagedReader(read, 4096, 1);
  await get(0x1000n, 8);
  assert.equal(calls[0].len, 4096, 'canonical pageBytes=4096 must page-read 4096 bytes');
  assert.equal(calls[0].addr, 0x1000n, 'canonical pageBytes=4096 must align reads to 4096');
  await get(0x2000n, 8);
  assert.equal(calls.filter((c) => c.len === 4096).length, 2,
    'canonical maxPages=1 still performs both page loads');
}

// 5. parseObjcExtendedMetadata passes malformed budgets through without a raw throw.
{
  const { read, calls } = recordingRead();
  const sections = { protocolList: { vmAddr: 0x1000n, size: 8n }, categoryList: null };
  const ext = await parseObjcExtendedMetadata(read, sections, { pageBytes: ['4096.5'], maxPages: ['1'] });
  assert.ok(ext, 'extended metadata parse must survive malformed budgets');
  for (const call of calls) {
    assert.equal(call.len, 65536, 'extended metadata parser must use the default page budget for malformed pageBytes');
  }
}

// 6. Canonical pageBytes still reaches the extended metadata parser.
{
  const { read, calls } = recordingRead();
  const sections = { protocolList: { vmAddr: 0x1000n, size: 8n }, categoryList: null };
  await parseObjcExtendedMetadata(read, sections, { pageBytes: 256, maxPages: 4 });
  const pageLoads = calls.filter((c) => c.len === 256);
  assert.ok(pageLoads.length > 0, 'canonical pageBytes=256 must drive 256-byte page loads');
}

console.log('issue-5681 objc paged reader budget strictness: ok');
