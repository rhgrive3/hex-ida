import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCppReceiverEvidence,
  createCppClassIdentity,
  createCppVtableEvidence,
  createCppVirtualSlotEvidence,
  extractCppObjectEvidence,
  validateCppObjectEvidence,
  CPP_RECEIVER_SCHEMA,
  CPP_CLASS_IDENTITY_SCHEMA,
  CPP_VTABLE_SCHEMA,
  CPP_VIRTUAL_SLOT_SCHEMA,
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from '../../js/analysis/cxx/object-evidence.js';

// Helper to construct a synthetic IR with instructions and values
function makeTestIr({ hasCopy = false, hasVirtualCall = false, slotOffset = 0x40n } = {}) {
  const values = [
    { id: 1, kind: 'arg', reg: 'x0', uses: [], def: null },
  ];
  const instructions = [];

  if (hasCopy) {
    values.push({ id: 2, kind: 'def', reg: 'x19', uses: [], def: null });
    const movInst = {
      id: 10,
      op: 'mov',
      dst: values[1],
      args: [{ value: values[0] }],
    };
    values[1].def = movInst;
    instructions.push(movInst);
  }

  if (hasVirtualCall) {
    const receiverVal = hasCopy ? values[1] : values[0];
    // vptr = load [receiverVal + 0]
    const vptrVal = { id: 3, kind: 'def', reg: 'x8', uses: [], def: null };
    const loadVptr = {
      id: 20,
      op: 'load',
      dst: vptrVal,
      args: [],
      loc: { kind: 'field', base: receiverVal, disp: 0n, size: 8 },
    };
    vptrVal.def = loadVptr;

    // slot = load [vptrVal + slotOffset]
    const slotVal = { id: 4, kind: 'def', reg: 'x8', uses: [], def: null };
    const loadSlot = {
      id: 21,
      op: 'load',
      dst: slotVal,
      args: [],
      loc: { kind: 'field', base: vptrVal, disp: slotOffset, size: 8 },
    };
    slotVal.def = loadSlot;

    // call slotVal(receiverVal)
    const callInst = {
      id: 22,
      op: 'call',
      args: [{ value: slotVal }, { value: receiverVal }],
    };
    values.push(vptrVal, slotVal);
    instructions.push(loadVptr, loadSlot, callInst);
  }

  return { values, instructions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Positive Receiver Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Positive receiver for C++ constructor', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_player_ctor',
    functionName: '_ZN6PlayerC1Ev',
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.completeness, 'complete');
  assert.ok(report.receiver);
  assert.equal(report.receiver.schema, CPP_RECEIVER_SCHEMA);
  assert.equal(report.receiver.receiverRole, 'this');
  assert.equal(report.receiver.canonicalValueId, 1);
  assert.equal(report.receiver.classIdentity.kind, 'named');
  assert.equal(report.receiver.classIdentity.className, 'Player');
  assert.equal(report.receiver.nonStaticProof.rule, 'constructor-has-this');
});

test('PR A: Positive receiver for C++ const member function', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_player_get',
    functionName: '_ZNK6Player3getEv',
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.completeness, 'complete');
  assert.ok(report.receiver);
  assert.equal(report.receiver.receiverRole, 'this');
  assert.equal(report.receiver.classIdentity.className, 'Player');
  assert.equal(report.receiver.nonStaticProof.rule, 'const-qualifier-has-this');
});

test('PR A: Positive receiver from vtable slot membership', () => {
  const ir = makeTestIr();
  const vtable = createCppVtableEvidence({
    vtableAddress: 0x5000n,
    pointerBytes: 8,
    offsetToTop: 0n,
    slots: [{ index: 0, address: 0x1234n, symbolName: '_ZN6Player6UpdateEv', unresolved: false }],
  });

  const report = extractCppObjectEvidence({
    functionId: 'sub_player_update',
    functionAddress: 0x1234n,
    functionName: '_ZN6Player6UpdateEv',
    vtables: [vtable],
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.completeness, 'complete');
  assert.ok(report.receiver);
  assert.equal(report.receiver.nonStaticProof.rule, 'vtable-slot-is-virtual-member');
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative Receiver Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Ordinary C function with x0 first argument is rejected (negative)', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_ordinary_c',
    functionName: 'compute_hash',
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.receiver, null);
  assert.equal(report.status, 'non-cxx-or-free-function');
  assert.equal(report.reason, 'not-mangled-symbol');
});

