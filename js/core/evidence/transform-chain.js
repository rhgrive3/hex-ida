/**
 * Composition of existing pass-local verification receipts. This module NEVER
 * rewrites IR/AST, mints a solver theorem, or treats a content digest as proof.
 * It checks a bounded dependency DAG and asks the existing host checker registry
 * to replay each relation against its canonical fragments/observables.
 */
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import { snapshotContractData, recordFields, exactString, exactEnum, stringSet, contractFail } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { CertificateCheckerRegistry } from './certificate.js';

export const TRANSFORM_RECEIPT_SCHEMA = 'scoped-transform-receipt/v1';
export const TRANSFORM_COMPOSITION_SCHEMA = 'scoped-transform-composition/v1';
export const TRANSFORM_COMPOSITION_VERSION = '1.0.0';
const SEMANTIC_CHECK_LEVELS = new Set(['derivation-checked', 'solver-validated', 'independent-proof-checked']);
const CHECK_RANK = Object.freeze({ 'derivation-checked': 1, 'solver-validated': 2, 'independent-proof-checked': 3 });
const equalData = (a, b) => stableStringify(a) === stableStringify(b)
  && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));

/** Opaque IDs refer to canonical footprint/environment artifacts, not AST text. */
export function normalizeTransformObservables(value) {
  const input = snapshotContractData(value, { maxNodes: 2048, maxBytes: 65536 });
  recordFields(input, ['inputBindings', 'outputs', 'memoryFootprint', 'eventModel', 'faults', 'termination',
    'fpEnvironment', 'concurrencyModel'], 'transform-observable-fields');
  return deepFreeze({ inputBindings: stringSet(input.inputBindings, 'transform-input-bindings', 128),
    outputs: stringSet(input.outputs, 'transform-output-bindings', 128),
    memoryFootprint: exactString(input.memoryFootprint, 'transform-memory-footprint'),
    eventModel: exactString(input.eventModel, 'transform-event-model'), faults: exactString(input.faults, 'transform-fault-model'),
    termination: exactEnum(input.termination, ['preserve', 'bounded-only', 'unproved'], 'transform-termination'),
    fpEnvironment: exactString(input.fpEnvironment, 'transform-fp-environment'),
    concurrencyModel: exactString(input.concurrencyModel, 'transform-concurrency-model') });
}
function fragment(value) {
  recordFields(value, ['artifactId', 'ownerDigest', 'semanticIrVersion', 'entityIds', 'byteRangeIds'], 'transform-fragment-fields');
  const entityIds = stringSet(value.entityIds, 'transform-fragment-entities', 1024);
  if (!entityIds.length) contractFail('transform-fragment-empty');
  return { artifactId: exactString(value.artifactId, 'transform-fragment-artifact'),
    ownerDigest: exactString(value.ownerDigest, 'transform-fragment-digest'),
    semanticIrVersion: exactString(value.semanticIrVersion, 'transform-semantic-ir-version'), entityIds,
    byteRangeIds: stringSet(value.byteRangeIds, 'transform-fragment-byte-ranges', 128) };
}

/** Normalization establishes identity/integrity ONLY. Accepted receipts stay in their existing owner. */
export function normalizeTransformReceipt(value, { world, assumptions, snapshotId, functionId } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world);
  const input = snapshotContractData(value, { allowBigInt: true, maxNodes: 8192, maxBytes: 262144 });
  recordFields(input, ['schema', 'id', 'worldId', 'assumptionsId', 'binaryId', 'functionId', 'snapshotId',
    'before', 'after', 'ruleId', 'ruleVersion', 'ownerVersion', 'observable', 'claim', 'sourceReceipts',
    'obligations', 'queryHash', 'evidenceId'], 'transform-receipt-fields');
  if (input.schema !== TRANSFORM_RECEIPT_SCHEMA || input.worldId !== world.id || input.assumptionsId !== assumptions.id
    || input.snapshotId !== snapshotId || input.functionId !== functionId
    || !world.binarySet.some((member) => member.binaryId === input.binaryId)) contractFail('transform-receipt-world-binding');
  const body = { schema: TRANSFORM_RECEIPT_SCHEMA, worldId: world.id, assumptionsId: assumptions.id,
    binaryId: input.binaryId, functionId: exactString(input.functionId, 'transform-function'), snapshotId,
    before: fragment(input.before), after: fragment(input.after),
    ruleId: exactString(input.ruleId, 'transform-rule'), ruleVersion: exactString(input.ruleVersion, 'transform-rule-version'),
    ownerVersion: exactString(input.ownerVersion, 'transform-owner-version'),
    observable: normalizeTransformObservables(input.observable),
    claim: exactEnum(input.claim, ['equivalent', 'refines', 'bounded-equivalent'], 'transform-claim'),
    sourceReceipts: stringSet(input.sourceReceipts, 'transform-source-receipts', 64),
    obligations: stringSet(input.obligations, 'transform-obligations', 128),
    queryHash: input.queryHash === null ? null : exactString(input.queryHash, 'transform-query-hash'),
    evidenceId: input.evidenceId === null ? null : exactString(input.evidenceId, 'transform-evidence-id') };
  const id = createEntityId({ binaryId: input.binaryId, kind: TRANSFORM_RECEIPT_SCHEMA,
    identity: { version: TRANSFORM_COMPOSITION_VERSION, body } });
  if (input.id !== undefined && input.id !== id) contractFail('transform-receipt-id-mismatch');
  if (body.sourceReceipts.includes(id)) contractFail('transform-receipt-self-dependency');
  return deepFreeze({ ...body, id });
}

