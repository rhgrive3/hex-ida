import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';
import { resolveABIPlugin, AAPCS64_ABI, AAPCS64_ILP32_ABI } from '../../../js/targets/abi/index.js';
import { classifyAAPCS64Arguments as classifyCore } from '../../../js/targets/abi/aapcs64-core.js';
import { normalizeAbiPieces } from '../../../js/targets/abi/evidence.js';

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

  await t.test('consecutive ILP32 spilled copies keep every piece at its normalized stack offset', () => {
    const copy = { type:'struct Big', aggregate:true, bits:256,
      members:[0,8,16,24].map(byteOffset => ({ type:'uint64', bits:64, byteOffset })) };
    const insn = { callPrototype:{ args:[...Array.from({ length:8 }, () => ({ type:'uint64', bits:64 })), copy, copy, copy] } };
    for (const result of [classifyCore(insn, { dataModel:'ilp32', pointerBits:32 }), AAPCS64_ILP32_ABI.classifyArguments(insn)]) {
      const copies = result.arguments.slice(8);
      assert.equal(result.partial, false);
      assert.deepEqual(copies.map(entry => entry.offset), [0,8,16]);
      assert.deepEqual(copies.map(entry => entry.pieces[0].stackOffset), [0,8,16]);
      for (const entry of copies) {
        assert.equal(entry.bits, 32);
        assert.equal(entry.bytes, 4);
        assert.ok(normalizeAbiPieces(entry, entry.pieces));
        assert.equal(result.stackArguments.find(stack => stack.index === entry.index), entry);
      }
    }
  });

  await t.test('whole-aggregate spill normalization moves consecutive indirect-copy pieces too', () => {
    const pair = { type:'struct Pair', aggregate:true, bits:128,
      members:[0,8].map(byteOffset => ({ type:'uint64', bits:64, byteOffset })) };
    const copy = { type:'struct Big', aggregate:true, bits:256,
      members:[0,8,16,24].map(byteOffset => ({ type:'uint64', bits:64, byteOffset })) };
    const insn = { callPrototype:{ args:[...Array.from({ length:7 }, () => ({ type:'uint64', bits:64 })), pair, copy, copy, copy] } };
    const result = AAPCS64_ILP32_ABI.classifyArguments(insn);
    const copies = result.arguments.slice(8);
    assert.equal(result.arguments[7].location, 'stack');
    assert.deepEqual(copies.map(entry => entry.offset), [16,24,32]);
    assert.deepEqual(copies.map(entry => entry.pieces[0].stackOffset), [16,24,32]);
    assert.ok(copies.every(entry => normalizeAbiPieces(entry, entry.pieces)));
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

  await t.test('unsupported ILP32 variant PCS never resolves or classifies as standard AAPCS64', () => {
    const callingConvention = 'aarch64-ilp32-variant-pcs';
    assert.equal(AAPCS64_ILP32_ABI.callingConventions().includes(callingConvention), false);

    const resolved = resolveABIPlugin({
      architecture: 'arm64',
      platform: 'linux',
      bits: 32,
      callingConvention,
    });
    assert.equal(resolved.id, 'unknown');
    assert.equal(resolved.supported, false);

    const argsInsn = {
      callPrototype: {
        callingConvention,
        args: [{ type: 'uint64', bits: 64 }],
      },
    };
    for (const result of [classifyCore(argsInsn), AAPCS64_ILP32_ABI.classifyArguments(argsInsn)]) {
      assert.equal(result.unsupported, true);
      assert.equal(result.partial, true);
      assert.equal(result.stackArgsUnknown, true);
      assert.deepEqual(result.arguments, []);
    }

    const returnInsn = {
      callPrototype: { callingConvention, returnType: 'uint64', bits: 64 },
    };
    const callReturn = AAPCS64_ILP32_ABI.classifyCallReturn(returnInsn);
    assert.equal(callReturn.unsupported, true);
    assert.equal(callReturn.partial, true);
    assert.equal(callReturn.reg, null);

    const functionReturn = AAPCS64_ILP32_ABI.classifyFunctionReturn({
      functionPrototype: { callingConvention, returnType: 'uint64', bits: 64 },
    });
    assert.equal(functionReturn.unsupported, true);
    assert.equal(functionReturn.partial, true);
    assert.equal(functionReturn.reg, null);
  });
});
