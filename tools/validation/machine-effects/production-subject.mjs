import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { OP } from '../../../js/ir-base.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { createRiscv64DecodedInstruction, RISCV64_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { evaluateExpr } from '../../../js/symbolic/expr/evaluate.js';
import { boundedExpressionEvaluationCost } from '../../../js/symbolic/memory/expression-contract.js';
import { QueryFailure } from '../../../js/symbolic/memory/query-state.js';
import { canonicalStringify } from './oracle-schema.mjs';
import { productionSubjectObservation } from './oracle-runner.mjs';
import { PRODUCTION_SUBJECT_IDENTITY } from './oracle-policy.mjs';
import { assessArchitecturalEvidence, createArchitecturalEvidenceFromArtifactRecord } from './oracle-evidence-v2.mjs';

export const PRODUCTION_SUBJECT_VERSION = 'machine-effects-production-register-subject/v2';

// Inputs only. Neither oracle register values nor trace assignments enter the
// production decoder, lifter, SSA projection or canonical Expr evaluator.
export const RV64_FORMAL_ADD_PREFIX = Object.freeze({
  recordId: 'riscv64-rv64imc-add-concrete-trace',
  profileId: 'riscv64:rv64imc',
  source: Object.freeze({
    path: 'tests/machine-effects/fixtures/formal-source/rv64-add.S',
    digest: 'sha256:ba8b122f2d82c1e54b078808c596df051d1ee8cfa8e412d2ec4277ca237cd055',
  }),
  inputDigest: 'sha256:d77acb5f950a47424438bc26d30fd9704a0c37413c86b9045707dd4e64e7edb4',
  artifactDigest: 'sha256:07cb9811a64beadd351ce77c5432be78117007dc2bcbdb3b9aaf272a9a96fbda',
  effect: Object.freeze({ instructionId: 'rv64:add:x5-x1-x2', effectId: 'register:x5',
    caseId: 'formal:rv64-add', requiredFeatures: Object.freeze(['rv64imc']) }),
  instructions: Object.freeze([
    Object.freeze({ address: '0x80000000', rawBytes: Object.freeze([0x95, 0x40]) }),
    Object.freeze({ address: '0x80000002', rawBytes: Object.freeze([0x0d, 0x41]) }),
    Object.freeze({ address: '0x80000004', rawBytes: Object.freeze([0xb3, 0x82, 0x20, 0x00]) }),
  ]),
});

function declined(status, reason) {
  return Object.freeze({ status, reason, observables: Object.freeze({}) });
}

function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function prefixDigest(instructions) {
  return digest(canonicalStringify(instructions.map(instruction => ({
    address: String(BigInt(instruction.address)), rawBytes: [...instruction.rawBytes],
  }))));
}

// Shared input identity for the producer observation and offline diagnostics.
// This hashes inputs only; it does not issue observation or oracle authority.
export function rv64RegisterPrefixInputDigest(instructions, initialRegisters = null) {
  if (initialRegisters === null) return prefixDigest(instructions);
  return digest(canonicalStringify({ scope: 'rv64-register-prefix-with-entry-state/v1',
    prefix: prefixDigest(instructions), registers: Object.fromEntries(Object.keys(initialRegisters).sort()
      .map(key => [key, String(BigInt(initialRegisters[key]))])),
  }));
}

// Read the retained trace as data, without interpreting ISA operations. Its
// bytes/PCs bind the subject input; its assignments independently bind the
// comparison values. The artifact's ELF/model digest has a different domain.
function pinnedTraceReference(record) {
  const input = RV64_FORMAL_ADD_PREFIX;
  const source = fs.readFileSync(new URL(`../../../${input.source.path}`, import.meta.url));
  if (digest(source) !== input.source.digest) throw new TypeError('production-formal-source-drift');
  const lines = record.artifact.toolOutput.trimEnd().split('\n');
  if (lines.length !== 7 || lines[6] !== 'QEMU-RISCV64 exit-status:8') throw new TypeError('production-formal-trace-shape');
  const instructions = [], observables = {};
  for (let index = 0; index < 3; index++) {
    const instruction = /^\[(\d+)\] \[M\]: (0x[0-9a-fA-F]{16}) \((0x(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8}))\) .+$/.exec(lines[index * 2]);
    const assignment = /^(x(?:[1-9]|[12][0-9]|3[01])) <- (0x[0-9a-fA-F]{16})$/.exec(lines[index * 2 + 1]);
    if (!instruction || instruction[1] !== String(index) || !assignment) throw new TypeError('production-formal-trace-shape');
    instructions.push({ address: instruction[2], rawBytes: [...Buffer.from(instruction[3].slice(2), 'hex')].reverse() });
    observables[`register:${assignment[1]}`] = assignment[2].toLowerCase();
  }
  const inputDigest = prefixDigest(instructions);
  if (inputDigest !== prefixDigest(input.instructions)) throw new TypeError('production-formal-trace-input-mismatch');
  return { inputDigest, observables };
}

