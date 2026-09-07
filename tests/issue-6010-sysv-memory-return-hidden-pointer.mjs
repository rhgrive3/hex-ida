// Regression for #6010: the SysV AMD64 return classifier discarded a proven
// MEMORY eightbyte class as "classification not proven", so the hidden
// structure-return pointer (RDI in, RAX out) was never derived and every user
// argument landed one register too far left. The proven MEMORY decision now
// produces the exact indirect result and the argument allocator shares that
// decision; a genuinely unproven aggregate return fails the user arguments
// closed to unknown instead of leaving false-exact slots.
import assert from 'node:assert/strict';
import { classifySysVAMD64Arguments, classifySysVAMD64CallReturn } from '../js/targets/abi/sysv-amd64.js';

const MEMORY_RETURN = {
  returnType: 'struct S',
  aggregate: true,
  returnBits: 192,
  returnAggregate: {
    bits: 192,
    bytes: 24,
    members: [
      { bits: 64, bytes: 8, byteOffset: 0 },
      { bits: 64, bytes: 8, byteOffset: 8 },
      { bits: 64, bytes: 8, byteOffset: 16 },
    ],
  },
  returnEightbyteClasses: ['MEMORY'],
  args: [{ type: 'long', bits: 64 }],
};

{
  const ret = classifySysVAMD64CallReturn({ callPrototype: MEMORY_RETURN });
  assert.equal(ret.partial, undefined, 'a proven MEMORY return is exact, not partial');
  assert.equal(ret.indirect, true, 'MEMORY return must become the caller-provided storage result');
  assert.equal(ret.reg, 'rax', 'the callee returns the storage pointer in RAX');
  assert.deepEqual(ret.hiddenResultPointer, { input: 'rdi', returned: 'rax' });
  assert.equal(ret.bytes, 24);
}

{
  const args = classifySysVAMD64Arguments({ callPrototype: MEMORY_RETURN });
  const hidden = args.arguments.find((entry) => entry?.role === 'indirect-result');
  assert.ok(hidden, 'the hidden sret pointer must be derived from the shared return decision');
  assert.equal(hidden.reg, 'rdi');
  assert.equal(args.arguments[1].reg, 'rsi', 'the first user argument shifts to RSI');
}

{
  const six = { ...MEMORY_RETURN, args: Array.from({ length: 6 }, () => ({ type: 'long', bits: 64 })) };
  const args = classifySysVAMD64Arguments({ callPrototype: six });
  const regs = args.arguments.map((entry) => `${entry.index}:${entry.reg ?? entry.location}${entry.hidden ? '(hidden)' : ''}`);
  assert.deepEqual(regs, ['-1:rdi(hidden)', '0:rsi', '1:rdx', '2:rcx', '3:r8', '4:r9', '5:stack'],
    'hidden RDI consumes a GP slot and the register frontier shifts, pushing the 6th user argument to the stack');
}

{
  // Explicit provider metadata keeps working unchanged.
  const explicit = {
    returnType: 'struct T', aggregate: true, indirectResult: true, returnBits: 192,
    args: [{ type: 'long', bits: 64 }],
  };
  const args = classifySysVAMD64Arguments({ callPrototype: explicit });
  assert.equal(args.arguments.find((entry) => entry?.role === 'indirect-result')?.reg, 'rdi');
  assert.equal(args.arguments[1].reg, 'rsi');
  const ret = classifySysVAMD64CallReturn({ callPrototype: explicit });
  assert.equal(ret.indirect, true);
  assert.equal(ret.reg, 'rax');
}

{
  // Small direct INTEGER/SSE aggregate returns must not grow a hidden sret.
  const small = {
    returnType: 'struct P', aggregate: true, returnBits: 128,
    returnAggregate: {
      bits: 128, bytes: 16,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 64, bytes: 8, byteOffset: 8 },
      ],
    },
    returnEightbyteClasses: ['INTEGER', 'INTEGER'],
    args: [{ type: 'long', bits: 64 }],
  };
  const ret = classifySysVAMD64CallReturn({ callPrototype: small });
  assert.equal(ret.indirect, undefined);
  assert.equal(ret.reg, 'rax');
  const args = classifySysVAMD64Arguments({ callPrototype: small });
  assert.equal(args.arguments.find((entry) => entry?.role === 'indirect-result'), undefined);
  assert.equal(args.arguments[0].reg, 'rdi', 'no hidden pointer: the first user argument stays in RDI');
}

{
  // A MEMORY return without a provable storage extent, and an unproven
  // aggregate return, fail closed on both sides.
  const noSize = { ...MEMORY_RETURN, returnAggregate: undefined };
  const ret = classifySysVAMD64CallReturn({ callPrototype: noSize });
  assert.equal(ret.partial, true);
  assert.equal(ret.reason, 'sysv-amd64-aggregate-return-memory-storage-size-unproven');
  const args = classifySysVAMD64Arguments({ callPrototype: noSize });
  assert.equal(args.partial, true, 'user arguments must not stay false-exact when the return is unproven');
  assert.ok(args.arguments.every((entry) => entry?.location === 'unknown'), 'every user argument degrades to unknown');
}
