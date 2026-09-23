import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIR } from '../../js/ir-core.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../js/decompiler/pipeline-core.js';
import { recoverHighVariables } from '../../js/decompiler/types/high-variables.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';
import {
  createCppMemberEvidence,
  createCppReceiverEvidence,
  createCppClassIdentity,
  createCppVirtualSlotEvidence,
} from '../../js/analysis/cxx/object-evidence.js';
import { isCppReceiverAlias } from '../../js/decompiler/cxx-evidence.js';

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
    addr: rows[0]?.address ?? null,
    ...options,
  };
  return { ir, model, opts };
}

function receiverValue(ir) {
  const value = ir?.args?.get?.('x0')
    ?? ir?.values?.find?.(candidate => candidate?.kind === 'arg' && (candidate?.reg === 'x0' || candidate?.index === 0))
    ?? null;
  assert.ok(value, 'fixture must expose canonical ABI argument 0');
  return value;
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
    functionAddress: opts.addr,
    functionId: 'func_player_read',
    canonicalValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_anon_read',
    canonicalValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_actor_mov',
    canonicalValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_store',
    canonicalValueId: receiverValue(ir).id,
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

  const partialReceiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_partial',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'speculative' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'partial',
    snapshotId: 'snap-5',
    uncertainty: null,
  });

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

  const uncertainReceiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_uncertain',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'guessed' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-6',
    uncertainty: 'ambiguous-alias-set',
  });

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
    functionAddress: opts.addr,
    functionId: 'func_vcall',
    canonicalValueId: receiverValue(ir).id,
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
    receiverValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_vcall_closed',
    canonicalValueId: receiverValue(ir).id,
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
    receiverValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_vcall_multi',
    canonicalValueId: receiverValue(ir).id,
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
    receiverValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_fields',
    canonicalValueId: receiverValue(ir).id,
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

test('canonical member type evidence reaches pseudocode as a non-semantic field annotation', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_typed_member',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'typed-member-snapshot',
  });
  const member = createCppMemberEvidence({
    functionId: receiver.functionId,
    receiverDigest: receiver.digest,
    snapshotId: 'typed-member-snapshot',
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    categoryCandidates: ['int32_t', 'uint32_t'],
    widthOnly: true,
    readCount: 1,
    rule: 'word-access',
  });

  opts.cxxEvidence = { receiver, members:[member] };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /this->field_38\s*\/\* int32_t\|uint32_t \*\//,
    'the canonical type category should be visible without pretending it is a field name');
});

test('receiver spill/reload carries typed member projection and reused stack slot fails closed', () => {
  const positive = createFixture({
    lines: [
      'str x0, [sp, #0x10]',
      'ldr x8, [sp, #0x10]',
      'ldr w0, [x8, #0x38]',
      'ret',
    ],
  });
  const receiver = createCppReceiverEvidence({
    functionAddress: positive.opts.addr,
    functionId: 'func_spilled_typed_member',
    canonicalValueId: receiverValue(positive.ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'spilled-typed-member-snapshot',
  });
  const member = createCppMemberEvidence({
    functionId: receiver.functionId,
    receiverDigest: receiver.digest,
    snapshotId: receiver.snapshotId,
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    categoryCandidates: ['int32_t', 'uint32_t'],
    widthOnly: true,
    readCount: 1,
    rule: 'word-access',
  });
  positive.opts.cxxEvidence = { receiver, members:[member] };
  const projected = decompileSemantic(positive.model, positive.opts);
  assert.match(projected.pseudocode, /this->field_38\s*\/\* int32_t\|uint32_t \*\//);

  const reused = createFixture({
    lines: [
      'str x0, [sp, #0x10]',
      'str x1, [sp, #0x10]',
      'ldr x8, [sp, #0x10]',
      'ldr w0, [x8, #0x38]',
      'ret',
    ],
  });
  const reusedReceiver = createCppReceiverEvidence({
    functionAddress: reused.opts.addr,
    functionId: 'func_reused_receiver_slot',
    canonicalValueId: receiverValue(reused.ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'reused-receiver-slot-snapshot',
  });
  const reusedMember = createCppMemberEvidence({
    functionId: reusedReceiver.functionId,
    receiverDigest: reusedReceiver.digest,
    snapshotId: reusedReceiver.snapshotId,
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    categoryCandidates: ['int32_t', 'uint32_t'],
    widthOnly: true,
    readCount: 1,
    rule: 'word-access',
  });
  reused.opts.cxxEvidence = { receiver:reusedReceiver, members:[reusedMember] };
  const failClosed = decompileSemantic(reused.model, reused.opts);
  assert.doesNotMatch(failClosed.pseudocode, /this->field_38/);
  assert.doesNotMatch(failClosed.pseudocode, /int32_t\|uint32_t/);
});

test('enhanced projection preserves canonical C++ member type annotations', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_typed_member_pipeline',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'typed-member-pipeline-snapshot',
  });
  const member = createCppMemberEvidence({
    functionId: receiver.functionId,
    receiverDigest: receiver.digest,
    snapshotId: 'typed-member-pipeline-snapshot',
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    categoryCandidates: ['int32_t', 'uint32_t'],
    widthOnly: true,
    readCount: 1,
    rule: 'word-access',
  });

  opts.cxxEvidence = { receiver, members:[member] };
  const seed = decompileSemantic(model, opts);
  const enhanced = enhanceCore(seed, model, opts);
  assert.ok(enhanced);
  assert.match(enhanced.pseudocode, /this->field_38\s*\/\* int32_t\|uint32_t \*\//);
});

test('canonical member evidence cannot be replayed onto another receiver', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const currentReceiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_current_receiver',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'current-receiver-snapshot',
  });
  const otherReceiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_other_receiver',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'other-receiver-snapshot',
  });
  const replayedMember = createCppMemberEvidence({
    functionId: otherReceiver.functionId,
    receiverDigest: otherReceiver.digest,
    snapshotId: 'other-receiver-snapshot',
    offsetBytes: 0x38n,
    sizeBytes: 4,
    category: 'int32',
    typeLabel: 'int32_t|uint32_t',
    categoryCandidates: ['int32_t', 'uint32_t'],
    widthOnly: true,
    readCount: 1,
    rule: 'word-access',
  });

  opts.cxxEvidence = { receiver: currentReceiver, members:[replayedMember] };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /this->field_38/);
  assert.doesNotMatch(result.pseudocode, /int32_t\|uint32_t/,
    'member evidence bound to another receiver must fail closed at projection time');
});

