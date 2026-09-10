import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { buildCilCallMetadataIndex } from '../../../js/managed/cil/call-signature-metadata.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const CLI_HEADER_OFFSET = 0x200;
const PE_OPTIONAL_HEADER_OFFSET = 0x98;
const CLI_DIRECTORY_SIZE_OFFSET = PE_OPTIONAL_HEADER_OFFSET + 100 + 14 * 8;

function fixture({ cb = 72, directorySize = 72 } = {}) {
  const { bytes } = buildCil();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(CLI_HEADER_OFFSET, cb, true);
  view.setUint32(CLI_DIRECTORY_SIZE_OFFSET, directorySize, true);
  return bytes;
}

function assertPublicRejects(bytes) {
  const probe = probeCil(bytes);
  assert.equal(probe.supported, false);
  assert.throws(() => parseCil(bytes), /cil-unsupported-binary/);
}

test('#4128: valid 72-byte CLI header remains accepted by public and call-signature paths', () => {
  const bytes = fixture();
  assert.equal(probeCil(bytes).supported, true);
  assert.equal(parseCil(bytes).methods.length, 1);
  assert.doesNotThrow(() => buildCilCallMetadataIndex(bytes));
});

test('#4128: cb below IMAGE_COR20_HEADER size fails closed', () => {
  for (const cb of [0, 1, 71]) {
    const bytes = fixture({ cb });
    assertPublicRejects(bytes);
    assert.throws(() => buildCilCallMetadataIndex(bytes), /cil-invalid-cli-header-size/);
  }
});

test('#4128: cb cannot exceed the CLI data-directory size', () => {
  const bytes = fixture({ cb: 73, directorySize: 72 });
  assertPublicRejects(bytes);
  assert.throws(() => buildCilCallMetadataIndex(bytes), /cil-invalid-cli-header-size/);
});

test('#4128: a mapped future-compatible header extension is accepted when cb fits the directory', () => {
  const bytes = fixture({ cb: 80, directorySize: 80 });
  assert.equal(probeCil(bytes).supported, true);
  assert.equal(parseCil(bytes).methods.length, 1);
  assert.doesNotThrow(() => buildCilCallMetadataIndex(bytes));
});

test('#4128: the complete declared CLI header must be physically mapped', () => {
  const bytes = fixture({ cb: 0x2e01, directorySize: 0x2e01 });
  assertPublicRejects(bytes);
  assert.throws(() => buildCilCallMetadataIndex(bytes), /cil-call-signature-cli-header-unmapped/);
});
