import test from 'node:test';
import assert from 'node:assert/strict';
import { stableDigest } from '../../../js/core/identity/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import {
  buildMemorySsa,
  MEMORY_SSA_BUILD_VERSION,
  isCanonicalMemorySsaProducerArtifact,
} from '../../../js/semantics/memoryssa/build.js';
import {
  forwardMemoryValue,
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  isCanonicalExactMemoryForwarding,
} from '../../../js/semantics/memoryssa/queries.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { buildExpressionForTesting } from '../../../js/decompiler/pipeline-core.js';
import { bitvector } from '../../../js/decompiler/phase8/bitvector.js';
import {
  factFromRange,
  fullRange,
  rangeOf,
  fullFact,
  singletonFact,
  evaluateBinaryFact,
  evaluateBinaryRange,
  contains,
  joinFacts,
  widenFacts,
} from '../../../js/decompiler/phase8/range.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { seedAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import { resolveStep } from '../../../js/decompiler/phase8/induction.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

// =============================================================================
// HEX-C2-01: Byte-Exact MemorySSA Forwarding Denominator
// =============================================================================
export const C2_01_WIDTHS = Object.freeze([8, 16, 32, 64, 128]);
export const C2_01_ENDIANS = Object.freeze(['little', 'big']);
export const C2_01_SCENARIOS = Object.freeze([
  'full',
  'split',
  'overwrite',
  'hole',
  'unknown-byte',
  'volatile-load',
  'atomic-load',
  'volatile-store',
  'atomic-store',
  'unknown-write',
  'unknown-call',
  'may-store',
]);
export const C2_01_TOTAL_CELLS = C2_01_WIDTHS.length * C2_01_ENDIANS.length * C2_01_SCENARIOS.length; // 120

const origin = id => ({ instructionIds: [`c2_${id}`] });
const bitType = widthBits => ({ kind: 'bitvector', widthBits });
const addressType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

function readBytes(bytes, endian) {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value |= BigInt(bytes[i]) << BigInt(8 * (endian === 'little' ? i : bytes.length - 1 - i));
  }
  return value;
}

