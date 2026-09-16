import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openBinary } from '../../js/binary/index.js';

const sourceUrl = new URL('./fixtures/x02-arm64e-authenticated.c', import.meta.url);
const binaryUrl = new URL('./fixtures/x02-arm64e-authenticated.o', import.meta.url);
const provenanceUrl = new URL('./fixtures/x02-arm64e-authenticated-provenance.json', import.meta.url);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const occurrences = (bytes, word) => {
  const result = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    if (u32(bytes, offset) === word) result.push(offset);
  }
  return result;
};

test('X02-F-48 uses a pinned compiler-produced arm64e Mach-O with PAC return instructions', () => {
  const source = fs.readFileSync(sourceUrl);
  const bytes = fs.readFileSync(binaryUrl);
  const provenance = JSON.parse(fs.readFileSync(provenanceUrl, 'utf8'));

  assert.equal(provenance.acceptanceRow, 'X02-F-48');
  assert.equal(sha256(source), provenance.sourceSha256);
  assert.equal(sha256(bytes), provenance.binarySha256);
  assert.equal(bytes.length, provenance.binaryByteLength);
  assert.equal(provenance.claims.compilerProduced, true);
  assert.equal(provenance.claims.handEncoded, false);

  const sourceText = source.toString('utf8');
  assert.doesNotMatch(sourceText, /\b(?:__asm__|asm)\b|\.inst\b|0xd50323(?:3f|bf)\b|0xd65f0bff\b/i,
    'PAC words must come from the compiler, not inline assembly or hand-encoded constants');

  assert.equal(u32(bytes, 0), 0xfeedfacf);
  assert.equal(u32(bytes, 4), 0x0100000c);
  const cpuSubtype = u32(bytes, 8);
  assert.equal(cpuSubtype & 0x00ffffff, 2, 'Mach-O CPU subtype must be ARM64E');
  assert.equal((cpuSubtype & 0xff000000) >>> 0, 0x80000000, 'ARM64E PAC capability bit must be retained');

  const image = openBinary(bytes);
  assert.equal(image.format, provenance.expected.format);
  assert.equal(image.arch, provenance.expected.architecture);
  assert.equal(image.platform, provenance.expected.platform);
  assert.equal(image.metadata.buildVersion?.minos, provenance.expected.minimumOS);
  assert.equal(image.metadata.buildVersion?.source, 'LC_BUILD_VERSION');

  const paciasp = occurrences(bytes, 0xd503233f);
  const autiasp = occurrences(bytes, 0xd50323bf);
  const retaa = occurrences(bytes, 0xd65f0bff);
  assert.ok(paciasp.length >= 1, 'compiler-produced object must contain PACIASP');
  assert.ok(autiasp.length >= 1 || retaa.length >= 1,
    'compiler-produced object must contain an authenticated return path');

  assert.equal(provenance.claims.runtimeAuthenticationExecuted, false);
  assert.equal(provenance.claims.osExecutionVerified, false);
  assert.equal(provenance.claims.cryptographicSigningVerified, false);
  assert.equal(provenance.claims.independentExternalOracleExecuted, false);
});
