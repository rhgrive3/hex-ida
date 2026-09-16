import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createTemporaryValue,
  MEMORY_ORDERINGS,
} from '../../js/semantics/effects/index.js';
import { SEMANTIC_MEMORY_ORDERINGS } from '../../js/semantics/ir/common.js';
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
import {
  assessArchitecturalEvidence,
  createArchitecturalEvidenceFromArtifactRecord,
} from '../../tools/validation/machine-effects/oracle-evidence-v2.mjs';
import { assessProductionFormalEvidence } from '../../tools/validation/machine-effects/production-subject.mjs';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer-core.js';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';
import {
  ARM64E_PAC_DENOMINATOR_ID,
  validateArm64ePacDenominator,
} from '../../tools/validation/machine-effects/arm64e-pac-denominator.mjs';
import {
  RV64IMC_DECODER_DENOMINATOR_ID,
  validateRv64imcDecoderDenominator,
} from '../../tools/validation/machine-effects/riscv64-rv64imc-denominator.mjs';

const reg = (n, bits = 64) => ({ k: 'reg', text: `x${n}`, cls: 'gp', bits, num: n });
const imm = (v) => ({ k: 'imm', text: `#${v}`, value: BigInt(v) });
const mem = (base, { disp = null } = {}) => ({
  k: 'mem', text: '[...]', base, index: null, shift: null, mode: 'offset',
  disp: disp == null ? null : imm(disp), addressDisp: disp == null ? null : imm(disp), writebackDisp: null,
});
const parseOps = (parts) => parts.map((p) => (p.startsWith('#') ? imm(Number(p.slice(1))) : reg(Number(p.replace('x', '')))));
const ctxFor = (id) => ({ instructionId: id, origin: { instructionIds: [id] } });

const loweringContext = Object.freeze({ functionId: 'me01-acceptance', blockId: 'entry', addressWidthBits: 64 });

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

test('HEX-ME-01 denominator: 10 frozen cases across orderings and undefined masks', () => {
  assert.equal(ORDERING_UNDEFINED_MATRIX.length, 10);
  assert.deepEqual(ORDERING_UNDEFINED_MATRIX.map(({ id }) => id), [
    'ordering-relaxed', 'ordering-acquire', 'ordering-release', 'ordering-acq-rel',
    'ordering-seq-cst', 'ordering-unknown', 'undefined-fully', 'undefined-partial',
    'undefined-conditional', 'undefined-operand-dependent',
  ]);
  assert.deepEqual(
    ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'ordering').map(({ ordering }) => ordering),
    SEMANTIC_MEMORY_ORDERINGS,
  );
  for (const ordering of MEMORY_ORDERINGS) {
    assert.ok(SEMANTIC_MEMORY_ORDERINGS.includes(ordering), `missing ordering ${ordering}`);
  }
  assert.ok(SEMANTIC_MEMORY_ORDERINGS.includes('unknown'));

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

test('HEX-ME-01 contract validation: atomic ordering constraints and producer lowering', () => {
  // Non-atomic access with an ordering is rejected
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: false, ordering: 'acquire' }),
    /machine-effects-ordering-requires-atomic-access/,
  );

  // Invalid memory ordering is rejected
  assert.throws(
    () => createMemoryAccess({ space: 'memory', addressExpr: {}, widthBits: 32, endian: 'little', atomic: true, ordering: 'not-an-ordering' }),
    /machine-effects-invalid-memory-ordering/,
  );

  // Real ARM64 producer probes: ldar, stlr, ldxr
  const probes = [
    { id: 'ldar', mnemonic: 'ldar', ops: [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'acquire' },
    { id: 'stlr', mnemonic: 'stlr', ops: [reg(0), mem(reg(1))], access: 'memory-write', ordering: 'release' },
    { id: 'ldxr', mnemonic: 'ldxr', ops: [reg(0), mem(reg(1))], access: 'memory-read', ordering: 'relaxed' },
  ];
  for (const probe of probes) {
    const effects = liftArm64MemoryEffects({ mnemonic: probe.mnemonic, ops: probe.ops }, ctxFor(`probe-${probe.id}`));
    const op = effects.operations.find((o) => o.kind === probe.access);
    assert.ok(op, `${probe.mnemonic} must produce ${probe.access}`);
    assert.equal(op.access.atomic, true);
    assert.equal(op.access.ordering, probe.ordering);

    const ir = lowerMachineEffectBundleToSemanticIr(effects, loweringContext);
    const memNode = ir.nodes.find((n) => n.memory);
    assert.ok(memNode);
    assert.equal(memNode.memory.atomic, true);
    assert.equal(memNode.memory.ordering, probe.ordering);
  }
});

test('HEX-ME-01 architectural undefined behaviors: variable shift, division by zero, unmodelled operands', () => {
  // Variable shift modulo
  const lslv = liftArm64IntegerEffects({
    instructionId: 'me01-lslv',
    mnemonic: 'lslv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-lslv'] },
  });
  const shift = lslv.operations.find((op) => op.kind === 'value' && op.opcode === 'shl');
  assert.ok(shift);
  const modulo = lslv.operations.find(
    (op) => op.kind === 'value' && op.metadata?.reason === 'a64-variable-shift-modulo-register-width',
  );
  assert.ok(modulo);

  // Division by zero
  const sdiv = liftArm64IntegerEffects({
    instructionId: 'me01-sdiv',
    mnemonic: 'sdiv',
    ops: parseOps(['x0', 'x1', 'x2']),
    origin: { instructionIds: ['me01-sdiv'] },
  });
  const div = sdiv.operations.find((op) => op.kind === 'value' && op.opcode === 'a64-sdiv');
  assert.ok(div);
  assert.equal(div.metadata.divisionByZero, 'returns-zero');
  assert.equal(div.metadata.signedOverflow, 'wraps-min-div-minus-one');

  // Unmodelled operand partiality
  const partial = liftArm64IntegerEffects({
    instructionId: 'me01-partial',
    mnemonic: 'lslv',
    ops: [reg(0), reg(1), { k: 'other', text: '??' }],
    origin: { instructionIds: ['me01-partial'] },
  });
  assert.equal(partial.completeness, 'partial');
  assert.ok(partial.unknownEffects);
});

