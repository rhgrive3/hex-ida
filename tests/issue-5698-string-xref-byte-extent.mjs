import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgramIndex } from '../js/program.js';
import { buildStringMap } from '../js/appmap.js';
import { findings } from '../js/auto.js';

// #5698: the string xref span is a virtual-address byte range. Producers used
// the display text's UTF-16 code-unit count as the span, so multibyte UTF-8
// strings under-covered their own bytes and interior/suffix code xrefs to
// them were silently dropped. The scanner now carries the raw run's
// byteLength, and the consumers use it — validated against the provable
// producer window derived from the control-escaped display text; malformed,
// forged, or missing extents fail closed (no over-inclusive authority).

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

test('#5698 without byteLength the fallback is the provable minimum, never over-inclusive', () => {
  // Legacy shapes carry no byteLength. The escaped display cannot prove the
  // exact raw extent, so the fallback span is the provable minimum (one raw
  // byte per display code point): base xrefs stay covered, but the span is
  // never inflated beyond what the display can prove (fail-closed, R1).
  const program = indexWithRefs([0x1000n]);
  const result = buildStringMap({
    program,
    strings: [{ addr: 0x1000n, text: LOGIN }], // legacy shape: no byteLength
  });
  assert.ok(result.subsystems.length > 0,
    'a base xref stays covered by the provable-minimum fallback');
  const interior = indexWithRefs([0x1006n]);
  assert.equal(buildStringMap({ program: interior, strings: [{ addr: 0x1000n, text: LOGIN }] }).subsystems.length, 0,
    'an interior ref beyond the provable minimum is NOT covered (no over-valuation)');
});

test('#5698 a forged byteLength larger than the string gets no xref authority', () => {
  // R1 counterexample: the real string is 25 bytes, but the entry lies with
  // byteLength 128 — xrefs beyond the real extent must not become referenced.
  const program = indexWithRefs([0x1070n]); // inside the forged [0x1000,0x1080), outside the real 25 bytes
  const strings = [{ addr: 0x1000n, text: 'https://example.com/login', byteLength: 128 }];
  assert.equal(buildStringMap({ program, strings }).subsystems.length, 0,
    'buildStringMap must not classify through a forged byteLength');
  const out = findings(strings, program, null, 40);
  assert.equal(out.length, 1, 'the endpoint signal still fires');
  assert.equal(out[0].actionable, false,
    'findings must not mark a forged-extent string referenced');
});

test('#5698 malformed byteLength spellings get no xref authority', () => {
  const program = indexWithRefs([0x1000n]);
  const out = findings([
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: '25' },
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: [25] },
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: true },
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: 0 },
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: -25 },
    { addr: 0x1000n, text: 'https://example.com/login', byteLength: 25.5 },
  ], program, null, 40);
  assert.equal(out.length, 6, 'the strings stay visible as data');
  for (const entry of out) {
    assert.equal(entry.actionable, false, 'malformed byteLength must fail closed');
    assert.equal(entry.status, 'unreferenced');
  }
});

