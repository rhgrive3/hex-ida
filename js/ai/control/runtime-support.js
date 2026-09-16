import { AIError } from '../schema.js';
import { globalCandidateAuthority } from '../../agent/candidate-authority.js';
import { canonicalBindingId, firstBinding, resolveBinaryIdentity, sameStrongIdentity } from './snapshot.js';

export function requiredScopeForTool(tool) {
  if (['search_functions','search_strings','compare_functions','lookup_known_function'].includes(tool)) return 'binary';
  if (['project_search','get_binary_diff'].includes(tool)) return 'project';
  if (['get_runtime_observations','verify_runtime_hypothesis'].includes(tool)) return 'runtime';
  if (tool === 'get_related_functions') return 'neighborhood';
  return null;
}
export function wireMeta(request, controller, intent, sessionId = null) { return { sessionId, mode: request.mode, style: request.style, scope: controller.effectiveScope, requestedScope: request.scope, effectiveScope: controller.effectiveScope, intent, task: request.task || null, responseSchema: null }; }
export function maxWireUsage(a, b) { return Object.fromEntries(Object.keys(a).map((key) => [key, Math.max(Number(a[key] || 0), Number(b[key] || 0))])); }
export function memoryAnchor(snapshot, effectiveScope, liveContext = null) {
  let runtimeSessionId = snapshot.runtimeSessionIdentity || null;
  let runtimeSessionState = snapshot.runtimeSessionState || (runtimeSessionId != null ? 'bound' : 'unknown');
  if (runtimeSessionState === 'unknown' && liveContext?.runtimeSessionKnown === true) {
    const observed = firstBinding(liveContext.runtimeSession?.id, liveContext.runtime?.sessionId, liveContext.runtimeSessionId);
    runtimeSessionId = canonicalBindingId(observed);
    runtimeSessionState = observed == null ? 'none' : runtimeSessionId == null ? 'unknown' : 'bound';
  }
  return { snapshotId: snapshot.id, binaryId: snapshot.binaryId, functionAddress: snapshot.currentFunction?.address || null, selection: snapshot.selection ? { start: snapshot.selection.start, end: snapshot.selection.end } : null, runtimeSessionId, runtimeSessionState, effectiveScope };
}
export function sessionMatchesSnapshot(session, snapshot) {
  const sessionIdentity = session.binaryIdentity || null;
  const snapshotIdentity = snapshot.binaryIdentity || null;
  const sessionRawId = session.binaryId ?? sessionIdentity?.id ?? null;
  const snapshotRawId = snapshot.binaryId ?? snapshotIdentity?.id ?? null;
  const sessionBindingId = canonicalBindingId(sessionRawId);
  const snapshotBindingId = canonicalBindingId(snapshotRawId);
  if (sessionRawId != null && sessionBindingId == null) return false;
  if (snapshotRawId != null && snapshotBindingId == null) return false;
  // An unbound session carries no positive evidence that it belongs to the
  // current binary. Treating that as a wildcard match would silently adopt
  // another binary's investigation state, so both sides must be unbound (or
  // the session must prove its binding via a verifiable legacy id) to match.
  let binaryMatches = sessionBindingId == null
    ? snapshotBindingId == null
    : sessionBindingId === snapshotBindingId;
  if (!binaryMatches) {
    const sessionStrong = strongIdentity(sessionIdentity, sessionBindingId);
    const snapshotStrong = strongIdentity(snapshotIdentity, snapshotBindingId);
    const sessionLegacy = sessionIdentity?.legacyId ?? (!sessionIdentity ? sessionBindingId : null);
    const snapshotLegacy = snapshot.legacyBinaryId ?? snapshotIdentity?.legacyId ?? null;

    // #8967: a legacy session's `filename:slice` binding is not a collision-
    // resistant proof that its bytes equal a strong snapshot's identity. When
    // the session carries no strong identity but the snapshot does, matching
    // by `sameLegacy()` promotes weak string equality into a strong binary
    // identity and lets a byte-different file with the same name hydrate the
    // prior conversation/confirmed findings across binaries. Fail closed; only
    // symmetric legacy↔legacy comparisons (no strong upgrade) keep the old
    // compatibility behaviour.
    if (!sessionStrong && snapshotStrong) binaryMatches = false;
    else if (!sessionStrong && !snapshotStrong) binaryMatches = sameLegacy(sessionLegacy, snapshotLegacy);
    else binaryMatches = false;
  }
  const sessionProjectId = canonicalBindingId(session.projectId);
  const snapshotProjectId = canonicalBindingId(snapshot.projectIdentity);
  if (session.projectId != null && sessionProjectId == null) return false;
  if (snapshot.projectIdentity != null && snapshotProjectId == null) return false;
  const projectMatches = session.projectId == null
    ? snapshot.projectIdentity == null
    : sessionProjectId === snapshotProjectId;
  const priorAnchor = session.investigationMemory?.anchor || null;
  const priorRuntimeRaw = priorAnchor?.runtimeSessionId ?? null;
  const priorRuntime = canonicalBindingId(priorRuntimeRaw);
  const priorRuntimeState = priorAnchor?.runtimeSessionState || (priorRuntimeRaw != null ? 'bound' : 'unknown');
  const snapshotRuntime = canonicalBindingId(snapshot.runtimeSessionIdentity);
  const snapshotRuntimeState = snapshot.runtimeSessionState || (snapshot.runtimeSessionIdentity != null ? 'bound' : 'unknown');
  let runtimeMatches = true;
  if (priorRuntimeState === 'bound') runtimeMatches = priorRuntime != null && snapshotRuntimeState === 'bound' && snapshotRuntime != null && priorRuntime === snapshotRuntime;
  else if (priorRuntimeState === 'none') runtimeMatches = snapshotRuntimeState === 'none';
  return binaryMatches && projectMatches && runtimeMatches;
}
export function assertLiveBindingsUnchanged(local, snapshot) {
  const live = resolveBinaryIdentity(local, {});
  const expectedLive = snapshot.binaryIdentitySource === 'request-fallback'
    ? (snapshot.liveBinaryIdentity || null)
    : (snapshot.binaryIdentity || null);
  const expectedId = snapshot.binaryIdentitySource === 'request-fallback'
    ? expectedLive?.id
    : snapshot.binaryId;
  const expectedLegacy = snapshot.binaryIdentitySource === 'request-fallback'
    ? expectedLive?.legacyId
    : snapshot.legacyBinaryId;
  const sameId = live.id === expectedLive?.id;
  const liveStrong = strongIdentity(live, live.id);
  const expectedStrong = strongIdentity(expectedLive, expectedId);
  const same = liveStrong && expectedStrong
    ? sameStrongIdentity(live, expectedLive, local)
    : !liveStrong && !expectedStrong && (sameId || sameLegacy(live.legacyId, expectedLegacy));
  if (!same) throw new AIError('scope_violation', 'The binary changed while this AI turn was running; refusing to mix workbench states.');
  const liveProject = firstBinding(local.projectId, local.project?.id, local.project?.binaryHash);
  if (!sameNullableBinding(liveProject, snapshot.projectIdentity)) {
    throw new AIError('scope_violation', 'The project changed while this AI turn was running; refusing to mix workbench states.');
  }
  const liveRuntime = firstBinding(local.runtimeSession?.id, local.runtime?.sessionId, local.runtimeSessionId);
  const liveRuntimeKnown = local.runtimeSessionKnown === true || liveRuntime != null;
  const liveRuntimeBinding = canonicalBindingId(liveRuntime);
  const liveRuntimeState = liveRuntimeKnown ? (liveRuntime == null ? 'none' : liveRuntimeBinding == null ? 'invalid' : 'bound') : 'unknown';
  const snapshotRuntime = canonicalBindingId(snapshot.runtimeSessionIdentity);
  const snapshotRuntimeState = snapshot.runtimeSessionState || (snapshot.runtimeSessionIdentity != null ? 'bound' : 'unknown');
  if (snapshotRuntimeState === 'bound') {
    if (liveRuntimeState !== 'bound' || snapshotRuntime == null || liveRuntimeBinding !== snapshotRuntime) {
      throw new AIError('scope_violation', 'The runtime session changed while this AI turn was running; refusing to mix workbench states.');
    }
  } else if (snapshotRuntimeState === 'none' && liveRuntimeState !== 'none') {
    throw new AIError('scope_violation', 'The runtime session changed while this AI turn was running; refusing to mix workbench states.');
  }
}
export function compactCandidate(candidate) { return { address: addressString(candidate.address), name: candidate.name, lexicalScore: candidate.lexicalScore, semanticScore: candidate.semanticScore, graphScore: candidate.graphScore, evidenceScore: candidate.evidenceScore, runtimeScore: candidate.runtimeScore, totalScore: candidate.totalScore, reasons: candidate.reasons }; }
export function deterministicDecision(plan, request, error = null) {
  if (error?.type === 'cancelled') return { type: 'final', answer: humanError(error), confidence: 0, evidenceIds: [], hypothesisIds: [], suggestedActions: [], followups: [] };
  const best = plan?.best;
  if (best) {
    const address = addressString(best.address);
    const verified = best.verification?.verified === true;
    // #8673: the planner's own coverage state, not the local verification flag,
    // decides whether this turn may claim a terminal strongest-candidate result.
    const authority = globalCandidateAuthority(plan);
    const label = best.name || address;
    const answer = authority.authoritative
      ? `最も強い候補は ${label} です。Hex の決定論的 planner が候補を順位付けし、${verified ? '更新経路を検証しました。' : '追加検証が必要です。'}`
      : `暫定的な最有力候補は ${label} です。Hex の決定論的 planner が候補を順位付けし、${verified ? 'その候補の更新経路を局所的に検証しました' : '候補の順位付けまで完了しました'}が、候補探索または意味解析が未完了のため、最も強い候補の確定は保留しています。`;
    // A plan that went through EvidenceStore.ingestPlan() carries the exact
    // canonical record set it produced. Citing raw planner source IDs would
    // never resolve against those records, so the deterministic fallback must
    // consume the published binding when one exists (#8864).
    const evidenceIds = Array.isArray(plan.evidenceRecordIds) ? plan.evidenceRecordIds : (plan.evidence || []);
    return { type: 'final', answer, confidence: deterministicConfidence(plan), evidenceIds, hypothesisIds: [], suggestedActions: address ? [{ kind: 'open-function', target: address, label: '候補関数を開く' }] : [], followups: plan.missingEvidence || [] };
  }
  return { type: 'final', answer: error ? humanError(error) : (request.mode === 'chat' ? '利用できるローカル根拠だけでは回答を確定できませんでした。' : '有力な候補を特定できませんでした。'), confidence: 0, evidenceIds: [], suggestedActions: [], followups: plan?.missingEvidence || [] };
}
/**
 * Publish the canonical evidence binding for one plan.
 *
 * `EvidenceStore.ingestPlan()` projects a plan's raw source IDs into canonical
 * `ev_<digest>` records, so finalization cannot consume `plan.evidence`
 * directly. The turn executor calls this immediately after ingestion so the
 * current plan carries the exact canonical record set it produced (#8864).
 */
