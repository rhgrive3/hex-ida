import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIR } from '../../js/ir-core.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../js/decompiler/pipeline-core.js';
import { recoverHighVariables } from '../../js/decompiler/types/high-variables.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';
import {
  createCppReceiverEvidence,
  createCppClassIdentity,
  createCppVirtualSlotEvidence,
} from '../../js/analysis/cxx/object-evidence.js';

function createFixture({
  lines = ['ldr w0, [x0, #0x38]', 'ret'],
  name = 'test_func',
  options = {},
} = {}) {
  const rows = lines.map((text, row) => {
    const split = text.indexOf(' ');
    return {
      row,
      address: 0x100000000n + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
  const prototype = { returnType: 'uint64', returnBits: 64, returnsValue: true, args: [{ type: 'uint64', bits: 64 }] };
  const ir = buildIR(model, { rowOfAddress, returnType: 'uint64', callPrototypeFor: () => prototype, semanticMigrationMode: 'semantic-v2-compat' });
  const opts = {
    ir,
    deterministicTransforms: true,
    returnType: 'uint64',
    defaultCallArgs: 1,
    name,
    ...options,
  };
  return { ir, model, opts };
}

test('positive receiver: argument 0 renders as this and signature has ClassName * this', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const classIdentity = createCppClassIdentity({
    kind: 'named',
    className: 'Player',
    vtableAddress: 0x100020000n,
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_player_read',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    classIdentity,
    nonStaticProof: {
      source: 'rtti-vtable-member',
      rule: 'vtable-slot-entry',
    },
    abiBinding: {
      architecture: 'arm64',
      register: 'x0',
      argumentIndex: 0,
    },
    completeness: 'complete',
    snapshotId: 'snap-1',
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Signature must project Player * this
  assert.match(code, /Player\s*\*\s*this/);
  // Field access must project this->field_38
  assert.match(code, /this->field_38/);
  // Must NOT retain a1 as the receiver
  assert.doesNotMatch(code, /a1->field_38/);
});

test('anonymous class receiver: renders uint64 this without inventing fake class name', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const classIdentity = createCppClassIdentity({
    kind: 'anonymous',
    vtableAddress: 0x100020000n,
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_anon_read',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    classIdentity,
    nonStaticProof: {
      source: 'vtable-membership',
      rule: 'vtable-slot-entry',
    },
    abiBinding: {
      architecture: 'arm64',
      register: 'x0',
      argumentIndex: 0,
    },
    completeness: 'complete',
    snapshotId: 'snap-2',
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Signature must have 'this' without fake class name
  assert.match(code, /\bthis\b/);
  assert.doesNotMatch(code, /AnonymousClass/);
  assert.doesNotMatch(code, /Class_/);
  // Field access still projects this->field_38
  assert.match(code, /this->field_38/);
});

test('receiver copy: tracing MOV x19, x0 renders this->field_20', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'mov x19, x0',
      'ldr w0, [x19, #0x20]',
      'ret',
    ],
  });

  const classIdentity = createCppClassIdentity({
    kind: 'named',
    className: 'Actor',
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_actor_mov',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    classIdentity,
    nonStaticProof: {
      source: 'cxx-nonstatic-proof',
      rule: 'proven-const-member',
    },
    abiBinding: {
      architecture: 'arm64',
      register: 'x0',
      argumentIndex: 0,
    },
    completeness: 'complete',
    snapshotId: 'snap-3',
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  assert.match(code, /this->field_20/);
});

test('store to receiver field: this->field_10 = 42', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'mov w1, #42',
      'str w1, [x0, #0x10]',
      'ret',
    ],
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_store',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: {
      source: 'cxx-member',
      rule: 'proven-constructor',
    },
    abiBinding: {
      architecture: 'arm64',
      register: 'x0',
      argumentIndex: 0,
    },
    completeness: 'complete',
    snapshotId: 'snap-4',
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  assert.match(code, /this->field_10\s*=\s*42/);
});

