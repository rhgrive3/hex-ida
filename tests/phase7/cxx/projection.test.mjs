// Focused regressions for the C++ evidence projection seam
// (`js/analysis/cxx/project.js`).
//
// These run against the real compiler-produced ARM64 fixtures: the class
// identity, vtable membership and slot targets all come from the ELF, and the
// only test-supplied input is the IR binding that names which SSA value is the
// receiver.
//
// The properties under test are the ones that make the seam safe to call from a
// synchronous analysis entrypoint:
//   - nothing is projected before the slice index is built (fail closed),
//   - a function with no positive non-static member proof projects nothing,
//   - a slice with no C++ family costs zero reads,
//   - a non-canonical look-alike can never be laundered into `this`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCxxEvidenceProvider,
  isCxxEvidenceProvider,
  normalizeCxxEvidenceInput,
} from '../../../js/analysis/cxx/project.js';
import {
  createCppVirtualSlotEvidence,
  isCanonicalCppReceiverEvidence,
  isCanonicalCppVirtualSlotEvidence,
} from '../../../js/analysis/cxx/object-evidence.js';
import { SymbolIndex } from '../../../js/symbols.js';
import { openCxxFixture } from './fixtures/open.mjs';

const RTTI_FIXTURE = 'game-rtti-o0';
const NO_RTTI_FIXTURE = 'game-nortti-o2';

function symbolAddress(probe, name) {
  for (let index = 0; index < probe.symbols.names.length; index++) {
    if (probe.symbols.names[index] === name) return probe.symbols.addrs[index];
  }
  return null;
}

function providerFor(probe, overrides = {}) {
  return createCxxEvidenceProvider({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    architecture: 'arm64',
    snapshotId: `fixture:${probe.name}`,
    ...overrides,
  });
}

// The receiver binding is the only thing the IR contributes to this seam. The
// class, the vtable and the slot targets all come from the fixture.
function receiverIr(valueId = 'arg0') {
  return {
    values: [{ id: valueId, kind: 'arg', reg: 'x0', bits: 64 }],
    instructions: [],
  };
}

async function rttiProbe() {
  const probe = openCxxFixture(RTTI_FIXTURE);
  assert.equal(probe.available, true, probe.reason ?? 'fixture unavailable');
  return probe;
}

test('nothing is projected before the slice index is built', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);

  assert.equal(provider.stats().ready, false);
  assert.equal(provider.classEvidence(), null);
  assert.equal(provider.projectForFunction({
    functionId: 'sub_0',
    functionAddress: symbolAddress(probe, '_ZN6Player10takeDamageEi'),
    ir: receiverIr(),
  }), null, 'a not-yet-built index must project nothing rather than guess');
  assert.deepEqual(provider.stats(), {
    ready: false, builds: 0, projections: 0, provided: 0, unproven: 0,
    classes: 0, vtables: 0, slots: 0, reads: 0,
  });
});

test('a proven virtual member projects a canonical receiver and its vtable slots', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  const stats = provider.stats();
  assert.equal(stats.ready, true);
  assert.equal(stats.builds, 1);
  assert.equal(stats.classes, 3, 'Entity/Actor/Player');
  assert.equal(stats.reads > 0, true, 'vtable reads are bounded but non-zero');

  const address = symbolAddress(probe, '_ZN6Player10takeDamageEi');
  assert.notEqual(address, null, 'fixture must export Player::takeDamage');

  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: address,
    functionName: '_ZN6Player10takeDamageEi',
    ir: receiverIr(),
  });

  assert.ok(projection, 'a vtable member must project evidence');
  assert.equal(projection.schema, 'cpp-evidence-projection/v1');
  assert.equal(projection.status, 'verified-cpp-object');

  const receiver = projection.receiver;
  assert.equal(isCanonicalCppReceiverEvidence(receiver), true);
  assert.equal(receiver.receiverRole, 'this');
  assert.equal(receiver.completeness, 'complete');
  assert.equal(receiver.uncertainty, null);
  assert.equal(receiver.abiBinding.argumentIndex, 0);
  assert.equal(receiver.abiBinding.register, 'x0');
  assert.equal(receiver.canonicalValueId, 'arg0');
  assert.equal(receiver.classIdentity.className, 'Player');
  assert.equal(receiver.classIdentity.isAnonymous, false);
  assert.equal(receiver.nonStaticProof.source, 'vtable-membership');

  for (const slot of projection.virtualSlots) {
    assert.equal(isCanonicalCppVirtualSlotEvidence(slot), true);
    assert.equal(slot.virtualSlotKnown, true);
    // No call-site closure authority was supplied, so no exact target may exist.
    assert.equal(slot.exactTargetKnown, false);
    assert.equal(slot.exactTargetAddress, null);
  }
});

