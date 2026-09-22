import assert from 'node:assert/strict';
import test from 'node:test';

import { openCxxFixture } from './fixtures/open.mjs';
import { buildCxxClassEvidence } from '../../../js/analysis/cxx/rtti-evidence.js';
import {
  CPP_CLOSURE_RULES,
  derivedClassesOf,
  resolveVirtualTargetSet,
  virtualSlotEvidenceFor,
} from '../../../js/analysis/cxx/virtual-dispatch.js';
import { isCanonicalCppVirtualSlotEvidence } from '../../../js/analysis/cxx/object-evidence.js';

const RTTI = 'game-rtti-o2';
const NO_RTTI = 'game-nortti-o2';

function unavailableReason() {
  const probe = openCxxFixture(RTTI);
  return probe.available ? null : probe.reason;
}

const UNAVAILABLE = unavailableReason();
const FIXTURE_OPTIONS = UNAVAILABLE ? { skip: UNAVAILABLE } : {};

async function evidence(name, overrides = {}) {
  const probe = openCxxFixture(name);
  return buildCxxClassEvidence({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    maxSlots: 16,
    ...overrides,
  });
}

// Slot 2 of this fixture is `takeDamage`: Entity declares it, Actor overrides it,
// Player overrides it. Slot 3 is `update`: Entity declares it, Actor overrides
// it, Player inherits Actor's implementation. Slot indices are fixed by the
// Itanium ABI, so they are stable across -O0/-O2.
const TAKE_DAMAGE_SLOT = 2;
const UPDATE_SLOT = 3;

test('inheritance edges come from RTTI, not naming similarity', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  assert.deepEqual(derivedClassesOf(report, 'Entity'), ['Actor', 'Player']);
  assert.deepEqual(derivedClassesOf(report, 'Actor'), ['Player']);
  assert.deepEqual(derivedClassesOf(report, 'Player'), []);
  assert.deepEqual(derivedClassesOf(report, 'NotAClass'), []);
});

test('receiver of static type Entity: the target set keeps every legal override', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  const targetSet = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: TAKE_DAMAGE_SLOT,
  });

  assert.equal(targetSet.scope, 'call-site');
  assert.deepEqual(targetSet.derivedClasses, ['Actor', 'Player']);
  assert.equal(targetSet.candidates.length, 3, 'Entity, Actor and Player implementations are all legal');
  assert.equal(targetSet.candidateAddresses.length, 3);
  assert.equal(new Set(targetSet.candidateAddresses).size, 3);
  assert.deepEqual(
    [...new Set(targetSet.candidates.map((candidate) => candidate.viaClass))].sort(),
    ['Actor', 'Entity', 'Player'],
  );
  assert.equal(targetSet.closureProven, false);
  assert.equal(targetSet.completeness, 'complete');
  assert.equal(targetSet.reason, null);
});

test('receiver of static type Player: one candidate is still not a closure proof', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  const targetSet = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
  });

  assert.equal(targetSet.candidates.length, 1);
  // A class derived outside this image could legally override the slot, so a
  // single discovered candidate must never be promoted to a single target.
  assert.equal(targetSet.closureProven, false);
  assert.equal(targetSet.closureRule, null);
});

test('an inherited slot resolves to the base implementation for the derived class', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  const playerUpdate = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: UPDATE_SLOT,
  });
  assert.equal(playerUpdate.candidates.length, 1);
  assert.deepEqual(playerUpdate.candidates[0].aliases, ['_ZN5Actor6updateEf']);

  const entityUpdate = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: UPDATE_SLOT,
  });
  // Actor overrides update; Player inherits Actor's implementation, so the
  // reachable implementation set is {Entity::update, Actor::update} even though
  // three vtables contribute a slot value.
  assert.equal(entityUpdate.candidateAddresses.length, 2);
  assert.deepEqual(
    [...entityUpdate.candidates.map((candidate) => candidate.aliases[0])].sort(),
    ['_ZN5Actor6updateEf', '_ZN5Actor6updateEf', '_ZN6Entity6updateEf'],
  );
});