test('HEX-ME-01 differential matrix classification and path proofs across pipeline stages', async () => {
  const report = await classify(ORDERING_UNDEFINED_MATRIX);
  assert.equal(report.blocking, false);
  assert.equal(report.results.length, 10);
  report.results.forEach((result, index) => {
    assert.equal(result.classification, ORDERING_UNDEFINED_MATRIX[index].expectedClassification);
    assert.equal(result.pathProof.passed, true);
  });
});

test('HEX-ME-01 boundary mutation detection: ordering loss, changed atomicity, mask mutation, lost predicates', async () => {
  // Ordering loss and changes
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'ordering')) {
    const reportLost = await classify([record], {
      mutateIr(ir) { delete ir.nodes.find((n) => n.memory).memory.ordering; },
    });
    assert.equal(reportLost.results[0].classification, 'mismatch');
    assert.equal(reportLost.blocking, true);

    const reportAtomicity = await classify([record], {
      mutateIr(ir) {
        const mem = ir.nodes.find((n) => n.memory).memory;
        mem.atomic = !mem.atomic;
      },
    });
    assert.equal(reportAtomicity.results[0].classification, 'mismatch');
    assert.equal(reportAtomicity.blocking, true);
  }

  // Mask mutation and concrete projection
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ kind }) => kind === 'undefined')) {
    const reportMut = await classify([record], {
      mutateIr(ir) { ir.nodes.find((n) => n.attributes?.machineEffects?.undefinedResult).attributes.machineEffects.undefinedResult.mask = '0x01'; },
    });
    assert.equal(reportMut.results[0].classification, 'mismatch');
    assert.equal(reportMut.blocking, true);

    const reportConcrete = await classify([record], {
      mutateProjection(p) { p.instructions.find((i) => i.extra?.undefinedResult).dst.const = 3n; },
    });
    assert.equal(reportConcrete.results[0].classification, 'mismatch');
    assert.equal(reportConcrete.blocking, true);
  }

  // Conditional predicate loss
  for (const record of ORDERING_UNDEFINED_MATRIX.filter(({ descriptor }) => descriptor?.condition)) {
    const reportPred = await classify([record], {
      mutateIr(ir) { delete ir.nodes.find((n) => n.attributes?.machineEffects?.undefinedResult).attributes.machineEffects.undefinedResult.condition; },
    });
    assert.equal(reportPred.results[0].classification, 'mismatch');
    assert.equal(reportPred.blocking, true);
  }
});

test('HEX-ME-01 formal evidence artifacts manifest and pinned oracle policies', () => {
  const manifest = validateFormalEvidenceArtifacts(JSON.parse(fs.readFileSync(
    new URL('../../tools/validation/machine-effects/generated/formal-evidence-artifacts.json', import.meta.url),
    'utf8',
  )));
  assert.ok(manifest.records.length > 0);
  assert.equal(manifest.identities.qemuAarch64.role, 'independent-concrete-execution');
  assert.equal(manifest.identities.qemuRiscv64.role, 'independent-concrete-execution');

  const policy = EXTERNAL_ORACLE_POLICY.find(({ id }) => id === 'herdtools7-aarch64-memory-model');
  assert.equal(policy.semanticAuthority, 'declared-litmus-outcome-universe-only');
  assert.equal(policy.defaultNetworkRequired, false);

  const litmusRecords = ORDERING_UNDEFINED_MATRIX.filter(({ litmus }) => litmus);
  assert.equal(litmusRecords.length, 5);
  for (const record of litmusRecords) {
    const artifact = manifest.records.find(({ id }) => id === record.litmus.artifactId);
    assert.ok(artifact);
    assert.equal(artifact.source.path, record.litmus.sourcePath);
  }

  // Pinned Sail trace agrees with production RV64 subject
  const rv64Record = manifest.records.find((item) => item.id === 'riscv64-rv64imc-add-concrete-trace');
  assert.ok(rv64Record);
  const rv64Result = assessProductionFormalEvidence(rv64Record);
  assert.equal(rv64Result.assessment.status, 'exact/equivalent');
  assert.equal(rv64Result.assessment.exactAuthorized, true);
});

test('HEX-ME-01 architecture denominators: ARM64e PAC and RV64IMC frozen coverage', () => {
  const pac = validateArm64ePacDenominator();
  assert.equal(pac.denominatorId, ARM64E_PAC_DENOMINATOR_ID);
  assert.equal(pac.encodingFamilyCount, 44);
  assert.equal(pac.encodingCaseCount, 45_521);

  const rv64 = validateRv64imcDecoderDenominator();
  assert.equal(rv64.denominatorId, RV64IMC_DECODER_DENOMINATOR_ID);
  assert.ok(rv64.encoding32FamilyCount > 0);
  assert.ok(rv64.compressedFamilyCount > 0);
});
