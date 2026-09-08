import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

// Issue #5545: seedValidatedEntrypoint() had no RISC-V branch, so a PE with
// Machine = RISC-V (0x5032/0x5064) accepted an odd AddressOfEntryPoint
// (alignment fell through to 1 byte). An odd address can never start a
// RISC-V instruction (IALIGN=32 base, 16 with compressed extensions).

function makePE({ machine, entryRva, bits = 64 }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4;
  const optionalSize = bits === 64 ? 0xf0 : 0xe0;
  const opt = coff + 20, section = opt + optionalSize;
  const imageBase = bits === 64 ? 0x140000000n : 0x10000000n;
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);
  view.setUint16(opt, bits === 64 ? 0x20b : 0x10b, true);
  view.setUint32(opt + 16, entryRva, true);
  if (bits === 64) view.setBigUint64(opt + 24, imageBase, true);
  else view.setUint32(opt + 28, Number(imageBase), true);
  view.setUint32(opt + 32, 0x1000, true);
  view.setUint32(opt + 36, 0x200, true);
  view.setUint32(opt + 56, 0x2000, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + (bits === 64 ? 108 : 92), 0, true);
  bytes.set(new TextEncoder().encode('.text'), section);
  view.setUint32(section + 8, 0x200, true);
  view.setUint32(section + 12, 0x1000, true);
  view.setUint32(section + 16, 0x200, true);
  view.setUint32(section + 20, 0x200, true);
  view.setUint32(section + 36, 0x60000020, true);
  // A minimal valid RISC-V instruction (c.nop / nop padding) at RVA 0x1000.
  bytes[0x200] = 0x01; bytes[0x201] = 0x00; bytes[0x202] = 0x13; bytes[0x203] = 0x00;
  return bytes;
}

function entrypointState(image) {
  return {
    valid: image.metadata.entrypointValid,
    diagnostic: image.metadata.entrypointDiagnostic,
    seeds: image.functions.filter((f) => f.source === 'entrypoint'),
  };
}

// Odd entrypoints are rejected on both RISC-V machines.
for (const machine of [0x5032, 0x5064]) {
  const image = parsePE(makePE({ machine, entryRva: 0x1001 }));
  const state = entrypointState(image);
  assert.equal(state.valid, false, `riscv machine 0x${machine.toString(16)} rejects odd entrypoint`);
  assert.match(state.diagnostic, /aligned/, 'the diagnostic names the alignment contract');
  assert.equal(state.seeds.length, 0, 'no entrypoint seed at an odd address');
}

// 2- and 4-byte aligned entrypoints stay valid on both RISC-V machines.
for (const machine of [0x5032, 0x5064]) {
  for (const rva of [0x1002, 0x1004]) {
    const image = parsePE(makePE({ machine, entryRva: rva }));
    const state = entrypointState(image);
    assert.equal(state.valid, true, `0x${machine.toString(16)} entrypoint 0x${rva.toString(16)} stays valid`);
    assert.equal(state.diagnostic, null);
    assert.equal(state.seeds.length, 1);
    assert.equal(state.seeds[0].address, 0x140000000n + BigInt(rva));
  }
}

// Non-RISC-V machines keep their existing contracts.
{
  const arm64 = parsePE(makePE({ machine: 0xaa64, entryRva: 0x1002, bits: 64 }));
  assert.equal(entrypointState(arm64).valid, false, 'arm64 still requires 4-byte alignment');
  const armnt = parsePE(makePE({ machine: 0x01c4, entryRva: 0x1002 }));
  assert.equal(entrypointState(armnt).valid, true, 'ARMNT keeps its 2-byte contract');
}

// Compressed-capable RISC-V profiles permit 2-byte instruction alignment;
// odd addresses remain invalid, while 0x1002 is a valid boundary.
for (const machine of [0x5032, 0x5064]) {
  const image = parsePE(makePE({ machine, entryRva: 0x1002 }));
  const state = entrypointState(image);
  assert.equal(state.valid, true, `riscv machine 0x${machine.toString(16)} accepts a 2-byte-aligned entrypoint`);
  assert.equal(state.diagnostic, null);
  assert.equal(state.seeds.length, 1);
}

console.log('issue #5545 RISC-V entrypoint alignment regression: PASS');
