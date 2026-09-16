import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/effects.js';
import { liftArm64eAuthenticatedLoadEffects } from '../../js/targets/architecture/arm64e/effects-memory.js';
import { liftArm64ePacmEffects } from '../../js/targets/architecture/arm64e/effects-pacm.js';
import { arm64ePointerAuthenticationOperandShapeFailureBundle } from '../../js/targets/architecture/arm64e/encoding.js';

const ID = 'insn-A';

function decoded(mnemonic, opStr = '', overrides = {}) {
  return {
    instructionId: ID,
    mnemonic,
    mode: 'arm64e',
    address: 0x1000n,
    opStr,
    ops: parseOperands(opStr),
    origin: { instructionIds: [ID] },
    ...overrides,
  };
}

function assertRejects(label, run, expectedCode) {
  let thrown = null;
  try { run(); } catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: structured identity must fail closed, not launder through String()`);
  if (expectedCode) assert.equal(thrown.message, expectedCode, `${label}: expected ${expectedCode}`);
}

// Each owner of the ARM64e extension, including the composed architecture
// plugin, must apply one identity contract. A representative per owner keeps
// the matrix honest about which helper actually issued the bundle.
const OWNERS = Object.freeze([
  Object.freeze({ id: 'pauth-sign', lift: liftArm64eEffects, instruction: () => decoded('pacia', 'x2, x3'), completeness: 'exact-with-intrinsic' }),
  Object.freeze({ id: 'pauth-generic-code', lift: liftArm64eEffects, instruction: () => decoded('pacga', 'x0, x1, x2'), completeness: 'exact-with-intrinsic' }),
  Object.freeze({ id: 'pauth-authenticated-branch', lift: liftArm64eEffects, instruction: () => decoded('braa', 'x0, x1'), completeness: 'exact-with-intrinsic' }),
  Object.freeze({ id: 'pauth-authenticated-return', lift: liftArm64eEffects, instruction: () => decoded('retaa', ''), completeness: 'exact-with-intrinsic' }),
  Object.freeze({ id: 'authenticated-load', lift: liftArm64eAuthenticatedLoadEffects, instruction: () => decoded('ldraa', 'x0, [x1]'), completeness: 'exact-with-intrinsic' }),
  Object.freeze({ id: 'pacm', lift: liftArm64ePacmEffects, instruction: () => decoded('pacm', ''), completeness: 'partial' }),
  Object.freeze({ id: 'encoding-failure', lift: arm64ePointerAuthenticationOperandShapeFailureBundle, instruction: () => decoded('pacia', 'x0, x1, x2'), completeness: 'partial' }),
  Object.freeze({ id: 'extension-plugin', lift: (record, context) => ARM64E_ARCHITECTURE.liftExact(record, context), instruction: () => decoded('pacia', 'x2, x3'), completeness: 'exact-with-intrinsic' }),
]);

// 1/6. Primitive canonical identity keeps every existing exact claim.
for (const owner of OWNERS) {
  const bundle = owner.lift(owner.instruction(), { instructionId: ID, mode: 'arm64e' });
  assert.ok(bundle, `${owner.id}: a primitive identity must still lift`);
  assert.equal(bundle.completeness, owner.completeness, `${owner.id}: completeness must not regress`);
  assert.equal(bundle.instructionId, ID, `${owner.id}: instructionId`);
  assert.equal(bundle.mode, 'arm64e', `${owner.id}: mode`);
  assert.equal(bundle.architectureId, 'arm64e', `${owner.id}: architectureId`);
}

// 2-5. The #5992 malformed-identity matrix, now shared with the extension.
const MALFORMED_INSTRUCTION_IDS = Object.freeze([
  Object.freeze({ label: 'array', value: [ID] }),
  Object.freeze({ label: 'object', value: { id: ID } }),
  Object.freeze({ label: 'boxed-string', value: new String(ID) }),
  Object.freeze({ label: 'number', value: 7 }),
  Object.freeze({ label: 'boolean', value: true }),
  Object.freeze({ label: 'whitespace', value: '   ' }),
  Object.freeze({ label: 'empty', value: '' }),
]);
const MALFORMED_MODES = Object.freeze([
  Object.freeze({ label: 'array', value: ['arm64e'] }),
  Object.freeze({ label: 'object', value: { mode: 'arm64e' } }),
  Object.freeze({ label: 'number', value: 7 }),
  Object.freeze({ label: 'boolean', value: false }),
  Object.freeze({ label: 'whitespace', value: ' \t ' }),
]);

for (const owner of OWNERS) {
  for (const field of MALFORMED_INSTRUCTION_IDS) {
    assertRejects(`${owner.id}: instructionId ${field.label}`,
      () => owner.lift(owner.instruction(), { instructionId: field.value }),
      'arm64e-instruction-id-required');
  }
  for (const field of MALFORMED_MODES) {
    assertRejects(`${owner.id}: mode ${field.label}`,
      () => owner.lift(owner.instruction(), { instructionId: ID, mode: field.value }),
      'arm64e-mode-invalid');
  }
  // A malformed identity inside the decoded record is rejected as well: the
  // context is not the only entry point the extension must guard.
  assertRejects(`${owner.id}: decoded array instructionId`,
    () => owner.lift({ ...owner.instruction(), instructionId: [ID] }, { mode: 'arm64e' }),
    'arm64e-instruction-id-required');
}

// 4. Validation must never execute caller-controlled conversion hooks.
let hookCalls = 0;
const hook = (field) => ({ toString: () => { hookCalls += 1; return field; } });
for (const owner of OWNERS) {
  assertRejects(`${owner.id}: custom-toString instructionId`,
    () => owner.lift(owner.instruction(), { instructionId: hook(ID), mode: 'arm64e' }),
    'arm64e-instruction-id-required');
  assertRejects(`${owner.id}: custom-toString mode`,
    () => owner.lift(owner.instruction(), { instructionId: ID, mode: hook('arm64e') }),
    'arm64e-mode-invalid');
}
assert.equal(hookCalls, 0, 'identity validation must not invoke a caller-controlled toString() hook');

// 7. The authenticated-load owner also publishes endianness into its memory access.
const MALFORMED_ENDIANNESS = Object.freeze([
  Object.freeze({ label: 'array', value: ['little'] }),
  Object.freeze({ label: 'object', value: { endian: 'little' } }),
  Object.freeze({ label: 'boxed-string', value: new String('little') }),
  Object.freeze({ label: 'number', value: 0 }),
]);
for (const field of MALFORMED_ENDIANNESS) {
  assertRejects(`authenticated-load dataEndianness ${field.label}`,
    () => liftArm64eAuthenticatedLoadEffects(decoded('ldraa', 'x0, [x1]'), { instructionId: ID, dataEndianness: field.value }),
    'arm64e-data-endianness-invalid');
}
{
  const bundle = liftArm64eAuthenticatedLoadEffects(decoded('ldraa', 'x0, [x1]'), { instructionId: ID });
  const access = bundle.operations.find((operation) => operation.kind === 'memory-read').access;
  assert.equal(access.endian, 'little', 'an absent endianness keeps the canonical A64 default');
}

// 9. Origin lists keep the same primitive contract on the extension path.
assertRejects('extension nested origin instructionIds',
  () => ARM64E_ARCHITECTURE.liftExact({ ...decoded('pacia', 'x2, x3'), origin: { instructionIds: [[ID]] } }, { instructionId: ID, mode: 'arm64e' }));
assertRejects('extension object origin',
  () => ARM64E_ARCHITECTURE.liftExact(decoded('pacia', 'x2, x3'), { instructionId: ID, origin: 'origin-A' }));

// Parity with the base ARM64 owner (#5992): the same matrix must fail closed
// there too, so the two owners cannot drift apart again silently. The base
// owner takes identity from the decoded record, so the matrix is applied there.
for (const field of MALFORMED_INSTRUCTION_IDS) {
  assertRejects(`base arm64 instructionId ${field.label}`,
    () => ARM64_ARCHITECTURE.liftExact({ ...decoded('add', 'x0, x1, x2', { mode: 'a64' }), instructionId: field.value }),
    'arm64-effects-instruction-id-required');
}
assert.equal(
  ARM64_ARCHITECTURE.liftExact(decoded('add', 'x0, x1, x2', { mode: 'a64' }), { instructionId: ID, mode: 'a64' }).completeness,
  'exact',
  'base ARM64 canonical identity must stay exact',
);

console.log('Issue #8815 ARM64e PAuth strict identity boundary: PASS');