/** Observe final written GPRs in a straight-line RV64 prefix.
 * This is an offline subject adapter, not an ISA oracle or function executor.
 * Explicit entry registers are inputs, never expected outputs. Memory, control
 * transfers, faults, unknowns and unbound entry state decline. maxWorkItems is
 * one prefix-wide scalar budget: translation, DAG-cost inspection and the
 * recursive evaluator's conservative visit bound share it. Decoding/lifting
 * remains separately bounded by maxInstructions; this is not a wall-time bound.
 */
export function observeRv64RegisterPrefix(instructions, { signal, maxInstructions = 32, maxWorkItems = 10000, initialRegisters = null } = {}) {
  if (signal?.aborted) return declined('cancelled', 'subject-cancelled');
  if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 1 || maxInstructions > 32
      || !Number.isSafeInteger(maxWorkItems) || maxWorkItems < 1 || maxWorkItems > 10000) {
    return declined('budget', 'subject-invalid-budget');
  }
  if (!Array.isArray(instructions) || instructions.length === 0) return declined('malformed', 'subject-empty-prefix');
  if (instructions.length > maxInstructions) return declined('budget', 'subject-instruction-budget');
  const resources = { translationWorkItems: 0, evaluationPreflightWorkItems: 0,
    evaluationUpperBound: 0, accountedWorkItems: 0 };
  const resourceSnapshot = () => Object.freeze({ ...resources });
  const charge = (stage, amount) => {
    if (signal?.aborted) throw new QueryFailure('subject-cancelled');
    if (!Number.isSafeInteger(amount) || amount < 1) throw new QueryFailure('subject-invalid-work-accounting');
    if (amount > maxWorkItems - resources.accountedWorkItems) throw new QueryFailure('subject-work-budget');
    resources[stage] += amount;
    resources.accountedWorkItems += amount;
  };
  const evaluationGuard = Object.freeze({ take(key, amount = 1) {
    if (key !== 'workItems') throw new QueryFailure('subject-invalid-work-accounting');
    charge('evaluationPreflightWorkItems', amount);
  } });
  try {
    const symbolicArgs = {};
    if (initialRegisters !== null) {
      if (typeof initialRegisters !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(initialRegisters))) {
        return declined('malformed', 'subject-invalid-entry-registers');
      }
      const keys = Object.keys(initialRegisters).sort();
      if (keys.length > 31) return declined('budget', 'subject-entry-register-budget');
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(initialRegisters, key);
        if (!/^x(?:[1-9]|[12][0-9]|3[01])$/.test(key) || !Object.hasOwn(property, 'value')
            || typeof property.value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(property.value)) {
          return declined('malformed', 'subject-invalid-entry-register');
        }
        symbolicArgs[key] = BigInt(property.value);
      }
    }
    const decoded = instructions.map(({ address, rawBytes }) => createRiscv64DecodedInstruction({
      address, rawBytes, size: rawBytes.length, mode: 'rv64imc',
    }));
    for (let index = 0; index < decoded.length; index++) {
      const instruction = decoded[index];
      if (instruction.address % 2n !== 0n) return declined('unsupported', 'subject-instruction-alignment');
      if (instruction.address < 0n || instruction.address + BigInt(instruction.size) > (1n << 64n)
          || (index > 0 && instruction.address !== decoded[index - 1].address + BigInt(decoded[index - 1].size))) {
        return declined('unsupported', 'subject-noncontiguous-prefix');
      }
    }
    const inputDigest = rv64RegisterPrefixInputDigest(decoded, initialRegisters === null ? null : symbolicArgs);
    const pipeline = buildSemanticV2CompatibilityPipeline({
      architecturePlugin: architecturePluginV2('riscv64'),
      decoderSemanticVersion: RISCV64_DECODER_SEMANTIC_VERSION,
      binaryId: inputDigest, sliceId: PRODUCTION_SUBJECT_VERSION, addressWidthBits: 64,
      entryBlockKey: 'entry', blocks: [{ key: 'entry', startAddress: decoded[0].address,
        instructions: decoded.map(instruction => ({ decoded: instruction })), successors: [] }],
    }, { signal });
    const expectedWrites = new Map();
    for (const bundle of pipeline.machineEffects) {
      if (bundle.completeness !== 'exact' || bundle.unknownEffects || bundle.possibleFaults.length
          || bundle.controlEffect.kind !== 'fallthrough') return declined('unsupported', 'subject-nonscalar-effects');
      for (const operation of bundle.operations) {
        if (!['value', 'register-read', 'register-write'].includes(operation.kind) || operation.undefinedResult) {
          return declined('unsupported', 'subject-nonscalar-effects');
        }
        if (operation.kind === 'register-write') expectedWrites.set(operation.id, operation.register.registerId);
      }
    }
    if (pipeline.semanticIr.completeness !== 'complete' || pipeline.instrumentation.semanticUnknownCount
        || pipeline.instrumentation.unsupportedInstructionCount) return declined('partial', 'subject-incomplete-semantics');
    const observables = {}, assignments = [];
    for (const instruction of pipeline.legacyV1.instructions) {
      if (!instruction.extra?.stateWrite) continue;
      if (signal?.aborted) return declined('cancelled', 'subject-cancelled');
      const physical = instruction.extra.stateWrite.physicalIdentity;
      const effectId = instruction.extra.attributes?.machineEffects?.sourceEffectId;
      if (instruction.op !== OP.MOV || !instruction.dst || !instruction.extra.stateSsaDefinitionId
          || instruction.extra.stateWriteProof?.broadUnknown !== false || physical?.kind !== 'register'
          || !/^x(?:[1-9]|[12][0-9]|3[01])$/.test(physical.registerId)
          || expectedWrites.get(effectId) !== physical.registerId) return declined('partial', 'subject-unproved-state-write');
      const remainingWork = maxWorkItems - resources.accountedWorkItems;
      if (remainingWork === 0) throw new QueryFailure('subject-work-budget');
      const translated = translateSemanticIR(instruction.dst, { signal,
        maxWorkItems: remainingWork, maxDepth: 64, symbolicArgs });
      charge('translationWorkItems', translated.metrics?.workItems);
      if (translated.unsupportedEntities.some(entity => entity.reason === 'budget:translation-work')) {
        throw new QueryFailure('subject-work-budget');
      }
      if (translated.status !== 'exact' || translated.semanticUnknowns || translated.assumptions.length) {
        return declined(signal?.aborted ? 'cancelled' : 'partial', 'subject-inexact-scalar-translation');
      }
      // Translation emits canonical immutable Expr DAGs. The existing evaluator
      // recursively revisits shared children: a small DAG can have exponential
      // tree cost. Reuse the existing cost bound and reserve it before execution;
      // neither counting nor evaluation creates alternative ISA semantics.
      const evaluationCost = boundedExpressionEvaluationCost([translated.expression], evaluationGuard,
        maxWorkItems - resources.accountedWorkItems);
      charge('evaluationUpperBound', evaluationCost);
      const evaluated = evaluateExpr(translated.expression);
      if (evaluated.status !== 'value' || evaluated.sort?.kind !== 'bv' || evaluated.sort.width !== 64
          || typeof evaluated.value !== 'bigint') return declined('partial', 'subject-unbound-or-unsupported-value');
      const key = `register:${physical.registerId}`;
      observables[key] = `0x${evaluated.value.toString(16).padStart(16, '0')}`;
      assignments.push(Object.freeze({ observable: key, sourceEffectId: effectId,
        semanticNodeId: instruction.semanticNodeId, stateSsaDefinitionId: instruction.extra.stateSsaDefinitionId }));
      expectedWrites.delete(effectId);
    }
    if (!assignments.length || expectedWrites.size) return declined('partial', 'subject-incomplete-state-write-projection');
    if (signal?.aborted) return declined('cancelled', 'subject-cancelled');
    return Object.freeze({ status: 'observed', reason: null, observables: Object.freeze(observables),
      subjectVersion: PRODUCTION_SUBJECT_VERSION,
      scope: initialRegisters === null ? 'self-contained-rv64-register-prefix' : 'rv64-register-prefix-with-entry-state', inputDigest,
      instructionCount: decoded.length, assignments: Object.freeze(assignments), resources: resourceSnapshot(),
      architectureSemanticVersion: pipeline.architectureSemanticVersion,
      decoderSemanticVersion: pipeline.decoderSemanticVersion, pipelineVersion: pipeline.pipelineVersion });
  } catch (error) {
    if (error instanceof QueryFailure) {
      const status = signal?.aborted || error.reason === 'subject-cancelled' ? 'cancelled'
        : error.reason === 'subject-work-budget' ? 'budget' : 'partial';
      return Object.freeze({ ...declined(status, error.reason), resources: resourceSnapshot() });
    }
    return declined(signal?.aborted ? 'cancelled' : 'unsupported', `subject-rejected:${String(error.message).slice(0, 160)}`);
  }
}