export function withPlanEvidenceBinding(plan, records) {
  if (!plan || typeof plan !== 'object') return plan;
  const ids = [];
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const id = typeof record?.id === 'string' && record.id ? record.id : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ...plan, evidenceRecordIds: ids };
}

const MAX_FALLBACK_EVIDENCE = 50;

const CLAIM_ADDRESS_PATTERN = /0x[0-9a-fA-F]{1,16}/g;

/**
 * Canonical addresses the final answer actually asserts.
 *
 * A verified record proves its own subject, not an arbitrary sentence that
 * happens to cite it (#9009). Only literal `0x…` tokens count, so this stays a
 * deterministic typed check instead of a textual-entailment guess.
 */
export function claimedAddresses(...texts) {
  const claimed = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.match(CLAIM_ADDRESS_PATTERN) || []) claimed.add(match.toLowerCase());
  }
  return claimed;
}

function recordSubjects(record) {
  const subjects = new Set();
  for (const value of [record?.functionAddress, record?.address]) {
    if (value == null) continue;
    try { subjects.add(`0x${BigInt(value).toString(16)}`); } catch { subjects.add(String(value).toLowerCase()); }
  }
  return subjects;
}

/**
 * Records that carry the authority a final answer presents.
 *
 * `supported` planner ranking is useful provenance but it is not proof, so it
 * may not satisfy the evidence requirement that lifts the evidence-free
 * confidence cap (#8864). A `verified` record additionally has to prove the
 * subject the answer asserts: a genuine `0x1000` proof cited under a claim about
 * `0xDEAD` is provenance for a different fact, not authority for it (#9009).
 * Nothing proves an address-free claim is unsupported, so that case keeps the
 * pre-#9009 contract (#5159, #8864).
 */
