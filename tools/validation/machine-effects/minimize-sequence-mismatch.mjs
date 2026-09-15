import { canonicalStringify, sha256Digest, validateCorpusCase } from './oracle-schema.mjs';
import { compareMachineState, createReferenceOracle } from './oracle-runner.mjs';
import { observeRv64RegisterPrefix, PRODUCTION_SUBJECT_VERSION, rv64RegisterPrefixInputDigest } from './production-subject.mjs';

const VERSION = 'machine-effects-sequence-mismatch-minimizer/v1';
const FIXED = ['profileId', 'architecture', 'initialState', 'definedMask', 'undefinedMask',
  'unobservedMask', 'requiredFeatures', 'oracleIdentity', 'oracleVersion', 'provenance', 'expectedStateSource',
  'generatorIdentity', 'generatorVersion', 'expectedOutcome'];

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function validateSequence(corpusCases) {
  if (!Array.isArray(corpusCases) || corpusCases.length < 1 || corpusCases.length > 32) {
    throw new TypeError('sequence-minimizer-instruction-budget');
  }
  const cases = corpusCases.map(validateCorpusCase), first = cases[0];
  for (const row of cases) {
    for (const key of FIXED) if (canonicalStringify(row[key]) !== canonicalStringify(first[key])) {
      throw new TypeError(`sequence-minimizer-contract-drift:${key}`);
    }
    const op = row.operation;
    if (row.profileId !== 'riscv64:rv64imc' || row.architecture !== 'riscv64'
        || row.expectedOutcome.kind !== 'normal' || op.widthBits !== 64 || op.setsFlags || op.carryIn !== 0
        || ![op.lhs, op.rhs, op.destination].every(reg => /^x(?:[1-9]|[12][0-9]|3[01])$/.test(reg))) {
      throw new TypeError('sequence-minimizer-rv64-register-add-required');
    }
    // Independent encoding identity, not a call back into the production
    // decoder: ADD is OP/funct3=0/funct7=0. No PC-relative instruction can
    // enter this reducer, so packing a deletion at the fixed base is sound.
    const word = (Number(op.rhs.slice(1)) << 20) | (Number(op.lhs.slice(1)) << 15)
      | (Number(op.destination.slice(1)) << 7) | 0x33;
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(word);
    if (row.instructionBytes !== bytes.toString('hex')) throw new TypeError('sequence-minimizer-bytes-model-mismatch');
  }
  return cases;
}

/** Offline diagnostic for straight-line RV64 ADD sequences. Each deletion
 * threads the existing independent reference through the remaining operations
 * and reruns the actual production prefix from the same entry state. Case
 * expected values are never reused as a sequence oracle. This does not issue
 * formal/release evidence or add another MachineEffects evaluator.
 * maxComparisons counts complete candidate sequences, including empty ones;
 * the <=32-row artifact preflight shares the same aggregate time deadline.
 */
