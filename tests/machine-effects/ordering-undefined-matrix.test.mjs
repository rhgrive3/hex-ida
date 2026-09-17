import assert from 'node:assert/strict';
import test from 'node:test';

import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer-core.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import { createMemoryAccess } from '../../js/semantics/effects/index.js';
import { MEMORY_ORDERINGS } from '../../js/semantics/effects/index.js';
import { SEMANTIC_MEMORY_ORDERINGS } from '../../js/semantics/ir/common.js';
import fs from 'node:fs';
import { createBitVectorValue, createMachineEffectBundle, createMachineOperation, createTemporaryValue } from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { classifySemanticMemoryRegion } from '../../js/analysis/alias/index-v2.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { runDifferentialHarness } from '../../tools/validation/semantic-v2/differential.mjs';
import { ORDERING_UNDEFINED_MATRIX } from '../../tools/validation/machine-effects/ordering-undefined-matrix.mjs';
import { EXTERNAL_ORACLE_POLICY } from '../../tools/validation/machine-effects/external-oracles.mjs';
import { validateFormalEvidenceArtifacts } from '../../tools/validation/machine-effects/generate-formal-evidence.mjs';

const reg = (n, bits = 64) => ({ k: 'reg', text: `x${n}`, cls: 'gp', bits, num: n });
const imm = (v) => ({ k: 'imm', text: `#${v}`, value: BigInt(v) });
const mem = (base, { disp = null } = {}) => ({
  k: 'mem', text: '[...]', base, index: null, shift: null, mode: 'offset',
  disp: disp == null ? null : imm(disp), addressDisp: disp == null ? null : imm(disp), writebackDisp: null,
});
const parseOps = (parts) => parts.map((p) => (p.startsWith('#') ? imm(Number(p.slice(1))) : reg(Number(p.replace('x', '')))));
const ctxFor = (id) => ({ instructionId: id, origin: { instructionIds: [id] } });

/**
 * Real ARM64 producer probes supplement the exhaustive, explicitly synthetic
 * transport-contract denominator below. They are not undefined-mask evidence.
 */
const ORDERING_RECORDS = Object.freeze([
  // ARM v8 A-profile: LDAR/STLR give acquire/release; LDXR/STXR are relaxed
  // monotonically; DMB variants carry the barrier domain+ordering scope.
  { id: 'ldar-acquire', mnemonic: 'ldar', ops: () => [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'acquire' },
  { id: 'stlr-release', mnemonic: 'stlr', ops: () => [reg(0), mem(reg(1))], access: 'memory-write', ordering: 'release' },
  { id: 'ldxr-relaxed', mnemonic: 'ldxr', ops: () => [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'relaxed' },
]);

test('ME-01 ordering denominator: every machine-effects ordering maps to the semantic V2 set', () => {
  for (const ordering of MEMORY_ORDERINGS) {
    assert.ok(
      SEMANTIC_MEMORY_ORDERINGS.includes(ordering),
      `machine-effects ordering ${ordering} has no Semantic V2 identity`,
    );
  }
  assert.ok(SEMANTIC_MEMORY_ORDERINGS.includes('unknown'), 'V2 must keep an explicit unknown ordering');
});

for (const record of ORDERING_RECORDS) {
  test(`ME-01 ordering matrix: ${record.id} lowers with ordering ${record.ordering} preserved`, () => {
    const effects = liftArm64MemoryEffects(
      { mnemonic: record.mnemonic, ops: record.ops() }, ctxFor(`me01-${record.id}`),
    );
    const readOrWrite = effects.operations.find((op) => op.kind === record.access);
    assert.ok(readOrWrite, `${record.mnemonic} must produce a ${record.access}`);
    const access = readOrWrite.access;
    assert.equal(access.atomic, true);
    assert.equal(access.ordering, record.ordering);
    const ir = lowerMachineEffectBundleToSemanticIr(effects, loweringContext);
    const lowered = ir.nodes.filter((node) => node.memory);
    assert.equal(lowered.length, 1);
    assert.equal(lowered[0].memory.ordering, record.ordering);
    assert.equal(lowered[0].memory.atomic, true);
  });
}

test('ME-01 ordering matrix: non-atomic access with an ordering is rejected at the contract', () => {
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: false, ordering: 'acquire' }),
    /machine-effects-ordering-requires-atomic-access/,
  );
});

test('ME-01 ordering matrix: an unknown ordering cannot masquerade as a known one', () => {
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: true, ordering: 'not-an-ordering' }),
    /machine-effects-invalid-memory-ordering/,
  );
});