function makeFixture(bits, endian, scenario) {
  const name = `c2-acceptance-${bits}-${endian}-${scenario}`;
  const count = bits / 8;
  const nodes = [];
  const values = [];
  const expected = Array.from({ length: count }, (_, i) => (0x91 + i * 37) & 255);

  const add = (id, kind, extra = {}) => {
    const node = { id, kind, blockId: 'b0', inputs: [], outputs: [], origin: origin(id), ...extra };
    nodes.push(node);
    return node;
  };

  const value = (id, type, definition, constant) => {
    const item = { id, kind: definition ? 'definition' : 'entry', machineType: type, origin: origin(id) };
    if (definition) {
      item.definitionNodeId = definition;
      item.sourceEntityId = definition;
    }
    if (constant !== undefined) {
      item.metadata = { constant: { kind: 'bitvector', widthBits: type.widthBits, value: constant } };
    }
    values.push(item);
    return id;
  };

  value('addr', addressType, 'n_addr');
  add('n_addr', 'address', { outputs: ['addr'], attributes: { value: '0x4000' } });

  const access = (widthBits, qualifiers = {}) => ({
    addressSpace: 'memory',
    addressExpr: { valueId: 'addr' },
    widthBits,
    endian,
    alignment: 1,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    faults: [],
    ...qualifiers,
  });

  const addressing = offset => ({
    machineEffects: { operationMetadata: { addressing: { addressDisplacement: String(offset) } } },
  });

  const store = (id, offset, bytes, { unknown = false, qualifiers = {} } = {}) => {
    const width = bytes.length * 8;
    const stored = readBytes(bytes, endian);
    const valueId = `value_${id}`;
    const definition = `const_${id}`;
    value(valueId, bitType(width), unknown ? null : definition, unknown ? undefined : stored);
    if (!unknown) add(definition, 'const', { outputs: [valueId], attributes: { value: stored } });
    add(id, 'store', { inputs: ['addr', valueId], memory: access(width, qualifiers), attributes: addressing(offset) });
  };

  if (scenario === 'split' || scenario === 'hole') {
    for (let i = 0; i < count - (scenario === 'hole' ? 1 : 0); i++) {
      store(`store_${i}`, i, [expected[i]]);
    }
  } else {
    store('store_full', 0, expected, {
      qualifiers:
        scenario === 'volatile-store'
          ? { volatility: true }
          : scenario === 'atomic-store'
            ? { atomic: true }
            : {},
    });
  }

  if (scenario === 'overwrite' || scenario === 'unknown-byte' || scenario === 'may-store') {
    const offset = Math.floor(count / 2);
    expected[offset] = 0x5e;
    store('store_override', offset, [expected[offset]], { unknown: scenario === 'unknown-byte' });
  }

  let partial = false;
  if (scenario === 'unknown-write') {
    partial = true;
    add('unknown_writer', 'unknown-memory-effect', {
      completeness: 'unknown',
      unknown: { reason: 'unresolved-writer', categories: ['memory'] },
    });
  }
  if (scenario === 'unknown-call') {
    partial = true;
    add('unknown_call', 'call', {
      completeness: 'unknown',
      unknown: { reason: 'unresolved-call', categories: ['memory'] },
      call: {
        targetValueIds: [],
        targetEntityIds: [],
        arguments: [],
        returns: [],
        stateReads: [],
        stateWrites: [],
        memoryRead: { scope: 'unknown' },
        memoryWrite: { scope: 'unknown' },
        controlEffects: [],
        determinism: 'unknown',
        noreturn: 'unknown',
        mayThrow: 'unknown',
        summarySource: 'fixture',
        completeness: 'unknown',
        unknownEffects: { reason: 'unresolved-call', categories: ['memory'] },
      },
    });
  }

  value('loaded', bitType(bits), 'n_load');
  add('n_load', 'load', {
    inputs: ['addr'],
    outputs: ['loaded'],
    memory: access(
      bits,
      scenario === 'volatile-load'
        ? { volatility: true }
        : scenario === 'atomic-load'
          ? { atomic: true }
          : {}
    ),
    attributes: addressing(0),
  });
  add('n_return', 'return', { inputs: ['loaded'] });

  const ir = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: name,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map(n => n.id), origin: origin('block') }],
    nodes,
    values,
    completeness: partial ? 'partial' : 'complete',
    unknowns: partial ? [{ reason: 'unresolved-memory', categories: ['memory'] }] : [],
    origin: origin(name),
  });
  const cfg = createSemanticCfg({ functionId: name, entryBlockId: 'b0', blocks: [{ id: 'b0', successors: [] }] });
  const region = createMemoryRegionRef({
    id: 'region',
    kind: 'global-absolute',
    binaryId: name,
    address: '0x4000',
    widthBits: bits,
    origin: origin('region'),
  });
  const digest = stableDigest(ir);
  const identity = {
    binaryId: name,
    sliceId: 'slice',
    functionId: name,
    semanticIrId: 'ir',
    scalarSsaId: 'ssa',
    memorySsaId: 'mssa',
    snapshotId: 'snapshot',
    semanticIrContractVersion: '2.0.0',
    semanticIrDigest: digest,
    scalarSsaBuildVersion: '1.0.0',
    scalarSsaDigest: 'fixture-ssa',
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: 'c2-fixture',
  };

  const artifact = buildMemorySsa(
    ir,
    cfg,
    {
      regions: [region],
      resolveRegion: () => region,
      queryAlias: (_left, _right, context) => {
        const may =
          scenario === 'may-store' &&
          [context.left, context.right].some(item => item.descriptor?.node?.id === 'store_override');
        return {
          relation: may ? 'may' : 'must',
          reasonCodes: [may ? 'overlapping-possible-store' : 'identical-region-identity'],
          evidenceIds: ['c2-canonical-alias'],
          proof: {
            analyzerId: 'phase7.alias.solver',
            analyzerVersion: '1.1.1',
            completeness: 'complete',
            stopReason: null,
          },
        };
      },
      identity,
      snapshotId: 'snapshot',
      canonicalIrIdentity: { functionId: name, semanticIrId: 'ir', semanticIrContractVersion: '2.0.0', semanticIrDigest: digest },
    }
  );

  return { name, ir, cfg, artifact, expected };
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------

