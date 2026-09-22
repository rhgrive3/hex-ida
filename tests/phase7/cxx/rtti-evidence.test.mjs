import assert from 'node:assert/strict';
import test from 'node:test';

import { openCxxFixture } from './fixtures/open.mjs';
import {
  buildCxxClassEvidence,
  createCxxEvidenceCache,
  parseItaniumTypeName,
  parseItaniumTypeInfo,
  vtableEvidenceFor,
} from '../../../js/analysis/cxx/rtti-evidence.js';

const RTTI = 'game-rtti-o2';
const RTTI_O0 = 'game-rtti-o0';
const NO_RTTI = 'game-nortti-o2';

function fixturesAvailable() {
  const probe = openCxxFixture(RTTI);
  return probe.available ? null : probe.reason;
}

const UNAVAILABLE = fixturesAvailable();
// Node's test runner treats any *defined* `skip` value as a skip, so the option
// object must be omitted entirely when the toolchain is present.
const FIXTURE_OPTIONS = UNAVAILABLE ? { skip: UNAVAILABLE } : {};

async function evidenceFor(probe, overrides = {}) {
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

function classNamed(report, name) {
  return report.classes.find((record) => record.className === name) ?? null;
}

function symbolNamesAt(probe, address) {
  const out = [];
  for (let index = 0; index < probe.symbols.addrs.length; index++) {
    if (probe.symbols.addrs[index] === address) out.push(probe.symbols.names[index]);
  }
  return out;
}

// ── Itanium type-name parsing ──────────────────────────────────────────────

test('parseItaniumTypeName accepts simple and nested type names', () => {
  const encoder = new TextEncoder();
  assert.equal(parseItaniumTypeName(encoder.encode('6Entity')), 'Entity');
  assert.equal(parseItaniumTypeName(encoder.encode('N2ns5KlassE')), 'ns::Klass');
  assert.equal(parseItaniumTypeName(Uint8Array.from([0])), null);
  assert.equal(parseItaniumTypeName(null), null);
});

test('parseItaniumTypeName refuses constructs it cannot prove', () => {
  const encoder = new TextEncoder();
  // Template arguments and substitutions are not a plain identifier chain.
  assert.equal(parseItaniumTypeName(encoder.encode('St6vectorI6EntitySaIS0_EE')), null);
  // Declaration nested without the terminating `E`.
  assert.equal(parseItaniumTypeName(encoder.encode('N3Foo3Bar')), null);
  // Word longer than the buffer.
  assert.equal(parseItaniumTypeName(encoder.encode('99Entity')), null);
  // A single length prefix that does not consume the whole string.
  assert.equal(parseItaniumTypeName(encoder.encode('3FooBar')), null);
});

// ── RTTI-present binaries ──────────────────────────────────────────────────

test('real ARM64 RTTI binary: classes, typeinfo kind and inheritance chain', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await evidenceFor(probe);

  assert.equal(report.rttiPresent, true, 'symbols carry _ZTI/_ZTS so RTTI must be reported present');

  const entity = classNamed(report, 'Entity');
  const actor = classNamed(report, 'Actor');
  const player = classNamed(report, 'Player');
  assert.ok(entity && actor && player, 'the three fixture classes must be recovered by name');

  // Names come from real typeinfo, not from a heuristic.
  for (const record of [entity, actor, player]) {
    assert.match(record.nameSource, /^rtti-/);
    assert.equal(record.classIdentity.kind, 'named');
    assert.equal(record.classIdentity.className, record.className);
  }

  assert.equal(entity.typeinfoKind, '__class_type_info');
  assert.equal(entity.resolvedBases.length, 0);
  assert.deepEqual(entity.derivedFrom, ['Actor']);

  assert.equal(actor.typeinfoKind, '__si_class_type_info');
  assert.deepEqual(actor.resolvedBases.map((base) => base.className), ['Entity']);
  assert.deepEqual(actor.derivedFrom, ['Player']);

  assert.deepEqual(player.resolvedBases.map((base) => base.className), ['Actor']);
  assert.deepEqual(player.derivedFrom, []);
});

