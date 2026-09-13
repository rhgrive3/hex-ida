/** Replay an ACTUAL bounded native projection. The worker proposes snapshots;
 * this independent kernel checks their typed expressions, final statement map
 * and canonical memory view/retained-event forwarding receipts. Hashes only name
 * fragments. No optimizer, renderer or machine lifter is imported here.
 */
import { stableDigest, stableStringify, lossyTypeWitness, deepFreeze } from '../identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import { recordFields, contractFail, snapshotContractData } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { checkBitvectorViewRelation, BV_VIEW_PROOF_RULE, BV_VIEW_PROOF_VERSION } from './bv-view-proof.js';
import { checkMemoryViewFrame } from './memory-transform-frame.js';
import { normalizeTransformReceipt, explainTransformChain, TRANSFORM_RECEIPT_SCHEMA } from './transform-chain.js';
import { CertificateCheckerRegistry } from './certificate.js';
import { checkMemoryTransformRelation, normalizeMemoryTransformProgram, MEMORY_TRANSFORM_RULE, MEMORY_TRANSFORM_VERSION } from './memory-transform-proof.js';
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });

/** Replay value-forwarding receipts emitted by the actual native owner. The
 * inherited canonical events stay explicit; rendering may still omit them. */
async function explainNativeMemoryTransforms(capture, view, { world, assumptions, snapshotId, functionId,
  producerArtifactId, current, work, includePremises }) {
  const base = { exact: false, renderedEventPreservation: 'unproved', wholeFunctionProof: false,
    scope: 'canonical-memory-values-with-inherited-machine-events' };
  if (!capture) return { ...base, status: 'unknown', verifiedStepCount: 0, remaining: ['memory-transform-capture-unavailable'] };
  if (capture.schema !== 'canonical-memory-transform-capture/v1' || capture.worldId !== world.id
    || capture.snapshotId !== snapshotId || capture.functionId !== functionId || capture.proofStatus !== 'not-checked'
    || !Array.isArray(capture.steps) || capture.steps.length > 32) contractFail('native-memory-transform-capture-binding');
  if (!capture.steps.length) return { ...base, status: 'unknown', verifiedStepCount: 0, remaining: capture.remaining };
  const nodes = new Map(), receipts = [];
  const first = normalizeMemoryTransformProgram(capture.steps[0].before, { work });
  const observable = { inputBindings: first.inputs.map(row => row.id), outputs: first.outputs,
    memoryFootprint: `all-touched-byte-ranges:${digest(first.operations.filter(op => op.range).map(op => op.range))}`,
    eventModel: 'retained-canonical-events-with-exception-prefix-memory', faults: 'preserve-all-declared-fault-and-exception-prefixes',
    termination: 'preserve', fpEnvironment: 'no-FP-rule', concurrencyModel: first.concurrency };
  for (const step of capture.steps) {
    work.checkpoint(); work.charge('workUnits');
    const before = normalizeMemoryTransformProgram(step.before, { work }), after = normalizeMemoryTransformProgram(step.after, { work });
    const fragment = p => ({ artifactId: producerArtifactId, ownerDigest: p.id, semanticIrVersion: p.schema,
      entityIds: p.outputs.length ? p.outputs : [p.functionId], byteRangeIds: [] });
    const receipt = normalizeTransformReceipt({ schema: TRANSFORM_RECEIPT_SCHEMA,
      worldId: world.id, assumptionsId: assumptions.id, snapshotId, functionId, binaryId: view.binaryId,
      before: fragment(before), after: fragment(after), ruleId: MEMORY_TRANSFORM_RULE, ruleVersion: MEMORY_TRANSFORM_VERSION,
      ownerVersion: capture.schema, observable, claim: 'equivalent', sourceReceipts: receipts.length ? [receipts.at(-1).id] : [],
      obligations: [], queryHash: null, evidenceId: step.sourceReceipt?.identity?.digest ?? null }, { world, assumptions, snapshotId, functionId });
    receipts.push(receipt); nodes.set(receipt.id, { receipt, step, before, after });
  }
  const registry = new CertificateCheckerRegistry();
  registry.register({ id: 'scpa-native-memory-transform', version: MEMORY_TRANSFORM_VERSION,
    semanticKind: 'decompiler-transform', level: 'derivation-checked', execution: 'local-bounded', check: node => {
      if (!current()) contractFail('native-transform-owner-stale');
      const row = nodes.get(node.id), fact = row.step.sourceReceipt;
      const read = row.before.operations.find(op => op.id === fact?.useId && op.kind === 'read');
      const forwarded = row.after.operations.find(op => op.id === `${fact?.useId}:forwarded-value` && op.kind === 'copy');
      const forwardedBytes = fact && typeof fact.value === 'bigint' && Number.isSafeInteger(fact.widthBits)
        && fact.widthBits > 0 && fact.widthBits <= 128 && fact.widthBits % 8 === 0
        ? Array.from({ length: fact.widthBits / 8 }, (_, i) => Number((fact.value >> BigInt(i * 8)) & 255n)) : null;
      const bound = fact?.artifactDigest === capture.ownerDigest && row.before.ownerDigest === capture.ownerDigest
        && row.after.ownerDigest === capture.ownerDigest && fact.proofKind === 'canonical-memoryssa-byte-forwarding'
        && fact.status === 'exact' && fact.completeness === 'complete' && fact.proofVersion === '1.0.0'
        && row.step.ruleId === 'canonical-memoryssa-value-forwarding-with-retained-events'
        && row.step.ruleVersion === fact.proofVersion && row.step.claim === 'equivalent-with-inherited-machine-events'
        && read && forwarded && forwarded.target === read.target && forwardedBytes && typed(forwarded.value) === typed(forwardedBytes)
        && fact.widthBits === read.range.bytes * 8 && fact.endian === read.endian
        && fact.useId === row.step.canonicalSource?.useId && fact.artifactDigest === row.step.canonicalSource?.artifactDigest
        && typed(fact.contributingDefinitionIds) === typed(row.step.canonicalSource?.contributingDefinitionIds)
        && Array.isArray(row.step.statementBindings) && row.step.statementBindings.length > 0
        && row.step.statementBindings.every(binding => {
          const final = view.finalStatements[binding.index];
          return final && final.text === binding.text && typed(final.source) === typed(binding.source);
        });
      const check = bound && world.environment.concurrency !== 'single-thread'
        ? { status: 'unknown', reason: 'memory-transform-concurrency-not-qualified' }
        : bound ? checkMemoryTransformRelation(row.before, row.after, { worldId: world.id, snapshotId, functionId, work })
        : { status: 'rejected', reason: 'native-memory-transform-source-or-statement-binding' };
      return { ...check, worldId: world.id, assumptionsId: assumptions.id, nodeId: node.id, propositionChecked: true,
        detail: { scope: base.scope, memoryOptimization: false, valueProjectionChanged: check.valueProjectionChanged ?? false,
          renderedEventPreservation: 'unproved', ...(check.firstFailure ? { firstFailure: check.firstFailure } : {}) } };
    } });
  const chain = await explainTransformChain({ functionId, stepIds: receipts.map(row => row.id), includePremises }, {
    world, assumptions, snapshotId, work, checkers: registry,
    resolveReceipt: id => nodes.has(id) ? { data: nodes.get(id).receipt, isCurrent: current } : null });
  return deepFreeze({ ...base, status: 'completed', chain,
    verifiedStepCount: chain.checks.filter(row => row.status === 'verified').length,
    statementIndices: [...new Set(capture.steps.flatMap(step => step.statementIndices))],
    remaining: [...new Set([...(capture.remaining ?? []), ...chain.remaining, 'C-rendered-memory-event-preservation-unproved'])] });
}

