import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';
import { stableDigest } from '../core/identity/index.js';

const PROPOSAL_KINDS = new Set(['rename', 'comment', 'type', 'struct-field', 'patch', 'project-annotation']);
const PROPOSAL_CAPABILITIES = Object.freeze({
  rename: 'annotation.rename', comment: 'annotation.comment', type: 'annotation.set-type',
  'struct-field': 'annotation.struct-field', patch: 'patch.create', 'project-annotation': 'annotation.project',
});
const EXECUTION_PAYLOADS = new WeakMap();
const PROPOSAL_AUTHORITIES = new WeakMap();
const EXECUTION_AUTHORIZATIONS = new WeakMap();
let proposalSequence = 1;

export class ProposalStore {
  constructor({ evidenceStore, binding = null } = {}) {
    this.evidenceStore = evidenceStore;
    this.binding = typeof binding === 'function' ? binding : null;
    this.records = new Map();
    this.approvals = new Map();
    this.audit = [];
  }

  create(input = {}) {
    const kind = input.kind;
    if (!PROPOSAL_KINDS.has(kind)) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${kind}`);
    // A truthy non-array must never reach property access with a native
    // TypeError: malformed tool input stays inside the invalid_tool_call
    // domain-error boundary on the deterministic-evidence validation path.
    if (input.evidenceIds != null && !Array.isArray(input.evidenceIds)) {
      throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
    }
    const evidenceIds = Array.from(new Set((input.evidenceIds || []).filter((id) => typeof id === 'string' && this.evidenceStore?.has(id))));
    if (!evidenceIds.length) throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
    let id;
    if (Object.prototype.hasOwnProperty.call(input, 'id')) {
      const inputId = input.id;
      if (typeof inputId !== 'string' || !inputId) throw new AIError('invalid_tool_call', 'Proposal id must be a non-empty string.');
      id = inputId;
      if (this.records.has(id)) throw new AIError('invalid_tool_call', `Proposal id already exists: ${id}`);
    } else {
      do id = `proposal_${proposalSequence++}`;
      while (this.records.has(id));
    }
    const binding = this.binding?.() || null;
    // Capture the caller-controlled property once. Besides closing the
    // revision/payload TOCTOU, this preserves the explicit symbol-key fail
    // closed check below because structuredClone intentionally omits symbols.
    const before = input.before;
    rejectUnstableProposalState(before);
    const executionPayload = snapshotProposalPayload(input, before);
    // Uint8Array is an accepted wire representation of patch bytes, but the
    // stale-state authority and the backend read both use plain arrays. Keep
    // one canonical payload for either accepted container so equal bytes do
    // not produce different revisions (#6171).
    if (kind === 'patch' && (executionPayload.before instanceof Uint8Array || executionPayload.after instanceof Uint8Array)) {
      executionPayload.before = proposalBytes(executionPayload.before);
      executionPayload.after = proposalBytes(executionPayload.after);
    }
    // The stale-state authority must fingerprint the same stable value that
    // execution will receive. Reading caller-controlled `input.before` again
    // after snapshotting would make an accessor-backed value a TOCTOU boundary:
    // the payload could contain A while the revision records B (#5945).
    // Structured cloning also rejects symbol-keyed state before this point, so
    // the owned payload is the complete fail-closed identity view.
    const revision = fingerprint(executionPayload.before);
    const bindingRevision = fingerprint(binding);
    const authority = Object.freeze({
      id,
      kind,
      capability: PROPOSAL_CAPABILITIES[kind],
      revision,
      bindingRevision,
    });
    const record = {
      id, kind,
      // The public record stays bounded for display/wire consumers. Mutation
      // authority is held separately in EXECUTION_PAYLOADS.
      target: jsonSafe(executionPayload.target),
      before: jsonSafe(executionPayload.before),
      after: jsonSafe(executionPayload.after),
      reason: String(input.reason || '').slice(0, 2000), evidenceIds,
      createdAt: new Date().toISOString(), status: 'pending',
      // Identity/staleness checks use the exact snapshotted value that will be
      // executed, never jsonSafe's display-oriented depth/item truncation.
      revision,
      binding: jsonSafe(binding),
      bindingRevision,
    };
    EXECUTION_PAYLOADS.set(record, executionPayload);
    PROPOSAL_AUTHORITIES.set(record, authority);
    this.records.set(id, record);
    this.audit.push({ type: 'proposal-created', proposalId: id, timestamp: record.createdAt });
    return proposalSnapshot(record);
  }

  approve(id) {
    const proposal = requireProposalRecord(this, id);
    const authority = proposalAuthority(proposal);
    if (proposal.status !== 'pending') throw new AIError('approval_required', 'Only pending proposals can be approved.');
    const token = randomToken();
    proposal.status = 'approved';
    this.approvals.set(authority.id, token);
    this.audit.push({ type: 'proposal-approved', proposalId: authority.id, timestamp: new Date().toISOString() });
    return { proposal: proposalSnapshot(proposal), approvalToken: token };
  }

  reject(id) {
    const proposal = requireProposalRecord(this, id);
    const authority = proposalAuthority(proposal);
    if (proposal.status !== 'pending' && proposal.status !== 'approved') return proposalSnapshot(proposal);
    proposal.status = 'rejected';
    this.approvals.delete(authority.id);
    this.audit.push({ type: 'proposal-rejected', proposalId: authority.id, timestamp: new Date().toISOString() });
    return proposalSnapshot(proposal);
  }

  async apply(id, { approvalToken, currentState, apply } = {}) {
    const proposal = requireProposalRecord(this, id);
    const authority = proposalAuthority(proposal);
    if (proposal.status !== 'approved' || this.approvals.get(authority.id) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');

    // Consume approval and move to the in-flight state synchronously before any
    // await. A second caller with the same token can no longer pass validation.
    proposal.status = 'applying';
    this.approvals.delete(authority.id);
    this.audit.push({ type: 'proposal-applying', proposalId: authority.id, timestamp: new Date().toISOString() });

    let bindingRevision;
    try {
      bindingRevision = fingerprint(this.binding?.() || null);
    } catch (error) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
      throw error;
    }
    if (authority.bindingRevision !== bindingRevision) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-binding-mismatch', proposalId: authority.id, timestamp: new Date().toISOString() });
      throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
    }

    let currentRevision;
    try {
      currentRevision = fingerprint(currentState);
    } catch (error) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
      throw error;
    }
    if (currentRevision !== authority.revision) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-stale', proposalId: authority.id, timestamp: new Date().toISOString() });
      throw new AIError('tool_failed', 'The proposal target changed after it was created.');
    }
    if (typeof apply !== 'function') {
      proposal.status = 'failed';
      throw new AIError('tool_failed', 'No mutation adapter is available.');
    }
    let authorization = null;
    try {
      const executionProposal = proposalExecutionView(proposal);
      authorization = issueProposalAuthorization(this, proposal, executionProposal, approvalToken);
      await apply(executionProposal, authorization);
      proposal.status = 'applied';
      this.audit.push({ type: 'proposal-applied', proposalId: authority.id, timestamp: new Date().toISOString() });
      return proposalSnapshot(proposal);
    } catch (error) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
      throw error;
    } finally {
      if (authorization) EXECUTION_AUTHORIZATIONS.delete(authorization);
    }
  }

  require(id) { return proposalSnapshot(requireProposalRecord(this, id)); }
  has(id) { return typeof id === 'string' && !!id && this.records.has(id); }
  get(id) {
    if (typeof id !== 'string' || !id) return null;
    const value = this.records.get(id);
    return value ? proposalSnapshot(value) : null;
  }
  all() { return Array.from(this.records.values(), (proposal) => proposalSnapshot(proposal)); }
  executionView(id) { return proposalExecutionView(requireProposalRecord(this, id)); }
}

export function proposalCapability(proposal) {
  return PROPOSAL_CAPABILITIES[proposal?.kind] || null;
}

export function proposalArguments(proposal) {
  const target = proposalTarget(proposal?.target);
  if (proposal?.kind === 'rename' || proposal?.kind === 'comment' || proposal?.kind === 'type') return { ...target, value: proposal.after };
  if (proposal?.kind === 'struct-field') return { ...target, ...(proposal.after && typeof proposal.after === 'object' ? proposal.after : { type: proposal.after }) };
  if (proposal?.kind === 'patch') return { ...target, before: proposalBytes(proposal.before), after: proposalBytes(proposal.after) };
  return { ...target, value: proposal?.after };
}

export function consumeProposalAuthorization(authorization, capability, args) {
  if (!authorization || typeof authorization !== 'object') return false;
  const record = EXECUTION_AUTHORIZATIONS.get(authorization);
  if (!record) return false;

  // A branded authorization is single-use even when the attempted capability
  // or arguments are wrong. This prevents a leaked authority from being probed
  // and then replayed with a corrected mutation.
  EXECUTION_AUTHORIZATIONS.delete(authorization);
  try {
    if (authorization.kind !== 'proposal' || authorization.token !== record.token || authorization.proposalId !== record.proposalId) return false;
    if (record.store.records.get(record.proposalId) !== record.proposal || record.proposal.status !== 'applying') return false;
    const authority = proposalAuthority(record.proposal);
    if (authority.id !== record.proposalId || authority.capability !== record.capability || authority.bindingRevision !== record.bindingRevision) return false;
    if (record.capability !== capability) return false;
    if (fingerprint(record.store.binding?.() || null) !== record.bindingRevision) return false;
    return fingerprint(args) === record.argumentsRevision;
  } catch {
    return false;
  }
}

function issueProposalAuthorization(store, proposal, executionProposal, approvalToken) {
  const authority = proposalAuthority(proposal);
  const capability = authority.capability;
  if (!capability) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${authority.kind}`);
  const authorization = Object.freeze({ kind: 'proposal', token: approvalToken, proposalId: authority.id });
  EXECUTION_AUTHORIZATIONS.set(authorization, {
    store,
    proposal,
    proposalId: authority.id,
    token: approvalToken,
    capability,
    argumentsRevision: fingerprint(proposalArguments(executionProposal)),
    bindingRevision: authority.bindingRevision,
  });
  return authorization;
}

