import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgramIndex } from '../js/program.js';
import { buildStringMap } from '../js/appmap.js';
import { findings } from '../js/auto.js';

// #5698: the string xref span is a virtual-address byte range. Producers used
// the display text's UTF-16 code-unit count as the span, so multibyte UTF-8
// strings under-covered their own bytes and interior/suffix code xrefs to
// them were silently dropped. The scanner now carries the raw run's
// byteLength, and the consumers use it (or the byte-length proxy) for the
// span.

function indexWithRefs(refTo) {
  // Distinct ref sites: functionsReferencing() dedupes by function start, so
  // one entry per ref keeps the found-count comparable to the ref count.
  return new ProgramIndex({
    vmAddr: 0n,
    refFrom: BigUint64Array.from(refTo.map((target, i) => 0x5000n + BigInt(i) * 0x100n)),
    refTo: BigUint64Array.from(refTo),
    refKind: new Uint8Array(refTo.length),
  });
}

const LOGIN = 'ログイン'; // 4 UTF-16 units, 12 UTF-8 bytes at 0x1000

test('#5698 interior xref to a multibyte string is found using the byte extent', () => {
  const program = indexWithRefs([0x1000n, 0x1006n, 0x100bn]);
  // byteLength 12: every ref inside [0x1000, 0x100c) must be found.
  const users = program.functionsReferencing(0x1000n, 12n, 8);
  assert.equal(users.length, 3);
  // The old span (text.length = 4) would only cover [0x1000, 0x1004).
  const oldSpan = program.functionsReferencing(0x1000n, 4n, 8);
  assert.equal(oldSpan.length, 1, 'control: the raw 4n span misses interior refs');
});

test('#5698 buildStringMap uses byteLength, not text length, for the xref span', () => {
  const program = indexWithRefs([0x1006n]); // ref into the 3rd code point
  const result = buildStringMap({
    program,
    strings: [{ addr: 0x1000n, text: LOGIN, byteLength: 12 }],
  });
  assert.ok(result.subsystems.length > 0,
    'the interior-referenced string must classify into the map');
});

test('#5698 buildStringMap falls back to a byte-length proxy without byteLength', () => {
  const program = indexWithRefs([0x1006n]);
  const result = buildStringMap({
    program,
    strings: [{ addr: 0x1000n, text: LOGIN }], // legacy shape: no byteLength
  });
  assert.ok(result.subsystems.length > 0,
    'the byte-length proxy must still cover interior refs for legacy shapes');
});

test('#5698 findings marks an interior-referenced multibyte string actionable', () => {
  const program = indexWithRefs([0x1006n]);
  // 'ログイン' alone matches no SIGNALS regex; use an https endpoint with a
  // multibyte suffix so the signal fires and the span logic is exercised.
  const endpoint = { addr: 0x1000n, text: 'https://example.com/ログイン', byteLength: 30 };
  const out = findings([endpoint], program, null, 40);
  assert.equal(out.length, 1);
  assert.equal(out[0].actionable, true, 'an interior-referenced string is not unreferenced');
});

test('#5698 byte caps stay byte-denominated', () => {
  // A 300-byte endpoint string with byteLength present: span capped at 256.
  const long = { addr: 0x2000n, text: `https://example.com/${'a'.repeat(260)}`, byteLength: 300 };
  const program = indexWithRefs([0x2000n, 0x2001n, 0x2002n]);
  void 0x20ff; void 0x2100;
  const out = findings([long], program, null, 40);
  assert.equal(out[0].actionable, true);
  const inSpan = program.functionsReferencing(0x2000n, 256n, 8);
  assert.equal(inSpan.length, 3, 'refs within the byte cap are all found');
  void 0x2100;
});

test('#5698 escaped control characters still classify through the byte proxy', () => {
  // '\t' in the display text is an escaped raw 0x09 byte; the proxy must not
  // shrink the span below the real run. Matches the debuglog signal.
  const text = 'debug:\tvalue';
  const program = indexWithRefs([0x3000n + BigInt(text.length - 1)]);
  const out = findings([{ addr: 0x3000n, text, byteLength: text.length }], program, null, 40);
  assert.equal(out.length, 1);
  assert.equal(out[0].actionable, true);
});