export function checkNativeTransformRelation(relation, { finalStatements, memoryFrame, worldId, snapshotId, functionId, work } = {}) {
  const r = snapshotContractData(relation, { allowBigInt: true, maxNodes: 16384, maxBytes: 1048576 });
  recordFields(r, ['before', 'after', 'beforeStatement', 'afterStatement', 'statementId', 'statementIndex', 'mapping'], 'native-transform-relation-fields');
  const before = r.beforeStatement, after = r.afterStatement;
  const statement = finalStatements?.[r.statementIndex];
  const reject = reason => ({ status: 'rejected', reason, exact: false, renderingEquivalence: 'unproved' });
  if (!Number.isSafeInteger(r.statementIndex) || r.statementIndex < 0 || r.statementIndex >= 128
    || r.statementId !== `phase8-statement:${r.statementIndex}` || !before || !after || !statement
    || before.index !== r.statementIndex || after.index !== r.statementIndex || statement.index !== r.statementIndex
    || before.statementKind !== after.statementKind || statement.statementKind !== after.statementKind
    || typed(before.expression) !== typed(r.before) || typed(after.expression) !== typed(r.after)
    || typed(before.location) !== typed(after.location) || typed(after.location) !== typed(statement.location)
    || typed(before.source) !== typed(after.source) || typed(after.source) !== typed(statement.source)
    || statement.text !== after.text) return reject('final-statement-mapping-mismatch');
  const pure = checkBitvectorViewRelation(r.before, r.after, { work });
  if (pure.reason !== 'memory-frame-required') return { ...pure, statementMapping: 'bound-to-final-index-source-and-text' };
  if (!memoryFrame) return { ...pure, reason: 'memory-frame-unavailable' };
  const frame = checkMemoryViewFrame(memoryFrame, { worldId, snapshotId, functionId, work });
  if (frame.status !== 'verified') return { ...frame, exact: false, renderingEquivalence: 'unproved' };
  const relationCheck = checkBitvectorViewRelation(r.before, r.after, { work, allowMemory: true });
  return { ...relationCheck, statementMapping: 'bound-to-final-index-source-and-text', memoryFrame: frame.status };
}