function requireProposalRecord(store, id) {
  if (typeof id !== 'string' || !id) throw new AIError('invalid_tool_call', 'Unknown proposal.');
  const value = store.records.get(id);
  if (!value) throw new AIError('invalid_tool_call', 'Unknown proposal.');
  return value;
}

function proposalAuthority(proposal) {
  const authority = PROPOSAL_AUTHORITIES.get(proposal);
  if (!authority) throw new AIError('tool_failed', 'Proposal authority metadata is unavailable.');
  return authority;
}

function proposalSnapshot(proposal) {
  const authority = proposalAuthority(proposal);
  return {
    ...proposal,
    id: authority.id,
    kind: authority.kind,
    target: jsonSafe(proposal.target),
    before: jsonSafe(proposal.before),
    after: jsonSafe(proposal.after),
    evidenceIds: Array.isArray(proposal.evidenceIds) ? [...proposal.evidenceIds] : [],
    revision: authority.revision,
    binding: jsonSafe(proposal.binding),
    bindingRevision: authority.bindingRevision,
  };
}

function proposalTarget(target) { return target && typeof target === 'object' ? { ...target } : { address: target }; }
function proposalBytes(value) {
  // Patch bytes are mutation-authority input. Coercing each element (the old
  // `Number` mapping) let string/boolean/null bytes reach the strict
  // capability validator as canonical numbers, so the original type violation
  // could never be detected and the approved identity was compared against a
  // laundered view. Validate byte identity instead of laundering it (#6171).
  if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
    throw new AIError('invalid_tool_call', 'Mutation bytes must be an Array or Uint8Array.');
  }
  const raw = Array.from(value);
  for (const byte of raw) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new AIError('invalid_tool_call', 'Mutation contains a non-byte value.');
    }
  }
  return Array.from(raw);
}