test('negative gate: ordinary C function without cxxEvidence renders a1->field_38', () => {
  const { model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  // No cxxEvidence
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  assert.match(code, /a1->field_38/);
  assert.doesNotMatch(code, /\bthis\b/);
});

test('negative gate: partial completeness fails closed and preserves a1', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const partialReceiver = {
    schema: 'cpp-receiver-evidence/v1',
    functionId: 'func_partial',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'speculative' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'partial',
    snapshotId: 'snap-5',
    uncertainty: null,
  };

  opts.cxxEvidence = { receiver: partialReceiver };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  assert.match(code, /a1->field_38/);
  assert.doesNotMatch(code, /\bthis->/);
});

test('negative gate: uncertainty flag fails closed and preserves a1', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const uncertainReceiver = {
    schema: 'cpp-receiver-evidence/v1',
    functionId: 'func_uncertain',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'guessed' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-6',
    uncertainty: 'ambiguous-alias-set',
  };

  opts.cxxEvidence = { receiver: uncertainReceiver };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  assert.match(code, /a1->field_38/);
  assert.doesNotMatch(code, /\bthis->/);
});

test('virtual slot dispatch: unclosed candidate count = 1 retains indirect call (*(code **)(...))(this)', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'ldr x8, [x0]',
      'ldr x8, [x8, #0x10]',
      'blr x8',
      'ret',
    ],
  });

  const callInst = ir.instructions.find((i) => i.op === 'call');
  assert.ok(callInst);

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_vcall',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-7',
  });

  // Candidate count = 1, but closureProven is false!
  const virtualSlotEvidence = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: ir.values[0].id,
    vptrValueId: 'vptr_val',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: false,
    candidateTargetIds: ['0x100040'],
    exactTargetAddress: 0x100040n,
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
    virtualSlots: [virtualSlotEvidence],
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Soundness requirement: candidate count = 1 does NOT prove target when closureProven is false.
  // It MUST retain indirect call syntax (*(code **)(...))(this)
  assert.match(code, /\(\*\(code \*\*\)\(\.\.\.\)\)\(this\)/);
  assert.doesNotMatch(code, /sub_100040/);
});

test('virtual slot dispatch: closureProven with single candidate devirtualizes to exact target', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'ldr x8, [x0]',
      'ldr x8, [x8, #0x10]',
      'blr x8',
      'ret',
    ],
  });

  const callInst = ir.instructions.find((i) => i.op === 'call');
  assert.ok(callInst);

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_vcall_closed',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-8',
  });

  // Closure IS proven with single candidate
  const virtualSlotEvidence = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: ir.values[0].id,
    vptrValueId: 'vptr_val',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: true,
    candidateTargetIds: ['0x100040'],
    exactTargetAddress: 0x100040n,
  });

  opts.symbolFor = (addr) => (addr === 0x100040n ? 'Player_onTakeDamage' : null);
  opts.cxxEvidence = {
    receiver: receiverEvidence,
    virtualSlots: [virtualSlotEvidence],
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Devirtualized call with this as argument
  assert.match(code, /Player_onTakeDamage\(this\)/);
});

test('virtual slot dispatch: closureProven with multiple candidates fails closed to indirect call', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'ldr x8, [x0]',
      'ldr x8, [x8, #0x10]',
      'blr x8',
      'ret',
    ],
  });

  const callInst = ir.instructions.find((i) => i.op === 'call');
  assert.ok(callInst);

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_vcall_multi',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-9',
  });

  // Closure proven but 2 candidates -> exactTargetKnown is false
  const virtualSlotEvidence = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: ir.values[0].id,
    vptrValueId: 'vptr_val',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: true,
    candidateTargetIds: ['0x100040', '0x100080'],
    exactTargetAddress: null,
  });

  opts.cxxEvidence = {
    receiver: receiverEvidence,
    virtualSlots: [virtualSlotEvidence],
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Retains indirect call syntax
  assert.match(code, /\(\*\(code \*\*\)\(\.\.\.\)\)\(this\)/);
});

