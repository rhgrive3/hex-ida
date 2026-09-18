/** Compatibility entry point for the canonical Phase 8 proof-plan authority. */
export {
  PROOF_REWRITE_PASS,
  preparePhase8RewritePlan,
  isPhase8RewritePlan,
  runProofRewritePass,
  proofAdmissionReason,
  proofPublicationResult,
  readProvedRewrites,
  readProvedInputBindings,
} from './pass-validation.js';
