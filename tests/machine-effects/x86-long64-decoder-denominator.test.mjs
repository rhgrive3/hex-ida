import assert from 'node:assert/strict';

import {
  X86_DECODED_INSTRUCTION_CONTRACT_VERSION,
  X86_DECODER_SEMANTIC_VERSION,
  createX86DecodedInstruction,
} from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects, liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  buildX86CapstoneRegistryEvidence,
  verifyX86CapstoneRegistryEvidence,
} from '../../tools/validation/machine-effects/x86-capstone-registry.mjs';
import { x86Long64LeaDenominatorIdentity } from '../../tools/validation/machine-effects/x86-long64-lea-denominator.mjs';
import {
  X86_LONG64_DECODER_WITNESSES,
} from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import {
  X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS,
  analyzeX86Long64ValidEncodingOwnership,
  assertX86Long64FallbackNegativeProof,
  assertX86Long64ValidEncodingOwnership,
  bytesFromX86Long64WitnessHex,
  classifyX86Long64WitnessPrefix,
  verifyX86Long64DecoderDenominatorFixture,
  x86Long64DecoderDenominatorIdentity,
  x86Long64FallbackEligibilityForRegistryRow,
  x86Long64FallbackNegativeProof,
} from '../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs';

const identity = x86Long64DecoderDenominatorIdentity();
assert.equal(identity.decoderContractVersion, X86_DECODED_INSTRUCTION_CONTRACT_VERSION);
assert.equal(identity.semanticVersion, X86_DECODER_SEMANTIC_VERSION);
assert.equal(identity.registryInstructionCount, 1523);
assert.equal(identity.validLong64InstructionIdCount, 1487);
assert.equal(identity.explicitOutOfProfileRegistryIdCount, 36);
assert.equal(identity.modeInvalidOrRepurposedCount, 19);
assert.equal(identity.prefixTokenCount, 7);
assert.equal(identity.nonemittingAliasCount, 10);
assert.equal(identity.validLong64InstructionIdCount + identity.explicitOutOfProfileRegistryIdCount, identity.registryInstructionCount);
assert.equal(identity.modrmSibSubproof.encodingCaseCount, 302976);
assert.equal(identity.modrmSibSubproof.denominatorId, x86Long64LeaDenominatorIdentity().denominatorId);
assert.match(identity.denominatorMethod, /production effect registries are not an enumeration oracle/);

