/** Replay an ACTUAL bounded native projection. The worker proposes snapshots;
 * this independent kernel checks their typed expressions, final statement map
 * and (where necessary) unchanged canonical memory frame. Hashes only name
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
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
const digest = value => stableDigest({ value, typed: lossyTypeWitness(value) });

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
  return deepFreeze({ ...base, status: 'completed', statements,
    verifiedStatementCount: statements.filter(s => s.chain.status === 'conditionally-verified').length,
    remaining: [...new Set([...(view.remaining ?? []), ...(capture.remaining ?? []),
      ...statements.flatMap(statement => statement.chain.remaining ?? []),
      'whole-function-equivalence-unproved', 'C-rendering-equivalence-unproved',
      ...(statements.length ? [] : ['no-captured-expression-view-changes'])])], cost: work.cost() });
}