test('C2-01 denominator is frozen to 120 cells across widths, endians, and clobber scenarios', () => {
  assert.equal(C2_01_WIDTHS.length, 5);
  assert.deepEqual(C2_01_WIDTHS, [8, 16, 32, 64, 128]);
  assert.equal(C2_01_ENDIANS.length, 2);
  assert.deepEqual(C2_01_ENDIANS, ['little', 'big']);
  assert.equal(C2_01_SCENARIOS.length, 12);
  assert.equal(C2_01_TOTAL_CELLS, 120);
});

test('C2-01 byte forwarding yields 30 exact numeric reconstructions and 90 safe fail-closed withholdings', () => {
  let exactCount = 0;
  let withheldCount = 0;

  for (const bits of C2_01_WIDTHS) {
    for (const endian of C2_01_ENDIANS) {
      for (const scenario of C2_01_SCENARIOS) {
        const { name, ir, cfg, artifact, expected } = makeFixture(bits, endian, scenario);
        assert.equal(isCanonicalMemorySsaProducerArtifact(artifact), true, name);

        const use = artifact.uses.find(u => u.sourceEntityId === 'n_load');
        assert.ok(use, name);

        const options = {
          functionId: ir.functionId,
          ir,
          cfg,
          consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
          purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
        };
        const direct = forwardMemoryValue(artifact, use.id, options);
        const projected = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: artifact, cfg });
        const load = projected.instructions.find(i => i.semanticNodeId === 'n_load');
        assert.ok(load, name);

        const isExactScenario = ['full', 'split', 'overwrite'].includes(scenario);
        if (isExactScenario) {
          exactCount++;
          assert.equal(direct.status, 'exact', `${name}: expected exact`);
          assert.deepEqual(direct.bytes, expected, name);
          assert.equal(direct.value, readBytes(expected, endian), name);
          assert.equal(direct.widthBits, bits);
          assert.equal(direct.proofKind, 'canonical-memoryssa-byte-forwarding');
          assert.equal(load.memoryForwarding?.status, 'exact', name);
          assert.equal(load.dst.const, direct.value, name);

          // Context and authority validation
          const context = canonicalMemoryForwardingContext(direct, {
            artifact,
            useId: use.id,
            sourceEntityId: 'n_load',
            nodeId: 'n_load',
            entityId: direct.loadEntityId,
            regionId: direct.loadRegionId,
            range: direct.loadRange,
            artifactDigest: artifact.canonicalDigest,
            snapshotId: artifact.snapshotId,
            consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
            purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
          });
          assert.equal(isCanonicalExactMemoryForwarding(direct, context), true);
          // Copied proof has no private authority
          assert.equal(isCanonicalExactMemoryForwarding(structuredClone(direct), context), false);
          // Stale snapshot has no authority
          assert.equal(isCanonicalExactMemoryForwarding(direct, { ...context, snapshotId: 'stale' }), false);
          // Copied producer has no private authority
          assert.notEqual(forwardMemoryValue(structuredClone(artifact), use.id, options).status, 'exact');

          // Expression consumer validation
          const expression = buildExpressionForTesting(load.dst, { ir: { ...projected, args: new Map() }, model: { calls: [] } });
          assert.equal(expression.kind, 'const', name);
          assert.equal(expression.value, direct.value, name);
        } else {
          withheldCount++;
          assert.notEqual(direct.status, 'exact', `${name}: non-exact must withhold`);
          assert.equal(load.dst.const, null, name);
          assert.notEqual(load.memoryForwarding?.status, 'exact', name);
        }
      }
    }
  }

  assert.equal(exactCount, 30, '30 exact numeric reconstructions');
  assert.equal(withheldCount, 90, '90 safe fail-closed withholdings');
});

