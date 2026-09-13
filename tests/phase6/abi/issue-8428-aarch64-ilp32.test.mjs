import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';
import { resolveABIPlugin, AAPCS64_ABI, AAPCS64_ILP32_ABI } from '../../../js/targets/abi/index.js';

function createElf32AArch64() {
  const b = new Uint8Array(52);
  const v = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 3], 0); // ELFCLASS32, little-endian, EV_CURRENT, Linux
  v.setUint16(16, 3, true);   // ET_DYN
  v.setUint16(18, 183, true); // EM_AARCH64
  v.setUint32(20, 1, true);   // EV_CURRENT
  v.setUint16(40, 52, true);  // e_ehsize
  return b;
}

function createElf64AArch64() {
  const b = new Uint8Array(64);
  const v = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 3], 0); // ELFCLASS64, little-endian, EV_CURRENT, Linux
  v.setUint16(16, 3, true);   // ET_DYN
  v.setUint16(18, 183, true); // EM_AARCH64
  v.setUint32(20, 1, true);   // EV_CURRENT
  v.setUint16(52, 64, true);  // e_ehsize
  return b;
}

test('issue #8428: ELFCLASS32 AArch64 distinguishes ILP32 data model from LP64', async (t) => {
  await t.test('parseELF identifies ELFCLASS32 AArch64 data-model authority', () => {
    const elf32 = parseELF(createElf32AArch64());
    assert.equal(elf32.arch, 'arm64');
    assert.equal(elf32.bits, 32);
    assert.equal(elf32.metadata?.dataModel, 'ilp32');
    assert.equal(elf32.metadata?.pointerBits, 32);

    const elf64 = parseELF(createElf64AArch64());
    assert.equal(elf64.arch, 'arm64');
    assert.equal(elf64.bits, 64);
    assert.equal(elf64.metadata?.dataModel, 'lp64');
    assert.equal(elf64.metadata?.pointerBits, 64);
  });

  await t.test('AAPCS64 ILP32 classifies pointer argument as 32-bit with x0 carrier', () => {
    const abi = AAPCS64_ILP32_ABI;
    assert.ok(abi, 'AAPCS64_ILP32_ABI should be registered');
    assert.equal(abi.id, 'aapcs64-ilp32');

    const args = abi.classifyArguments({
      callPrototype: { args: [{ type: 'void *', pointer: true }] },
    });

    assert.equal(args.arguments.length, 1);
    const arg = args.arguments[0];
    assert.equal(arg.location, 'register');
    assert.equal(arg.reg, 'x0');
    assert.equal(arg.pointer, true);
    assert.equal(arg.bits, 32, 'logical pointer width should be 32 bits under ILP32');
    assert.equal(arg.bytes, 4);

    assert.equal(args.srcs.length, 1);
    assert.equal(args.srcs[0].reg, 'x0');
    assert.equal(args.srcs[0].bits, 64, 'physical register carrier remains 64 bits');
  });

  await t.test('AAPCS64 ILP32 classifies pointer return as 32-bit in x0', () => {
    const abi = AAPCS64_ILP32_ABI;
    const ret = abi.classifyFunctionReturn({
      functionPrototype: { returnType: 'void *', pointer: true },
    });

    assert.ok(ret);
    assert.equal(ret.reg, 'x0');
    assert.equal(ret.bits, 32, 'pointer return width should be 32 bits under ILP32');
  });

  await t.test('AAPCS64 ILP32 indirect aggregate return has pointerBits: 32', () => {
    const abi = AAPCS64_ILP32_ABI;
    const ret = abi.classifyFunctionReturn({
      functionPrototype: {
        returnType: 'struct Large',
        aggregate: true,
        bits: 256,
        layout: {
          bytes: 32,
          bits: 256,
          members: [
            { name: 'a', bits: 128, bytes: 16, byteOffset: 0 },
            { name: 'b', bits: 128, bytes: 16, byteOffset: 16 },
          ],
        },
      },
    });

    assert.ok(ret);
    assert.equal(ret.indirect, true);
    assert.equal(ret.hiddenResultPointer, 'x8');
    assert.equal(ret.pointerBits, 32, 'hidden result pointerBits should be 32 under ILP32');
  });

  await t.test('AAPCS64 ILP32 aggregate indirect-copy pointer uses 32-bit pointer width', () => {
    const abi = AAPCS64_ILP32_ABI;
    // An aggregate requiring indirect copy (>16 bytes)
    const args = abi.classifyArguments({
      callPrototype: {
        args: [{
          type: 'struct Big',
          aggregate: true,
          bits: 256,
          bytes: 32,
          layout: {
            bytes: 32,
            bits: 256,
            members: [
              { name: 'a', bits: 128, bytes: 16, byteOffset: 0 },
              { name: 'b', bits: 128, bytes: 16, byteOffset: 16 },
            ],
          },
        }],
      },
    });

    assert.equal(args.arguments.length, 1);
    const arg = args.arguments[0];
    assert.equal(arg.abiClass, 'aggregate-indirect-copy');
    assert.equal(arg.pointer, true);
    assert.equal(arg.bits, 32, 'indirect-copy pointer width should be 32 bits under ILP32');
    assert.equal(arg.bytes, 4);
  });

  await t.test('AAPCS64 LP64 (default) preserves 64-bit pointer semantics', () => {
    const abi = AAPCS64_ABI;
    const args = abi.classifyArguments({
      callPrototype: { args: [{ type: 'void *', pointer: true }] },
    });
    assert.equal(args.arguments[0].bits, 64);
    assert.equal(args.arguments[0].bytes, 8);

    const ret = abi.classifyFunctionReturn({
      functionPrototype: { returnType: 'void *', pointer: true },
    });
    assert.equal(ret.bits, 64);
  });

  await t.test('resolveABIPlugin selects ILP32 when bits: 32 or abiId: "aapcs64-ilp32"', () => {
    const resolvedByBits = resolveABIPlugin({
      architecture: 'arm64',
      platform: 'linux',
      bits: 32,
    });
    assert.equal(resolvedByBits.id, 'aapcs64-ilp32');

    const resolvedById = resolveABIPlugin({
      architecture: 'arm64',
      platform: 'linux',
      abiId: 'aapcs64-ilp32',
    });
    assert.equal(resolvedById.id, 'aapcs64-ilp32');
  });
});
