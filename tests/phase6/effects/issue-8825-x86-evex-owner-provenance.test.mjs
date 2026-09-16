import assert from 'node:assert/strict';

// Model the dedicated receiver worker realm used by the production semantic
// revalidation path. Public/parser rows below intentionally never receive this
// brand; only the canonical Capstone row used for the positive control does.
globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);
globalThis.__HEX_PROTECTED_WORKER_LOGICAL_PATH__ = 'js/targets/architecture/x86_64/semantic-revalidation-worker.js';

const { createCapstoneX86Session } = await import('../../phase5/helpers/capstone-session.mjs');
const { liftX86MachineEffects } = await import('../../../js/targets/architecture/x86_64/effects/index.js');
const { trustedCapstoneInstruction } = await import('../../../js/targets/architecture/x86_64/effects/extended-state-helpers.js');
const {
  hasReceiverRevalidatedX86Row,
  markReceiverRevalidatedX86Row,
} = await import('../../../js/targets/architecture/x86_64/runtime-provenance.js');

const capstone = await createCapstoneX86Session();
try {
  // vblendmps xmm0, xmm2, xmm1. This is the concrete row used by #8825: the
  // architectural destination is xmm0, so the exact MAXVL aliases are ymm0
  // and zmmh0 after receiver revalidation.
  const raw = capstone.decode([0x62, 0xf2, 0x6d, 0x08, 0x65, 0xc1], 0x720000n)[0];
  assert.equal(raw.instructionFamily, 'vblendmps');
  assert.equal(raw.opcodeName, 'vblendmps');

  const receiverRow = markReceiverRevalidatedX86Row(raw);
  assert.equal(hasReceiverRevalidatedX86Row(receiverRow), true);
  const positive = liftX86MachineEffects(receiverRow, { instructionId:'issue-8825:positive' });
  assert.equal(positive.completeness, 'exact-with-intrinsic');
  assert.deepEqual(
    positive.operations.filter((operation) => operation.kind === 'register-write').map((operation) => operation.register.registerId),
    ['ymm0', 'zmmh0'],
    'the canonical receiver row keeps its byte-proven destination',
  );

  // Counterexample: structuredClone preserves the apparent Capstone fields
  // but cannot preserve the receiver-private WeakSet brand. Mutating only the
  // destination changes the architectural write to xmm3 on the old path.
  const forged = structuredClone(raw);
  forged.detail.operands[0].registerId = 'xmm3';
  forged.detail.operands[0].registerCode = 125;
  assert.equal(hasReceiverRevalidatedX86Row(forged), false);
  const rejected = liftX86MachineEffects(forged, { instructionId:'issue-8825:forged-destination' });
  assert.equal(rejected.completeness, 'partial');
  assert.equal(rejected.unknownEffects?.reason, 'x86-evex-trusted-decoder-provenance-required');
  assert.deepEqual(
    rejected.operations.filter((operation) => operation.kind === 'register-write'),
    [],
    'an unbranded row cannot publish forged definite vector writes',
  );

  // The old trust predicate also accepted caller-controlled coercions. Keep a
  // marked test row so the provenance gate is satisfied, then prove that both
  // a string instruction code and an opcodeName object are rejected without
  // invoking conversion hooks.
  const stringCode = { ...receiverRow, instructionCode:String(receiverRow.instructionCode) };
  const opcodeName = { toString() { throw new Error('opcodeName-coercion-must-not-run'); } };
  const objectName = { ...receiverRow, opcodeName };
  const markedStringCode = markReceiverRevalidatedX86Row(stringCode);
  const markedObjectName = markReceiverRevalidatedX86Row(objectName);
  assert.equal(trustedCapstoneInstruction(markedStringCode, 'vblendmps', markedStringCode), false);
  assert.equal(trustedCapstoneInstruction(markedObjectName, 'vblendmps', markedObjectName), false);
} finally {
  capstone.close();
}

console.log('issue-8825 x86 EVEX owner provenance: PASS');