const session = await createCapstoneX86Session();
const decodedRows = [];
try {
  const registry = buildX86CapstoneRegistryEvidence(session.instructionName);
  verifyX86CapstoneRegistryEvidence(registry);
  assert.equal(verifyX86Long64DecoderDenominatorFixture(registry), true);

  // Replay every independently frozen instruction-identity witness through the
  // production Capstone bridge with detail enabled. A valid witness must decode
  // exactly once, consume all bytes, preserve its registry identity, and expose
  // the structured facts required by semantic family owners.
  for (const [id,name,hex] of X86_LONG64_DECODER_WITNESSES) {
    const bytes = bytesFromX86Long64WitnessHex(hex);
    const decoded = session.decode(bytes, 0x100000n + BigInt(id) * 0x20n);
    assert.equal(decoded.length, 1, `valid long-64 witness did not decode exactly once: ${id}:${name}:${hex}`);
    const item = decoded[0];
    assert.equal(item.length, bytes.length, `valid long-64 witness not fully consumed: ${id}:${name}:${hex}`);
    assert.equal(item.instructionCode, id, `instruction id drift: ${id}:${name}:${hex}`);
    assert.equal(item.instructionFamily, name, `instruction name drift: ${id}:${name}:${hex}`);
    assert.equal(item.detailAvailable, true, `structured detail missing: ${id}:${name}`);
    assert.equal(item.detailStatus, 'complete', `structured detail incomplete: ${id}:${name}`);
    assert.ok(item.detail.addressSizeBits === 32 || item.detail.addressSizeBits === 64, `long-mode address size escaped profile: ${id}:${name}`);
    assert.equal(item.detail.operandCount, item.detail.operands.length, `operand-count drift: ${id}:${name}`);
    assert.ok(Array.isArray(item.detail.implicitReads), `implicit read set missing: ${id}:${name}`);
    assert.ok(Array.isArray(item.detail.implicitWrites), `implicit write set missing: ${id}:${name}`);
    const instruction = createX86DecodedInstruction({ ...item, instructionId:`x86-decoder-denominator:${id}` });
    assert.equal(instruction.contractVersion, identity.decoderContractVersion);
    assert.equal(instruction.decoderSemanticVersion, identity.semanticVersion);
    decodedRows.push(Object.freeze({ id, name, hex, instruction }));
  }
  assert.equal(decodedRows.length, identity.validLong64InstructionIdCount);

  // The all-mode registry is not silently treated as valid long mode. Its 36
  // non-emitting IDs are an exact, named partition: legacy-mode-only or
  // repurposed semantics, standalone prefix tokens, and aliases/superclasses
  // that the deployed long-mode decoder canonicalizes to other emitted IDs.
  const witnessIds = new Set(decodedRows.map(({ id }) => id));
  assert.equal(X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS.length, 36);
  for (const row of X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS) {
    assert.equal(witnessIds.has(row.id), false, `out-of-profile registry row emitted as valid witness: ${row.id}:${row.name}`);
    assert.deepEqual(x86Long64FallbackEligibilityForRegistryRow(row.id), { class:'out-of-profile', reason:row.reason });
  }
  for (const { id, name } of decodedRows) {
    assert.equal(x86Long64FallbackEligibilityForRegistryRow(id), null, `valid instruction was fallback-eligible: ${id}:${name}`);
  }

  // Representative legacy-only encodings are invalid in long mode. Other
  // legacy registry semantics are repurposed by long mode and must decode to
  // the long-mode canonical identity rather than the old instruction ID.
  for (const hex of ['37','d50a','d40a','3f','27','2f','ce','60','61','d6']) {
    assert.equal(session.decode(bytesFromX86Long64WitnessHex(hex), 0x2000n).length, 0, `mode-invalid encoding accepted: ${hex}`);
  }
  const repurposed = [
    ['63c0',493,'movsxd'], ['9c',614,'pushfq'], ['9d',591,'popfq'],
    ['e300',271,'jrcxz'], ['67e300',259,'jecxz'],
  ];
  for (const [hex,id,name] of repurposed) {
    const decoded = session.decode(bytesFromX86Long64WitnessHex(hex), 0x2100n);
    assert.equal(decoded.length, 1, `repurposed long-mode encoding rejected: ${hex}`);
    assert.equal(decoded[0].instructionCode, id);
    assert.equal(decoded[0].instructionFamily, name);
  }

  // Prefix tokens alone and truncated vector-prefix forms are invalid rather
  // than a hidden unsupported family eligible for fallback.
  for (const hex of ['f0','f2','f3','48','c5','c400','62000000']) {
    assert.equal(session.decode(bytesFromX86Long64WitnessHex(hex), 0x2200n).length, 0, `truncated/reserved prefix form decoded: ${hex}`);
  }

  // Every legacy prefix class is exercised on a legal long-mode instruction.
  // LOCK gets a lockable RMW form; REP/REPNE get string forms; segment, address
  // and operand-size overrides get scalar witnesses.
  const legacyPrefixCases = [
    ['f0','f00118'], ['f2','f2ae'], ['f3','f3a4'],
    ['2e','2e8b00'], ['36','368b00'], ['3e','3e8b00'], ['26','268b00'], ['64','648b00'], ['65','658b00'],
    ['66','6689d8'], ['67','678b00'],
  ];
  for (const [prefixHex,hex] of legacyPrefixCases) {
    const prefix = Number.parseInt(prefixHex,16);
    const [decoded] = session.decode(bytesFromX86Long64WitnessHex(hex), 0x2300n);
    assert.ok(decoded, `legal legacy prefix rejected: ${hex}`);
    assert.ok(decoded.detail.prefixes.legacy.includes(prefix), `legacy prefix omitted from structured detail: ${hex}`);
    assert.equal(x86Long64FallbackEligibilityForRegistryRow(decoded.instructionCode), null, `prefixed valid instruction became fallback-eligible: ${hex}`);
  }

  // All 16 REX bytes are legal discriminator states for this register-register
  // MOV witness. REX.W changes operand width; R/X/B extend register selectors.
  for (let rex = 0x40; rex <= 0x4f; rex++) {
    const bytes = Uint8Array.of(rex,0x89,0xc0);
    const [decoded] = session.decode(bytes, 0x2400n + BigInt(rex));
    assert.ok(decoded, `REX discriminator rejected: ${rex.toString(16)}`);
    assert.equal(decoded.instructionFamily, 'mov');
    assert.equal(decoded.detail.prefixes.rex, rex);
  }

  // The witness quotient must contain every prefix grammar used in the locked
  // decoder. XOP is deliberately recognized by this independent grammar even
  // though capstone-structured.js only labels VEX2/VEX3/EVEX vector prefixes.
  const prefixKinds = new Map();
  for (const [, ,hex] of X86_LONG64_DECODER_WITNESSES) {
    const kind = classifyX86Long64WitnessPrefix(bytesFromX86Long64WitnessHex(hex));
    prefixKinds.set(kind,(prefixKinds.get(kind) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(prefixKinds), identity.witnessPrefixKindCounts);
  for (const kind of ['vex2','vex3','evex','xop','3dnow']) {
    const witness = X86_LONG64_DECODER_WITNESSES.find(([, ,hex]) => classifyX86Long64WitnessPrefix(bytesFromX86Long64WitnessHex(hex)) === kind);
    assert.ok(witness, `missing prefix-kind witness: ${kind}`);
    const [decoded] = session.decode(bytesFromX86Long64WitnessHex(witness[2]), 0x2500n);
    assert.ok(decoded);
    if (kind === 'vex2' || kind === 'vex3' || kind === 'evex') assert.equal(decoded.detail.prefixes.vector?.kind, kind);
    if (kind === 'xop') assert.equal(decoded.detail.prefixes.vector, null, 'XOP must not be laundered as an unverified VEX prefix');
  }

  // Immediate predicate bytes encode aliases/sub-operations rather than an
  // unsupported family. Exhaustively sweep the 8-bit predicate for a legacy
  // compare and a VEX compare; every valid decode must land in the denominator.
  for (const stem of [Uint8Array.of(0x0f,0xc2,0xc0), Uint8Array.of(0xc5,0xf8,0xc2,0xc0)]) {
    for (let immediate = 0; immediate < 256; immediate++) {
      const bytes = Uint8Array.from([...stem,immediate]);
      const decoded = session.decode(bytes, 0x2600n + BigInt(immediate));
      assert.equal(decoded.length, 1, `compare predicate rejected: ${Buffer.from(bytes).toString('hex')}`);
      assert.ok(witnessIds.has(decoded[0].instructionCode), `compare predicate escaped denominator: ${decoded[0].instructionCode}:${decoded[0].instructionFamily}`);
    }
  }
  for (let immediate = 0; immediate < 8; immediate++) {
    for (const stem of [Uint8Array.of(0x62,0xf3,0x6d,0x48,0x1f,0xcb), Uint8Array.of(0x8f,0xe8,0x78,0xcc,0xc0)]) {
      const bytes = Uint8Array.from([...stem,immediate]);
      const decoded = session.decode(bytes, 0x2700n + BigInt(immediate));
      assert.equal(decoded.length, 1, `vector predicate rejected: ${Buffer.from(bytes).toString('hex')}`);
      assert.ok(witnessIds.has(decoded[0].instructionCode), `vector predicate escaped denominator: ${decoded[0].instructionCode}:${decoded[0].instructionFamily}`);
    }
  }

  // Ownership is evaluated using canonical dispatch-owner tracing.
  const ownership = analyzeX86Long64ValidEncodingOwnership(decodedRows, dispatchX86MachineEffects);
  assert.equal(ownership.validEncodingCount, identity.validLong64InstructionIdCount);
  assert.equal(ownership.ownedCount + ownership.unownedCount + ownership.invalidOwnerCount, ownership.validEncodingCount);
  assert.equal(ownership.invalidOwnerCount, 0);

  // Mutation resistance: mutating metadata.family must NOT change canonical ownership tracing
  const poisonedDispatcher = (instruction) => {
    const outcome = dispatchX86MachineEffects(instruction);
    if (outcome.result) {
      // Simulate poison metadata
      return { ownerId: outcome.ownerId, result: { ...outcome.result, metadata: { ...outcome.result.metadata, family: 'poison-mutated' } } };
    }
    return outcome;
  };
  const poisonedOwnership = analyzeX86Long64ValidEncodingOwnership(decodedRows, poisonedDispatcher);
  assert.deepEqual(poisonedOwnership.ownerCounts, ownership.ownerCounts);
  assert.equal(poisonedOwnership.ownedCount, ownership.ownedCount);

  const fallbackProof = x86Long64FallbackNegativeProof(ownership);
  assert.equal(fallbackProof.validEncodingFallbackEligibleCount, 0);
  assert.equal(fallbackProof.validEncodingWithoutOwnerCount, ownership.unownedCount);
  if (ownership.unownedCount) {
    assert.throws(() => assertX86Long64ValidEncodingOwnership(ownership), /x86-long64-valid-encoding-unowned/);
    assert.throws(() => assertX86Long64FallbackNegativeProof(ownership), /x86-long64-fallback-laundering-valid-encoding/);
  } else {
    assert.equal(assertX86Long64ValidEncodingOwnership(ownership), true);
    assert.equal(assertX86Long64FallbackNegativeProof(ownership), true);
  }

  console.log(JSON.stringify({
    denominatorId:identity.denominatorId,
    validLong64InstructionIds:decodedRows.length,
    explicitOutOfProfileRegistryIds:identity.explicitOutOfProfileRegistryIdCount,
    ownership:{ owned:ownership.ownedCount, unowned:ownership.unownedCount, ownerCounts:ownership.ownerCounts, metadataLabelCounts:ownership.metadataLabelCounts },
    firstUnowned:ownership.unowned.slice(0,12),
  }));
} finally {
  session.close();
}

console.log('x86 long-64 decoder denominator / ownership / fallback-negative proof: PASS');