/** Existing independent-oracle runner adapter. Only bytes and initial state
 * enter production; operation descriptions and expected state are not read.
 * The prefix observer accounts for every effect before untouched input state
 * is preserved here. Unsupported observations cannot become comparisons.
 */
export function observeRv64CorpusCase({ caseValue, signal }) {
  const unavailable = (kind, code) => ({ subjectIdentity: PRODUCTION_SUBJECT_IDENTITY,
    subjectRole: 'production-machine-effects-subject', outcome: { kind, code }, state: null });
  if (caseValue.profileId !== 'riscv64:rv64imc' || caseValue.architecture !== 'riscv64'
      || !/^(?:[0-9a-fA-F]{2}){2,4}$/.test(caseValue.instructionBytes)) {
    return unavailable('unsupported', 'rv64-corpus-subject-scope');
  }
  const observation = observeRv64RegisterPrefix([{ address: '0x1000',
    rawBytes: [...Buffer.from(caseValue.instructionBytes, 'hex')] }], {
    signal, initialRegisters: caseValue.initialState.registers,
  });
  if (observation.status !== 'observed') return unavailable(
    observation.status === 'cancelled' ? 'cancelled' : 'unsupported', observation.reason);
  const state = structuredClone(caseValue.initialState);
  for (const [key, value] of Object.entries(observation.observables)) state.registers[key.slice('register:'.length)] = value;
  return productionSubjectObservation({ state });
}

