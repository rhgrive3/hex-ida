import { AIError } from '../schema.js';
import { assertSchema } from '../validation.js';
import { validatePatchRange } from '../../patch.js';

export class CapabilityExecutor {
  constructor({ catalog, app = null, ui = null, actionRunner = null, toolRegistry = null, runtimePlatform = null, binaryId = null, proposalStore = null, approvalVerifier = null } = {}) {
    this.catalog = catalog; this.app = app; this.ui = ui; this.actionRunner = actionRunner;
    this.toolRegistry = toolRegistry; this.runtimePlatform = runtimePlatform; this.binaryId = binaryId;
    this.proposalStore = proposalStore ?? null;
    this.approvalVerifier = approvalVerifier ?? null;
    this.reverts = new Map();
  }

  currentBinaryId() { return typeof this.binaryId === 'function' ? this.binaryId() : this.binaryId; }
  context() { return { app: this.app, ui: this.ui, toolRegistry: this.toolRegistry, runtimePlatform: this.runtimePlatform, binaryId: this.currentBinaryId() }; }
  async resolveRuntimePlatform() { return typeof this.runtimePlatform === 'function' ? this.runtimePlatform() : this.runtimePlatform; }

  async execute(id, args = {}, options = {}) {
    const entry = this.catalog?.get?.(id);
    if (!entry || !entry.agentExposed) throw new AIError('invalid_tool_call', `Unknown or human-only capability: ${id}`);
    assertSchema(args, entry.inputSchema || { type: 'object' }, 'invalid_tool_call');
    const runtimePlatform = entry.category === 'runtime' ? await this.resolveRuntimePlatform() : null;
    this.verifyBinding(entry, args, runtimePlatform);
    if (entry.requiresApproval && !validAuthorization(options.authorization)) throw new AIError('approval_required', `Capability ${id} requires a proposal approval token.`);
    this.verifyScope(entry, options);
    if (entry.requiresApproval) await this.verifyApproval(entry, args, options.authorization);
    if (entry.agentTool) return this.executeTool(entry, args, options);
    if (entry.actionKind) return this.executeAction(entry, args);
    return this.executeBuiltIn(entry, args, options, runtimePlatform);
  }

  verifyBinding(entry, args, runtimePlatform = null) {
    const binaryId = this.currentBinaryId();
    if (args.binaryId != null && binaryId != null && String(args.binaryId) !== String(binaryId)) throw new AIError('scope_violation', 'Capability target belongs to a different binary.');
    if (!entry.runtimeBound) return;
    const session = runtimePlatform?.currentSession?.(false);
    if (!session) throw new AIError('tool_failed', 'No runtime session is available.');
    if (args.runtimeSessionId == null || String(args.runtimeSessionId) !== String(session.id)) throw new AIError('scope_violation', 'Runtime session identity does not match the requested action.');
    if (binaryId != null && session.binaryHash != null && String(binaryId) !== String(session.binaryHash)) throw new AIError('scope_violation', 'Runtime session is bound to a different binary.');
    if (args.binaryId != null && session.binaryHash && String(args.binaryId) !== String(session.binaryHash)) throw new AIError('scope_violation', 'Runtime action is bound to a different binary.');
  }

  verifyScope(entry, options = {}) {
    // scopeSupport is a catalog contract, not a per-dispatch-branch check:
    // enforce it here so agentTool, actionKind, and built-in paths share one
    // policy (#6150).
    const scope = options?.scope || 'auto';
    if (scope === 'auto') return;
    let allowedScopes;
    if (entry.agentTool) {
      const record = this.toolRegistry?.get?.(entry.agentTool);
      allowedScopes = record?.scopeSupport || entry.scopeSupport || [];
    } else {
      allowedScopes = entry.scopeSupport || [];
    }
    if (!allowedScopes.includes(scope)) {
      throw new AIError('scope_violation', `${entry.id} does not support ${scope} scope.`);
    }
  }

