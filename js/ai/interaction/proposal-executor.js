import { AIError } from '../schema.js';
import { proposalArguments, proposalCapability } from '../proposals.js';

const NOTE_BACKED_KINDS = new Set(['rename', 'comment', 'type', 'struct-field']);
const NOTE_READY_TIMEOUT_MS = 10_000;

export class ProposalExecutor {
  constructor({ store, capabilityExecutor, app } = {}) {
    this.store = store; this.capabilityExecutor = capabilityExecutor; this.app = app;
  }

  async approveAndApply(id) {
    if (!this.store) throw new AIError('tool_failed', 'No proposal store is available.');
    const { proposal, approvalToken } = this.store.approve(id);
    const executionProposal = typeof this.store.executionView === 'function' ? this.store.executionView(id) : proposal;
    const currentState = await this.currentState(executionProposal);
    let execution = null;
    const applied = await this.store.apply(id, {
      approvalToken, currentState,
      apply: async (item, authorization) => {
        const capability = proposalCapability(item);
        if (!capability) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${item.kind}`);
        execution = await this.capabilityExecutor.execute(capability, proposalArguments(item), { authorization });
        await this.verifyPostcondition(item, execution);
      },
    });
    return { proposal: applied, execution };
  }

  async currentState(proposal) {
    if (NOTE_BACKED_KINDS.has(proposal.kind)) await awaitNoteStoreReady(this.app);
    const target = targetObject(proposal.target);
    const address = target.address == null ? null : BigInt(target.address);
    switch (proposal.kind) {
      case 'rename': return address == null ? null : (this.app?.notes?.nameOf?.(address) || this.app?.symbols?.nameAt?.(address) || null);
      case 'comment': return address == null ? null : (this.app?.notes?.comment?.(address) || null);
      case 'type': return address == null ? null : (this.app?.notes?.typeOf?.(address, String(target.key || 'return')) || null);
      case 'struct-field': return findStructField(this.app, target);
      case 'patch': {
        const expected = byteArray(proposal.before);
        const result = address == null ? null : await this.app?.backend?.readAt?.(address, expected.length);
        return result?.found ? Array.from(result.bytes) : null;
      }
      case 'project-annotation': return findProjectAnnotation(this.app, target);
      default: return proposal.before;
    }
  }

  async verifyPostcondition(proposal, execution) {
    if (proposal.kind === 'patch') {
      if (!execution || !same(execution.after, proposal.after)) throw new AIError('tool_failed', 'Patch postcondition does not match the approved bytes.');
      return;
    }
    const live = await this.currentState({ ...proposal, before: proposal.after });
    if (!containsValue(live, proposal.after)) throw new AIError('tool_failed', `Postcondition verification failed for ${proposal.kind}.`);
  }
}

async function awaitNoteStoreReady(app) {
  if (!app || app.notes?.id) return app?.notes;
  const controller = app.noteAttachController;
  const doc = globalThis.document;
  if (!controller?.signal || typeof doc?.addEventListener !== 'function') return app.notes;
  if (controller.signal.aborted) throw new AIError('tool_failed', 'Annotation store binding was replaced before the proposal could be applied.');

  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      doc.removeEventListener('hex:notes-attached', onAttached);
      controller.signal.removeEventListener('abort', onAbort);
      if (timer != null) clearTimeout(timer);
    };
    const succeed = () => { cleanup(); resolve(); };
    const fail = (message) => { cleanup(); reject(new AIError('tool_failed', message)); };
    const onAttached = () => {
      if (app.noteAttachController === controller && app.notes?.id) succeed();
    };
    const onAbort = () => fail('Annotation store binding changed before the proposal could be applied.');

    doc.addEventListener('hex:notes-attached', onAttached);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (app.notes?.id) return succeed();
    timer = setTimeout(() => fail('Annotation store binding did not become ready before the proposal could be applied.'), NOTE_READY_TIMEOUT_MS);
  });
  return app.notes;
}

function targetObject(target) { return target && typeof target === 'object' ? { ...target } : { address: target }; }
function findStructField(app, target) {
  const struct = app?.notes?.structs?.find?.((item) => item?.name === String(target.struct || target.name || ''));
  return struct?.fields?.find?.((item) => Number(item?.offset) === Number(target.offset)) || null;
}
function findProjectAnnotation(app, target) { return app?.projectAnnotations?.find?.((item) => item?.id === String(target.id || ''))?.value ?? null; }
function byteArray(value) { return Array.from(value instanceof Uint8Array ? value : (value || []), Number); }
function same(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }
function containsValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => containsValue(actual[key], value));
  }
  return same(actual, expected);
}
function normalize(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}; for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]); return out;
  }
  return Array.isArray(value) ? value.map(normalize) : typeof value === 'bigint' ? value.toString() : value;
}

export function createProposalExecutor(options) { return new ProposalExecutor(options); }