export function qualifyingEvidence(evidence, claimAddresses = null) {
  const verified = (Array.isArray(evidence) ? evidence : []).filter((item) => item?.status === 'verified');
  if (!(claimAddresses instanceof Set) || !claimAddresses.size) return verified;
  const covering = verified.filter((item) => {
    const subjects = recordSubjects(item);
    for (const address of claimAddresses) if (subjects.has(address)) return true;
    return false;
  });
  // Fail closed when the citation set does not cover every asserted address:
  // quantity of unrelated verified records cannot substitute for the proof of
  // the specific claim (#9009 acceptance 5).
  const covered = new Set();
  for (const item of covering) for (const subject of recordSubjects(item)) covered.add(subject);
  for (const address of claimAddresses) if (!covered.has(address)) return [];
  return covering;
}

/**
 * Claim-authorizing evidence for one final decision.
 *
 * Provider/model prose is untrusted authority input. When it asserts no typed
 * subject that Hex can bind deterministically, merely selecting a real
 * `verified` record cannot make an arbitrary address-free sentence terminal
 * (#9009). Deterministic first-party fallbacks retain the historical
 * address-free contract because their claim is produced by Hex from the plan,
 * not authored by the provider.
 */
export function finalAnswerAuthorityEvidence(
  evidence,
  claimAddresses = null,
  { providerControlled = false, allowAddressFreeDeterministicFallback = false } = {},
) {
  const hasTypedClaim = claimAddresses instanceof Set && claimAddresses.size > 0;
  if (providerControlled && !hasTypedClaim && !allowAddressFreeDeterministicFallback) return [];
  return qualifyingEvidence(evidence, claimAddresses);
}

