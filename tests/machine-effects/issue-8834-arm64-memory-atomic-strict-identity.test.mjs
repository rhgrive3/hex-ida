import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';
import { canonicalIdentityString } from '../../js/targets/architecture/arm64/effects/common.js';

const ID = 'id-A';
const loadRecord = () => ({ mnemonic:'ldar', opStr:'w0, [x1]', ops:parseOperands('w0, [x1]'), mode:'a64' });
const exclusiveRecord = () => ({ mnemonic:'ldxr', opStr:'x0, [x1]', ops:parseOperands('x0, [x1]'), mode:'a64' });
const integerRecord = () => ({ mnemonic:'add', opStr:'x0, x1, x2', ops:parseOperands('x0, x1, x2'), mode:'a64' });

function assertRejects(label, run, expectedCode) {
  let thrown = null;
  try { run(); } catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: structured identity must fail closed, not launder through String()`);
  if (expectedCode) assert.equal(thrown.message, expectedCode, `${label}: expected ${expectedCode}`);
}

// The memory and atomic owners used to resolve their own `instructionId` /
// `mode` / architecture / endianness with a coercive local `contextOf()`, so a
// value that only survives `String()` reached an `exact` (LDAR) or
// `exact-with-intrinsic` (LDXR) bundle while the common owner already rejected
// it (#5992, #8834). One malformed-identity matrix now covers all of them.
const MEMORY = Object.freeze({ id:'memory', lift:(record, context) => liftArm64MemoryEffects(record, context), record:loadRecord, completeness:'exact' });
const ATOMIC = Object.freeze({ id:'atomic', lift:(record, context) => liftArm64AtomicEffects(record, context), record:exclusiveRecord, completeness:'exact-with-intrinsic' });
const DISPATCHED_MEMORY = Object.freeze({ id:'dispatched-memory', lift:(record, context) => liftArm64MachineEffects(record, context), record:loadRecord, completeness:'exact' });
const DISPATCHED_ATOMIC = Object.freeze({ id:'dispatched-atomic', lift:(record, context) => liftArm64MachineEffects(record, context), record:exclusiveRecord, completeness:'exact-with-intrinsic' });
const DISPATCHED_INTEGER = Object.freeze({ id:'dispatched-integer', lift:(record, context) => liftArm64MachineEffects(record, context), record:integerRecord, completeness:'exact' });

// Owners that consume caller-supplied context identity evidence must validate
// every identity field there; the common owner resolves identity from the
// decoded record only, so its contract is asserted on that path instead.
const CONTEXT_EVIDENCE_OWNERS = Object.freeze([MEMORY, ATOMIC, DISPATCHED_MEMORY, DISPATCHED_ATOMIC]);
const CONTEXT_FIELDS = Object.freeze({
  instructionId:'arm64-machine-effects-instruction-id-required',
  mode:'arm64-machine-effects-mode-invalid',
  architectureId:'arm64-machine-effects-architecture-id-invalid',
  dataEndianness:'arm64-machine-effects-data-endianness-invalid',
});
// Every owner must fail closed on a malformed decoded record, each with its own
// canonical error code so a regression cannot be hidden by a generic message.
const DECODED_IDENTITY_OWNERS = Object.freeze([
  ...CONTEXT_EVIDENCE_OWNERS.map((owner) => Object.freeze({ owner, fields:CONTEXT_FIELDS })),
  Object.freeze({ owner:DISPATCHED_INTEGER, fields:Object.freeze({
    instructionId:'arm64-effects-instruction-id-required',
    mode:'arm64-effects-mode-invalid',
  }) }),
]);
const MALFORMED_VALUES = Object.freeze([
  Object.freeze({ label:'array', value:[ID] }),
  Object.freeze({ label:'object', value:{ id:ID } }),
  Object.freeze({ label:'boxed-string', value:new String(ID) }),
  Object.freeze({ label:'number', value:7 }),
  Object.freeze({ label:'boolean', value:true }),
  Object.freeze({ label:'whitespace', value:'   ' }),
]);

// 1-2, 10. Canonical primitive identity keeps the exact claims, the acquire
// ordering, and the exclusive-monitor state.
for (const owner of [...CONTEXT_EVIDENCE_OWNERS, DISPATCHED_INTEGER]) {
  const bundle = owner.lift({ ...owner.record(), instructionId:ID }, { instructionId:ID, mode:'a64', architectureId:'arm64', dataEndianness:'little' });
  assert.equal(bundle.completeness, owner.completeness, `${owner.id}: canonical identity completeness must not regress`);
  assert.equal(bundle.instructionId, ID, `${owner.id}: instructionId`);
  assert.equal(bundle.mode, 'a64', `${owner.id}: mode`);
  assert.equal(bundle.architectureId, 'arm64', `${owner.id}: architectureId`);
}
{
  const ldar = liftArm64MemoryEffects({ ...loadRecord(), instructionId:ID }, { instructionId:ID });
  const access = ldar.operations.find((operation) => operation.kind === 'memory-read').access;
  assert.equal(access.ordering, 'acquire', 'LDAR acquire ordering must survive the identity tightening');
  assert.equal(access.atomic, true, 'LDAR atomicity must survive the identity tightening');
  const exclusive = liftArm64AtomicEffects({ ...exclusiveRecord(), instructionId:ID }, { instructionId:ID });
  assert.ok(exclusive.operations.some((operation) => operation.kind === 'intrinsic'
    && operation.intrinsicId === 'arm64.exclusive-monitor-set'), 'LDXR exclusive-monitor state must survive');
  const casal = liftArm64AtomicEffects({ mnemonic:'casal', opStr:'x0, x2, [x1]', ops:parseOperands('x0, x2, [x1]'), mode:'a64', instructionId:ID });
  assert.equal(casal.metadata.ordering, 'acq-rel', 'CASAL ordering must survive the identity tightening');
}
// An absent context still resolves from the decoded record alone.
assert.equal(liftArm64MemoryEffects({ ...loadRecord(), instructionId:ID }).instructionId, ID, 'decoded-only identity');
assert.equal(liftArm64AtomicEffects({ ...exclusiveRecord(), instructionId:ID }).instructionId, ID, 'decoded-only atomic identity');

// 3-8. The same matrix fails closed for every owner, from both entry points.
for (const { owner, fields } of DECODED_IDENTITY_OWNERS) {
  for (const [field, code] of Object.entries(fields)) {
    for (const value of MALFORMED_VALUES) {
      if (CONTEXT_EVIDENCE_OWNERS.includes(owner)) {
        assertRejects(`${owner.id}: context ${field} ${value.label}`,
          () => owner.lift({ ...owner.record(), instructionId:ID }, { instructionId:ID, [field]:value.value }), code);
      }
      assertRejects(`${owner.id}: decoded ${field} ${value.label}`,
        () => owner.lift({ ...owner.record(), instructionId:ID, [field]:value.value }, { instructionId:ID }), code);
    }
  }
}

// 4. Validation must never execute caller-controlled conversion hooks.
let hookCalls = 0;
const hook = (value) => ({ toString:() => { hookCalls += 1; return value; } });
for (const owner of CONTEXT_EVIDENCE_OWNERS) {
  for (const field of Object.keys(CONTEXT_FIELDS)) {
    assertRejects(`${owner.id}: custom-toString ${field}`,
      () => owner.lift({ ...owner.record(), instructionId:ID }, { instructionId:ID, [field]:hook(ID) }));
  }
}
assert.equal(hookCalls, 0, 'identity validation must not invoke a caller-controlled toString() hook');

// Origin identity stays on the same primitive domain for these owners.
assertRejects('memory nested origin instructionIds',
  () => liftArm64MemoryEffects({ ...loadRecord(), instructionId:ID }, { instructionId:ID, origin:{ instructionIds:[[ID]] } }));
assertRejects('atomic nested origin instructionIds',
  () => liftArm64AtomicEffects({ ...exclusiveRecord(), instructionId:ID }, { instructionId:ID, origin:{ instructionIds:[[ID]] } }));

// The shared resolver is the single canonicalization point behind all of this.
assert.equal(canonicalIdentityString(' id ', 'x-error'), 'id');
assert.throws(() => canonicalIdentityString(['id'], 'x-error'), /x-error/);

console.log('Issue #8834 ARM64 memory/atomic strict identity boundary: PASS');
