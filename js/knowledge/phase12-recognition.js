import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { importPhase12Package } from '../phase12/package-envelope.js';

export const RECOGNITION_ALGORITHM_VERSION = 'hex-recognition-phase12-v1';
export const MATCH_TIERS = Object.freeze(['exact-content', 'relocation-normalized', 'structural', 'semantic', 'capability']);

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function tierRank(value) { const index = MATCH_TIERS.indexOf(value); return index < 0 ? MATCH_TIERS.length : index; }

export function createMatchResult(input = {}) {
  const sourceEntityId = String(input.sourceEntityId || input.entityId || '').trim();
  const packageEntryId = String(input.packageEntryId || input.entryId || '').trim();
  if (!sourceEntityId || !packageEntryId) throw new TypeError('recognition source and package identities are required');
  if (Array.isArray(input.candidates) && input.candidates.length === 0) throw new TypeError('recognition candidates are required');
  const candidates = (Array.isArray(input.candidates) ? input.candidates : [{ ...input, sourceEntityId, packageEntryId }]).map((candidate) => ({
    sourceEntityId: String(candidate.sourceEntityId || sourceEntityId),
    packageEntryId: String(candidate.packageEntryId || candidate.entryId || packageEntryId),
    tier: MATCH_TIERS.includes(candidate.tier) ? candidate.tier : 'semantic',
    score: clamp(candidate.score ?? candidate.confidence),
    confidence: clamp(candidate.confidence ?? candidate.score),
    featuresUsed: list(candidate.featuresUsed || candidate.features),
    conflictingFeatures: list(candidate.conflictingFeatures || candidate.conflicts),
    evidenceIds: list(candidate.evidenceIds || candidate.evidence),
    packageContentHash: String(candidate.packageContentHash || input.packageContentHash || ''),
  })).sort((a, b) => b.score - a.score || tierRank(a.tier) - tierRank(b.tier) || a.packageEntryId.localeCompare(b.packageEntryId));
  const top = candidates[0];
  const second = candidates[1] || null;
  const rawAmbiguityWindow = Number(input.ambiguityWindow ?? 0.035);
  const ambiguityWindow = Number.isFinite(rawAmbiguityWindow) ? Math.max(0, rawAmbiguityWindow) : 0.035;
  const ambiguityMargin = second ? Math.max(0, top.score - second.score) : 1;
  const candidateSearchTruncated = input.candidateSearchTruncated === true || input.truncated === true || input.candidateSearch?.truncated === true;
  const ambiguous = candidateSearchTruncated || !!second && ambiguityMargin <= ambiguityWindow;
  const result = {
    id: `match:${stableDigest({ sourceEntityId, packageEntryId: top.packageEntryId, packageContentHash: top.packageContentHash, algorithm: RECOGNITION_ALGORITHM_VERSION })}`,
    sourceEntityId,
    packageEntryId: top.packageEntryId,
    tier: top.tier,
    score: top.score,
    confidence: top.confidence,
    ambiguityMargin,
    featuresUsed: top.featuresUsed,
    conflictingFeatures: top.conflictingFeatures,
    algorithmVersion: RECOGNITION_ALGORITHM_VERSION,
    packageContentHash: top.packageContentHash || null,
    evidenceIds: top.evidenceIds,
    completeness: candidateSearchTruncated ? 'partial' : 'complete',
    candidateSearchTruncated,
    candidateCount: candidates.length,
    candidates,
    unique: !ambiguous,
    status: ambiguous ? 'ambiguous' : 'suggestion',
    authority: 'L2-suggestion',
    externalConfirmation: input.externalConfirmation || null,
  };
  return deepFreeze(result);
}

export function recognitionCanClaimUnique(result) {
  return !!result && result.unique === true && result.candidateSearchTruncated !== true && result.completeness === 'complete' && result.conflictingFeatures.length === 0;
}

