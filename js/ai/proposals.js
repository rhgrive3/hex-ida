import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';
import { stableDigest } from '../core/identity/index.js';

const PROPOSAL_KINDS = new Set(['rename', 'comment', 'type', 'struct-field', 'patch', 'project-annotation']);
const EXECUTION_PAYLOADS = new WeakMap();
let proposalSequence = 1;

export class ProposalStore {
  constructor({ evidenceStore, binding = null } = {}) {
    this.evidenceStore = evidenceStore;
    this.binding = typeof binding === 'function' ? binding : null;
    this.records = new Map();
    this.approvals = new Map();
    // Tokens consumed by apply() but currently in-flight inside the apply
    // callback. CapabilityExecutor verifies against both maps so the
    // legitimate ProposalExecutor path (which calls back inside apply)
    // still validates after the approval is consumed (#6221).
    this.inflight = new Map();
    this.audit = [];
  }

  create(input = {}) {
    if (!PROPOSAL_KINDS.has(input.kind)) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${input.kind}`);
    const evidenceIds = Array.from(new Set((Array.isArray(input.evidenceIds) ? input.evidenceIds : []).filter((id) => typeof id === 'string' && this.evidenceStore?.has(id))));
    if (!evidenceIds.length) throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
    let id;
    if (Object.prototype.hasOwnProperty.call(input, 'id')) {
      if (typeof input.id !== 'string' || !input.id) throw new AIError('invalid_tool_call', 'Proposal id must be a non-empty string.');
      id = input.id;
      if (this.records.has(id)) throw new AIError('invalid_tool_call', `Proposal id already exists: ${id}`);
    } else {
      do id = `proposal_${proposalSequence++}`;
      while (this.records.has(id));
    }
    const binding = this.binding?.() || null;
    const revision = fingerprint(input.before);
    const bindingRevision = fingerprint(binding);
    const executionPayload = snapshotProposalPayload(input);
    const record = {
      id, kind: input.kind,
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
    this.records.set(id, record);
    this.audit.push({ type: 'proposal-created', proposalId: id, timestamp: record.createdAt });
    return record;
  }

  approve(id) {
    const proposal = this.require(id);
    if (proposal.status !== 'pending') throw new AIError('approval_required', 'Only pending proposals can be approved.');
    proposal.status = 'approved';
    const token = randomToken();
    this.approvals.set(proposal.id, token);
    this.audit.push({ type: 'proposal-approved', proposalId: proposal.id, timestamp: new Date().toISOString() });
    return { proposal, approvalToken: token };
  }

  reject(id) {
    const proposal = this.require(id);
    if (proposal.status !== 'pending' && proposal.status !== 'approved') return proposal;
    proposal.status = 'rejected';
    this.approvals.delete(proposal.id);
    this.inflight.delete(proposal.id);
    this.audit.push({ type: 'proposal-rejected', proposalId: proposal.id, timestamp: new Date().toISOString() });
    return proposal;
  }

  async apply(id, { approvalToken, currentState, apply } = {}) {
    const proposal = this.require(id);
    if (proposal.status !== 'approved' || this.approvals.get(proposal.id) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');

    // Consume approval and move to the in-flight state synchronously before any
    // await. A second caller with the same token can no longer pass validation.
    proposal.status = 'applying';
    this.approvals.delete(proposal.id);
    this.inflight.set(proposal.id, approvalToken);
    this.audit.push({ type: 'proposal-applying', proposalId: proposal.id, timestamp: new Date().toISOString() });

    try {
      if (proposal.bindingRevision !== fingerprint(this.binding?.() || null)) {
        proposal.status = 'failed';
        this.audit.push({ type: 'proposal-binding-mismatch', proposalId: proposal.id, timestamp: new Date().toISOString() });
        throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
      }

      if (fingerprint(currentState) !== proposal.revision) {
        proposal.status = 'failed';
        this.audit.push({ type: 'proposal-stale', proposalId: proposal.id, timestamp: new Date().toISOString() });
        throw new AIError('tool_failed', 'The proposal target changed after it was created.');
      }
      if (typeof apply !== 'function') {
        proposal.status = 'failed';
        throw new AIError('tool_failed', 'No mutation adapter is available.');
      }
      await apply(proposalExecutionView(proposal));
      proposal.status = 'applied';
      this.audit.push({ type: 'proposal-applied', proposalId: proposal.id, timestamp: new Date().toISOString() });
      return proposal;
    } catch (error) {
      if (proposal.status === 'applying') {
        proposal.status = 'failed';
        this.audit.push({ type: 'proposal-failed', proposalId: proposal.id, timestamp: new Date().toISOString() });
      }
      throw error;
    } finally {
      this.inflight.delete(proposal.id);
    }
  }

  require(id) {
    if (typeof id !== 'string' || !id) throw new AIError('invalid_tool_call', 'Unknown proposal.');
    const value = this.records.get(id);
    if (!value) throw new AIError('invalid_tool_call', 'Unknown proposal.');
    return value;
  }
  has(id) { return typeof id === 'string' && !!id && this.records.has(id); }
  get(id) { return typeof id === 'string' && !!id ? this.records.get(id) || null : null; }
  all() { return Array.from(this.records.values()); }
  executionView(id) { return proposalExecutionView(this.require(id)); }
}

function proposalExecutionView(proposal) {
  const payload = EXECUTION_PAYLOADS.get(proposal);
  if (!payload) throw new AIError('tool_failed', 'Proposal execution payload is unavailable.');
  return { ...proposal, ...snapshotProposalPayload(payload) };
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

function snapshotProposalPayload(value) {
  const clone = globalThis.structuredClone;
  if (typeof clone !== 'function') {
    throw new AIError('tool_failed', 'Structured cloning is unavailable for proposal execution payloads.');
  }
  let payload;
  try {
    payload = {
      target: clone(value.target),
      before: clone(value.before),
      after: clone(value.after),
    };
    restoreRegExpLastIndex(value.target, payload.target);
    restoreRegExpLastIndex(value.before, payload.before);
    restoreRegExpLastIndex(value.after, payload.after);
  } catch {
    throw new AIError('invalid_tool_call', 'Proposal execution payload must be structured-cloneable.');
  }
  if (containsSharedMemory(payload)) {
    throw new AIError('invalid_tool_call', 'Proposal execution payload must not contain shared memory.');
  }
  return payload;
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
    if (value instanceof Date) return `t${JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString())}`;
    if (value instanceof ArrayBuffer) {
      let hexText = '';
      for (const byte of new Uint8Array(value)) hexText += byte.toString(16).padStart(2, '0');
      return `yArrayBuffer:${JSON.stringify(hexText)}`;
    }
    if (ArrayBuffer.isView(value)) {
      // Typed-array/view kinds carry different element semantics over the same
      // raw bytes (Uint8Array vs Uint32Array vs Float32Array vs DataView).
      // The stale-state guard must not alias them to one revision (#6215).
      const tag = value instanceof DataView ? 'DataView' : (value?.constructor?.name || 'UnknownView');
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let hexText = '';
      for (const byte of bytes) hexText += byte.toString(16).padStart(2, '0');
      return `y${tag}:${JSON.stringify(hexText)}:${value.byteLength}`;
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