test('PR A: C++ free function with object pointer is rejected (negative)', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_free_func',
    functionName: '_Z6updateP6Player', // update(Player*)
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.receiver, null);
  assert.equal(report.status, 'non-cxx-or-free-function');
  assert.equal(report.reason, 'cxx-free-function');
});

test('PR A: C++ static member function is rejected (negative)', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_static_member',
    functionName: '_ZN6Player5ResetEv',
    metadata: { isStatic: true },
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.receiver, null);
  assert.equal(report.status, 'static-member-no-receiver');
  assert.equal(report.reason, 'static-member-function');
});

// ─────────────────────────────────────────────────────────────────────────────
// Copy & MOV Propagation Test
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Receiver identity preserved across MOV copy', () => {
  const ir = makeTestIr({ hasCopy: true, hasVirtualCall: true });
  const report = extractCppObjectEvidence({
    functionId: 'sub_with_copy',
    functionName: '_ZN6PlayerC1Ev',
    ir,
    snapshotId: 'snap-001',
  });

  assert.ok(report.receiver);
  assert.equal(report.receiver.canonicalValueId, 1);
  assert.equal(report.virtualSlots.length, 1);
  assert.equal(report.virtualSlots[0].receiverValueId, 2); // Copied to x19 (value 2)
  assert.equal(report.virtualSlots[0].virtualSlotKnown, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Named vs. Anonymous Class Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Named class retains verified name', () => {
  const identity = createCppClassIdentity({
    kind: 'named',
    className: 'EntityComponent',
    vtableAddress: 0x4000n,
  });

  assert.equal(identity.kind, 'named');
  assert.equal(identity.className, 'EntityComponent');
  assert.equal(identity.isAnonymous, false);
});