export async function recognizeWithKnowledgeDB({ db, input, packageEnvelope = null, options = {} } = {}) {
  if (!db || typeof db.findMatches !== 'function') throw new TypeError('knowledge database is required');
  const packageHash = packageEnvelope?.contentHash || null;
  const matches = await db.findMatches(input, options);
  const candidates = matches.map((match) => ({
    sourceEntityId: input.sourceEntityId || input.entityId || input.address || 'unknown-entity',
    packageEntryId: match.record.identityKey || match.record.id,
    tier: match.identity === 'exact' ? 'exact-content' : match.identity === 'normalized' ? 'relocation-normalized' : match.identity === 'structural' ? 'structural' : 'semantic',
    score: match.confidence,
    confidence: match.confidence,
    featuresUsed: match.reasons,
    evidenceIds: match.evidence?.map((item) => item.id || item.ref || stableDigest(item)),
    packageContentHash: packageHash,
  }));
  if (!candidates.length) return Object.freeze({ status: 'no-match', completeness: matches.truncated ? 'partial' : 'complete', candidateSearchTruncated: matches.truncated === true, candidates: [] });
  return createMatchResult({ ...input, packageContentHash: packageHash, candidates, candidateSearchTruncated: matches.truncated === true, ambiguityWindow: options.ambiguityWindow });
}

// Host-held approval authority for L4 promotion (#5216, review R2–R5): a
// plain { approved:true, targetMatchId } self-declaration is not approval
// evidence, and neither is any caller-fabricated authority — a duck-typed
// { consumeGrant(){…} } option or an importer of this module must not be
// able to mint approval. Three boundaries make issuance real rather than
// self-asserted:
// 1. The realm's platform Event boundary, captured once at module evaluation
//    (host boot): approval gestures must be real platform Events whose
//    browser-managed isTrusted internal slot is true — read through the
//    captured Event.prototype getters so an own-property shadow
//    (`Object.defineProperty(ev, 'isTrusted', { value: true })`) cannot forge
//    them, and so a caller-built plain object ({ type:'click',
//    isTrusted:true }) can never pass (it is not a platform Event at all).
//    User-agent dispatched gestures are the only Events whose isTrusted slot
//    is true, so code running in the page cannot fabricate one.
// 2. Approval surfaces are module-minted and match-bound before any gesture
//    can reach them (review R5 + R2): an arbitrary trusted click observed
//    elsewhere (navigation, another panel, any unrelated button) must not be
//    launderable into an approval for an attacker-chosen result — and
//    neither may a caller-chosen surface, which would let untrusted code
//    redefine what the user clicked on. The module therefore hands out
//    neither an "issue a grant for this event" nor an "attach this control
//    to that element" seam: `Event.isTrusted` proves that user input
//    happened, never what it meant. `createRecognitionApprovalControl(
//    result, …)` MINTS the approval surface itself (a real DOM button in
//    the browser; the trusted runner's EventTarget stand-in under test),
//    registers the delivery handler on it module-internally, and exposes
//    the surface read-only for the host UI to mount. A gesture can mint
//    only when the platform DELIVERS it to that exact module-minted surface
//    (the captured `Event.prototype.currentTarget` getter reports the
//    surface during delivery only): forwarding an event captured on another
//    surface fails live and on replay, and because neither `attach()` nor
//    `handleEvent` is exposed, no importer can transplant the delivery
//    handler onto an unrelated element — a genuine trusted click on a
//    navigation button can never reach the approval authority. Whatever UI
//    mounts the module's own approval button for a match, a
//    platform-delivered trusted click ON THAT BUTTON is the user activating
//    the approval control for that match; a hostile UI that deceptively
//    places it is browser-security/clickjacking territory, outside any
//    in-page JS authority.
// 3. Consumption is module-private and re-verifies the host project binding
//    current at consumption time (review R4): a record minted under one
//    binding cannot be spent after the host re-binds, and an unbound record
//    cannot be spent under any binding. Records are single-use; match id,
//    target entity, package identity/hash, algorithm version, actor identity
//    and interaction type are all verified from the minted record.
// The Node test harness (and the phase12 denominator behavior probe) is the
// trusted-runner domain: it runs this module in a realm whose platform Event
// API is a stand-in that can mark gestures trusted exactly where the browser
// would (tests/phase12/knowledge/harness-event-realm.mjs and
// tools/validation/phase12/recognition-probe-realm.mjs). Replacing
// globalThis.Event before host boot is out of the threat model: that is
// pre-application code execution, the same trust tier as the host bundle
// itself; post-boot replacement cannot affect the captured references.
const APPROVAL_INTERACTION_TYPES = new Set(['click', 'pointerdown', 'pointerup', 'keydown']);

