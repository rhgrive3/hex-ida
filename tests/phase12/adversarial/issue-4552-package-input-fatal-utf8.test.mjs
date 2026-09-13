import assert from 'node:assert/strict';
import {
  PackageValidationError,
  createPackageEnvelope,
  importPhase12Package,
  parseBoundedPackageInput,
} from '../../../js/phase12/package-envelope.js';

// #4552: parseBoundedPackageInput() decoded byte package input with a
// non-fatal TextDecoder, so bytes that are not valid UTF-8 were silently
// replaced with U+FFFD and accepted as a different well-formed Unicode JSON
// value. The .hexproj parser already decodes with { fatal: true }; Phase 12
// package ingress must not be the loose one.

function bytesOf(...parts) {
  const chunks = parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function isUtf8Rejection(error) {
  return error instanceof PackageValidationError && error.code === 'package-input-invalid-utf8';
}

// 1. a stray 0xff byte inside a JSON string is rejected, not aliased to U+FFFD.
assert.throws(
  () => parseBoundedPackageInput(bytesOf('{"value":"', [0xff], '"}')),
  isUtf8Rejection,
  'invalid UTF-8 byte 0xff must be rejected at the decode boundary',
);

// 2. other malformed encodings fail closed the same way: a truncated
//    sequence, a dangling continuation byte, an illegal surrogate encoding
//    (ED A0 80) and a byte order mark in the middle of the payload.
assert.throws(() => parseBoundedPackageInput(bytesOf('{"value":"', [0xc3], '"}')), isUtf8Rejection, 'truncated 2-byte sequence must be rejected');
assert.throws(() => parseBoundedPackageInput(bytesOf('{"value":"', [0xa9], '"}')), isUtf8Rejection, 'dangling continuation byte must be rejected');
assert.throws(() => parseBoundedPackageInput(bytesOf('{"value":"', [0xed, 0xa0, 0x80], '"}')), isUtf8Rejection, 'CESU-8 style surrogate encoding must be rejected');
assert.throws(() => parseBoundedPackageInput(bytesOf('{"a":', [0xff], '}')), isUtf8Rejection, 'invalid byte after a value must be rejected');
assert.throws(() => parseBoundedPackageInput(bytesOf('{"val', [0xff], 'ue":1}')), isUtf8Rejection, 'invalid byte inside a key must be rejected');
assert.throws(() => parseBoundedPackageInput(Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), isUtf8Rejection, 'raw 0xff inside a string value must be rejected');

// 2b. leading garbage that never even forms JSON structure fails closed too.
assert.throws(
  () => parseBoundedPackageInput(Uint8Array.from([0xff, 0xfe, 0x00, 0x7b])),
  (error) => error instanceof PackageValidationError,
  'non-UTF-8 leading bytes must never parse into a package value',
);

// 3. the rejection is a normalized package validation error, never a bare
//    TypeError from the decoder, and the malformed bytes never reach JSON.
for (const input of [bytesOf('{"value":"', [0xff], '"}'), Uint8Array.from([0xf5, 0x80, 0x80, 0x80])]) {
  try {
    parseBoundedPackageInput(input);
    assert.fail('invalid UTF-8 byte input must throw');
  } catch (error) {
    assert.ok(error instanceof PackageValidationError, `decode failure must be a PackageValidationError, got ${error?.name}`);
    assert.notEqual(error.name, 'TypeError');
    assert.equal(error.code, 'package-input-invalid-utf8');
  }
}

// 4. canonical UTF-8 byte input keeps parsing exactly as before.
const canonical = bytesOf('{"value":"héllo \u{1f600} 日本語","n":1}');
const parsedCanonical = parseBoundedPackageInput(canonical);
assert.equal(parsedCanonical.value.value, 'héllo \u{1f600} 日本語');
assert.equal(parsedCanonical.value.n, 1);
assert.equal(parsedCanonical.inputBytes, canonical.byteLength);

// 5. string input semantics are unchanged, including non-ASCII text.
const asString = new TextDecoder().decode(canonical);
assert.deepEqual(parseBoundedPackageInput(asString).value, parsedCanonical.value);
assert.throws(
  () => parseBoundedPackageInput('{"value":}'),
  (error) => error instanceof PackageValidationError && error.code === 'package-json-malformed',
  'valid UTF-8 with malformed JSON keeps the json-malformed code',
);
assert.throws(
  () => parseBoundedPackageInput(bytesOf('{"value":', [0xff], '}')),
  isUtf8Rejection,
  'encoding strictness is checked before JSON well-formedness',
);

// 6. byte budget and content identity contracts are not weakened.
assert.throws(
  () => parseBoundedPackageInput(Uint8Array.from(JSON.stringify({ a: 'x'.repeat(200) }).split('').map((ch) => ch.charCodeAt(0))), { maxBytes: 32 }),
  (error) => error instanceof PackageValidationError && error.code === 'package-input-too-large',
  'oversized byte input still fails the pre-parse byte budget',
);
const envelope = createPackageEnvelope({ kind: 'knowledge', packageId: 'utf8-pkg', packageVersion: '1', payload: { note: 'café \u{1f600}' } });
const envelopeBytes = bytesOf(JSON.stringify(envelope));
assert.equal(importPhase12Package(envelopeBytes).contentHash, envelope.contentHash);
assert.equal(importPhase12Package(new TextDecoder().decode(envelopeBytes)).contentHash, envelope.contentHash);
assert.throws(
  () => importPhase12Package(bytesOf('{"format":"hex-phase12-package-envelope-v1","value":"', [0xff], '"}')),
  isUtf8Rejection,
  'package import through the byte path is strict too',
);

console.log('issue-4552: package input fatal UTF-8 regressions green');