  async verifyApproval(entry, args, authorization) {
    // A caller-controlled {kind,token} shape is not an authority. The token
    // must be a live approval issued by the trusted ProposalStore for the
    // matching proposal, capability kind, and binary binding (#6221).
    if (typeof this.approvalVerifier === 'function') {
      let ok = false;
      try {
        ok = await this.approvalVerifier({ capabilityId: entry.id, args, authorization, entry });
      } catch (error) {
        if (error?.type === 'scope_violation' || error?.type === 'approval_required') throw error;
        throw new AIError('approval_required', `Capability ${entry.id} requires a proposal approval token.`);
      }
      if (ok !== true) throw new AIError('approval_required', `Capability ${entry.id} requires a proposal approval token.`);
      return;
    }
    const rawStore = typeof this.proposalStore === 'function' ? this.proposalStore() : this.proposalStore;
    const stores = Array.isArray(rawStore) ? rawStore : (rawStore instanceof Set ? [...rawStore] : (rawStore ? [rawStore] : []));
    if (!stores.length) {
      throw new AIError('approval_required', `Capability ${entry.id} requires a proposal approval token from a trusted approval authority.`);
    }
    const proposalId = authorization?.proposalId;
    if (typeof proposalId !== 'string' || !proposalId) {
      throw new AIError('approval_required', `Capability ${entry.id} requires a proposal approval token.`);
    }
    // A shared executor may trust several session stores; accept a live token
    // from any of them, but still bind kind and binary per proposal (#6221).
    let accepted = false;
    let bindingMismatch = false;
    for (const store of stores) {
      let proposal = null;
      try {
        proposal = store.require?.(proposalId) ?? store.get?.(proposalId) ?? null;
      } catch {
        continue;
      }
      if (!proposal) continue;
      const liveToken = store.approvals?.get?.(proposalId);
      const inflightToken = store.inflight?.get?.(proposalId);
      if (authorization.token !== liveToken && authorization.token !== inflightToken) continue;
      // Kind binding: capabilities with a proposal-kind mapping require an
      // exact kind match; unmapped capabilities (runtime.*, patch.apply,
      // patch.revert, project.*) accept any live token from the trusted
      // store, with binding still enforced below.
      const kindsForCapability = CAPABILITY_KINDS[entry.id];
      if (kindsForCapability != null && !kindsForCapability.includes(proposal.kind)) continue;
      const proposalBinary = proposal.binding?.binaryId ?? null;
      const currentBinary = this.currentBinaryId();
      if (proposalBinary != null && currentBinary != null && String(proposalBinary) !== String(currentBinary)) {
        bindingMismatch = true;
        continue;
      }
      accepted = true;
      break;
    }
    if (bindingMismatch && !accepted) {
      throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
    }
    if (!accepted) {
      throw new AIError('approval_required', `Capability ${entry.id} requires a proposal approval token.`);
    }
  }

  executeTool(entry, args, options) {
    const record = this.toolRegistry?.get?.(entry.agentTool);
    if (!record) throw new AIError('invalid_tool_call', `Analysis tool is unavailable: ${entry.agentTool}`);
    const scope = options?.scope || 'auto';
    if (scope !== 'auto') {
      const allowedScopes = record.scopeSupport || entry.scopeSupport || [];
      if (!allowedScopes.includes(scope)) {
        throw new AIError('scope_violation', `${entry.id} does not support ${scope} scope.`);
      }
    }
    return typeof this.toolRegistry.execute === 'function'
      ? this.toolRegistry.execute(entry.agentTool, args, options)
      : record.execute(args, options);
  }

  async executeAction(entry, args) {
    if (typeof this.actionRunner !== 'function') throw new AIError('tool_failed', 'Workbench action adapter is unavailable.');
    await this.actionRunner({ kind: entry.actionKind, ...args });
    return { ok: true, capability: entry.id };
  }