test('ME-01 undefined matrix: variable shift models the modulo, never a guessed shift', () => {
  // A64 LSLV: the shift amount is the register value modulo the datasize.
  // ARM says shift amounts >= width give an architecturally defined result
  // only through that modulo — the lowering must apply the modulo explicitly.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-lslv',
    mnemonic: 'lslv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-lslv'] },
  });
  const shift = effects.operations.find((op) => op.kind === 'value' && op.opcode === 'shl');
  assert.ok(shift, 'lslv must lower to a shl value operation');
  const modulo = effects.operations.find(
    (op) => op.kind === 'value' && op.metadata?.reason === 'a64-variable-shift-modulo-register-width',
  );
  assert.ok(modulo, 'the shift amount must be masked by the modulo operation');
});

test('ME-01 undefined matrix: division-by-zero must be explicit, not silent', () => {
  // A64 SDIV/UDIV: division by zero returns zero, not an architectural
  // undefined — the lowering must name that behavior in metadata.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-sdiv',
    mnemonic: 'sdiv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-sdiv'] },
  });
  const div = effects.operations.find((op) => op.kind === 'value' && op.opcode === 'a64-sdiv');
  assert.ok(div, 'sdiv must lower to the explicit a64-sdiv opcode');
  assert.equal(div.metadata.divisionByZero, 'returns-zero');
  assert.equal(div.metadata.signedOverflow, 'wraps-min-div-minus-one');
});

test('ME-01 undefined matrix: an unmodelled operand stays partial, never concrete', () => {
  // A missing shift-amount register cannot read as a computed result.
  const effects = liftArm64IntegerEffects({
    instructionId: 'me01-lslv-partial',
    mnemonic: 'lslv',
    ops: [reg(0), reg(1), { k: 'other', text: '??' }],
    origin: { instructionIds: ['me01-lslv-partial'] },
  });
  assert.equal(effects.completeness, 'partial');
  assert.ok(effects.unknownEffects);
  assert.notEqual(effects.unknownEffects.reason, undefined);
});

const loweringContext = Object.freeze({ functionId: 'me01-matrix', blockId: 'entry', addressWidthBits: 64 });

function matrixBundle(record) {
  const value = createTemporaryValue(`output-${record.id}`, { kind: 'bitvector', widthBits: 8 });
  const operation = record.kind === 'ordering'
    ? createMachineOperation({
      kind: 'memory-read', value,
      access: createMemoryAccess({
        space: 'memory', addressExpr: createBitVectorValue(64, 0x4000n),
        widthBits: 8, endian: 'little', atomic: record.machineOrdering !== null,
        ...(record.machineOrdering === null ? {} : { ordering: record.machineOrdering }),
      }),
    })
    : createMachineOperation({
      kind: 'value', opcode: 'add',
      inputs: [createBitVectorValue(8, 1n), createBitVectorValue(8, 2n)],
      outputs: [value], undefinedResult: record.descriptor,
    });
  return createMachineEffectBundle({
    instructionId: record.id, architectureId: 'matrix-contract', mode: 'synthetic',
    operations: [operation], controlEffect: { kind: 'fallthrough' },
    possibleFaults: [], origin: { instructionIds: [record.id] }, completeness: 'exact',
  });
}

function cfgFor(ir) {
  return createSemanticCfg({
    functionId: ir.functionId, entryBlockId: ir.entryBlockId,
    blocks: ir.blocks.map(({ id }) => ({ id, successors: [] })),
  });
}

function observation(ir, memoryssa, projection) {
  return {
    memory: ir.nodes.filter((node) => node.memory).map(({ memory }) => ({ ordering: memory.ordering, atomic: memory.atomic })),
    memorySsa: memoryssa.accessMetadata.filter(({ memory }) => memory).map(({ memory, sequencing }) => ({
      ordering: memory.ordering, atomic: memory.atomic,
      sequencing: { ordering: sequencing?.ordering, atomic: sequencing?.atomic },
    })),
    projectedMemory: projection.instructions.filter((instruction) => instruction.extra?.memoryAccess)
      .map(({ extra: { memoryAccess } }) => ({ ordering: memoryAccess.ordering, atomic: memoryAccess.atomic })),
    undefinedResults: ir.nodes.flatMap((node) => node.attributes?.machineEffects?.undefinedResult
      ? [node.attributes.machineEffects.undefinedResult] : []),
    maskedOutputs: projection.instructions.flatMap((instruction) => instruction.extra?.undefinedResult
      ? [{ op: instruction.op, descriptor: instruction.extra.undefinedResult, concreteDestination: instruction.dst?.const != null }] : []),
  };
}