test('a constructor projects evidence from symbol syntax without a vtable slot', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  const name = '_ZN6PlayerC1Ev';
  const address = symbolAddress(probe, name) ?? symbolAddress(probe, '_ZN6PlayerC2Ev');
  assert.notEqual(address, null);

  const projection = provider.projectForFunction({
    functionId: 'fn:player-ctor',
    functionAddress: address,
    functionName: name,
    ir: receiverIr(),
  });

  assert.ok(projection);
  assert.equal(projection.receiver.nonStaticProof.source, 'symbol-syntax');
  assert.equal(projection.receiver.nonStaticProof.rule, 'constructor-has-this');
});

test('a free function taking an object pointer projects nothing', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  const address = symbolAddress(probe, '_Z10readHealthP6Entity');
  assert.notEqual(address, null, 'fixture must export readHealth');

  assert.equal(provider.projectForFunction({
    functionId: 'fn:read-health',
    functionAddress: address,
    functionName: '_Z10readHealthP6Entity',
    ir: receiverIr(),
  }), null, 'x0 alone is never `this`');
  assert.equal(provider.stats().unproven >= 1, true);
});

test('a proven member with no receiver binding in the IR projects nothing', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  assert.equal(provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddress(probe, '_ZN6Player10takeDamageEi'),
    functionName: '_ZN6Player10takeDamageEi',
    ir: { values: [], instructions: [] },
  }), null, 'no canonical arg-0 value means no provable receiver');
});

test('an anonymous class keeps a null name instead of a fabricated one', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  const report = provider.classEvidence();
  assert.equal(report.rttiPresent, true);
  for (const record of report.classes) {
    if (record.className == null) continue;
    assert.equal(typeof record.nameSource, 'string');
    assert.match(record.nameSource, /^(rtti-|vtable-symbol)/);
  }
  // Every name the producer emits is traceable to RTTI or to a `_ZTV` symbol.
  const names = report.classes.map((record) => record.className).filter(Boolean).sort();
  assert.deepEqual(names, ['Actor', 'Entity', 'Player']);
});

test('without RTTI the name comes from the vtable symbol and no inheritance is claimed', async () => {
  const probe = openCxxFixture(NO_RTTI_FIXTURE);
  assert.equal(probe.available, true, probe.reason ?? 'fixture unavailable');
  const provider = providerFor(probe);
  await provider.build();

  const report = provider.classEvidence();
  assert.equal(report.rttiPresent, false);
  for (const record of report.classes) {
    assert.equal(record.typeinfoAddress, null);
    assert.deepEqual([...record.bases], []);
    if (record.className) assert.equal(record.nameSource, 'vtable-symbol');
  }

  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddress(probe, '_ZN6Player10takeDamageEi'),
    functionName: '_ZN6Player10takeDamageEi',
    ir: receiverIr(),
  });
  assert.ok(projection);
  assert.equal(projection.receiver.classIdentity.className, 'Player');
});

test('a slice without any C++ symbol costs zero reads and projects nothing', async () => {
  const symbols = new SymbolIndex({
    addrs: [0x1000n, 0x1100n],
    names: ['_start', 'main'],
    kinds: [0, 0],
    flags: [0, 0],
  });
  let reads = 0;
  const provider = createCxxEvidenceProvider({
    symbols,
    read: async () => { reads++; return null; },
    architecture: 'arm64',
    snapshotId: 'fixture:c-only',
  });

  const index = await provider.build();
  assert.equal(index.empty, true);
  assert.equal(reads, 0, 'the mangled-name prefilter must avoid every read');
  assert.equal(provider.projectForFunction({
    functionId: 'sub_1000', functionAddress: 0x1000n, ir: receiverIr(),
  }), null);
  assert.equal(provider.stats().classes, 0);
  assert.equal(provider.stats().reads, 0);
});