const HOST_EVENT = typeof Event === 'function' ? Event : null;
const HOST_EVENT_IS_TRUSTED_GETTER = HOST_EVENT
  ? Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted')?.get ?? null
  : null;
const HOST_EVENT_CURRENT_TARGET_GETTER = HOST_EVENT
  ? Object.getOwnPropertyDescriptor(Event.prototype, 'currentTarget')?.get ?? null
  : null;

function createRecognitionApprovalAuthority() {
  // matchId -> minted approval record. Single-use, keyed to the match.
  const approved = new Map();
  let projectBinding = null;
  return deepFreeze({
    configureHost({ projectBinding: binding = null } = {}) {
      if (binding != null) {
        const text = String(binding).trim();
        if (!text) throw new TypeError('recognition approval project binding must be a non-empty string');
        projectBinding = text;
      } else {
        projectBinding = null;
      }
    },
    hostProjectBinding() { return projectBinding; },
    // A trusted approval gesture delivered to the control's surface: a real
    // platform Event, browser-trusted, of a direct gesture type, and
    // currently being delivered BY THE PLATFORM to exactly that surface.
    // A trusted approval gesture delivered to the control's surface: a real
    // platform Event, browser-trusted, of a direct gesture type, delivered
    // to exactly that surface, while the host carries a project binding
    // (review R2 round 5: an unbound record must never exist — the issue
    // requires the project/binary binding as part of the approval
    // authority's identity, so minting fails closed while the host has not
    // bound a project yet; the control stays armed for the real gesture).
    requireTrustedDelivery(event, surface) {
      if (!HOST_EVENT || !HOST_EVENT_IS_TRUSTED_GETTER || !HOST_EVENT_CURRENT_TARGET_GETTER) throw new TypeError('recognition approval is unavailable in this realm: no platform Event API');
      if (!event || typeof event !== 'object') throw new TypeError('recognition approval requires the user interaction event of a direct approval gesture');
      if (!(event instanceof HOST_EVENT)) throw new TypeError('recognition approval requires the platform Event of a direct approval gesture; caller-built objects are not approval evidence');
      if (HOST_EVENT_IS_TRUSTED_GETTER.call(event) !== true) throw new TypeError('recognition approval requires a browser-trusted user interaction; synthetic events are not approval evidence');
      if (HOST_EVENT_CURRENT_TARGET_GETTER.call(event) !== surface) throw new TypeError('recognition approval requires the gesture to be delivered to this approval surface; events observed on other UIs are not approval evidence');
      if (!APPROVAL_INTERACTION_TYPES.has(event.type)) throw new TypeError('recognition approval requires a direct approval gesture (click/pointer/keydown), not an indirect event');
      if (projectBinding == null) throw new TypeError('recognition approval requires the host project/binary binding to be configured before an approval can be minted');
    },
    // Mint the approval record from a verified control delivery. The record
    // never leaves this module as data.
    recordApproval(result, { actorId, interactionType }) {
      if (!result || result.authority !== 'L2-suggestion' || !result.id) throw new TypeError('recognition suggestion required');
      const actor = String(actorId || '').trim();
      if (!actor) throw new TypeError('local approving actor identity is required');
      // A fresh trusted gesture re-arms the approval: an unconsumed stale
      // record (e.g. left behind by a failed consumption after a host
      // re-bind) is replaced by the latest verified gesture. Consumption
      // itself stays single-use, and only a real delivery can mint.
      const record = deepFreeze({
        matchId: result.id,
        sourceEntityId: result.sourceEntityId,
        packageEntryId: result.packageEntryId,
        packageContentHash: result.packageContentHash ?? null,
        algorithmVersion: result.algorithmVersion,
        actorId: actor,
        interactionType: String(interactionType || ''),
        projectBinding,
      });
      approved.set(result.id, record);
      return record;
    },
    consumeFor(result, actorId = null) {
      const record = approved.get(result?.id);
      if (!record) throw new Error('explicit recognition approval is required');
      const matches = (field, expected) => (record[field] ?? null) === (expected ?? null);
      if (!matches('sourceEntityId', result?.sourceEntityId)) throw new Error('recognition approval record is bound to a different target entity');
      if (!matches('packageEntryId', result?.packageEntryId)) throw new Error('recognition approval record is bound to a different package entry');
      if (!matches('packageContentHash', result?.packageContentHash)) throw new Error('recognition approval record is bound to a different package content');
      if (!matches('algorithmVersion', result?.algorithmVersion)) throw new Error('recognition approval record is bound to a different algorithm version');
      const actor = actorId == null ? record.actorId : String(actorId).trim();
      if (actor !== record.actorId) throw new Error('recognition approval record is bound to a different actor');
      // The binding is re-verified against the host binding CURRENT at
      // consumption time (review R4): a record minted under one project
      // binding cannot be spent after the host re-binds, and an unbound
      // record cannot be spent under any binding.
      // Fail closed on a missing binding on either side (review R2 round 5):
      // an unbound record can never be spent, even against an unbound host.
      if (projectBinding == null || record.projectBinding == null) throw new Error('recognition approval record is bound to a different project binding');
      if ((projectBinding ?? null) !== (record.projectBinding ?? null)) throw new Error('recognition approval record is bound to a different project binding');
      approved.delete(result.id);
      return record;
    },
  });
}