  async executeBuiltIn(entry, args, options, runtimePlatform = null) {
    const app = this.app;
    switch (entry.id) {
      case 'annotation.rename': return renameSymbol(app, args);
      case 'annotation.comment': return setNote(app, 'comment', args);
      case 'annotation.set-type': return setType(app, args);
      case 'annotation.struct-field': return setStructField(app, args);
      case 'annotation.project': return setProjectAnnotation(app, args);
      case 'patch.preview': return previewPatch(app, args);
      case 'patch.create': return createPatch(app, args);
      case 'patch.inspect': return { patches: (app?.patches?.list?.() || []).map(serializePatch) };
      case 'patch.revert': return this.revertPatch(args);
      case 'patch.apply': return applyPatch(app, args);
      case 'runtime.status': return runtimeStatus(runtimePlatform);
      case 'runtime.connect': return runtimePlatform?.startSession?.({ adapter: args.adapter || null, binaryHash: args.binaryId || this.currentBinaryId(), trace: args.trace || {}, connect: true }) ?? unavailable('runtime connect');
      case 'runtime.attach': return runtimeAdapter(runtimePlatform).attach(args.target || {}, options);
      case 'runtime.detach': return runtimePlatform.sessions.close(args.runtimeSessionId);
      case 'runtime.breakpoint-create': return runtimeAdapter(runtimePlatform).setBreakpoint(args.breakpoint || args);
      case 'runtime.watchpoint-create': return runtimeAdapter(runtimePlatform).watchMemory(args.watchpoint || args);
      case 'runtime.breakpoint-remove': case 'runtime.watchpoint-remove': return runtimeAdapter(runtimePlatform).removeBreakpoint(args.id);
      case 'runtime.continue': return runtimeAdapter(runtimePlatform).resume(options);
      case 'runtime.pause': return runtimeAdapter(runtimePlatform).pause(options);
      case 'runtime.step-in': return runtimeAdapter(runtimePlatform).stepInto(options);
      case 'runtime.step-over': return runtimeAdapter(runtimePlatform).stepOver(options);
      case 'runtime.step-out': return runtimeAdapter(runtimePlatform).stepOut(options);
      case 'runtime.registers': return runtimeAdapter(runtimePlatform).readRegisters(args.threadId);
      case 'runtime.memory-read': return boundedMemoryRead(runtimeAdapter(runtimePlatform), args);
      case 'runtime.memory-write': return boundedMemoryWrite(runtimeAdapter(runtimePlatform), args);
      case 'runtime.experiment': return runtimePlatform.runExperiment(args.experiment, options);
      case 'project.save': return callRequired(app?.workspace, 'autosave');
      case 'project.snapshot': return callRequired(app?.workspace, 'snapshot');
      case 'project.restore-known': return callRequired(app?.workspace, 'importProject', args.project);
      case 'project.binary-diff': return callRequired(app?.workspace, 'diff', args.options || {});
      case 'project.export-report': {
        if (typeof app?.report?.export === 'function') return app.report.export(args);
        if (app?.autoReport) return app.autoReport;
        throw new AIError('tool_failed', 'No deterministic report is available to export.');
      }
      default: throw new AIError('invalid_tool_call', `No executor is registered for capability ${entry.id}.`);
    }
  }

  async revertPatch(args) {
    const patch = this.app?.patches?.at?.(BigInt(args.fileOffset));
    if (!patch) throw new AIError('tool_failed', 'Patch is no longer present.');
    this.app.patches.remove(patch.offset);
    const metadata = serializePatch(patch);
    this.reverts.set(String(patch.offset), metadata);
    return { reverted: true, patch: metadata };
  }
}

function validAuthorization(value) { return value?.kind === 'proposal' && typeof value.token === 'string' && value.token.length >= 8; }
// Proposal kind -> capability binding for approval verification. Capabilities
// without a proposal kind (runtime.*, patch.apply/revert, project.*) accept
// any live token from the trusted store; kind-mapped capabilities require an
// exact match (#6221).
const PROPOSAL_KIND_CAPABILITY = Object.freeze({
  rename: 'annotation.rename',
  comment: 'annotation.comment',
  type: 'annotation.set-type',
  'struct-field': 'annotation.struct-field',
  patch: 'patch.create',
  'project-annotation': 'annotation.project',
});
// Reverse index: capability -> proposal kinds that may authorize it.
// Capabilities absent here (runtime.*, patch.apply/revert, project.*) accept
// any live token from the trusted store.
const CAPABILITY_KINDS = Object.freeze(
  Object.entries(PROPOSAL_KIND_CAPABILITY).reduce((acc, [kind, capability]) => {
    (acc[capability] ||= []).push(kind);
    return acc;
  }, {}),
);
function runtimeAdapter(platform) { const session = platform?.currentSession?.(); if (!session?.adapter) throw new AIError('tool_failed', 'Runtime adapter is unavailable.'); return session.adapter; }
function runtimeStatus(platform) { const session = platform?.currentSession?.(false); return session ? { connected: !!session.adapter?.connected, sessionId: session.id, binaryId: session.binaryHash || null, backend: session.backend, capabilities: session.adapter?.capabilities || {} } : { connected: false, sessionId: null }; }