test('authoritative field name metadata: this->field_38 becomes this->m_health', () => {
  const { ir, model, opts } = createFixture({
    lines: [
      'ldr w1, [x0, #0x38]',
      'ldr w2, [x0, #0x40]',
      'add w0, w1, w2',
      'ret',
    ],
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_fields',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-10',
  });

  opts.cxxEvidence = { receiver: receiverEvidence };
  // Authoritative field name for 0x38, but NOT for 0x40
  opts.fieldFor = (_reg, off) => (off === 0x38n ? { name: 'm_health' } : null);

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  const code = result.pseudocode;

  // Authoritative offset has name
  assert.match(code, /this->m_health/);
  // Unknown offset keeps hex field_40 without fabricating fake names
  assert.match(code, /this->field_40/);
});

test('high variable naming: recoverHighVariables names argument 0 as this with confidence 0.95', () => {
  const { ir, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_high_var',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-11',
  });

  const types = inferSemanticTypes(ir, { instructions: ir.instructions });
  const highVars = recoverHighVariables(ir, types, {
    ...opts,
    cxxEvidence: { receiver: receiverEvidence },
  });

  const group0 = highVars.groups.find((g) => g.kind === 'argument' && g.argIndex === 0);
  assert.ok(group0);
  assert.equal(group0.name, 'this');
  assert.equal(group0.nameConfidence, 0.95);
});

test('pipeline-core projection: enhanceSemanticDecompilation projects this->field_38', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionId: 'func_pipeline',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-12',
  });

  opts.cxxEvidence = { receiver: receiverEvidence };
  const seed = decompileSemantic(model, opts);
  assert.ok(seed);

  const enhanced = enhanceCore(seed, model, opts);
  assert.ok(enhanced);
  assert.match(enhanced.pseudocode, /this->field_38/);
});


test('adversarial: plain forged receiver evidence cannot rename argument 0 to this', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });
  opts.cxxEvidence = {
    receiver: {
      schema: 'cpp-receiver-evidence/v1',
      functionId: 'forged',
      canonicalValueId: ir.values[0].id,
      receiverRole: 'this',
      abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
      completeness: 'complete',
      snapshotId: 'forged',
      uncertainty: null,
    },
  };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /a1->field_38/);
  assert.doesNotMatch(result.pseudocode, /this->field_38/);
});

test('adversarial: producer-issued receiver for a different canonical value fails closed', () => {
  const { model, opts } = createFixture({
    lines: ['mov x1, x0', 'ldr w0, [x0, #0x38]', 'ret'],
  });
  const stale = createCppReceiverEvidence({
    functionId: 'other_function',
    canonicalValueId: 999999,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'stale',
  });
  opts.cxxEvidence = { receiver: stale };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /a1->field_38/);
  assert.doesNotMatch(result.pseudocode, /this->field_38/);
});

test('adversarial: forged virtual-slot evidence cannot devirtualize a call', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr x8, [x0]', 'ldr x8, [x8, #0x10]', 'blr x8', 'ret'],
  });
  const callInst = ir.instructions.find((i) => i.op === 'call');
  const receiver = createCppReceiverEvidence({
    functionId: 'func_forged_slot',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'slot-forge',
  });
  opts.symbolFor = () => 'forged_exact_target';
  opts.cxxEvidence = {
    receiver,
    virtualSlots: [{
      schema: 'cpp-virtual-slot-evidence/v1',
      callSiteId: callInst.id,
      receiverValueId: ir.values[0].id,
      vptrValueId: 'fake',
      slotIndex: 2,
      slotByteOffset: 16,
      virtualSlotKnown: true,
      exactTargetKnown: true,
      exactTargetAddress: 0x1234n,
      closureProven: true,
    }],
  };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.doesNotMatch(result.pseudocode, /forged_exact_target/);
});

test('virtual slot without authoritative argument count preserves unknown additional arguments', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr x8, [x0]', 'ldr x8, [x8, #0x10]', 'blr x8', 'ret'],
    options: { defaultCallArgs: null },
  });
  const callInst = ir.instructions.find((i) => i.op === 'call');
  const receiver = createCppReceiverEvidence({
    functionId: 'func_unknown_arity',
    canonicalValueId: ir.values[0].id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'unknown-arity',
  });
  const slot = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: ir.values[0].id,
    vptrValueId: 'vptr',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: false,
  });
  opts.cxxEvidence = { receiver, virtualSlots:[slot] };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /additional arguments unknown/);
});