/** One pinned formal comparison, using existing evidence validation/comparison.
 * Other profiles and relaxed-memory outcome sets remain explicitly unsupported.
 */
export function assessProductionFormalEvidence(record, options = {}) {
  const input = RV64_FORMAL_ADD_PREFIX;
  const noComparison = (status, reason, observation = null) => Object.freeze({ observation,
    assessment: Object.freeze({ status, reason, exactAuthorized: false, passContribution: 0 }) });
  if (record?.id !== input.recordId || record.kind !== 'instruction-footprint' || record.profileId !== input.profileId) {
    return noComparison('unsupported', 'production-formal-subject-not-integrated');
  }
  let evidence, reference;
  try {
    if (canonicalStringify(record.source) !== canonicalStringify(input.source)
        || canonicalStringify(record.effect) !== canonicalStringify(input.effect) || record.artifact?.inputDigest !== input.inputDigest
        || record.artifactDigest !== input.artifactDigest) {
      return noComparison('mismatch', 'production-formal-input-identity-mismatch');
    }
    evidence = createArchitecturalEvidenceFromArtifactRecord(record);
    reference = pinnedTraceReference(record);
  }
  catch (error) { return noComparison('malformed', error.message); }
  const observation = observeRv64RegisterPrefix(input.instructions, options);
  if (observation.status !== 'observed') return noComparison(observation.status, observation.reason, observation);
  if (observation.inputDigest !== reference.inputDigest) {
    return noComparison('mismatch', 'production-formal-subject-input-mismatch', observation);
  }
  const keys = Object.keys(observation.observables).sort();
  if (canonicalStringify(evidence.observables.declared) !== canonicalStringify(keys)
      || canonicalStringify(evidence.observables.known) !== canonicalStringify(keys)) {
    return noComparison('mismatch', 'production-formal-observable-scope-mismatch', observation);
  }
  for (const key of keys) {
    if (evidence.expectedObservables[key] !== reference.observables[key]) {
      return noComparison('mismatch', `reference-output-disagreement:${key}`, observation);
    }
  }
  return Object.freeze({ observation, referenceInputDigest: reference.inputDigest, assessment: assessArchitecturalEvidence({ evidence,
    subject: { profileId: input.profileId, effect: input.effect, observables: observation.observables } }) });
}