function matrixAdapters({ mutateIr, mutateMemorySsa, mutateProjection } = {}) {
  return {
    // This is a fixed transport-contract oracle, not a claim of legacy ISA truth.
    legacy: { run: (record) => record.mustPreserve },
    v2: {
      machineEffects: matrixBundle,
      semanticIrV2(effects) {
        const ir = lowerMachineEffectBundleToSemanticIr(effects, loweringContext);
        if (!mutateIr) return ir;
        const changed = structuredClone(ir);
        mutateIr(changed);
        return changed;
      },
      scalarSsa: (ir) => buildSemanticSsa(ir, cfgFor(ir)),
      resolveRegions: (ir) => new Map(ir.nodes.filter((node) => node.memory)
        .map((node) => [node.id, classifySemanticMemoryRegion(ir, node)])),
      memorySsa(ir, regions) {
        const memoryssa = buildMemorySsa(ir, cfgFor(ir), {
          resolveRegion: (_memory, { node }) => regions.get(node.id),
        });
        if (!mutateMemorySsa) return memoryssa;
        const changed = structuredClone(memoryssa);
        mutateMemorySsa(changed);
        return changed;
      },
      compatV1({ ir, ssa, memoryssa }) {
        const projection = projectSemanticIrV2ToLegacyV1(ir, { ssa, memorySsa: memoryssa, cfg: cfgFor(ir) });
        if (!mutateProjection) return observation(ir, memoryssa, projection);
        // Production projections contain executable graph helpers. Copy only
        // the observed descriptors for fault injection; cloning the entire
        // graph would turn DataCloneError into a misleading passing negative.
        const changed = { instructions: projection.instructions.map((instruction) => ({
          ...instruction,
          dst: instruction.dst == null ? instruction.dst : { ...instruction.dst },
          extra: {
            ...instruction.extra,
            ...(instruction.extra?.memoryAccess == null ? {} : { memoryAccess: structuredClone(instruction.extra.memoryAccess) }),
            ...(instruction.extra?.undefinedResult == null ? {} : { undefinedResult: structuredClone(instruction.extra.undefinedResult) }),
          },
        })) };
        mutateProjection(changed);
        return observation(ir, memoryssa, changed);
      },
    },
  };
}

async function classify(records, mutations) {
  return runDifferentialHarness({
    cases: records.map((record) => ({ name: record.id, input: record })),
    adapters: matrixAdapters(mutations),
  });
}

test('ME-01 fixed denominator is deeply frozen and cannot silently shrink', () => {
  assert.deepEqual(ORDERING_UNDEFINED_MATRIX.map(({ id }) => id), [
    'ordering-relaxed', 'ordering-acquire', 'ordering-release', 'ordering-acq-rel',
    'ordering-seq-cst', 'ordering-unknown', 'undefined-fully', 'undefined-partial',
    'undefined-conditional', 'undefined-operand-dependent',
  ]);
  assert.deepEqual(ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'ordering')
    .map(({ ordering }) => ordering), SEMANTIC_MEMORY_ORDERINGS);
  function assertFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    Object.values(value).forEach(assertFrozen);
  }
  assertFrozen(ORDERING_UNDEFINED_MATRIX);
  for (const record of ORDERING_UNDEFINED_MATRIX) {
    assert.equal(record.evidenceScope, 'contract-transport-only');
    assert.ok(record.mustForbid.length > 0);
  }
});

test('ME-01 all fixed cases traverse real V2, SSA, regions, MemorySSA and projection', async () => {
  const report = await classify(ORDERING_UNDEFINED_MATRIX);
  assert.equal(report.blocking, false, JSON.stringify(report.results.filter((result) => result.blocking)));
  assert.equal(report.results.length, 10);
  report.results.forEach((result, index) => {
    assert.equal(result.classification, ORDERING_UNDEFINED_MATRIX[index].expectedClassification);
    assert.equal(result.pathProof.passed, true);
  });
});

test('ME-01 mutation controls preserve equivalent cloned artifacts at each boundary', async () => {
  for (const mutations of [{ mutateIr() {} }, { mutateMemorySsa() {} }, { mutateProjection() {} }]) {
    const report = await classify(ORDERING_UNDEFINED_MATRIX, mutations);
    assert.equal(report.blocking, false, JSON.stringify({
      boundary: Object.keys(mutations)[0], failures: report.results.filter(({ blocking }) => blocking)
        .map(({ caseName, reason, error }) => ({ caseName, reason, error })),
    }));
    assert.equal(report.exactEquivalentCount, ORDERING_UNDEFINED_MATRIX.length);
  }
});