export async function explainNativeTransformProjection(view, { world, assumptions, snapshotId, functionId,
  producerArtifactId, isCurrent, work, includePremises = false } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  if (typeof isCurrent !== 'function' || isCurrent() !== true) contractFail('native-transform-owner-stale');
  const current = () => { work.checkpoint(); return isCurrent() === true; };
  if (view?.schema !== 'scoped-local-owner-projection/v1' || view.kind !== 'transforms' || view.version !== '1.0.0'
    || view.worldId !== world.id || view.assumptionsId !== assumptions.id || view.snapshotId !== snapshotId
    || view.functionId !== functionId || view.producerArtifactId !== producerArtifactId
    || !world.binarySet.some(member => member.binaryId === view.binaryId)) contractFail('native-transform-projection-binding');
  if (view.status !== 'completed') return { status: 'unsupported', reason: view.reason ?? 'native-transform-projection-unavailable', exact: false };
  const capture = view.capture;
  const base = { schema: 'scoped-native-transform-explanation/v1', worldId: world.id, assumptionsId: assumptions.id,
    snapshotId, functionId, producerArtifactId, exact: false, wholeFunctionProof: false,
    sourceBinding: view.sourceBinding, semanticKernelQualification: 'separate-obligation',
    scope: 'actual-Phase8-expression-view-relations; not-all-passes-or-C-equivalence',
    publication: 'read-only; does-not-accept-rewrites-or-publish-canonical-facts' };
  if (!capture || capture.schema !== 'phase8-transform-capture/v1' || capture.scope !== 'phase8-expression-view-only'
    || capture.proofStatus !== 'not-checked' || !Array.isArray(capture.relations) || capture.relations.length > 128
    || !Array.isArray(view.finalStatements) || view.finalStatements.length > 128) {
    return deepFreeze({ ...base, status: 'unknown', statements: [], remaining: ['native-transform-capture-unavailable'] });
  }
  const statements = [], ids = new Set();
  for (const relation of capture.relations) {
    if (!current()) contractFail('native-transform-owner-stale');
    work.charge('results'); work.charge('workUnits');
    if (ids.has(relation.statementId)) contractFail('native-transform-duplicate-statement');
    ids.add(relation.statementId);
    const fragment = expression => ({ artifactId: producerArtifactId, ownerDigest: digest(expression),
      semanticIrVersion: 'typed-expression-view/v1', entityIds: [relation.statementId], byteRangeIds: [] });
    const receipt = normalizeTransformReceipt({ schema: TRANSFORM_RECEIPT_SCHEMA,
      worldId: world.id, assumptionsId: assumptions.id, snapshotId, functionId, binaryId: view.binaryId,
      before: fragment(relation.before), after: fragment(relation.after), ruleId: BV_VIEW_PROOF_RULE,
      ruleVersion: BV_VIEW_PROOF_VERSION, ownerVersion: 'phase8-transform-capture/v1', claim: 'equivalent',
      observable: { inputBindings: ['identical-typed-symbolic-inputs'], outputs: [relation.statementId],
        memoryFootprint: 'identical-opaque-loads-and-canonical-MSSA-if-present', eventModel: 'expression-tree-order',
        faults: 'preserve-identical-opaque-events-only', termination: 'preserve', fpEnvironment: 'no-FP-rule',
        concurrencyModel: 'no-event-reorder-or-duplication' },
      sourceReceipts: [], obligations: [], queryHash: null, evidenceId: null }, { world, assumptions, snapshotId, functionId });
    // Private invocation-local checker: the payload cannot supply callbacks or
    // choose a stronger proof level. Canonical interpretation is a premise, so
    // this composition deliberately stays at derivation-checked.
    const registry = new CertificateCheckerRegistry();
    let firstFailure = null;
    registry.register({ id: 'scpa-native-typed-view', version: BV_VIEW_PROOF_VERSION,
      semanticKind: 'decompiler-transform', level: 'derivation-checked', execution: 'local-bounded',
      check: node => {
        if (!current()) contractFail('native-transform-owner-stale');
        const check = checkNativeTransformRelation(relation, { finalStatements: view.finalStatements,
          memoryFrame: view.memoryFrame, worldId: world.id, snapshotId, functionId, work });
        firstFailure = check.firstFailure ?? null;
        return { ...check, worldId: world.id, assumptionsId: assumptions.id, nodeId: node.id, propositionChecked: true,
          detail: { scope: check.scope ?? 'statement-mapping', exact: false, renderingEquivalence: 'unproved',
            ...(check.memoryFrame ? { memoryFrame: check.memoryFrame } : {}) } };
      } });
    const chain = await explainTransformChain({ functionId, stepIds: [receipt.id], includePremises }, {
      world, assumptions, snapshotId, work, checkers: registry,
      resolveReceipt: id => id === receipt.id ? { data: receipt, isCurrent: current } : null });
    statements.push({ statementId: relation.statementId, statementIndex: relation.statementIndex,
      beforeText: relation.beforeStatement.text, afterText: relation.afterStatement.text,
      source: relation.afterStatement.source, chain, ...(firstFailure ? { firstFailure } : {}) });
    await work.yieldIfNeeded();
  }
  if (!current()) contractFail('native-transform-owner-stale');
  const memoryTransforms = await explainNativeMemoryTransforms(view.memoryTransforms, view, {
    world, assumptions, snapshotId, functionId, producerArtifactId, current, work, includePremises });
  if (!current()) contractFail('native-transform-owner-stale');
  return deepFreeze({ ...base, status: 'completed', statements,
    memoryTransforms, verifiedMemoryTransformCount: memoryTransforms.verifiedStepCount,
    verifiedStatementCount: statements.filter(s => s.chain.status === 'conditionally-verified').length,
    remaining: [...new Set([...(view.remaining ?? []), ...(capture.remaining ?? []),
      ...statements.flatMap(statement => statement.chain.remaining ?? []),
      'whole-function-equivalence-unproved', 'C-rendering-equivalence-unproved',
      ...(statements.length ? [] : ['no-captured-expression-view-changes'])])], cost: work.cost() });
}