function proposalExecutionView(proposal) {
  const payload = EXECUTION_PAYLOADS.get(proposal);
  if (!payload) throw new AIError('tool_failed', 'Proposal execution payload is unavailable.');
  return { ...proposalSnapshot(proposal), ...snapshotProposalPayload(payload) };
}

function restoreRegExpLastIndex(source, target, seen = new WeakSet()) {
  if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return;
  if (seen.has(source)) return;
  seen.add(source);
  if (source instanceof RegExp && target instanceof RegExp) {
    target.lastIndex = source.lastIndex;
    return;
  }
  if (source instanceof Map && target instanceof Map) {
    const srcKeys = Array.from(source.keys());
    const tgtKeys = Array.from(target.keys());
    for (let i = 0; i < srcKeys.length; i++) {
      restoreRegExpLastIndex(srcKeys[i], tgtKeys[i], seen);
      restoreRegExpLastIndex(source.get(srcKeys[i]), target.get(tgtKeys[i]), seen);
    }
    return;
  }
  if (source instanceof Set && target instanceof Set) {
    const srcVals = Array.from(source.values());
    const tgtVals = Array.from(target.values());
    for (let i = 0; i < srcVals.length; i++) {
      restoreRegExpLastIndex(srcVals[i], tgtVals[i], seen);
    }
    return;
  }
  if (Array.isArray(source) && Array.isArray(target)) {
    for (let i = 0; i < source.length; i++) {
      restoreRegExpLastIndex(source[i], target[i], seen);
    }
    return;
  }
  for (const key of Object.keys(source)) {
    if (key in target) {
      restoreRegExpLastIndex(source[key], target[key], seen);
    }
  }
}

