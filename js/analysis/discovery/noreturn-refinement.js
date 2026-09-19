/**
 * B1a — downstream noreturn-continuation topology refinement (read-only producer).
 *
 * Bootstrap discovery must never consume the interprocedural summary that is
 * built from its own function/entity model. This producer runs *after* a stable
 * ProgramIndex and complete local summaries exist, captures one immutable
 * binding, and returns one immutable proposal. It never mutates the symbol
 * index and never calls back into bootstrap discovery.
 *
 * The rule is deliberately narrow:
 *
 *   a continuation is proposed only when a direct call targets a
 *   locally-defined function whose interprocedural summary proves
 *   `noreturn === true` with `completeness === 'complete'`, the caller's CFG
 *   predecessor evidence for that continuation is *complete*, and the only
 *   predecessor removed by the noreturn proof is the call's ordinary
 *   fallthrough.
 *
 * Any missing, stale, partial, truncated, cancelled or unconverged evidence
 * carries no authority: the candidate is dropped, and a globally truncated
 * enumeration yields an incomplete proposal with zero authority rather than a
 * query-order-dependent prefix.
 *
 * No benchmark id, function name, fixed address or section name participates.
 */

export const NORETURN_REFINEMENT_PRODUCER = Object.freeze({
  id: 'noreturn-continuation',
  version: '1.0.0',
});
export const NORETURN_REFINEMENT_PROPOSAL_SCHEMA = 'function-topology-refinement-proposal/v1';
export const NORETURN_REFINEMENT_LIMITS = Object.freeze({
  /** Maximum candidates considered before the enumeration is declared truncated. */
  maxCandidates: 4096,
});

function asAddress(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function freezeAddress(value) {
  return typeof value === 'bigint' ? value : null;
}

function statusComplete(summary) {
  return summary != null && summary.status != null && summary.status.completeness === 'complete';
}

/**
 * Build one immutable refinement proposal from already-loaded evidence.
 *
 * @param {object} input
 * @param {object} input.binding            captured topology/analysis identity
 * @param {Iterable} input.calls            `{ site, target }` direct-call records
 * @param {object} input.authority          read-only evidence provider (see below)
 * @param {object} [input.limits]
 */
export function buildNoreturnContinuationProposal({ binding, calls, authority, limits = {} } = {}) {
  const maxCandidates = Number.isSafeInteger(limits.maxCandidates) ? limits.maxCandidates : NORETURN_REFINEMENT_LIMITS.maxCandidates;
  if (!binding || typeof binding !== 'object' || typeof authority !== 'object' || authority == null) {
    return incompleteProposal(binding, 'invalid-input');
  }
  const required = ['functionStartAt', 'isLocalFunctionStart', 'declaredEndOf', 'callInstructionEnd',
    'summaryOf', 'predecessorProof', 'isExecutable', 'isInstructionBoundary'];
  for (const method of required) {
    if (typeof authority[method] !== 'function') return incompleteProposal(binding, `authority-missing:${method}`);
  }

  const records = [];
  let considered = 0;
  let truncated = false;
  const callSource = calls == null ? [] : calls;
  let iterator;
  try {
    iterator = callSource[Symbol.iterator];
  } catch {
    return incompleteProposal(binding, 'calls-iteration-failed');
  }
  if (typeof iterator !== 'function') {
    return incompleteProposal(binding, 'calls-not-iterable');
  }
  try {
    for (const call of callSource) {
      if (considered >= maxCandidates) { truncated = true; break; }
      considered += 1;
      const site = asAddress(call?.site);
      const target = asAddress(call?.target);
      if (site == null || target == null) continue;
      const candidate = deriveCandidate({ site, target, authority });
      if (candidate) records.push(candidate);
    }
  } catch {
    return incompleteProposal(binding, 'calls-iteration-failed');
  }

  if (truncated) return incompleteProposal(binding, 'candidate-enumeration-truncated');

  records.sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1
    : left.callSite < right.callSite ? -1 : left.callSite > right.callSite ? 1 : 0));
  const deduped = [];
  const seen = new Set();
  for (const record of records) {
    const key = record.start.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }

  return Object.freeze({
    schema: NORETURN_REFINEMENT_PROPOSAL_SCHEMA,
    producer: NORETURN_REFINEMENT_PRODUCER,
    binding: Object.freeze({ ...binding }),
    status: Object.freeze({ completeness: 'complete', stopReason: null }),
    candidates: Object.freeze(deduped.map((record) => Object.freeze(record))),
  });
}

function incompleteProposal(binding, stopReason) {
  return Object.freeze({
    schema: NORETURN_REFINEMENT_PROPOSAL_SCHEMA,
    producer: NORETURN_REFINEMENT_PRODUCER,
    binding: binding && typeof binding === 'object' ? Object.freeze({ ...binding }) : null,
    status: Object.freeze({ completeness: 'incomplete', stopReason: stopReason ?? 'incomplete' }),
    candidates: Object.freeze([]),
  });
}

function deriveCandidate({ site, target, authority }) {
  // 1. The target must be a locally-defined function start, not an import,
  //    model, indirect or ambiguous target.
  if (authority.isLocalFunctionStart(target) !== true) return null;
  const callerStart = asAddress(authority.functionStartAt(site));
  if (callerStart == null || callerStart === target) return null;
  if (asAddress(authority.functionStartAt(target)) !== target) return null;

  // 2. Only a complete interprocedural summary may authorise a split, and only
  //    when it proves noreturn exactly.
  const calleeSummary = authority.summaryOf(target);
  if (!statusComplete(calleeSummary) || calleeSummary.noreturn !== true) return null;

  // 3. The continuation is the decoded end of the exact call instruction, never
  //    a hard-coded width.
  const start = asAddress(authority.callInstructionEnd(site));
  if (start == null || start <= site) return null;
  if (authority.isExecutable(start) !== true || authority.isInstructionBoundary(start) !== true) return null;
  if (authority.isLocalFunctionStart(start) === true) return null;

  // 4. The continuation must stay strictly inside the caller's own span.
  const callerEnd = asAddress(authority.declaredEndOf(callerStart));
  if (callerEnd == null || start >= callerEnd) return null;

  // 5. Complete predecessor evidence must remove only the noreturn fallthrough.
  const proof = authority.predecessorProof({ callerStart, callSite: site, callInstructionEnd: start, continuation: start });
  if (!proof || proof.complete !== true) return null;
  if (proof.hasOtherPredecessor !== false) return null;

  return {
    start,
    callerStart,
    callSite: site,
    calleeStart: target,
    callInstructionEnd: start,
    provenance: {
      source: 'noreturn-continuation-refinement',
      convention: 'post-noreturn-split',
    },
  };
}