/**
 * Substitute evidence for a decision that made no explicit citation.
 *
 * Only records bound to the *current* plan qualify, and only at the authority
 * the presentation claims: a `supported` planner ranking record must never
 * satisfy a confirmed-evidence check or lift the evidence-free confidence cap.
 * The former session-wide `sourceTool === 'deterministic-goal-planner'` scan is
 * removed because it re-attached earlier turns' records to unrelated answers
 * (#8864). A turn with no planner result at all keeps the #5159 verified-session
 * projection.
 */
export function fallbackEvidence(store, plan) {
  if (plan && typeof plan === 'object') {
    const bound = typeof store.planEvidence === 'function' ? store.planEvidence(plan, { verifiedOnly: false }) : [];
    return bound.slice(0, MAX_FALLBACK_EVIDENCE);
  }
  return store.all().filter((item) => item.status === 'verified').slice(-MAX_FALLBACK_EVIDENCE);
}
export function deterministicConfidence(plan) {
  const staticConfidence = plan?.best?.semanticFacts?.length ? 0.78 : 0.45;
  // A positive local verification is not global coverage proof: the 0.98
  // terminal authority requires the planner/candidate/semantic coverage state
  // to be complete as well (#8673).
  if (plan?.best?.verification?.verified === true) return globalCandidateAuthority(plan).authoritative ? 0.98 : staticConfidence;
  if (plan?.best?.semanticFacts?.length) return 0.78;
  return plan?.best ? 0.45 : 0;
}
export function presentAnswer(answer, style, evidence, plan, claimAddresses = null, authorityEvidence = null) {
  if (style === 'analyst') return answer;
  const verified = Array.isArray(authorityEvidence)
    ? authorityEvidence.length
    : qualifyingEvidence(evidence, claimAddresses).length;
  const unverified = Math.max(0, (evidence || []).length - verified);
  // Beginner prose must not call a merely `supported` ranking record a
  // confirmed fact (#8864), and must not call an unrelated verified fact
  // confirmation of what the answer asserts (#9009).
  const suffix = verified
    ? `\n\nHex が確認できた根拠は ${verified} 件です。${unverified ? ` 未検証の補強根拠も ${unverified} 件添付しています。` : ''}`
    : (unverified
      ? '\n\nこの回答には、Hex が確認済みにした根拠がまだありません（添付は未検証の補強根拠のみです）。'
      : '\n\nこの回答には、Hex が確認済みにした根拠がまだありません。');
  return `${answer}${suffix}${plan?.missingEvidence?.length ? ` 次に確認する点: ${plan.missingEvidence.slice(0, 3).join('、')}。` : ''}`;
}
export function defaultMonotonicNow() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch { /* fall through to the wall clock */ }
  return Date.now();
}
export function resolveMonotonicClock(...candidates) {
  for (const candidate of candidates) if (typeof candidate === 'function') return candidate;
  return defaultMonotonicNow;
}
// A caller-supplied clock is still an authority input. Freeze each turn's
// observation to a finite, non-decreasing primitive so a clock correction
// cannot extend a deadline or make elapsed time negative.
export function createMonotonicClock(clock = defaultMonotonicNow) {
  let last = null;
  return () => {
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) return last ?? 0;
    if (last == null || value > last) last = value;
    return last;
  };
}