function snapshotProposalPayload(value, stableBefore = value.before) {
  const clone = globalThis.structuredClone;
  if (typeof clone !== 'function') {
    throw new AIError('tool_failed', 'Structured cloning is unavailable for proposal execution payloads.');
  }
  let payload;
  try {
    payload = {
      target: clone(value.target),
      before: clone(stableBefore),
      after: clone(value.after),
    };
    restoreRegExpLastIndex(value.target, payload.target);
    restoreRegExpLastIndex(stableBefore, payload.before);
    restoreRegExpLastIndex(value.after, payload.after);
  } catch {
    throw new AIError('invalid_tool_call', 'Proposal execution payload must be structured-cloneable.');
  }
  if (containsSharedMemory(payload)) {
    throw new AIError('invalid_tool_call', 'Proposal execution payload must not contain shared memory.');
  }
  return payload;
}

// `structuredClone` omits symbol-keyed properties and invokes accessors. The
// proposal boundary must not silently lose identity-bearing state or read a
// mutable accessor twice while preparing an approval. Capture the top-level
// before value once in create(), then reject unsupported nested accessors and
// symbol keys without invoking them.
function rejectUnstableProposalState(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new AIError('tool_failed', 'Proposal state contains symbol-keyed own properties and cannot be fingerprinted safely.');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new AIError('tool_failed', 'Proposal state contains accessor-backed state and cannot be snapshotted safely.');
      }
      rejectUnstableProposalState(descriptor.value, seen);
    }
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('tool_failed', 'Proposal state cannot be snapshotted safely.');
  }
}

function containsSharedMemory(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false;
  const SharedBuffer = globalThis.SharedArrayBuffer;
  if (typeof SharedBuffer === 'function' && value instanceof SharedBuffer) return true;
  if (ArrayBuffer.isView(value)) {
    return typeof SharedBuffer === 'function' && value.buffer instanceof SharedBuffer;
  }
  if (value instanceof ArrayBuffer) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (containsSharedMemory(key, seen) || containsSharedMemory(item, seen)) return true;
    }
    return false;
  }
  if (value instanceof Set) {
    for (const item of value) {
      if (containsSharedMemory(item, seen)) return true;
    }
    return false;
  }

  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor && containsSharedMemory(descriptor.value, seen)) return true;
  }
  return false;
}

/**
 * Stale-state fingerprint.
 *
 * `revision` and `bindingRevision` are safety checks: they decide whether the
 * thing the user approved is still the thing about to be written. A 32-bit
 * hash is far too small for that job — with a 32-bit digest an unrelated state
 * passes the guard by accident often enough to matter, and it is trivially
 * steerable. The canonical text is therefore digested with the same 128-bit
 * primitive the rest of the product uses for identity.
 *
 * `stableDigest` is given the canonical *text*, never the raw value: the text
 * already carries the type tags, so nothing is lost to `jsonSafe` on the way in.
 */
function fingerprint(value) {
  return stableDigest(canonicalIdentity(value));
}

/**
 * Domain-separated canonical text for one value.
 *
 * The previous encoding described non-JSON values with ordinary objects
 * (`{"$bigint":"1"}`, `{"$number":"NaN"}`, `{"$undefined":true}`) while the
 * ordinary-object branch was free to use those very keys. So `1n` and
 * `{ $bigint: '1' }` produced the same text, and a proposal approved against
 * `before: 1n` passed its stale-state guard against a completely different
 * current state (#1299).
 *
 * Renaming the magic keys only moves that collision. Instead every value kind
 * now carries its own leading tag, and no tag's payload can be produced by
 * another kind:
 *
 *   z null · v undefined · b boolean · i bigint · d number · s string
 *   x symbol/function · t Date · y bytes · m Map · e Set · a array · o object
 *
 * Strings are JSON-quoted after their tag, numbers and bigints are terminated,
 * so concatenating elements with `,` stays unambiguous.
 */
