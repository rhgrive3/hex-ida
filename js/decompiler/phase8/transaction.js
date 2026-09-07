import { createPassResult } from './contract.js';
import {
  attachValidatedRewriteMetadata,
  recomputeEquivalenceProofId,
  validatedRewriteMetadataFor,
} from './pass-validation.js';
import * as core from './transaction-core.js';

export {
  commitAnalysisState,
  createAnalysisState,
  forkAnalysisState,
  invalidationFor,
  seedAnalysisState,
  transactionDigest,
} from './transaction-core.js';

class RewriteRefusal extends Error {
  constructor(reason) { super(`phase8-c4-04-refusal:${reason}`); this.reason = reason; }
}

function admission(result, descriptor) {
  const transforms = [];
  const retainedIndexes = [];
  const diagnostics = [];
  for (let index = 0; index < result.transforms.length; index += 1) {
    const transform = result.transforms[index];
    const validation = transform.validation;
    if (validation == null) {
      if (transform.rewrite != null && transform.unvalidatedReason == null) throw new RewriteRefusal('rewrite-unvalidated');
      transforms.push(transform); retainedIndexes.push(index); continue;
    }
    if (validation.validation === 'refuted') throw new RewriteRefusal('rewrite-refuted');
    if (validation.validation === 'equivalent') {
      const expected = recomputeEquivalenceProofId(transform, descriptor);
      if (validation.equivalenceProofId !== expected) throw new RewriteRefusal('rewrite-proof-id-mismatch');
      transforms.push(transform); retainedIndexes.push(index); continue;
    }
    if (validation.validation === 'unknown' || validation.validation === 'unsupported') {
      const reason = validation.reason ?? validation.validation;
      diagnostics.push(Object.freeze({
        severity:'warning', code:'phase8-rewrite-not-adopted',
        message:`rewrite ${String(transform.kind)} was not adopted: ${String(reason)}`,
        reason:String(reason),
      }));
      continue;
    }
    throw new RewriteRefusal('rewrite-validation-malformed');
  }
  return { transforms, retainedIndexes, diagnostics };
}

function coreResultOf(result, descriptor, admitted) {
  const retainedChange = admitted.transforms.length > 0 || result.produced.length > 0;
  return createPassResult({
    descriptor,
    status:retainedChange ? result.status : 'unchanged',
    changed:retainedChange,
    completeness:result.completeness,
    transforms:admitted.transforms.map(({ kind, targets, proof, originRefs }) => ({ kind, targets, proof, originRefs })),
    diagnostics:[...result.diagnostics, ...admitted.diagnostics],
    invalidated:retainedChange ? result.invalidated : [],
    produced:result.produced,
    stopReason:result.stopReason,
  });
}

export function runPassTransaction(state, pass, context = {}, budget = {}) {
  let publishedMetadata = null;
  let retainedIndexes = null;
  const wrapped = {
    descriptor:pass.descriptor,
    run(passContext, passBudget, area) {
      const raw = pass.run(passContext, passBudget, area);
      const metadata = validatedRewriteMetadataFor(raw);
      if (metadata == null) return raw;
      const enriched = attachValidatedRewriteMetadata(raw, metadata);
      const admitted = admission(enriched, pass.descriptor);
      publishedMetadata = metadata;
      retainedIndexes = admitted.retainedIndexes;
      return coreResultOf(enriched, pass.descriptor, admitted);
    },
  };
  const outcome = core.runPassTransaction(state, wrapped, context, budget);
  if (!outcome.committed && typeof outcome.stopReason === 'string' && outcome.stopReason.startsWith('failed:phase8-c4-04-refusal:')) {
    const reason = outcome.stopReason.slice('failed:phase8-c4-04-refusal:'.length);
    return Object.freeze({ ...outcome, stopReason:`${reason}:${pass.descriptor.id}` });
  }
  if (!outcome.committed || publishedMetadata == null || outcome.result == null) return outcome;
  const retainedMetadata = retainedIndexes.map((index) => publishedMetadata[index]);
  const result = attachValidatedRewriteMetadata(outcome.result, retainedMetadata);
  return Object.freeze({ ...outcome, result });
}