async function boundedMemoryRead(adapter, args) {
  const size = Number(args.size ?? 1);
  if (!Number.isSafeInteger(size) || size < 1 || size > 256 * 1024) throw new AIError('invalid_tool_call', 'Runtime memory read must be between 1 and 262144 bytes.');
  const bytes = await adapter.readMemory(args.address, size);
  return { address: String(args.address), bytes: Array.from(bytes || []) };
}
async function boundedMemoryWrite(adapter, args) {
  const bytes = byteArray(args.bytes), expected = byteArray(args.expectedBefore);
  if (!bytes.length || bytes.length > 64 * 1024 || bytes.length !== expected.length) throw new AIError('invalid_tool_call', 'Runtime write bytes and expected-before must have the same length between 1 and 65536.');
  const before = await adapter.readMemory(args.address, expected.length);
  if (!equalBytes(before, expected)) throw new AIError('tool_failed', 'Runtime memory target is stale: expected-before does not match.');
  await adapter.writeMemory(args.address, bytes);
  const after = await adapter.readMemory(args.address, bytes.length);
  if (!equalBytes(after, bytes)) throw new AIError('tool_failed', 'Runtime memory write postcondition verification failed.');
  return { address: String(args.address), written: bytes.length, before: Array.from(expected), after: Array.from(bytes) };
}

function setNote(app, kind, args, after = null) {
  const address = BigInt(args.address); const value = String(args.value ?? '');
  const method = kind === 'name' ? 'setName' : 'setComment';
  if (typeof app?.notes?.[method] !== 'function') throw new AIError('tool_failed', `${kind} annotation adapter is unavailable.`);
  app.notes[method](address, value); after?.(); app.viewer?.setSymbols?.(app.symbols); app.updateChrome?.();
  return { ok: true, address: address.toString(), value };
}

// annotation.rename commits two coupled mutations (notes.setName +
// symbols.rename). A failure of the second must not leave the first applied:
// restore the prior note state and only then surface the original error, so a
// failed proposal never ends up partially written (#6255).
function renameSymbol(app, args) {
  const address = BigInt(args.address); const value = String(args.value ?? '');
  if (typeof app?.notes?.setName !== 'function') throw new AIError('tool_failed', 'name annotation adapter is unavailable.');
  const previousName = app.notes.nameOf?.(address);
  app.notes.setName(address, value);
  try {
    app.symbols?.rename?.(address, value);
  } catch (error) {
    try {
      app.notes.setName(address, previousName == null ? '' : previousName);
    } catch (rollbackError) {
      throw new AIError('tool_failed', `Rename failed and the note mutation could not be rolled back: ${rollbackError?.message || rollbackError}`, { cause: String(error?.message || error) });
    }
    app.viewer?.setSymbols?.(app.symbols); app.updateChrome?.();
    throw error;
  }
  app.viewer?.setSymbols?.(app.symbols); app.updateChrome?.();
  return { ok: true, address: address.toString(), value };
}

function setType(app, args) {
  const address = BigInt(args.address), key = String(args.key || 'return'), value = String(args.value ?? '');
  if (typeof app?.notes?.setType !== 'function') throw new AIError('tool_failed', 'Type annotation adapter is unavailable.');
  if (app.notes.setType(address, key, value) === false) throw new AIError('tool_failed', 'Type annotation could not be persisted.');
  return { ok: true, address: address.toString(), key, value };
}

function setStructField(app, args) {
  if (!Array.isArray(app?.notes?.structs)) throw new AIError('tool_failed', 'Structure annotation adapter is unavailable.');
  const name = String(args.struct || args.name || '').trim(), offset = Number(args.offset);
  if (!name || !Number.isSafeInteger(offset) || offset < 0) throw new AIError('invalid_tool_call', 'A structure name and non-negative field offset are required.');
  let struct = app.notes.structs.find((item) => item?.name === name);
  if (!struct) { struct = { name, fields: [] }; app.notes.structs.push(struct); }
  if (!Array.isArray(struct.fields)) struct.fields = [];
  const field = { offset, name: String(args.field || args.fieldName || ''), type: String(args.type || '') };
  const index = struct.fields.findIndex((item) => Number(item?.offset) === offset);
  if (index >= 0) struct.fields[index] = field; else struct.fields.push(field);
  app.notes.dirty = true; app.notes.save?.();
  return { ok: true, struct: name, field };
}

