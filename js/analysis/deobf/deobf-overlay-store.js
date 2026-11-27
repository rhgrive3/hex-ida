// Non-destructive Deobfuscation Overlay Store (§19.3 / §13.2).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.

export const DEOBF_SOURCE_PRIORITY = Object.freeze({
  EMU_PARTIAL: 1,
  ABSTRACT_VM: 2,
  EMU_EXACT: 3,
});

export const DEOBF_RECORD_KIND = Object.freeze({
  STACK_STR: 1,
  LOOP_DEOBF: 2,
  CONST_ADDR: 3,
  EMU_STR: 4,
  EMU_TABLE: 5,
  EMU_RAW: 6,
});

function toVaKey(va) {
  if (typeof va === 'bigint') return `0x${va.toString(16)}`;
  if (typeof va === 'number' && Number.isFinite(va)) return `0x${BigInt(Math.trunc(va)).toString(16)}`;
  if (typeof va === 'string') {
    const trimmed = va.trim();
    if (/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      return `0x${BigInt(trimmed).toString(16)}`;
    }
    return trimmed.toLowerCase();
  }
  return String(va);
}

export function priorityForSource(source, partialRun = false) {
  if (source === 'mini_arm64_emu' || source === 'emu') {
    return partialRun ? DEOBF_SOURCE_PRIORITY.EMU_PARTIAL : DEOBF_SOURCE_PRIORITY.EMU_EXACT;
  }
  if (source === 'bounded_abstract_vm' || source === 'abstract_vm') {
    return DEOBF_SOURCE_PRIORITY.ABSTRACT_VM;
  }
  return 0;
}

export class DeobfOverlayStore {
  constructor() {
    this._byInsnVa = new Map();
    this._activeControllers = new Set();
    this._revision = 0;
  }

  get revision() {
    return this._revision;
  }

  get size() {
    return this._byInsnVa.size;
  }

  trackTask(abortController) {
    if (abortController && typeof abortController.abort === 'function') {
      this._activeControllers.add(abortController);
    }
    return () => this._activeControllers.delete(abortController);
  }

  setAnnotation(record) {
    if (!record || record.insnVa === undefined || record.insnVa === null) return false;
    const key = toVaKey(record.insnVa);
    const priority = record.priority ?? priorityForSource(record.source, Boolean(record.partialRun));
    const existing = this._byInsnVa.get(key);
    if (existing && existing.priority > priority) {
      return false;
    }

    const entry = {
      insnVa: key,
      kind: record.kind ?? DEOBF_RECORD_KIND.EMU_RAW,
      source: record.source ?? 'unknown',
      priority,
      partialRun: Boolean(record.partialRun),
      text: record.text ?? '',
      resolvedVa: record.resolvedVa !== undefined && record.resolvedVa !== null ? toVaKey(record.resolvedVa) : null,
      payloadBytes: record.payloadBytes ? new Uint8Array(record.payloadBytes) : null,
      inlineBadgeClass: 'tok-deobf-inline',
    };

    this._byInsnVa.set(key, entry);
    this._revision++;
    return true;
  }

  getAnnotation(insnVa) {
    return this._byInsnVa.get(toVaKey(insnVa)) || null;
  }

  listAnnotations() {
    return [...this._byInsnVa.values()];
  }

  clear(reason = 'forget_semantics') {
    for (const ctrl of this._activeControllers) {
      try {
        ctrl.abort(reason);
      } catch {
        // ignore
      }
    }
    this._activeControllers.clear();
    this._byInsnVa.clear();
    this._revision++;
  }
}

export function createDeobfOverlayStore() {
  return new DeobfOverlayStore();
}