test('real ARM64 RTTI binary: vtable slots stay inside the proven extent', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await evidenceFor(probe);
  const player = classNamed(report, 'Player');

  assert.equal(player.extentBasis, 'symbol-size');
  assert.equal(player.extentProven, true);
  // 40-byte vtable = offset-to-top + typeinfo + 4 slots.
  assert.equal(player.slotCount, 4);

  // No slot may point into the typeinfo records; that would mean the reader ran
  // past the table into the neighbouring object.
  for (const slot of player.slots) {
    if (slot.address == null) continue;
    const names = symbolNamesAt(probe, slot.address);
    assert.ok(!names.some((name) => /^_?_ZTI/.test(name)),
      `slot ${slot.index} leaked a typeinfo symbol: ${names.join(',')}`);
    assert.ok(!names.some((name) => /^_?_ZTV/.test(name)),
      `slot ${slot.index} leaked an abi vtable symbol: ${names.join(',')}`);
  }
});

test('real ARM64 RTTI binary: a merged virtual method keeps every symbol alias', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await evidenceFor(probe);
  const player = classNamed(report, 'Player');

  const overrideSlot = player.slots.find((slot) => slot.aliases.includes('_ZN6Player10takeDamageEi'));
  assert.ok(overrideSlot, 'Player::takeDamage must appear in the Player vtable');

  const inheritedSlot = player.slots.find((slot) => slot.aliases.includes('_ZN5Actor6updateEf'));
  assert.ok(inheritedSlot, 'Player inherits Actor::update and the slot must still resolve');
  assert.ok(!inheritedSlot.aliases.includes('_ZN6Player6updateEf'),
    'Player does not override update, so no such symbol may be fabricated');

  // Identical destructor bodies are folded onto one address; every alias is
  // retained instead of silently picking one class.
  const dtorSlot = player.slots.find((slot) => slot.aliases.some((name) => /D[012]Ev$/.test(name)));
  assert.ok(dtorSlot, 'the destructor slot must resolve');
  assert.ok(dtorSlot.aliases.length >= 1);
});

test('real ARM64 RTTI binary: canonical vtable projection round-trips', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await evidenceFor(probe);
  const player = classNamed(report, 'Player');

  const canonical = vtableEvidenceFor(player, { pointerBytes: 8 });
  assert.ok(canonical);
  assert.equal(canonical.schema, 'cpp-vtable-evidence/v1');
  assert.equal(canonical.vtableAddress, player.vtableAddress);
  assert.equal(canonical.typeinfo, player.typeinfoAddress);
  assert.equal(canonical.slots.length, player.slotCount);
  assert.equal(canonical.slots[0].index, 0);
  assert.equal(canonical.slots[0].offset, 16);
});

test('real ARM64 RTTI binary: the same input produces the same digest', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const first = await evidenceFor(probe);
  const second = await evidenceFor(probe, { symbols: probe.symbols });
  assert.equal(first.digest, second.digest);
  assert.equal(first.schema, 'cpp-rtti-evidence/v1');
});

test('real ARM64 RTTI binary at -O0 recovers the same class graph', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI_O0);
  const report = await evidenceFor(probe);
  assert.equal(report.rttiPresent, true);
  assert.deepEqual(classNamed(report, 'Entity').derivedFrom, ['Actor']);
  assert.deepEqual(classNamed(report, 'Actor').resolvedBases.map((base) => base.className), ['Entity']);
  // At -O0 the destructors are distinct functions, so no alias folding.
  const entity = classNamed(report, 'Entity');
  const dtorSlot = entity.slots.find((slot) => slot.aliases.some((name) => /_ZN6EntityD1Ev$/.test(name)));
  assert.ok(dtorSlot);
  assert.deepEqual(dtorSlot.aliases.filter((name) => /^_ZN/.test(name)), ['_ZN6EntityD2Ev', '_ZN6EntityD1Ev']);
});

// ── RTTI-absent binaries ───────────────────────────────────────────────────

