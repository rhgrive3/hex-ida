/**
 * js/symbolic/index.js
 *
 * Public entrypoint for Hex Symbolic and Solver-backed Verification subsystem.
 */

export * from './executor.js';
export * from './function-sandbox.js';
export * as expr from './expr/index.js';
export * as translate from './translate/index.js';
export * as solver from './solver/index.js';
export * as evidence from './evidence/index.js';
export * as verify from './verify/index.js';
export { createByteMemory, joinByteMemory } from './memory/byte-memory.js';
export { createTaintModels } from './taint/models.js';
export { queryTaint, isTaintQueryResult } from './query/taint.js';
export { projectTaint } from './projection/taint.js';
export { verifyDeobfuscationCandidate, isAdoptableCandidate } from './taint/proof-consumer.js';
export { semanticValueIdentity } from './memory/value-identity.js';
export { isExecutionSnapshot } from './memory/execution-snapshot.js';
export { queryDeobfuscationCandidates } from './query/deobfuscation.js';
export { querySymbolicAnalysis, isSymbolicAnalysisResult } from './query/analysis.js';

export { projectedMemoryAccessContext } from '../semantics/compat/semantic-ir-v2-to-v1-memory.js';
export { queryMemoryEquivalence, isAdoptableMemoryEquivalence } from './query/memory-equivalence.js';

export { queryEqualitySaturation } from './query/equality-saturation.js';
