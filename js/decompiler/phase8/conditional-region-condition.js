/** Prove a direct branch's proposed display predicate, then re-lower the proved
 * canonical term. Arbitrary C text and candidate ASTs never authorize a write.
 * Publication belongs to the existing committed region transaction/projection.
 */
import { stableDigest } from '../../core/identity/index.js';
import { createProjectionIrObserver } from '../../core/identity/live-data.js';
import { queryRecord } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, sameMemoryIdentity, QueryFailure } from '../../symbolic/memory/query-state.js';
import { createTaintModels } from '../../symbolic/taint/models.js';
import { readConditionalRegionStructure } from './conditional-region-structure.js';
import { readCopiedConditionalRegions } from '../pipeline-core.js';
import { readSemanticConditionalRegion } from '../semantic-core.js';
import { compileProofExpression, renderProofExpression } from './proof-expression.js';
import { children, mergeSource } from '../ast/nodes.js';
import { printExpression } from '../pretty/c.js';

const issued = new WeakMap();
const MODELS = createTaintModels({ id:'phase8-condition-empty', version:'1',
  provenance:'hex.phase8.explicit-empty-model/v1', sources:[], sinks:[] });
const LIMITS = Object.freeze({ workItems:262144, allocationUnits:131072 });
const OPTIONS = new Set(['identity','timeoutMs','limits','signal','isCancelled','getCurrentIdentity','now',
  'addressBits','endian','backendTier']);

export function readConditionalRegionCondition(plan, projection, structure, identity) {
  const entry = issued.get(plan);
  try {
    if (!entry || entry.projection !== projection || entry.structure !== structure
      || !sameMemoryIdentity(entry.guard.identity, identity)) return null;
    return entry.isCurrent() ? entry.packet : null;
  } catch { return null; }
}