test('build is idempotent and concurrent callers share one index', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);

  const [first, second] = await Promise.all([provider.build(), provider.build()]);
  const third = await provider.build();
  assert.equal(provider.stats().builds, 1, 'one build per provider');
  assert.equal(provider.stats().classes, 3);
  assert.equal(second, first, 'concurrent callers resolve to one index');
  assert.equal(third, first, 'a rebuilt request reuses the resolved index');
});

test('only a provider issued in this process is recognised', async () => {
  const probe = await rttiProbe();
  const real = providerFor(probe);
  assert.equal(isCxxEvidenceProvider(real), true);
  assert.equal(isCxxEvidenceProvider({ projectForFunction() {} }), false);
  assert.equal(isCxxEvidenceProvider(null), false);
  // Freezing must not lose identity, or the seam would stop recognising it.
  assert.equal(Object.isFrozen(real), true);
});

test('the consumer gate drops look-alike evidence and keeps canonical evidence', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();
  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddress(probe, '_ZN6Player10takeDamageEi'),
    functionName: '_ZN6Player10takeDamageEi',
    ir: receiverIr(),
  });
  assert.ok(projection);

  const accepted = normalizeCxxEvidenceInput(projection);
  assert.ok(accepted);
  assert.equal(accepted.receiver, projection.receiver);
  assert.equal(accepted.virtualSlots.length, projection.virtualSlots.length);

  // A structural clone is not canonical evidence, however correct it looks.
  assert.equal(
    normalizeCxxEvidenceInput({ receiver: { ...projection.receiver }, virtualSlots: [] }),
    null,
    'a cloned receiver is not authority',
  );

  assert.equal(normalizeCxxEvidenceInput(null), null);
  assert.equal(normalizeCxxEvidenceInput({ receiver: {} }), null);
  assert.equal(normalizeCxxEvidenceInput({ receiver: { receiverRole: 'this' } }), null);
  assert.equal(normalizeCxxEvidenceInput({ virtualSlots: [{ virtualSlotKnown: true }] }), null);
});

test('non-canonical slots never enter the accepted contract', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();
  const projection = provider.projectForFunction({
    functionId: 'fn:player-take-damage',
    functionAddress: symbolAddress(probe, '_ZN6Player10takeDamageEi'),
    functionName: '_ZN6Player10takeDamageEi',
    ir: receiverIr(),
  });
  assert.ok(projection);
  // `Player::takeDamage` performs no indirect dispatch itself, so a receiver
  // projection with no slots is the correct answer here, not a missing one.
  assert.deepEqual([...projection.virtualSlots], []);

  // A canonically-issued slot is a control input: the gate must keep it and
  // drop the look-alikes around it.
  const canonicalSlot = createCppVirtualSlotEvidence({
    callSiteId: 'call:1',
    receiverValueId: 'arg0',
    vptrValueId: 'vptr0',
    slotIndex: 1,
    slotByteOffset: 16,
    pointerBytes: 8,
    virtualSlotKnown: true,
    closureProven: false,
    candidateTargetIds: [],
    reason: 'canonical-vtable-slot-load',
  });

  const accepted = normalizeCxxEvidenceInput({
    receiver: projection.receiver,
    virtualSlots: [canonicalSlot, { callSiteId: 'forged' }, null],
  });
  assert.ok(accepted);
  assert.deepEqual([...accepted.virtualSlots], [canonicalSlot]);

  // Forged slots alone are not evidence of anything.
  assert.equal(normalizeCxxEvidenceInput({ virtualSlots: [{ callSiteId: 'forged' }] }), null);
});

test('a vtable that does not reference the address is never attached', async () => {
  const probe = await rttiProbe();
  const provider = providerFor(probe);
  await provider.build();

  // `readHealth` is a free function, so it belongs to no vtable. The seam must
  // not fall back to "some class" merely because classes exist.
  const address = symbolAddress(probe, '_Z10readHealthP6Entity');
  const projection = provider.projectForFunction({
    functionId: 'fn:read-health',
    functionAddress: address,
    functionName: '_Z10readHealthP6Entity',
    ir: receiverIr(),
  });
  assert.equal(projection, null);
});