test('#5698 the legacy escaped-display fallback never over-counts the raw extent', () => {
  // R1 counterexample: raw `debug:\tvalue` is 12 raw bytes; the scanner's
  // escaped display is 13 units. A display-derived fallback must NOT count
  // the escape as its two display characters, or a ref at addr+12 (past the
  // real string) would be treated as inside the string.
  const program = indexWithRefs([0x3000n + 12n]); // first byte past the real run
  const out = findings([{ addr: 0x3000n, text: 'debug:\\tvalue' }], program, null, 40);
  assert.equal(out[0].actionable, false,
    'the escaped display fallback must not cover bytes past the real run');
  const lastByte = indexWithRefs([0x3000n + 11n]);
  const outLast = findings([{ addr: 0x3000n, text: 'debug:\\tvalue' }], lastByte, null, 40);
  assert.equal(outLast[0].actionable, true,
    'the last real raw byte stays covered');
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
  // A 280-byte ASCII endpoint string with byteLength present: span capped at 256.
  const long = { addr: 0x2000n, text: `https://example.com/${'a'.repeat(260)}`, byteLength: 280 };
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

test('#5698 base xrefs to an ASCII login string stay detected (control)', () => {
  // Required regression #1: the pre-#5698 ASCII behavior is preserved. A ref
  // at the string base must keep classifying the string.
  const program = indexWithRefs([0x1000n]);
  const result = buildStringMap({
    program,
    strings: [{ addr: 0x1000n, text: 'https://example.com/login', byteLength: 25 }],
  });
  assert.ok(result.subsystems.length > 0, 'ASCII base xref still classifies');
  const out = findings([{ addr: 0x1000n, text: 'https://example.com/login', byteLength: 25 }],
    program, null, 40);
  assert.equal(out[0].actionable, true, 'the ASCII control stays actionable');
});

test('#5698 base xrefs to a multibyte string are detected by the consumer', () => {
  // Required regression #2: a ref at the BASE of ログイン (not only interior
  // offsets) classifies through buildStringMap().
  const program = indexWithRefs([0x1000n]);
  const result = buildStringMap({
    program,
    strings: [{ addr: 0x1000n, text: LOGIN, byteLength: 12 }],
  });
  assert.ok(result.subsystems.length > 0, 'the multibyte base xref classifies');
});

test('#5698 the real worker producer carries raw extents for 2/3/4-byte code points', async () => {
  // Required regression #5: each UTF-8 code-point class keeps its raw run
  // byte extent (which differs from the decoded display length).
  const { NodeBackend } = await import('./harness.mjs');
  const raw = new Uint8Array([
    ...Buffer.from('café', 'utf8'), 0x00,           // 2-byte é: 5 raw bytes
    ...Buffer.from('ログイン', 'utf8'), 0x00,        // 3-byte code points: 12 raw bytes
    ...Buffer.from('𝒜𝒷', 'utf8'),                   // 4-byte code points: 8 raw bytes
  ]);
  const file = {
    name: 'issue-5698-codepoint-classes.bin',
    size: raw.length,
    slice(start, end) {
      const part = raw.subarray(start, end);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
  const backend = new NodeBackend();
  const info = await backend.open(file);
  const scan = await backend.strings({ regionId: info.raw.id, min: 2, limit: 8 });
  assert.equal(scan.cancelled, false);
  const byText = new Map(scan.results.map((entry) => [entry.text, entry]));
  const cases = [
    ['café', 5, 4],       // [text, rawBytes, displayUnits (UTF-16 units)]
    ['ログイン', 12, 4],
    ['𝒜𝒷', 8, 4],
  ];
  for (const [text, rawBytes, displayUnits] of cases) {
    const entry = byText.get(text);
    assert.ok(entry, `the ${rawBytes}-byte string must be scanned`);
    assert.equal(entry.text.length, displayUnits, `${text}: display length`);
    assert.equal(entry.byteLength, rawBytes, `${text}: raw byte extent is preserved`);
    assert.notEqual(entry.byteLength, entry.text.length, `${text}: raw extent differs from display length`);
  }
});

test('#5698 the findings 256-byte cap is byte-denominated at its boundary', () => {
  // Required regression #7: refs at the last byte inside the 256-byte cap
  // stay actionable; refs inside the real 280-byte string but beyond the cap
  // must NOT be. Enlarging the cap to 280 would flip the second assertion.
  const long = { addr: 0x2000n, text: `https://example.com/${'a'.repeat(260)}`, byteLength: 280 };
  const inside = indexWithRefs([0x2000n + 255n]);
  const out = findings([long], inside, null, 40);
  assert.equal(out[0].actionable, true, 'a ref at cap-1 (byte 255) is covered');
  const beyond = indexWithRefs([0x2000n + 260n]);
  const outBeyond = findings([long], beyond, null, 40);
  assert.equal(outBeyond[0].actionable, false,
    'a ref at byte 260 lies beyond the 256-byte cap even though the string is 300 bytes');
  const atCap = indexWithRefs([0x2000n + 256n]);
  const outAtCap = findings([long], atCap, null, 40);
  assert.equal(outAtCap[0].actionable, false,
    'the cap is exclusive of byte offset 256');
});

test('#5698 the buildStringMap 128-byte cap is byte-denominated at its boundary', () => {
  // The map's span cap is 128 bytes: a ref at byte 127 classifies the string,
  // a ref at byte 130 (inside the real 180-byte string) does not.
  const long = { addr: 0x4000n, text: `https://example.com/${'a'.repeat(160)}`, byteLength: 180 };
  const inside = indexWithRefs([0x4000n + 127n]);
  assert.ok(buildStringMap({ program: inside, strings: [long] }).subsystems.length > 0,
    'a ref at cap-1 (byte 127) classifies');
  const beyond = indexWithRefs([0x4000n + 130n]);
  assert.equal(buildStringMap({ program: beyond, strings: [long] }).subsystems.length, 0,
    'a ref at byte 130 lies beyond the 128-byte cap');
});

test('#5698 the real worker scanStrings producer carries the raw run byte extent', async () => {
  // Producer→consumer contract: the classic worker's scanStrings() is the
  // producer of the strings consumed by buildStringMap()/findings(). It
  // display-escapes TAB/CR/LF, so its escaped text is LONGER than the raw run
  // (here 17 display chars for 14 raw bytes). The emitted byteLength must be
  // the raw run's byte extent, not the escaped display length; the consumer
  // span must then cover the raw run.
  const { NodeBackend } = await import('./harness.mjs');
  const raw = new TextEncoder().encode('debug:\t\r\nvalue');
  assert.equal(raw.length, 14);
  const bytes = new Uint8Array(raw.length + 4);
  bytes.set(raw, 2);
  const file = {
    name: 'issue-5698-control-bytes.bin',
    size: bytes.length,
    slice(start, end) {
      const part = bytes.subarray(start, end);
      return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    },
  };
  const backend = new NodeBackend();
  const info = await backend.open(file);
  assert.ok(info.raw?.id, 'raw region must be available');
  const scan = await backend.strings({ regionId: info.raw.id, min: 2, limit: 8 });
  assert.equal(scan.cancelled, false);
  const entry = scan.results.find((candidate) => candidate.text.includes('debug'));
  assert.ok(entry, 'the control-character string must be scanned');
  assert.equal(entry.text, 'debug:\\t\\r\\nvalue', 'display text stays control-escaped');
  assert.equal(entry.text.length, 17, 'the escaped display text is longer than the raw run');
  assert.equal(entry.byteLength, 14, 'byteLength is the raw run extent, not the display length');

  // Consumer: a ref to the last raw byte (offset 13) must fall inside the
  // producer-carried byte extent.
  const consumerProgram = indexWithRefs([entry.addr + 13n]);
  const out = findings([{ addr: entry.addr, text: entry.text, byteLength: entry.byteLength }],
    consumerProgram, null, 40);
  assert.equal(out.length, 1, 'the debug signal fires');
  assert.equal(out[0].actionable, true, 'the interior ref is covered by the raw byte extent');
});