function elapsedSince(started, nowFn) {
  const now = nowFn();
  if (typeof now !== 'number' || !Number.isFinite(now)
      || typeof started !== 'number' || !Number.isFinite(started)) return 0;
  return Math.max(0, now - started);
}

export function ensureRunning(signal, started, timeoutMs, nowFn = defaultMonotonicNow) {
  if (signal?.aborted) {
    throw new AIError(
      signal.reason === 'timeout' ? 'budget_exhausted' : 'cancelled',
      signal.reason === 'timeout' ? 'The AI investigation timed out.' : 'The AI investigation was cancelled.',
    );
  }
  if (elapsedSince(started, nowFn) >= timeoutMs) {
    throw new AIError('budget_exhausted', 'The AI investigation timed out.');
  }
}

export function remainingTime(started, timeoutMs, nowFn = defaultMonotonicNow) {
  const elapsed = elapsedSince(started, nowFn);
  return Math.max(1, Math.min(timeoutMs, timeoutMs - elapsed));
}
export function normalizeError(error, signal) { if (error instanceof AIError) return error; if (signal?.aborted || error?.name === 'AbortError') return new AIError(signal?.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal?.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.'); return new AIError('provider_error', error?.message || String(error), providerDiagnostics(error)); }
export function providerDiagnostics(error) { const details = error instanceof AIError ? error.details : error; const provider = safeDiagnosticToken(details?.provider, /^[a-z][a-z0-9-]{0,63}$/); const bridgeCode = safeDiagnosticToken(details?.bridgeCode ?? error?.code, /^[A-Za-z0-9_.-]{1,64}$/); const bridgeStage = safeDiagnosticToken(details?.bridgeStage ?? error?.stage, /^[a-z][a-z0-9-]{0,63}$/); const runtimeBuildId = safeDiagnosticToken(details?.runtimeBuildId, /^[a-f0-9]{1,64}$/i); const out = {}; if (provider) out.provider = provider; if (bridgeCode) out.bridgeCode = bridgeCode; if (bridgeStage) out.bridgeStage = bridgeStage; if (runtimeBuildId) out.runtimeBuildId = runtimeBuildId; return Object.keys(out).length ? out : null; }
function safeDiagnosticToken(value, pattern) { return typeof value === 'string' && pattern.test(value) ? value : null; }
const BRIDGE_DIAGNOSTIC_MESSAGES = Object.freeze({
  'manual-interference': 'The submitted ChatGPT turn does not match the Hex request.',
  'conversation-switched': 'The active ChatGPT conversation changed while Hex was waiting.',
  'already-active': 'Another Hex ChatGPT request is already active.',
  'response-error': 'ChatGPT reported an error for the active response.',
  'page-error': 'ChatGPT reported a page-level error for the active request.',
  timeout: 'ChatGPT response capture timed out.',
  RPC_UNSAFE_RESULT: 'The ChatGPT bridge rejected an unsafe RPC result.',
});
function safeBridgeDiagnosticMessage(code) { return code ? BRIDGE_DIAGNOSTIC_MESSAGES[code] || null : null; }
export function visibleProviderDiagnostics(error) {
  if (error?.type !== 'provider_error' && error?.type !== 'model_timeout') return '';
  const diagnostics = providerDiagnostics(error);
  if (!diagnostics) return '';
  const lines = ['Hex AI diagnostics:'];
  if (diagnostics.provider) lines.push(`provider: ${diagnostics.provider}`);
  if (diagnostics.bridgeCode) lines.push(`code: ${diagnostics.bridgeCode}`);
  if (diagnostics.bridgeStage) lines.push(`stage: ${diagnostics.bridgeStage}`);
  if (diagnostics.runtimeBuildId) lines.push(`runtimeBuildId: ${diagnostics.runtimeBuildId}`);
  const message = safeBridgeDiagnosticMessage(diagnostics.bridgeCode);
  if (message) lines.push(`message: ${message}`);
  return lines.join('\n');
}
export function humanError(error) {
  const labels = { cancelled: '解析を停止しました。保存済みの証拠とセッションは保持されています。', budget_exhausted: '解析予算または時間上限に達しました。得られた根拠までを返します。', context_too_large: 'provider へ送る入力全体が安全な上限を超えたため、送信前に停止しました。', model_timeout: 'モデル応答が時間内に完了しませんでした。ローカル解析結果は保持されています。', provider_error: 'AI provider を利用できませんでした。ローカル解析結果は保持されています。', invalid_model_output: 'モデル出力を安全に検証できませんでした。', invalid_tool_call: 'モデルが要求したツール呼び出しを検証できませんでした。', scope_violation: '指定された解析範囲を越える要求を拒否しました。', tool_failed: 'Hex ツールの実行に失敗しました。' };
  const label = labels[error?.type] || error?.message || 'AI 解析を完了できませんでした。';
  const diagnostics = visibleProviderDiagnostics(error);
  return diagnostics ? `${label}\n\n${diagnostics}` : label;
}
export function raceAbort(promise, signal, fallback = false) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(fallback);
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}
export function addressExistsSync(context, address) {
  if (typeof context.addressExists === 'function') {
    try {
      const result = context.addressExists(address);
      if (typeof result === 'boolean') return result;
      if (result && typeof result.then === 'function') return null;
      return false;
    } catch { return false; }
  }
  try {
    if (context.program?.functionRange) return !!context.program.functionRange(BigInt(address));
    if (context.symbols?.functionAt) return !!context.symbols.functionAt(BigInt(address));
  } catch { return false; }
  return true;
}
// An `addressExists` capability is authoritative when present: both explicit
// false and schema-invalid/non-boolean results must fail closed. Program/symbol
// fallback is used only when that capability is absent (#5790).
export async function addressExistsAsync(context, address, signal = null) {
  if (typeof context.addressExists === 'function') {
    try {
      const result = await raceAbort(context.addressExists(address), signal, false);
      return typeof result === 'boolean' ? result : false;
    } catch { return false; }
  }
  return addressExistsSync(context, address);
}
export function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
export function addressString(value) { try { return `0x${BigInt(value).toString(16)}`; } catch { return null; } }

function strongIdentity(identity, id) {
  const value = id == null ? canonicalBindingId(identity?.id) : canonicalBindingId(id);
  if (canonicalBindingId(identity?.hash) != null) return true;
  if (typeof value === 'string' && value.startsWith('content:')) return true;
  return identity?.confidence === 'strong' && identity?.state === 'ready' && typeof value === 'string' && !value.startsWith('fallback:');
}
function sameLegacy(a, b) {
  const left = canonicalBindingId(a), right = canonicalBindingId(b);
  return left != null && right != null && left === right;
}
function sameNullableBinding(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const left = canonicalBindingId(a), right = canonicalBindingId(b);
  return left != null && right != null && left === right;
}
