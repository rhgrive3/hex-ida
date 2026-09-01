import { MEMORY_ORDERINGS } from '../../../js/semantics/effects/index.js';


export const ORDERING_UNDEFINED_MATRIX_SCHEMA = 'machine-effects-ordering-undefined-matrix/v1';

export const ME01_ORDERING_MATRIX_VERSION = '1.0.0';

/**
 * ME-01 T002 inventory (per arm64 denominator), recorded 2026-09-01.
 *
 * Architectural undefined/implementation-defined outputs the production
 * lowering already MODELS explicitly:
 * - a64 variable shift amount modulo (LSLV/LSRV/ASRV/RORV mask the register
 *   shift amount by the datasize via `a64-variable-shift-modulo-register-width`)
 * - A64 SDIV/UDIV division-by-zero is architecturally defined (returns zero)
 *   and named as `divisionByZero: 'returns-zero'`
 * - A64 SDIV signed overflow is architecturally defined
 *   (`signedOverflow: 'wraps-min-div-minus-one'`)
 * - acquire/release/relaxed memory orderings on LDAR/STLR/LDXR-class accesses
 *   survive the effect-to-V2 boundary bit-exactly or downgrade to `unknown`
 *
 * Outputs the lowering deliberately DOES NOT model (stay conservative):
 * - a non-atomic access may not carry an ordering
 *   (`machine-effects-ordering-requires-atomic-access`)
 * - an unknown ordering cannot masquerade as a known one
 *   (`machine-effects-invalid-memory-ordering`)
 * - the effect-to-V2 boundary defaults any absent ordering to the explicit
 *   `unknown` value instead of inventing a stronger one
 *   (`js/semantics/ir/from-machine-effects.js`)
 * - an unmodelled operand (e.g. a missing shift-amount register) keeps the
 *   whole effect bundle `partial` with an explicit unknown-effect reason;
 *   it never reads as a computed concrete result
 */
export const ME01_UNDEFINED_INVENTORY = Object.freeze({
  schemaVersion: ORDERING_UNDEFINED_MATRIX_SCHEMA,
  matrixVersion: ME01_ORDERING_MATRIX_VERSION,
  profileScope: 'arm64:a64 (+ shared effect-to-V2 boundary)',
  modeled: Object.freeze([
    Object.freeze({ id: 'a64-variable-shift-modulo', where: 'js/targets/architecture/arm64/effects/integer-core.js', classification: 'defined' }),
    Object.freeze({ id: 'a64-division-by-zero-returns-zero', where: 'js/targets/architecture/arm64/effects/integer-core.js', classification: 'defined' }),
    Object.freeze({ id: 'a64-signed-division-overflow-wraps', where: 'js/targets/architecture/arm64/effects/integer-core.js', classification: 'defined' }),
    Object.freeze({ id: 'memory-orderings-acquire-release-relaxed', where: 'js/targets/architecture/arm64/effects/memory.js', classification: 'defined' }),
  ]),
  notModeled: Object.freeze([
    Object.freeze({ id: 'non-atomic-ordering', reason: 'machine-effects-ordering-requires-atomic-access', classification: 'rejected-at-contract' }),
    Object.freeze({ id: 'unknown-ordering-upgrade', reason: 'machine-effects-invalid-memory-ordering', classification: 'rejected-at-contract' }),
    Object.freeze({ id: 'absent-ordering', reason: "effect-to-V2 boundary defaults to 'unknown'", classification: 'conservative-unknown' }),
    Object.freeze({ id: 'unmodelled-operand', reason: 'effect bundle stays partial with explicit unknown-effect reason', classification: 'conservative-partial' }),
  ]),
});

const reg = (n, bits = 64) => ({ k: 'reg', text: `x${n}`, cls: 'gp', bits, num: n });
const imm = (v) => ({ k: 'imm', text: `#${v}`, value: BigInt(v) });
const mem = (base, { disp = null } = {}) => ({
  k: 'mem', text: '[...]', base, index: null, shift: null, mode: 'offset',
  disp: disp == null ? null : imm(disp), addressDisp: disp == null ? null : imm(disp), writebackDisp: null,
});

/**
 * ME-01 phase-1 frozen denominator: memory orderings, architecturally
 * undefined outputs, and undefined-bit masks. Each record states the
 * observable truth the lowering must preserve and the re-orderings the
 * oracle source forbids; the test scores production against it per field.
 */