// The one consuming authority. It is not reachable through the module
// surface: only this module can consume approval records, so callers cannot
// duck-type, swap or self-mint their way into the approval boundary.
const HOST_APPROVAL_AUTHORITY = createRecognitionApprovalAuthority();

// The host project/binary binding is a host-held capability, not a public
// reset (review R2 rounds 3+4): a normal exported setter would let any
// importer restore a stale binding and spend an approval record that the
// host re-bind had just invalidated (mint under A → host re-binds B →
// attacker restores A → stale record spendable). The capability is minted
// module-privately at evaluation time and delivered ONCE — over a
// consume-once bootstrap channel — to the host bundle's bootstrap hook,
// which the host registers before the module graph evaluates (its first
// import). The capability lives only in the host's closure afterwards: no
// global holder, no export, and no other surface ever returns it, so an
// importer cannot read or steal the genuine capability (the R2-round-4
// theft path — `globalThis[holder-key].capability` — no longer exists).
// A page script that executes BEFORE the module graph evaluates could
// install its own hook and receive the capability; that is
// pre-application code execution, the same trust tier as the host bundle
// itself, and out of the threat model (same tier argument as the captured
// platform Event references). If no bootstrap hook is registered, the
// capability is dropped and the binding stays unconfigured — fail-closed.
const HOST_CAPABILITY_STAMP = Symbol('hex.recognition.host-capability');
const HOST_BOOTSTRAP_KEY = Symbol.for('hex.recognition.host-bootstrap');
const HOST_CAPABILITY = deepFreeze({ [HOST_CAPABILITY_STAMP]: true });
(function deliverHostCapabilityOnce() {
  const bootstrap = globalThis[HOST_BOOTSTRAP_KEY];
  if (bootstrap && typeof bootstrap.deliver === 'function') {
    try {
      bootstrap.deliver(HOST_CAPABILITY);
    } catch {
      // A hostile/misbehaving hook must not break module evaluation; the
      // capability is simply not delivered and the binding stays null.
    }
  }
  // Consume the channel: post-evaluation code cannot observe or re-trigger
  // the delivery.
  delete globalThis[HOST_BOOTSTRAP_KEY];
})();

function isHostCapability(value) {
  return typeof value === 'object' && value !== null && value[HOST_CAPABILITY_STAMP] === true;
}

// The host uses the capability it received at bootstrap to set/re-bind the
// approval host binding for the session. This export is the ONLY way to
// change the binding, and it requires the module-stamped capability that
// only the host bootstrap ever received.
export function configureRecognitionApprovalHost({ projectBinding = null, capability = null } = {}) {
  if (!isHostCapability(capability)) throw new TypeError('recognition approval host configuration requires the host capability delivered at host bootstrap; importer-provided configuration is not authorized');
  HOST_APPROVAL_AUTHORITY.configureHost({ projectBinding });
}

// The only issuance seam: a one-shot approval control bound to exactly one
// recognition suggestion. The control MINTS its own approval surface (a real
// DOM button in the browser; a trusted-runner EventTarget stand-in under
// test) and registers the delivery handler on it module-internally — the
// surface is exposed read-only for the host UI to mount, and neither the
// surface registration nor the handler is reachable from outside, so no
// importer can transplant the approval delivery onto an unrelated element.
// Only a browser-trusted gesture the platform delivers to this module-minted
// surface mints the approval record; the grant never crosses the module
// boundary as data — the creator's onApproved continuation runs the local
// promotion. See the boundary comment above for the threat model.
const APPROVAL_SURFACE_CAPTION = 'Approve recognition suggestion';