test('closure requires an explicit, allow-listed call-site authority', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);

  // Without any exact-dynamic-class proof the Entity target set stays a set.
  const noProof = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: false,
  });
  assert.equal(noProof.closureProven, false);

  // With an exact-dynamic-class proof the dispatch is restricted to that
  // class's own vtable, so a base-class receiver CAN close to one target.
  const exactEntity = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
    closureAuthority: { rule: CPP_CLOSURE_RULES[0], callSiteId: 'call-1' },
  });
  assert.equal(exactEntity.closureProven, true);
  assert.equal(exactEntity.candidateAddresses.length, 1);

  const playerClosed = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
    closureAuthority: { rule: 'constructor-vtable-store', callSiteId: 'call-2' },
  });
  assert.equal(playerClosed.closureProven, true);
  assert.equal(playerClosed.closureRule, 'constructor-vtable-store');
  assert.equal(playerClosed.candidateAddresses.length, 1);

  const badRule = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
    closureAuthority: { rule: 'because-i-say-so', callSiteId: 'call-3' },
  });
  assert.equal(badRule.closureProven, false);
  assert.equal(badRule.reason, 'closure-authority-invalid');

  const missingCallSite = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
    closureAuthority: { rule: 'constructor-vtable-store' },
  });
  assert.equal(missingCallSite.closureProven, false);

  const missingAuthority = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
  });
  assert.equal(missingAuthority.closureProven, false);
  assert.equal(missingAuthority.reason, 'closure-authority-required');
});

function syntheticRecord(className, vtableAddress, slotAddresses) {
  return {
    className,
    derivedFrom: [],
    vtableAddress,
    slots: slotAddresses.map((address, index) => ({
      index,
      address,
      unresolved: address == null,
      reason: address == null ? 'encoded-pointer-without-fixup-context' : null,
      aliases: address == null ? [] : [`${className}_slot_${index}`],
    })),
  };
}

test('a multi-vtable exact class with two distinct targets fails closed', async () => {
  const synthetic = {
    rttiPresent: true,
    classes: [
      syntheticRecord('Widget', 0x1000n, [0x11n, 0x12n, 0x13n]),
      syntheticRecord('Widget', 0x2000n, [0x21n, 0x22n, 0x23n]),
    ],
  };
  const targetSet = resolveVirtualTargetSet({
    classEvidence: synthetic,
    receiverClass: 'Widget',
    slotIndex: 2,
    dynamicClassProven: true,
    closureAuthority: { rule: 'exact-object-definition', callSiteId: 'synthetic-1' },
  });
  assert.equal(targetSet.candidates.length, 2);
  assert.equal(targetSet.closureProven, false);
  assert.equal(targetSet.reason, 'exact-class-slot-not-single-target');
});

test('an unresolved exact-class slot fails closed', async () => {
  const synthetic = { rttiPresent: true, classes: [syntheticRecord('Widget', 0x1000n, [0x11n, 0x12n, null])] };
  const targetSet = resolveVirtualTargetSet({
    classEvidence: synthetic,
    receiverClass: 'Widget',
    slotIndex: 2,
    dynamicClassProven: true,
    closureAuthority: { rule: 'exact-object-definition', callSiteId: 'synthetic-2' },
  });
  assert.equal(targetSet.closureProven, false);
  assert.equal(targetSet.reason, 'exact-class-slot-unresolved');
  assert.equal(targetSet.completeness, 'partial');
});

test('a binary without RTTI reports a partial target set with an explicit reason', FIXTURE_OPTIONS, async () => {
  const report = await evidence(NO_RTTI);
  const targetSet = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: TAKE_DAMAGE_SLOT,
  });

  assert.equal(targetSet.rttiPresent, false);
  assert.deepEqual(targetSet.derivedClasses, [], 'derived classes cannot be enumerated without RTTI');
  assert.equal(targetSet.completeness, 'partial');
  assert.equal(targetSet.reason, 'rtti-absent-derived-classes-unknown');
  assert.equal(targetSet.candidates.length, 1);
  assert.equal(targetSet.closureProven, false);
});