function setProjectAnnotation(app, args) {
  if (!app) throw new AIError('tool_failed', 'Project annotation adapter is unavailable.');
  if (!Array.isArray(app.projectAnnotations)) app.projectAnnotations = [];
  const record = { id: String(args.id || `annotation:${Date.now()}`), kind: String(args.kind || 'note'), value: args.value, createdAt: new Date().toISOString() };
  app.projectAnnotations.push(record);
  app.autoReport ||= { report: { confirmed: [], deep: [] } };
  app.autoReport.report ||= { confirmed: [], deep: [] };
  app.autoReport.report.confirmed ||= [];
  app.autoReport.report.confirmed.push({ ...record, confirmed: true, source: 'project-annotation' });
  app.workspace?.autosave?.(); return record;
}

async function previewPatch(app, args) {
  const validated = await validatePatchTarget(app, args);
  return { ok: true, ...validated, after: byteArray(args.after) };
}
async function createPatch(app, args) {
  const validated = await validatePatchTarget(app, args), after = byteArray(args.after);
  app.patches?.add?.(validated.fileOffset, validated.before, after, { addr: validated.address, label: args.label || null, reason: args.reason || null, expectedBefore: validated.before, createdAt: new Date().toISOString() });
  const stored = app.patches?.at?.(validated.fileOffset);
  if (!stored || !equalBytes(stored.before, validated.before) || !equalBytes(stored.after, after)) throw new AIError('tool_failed', 'Patch postcondition verification failed.');
  return serializePatch(stored);
}
async function validatePatchTarget(app, args) {
  const address = BigInt(args.address), before = byteArray(args.before), after = byteArray(args.after);
  if (!before.length || before.length !== after.length) throw new AIError('invalid_tool_call', 'Patch before/after lengths must match and be non-zero.');
  const regions = app?.store?.get?.('regions') || [];
  const region = regions.find((item) => address >= item.vmAddr && address < item.vmAddr + item.size);
  const fileSize = app?.file?.size ?? app?.store?.get?.('fileInfo')?.size ?? null;
  const range = validatePatchRange(region, address, after.length, fileSize, args.instruction !== false);
  if (!range.ok) throw new AIError('invalid_tool_call', range.error);
  if (app?.patches?.at?.(range.fileOffset)) throw new AIError('tool_failed', 'Patch target already has a patch; revert it before creating a replacement.');
  const result = await app?.backend?.readAt?.(address, before.length);
  const actual = result?.found ? result.bytes : null;
  if (!actual || !equalBytes(actual, before)) throw new AIError('tool_failed', 'Patch target is stale: original bytes no longer match expected-before.');
  return { address, fileOffset: range.fileOffset, before };
}
async function applyPatch(app, args) {
  const source = args.file || app?.file;
  const output = await app?.patches?.apply?.(source);
  if (!(output instanceof Blob)) throw new AIError('tool_failed', 'Patch application did not produce an output Blob.');
  return { ok: true, output, size: output.size, patches: app.patches.list().map(serializePatch) };
}
function serializePatch(item) { return { fileOffset: item.offset.toString(), address: item.addr == null ? null : String(item.addr), before: Array.from(item.before), after: Array.from(item.after), label: item.label || null, reason: item.reason || null }; }
function byteArray(value) { const raw = Array.from(value || []); for (const byte of raw) if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new AIError('invalid_tool_call', 'Mutation contains a non-byte value.'); return Uint8Array.from(raw); }
function equalBytes(a, b) { return a?.length === b?.length && Array.from(a).every((value, index) => value === b[index]); }

function callRequired(target, method, ...args) {
  if (typeof target?.[method] !== 'function') throw new AIError('tool_failed', `Project ${method} capability is unavailable.`);
  return target[method](...args);
}
function unavailable(name) { throw new AIError('tool_failed', `${name} capability is unavailable.`); }

export function createCapabilityExecutor(options) { return new CapabilityExecutor(options); }
