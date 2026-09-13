import { createWorldScope, createAssumptionSet } from '../../js/core/identity/world.js';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { createScopedJudgmentCandidate, qualifyScopedJudgment } from '../../js/core/evidence/scoped.js';
export const worldInput = () => ({
  binarySet: [{ binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', sourceIdentity: { kind: 'complete-content', sha256: 'ab'.repeat(32) }, loadMapHash: 'load-map-v1', relocationViewHash: 'relocs-v1' }],
  profile: { isaRevision: 'aarch64-v8', features: [], abi: 'aapcs64', abiRevision: 'abi-v1', osModel: 'linux', endianness: 'le', addressBits: 64, exceptionModel: 'faults-v1', memoryModel: 'memory-v1' },
  environment: { dynamicLoading: 'open', concurrency: 'unknown', interposition: 'possible', ambientState: 'ambient-v1' },
  coverage: 'coverage-v1', generation: 'generation-v1',
});
export function fixture(mutator = null) { const data = worldInput(); mutator?.(data); const world = createWorldScope(data); return { world, assumptions: createAssumptionSet({}, world) }; }
export function workFor(t, limits = {}) { const work = new ScopedAnalysisWork({ limits: { deadlineMs: 10000, ...limits } }); t.after(() => work.dispose()); return work; }
export const selector = (partition = 'all') => ({ kind: 'dispatch-targets', ownerId: 'dispatch-owner', partition });
export const member = (id = 'target-a', value = '0x1000') => ({ id, value, evidenceIds: ['evidence-' + id] });
export const envelopeInput = (members = []) => ({ domain: 'callsite-a', provenMembers: members, upper: { kind: 'finite', members, evidenceIds: ['upper-receipt'] }, closure: { status: 'closed', certificate: 'closure-receipt', frontier: [] } });
export function candidateInput(overrides = {}) { return { subject: 'subject-a', value: { result: 7 }, quantifier: 'all-admitted-executions', precision: 'exact', support: [{ kind: 'machine-derived', producer: 'producer-v1' }], obligations: [], derivation: 'derivation-a', ...overrides }; }
export function supportResolver(world, assumptions, overrides = {}) { return (_support, candidate) => ({ accepted: true, world: world.id, assumptions: assumptions.id, subject: candidate.subject, propositionMatches: true, quantifier: candidate.quantifier, precision: candidate.precision, checkerLevel: 'independent-proof-checked', ...overrides }); }
export async function qualified(f, input = {}, options = {}) { const candidate = createScopedJudgmentCandidate(candidateInput(input), f); return qualifyScopedJudgment(candidate, { ...f, resolveSupport: supportResolver(f.world, f.assumptions), ...options }); }
