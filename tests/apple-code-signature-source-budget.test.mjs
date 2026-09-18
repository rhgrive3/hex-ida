import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAppleCodeSignature } from '../js/apple/knowledge.js';
import { SparseByteBuffer } from '../js/binary/source-reader.js';

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;

test('source-backed code-signature parsing defers an uncached large signature blob', () => {
  const declaredSize = 1024 * 1024;
  const sparse = new SparseByteBuffer(BigInt(declaredSize));
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, CSMAGIC_EMBEDDED_SIGNATURE, false);
  view.setUint32(4, declaredSize, false);
  view.setUint32(8, 1, false);
  sparse.add(0n, header);

  const signature = parseAppleCodeSignature(sparse, {
    dataOffset: 0,
    dataSize: declaredSize,
    containerOffset: 0n,
    commandOffset: 0x40n,
  });

  assert.equal(signature.status, 'partial');
  assert.equal(signature.complete, false);
  assert.deepEqual(signature.reasons, ['signature-bytes-deferred']);
  assert.equal(signature.validity, 'unknown');
  assert.equal(signature.authoritativeValidation, null);
  assert.deepEqual(signature.blobs, []);
  assert.deepEqual(signature.codeDirectories, []);
  assert.deepEqual(signature.provenance, {
    commandOffset: 0x40n,
    dataOffset: 0n,
    dataSize: declaredSize,
  });
});