export async function minimizeRv64SequenceMismatch({ corpusCases, subject = observeRv64RegisterPrefix,
  signal, maxComparisons = 256, timeoutMs = 30000 } = {}) {
  const startedAt = performance.now(), cases = validateSequence(corpusCases), first = cases[0];
  if (typeof subject !== 'function') throw new TypeError('sequence-minimizer-subject-required');
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 4096
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('sequence-minimizer-invalid-budget');
  }
  const contract = Object.fromEntries(FIXED.map(key => [key, first[key]]));
  const identity = indices => sha256Digest({ version: VERSION, contract,
    instructions: indices.map(index => ({ originalIndex: index, caseId: cases[index].caseId })) });
  const original = cases.map((_, index) => index), originalSequenceId = identity(original);
  const oracle = createReferenceOracle({ identity: first.oracleIdentity, version: first.oracleVersion,
    provenance: first.provenance, toolchainIdentity: first.provenance.toolchainIdentity });
  const controller = new AbortController();
  let stopped = null, comparisons = 0, current = original, confirmed = null, signature = null;
  const steps = [];
  let resolveStop;
  const stopPromise = new Promise(resolve => { resolveStop = resolve; });
  const stop = reason => {
    if (stopped) return;
    stopped = reason; controller.abort(); resolveStop(null);
  };
  const check = () => {
    if (performance.now() - startedAt >= timeoutMs) stop('resource-limited');
    return stopped === null;
  };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => stop('resource-limited'), Math.max(1, timeoutMs - (performance.now() - startedAt)));
  const finish = (status, reason, minimal = false) => freeze({ version: VERSION, status, reason,
    originalSequenceId, sequenceId: confirmed ? identity(current) : null,
    retainedIndices: confirmed ? [...current] : null,
    corpusCases: confirmed ? current.map(index => cases[index]) : null,
    contract, comparison: confirmed, comparisons, steps,
    reductionScope: 'rv64-add-instruction-deletion-fixed-entry-state',
    minimality: minimal ? 'single-instruction-deletion-fixed-point' : 'not-established', passContribution: 0 });
  const compare = async indices => {
    if (!check()) return null;
    if (comparisons >= maxComparisons) { stop('resource-limited'); return null; }
    comparisons++;
    let expectedState = structuredClone(first.initialState);
    for (const index of indices) {
      if (!check()) return null;
      const reference = await Promise.race([oracle.evaluate({ ...cases[index], initialState: expectedState },
        { signal: controller.signal }), stopPromise]);
      if (!check()) return null;
      if (reference?.outcome?.kind !== 'normal' || !reference.state) return { status: 'inconclusive' };
      expectedState = reference.state;
    }
    const instructions = indices.map((index, position) => ({ address: `0x${(0x1000 + 4 * position).toString(16)}`,
      rawBytes: [...Buffer.from(cases[index].instructionBytes, 'hex')] }));
    // Empty deletion has no instructions and both executions are the unchanged
    // entry state. It cannot preserve a defined-bit instruction mismatch.
    let observedState = structuredClone(first.initialState), observation = null;
    if (instructions.length) {
      observation = await Promise.race([Promise.resolve().then(() => subject(freeze(instructions),
        { signal: controller.signal, initialRegisters: first.initialState.registers })), stopPromise]);
      if (!check()) return null;
      if (observation?.status !== 'observed') return { status: 'inconclusive', reason: observation?.reason ?? 'missing-observation' };
      if (observation.subjectVersion !== PRODUCTION_SUBJECT_VERSION
          || observation.scope !== 'rv64-register-prefix-with-entry-state'
          || observation.instructionCount !== instructions.length
          || observation.inputDigest !== rv64RegisterPrefixInputDigest(instructions, first.initialState.registers)
          || !Array.isArray(observation.assignments) || observation.assignments.length !== indices.length
          || observation.assignments.some((row, index) => row.observable !== `register:${cases[indices[index]].operation.destination}`)) {
        return { status: 'inconclusive', reason: 'subject-input-binding-mismatch' };
      }
      const written = new Set(indices.map(index => cases[index].operation.destination));
      if (!observation.observables || Object.keys(observation.observables).length !== written.size
          || [...written].some(reg => !Object.hasOwn(observation.observables, `register:${reg}`))) {
        return { status: 'inconclusive', reason: 'incomplete-written-registers' };
      }
      for (const reg of written) observedState.registers[reg] = observation.observables[`register:${reg}`];
    }
    const comparison = compareMachineState({ expectedState, observedState, definedMask: first.definedMask });
    if (!check()) return null;
    const missing = comparison.mismatches.some(row => row.reason !== 'defined-bit-mismatch');
    return freeze({ status: missing ? 'inconclusive' : comparison.exact ? 'equivalent' : 'mismatch',
      sequenceId: identity(indices), expectedState, observedState, ...comparison,
      subjectInputDigest: observation?.inputDigest ?? null });
  };
  const preserves = comparison => comparison?.status === 'mismatch'
    && comparison.mismatches.some(row => row.reason === 'defined-bit-mismatch' && row.observable === signature);
  try {
    // A fresh caseId alone cannot bless a forged expected artifact. Check the
    // existing individual cases against the reference before interpreting them
    // as a sequence. Excluded bits remain excluded by the original mask.
    for (const row of cases) {
      if (!check()) return finish(stopped, 'reference-preflight-interrupted');
      const reference = await Promise.race([oracle.evaluate(row, { signal: controller.signal }), stopPromise]);
      if (!check()) return finish(stopped, 'reference-preflight-interrupted');
      if (!reference?.state || !compareMachineState({ expectedState: reference.state,
        observedState: row.expectedState, definedMask: row.definedMask }).exact) {
        return finish('inconclusive', 'reference-artifact-mismatch');
      }
    }
    const baseline = await compare(current);
    if (stopped) return finish(stopped, 'initial-comparison-interrupted');
    if (baseline.status === 'equivalent') return finish('not-mismatch', 'no-defined-bit-counterexample');
    if (baseline.status !== 'mismatch') return finish('inconclusive', baseline.reason ?? 'no-confirmed-defined-bit-counterexample');
    confirmed = baseline;
    signature = baseline.mismatches.find(row => row.reason === 'defined-bit-mismatch').observable;
    // Large contiguous deletions first, then repeat the one-instruction pass
    // after every accepted deletion. The latter establishes the stated local
    // fixed point even for non-monotone failures; this is not global minimality.
    for (let width = Math.max(1, Math.floor(current.length / 2)); width >= 1; width = Math.floor(width / 2)) {
      let changed;
      do {
        changed = false;
        for (let offset = 0; offset < current.length; offset += width) {
          const removed = current.slice(offset, offset + width);
          const candidate = current.filter(index => !removed.includes(index));
          const comparison = await compare(candidate);
          if (stopped) return finish(stopped, 'reduction-interrupted');
          if (comparison.status === 'inconclusive') return finish('inconclusive', 'candidate-comparison-inconclusive');
          if (preserves(comparison)) {
            steps.push({ fromSequenceId: identity(current), toSequenceId: identity(candidate), removedIndices: removed,
              observable: signature });
            current = candidate; confirmed = comparison; changed = true; break;
          }
        }
      } while (changed);
    }
    const replay = await compare(current);
    if (stopped) return finish(stopped, 'final-replay-interrupted');
    if (!preserves(replay)) return finish('inconclusive', 'final-counterexample-not-reproduced');
    confirmed = replay;
    return finish('minimized', 'defined-bit-mismatch-preserved', true);
  } catch (error) {
    return finish(stopped ?? 'inconclusive', `comparison-rejected:${String(error.message).slice(0, 160)}`);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}