export const ME01_ORDERING_RECORDS = Object.freeze([
  // ARM v8 A-profile: LDAR/STLR give acquire/release; LDXR/STXR are relaxed
  // monotonically; DMB variants carry the barrier domain+ordering scope.
  Object.freeze({
    id: 'ldar-acquire', mnemonic: 'ldar', access: 'memory-read', ordering: 'acquire',
    mustPreserve: Object.freeze({ atomic: true, ordering: 'acquire' }),
    mustForbid: Object.freeze(['downgrade-to-stronger', 'ordering-on-non-atomic']),
    expectedClassification: 'defined',
    ops: () => [reg(0), mem(reg(1))],
  }),
  Object.freeze({
    id: 'stlr-release', mnemonic: 'stlr', access: 'memory-write', ordering: 'release',
    mustPreserve: Object.freeze({ atomic: true, ordering: 'release' }),
    mustForbid: Object.freeze(['downgrade-to-stronger', 'ordering-on-non-atomic']),
    expectedClassification: 'defined',
    ops: () => [reg(0), mem(reg(1))],
  }),
  Object.freeze({
    id: 'ldxr-relaxed', mnemonic: 'ldxr', access: 'memory-read', ordering: 'relaxed',
    mustPreserve: Object.freeze({ atomic: true, ordering: 'relaxed' }),
    mustForbid: Object.freeze(['downgrade-to-stronger', 'ordering-on-non-atomic']),
    expectedClassification: 'defined',
    ops: () => [reg(0), mem(reg(1))],
  }),
]);

export const ME01_UNDEFINED_OUTPUT_RECORDS = Object.freeze([
  Object.freeze({
    id: 'lslv-shift-modulo', mnemonic: 'lslv', kind: 'undefined-output',
    mustPreserve: Object.freeze({ opcode: 'shl', moduloMetadata: 'a64-variable-shift-modulo-register-width' }),
    mustForbid: Object.freeze(['guessed-shift-amount', 'concrete-result-from-unmodelled-operand']),
    expectedClassification: 'defined-modulo',
    ops: () => [reg(0), reg(1), reg(2)],
  }),
  Object.freeze({
    id: 'sdiv-division-by-zero', mnemonic: 'sdiv', kind: 'undefined-output',
    mustPreserve: Object.freeze({ opcode: 'a64-sdiv', divisionByZero: 'returns-zero', signedOverflow: 'wraps-min-div-minus-one' }),
    mustForbid: Object.freeze(['silent-undefined', 'trap-misclassification']),
    expectedClassification: 'defined',
    ops: () => [reg(0), reg(1), reg(2)],
  }),
  Object.freeze({
    id: 'lslv-unmodelled-operand', mnemonic: 'lslv', kind: 'undefined-output',
    mustPreserve: Object.freeze({ completeness: 'partial', explicitUnknownEffect: true }),
    mustForbid: Object.freeze(['concrete-result-from-unmodelled-operand']),
    expectedClassification: 'conservative-partial',
    ops: () => [reg(0), reg(1), Object.freeze({ k: 'other', text: '??' })],
  }),
]);

export const ME01_CONTRACT_RECORDS = Object.freeze([
  Object.freeze({
    id: 'ordering-requires-atomic',
    access: Object.freeze({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: false, ordering: 'acquire' }),
    mustForbid: Object.freeze(['ordering-on-non-atomic']),
    expectedClassification: 'rejected-at-contract',
  }),
  Object.freeze({
    id: 'unknown-ordering-cannot-masquerade',
    access: Object.freeze({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: true, ordering: 'not-an-ordering' }),
    mustForbid: Object.freeze(['unknown-upgrade']),
    expectedClassification: 'rejected-at-contract',
  }),
]);

export function validateOrderingUndefinedMatrix(value) {
  if (value == null || typeof value !== 'object') throw new TypeError('me01-matrix-invalid');
  if (value.schemaVersion !== ORDERING_UNDEFINED_MATRIX_SCHEMA) throw new TypeError('me01-matrix-schema');
  if (value.matrixVersion !== ME01_ORDERING_MATRIX_VERSION) throw new TypeError('me01-matrix-version');
  for (const record of value.records ?? []) {
    if (!record?.id || typeof record.expectedClassification !== 'string') throw new TypeError('me01-matrix-record-invalid');
    if (record.ordering != null && !MEMORY_ORDERINGS.includes(record.ordering)) throw new TypeError('me01-matrix-ordering-invalid');
  }
  return true;
}

export const ME01_ORDERING_UNDEFINED_MATRIX = Object.freeze({
  schemaVersion: ORDERING_UNDEFINED_MATRIX_SCHEMA,
  matrixVersion: ME01_ORDERING_MATRIX_VERSION,
  inventory: ME01_UNDEFINED_INVENTORY,
  records: Object.freeze([
    ...ME01_ORDERING_RECORDS,
    ...ME01_UNDEFINED_OUTPUT_RECORDS,
    ...ME01_CONTRACT_RECORDS,
  ]),
});
