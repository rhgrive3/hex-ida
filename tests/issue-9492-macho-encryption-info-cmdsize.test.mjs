import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';

function u32(b, o, v) { new DataView(b.buffer).setUint32(o, v, true); }
function u64(b, o, v) { new DataView(b.buffer).setBigUint64(o, BigInt(v), true); }
const enc = new TextEncoder();

const HEADER_64 = 32;
const HEADER_32 = 28;
const SEGMENT_64 = 72;
const SEGMENT_32 = 56;
const FILE_BODY = 0x8000;

function segment64(fileSize = FILE_BODY) {
  const b = new Uint8Array(SEGMENT_64);
  u32(b, 0, 0x19); u32(b, 4, SEGMENT_64); b.set(enc.encode('__TEXT\0'), 8);
  u64(b, 24, 0x10000000n); u64(b, 32, fileSize); u64(b, 40, 0); u64(b, 48, fileSize);
  u32(b, 56, 7); u32(b, 60, 5); u32(b, 64, 0); u32(b, 68, 0);
  return b;
}

function segment32(fileSize = FILE_BODY) {
  const b = new Uint8Array(SEGMENT_32);
  u32(b, 0, 0x1); u32(b, 4, SEGMENT_32); b.set(enc.encode('__TEXT\0'), 8);
  u32(b, 24, 0x1000); u32(b, 28, fileSize); u32(b, 32, 0); u32(b, 36, fileSize);
  u32(b, 40, 7); u32(b, 44, 5); u32(b, 48, 0); u32(b, 52, 0);
  return b;
}

function encryptionCmd(cmd, size, cryptoff, cryptsize, cryptid) {
  const b = new Uint8Array(size);
  u32(b, 0, cmd); u32(b, 4, size);
  u32(b, 8, cryptoff); u32(b, 12, cryptsize); u32(b, 16, cryptid);
  return b;
}

function thin64(cmds) {
  const sizeofcmds = cmds.reduce((t, c) => t + c.length, 0);
  const b = new Uint8Array(HEADER_64 + sizeofcmds + FILE_BODY);
  u32(b, 0, 0xfeedfacf); u32(b, 4, 0x0100000c); u32(b, 8, 0); u32(b, 12, 2);
  u32(b, 16, cmds.length); u32(b, 20, sizeofcmds); u32(b, 24, 0); u32(b, 28, 0);
  let p = HEADER_64;
  for (const c of cmds) { b.set(c, p); p += c.length; }
  return b;
}

function thin32(cmds) {
  const sizeofcmds = cmds.reduce((t, c) => t + c.length, 0);
  const b = new Uint8Array(HEADER_32 + sizeofcmds + FILE_BODY);
  u32(b, 0, 0xfeedface); u32(b, 4, 7); u32(b, 8, 0); u32(b, 12, 2);
  u32(b, 16, cmds.length); u32(b, 20, sizeofcmds); u32(b, 24, 0);
  let p = HEADER_32;
  for (const c of cmds) { b.set(c, p); p += c.length; }
  return b;
}

test('Issue #9492: LC_ENCRYPTION_INFO (0x21) in 64-bit binary validates against 20 bytes, not 24', () => {
  // LC_ENCRYPTION_INFO (0x21) is 20 bytes even if encountered in a 64-bit binary
  const enc32in64 = encryptionCmd(0x21, 20, 0x4000, 0x1000, 1);
  const image = parseMachO(thin64([segment64(), enc32in64]));

  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x1000, cryptid: 1 });
  assert.equal(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO')), false);
});

test('Issue #9492: LC_ENCRYPTION_INFO_64 (0x2c) in 64-bit binary validates against 24 bytes', () => {
  const enc64 = encryptionCmd(0x2c, 24, 0x4000, 0x2000, 1);
  const image = parseMachO(thin64([segment64(), enc64]));

  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x4000, cryptsize: 0x2000, cryptid: 1 });
  assert.equal(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO')), false);
});

test('Issue #9492: LC_ENCRYPTION_INFO_64 (0x2c) with invalid size in 64-bit binary fails closed with warning', () => {
  const enc64Invalid = encryptionCmd(0x2c, 20, 0x4000, 0x2000, 1);
  const image = parseMachO(thin64([segment64(), enc64Invalid]));

  assert.equal(image.metadata.encryption, undefined);
  assert.ok(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO_64') && w.includes('invalid LC_ENCRYPTION_INFO_64 size 20')));
});

test('Issue #9492: LC_ENCRYPTION_INFO (0x21) with invalid size in 64-bit binary fails closed with warning', () => {
  const enc32Invalid = encryptionCmd(0x21, 24, 0x4000, 0x1000, 1);
  const image = parseMachO(thin64([segment64(), enc32Invalid]));

  assert.equal(image.metadata.encryption, undefined);
  assert.ok(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO') && w.includes('invalid LC_ENCRYPTION_INFO size 24')));
});

test('Issue #9492: LC_ENCRYPTION_INFO_64 (0x2c) in 32-bit binary validates against 24 bytes', () => {
  const enc64in32 = encryptionCmd(0x2c, 24, 0x2000, 0x1000, 2);
  const image = parseMachO(thin32([segment32(), enc64in32]));

  assert.deepEqual(image.metadata.encryption, { cryptoff: 0x2000, cryptsize: 0x1000, cryptid: 2 });
  assert.equal(image.warnings.some((w) => w.includes('LC_ENCRYPTION_INFO')), false);
});