function mintApprovalSurface(matchId) {
  if (typeof document === 'object' && document !== null && typeof document.createElement === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.hexRecognitionApproval = matchId;
    button.textContent = APPROVAL_SURFACE_CAPTION;
    return button;
  }
  // Trusted-runner (Node test / denominator probe) realm stand-in.
  const RunnerEventTarget = globalThis.HarnessEventTarget || globalThis.ProbeEventTarget;
  if (typeof RunnerEventTarget === 'function') return new RunnerEventTarget();
  throw new TypeError('recognition approval requires a host UI realm (DOM or trusted runner) to mint the approval surface');
}

export function createRecognitionApprovalControl(result, { actorId, onApproved } = {}) {
  if (!result || result.authority !== 'L2-suggestion' || !result.id) throw new TypeError('recognition suggestion required');
  if (result.candidateSearchTruncated || result.status === 'ambiguous') throw new Error('ambiguous or truncated recognition cannot be promoted');
  const actor = String(actorId || '').trim();
  if (!actor) throw new TypeError('local approving actor identity is required');
  if (typeof onApproved !== 'function') throw new TypeError('an onApproved continuation is required to run the local promotion');
  let state = 'pending';
  let continuation = onApproved;
  // The surface is minted here, before exposure; the delivery handler is
  // registered module-internally and never exported.
  const surface = mintApprovalSurface(result.id);
  const handleDelivery = (event) => {
    if (state !== 'pending') return;
    try {
      HOST_APPROVAL_AUTHORITY.requireTrustedDelivery(event, surface);
    } catch {
      // Not a trusted gesture on this module-minted approval surface: no
      // approval is minted and the control stays armed for the real one.
      return;
    }
    HOST_APPROVAL_AUTHORITY.recordApproval(result, { actorId: actor, interactionType: event.type });
    state = 'approved';
    const run = continuation;
    continuation = null;
    run();
  };
  surface.addEventListener('click', handleDelivery);
  return deepFreeze({
    matchId: result.id,
    // The host UI mounts this module-minted approval surface (e.g.
    // panel.appendChild(control.surface)). It is not caller-replaceable and
    // the delivery handler is not exported, so the approval delivery path
    // cannot be transplanted onto unrelated elements.
    get surface() { return surface; },
    // Tear down the pending control (e.g. the suggestion left the UI).
    release() {
      if (state === 'approved') return;
      state = 'released';
      surface.removeEventListener?.('click', handleDelivery);
    },
  });
}

export function promoteKnowledgeSuggestion(result, options = {}) {
  if (!result || result.authority !== 'L2-suggestion') throw new TypeError('recognition suggestion required');
  if (result.candidateSearchTruncated || result.status === 'ambiguous') throw new Error('ambiguous or truncated recognition cannot be promoted');
  for (const forbidden of ['approvalGrant', 'approvalToken', 'approvalAuthority', 'interaction']) {
    if (forbidden in options) {
      throw new Error('recognition approval evidence is minted by the host approval control and cannot be supplied');
    }
  }
  // The approval record is verified against the module-private host
  // authority; verified actor/provenance come from the minted record, not
  // caller fields (#5216).
  const record = HOST_APPROVAL_AUTHORITY.consumeFor(result, options.actorId ?? null);
  const actorId = String(record.actorId || '').trim();
  if (!actorId) throw new TypeError('local approving actor identity is required');
  return deepFreeze({
    kind: 'knowledge-fact', targetEntityId: result.sourceEntityId, value: options.value || { packageEntryId: result.packageEntryId, name: options.name || null },
    confirmation: 'user-confirmed', authority: 'L4-local-canonical',
    provenance: { source: 'local-user', actorId, approvedMatchId: record.matchId, approvalGesture: record.interactionType },
    externalProvenance: { packageContentHash: result.packageContentHash, packageEntryId: result.packageEntryId, algorithmVersion: result.algorithmVersion, evidenceIds: result.evidenceIds },
  });
}

export function importRecognitionPackage(value, options = {}) {
  const envelope = importPhase12Package(value, options);
  if (!['knowledge', 'mixed'].includes(envelope.kind)) throw new TypeError('recognition requires a knowledge package');
  return envelope;
}