test('C2-01 withdrawing canonical forwarding proof falls back to residual load', () => {
  const { ir, cfg, artifact } = makeFixture(32, 'little', 'full');
  const use = artifact.uses.find(u => u.sourceEntityId === 'n_load');
  const options = {
    functionId: ir.functionId,
    ir,
    cfg,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  };
  const direct = forwardMemoryValue(artifact, use.id, options);
  const projected = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: artifact, cfg });
  const load = projected.instructions.find(i => i.semanticNodeId === 'n_load');

  assert.equal(direct.status, 'exact');
  assert.equal(load.memoryForwarding?.status, 'exact');

  // Explicitly withdraw canonical forwarding proof while leaving structural link
  const unproved = { ...load.dst, const: null };
  unproved.def = {
    ...load,
    dst: unproved,
    memoryForwarding: { status: 'unknown', exact: false, completeness: 'unknown', reason: 'test-withdrawn-proof' },
  };
  const expr = buildExpressionForTesting(unproved, { ir: { ...projected, args: new Map() }, model: { calls: [] } });
  assert.equal(expr.kind, 'load');
});

test('C2-01 deterministic replay and AbortSignal cancellation', () => {
  const { ir, cfg, artifact } = makeFixture(64, 'little', 'split');
  const use = artifact.uses.find(u => u.sourceEntityId === 'n_load');
  const options = {
    functionId: ir.functionId,
    ir,
    cfg,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  };
  const first = forwardMemoryValue(artifact, use.id, options);
  const second = forwardMemoryValue(artifact, use.id, options);
  assert.deepEqual(first, second, 'deterministic replay must yield identical result');

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = forwardMemoryValue(artifact, use.id, { ...options, signal: aborted.signal });
  assert.equal(cancelled.status, 'cancelled');
});

// =============================================================================
// HEX-C2-02: Range, Known-Bits, Congruence, and Downstream Induction
// =============================================================================

const masked = (zero, one = 0n) => factFromRange(fullRange(8), { knownZero: zero, knownOne: one });
const c = n => singletonFact(bitvector(n, 8));

test('C2-02 bit mask algebra retains AND/OR/XOR and arithmetic shift properties', () => {
  const a = masked(0x80n, 1n), b = masked(0x40n, 2n);
  assert.equal(evaluateBinaryFact('and', a, b).knownZero & 0xc0n, 0xc0n);
  assert.equal(evaluateBinaryFact('or', a, b).knownOne & 3n, 3n);
  assert.equal(evaluateBinaryFact('xor', a, masked(1n, 0x80n)).knownOne & 0x81n, 0x81n);

  const ashr = evaluateBinaryFact('ashr', masked(0n, 0x80n), c(3n));
  assert.equal(ashr.knownOne & 0xf0n, 0xf0n);

  // Incompatible known bits prove inequality false
  assert.equal(evaluateBinaryFact('eq', masked(1n), masked(0n, 1n)).constant?.value, 0n);
  assert.equal(evaluateBinaryFact('ne', masked(1n), masked(0n, 1n)).constant?.value, 1n);
});

test('C2-02 SCCP pass publishes canonical range and bitmask facts for compound expressions', () => {
  const f = fixture('c2-sccp-acceptance');
  f.block(0);
  const x = f.opaque(8);
  const y = f.opaque(8);
  const a = f.binary('and', x, f.constant(252, 8), 8);
  const b = f.binary('and', y, f.constant(243, 8), 8);
  const z = f.binary('and', a, b, 8);
  f.ret(z);
  const ir = f.build();
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, { analysis: state, ir }, {});
  assert.equal(outcome.committed, true);

  const facts = state.get('ranges');
  const result = facts.facts?.get(z.id) ?? facts.values?.get(z.id) ?? facts.valueFacts?.get(z.id);
  assert.ok(result, 'canonical product fact must be published');
  assert.equal(result.knownZero & 15n, 15n);
});