test('PR A: Anonymous class retains identity without fabricating fake name', () => {
  const identity = createCppClassIdentity({
    kind: 'anonymous',
    vtableAddress: 0x4000n,
  });

  assert.equal(identity.kind, 'anonymous');
  assert.equal(identity.className, null);
  assert.equal(identity.isAnonymous, true);

  // Must reject anonymous identity that tries to supply a name
  assert.throws(
    () => createCppClassIdentity({ kind: 'anonymous', className: 'FakeClass' }),
    /cpp-class-identity-anonymous-cannot-have-name/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Virtual Slot vs. Exact Target Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Virtual slot recognized without assuming exact target', () => {
  const ir = makeTestIr({ hasVirtualCall: true, slotOffset: 0x40n });
  const report = extractCppObjectEvidence({
    functionId: 'sub_virtual_call',
    functionName: '_ZN6PlayerC1Ev',
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.virtualSlots.length, 1);
  const slot = report.virtualSlots[0];
  assert.equal(slot.virtualSlotKnown, true);
  assert.equal(slot.slotIndex, 8); // 0x40 / 8 = 8
  assert.equal(slot.slotByteOffset, 0x40);
  assert.equal(slot.exactTargetKnown, false); // Target set closure is NOT proven
  assert.equal(slot.exactTargetAddress, null);
});

test('PR A: Non-vtable table is not treated as virtual slot (negative)', () => {
  // Indirect call that doesn't follow vtable dereference pattern
  const ir = {
    values: [
      { id: 1, kind: 'arg', reg: 'x0', def: null },
      { id: 2, kind: 'def', reg: 'x1', def: null }, // arbitrary pointer
    ],
    instructions: [
      { id: 10, op: 'call', args: [{ value: { id: 2 } }] },
    ],
  };

  const report = extractCppObjectEvidence({
    functionId: 'sub_callback_table',
    functionName: '_ZN6PlayerC1Ev',
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.virtualSlots.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple Inheritance & Secondary Vtable Fail-Closed Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Secondary vtable with non-zero offsetToTop fails closed', () => {
  const ir = makeTestIr();
  const secondaryVtable = createCppVtableEvidence({
    vtableAddress: 0x6000n,
    pointerBytes: 8,
    offsetToTop: -16n, // Non-zero offset-to-top!
    slots: [{ index: 0, address: 0x2000n, symbolName: '_ZN6Player6RenderEv', unresolved: false }],
  });

  assert.equal(secondaryVtable.isSecondary, true);

  const report = extractCppObjectEvidence({
    functionId: 'sub_secondary_base',
    functionAddress: 0x2000n,
    functionName: '_ZN6Player6RenderEv',
    vtables: [secondaryVtable],
    ir,
    snapshotId: 'snap-001',
  });

  // Fails closed: cannot treat secondary vtable as primary receiver
  assert.equal(report.receiver, null);
  assert.equal(report.status, 'fail-closed-secondary-vtable');
});

test('PR A: This-adjusting thunk fails closed', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_thunk',
    functionName: '_ZThn16_N6Player6UpdateEv', // thunk to Player::Update()
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.receiver, null);
  assert.equal(report.status, 'fail-closed-thunk');
});

// ─────────────────────────────────────────────────────────────────────────────
// Incomplete Evidence Fail-Closed Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A: Incomplete evidence with stale snapshot fails closed', () => {
  assert.throws(
    () => createCppReceiverEvidence({
      functionId: 'sub_1',
      canonicalValueId: 1,
      receiverRole: 'this',
      classIdentity: { kind: 'named', className: 'Player' },
      nonStaticProof: { source: 'symbol-syntax', rule: 'constructor' },
      abiBinding: { register: 'x0', argumentIndex: 0 },
      completeness: 'complete',
      snapshotId: '', // Invalid / missing snapshot ID
    }),
    /cpp-receiver-snapshot-id-required/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial Mutation Tests
// ─────────────────────────────────────────────────────────────────────────────

test('PR A MUTATION 1: Change receiver function to free function removes receiver claim', () => {
  const ir = makeTestIr();
  const mutated = extractCppObjectEvidence({
    functionId: 'sub_test',
    functionName: '_Z6updateP6Player', // Mutated from member to free function
    ir,
    snapshotId: 'snap-001',
  });
  assert.equal(mutated.receiver, null);
});

test('PR A MUTATION 2: Change to static member removes receiver claim', () => {
  const ir = makeTestIr();
  const mutated = extractCppObjectEvidence({
    functionId: 'sub_test',
    functionName: '_ZN6Player6UpdateEv',
    metadata: { isStatic: true }, // Mutated to static
    ir,
    snapshotId: 'snap-001',
  });
  assert.equal(mutated.receiver, null);
});

test('PR A MUTATION 3: Change receiver canonical argument index throws', () => {
  assert.throws(
    () => createCppReceiverEvidence({
      functionId: 'sub_test',
      canonicalValueId: 2,
      receiverRole: 'this',
      classIdentity: { kind: 'named', className: 'Player' },
      nonStaticProof: { rule: 'constructor' },
      abiBinding: { register: 'x1', argumentIndex: 1 }, // Mutated from argument 0
      completeness: 'complete',
      snapshotId: 'snap-001',
    }),
    /cpp-receiver-abi-argument-index-invalid/,
  );
});

test('PR A MUTATION 4: Change offsetToTop to non-zero throws secondary vtable rejection', () => {
  assert.throws(
    () => createCppReceiverEvidence({
      functionId: 'sub_test',
      canonicalValueId: 1,
      receiverRole: 'this',
      classIdentity: { kind: 'named', className: 'Player', offsetToTop: -32n }, // Mutated offset
      nonStaticProof: { rule: 'constructor' },
      abiBinding: { register: 'x0', argumentIndex: 0 },
      completeness: 'complete',
      snapshotId: 'snap-001',
    }),
    /cpp-receiver-secondary-vtable-rejected/,
  );
});

test('PR A MUTATION 5: Single candidate without closure proof cannot become exact target', () => {
  const slot = createCppVirtualSlotEvidence({
    callSiteId: 100,
    receiverValueId: 1,
    vptrValueId: 2,
    slotIndex: 8,
    slotByteOffset: 0x40,
    virtualSlotKnown: true,
    candidateTargetIds: ['Player::Update'],
    closureProven: false, // Mutated: NOT proven closed!
    exactTargetAddress: 0x1234n,
  });

  assert.equal(slot.virtualSlotKnown, true);
  assert.equal(slot.exactTargetKnown, false); // MUST NOT claim exact target
  assert.equal(slot.exactTargetAddress, null);
});

test('PR A MUTATION 6: Relocation unresolved in vtable slot marks slot unresolved', () => {
  const vtable = createCppVtableEvidence({
    vtableAddress: 0x5000n,
    pointerBytes: 8,
    slots: [{ index: 0, address: 0x1000n, unresolved: true, reason: 'unresolved-pac' }],
  });

  assert.equal(vtable.slots[0].unresolved, true);
  assert.equal(vtable.slots[0].address, null);
});


test('PR A: exact target cannot be promoted when the virtual dispatch itself is unproven', () => {
  const slot = createCppVirtualSlotEvidence({
    callSiteId: 101,
    receiverValueId: 1,
    vptrValueId: 2,
    slotIndex: 2,
    slotByteOffset: 0x10,
    virtualSlotKnown: false,
    closureProven: true,
    candidateTargetIds: ['Player::Update'],
    exactTargetAddress: 0x1234n,
  });
  assert.equal(slot.virtualSlotKnown, false);
  assert.equal(slot.exactTargetKnown, false);
  assert.equal(slot.exactTargetAddress, null);
});

test('PR A: unaligned vtable load offset is not promoted to a virtual slot', () => {
  const ir = makeTestIr({ hasVirtualCall: true, slotOffset: 0x11n });
  const report = extractCppObjectEvidence({
    functionId: 'sub_unaligned_slot',
    functionName: '_ZN6PlayerC1Ev',
    ir,
    snapshotId: 'snap-unaligned',
  });
  assert.equal(report.virtualSlots.length, 0);
});

test('PR A: canonical receiver/slot identity is producer-bound and not copyable', () => {
  const receiver = createCppReceiverEvidence({
    functionId: 'sub_brand',
    canonicalValueId: 1,
    receiverRole: 'this',
    nonStaticProof: { rule: 'constructor-has-this' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-brand',
  });
  const slot = createCppVirtualSlotEvidence({
    callSiteId: 1,
    receiverValueId: 1,
    vptrValueId: 2,
    slotIndex: 0,
    slotByteOffset: 0,
    virtualSlotKnown: true,
    closureProven: false,
  });
  assert.equal(isCanonicalCppReceiverEvidence(receiver), true);
  assert.equal(isCanonicalCppReceiverEvidence(structuredClone(receiver)), false);
  assert.equal(isCanonicalCppVirtualSlotEvidence(slot), true);
  assert.equal(isCanonicalCppVirtualSlotEvidence(structuredClone(slot)), false);
});

test('PR A: negative vtable slot index/offset are rejected', () => {
  assert.throws(() => createCppVtableEvidence({
    vtableAddress: 0x5000n,
    pointerBytes: 8,
    slots: [{ index: -1, address: 0x1000n }],
  }), /cpp-vtable-slot-index-invalid/);
  assert.throws(() => createCppVtableEvidence({
    vtableAddress: 0x5000n,
    pointerBytes: 8,
    slots: [{ index: 0, offset: -8, address: 0x1000n }],
  }), /cpp-vtable-slot-offset-invalid/);
});

test('PR A MUTATION 7: Unproven member kind without vtable membership fails closed to partial', () => {
  const ir = makeTestIr();
  const report = extractCppObjectEvidence({
    functionId: 'sub_unproven',
    functionName: '_ZN6Player6HelperEv', // unadorned member without ctor/dtor/const/vtable
    ir,
    snapshotId: 'snap-001',
  });

  assert.equal(report.receiver, null);
  assert.equal(report.completeness, 'partial');
  assert.equal(report.reason, 'unproven-non-static-member');
});