test('an unknown receiver class yields no candidates and no invented evidence', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  const targetSet = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'NotAClass',
    slotIndex: 0,
  });
  assert.equal(targetSet.candidates.length, 0);
  assert.equal(targetSet.completeness, 'unknown');
  assert.equal(targetSet.reason, 'receiver-class-not-in-evidence');
});

test('a slot outside the vtable yields no candidates', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  const targetSet = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: 99,
  });
  assert.equal(targetSet.candidates.length, 0);
  assert.equal(targetSet.completeness, 'unknown');
  assert.equal(targetSet.reason, 'no-slot-evidence');
});

test('resolved target sets project into canonical virtual-slot evidence', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);

  const multi = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Entity',
    slotIndex: TAKE_DAMAGE_SLOT,
  });
  const multiEvidence = virtualSlotEvidenceFor({
    targetSet: multi,
    callSiteId: 'site-multi',
    receiverValueId: 'this-1',
    vptrValueId: 'vptr-1',
  });
  assert.ok(isCanonicalCppVirtualSlotEvidence(multiEvidence));
  assert.equal(multiEvidence.schema, 'cpp-virtual-slot-evidence/v1');
  assert.equal(multiEvidence.virtualSlotKnown, true);
  assert.equal(multiEvidence.candidateTargetIds.length, 3);
  assert.equal(multiEvidence.closureProven, false);
  assert.equal(multiEvidence.exactTargetKnown, false);

  const closed = resolveVirtualTargetSet({
    classEvidence: report,
    receiverClass: 'Player',
    slotIndex: TAKE_DAMAGE_SLOT,
    dynamicClassProven: true,
    closureAuthority: { rule: 'constructor-vtable-store', callSiteId: 'site-closed' },
  });
  const closedEvidence = virtualSlotEvidenceFor({
    targetSet: closed,
    callSiteId: 'site-closed',
    receiverValueId: 'this-2',
    vptrValueId: 'vptr-2',
  });
  assert.equal(closedEvidence.closureProven, true);
  assert.equal(closedEvidence.exactTargetKnown, true);
  assert.equal(closedEvidence.exactTargetAddress, closed.candidateAddresses[0]);
  assert.equal(closedEvidence.slotByteOffset, TAKE_DAMAGE_SLOT * 8);
});

test('a single unresolved candidate is never promoted to an exact target', async () => {
  const synthetic = { rttiPresent: true, classes: [syntheticRecord('Solo', 0x2000n, [0x51n, 0x52n, null])] };
  const targetSet = resolveVirtualTargetSet({ classEvidence: synthetic, receiverClass: 'Solo', slotIndex: 2 });
  assert.equal(targetSet.candidates.length, 1);
  assert.equal(targetSet.candidates[0].unresolved, true);
  assert.equal(targetSet.completeness, 'partial');
  assert.equal(targetSet.reason, 'slot-target-unresolved');

  const slotEvidence = virtualSlotEvidenceFor({
    targetSet,
    callSiteId: 'solo',
    receiverValueId: 'this',
    vptrValueId: 'vptr',
  });
  assert.equal(slotEvidence.candidateTargetIds.length, 0);
  assert.equal(slotEvidence.exactTargetKnown, false);
});

test('invalid call-site inputs are rejected', FIXTURE_OPTIONS, async () => {
  const report = await evidence(RTTI);
  assert.throws(() => resolveVirtualTargetSet({ classEvidence: report, receiverClass: 'Player', slotIndex: -1 }),
    /slot-index-invalid/);
  assert.throws(() => resolveVirtualTargetSet({ classEvidence: report, receiverClass: '', slotIndex: 0 }),
    /receiver-class-required/);
});
