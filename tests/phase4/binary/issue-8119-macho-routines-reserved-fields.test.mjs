import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const LC_SEGMENT = 0x1;
const LC_ROUTINES = 0x11;
const LC_SEGMENT_64 = 0x19;
const LC_ROUTINES_64 = 0x1a;
const INIT_ADDRESS = 0x1180n;

function put(bytes, offset, text) {
  bytes.set(Buffer.from(text), offset);
}

function macho64({ reservedIndex = null, reservedValue = 0n } = {}) {
  const bytes = new Uint8Array(0x500);
  const v = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  v.setInt32(4, 0x0100000c, true); // arm64
  v.setInt32(8, 0, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, 2, true);
  v.setUint32(20, 72 + 72, true);

  let p = 32;
  v.setUint32(p, LC_SEGMENT_64, true);
  v.setUint32(p + 4, 72, true);
  put(bytes, p + 8, '__TEXT');
  v.setBigUint64(p + 24, 0x1000n, true);
  v.setBigUint64(p + 32, 0x1000n, true);
  v.setBigUint64(p + 40, 0n, true);
  v.setBigUint64(p + 48, 0x400n, true);
  v.setInt32(p + 56, 5, true);
  v.setInt32(p + 60, 5, true);

  p += 72;
  v.setUint32(p, LC_ROUTINES_64, true);
  v.setUint32(p + 4, 72, true);
  v.setBigUint64(p + 8, INIT_ADDRESS, true);
  v.setBigUint64(p + 16, 7n, true);
  if (reservedIndex != null) {
    v.setBigUint64(p + 24 + reservedIndex * 8, reservedValue, true);
  }

  v.setUint32(Number(INIT_ADDRESS - 0x1000n), 0xd65f03c0, true);
  return bytes;
}

function macho32({ reservedIndex = null, reservedValue = 0 } = {}) {
  const bytes = new Uint8Array(0x300);
  const v = new DataView(bytes.buffer);
  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  v.setInt32(4, 7, true); // x86
  v.setInt32(8, 3, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, 2, true);
  v.setUint32(20, 56 + 40, true);

  let p = 28;
  v.setUint32(p, LC_SEGMENT, true);
  v.setUint32(p + 4, 56, true);
  put(bytes, p + 8, '__TEXT');
  v.setUint32(p + 24, 0x1000, true);
  v.setUint32(p + 28, 0x1000, true);
  v.setUint32(p + 32, 0, true);
  v.setUint32(p + 36, 0x300, true);
  v.setInt32(p + 40, 5, true);
  v.setInt32(p + 44, 5, true);

  p += 56;
  v.setUint32(p, LC_ROUTINES, true);
  v.setUint32(p + 4, 40, true);
  v.setUint32(p + 8, Number(INIT_ADDRESS), true);
  v.setUint32(p + 12, 3, true);
  if (reservedIndex != null) {
    v.setUint32(p + 16 + reservedIndex * 4, reservedValue, true);
  }

  bytes[Number(INIT_ADDRESS - 0x1000n)] = 0xc3;
  return bytes;
}

function routineSeed(image) {
  return image.functions.find(
    (f) => f.address === INIT_ADDRESS && (f.source === 'routines' || f.sources?.includes('routines')),
  );
}

for (const [command, makeCanonical] of [
  ['LC_ROUTINES_64', () => macho64()],
  ['LC_ROUTINES', () => macho32()],
]) {
  const image = parseMachO(makeCanonical());
  assert.equal(image.metadata.routines?.length, 1, `${command}: canonical record must remain publishable`);
  assert.ok(routineSeed(image), `${command}: all-zero reserved fields must preserve exact function evidence`);
  assert.equal(image.metadata.machoMetadata.complete, true, `${command}: canonical command stays complete`);
}

for (let reservedIndex = 0; reservedIndex < 6; reservedIndex++) {
  for (const tc of [
    { command:'LC_ROUTINES_64', cmd:LC_ROUTINES_64, bytes:macho64({ reservedIndex, reservedValue:1n }) },
    { command:'LC_ROUTINES', cmd:LC_ROUTINES, bytes:macho32({ reservedIndex, reservedValue:1 }) },
  ]) {
    const image = parseMachO(tc.bytes);
    assert.equal(
      image.metadata.routines,
      undefined,
      `${tc.command} reserved${reservedIndex + 1}: malformed command must not publish lifecycle authority`,
    );
    assert.equal(
      routineSeed(image),
      undefined,
      `${tc.command} reserved${reservedIndex + 1}: malformed command must not mint exact function evidence`,
    );
    assert.equal(image.metadata.machoMetadata.complete, false);
    assert.ok(
      image.metadata.machoMetadata.reasons.includes(`load-command-0x${tc.cmd.toString(16)}-parse-error`),
      `${tc.command} reserved${reservedIndex + 1}: malformed command must leave a partial diagnostic`,
    );
  }
}

console.log('issue-8119 Mach-O LC_ROUTINES[_64] reserved-field authority: PASS');