test('C2-02 joins and widening never lose represented values (monotone over-approximation)', () => {
  const samples = [
    masked(0n),
    masked(15n),
    masked(10n, 5n),
    masked(0x80n, 0x40n),
    factFromRange(rangeOf(248n, 7n, 8)),
    factFromRange(rangeOf(5n, 19n, 8)),
    c(3n),
  ];
  for (let i = 0; i < samples.length; i++) {
    for (let j = 0; j < samples.length; j++) {
      const f1 = samples[i], f2 = samples[j];
      const joined = joinFacts(f1, f2);
      const widened = widenFacts(f1, f2);

      // Verify that all points in f1 are contained in joined and widened
      for (const val of [0n, 1n, 2n, 3n, 5n, 15n, 0x40n, 0x80n, 255n]) {
        if (contains(f1.range, val) && (val & f1.knownZero) === 0n && (val & f1.knownOne) === f1.knownOne) {
          assert.ok(contains(joined.range, val), 'joined must contain f1 value');
          assert.ok(contains(widened.range, val), 'widened must contain f1 value');
        }
      }
    }
  }
});

test('C2-02 downstream induction consumes validated canonical scalar facts and rejects invalid/stale facts', () => {
  const f = fixture('c2-induction-acceptance');
  f.block(0);
  const counter = f.opaque(32);
  const amount = f.opaque(32);
  const update = f.binary('add', counter, amount, 32);

  const validIdentity = Object.freeze({
    binaryId: 'binary-b',
    functionId: 'function-f',
    snapshotId: 'snapshot-s',
    semanticIrId: 'semantic-ir-1',
    ssaId: 'ssa-1',
    analyzerVersion: 'phase8-test-1',
  });

  const validArtifact = Object.freeze({
    identity: validIdentity,
    completeness: 'complete',
    facts: new Map([[amount.id, singletonFact(bitvector(4n, 32), { valueId: amount.id })]]),
    constants: new Map(),
  });

  // Valid resolution consumes canonical scalar fact
  const step = resolveStep(update, counter, {
    rangeFacts: validArtifact,
    analysisIdentity: validIdentity,
  });
  assert.ok(step, 'step must resolve from valid canonical fact');
  assert.equal(step.step, 4n);
  assert.equal(step.reason, null);

  // Rejection without validated identity
  const unvalidatedArtifact = {
    completeness: 'complete',
    identity: null,
    facts: validArtifact.facts,
    constants: new Map(),
  };
  const rejectedNoIdentity = resolveStep(update, counter, { rangeFacts: unvalidatedArtifact, analysisIdentity: validIdentity });
  assert.equal(rejectedNoIdentity.step, null);
  assert.equal(rejectedNoIdentity.reason, 'the step is a variable value');

  // Rejection on stale snapshot
  const staleArtifact = {
    completeness: 'complete',
    identity: { ...validIdentity, snapshotId: 'stale' },
    facts: validArtifact.facts,
    constants: new Map(),
  };
  const rejectedStale = resolveStep(update, counter, { rangeFacts: staleArtifact, analysisIdentity: validIdentity });
  assert.equal(rejectedStale.step, null);
  assert.equal(rejectedStale.reason, 'the step is a variable value');

  // Rejection of partial canonical fact
  const partialArtifact = {
    completeness: 'partial',
    identity: validIdentity,
    facts: new Map([[amount.id, singletonFact(bitvector(4n, 32), { valueId: amount.id, status: 'partial' })]]),
    constants: new Map(),
  };
  const rejectedPartial = resolveStep(update, counter, { rangeFacts: partialArtifact, analysisIdentity: validIdentity });
  assert.equal(rejectedPartial.step, null);
  assert.equal(rejectedPartial.reason, 'the step is a variable value');
});