export async function prepareConditionalRegionCondition(structure, projection, options = {}) {
  let guard;
  const reject = reason => Object.freeze({ version:1, status:'partial', reason, transformAuthorization:false });
  try {
    const submitted = queryRecord(options);
    if (Object.keys(submitted).some(key => !OPTIONS.has(key))) return reject('unsupported-condition-option');
    guard = createQueryGuard(submitted, LIMITS); guard.check();
    const ir = projection?.ir, region = structure?.region;
    if (!readConditionalRegionStructure(structure, ir, guard.identity)) return reject('unissued-or-stale-structure');
    const [{ isProducerProjection, readProducerInputExpressions, producerExpressionToken },
      { readProjectedConditionalRegions, readProjectedConditionConsumer, readProjectedRegionControl },
      { querySymbolicAnalysis, readSymbolicTargetInputs },
      { lowerDirectBranchCondition }, { compileRepresentationProposal },
      { verifyDeobfuscationCandidate, isAdoptableCandidate }, E] = await Promise.all([
      import('../pipeline.js'), import('./projection.js'), import('../../symbolic/query/analysis.js'),
      import('../../symbolic/translate/scalar.js'), import('./representation-candidates.js'),
      import('../../symbolic/taint/proof-consumer.js'), import('../../symbolic/expr/index.js'),
    ]);
    guard.check();
    if (!isProducerProjection(projection)) return reject('unprepared-condition-projection');
    const carrierOf = () => readProjectedConditionalRegions(projection.cAst, ir)
      || (projection.phase8Projection == null ? readCopiedConditionalRegions(projection.cAst, ir) : null);
    const carrier = carrierOf();
    const copied = carrier?.regions.find(item => item.original === region);
    const proposal = readProjectedConditionConsumer(projection, region.branch);
    const control = copied && readProjectedRegionControl(projection, region.branch, copied.header, region.header);
    if (!copied || !proposal || !control || !['if-else','one-sided-if'].includes(region.selection.form)) {
      return reject('unbound-condition-producer');
    }
    const branch = region.branch;
    if (!['cbz','cbnz','tbz','tbnz'].includes(branch.extra?.kind) || branch.args?.length !== 1) {
      return reject('unsupported-condition-semantics');
    }
    const target = branch.args[0].value;
    const observation = createProjectionIrObserver().captureCertifiedData([projection.cAst, projection.semanticAst]);
    guard.take('workItems', observation.metrics.edges); guard.take('allocationUnits', observation.metrics.edges);
    const timeout = () => Math.max(0, Math.floor(guard.remainingMilliseconds()));
    // Reserve the existing query's translation, execution and flow allowances
    // separately. A small outer allowance cannot hide a larger child query.
    const analysisLimits = { workItems:32768, allocationUnits:16384, targets:1, candidates:0 };
    const memoryLimits = { workItems:65536, allocationUnits:32768 };
    const flowLimits = { workItems:32768, latticeValues:1024, flowEdges:4096, emittedRecords:2048 };
    guard.take('workItems', analysisLimits.workItems + memoryLimits.workItems + flowLimits.workItems);
    guard.take('allocationUnits', analysisLimits.allocationUnits + memoryLimits.allocationUnits
      + 8 * flowLimits.latticeValues + flowLimits.flowEdges + flowLimits.emittedRecords);
    const query = await querySymbolicAnalysis(ir, { identity:guard.identity, targets:[target], models:MODELS,
      candidateStrategy:'translate-only', timeoutMs:timeout(), analysisLimits, limits:flowLimits,
      memory:{ addressBits:submitted.addressBits ?? 64, endian:submitted.endian ?? 'little', limits:memoryLimits },
      signal:submitted.signal, isCancelled:submitted.isCancelled, getCurrentIdentity:submitted.getCurrentIdentity });
    guard.check();
    const binding = readSymbolicTargetInputs(query, target, guard.identity);
    if (!binding) return reject(query.reason ?? 'unbound-condition-inputs');
    const inputs = readProducerInputExpressions(projection, binding.inputs.map(input => input.value));
    if (!inputs || inputs.some(input => input.expression.kind !== 'var')) return reject('unbound-condition-display-inputs');
    const tokens = new Map();
    for (const [index, input] of inputs.entries()) {
      if (tokens.has(input.token) && tokens.get(input.token) !== binding.inputs[index].symbol) return reject('ambiguous-condition-input');
      tokens.set(input.token, binding.inputs[index].symbol);
    }
    const inputMap = new Map(), seen = new Set(), pending = [proposal.condition.expression];
    while (pending.length) {
      guard.take('workItems');
      const node = pending.pop();
      if (!node || seen.has(node)) continue;
      if (seen.size >= 2048) throw new QueryFailure('condition-proposal-bound');
      seen.add(node); guard.take('allocationUnits');
      if (node.kind === 'var') inputMap.set(node, tokens.get(producerExpressionToken(projection, node)));
      else pending.push(...children(node));
    }
    let before = lowerDirectBranchCondition(branch, binding.expression);
    if (before.kind === 'unknown_semantic') return reject(before.reason);
    const proposed = compileRepresentationProposal(proposal.condition.expression, inputMap, guard);
    if (proposed.sort.kind !== 'bv' || proposed.sort.width !== 1) return reject('condition-proposal-width');
    let after = E.createCompare('ne', proposed, E.createBv(1, 0n));
    if (region.selection.invert) { before = E.createConnective('not', before); after = E.createConnective('not', after); }
    const beforeHash = E.computeStructuralHash(before), afterHash = E.computeStructuralHash(after);
    guard.take('workItems', 100000);
    const verification = await verifyDeobfuscationCandidate({ before, after,
      candidateId:`condition:${afterHash}`, beforeValueId:`condition:${branch.id}`, afterValueId:`display-condition:${branch.id}`,
      identity:guard.identity, preconditions:[], correspondence:{ inputs:[] }, memoryObservables:[], effectObservables:[],
      backendTier:submitted.backendTier ?? 'tiered', timeoutMs:timeout(), signal:submitted.signal,
      isCancelled:submitted.isCancelled, getCurrentIdentity:submitted.getCurrentIdentity });
    guard.check();
    if (!isAdoptableCandidate(verification, { identity:guard.identity })) return reject(verification.reason ?? 'condition-not-equivalent');
    const recipe = compileProofExpression(after, binding, guard);
    if (!recipe) return reject('condition-lowering-unavailable');
    const rendered = renderProofExpression(recipe, inputs.map(input => input.expression), () => { guard.check(); return false; });
    if (!rendered || rendered.bits !== 1 || rendered.effect !== 'pure') return reject('condition-render-unavailable');
    const expression = { ...rendered, source:mergeSource(rendered.source, proposal.condition.expression.source, copied.header.source) };
    const text = `if (${printExpression(expression)}) {`;
    const outputObservation = createProjectionIrObserver().captureCertifiedData([expression]);
    guard.take('workItems', outputObservation.metrics.edges); guard.take('allocationUnits', outputObservation.metrics.edges);
    const sourceCurrent = () => isAdoptableCandidate(verification, { identity:guard.identity })
        && isProducerProjection(projection)
        && readSemanticConditionalRegion(region.record, ir) === region
        && carrierOf() === carrier
        && readProjectedConditionConsumer(projection, branch)?.consumer === proposal.consumer
        && readProjectedRegionControl(projection, branch, copied.header, region.header) === control
        && outputObservation.matches() && observation.matches();
    const isCurrent = () => {
      guard.check();
      return readConditionalRegionStructure(structure, ir, guard.identity)
        && readSymbolicTargetInputs(query, target, guard.identity) === binding && sourceCurrent();
    };
    if (!isCurrent()) return reject('stale-condition-proof');
    const queryHash = verification.evidence.queryHash;
    const planId = stableDigest({ kind:'proved-conditional-predicate', identity:guard.identity, beforeHash, afterHash,
      branchId:branch.id, invert:region.selection.invert, queryHash });
    const plan = Object.freeze({ version:1, status:'complete', planId, beforeHash, afterHash, queryHash,
      scope:'conditional-predicate-only', transformAuthorization:false, conditionValidation:'proved', identity:guard.identity });
    const packet = Object.freeze({ header:copied.header, expression, text, recipe, consumer:proposal.consumer, control,
      plan, isCurrent, sourceCurrent });
    issued.set(plan, { projection, structure, guard, packet, isCurrent });
    return plan;
  } catch (error) { return reject(guard?.reason() ?? error.reason ?? 'condition-proof-unavailable'); }
}
