import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const INSTRUCTION = 0x100;
const DETAIL = 0x400;
const HIGH_ADDRESSES = [
  0x0000000000001000n,
  0x7fffffffffffffffn,
  0x8000000000000000n,
  0xffff800000001000n,
  0xffffffffffffffffn,
];

async function loadBridge(relativePath, exportName) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: relativePath });
  return context[exportName];
}

function makeModule({ architecture, address, operandKind = null }) {
  const values = new Map();
  const set = (pointer, type, value) => values.set(`${pointer}:${type}`, value);
  const size = architecture === 'x86_64' ? 1 : 4;
  const bytes = architecture === 'x86_64' ? [0x90] : [0x13, 0x00, 0x00, 0x00];

  set(INSTRUCTION + 8, 'i64', BigInt.asIntN(64, address));
  set(INSTRUCTION + 16, 'i16', size);
  bytes.forEach((byte, index) => set(INSTRUCTION + 18 + index, 'i8', byte));

  if (operandKind) {
    set(INSTRUCTION, 'i32', 1);
    set(INSTRUCTION + 236, 'i32', DETAIL);
    if (architecture === 'x86_64') {
      const x86 = DETAIL + 96;
      const operand = x86 + 72;
      set(x86 + 64, 'i8', 1);
      set(operand, 'i32', operandKind === 'immediate' ? 2 : 3);
      if (operandKind === 'immediate') set(operand + 8, 'i64', -1n);
      else set(operand + 24, 'i64', -2n);
      set(operand + 32, 'i8', 8);
      set(operand + 33, 'i8', 1);
    } else {
      const riscv = DETAIL + 96;
      const operand = riscv + 8;
      set(riscv + 1, 'i8', 1);
      set(operand, 'i32', operandKind === 'immediate' ? 2 : 3);
      if (operandKind === 'immediate') set(operand + 8, 'i64', -1n);
      else set(operand + 16, 'i64', -2n);
    }
  }

  return {
    getValue(pointer, type) { return values.get(`${pointer}:${type}`) ?? 0; },
    UTF8ToString() { return ''; },
    ccall(functionName) { return functionName === 'cs_insn_name' ? 'test' : ''; },
  };
}

const [x86, riscv64] = await Promise.all([
  loadBridge('../../js/targets/architecture/x86_64/capstone-structured.js', 'HexX86CapstoneStructured'),
  loadBridge('../../js/targets/architecture/riscv64/capstone-structured.js', 'HexRiscv64CapstoneStructured'),
]);

for (const address of HIGH_ADDRESSES) {
  const x86Decoded = x86.parseInstruction(makeModule({ architecture: 'x86_64', address }), 0, INSTRUCTION, { address });
  assert.equal(x86Decoded.address, address, `x86 address must remain unsigned: 0x${address.toString(16)}`);

  const riscvDecoded = riscv64.parseInstruction(makeModule({ architecture: 'riscv64', address }), 0, INSTRUCTION, { address });
  assert.equal(riscvDecoded.address, address, `riscv64 address must remain unsigned: 0x${address.toString(16)}`);
}

assert.throws(
  () => x86.parseInstruction(makeModule({ architecture: 'x86_64', address: 0x1000n }), 0, INSTRUCTION, { address: 0x1001n }),
  /x86-decoder-address-mismatch/,
);
assert.throws(
  () => riscv64.parseInstruction(makeModule({ architecture: 'riscv64', address: 0x1000n }), 0, INSTRUCTION, { address: 0x1001n }),
  /riscv64-decoder-address-mismatch/,
);

const x86Immediate = x86.parseInstruction(
  makeModule({ architecture: 'x86_64', address: 0x1000n, operandKind: 'immediate' }),
  0,
  INSTRUCTION,
  { address: 0x1000n },
);
assert.equal(x86Immediate.detail.operands[0].value, -1n, 'x86 immediates must stay signed');

const riscvImmediate = riscv64.parseInstruction(
  makeModule({ architecture: 'riscv64', address: 0x1000n, operandKind: 'immediate' }),
  0,
  INSTRUCTION,
  { address: 0x1000n },
);
assert.equal(riscvImmediate.capstoneOperands[0].value, -1n, 'riscv64 immediates must stay signed');

const x86Memory = x86.parseInstruction(
  makeModule({ architecture: 'x86_64', address: 0x1000n, operandKind: 'memory' }),
  0,
  INSTRUCTION,
  { address: 0x1000n },
);
assert.equal(x86Memory.detail.operands[0].memory.displacement, -2n, 'x86 memory displacements must stay signed');

const riscvMemory = riscv64.parseInstruction(
  makeModule({ architecture: 'riscv64', address: 0x1000n, operandKind: 'memory' }),
  0,
  INSTRUCTION,
  { address: 0x1000n },
);
assert.equal(riscvMemory.capstoneOperands[0].displacement, -2n, 'riscv64 memory displacements must stay signed');

console.log('issue #4087 Capstone uint64 address boundary: PASS');