function canonicalIdentity(value, stack = new Set()) {
  if (value === null) return 'z';
  if (value === undefined) return 'v';
  const type = typeof value;
  if (type === 'boolean') return value ? 'b1' : 'b0';
  if (type === 'bigint') return `i${value.toString(10)};`;
  if (type === 'number') {
    if (Number.isNaN(value)) return 'dNaN;';
    if (value === Infinity) return 'dInfinity;';
    if (value === -Infinity) return 'd-Infinity;';
    if (Object.is(value, -0)) return 'd-0;';
    return `d${JSON.stringify(value)};`;
  }
  if (type === 'string') return `s${JSON.stringify(value)}`;
  if (type !== 'object') return `x${JSON.stringify(String(value))}`;

  if (stack.has(value)) throw new AIError('tool_failed', 'Proposal state contains a cyclic value and cannot be fingerprinted safely.');
  stack.add(value);
  try {
    // Symbol-keyed own properties are own state too, but a canonical text
    // cannot distinguish two distinct symbols sharing a description. The
    // stale-state contract therefore refuses symbol-keyed state explicitly
    // instead of silently omitting part of the value (#5945).
    if (Object.getOwnPropertySymbols(value).length) {
      throw new AIError('tool_failed', 'Proposal state contains symbol-keyed own properties and cannot be fingerprinted safely.');
    }
    if (value instanceof Date) return `t${JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString())}`;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let hexText = '';
      for (const byte of bytes) hexText += byte.toString(16).padStart(2, '0');
      return `y${JSON.stringify(hexText)}`;
    }
    // Map/Set entry order is part of the value, so it is preserved rather than
    // sorted: two maps built in a different order are different states.
    if (value instanceof Map) {
      return `m[${Array.from(value.entries()).map(([k, v]) => `${canonicalIdentity(k, stack)}:${canonicalIdentity(v, stack)}`).join(',')}]`;
    }
    if (value instanceof Set) {
      return `e[${Array.from(value.values()).map((item) => canonicalIdentity(item, stack)).join(',')}]`;
    }
    // RegExp matching state includes source, flags, and lastIndex. The latter
    // is non-enumerable but changes global/sticky matching behavior, so omitting
    // it would let a changed approved state pass the stale-state guard (#6250).
    if (value instanceof RegExp) {
      return `r${JSON.stringify(value.source)}:${JSON.stringify(value.flags)}:${canonicalIdentity(value.lastIndex, stack)}`;
    }
    // Fingerprinting decides whether the user-approved state is still the
    // state about to be written. A non-plain object (custom class, host
    // object, boxed primitive, ...) whose meaningful state sits in internal
    // slots cannot be encoded completely here, so it must fail closed
    // instead of collapsing to whatever own enumerable keys happen to show.
    if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) {
      throw new AIError('tool_failed', 'Proposal state contains an unsupported non-plain object and cannot be fingerprinted safely.');
    }
    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new AIError('tool_failed', 'Proposal state contains an unsupported non-plain object and cannot be fingerprinted safely.');
      }
    }
    if (Array.isArray(value)) {
      // Preserve sparse holes explicitly so array length/state changes cannot alias.
      const items = [];
      for (let index = 0; index < value.length; index++) {
        items.push(Object.prototype.hasOwnProperty.call(value, index)
          ? `p${canonicalIdentity(value[index], stack)}`
          : 'h');
      }
      return `a[${items.join(',')}]`;
    }
    // Own keys only, and `__proto__` among them is data here, not a mutation:
    // it is read with Object.keys/direct access and never assigned onto a
    // result object, so it cannot reach a prototype.
    const keys = Object.keys(value).sort();
    return `o{${keys.map((key) => `${JSON.stringify(key)}:${canonicalIdentity(value[key], stack)}`).join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

function randomToken() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new AIError('tool_failed', 'Secure randomness is unavailable for approval tokens.');
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let token = 'approval_';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
  return token;
}