test('ME-01 existing policy and pinned litmus references retain their exact claim-local universe', () => {
  const manifest = validateFormalEvidenceArtifacts(JSON.parse(fs.readFileSync(
    new URL('../../tools/validation/machine-effects/generated/formal-evidence-artifacts.json', import.meta.url), 'utf8',
  )));
  const policy = EXTERNAL_ORACLE_POLICY.find(({ id }) => id === 'herdtools7-aarch64-memory-model');
  assert.equal(policy.semanticAuthority, 'declared-litmus-outcome-universe-only');
  assert.equal(policy.defaultNetworkRequired, false);
  const records = ORDERING_UNDEFINED_MATRIX.filter(({ litmus }) => litmus);
  assert.equal(records.length, 5);
  for (const record of records) {
    const artifact = manifest.records.find(({ id }) => id === record.litmus.artifactId);
    assert.ok(artifact, record.id);
    assert.equal(artifact.source.path, record.litmus.sourcePath);
    assert.ok(policy.requiredPaths.includes(record.litmus.sourcePath));
    assert.deepEqual(artifact.memoryModel, {
      ordering: record.ordering, atomic: true,
      outcomeUniverse: [...record.litmus.permittedOutcomes, ...record.litmus.forbiddenOutcomes],
      permittedOutcomes: record.litmus.permittedOutcomes,
      forbiddenOutcomes: record.litmus.forbiddenOutcomes,
    });
  }
  assert.equal(ORDERING_UNDEFINED_MATRIX.find(({ ordering }) => ordering === 'unknown').litmus, null);
});

test('ME-01 ordering loss, changes and invented known ordering are blocking mismatches', async () => {
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'ordering')) {
    for (const replacement of SEMANTIC_MEMORY_ORDERINGS.filter((value) => value !== record.ordering)) {
      const report = await classify([record], { mutateIr(ir) {
        ir.nodes.find((node) => node.memory).memory.ordering = replacement;
      } });
      assert.equal(report.results[0].classification, 'mismatch', `${record.id} -> ${replacement}`);
      assert.equal(report.blocking, true);
    }
  }
});

test('ME-01 each downstream boundary rejects lost ordering and changed atomicity', async () => {
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'ordering')) {
    for (const mutate of [
      (memory) => { delete memory.ordering; },
      (memory) => { memory.atomic = !memory.atomic; },
    ]) {
      for (const mutations of [
        { mutateIr(ir) { mutate(ir.nodes.find((node) => node.memory).memory); } },
        { mutateMemorySsa(memoryssa) { mutate(memoryssa.accessMetadata.find(({ memory }) => memory).memory); } },
        { mutateMemorySsa(memoryssa) { mutate(memoryssa.accessMetadata.find(({ memory }) => memory).sequencing); } },
        { mutateProjection(projection) { mutate(projection.instructions.find((instruction) => instruction.extra?.memoryAccess).extra.memoryAccess); } },
      ]) {
        const report = await classify([record], mutations);
        if (mutations.mutateProjection) assert.equal(report.results[0].error, undefined, record.id);
        assert.equal(report.results[0].classification, 'mismatch', record.id);
        assert.equal(report.blocking, true);
      }
    }
  }
});

test('ME-01 every mask class rejects descriptor loss, mask mutation and concrete projection', async () => {
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'undefined')) {
    for (const mutations of [
      { mutateIr(ir) { delete ir.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult).attributes.machineEffects.undefinedResult; } },
      { mutateIr(ir) { ir.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult).attributes.machineEffects.undefinedResult.mask = '0x01'; } },
      { mutateProjection(projection) { projection.instructions.find((instruction) => instruction.extra?.undefinedResult).op = 'const'; } },
      { mutateProjection(projection) { projection.instructions.find((instruction) => instruction.extra?.undefinedResult).dst.const = 3n; } },
    ]) {
      const report = await classify([record], mutations);
      if (mutations.mutateProjection) assert.equal(report.results[0].error, undefined, record.id);
      assert.equal(report.results[0].classification, 'mismatch', record.id);
      assert.equal(report.blocking, true);
    }
  }
});

test('ME-01 conditional masks reject lost or changed predicates through projection', async () => {
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ descriptor }) => descriptor?.condition)) {
    for (const mutate of [
      (descriptor) => { delete descriptor.condition; },
      (descriptor) => { descriptor.condition.operand = 'different-operand'; },
    ]) {
      for (const mutations of [
        { mutateIr(ir) { mutate(ir.nodes.find((node) => node.attributes?.machineEffects?.undefinedResult).attributes.machineEffects.undefinedResult); } },
        { mutateProjection(projection) { mutate(projection.instructions.find((instruction) => instruction.extra?.undefinedResult).extra.undefinedResult); } },
      ]) {
        const report = await classify([record], mutations);
        if (mutations.mutateProjection) assert.equal(report.results[0].error, undefined, record.id);
        assert.equal(report.results[0].classification, 'mismatch', record.id);
        assert.equal(report.blocking, true);
      }
    }
  }
});