test('high variable naming: recoverHighVariables names argument 0 as this with confidence 0.95', () => {
  const { ir, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_high_var',
    canonicalValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_pipeline',
    canonicalValueId: receiverValue(ir).id,
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
      canonicalValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
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

test('adversarial: canonical receiver from a different function address fails closed', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr w0, [x0, #0x38]', 'ret'],
  });
  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr + 4n,
    functionId: 'different_function',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'wrong-function-address',
  });
  opts.cxxEvidence = { receiver };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.match(result.pseudocode, /a1->field_38/);
  assert.doesNotMatch(result.pseudocode, /this->field_38/);
});

test('adversarial: same-call-site slot for a different receiver cannot devirtualize', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr x8, [x0]', 'ldr x8, [x8, #0x10]', 'blr x8', 'ret'],
  });
  const callInst = ir.instructions.find((i) => i.op === 'call');
  assert.ok(callInst);
  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_receiver_bound_slot',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'receiver-bound-slot',
  });
  const other = ir.values.find(value => value?.id !== receiverValue(ir).id && !isCppReceiverAlias(value, receiver));
  assert.ok(other, 'fixture must expose a non-receiver SSA value');
  const mismatched = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: other.id,
    vptrValueId: 'other-vptr',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: true,
    candidateTargetIds: ['WrongTarget'],
    exactTargetAddress: 0x1234n,
  });
  opts.symbolFor = addr => addr === 0x1234n ? 'WrongTarget' : null;
  opts.cxxEvidence = { receiver, virtualSlots:[mismatched] };
  const result = decompileSemantic(model, opts);
  assert.ok(result);
  assert.doesNotMatch(result.pseudocode, /WrongTarget/);
});

test('adversarial: widening integer cast is not a receiver alias', () => {
  const source = { id:'source32', bits:32, def:null };
  const widened = {
    id:'widened64',
    bits:64,
    def:{ op:'unary', sub:'zext', args:[{ value:source }] },
  };
  const receiver = createCppReceiverEvidence({
    functionId: 'cast_alias_boundary',
    canonicalValueId: source.id,
    receiverRole: 'this',
    nonStaticProof: { rule:'proven-vtable-slot' },
    abiBinding: { architecture:'arm64', register:'x0', argumentIndex:0 },
    completeness:'complete',
    snapshotId:'cast-alias-boundary',
  });
  assert.equal(isCppReceiverAlias(widened, receiver), false);
  const sameWidth = {
    id:'bitcast64',
    bits:64,
    def:{ op:'unary', sub:'bitcast', args:[{ value:{ id:source.id, bits:64, def:null } }] },
  };
  assert.equal(isCppReceiverAlias(sameWidth, receiver), true,
    'known width-preserving casts remain transparent');
});

test('adversarial: forged virtual-slot evidence cannot devirtualize a call', () => {
  const { ir, model, opts } = createFixture({
    lines: ['ldr x8, [x0]', 'ldr x8, [x8, #0x10]', 'blr x8', 'ret'],
  });
  const callInst = ir.instructions.find((i) => i.op === 'call');
  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'func_forged_slot',
    canonicalValueId: receiverValue(ir).id,
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
      receiverValueId: receiverValue(ir).id,
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
    functionAddress: opts.addr,
    functionId: 'func_unknown_arity',
    canonicalValueId: receiverValue(ir).id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'unknown-arity',
  });
  const slot = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: receiverValue(ir).id,
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
