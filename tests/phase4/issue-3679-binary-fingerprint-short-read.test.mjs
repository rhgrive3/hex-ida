import assert from 'node:assert/strict';
import { fingerprintImage } from '../../js/binary/fingerprint.js';

function executableSection(fileSize) {
  return {
    fileOffset: 0n,
    fileSize,
    perms: { execute: true },
  };
}

{
  const malformed = {
    bytes: new Uint8Array([0x41]),
    sections: [executableSection(2n)],
    segments: [],
  };
  assert.throws(
    () => fingerprintImage(malformed),
    { name: 'RangeError', message: 'binary-fingerprint-short-read' },
  );
}

{
  const empty = {
    bytes: new Uint8Array(0),
    sections: [],
    segments: [],
  };
  const fingerprint = fingerprintImage(empty);
  assert.equal(fingerprint.bytes, 0);
  assert.equal(fingerprint.scope, 'executable-mappings');
}

{
  const resident = {
    bytes: new Uint8Array([0x41, 0x42]),
    sections: [executableSection(2n)],
    segments: [],
  };
  const sourceBytes = resident.bytes.slice();
  const sourceBacked = {
    source: {
      async readExactly(offset, length) {
        const start = Number(offset);
        return sourceBytes.subarray(start, start + length);
      },
    },
    sections: [executableSection(2n)],
    segments: [],
  };

  const residentFingerprint = fingerprintImage(resident);
  const sourceFingerprint = await fingerprintImage(sourceBacked);
  assert.equal(residentFingerprint.bytes, 2);
  assert.deepEqual(sourceFingerprint, residentFingerprint);
}

{
  const sourceBacked = {
    source: {
      async readExactly(_offset, length) {
        return new Uint8Array(Math.max(0, length - 1));
      },
    },
    sections: [executableSection(2n)],
    segments: [],
  };
  await assert.rejects(
    fingerprintImage(sourceBacked),
    { name: 'RangeError', message: 'binary-fingerprint-short-read' },
  );
}

console.log('issue-3679-binary-fingerprint-short-read: PASS');