/**
 * Main-chain order is explicit and preserved; premise nodes are topologically
 * replayed once. All steps use exactly one observable contract in v1. Wider
 * framing/loop proofs are UNKNOWN rather than silently generalized.
 */
export async function explainTransformChain(request, { world, assumptions, snapshotId, work,
  resolveReceipt = null, checkers = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  recordFields(request, ['functionId', 'stepIds', 'includePremises'], 'transform-chain-query-fields');
  const functionId = exactString(request.functionId, 'transform-chain-function');
  if (!Array.isArray(request.stepIds) || !request.stepIds.length || request.stepIds.length > 64) contractFail('transform-chain-step-count');
  const stepIds = request.stepIds.map((id) => exactString(id, 'transform-chain-step'));
  if (new Set(stepIds).size !== stepIds.length) contractFail('transform-chain-repeated-main-step');
  if (request.includePremises !== undefined && typeof request.includePremises !== 'boolean') contractFail('transform-chain-premises-option');
  if (!resolveReceipt) return { status: 'unsupported', reason: 'canonical-transform-receipt-owner-unbound', exact: false };
  if (checkers !== null && !(checkers instanceof CertificateCheckerRegistry)) contractFail('transform-checker-registry-required');
  const checkerRevision = checkers?.revision ?? null;
  const checkMembership = () => {
    if (checkers && checkers.revision !== checkerRevision) contractFail('transform-checker-membership-changed');
  };
  const nodes = new Map(), currents = new Map(), missing = new Set(), order = [], colors = new Map();
  const remaining = new Set(), cycles = [];
  for (const root of stepIds) {
    const stack = [{ id: root, position: 0, loaded: false }];
    while (stack.length) {
      work.checkpoint(); work.charge('workUnits');
      if (stack.length > 64) contractFail('transform-receipt-depth-budget');
      const frame = stack.at(-1);
      if (!frame.loaded) {
        if (colors.get(frame.id) === 'done' || missing.has(frame.id)) { stack.pop(); continue; }
        if (!nodes.has(frame.id)) {
          if (nodes.size + missing.size >= 256) contractFail('transform-receipt-node-budget');
          const context = await work.await((signal) => resolveReceipt(frame.id, { functionId, world, assumptions, snapshotId, signal, work }));
          if (!context) { missing.add(frame.id); remaining.add('receipt-owner-record-missing'); stack.pop(); continue; }
          if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('transform-receipt-owner-not-current');
          const receipt = normalizeTransformReceipt(context.data, { world, assumptions, snapshotId, functionId });
          if (receipt.id !== frame.id || context.isCurrent() !== true) contractFail('transform-receipt-resolver-binding');
          work.charge('nodes'); work.charge('residentBytes', stableStringify(receipt).length * 2 + 128);
          nodes.set(frame.id, receipt); currents.set(frame.id, context.isCurrent);
        }
        colors.set(frame.id, 'active'); frame.loaded = true;
      }
      const node = nodes.get(frame.id);
      if (frame.position >= node.sourceReceipts.length) {
        colors.set(frame.id, 'done'); order.push(frame.id); stack.pop(); continue;
      }
      const child = node.sourceReceipts[frame.position++];
      if (colors.get(child) === 'active') {
        if (cycles.length < 64) cycles.push({ from: frame.id, to: child });
        remaining.add('cyclic-proof-dependency'); continue;
      }
      if (colors.get(child) !== 'done' && !missing.has(child)) stack.push({ id: child, position: 0, loaded: false });
      await work.yieldIfNeeded();
    }
  }
  const checkRows = new Map();
  for (const id of order) {
    const receipt = nodes.get(id); work.checkpoint(); checkMembership();
    if (currents.get(id)() !== true) contractFail('transform-receipt-stale-before-replay');
    let result = { status: 'unknown', reason: 'transform-semantic-checker-unbound', checker: null };
    const unresolved = receipt.sourceReceipts.filter((dependency) => checkRows.get(dependency)?.status !== 'verified');
    for (const obligation of receipt.obligations) remaining.add(obligation);
    if (cycles.length) result = { ...result, reason: 'cyclic-proof-dependency' };
    else if (unresolved.length) result = { ...result, reason: 'premise-not-semantically-verified' };
    else if (receipt.obligations.length) result = { ...result, reason: 'receipt-has-open-obligations' };
    else if (checkers) {
      // Reuses the existing registry. Its handler must actually recheck the
      // fragments, query, assumptions and all observable dimensions. The
      // transport binding and digest above never satisfy this obligation.
      result = await checkers.check(deepFreeze({ ...receipt, semanticKind: 'decompiler-transform' }),
        { world, assumptions, snapshotId, receipt,
          premises: receipt.sourceReceipts.map((dependency) => ({ receipt: nodes.get(dependency), check: checkRows.get(dependency) })) }, work);
      if (result.status === 'verified' && !SEMANTIC_CHECK_LEVELS.has(result.checker?.level)) result = {
        ...result, status: 'unknown', reason: 'integrity-only-is-not-transform-proof' };
    }
    checkMembership();
    if (currents.get(id)() !== true) contractFail('transform-receipt-changed-during-replay');
    checkRows.set(id, deepFreeze({ ...result, receiptId: id, unresolvedPremises: unresolved }));
    if (result.status !== 'verified') remaining.add(result.reason ?? 'transform-replay-unverified');
    await work.yieldIfNeeded();
  }
  const chain = stepIds.map((id) => nodes.get(id)).filter(Boolean), mainChecks = stepIds.map((id) => checkRows.get(id));
  const observable = chain[0]?.observable ?? null;
  for (let index = 0; index < chain.length; index++) {
    const node = chain[index];
    if (!equalData(node.observable, observable)) remaining.add('observable-contract-changed-between-passes');
    if (index && !equalData(chain[index - 1].after, node.before)) remaining.add('transform-fragment-chain-disconnected');
    if (node.claim === 'refines') remaining.add('refinement-does-not-establish-symmetric-equivalence');
    if (node.observable.termination === 'unproved') remaining.add('termination-observable-unproved');
  }
  if (chain.length !== stepIds.length) remaining.add('main-chain-receipt-missing');
  const rejected = mainChecks.some((check) => check?.status === 'rejected');
  const verified = chain.length === stepIds.length && !remaining.size && mainChecks.every((check) => check?.status === 'verified');
  const bounded = [...nodes.values()].some((node) => node.claim === 'bounded-equivalent' || node.observable.termination === 'bounded-only');
  // The composition is no stronger than its weakest PREMISE checker as well
  // as its visible pass checkers; a hidden derivation may not be laundered into
  // an independent proof level by an independently checked final link.
  const minimumCheck = verified ? [...checkRows.values()].reduce((level, check) => CHECK_RANK[check.checker.level] < CHECK_RANK[level] ? check.checker.level : level,
    'independent-proof-checked') : null;
  checkMembership();
  for (const current of currents.values()) if (current() !== true) contractFail('transform-receipt-stale-before-publication');
  const body = snapshotContractData({ schema: TRANSFORM_COMPOSITION_SCHEMA, version: TRANSFORM_COMPOSITION_VERSION,
    worldId: world.id, assumptionsId: assumptions.id, snapshotId, functionId,
    status: rejected ? 'rejected' : verified ? 'conditionally-verified' : 'unknown',
    classification: rejected ? 'UNSUPPORTED' : verified ? 'CONDITIONALLY_PROVEN' : 'UNSUPPORTED',
    scope: bounded ? 'bounded-equivalence-only' : 'declared-observable-contract',
    exact: false, globalStaticTruth: false, semanticKernelQualification: 'separate-obligation',
    before: chain[0]?.before ?? null, after: chain.at(-1)?.after ?? null, observable, minimumCheck,
    stepIds, receipts: request.includePremises === true ? order.map((id) => nodes.get(id)) : chain,
    checks: request.includePremises === true ? order.map((id) => checkRows.get(id)) : mainChecks.map((row) => row ?? null),
    missing: [...missing], cycles, remaining: [...remaining].sort(),
    publication: 'read-only; no IR rewrite, pass acceptance, or canonical fact mutation' },
  { allowBigInt: true, maxNodes: 262144, maxBytes: 4 * 1024 * 1024 });
  work.charge('residentBytes', stableStringify(body).length * 2); work.checkpoint();
  return deepFreeze({ ...body, id: createEntityId({ binaryId: world.binarySet[0].binaryId, kind: TRANSFORM_COMPOSITION_SCHEMA,
    identity: { digest: stableDigest({ body, typed: lossyTypeWitness(body) }) } }), cost: work.cost() });
}
