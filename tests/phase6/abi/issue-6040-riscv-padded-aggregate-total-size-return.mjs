// Regression for #6040: the LP64 return classifier applied the padding guard
// before the psABI total-size rule, so an aggregate whose physical size (with
// alignment padding) exceeded 2*XLEN was dropped to partial instead of taking
// the mandatory memory (indirect) return — and the argument side, which shares
// the return decision, never derived the hidden a0 result pointer. The
// total-size threshold now runs first, on physical bytes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RISCV_LP64_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// struct { long a, b; int c; } — logical 20 bytes, physical 24 bytes (padding).
const PADDED_RETURN = {
  returnType: 'struct S { long a, b; int c; }',
  aggregate: true,
  returnBits: 160,
  bits: 160,
  bytes: 24,
  members: [
    { bits: 64, bytes: 8, byteOffset: 0 },
    { bits: 64, bytes: 8, byteOffset: 8 },
    { bits: 32, bytes: 4, byteOffset: 16 },
  ],
  padding: [{ bits: 32, bytes: 4, byteOffset: 20 }],
  returnsValue: true,
};

for (const [label, abi] of [['riscv-lp64', RISCV_LP64_ABI], ['riscv-lp64d', RISCV_LP64D_ABI]]) {
  test(`${label}: a padded aggregate over 2*XLEN takes the indirect memory return`, () => {
    const ret = abi.classifyCallReturn({ callPrototype: { ...PADDED_RETURN, args: [] } });
    assert.equal(ret.partial, undefined, 'the padded guard must not downgrade a total-size indirect return');
    assert.equal(ret.indirect, true);
    assert.equal(ret.reg, null);
    assert.equal(ret.bytes, 8, 'the published return value is the storage pointer');
    assert.deepEqual(ret.hiddenResultPointer, { input: 'x10', location: 'register', pointerBits: 64 });
  });

  test(`${label}: the argument side derives the hidden a0 from the same decision`, () => {
    const args = abi.classifyArguments({ callPrototype: { ...PADDED_RETURN, args: [{ type: 'uint64_t', bits: 64 }] } });
    const hidden = args.arguments.find((entry) => entry?.role === 'indirect-result');
    assert.ok(hidden, 'hidden indirect-result entry must be published');
    assert.equal(hidden.reg, 'x10');
    const user = args.arguments.find((entry) => entry?.index === 0);
    assert.equal(user.reg, 'x11', 'the user argument shifts past the hidden pointer');
  });

  test(`${label}: a small padded aggregate stays partial instead of going indirect`, () => {
    // struct { long a; int b; } — logical 12 bytes, physical 16 bytes: padded
    // but within 2*XLEN, so the padded guard keeps failing it closed.
    const small = {
      returnType: 'struct P { long a; int b; }', aggregate: true,
      returnBits: 96, bits: 96, bytes: 16,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 32, bytes: 4, byteOffset: 8 },
      ],
      padding: [{ bits: 32, bytes: 4, byteOffset: 12 }],
      returnsValue: true,
    };
    const ret = abi.classifyCallReturn({ callPrototype: { ...small, args: [] } });
    assert.equal(ret.partial, true, 'padding within the direct-return range is still not directly representable');
    assert.equal(ret.indirect, undefined);
    assert.match(ret.reason ?? '', /padded|not-represented/);
  });
}
