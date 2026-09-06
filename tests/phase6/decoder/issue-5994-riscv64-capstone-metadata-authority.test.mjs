import assert from 'node:assert/strict';
import test from 'node:test';

import '../../../js/targets/architecture/riscv64/capstone-structured.js';

const { parseInstruction } = globalThis.HexRiscv64CapstoneStructured;

function capstoneMemory() {
  const bytes = [0x13, 0x00, 0x00, 0x00]; // addi x0, x0, 0
  return {
    getValue(pointer, type) {
      if (pointer === 0 && type === 'i32') return 1;
      if (pointer === 8 && type === 'i64') return 0x1000n;
      if (pointer === 16 && type === 'i16') return 4;
      if (pointer >= 18 && pointer < 22 && type === 'i8') return bytes[pointer - 18];
      if (pointer === 236 && type === 'i32') return 0;
      return 0;
    },
    UTF8ToString(pointer) {
      if (pointer === 42) return 'nop';
      if (pointer === 74) return '';
      return '';
    },
  };
}

function parse(options = {}) {
  return parseInstruction(capstoneMemory(), 0, 0, {
    address:0x1000n,
    ...options,
  });
}

test('RISC-V Capstone bridge preserves canonical primitive architecture metadata', () => {
  const row = parse({
    mode:'rv64im',
    isaIdentity:'rv64im',
    isaEvidence:'phase6-fixture',
    instructionAlignment:4,
  });
  assert.equal(row.mode, 'rv64im');
  assert.equal(row.isaIdentity, 'rv64im');
  assert.equal(row.isaEvidence, 'phase6-fixture');
  assert.equal(row.instructionAlignment, 4);
  assert.deepEqual([...row.rawBytes], [0x13, 0x00, 0x00, 0x00]);

  const defaults = parse();
  assert.equal(defaults.mode, 'rv64imc');
  assert.equal(Object.hasOwn(defaults, 'isaIdentity'), false);
  assert.equal(Object.hasOwn(defaults, 'isaEvidence'), false);
  assert.equal(Object.hasOwn(defaults, 'instructionAlignment'), false);
});

test('RISC-V Capstone bridge rejects structured mode and ISA identities without coercion', () => {
  assert.throws(() => parse({ mode:['rv64im'] }), /riscv64-decoder-invalid-mode/);
  assert.throws(() => parse({ mode:true }), /riscv64-decoder-invalid-mode/);
  assert.throws(() => parse({ isaIdentity:['rv64im'] }), /riscv64-decoder-invalid-isa-identity/);
  assert.throws(() => parse({ isaEvidence:['phase6-fixture'] }), /riscv64-decoder-invalid-isa-evidence/);

  let coercions = 0;
  const hostileMode = {
    [Symbol.toPrimitive]() { coercions += 1; return 'rv64im'; },
    toString() { coercions += 1; return 'rv64im'; },
  };
  assert.throws(() => parse({ mode:hostileMode }), /riscv64-decoder-invalid-mode/);
  assert.equal(coercions, 0, 'mode validation must not invoke caller coercion hooks');
});

test('RISC-V Capstone bridge rejects non-number instruction alignment without coercion', () => {
  for (const value of [[4], '4', true]) {
    assert.throws(
      () => parse({ instructionAlignment:value }),
      /riscv64-decoder-invalid-instruction-alignment/,
    );
  }

  let coercions = 0;
  const hostileAlignment = {
    valueOf() { coercions += 1; return 4; },
    [Symbol.toPrimitive]() { coercions += 1; return 4; },
  };
  assert.throws(
    () => parse({ instructionAlignment:hostileAlignment }),
    /riscv64-decoder-invalid-instruction-alignment/,
  );
  assert.equal(coercions, 0, 'alignment validation must not invoke caller coercion hooks');
});
