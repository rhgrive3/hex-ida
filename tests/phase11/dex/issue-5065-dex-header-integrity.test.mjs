import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDex } from '../../../js/managed/dex/parser.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { applyDexIntegrity, dexAdler32, dexSha1 } from '../fixtures/dex-integrity.mjs';
import { buildDex } from '../fixtures/medium-dex.mjs';

// #5065: header bytes 0x08..0x0b (Adler-32 checksum) and 0x0c..0x1f (SHA-1
// signature) are AOSP integrity constraints G2/G3. The parser read neither, so a
// corrupted binary could be published as a valid managed image.

function validDex() {
  return applyDexIntegrity(buildDex({
    classNames: ['LTest;'],
    methods: [{ classType: 'LTest;', name: 'foo', returnType: 'V', params: [], words: [0x000e] }],
    fields: [{ classType: 'LTest;', type: 'I', name: 'x' }],
  }).bytes);
}

function inertPayloadOffset() {
  // buildDex keeps 16 unreferenced padding bytes after the string_data_items;
  // flipping one changes only the integrity fields, never the decoded topology.
  const { bytes, layout } = buildDex({});
  return layout.stringDataEnd + 8;
}

test('#5065 a valid checksum and signature are accepted', () => {
  const image = parseDex(validDex());
  assert.ok(image.strings.includes('LTest;'));
  assert.equal(image.classes[0].classType, 'LTest;');
});

test('#5065 the stored checksum equals Adler-32 over bytes 12..EOF', () => {
  const bytes = validDex();
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(8, true), dexAdler32(bytes, 12));
});

test('#5065 the stored signature equals SHA-1 over bytes 32..EOF', () => {
  const bytes = validDex();
  assert.deepEqual(Buffer.from(bytes.subarray(12, 32)), Buffer.from(dexSha1(bytes, 32)));
});

test('#5065 a single checksum bit flip is rejected', () => {
  const bytes = validDex();
  bytes[8] ^= 0x01;
  assert.throws(() => parseDex(bytes), (error) => error instanceof TypeError && error.message === 'dex-checksum-mismatch');
});

test('#5065 an arbitrary stored checksum value is rejected', () => {
  const bytes = validDex();
  new DataView(bytes.buffer).setUint32(8, 0, true);
  assert.throws(() => parseDex(bytes), /dex-checksum-mismatch/);
  const other = validDex();
  new DataView(other.buffer).setUint32(8, 0xffffffff, true);
  assert.throws(() => parseDex(other), /dex-checksum-mismatch/);
});

test('#5065 a signature bit flip with a recomputed checksum is rejected as a signature mismatch', () => {
  const bytes = validDex();
  bytes[12] ^= 0x01;
  new DataView(bytes.buffer).setUint32(8, dexAdler32(bytes, 12), true);
  assert.throws(() => parseDex(bytes), (error) => error instanceof TypeError && error.message === 'dex-signature-mismatch');
});

test('#5065 a payload bit flip is rejected on integrity even though the topology still parses', () => {
  const bytes = validDex();
  const offset = inertPayloadOffset();
  assert.ok(offset >= 0x20 && offset < bytes.length - 16);
  bytes[offset] ^= 0x80;
  // The flip is topologically inert: with integrity restamped the same bytes
  // still publish a valid image, so the rejection below is integrity-only.
  assert.ok(parseDex(applyDexIntegrity(bytes.slice())).strings.includes('LTest;'));
  assert.throws(() => parseDex(bytes), /dex-checksum-mismatch|dex-signature-mismatch/);
});

test('#5065 an integrity failure is never published as a valid managed image', async () => {
  const bytes = validDex();
  bytes[9] ^= 0x02;
  await assert.rejects(() => new DexFrontend().open(bytes), /dex-checksum-mismatch/);
});

test('#5065 a structurally invalid image keeps its format-specific error authority', () => {
  const bytes = validDex();
  new DataView(bytes.buffer).setUint32(32, bytes.length + 8, true);
  assert.throws(() => parseDex(bytes), /dex-file-size-mismatch/);
});
