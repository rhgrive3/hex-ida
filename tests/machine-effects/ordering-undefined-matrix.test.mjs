import assert from 'node:assert/strict';
import test from 'node:test';

import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer-core.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import { createMemoryAccess } from '../../js/semantics/effects/index.js';
import { MEMORY_ORDERINGS } from '../../js/semantics/effects/index.js';
import { SEMANTIC_MEMORY_ORDERINGS } from '../../js/semantics/ir/common.js';

const reg = (n, bits = 64) => ({ k: 'reg', text: `x${n}`, cls: 'gp', bits, num: n });
const imm = (v) => ({ k: 'imm', text: `#${v}`, value: BigInt(v) });
const mem = (base, { disp = null } = {}) => ({
  k: 'mem', text: '[...]', base, index: null, shift: null, mode: 'offset',
  disp: disp == null ? null : imm(disp), addressDisp: disp == null ? null : imm(disp), writebackDisp: null,
});
const parseOps = (parts) => parts.map((p) => (p.startsWith('#') ? imm(Number(p.slice(1))) : reg(Number(p.replace('x', '')))));
const ctxFor = (id) => ({ instructionId: id, origin: { instructionIds: [id] } });

/**
 * ME-01 phase-1 frozen denominator: memory orderings, architecturally
 * undefined outputs, and undefined-bit masks. Each record states the
 * observable truth the lowering must preserve; the test scores production
 * against it per field.
 */
const ORDERING_RECORDS = Object.freeze([
  // ARM v8 A-profile: LDAR/STLR give acquire/release; LDXR/STXR are relaxed
  // monotonically; DMB variants carry the barrier domain+ordering scope.
  { id: 'ldar-acquire', mnemonic: 'ldar', ops: () => [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'acquire' },
  { id: 'stlr-release', mnemonic: 'stlr', ops: () => [reg(0), mem(reg(1))], access: 'memory-write', ordering: 'release' },
  { id: 'ldxr-relaxed', mnemonic: 'ldxr', ops: () => [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'relaxed' },
]);

test('ME-01 ordering denominator: every machine-effects ordering maps to the semantic V2 set', () => {
  for (const ordering of MEMORY_ORDERINGS) {
    assert.ok(
      SEMANTIC_MEMORY_ORDERINGS.includes(ordering),
      `machine-effects ordering ${ordering} has no Semantic V2 identity`,
    );
  }
  assert.ok(SEMANTIC_MEMORY_ORDERINGS.includes('unknown'), 'V2 must keep an explicit unknown ordering');
});

for (const record of ORDERING_RECORDS) {
  test(`ME-01 ordering matrix: ${record.id} lowers with ordering ${record.ordering} preserved`, () => {
    const effects = liftArm64MemoryEffects(
      { mnemonic: record.mnemonic, ops: record.ops() }, ctxFor(`me01-${record.id}`),
    );
    const readOrWrite = effects.operations.find((op) => op.kind === record.access);
    assert.ok(readOrWrite, `${record.mnemonic} must produce a ${record.access}`);
    const access = readOrWrite.access;
    assert.equal(access.atomic, true);
    assert.equal(access.ordering, record.ordering);
    // The ordering survives the effect→V2 boundary bit-exactly or not at all:
    // a dropped ordering must read as 'unknown', never as a stronger one.
    const lowered = access.ordering ?? 'unknown';
    assert.ok(
      lowered === record.ordering || lowered === 'unknown',
      'ordering must be preserved exactly or downgraded to unknown, never upgraded',
    );
  });
}

test('ME-01 ordering matrix: non-atomic access with an ordering is rejected at the contract', () => {
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: false, ordering: 'acquire' }),
    /machine-effects-ordering-requires-atomic-access/,
  );
});

test('ME-01 ordering matrix: an unknown ordering cannot masquerade as a known one', () => {
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: true, ordering: 'not-an-ordering' }),
    /machine-effects-invalid-memory-ordering/,
  );
});

test('ME-01 undefined matrix: variable shift models the modulo, never a guessed shift', () => {
  // A64 LSLV: the shift amount is the register value modulo the datasize.
  // ARM says shift amounts >= width give an architecturally defined result
  // only through that modulo — the lowering must apply the modulo explicitly.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-lslv',
    mnemonic: 'lslv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-lslv'] },
  });
  const shift = effects.operations.find((op) => op.kind === 'value' && op.opcode === 'shl');
  assert.ok(shift, 'lslv must lower to a shl value operation');
  const modulo = effects.operations.find(
    (op) => op.kind === 'value' && op.metadata?.reason === 'a64-variable-shift-modulo-register-width',
  );
  assert.ok(modulo, 'the shift amount must be masked by the modulo operation');
});

test('ME-01 undefined matrix: division-by-zero must be explicit, not silent', () => {
  // A64 SDIV/UDIV: division by zero returns zero, not an architectural
  // undefined — the lowering must name that behavior in metadata.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-sdiv',
    mnemonic: 'sdiv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-sdiv'] },
  });
  const div = effects.operations.find((op) => op.kind === 'value' && op.opcode === 'a64-sdiv');
  assert.ok(div, 'sdiv must lower to the explicit a64-sdiv opcode');
  assert.equal(div.metadata.divisionByZero, 'returns-zero');
  assert.equal(div.metadata.signedOverflow, 'wraps-min-div-minus-one');
});

test('ME-01 undefined matrix: an unmodelled operand stays partial, never concrete', () => {
  // A missing shift-amount register cannot read as a computed result.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-lslv-partial',
    mnemonic: 'lslv',
    ops: [reg(0), reg(1), { k: 'other', text: '??' }],
    origin: { instructionIds: ['me01-lslv-partial'] },
  });
  assert.equal(effects.completeness, 'partial');
  assert.ok(effects.unknownEffects);
  assert.notEqual(effects.unknownEffects.reason, undefined);
});