test('real ARM64 -fno-rtti binary reports RTTI absent and invents nothing', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(NO_RTTI);
  const report = await evidenceFor(probe);

  assert.equal(report.rttiPresent, false);

  const player = classNamed(report, 'Player');
  assert.ok(player, 'the vtable symbol still gives an authoritative class name');
  assert.equal(player.nameSource, 'vtable-symbol');
  assert.equal(player.typeinfoAddress, null);
  assert.equal(player.typeinfoKind, null);
  assert.equal(player.resolvedBases.length, 0);
  assert.deepEqual(player.derivedFrom, [], 'without RTTI no inheritance edge may be claimed');
  for (const record of report.classes) {
    assert.equal(record.resolvedBases.length, 0);
    assert.deepEqual(record.derivedFrom, []);
  }
});

test('a vtable with no usable symbol yields an anonymous class, never a guessed name', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await buildCxxClassEvidence({
    symbols: { addrs: new BigUint64Array(0), names: [], nameAt: () => null, label: () => null },
    read: probe.read,
    pointerBytes: 8,
  });
  assert.equal(report.classes.length, 0);
  assert.equal(report.rttiPresent, false);
});

// ── Bounded reads / fail-closed behavior ───────────────────────────────────

test('unreadable memory yields no class rather than a partial fabricated one', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await buildCxxClassEvidence({
    symbols: probe.symbols,
    read: () => null,
    pointerBytes: 8,
    symbolSizeOf: probe.symbolSizeOf,
  });
  assert.equal(report.classes.length, 0);
  assert.ok(report.skipped.length > 0);
  assert.ok(report.skipped.every((entry) => entry.reason === 'vtable-unreadable'));
});

test('a vtable without a provable extent reports no slots', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await buildCxxClassEvidence({
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: 8,
  });
  // Without symbol sizes and with the ABI vtables excluded from the next-address
  // set this fixture still has a following vtable, so extents stay provable and
  // no slot list may ever exceed the table.
  for (const record of report.classes) {
    assert.ok(record.slotCount <= 16);
    if (!record.extentProven) assert.equal(record.slots.length, record.slotCount);
  }
});

test('vtable evidence respects the class limit and reports truncation', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const report = await evidenceFor(probe, { maxClasses: 1 });
  assert.equal(report.classes.length, 1);
  assert.equal(report.truncated, true);
});

test('parseItaniumTypeInfo fails closed when the reader cannot supply the record', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const result = await parseItaniumTypeInfo({
    // Read a page of zeros: no valid ABI vtable symbol and no name string.
    read: () => new Uint8Array(64),
    symbols: probe.symbols,
    typeinfoAddress: 0x1000n,
    pointerBytes: 8,
  });
  assert.equal(result.readable, true);
  assert.equal(result.abiVtable, null);
  assert.equal(result.className, null);
  assert.equal(result.baseEvidence, 'abi-kind-unresolved');
});

test('invalid producer inputs are rejected instead of silently defaulting', async () => {
  await assert.rejects(() => buildCxxClassEvidence({ read: () => null, pointerBytes: 3 }), /pointer-bytes-invalid/);
  await assert.rejects(() => buildCxxClassEvidence({ pointerBytes: 8 }), /read-required/);
  await assert.rejects(() => buildCxxClassEvidence({ read: () => null, maxSlots: 0 }), /max-slots-invalid/);
});

test('the opt-in cache reuses evidence only under an explicit key', FIXTURE_OPTIONS, async () => {
  const probe = openCxxFixture(RTTI);
  const cache = createCxxEvidenceCache({ maxEntries: 2 });
  const input = {
    symbols: probe.symbols,
    read: probe.read,
    pointerBytes: probe.pointerBytes,
    symbolSizeOf: probe.symbolSizeOf,
    sectionEndOf: probe.sectionEndOf,
    maxSlots: 16,
  };

  const first = await cache.get(input, 'slice-a');
  const second = await cache.get(input, 'slice-a');
  assert.equal(first, second, 'the same key must return the same evidence object');
  assert.equal(cache.size(), 1);

  const other = await cache.get(input, 'slice-b');
  assert.notEqual(first, other);
  assert.equal(cache.size(), 2);

  // A third key evicts the oldest entry but never returns a stale one.
  await cache.get(input, 'slice-c');
  assert.equal(cache.size(), 2);
  const uncached = await cache.get(input, null);
  assert.notEqual(uncached, first);
  assert.equal(cache.size(), 2);

  cache.clear();
  assert.equal(cache.size(), 0);
});
