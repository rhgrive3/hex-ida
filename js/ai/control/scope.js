import { AIError } from '../schema.js';
import { addressText } from '../validation.js';

export const SCOPE_ORDER = Object.freeze(['selection', 'function', 'neighborhood', 'binary', 'project', 'runtime']);
const RANK = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(SCOPE_ORDER.map((scope, index) => [scope, index]))));
const FULL_FUNCTION_TOOLS = new Set(['get_function','get_current_function','get_semantic_facts','decompile_function','get_cfg','trace_value','slice_backward','slice_forward','find_thresholds','verify_field_update','find_field_reads','find_field_writes','find_global_accesses']);
const BINARY_TOOLS = new Set(['search_functions','search_strings','compare_functions','lookup_known_function']);
const PROJECT_TOOLS = new Set(['project_search','get_binary_diff']);
const RUNTIME_TOOLS = new Set(['get_runtime_observations','verify_runtime_hypothesis']);
const TOOL_NON_ADDRESS_KEYS = new Map([
  ['inspect_function_region', new Set(['start'])],
]);
const TOOL_FUNCTION_ADDRESS_ARRAY_KEYS = new Map([
  ['find_constant', new Set(['functions'])],
  ['explain_evidence', new Set(['functions'])],
]);

export class ScopeController {
  constructor(snapshot, requestedScope = 'auto', { onExpand } = {}) {
    this.snapshot = snapshot;
    this.requestedScope = requestedScope || 'auto';
    this.effectiveScope = this.requestedScope === 'auto' ? initialScope(snapshot) : this.requestedScope;
    this.onExpand = typeof onExpand === 'function' ? onExpand : null;
    this.expansions = [];
  }

  expandTo(next, reason = 'required evidence') {
    if (this.requestedScope !== 'auto') return false;
    if (typeof next !== 'string' || !Object.hasOwn(RANK, next) || typeof RANK[next] !== 'number') return false;
    const currentRank = typeof this.effectiveScope === 'string' && Object.hasOwn(RANK, this.effectiveScope) ? RANK[this.effectiveScope] : -1;
    if (RANK[next] <= currentRank) return false;
    const event = {
      type: 'scope-expand', from: this.effectiveScope, to: next,
      label: `解析範囲を ${this.effectiveScope} から ${next} へ拡張`, reason: String(reason).slice(0, 300),
      timestamp: new Date().toISOString(),
    };
    this.effectiveScope = next;
    this.expansions.push(event);
    this.onExpand?.(event);
    return true;
  }

  ensureForIntent(intent) {
    const target = scopeForIntent(intent, this.snapshot);
    if (target) this.expandTo(target, `intent:${intent}`);
    return this.effectiveScope;
  }

  scopeAllowsTool(scope = this.effectiveScope, tool, args = {}) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (typeof effective !== 'string' || !Object.hasOwn(RANK, effective)) return false;
    if (effective === 'selection' && FULL_FUNCTION_TOOLS.has(tool)) return false;
    if (BINARY_TOOLS.has(tool) && !atLeast(effective, 'binary')) return false;
    if (PROJECT_TOOLS.has(tool) && !atLeast(effective, 'project')) return false;
    if (RUNTIME_TOOLS.has(tool) && effective !== 'runtime') return false;
    if (effective === 'function' || effective === 'selection' || effective === 'neighborhood') {
      for (const address of collectFunctionAddresses(args, '', tool)) if (!this.scopeContainsFunction(effective, address)) return false;
      for (const address of collectAddresses(args, '', tool)) if (!this.scopeContainsAddress(effective, address)) return false;
    }
    return true;
  }

  scopeContainsAddress(scope = this.effectiveScope, address) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (['binary','project','runtime'].includes(effective)) return true;
    const target = toBigInt(address);
    if (target == null) return false;
    if (effective === 'selection') return inRange(target, this.snapshot.selection?.start, this.snapshot.selection?.end);
    if (effective === 'function') return inFunction(target, this.snapshot.currentFunction);
    if (effective === 'neighborhood') {
      if (inFunction(target, this.snapshot.currentFunction)) return true;
      return (this.snapshot.neighborhood || []).some((item) => sameAddress(item, target));
    }
    return false;
  }

  scopeContainsFunction(scope = this.effectiveScope, address) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (effective === 'selection') return false;
    if (['binary','project','runtime'].includes(effective)) return true;
    if (sameAddress(this.snapshot.currentFunction?.address, address)) return true;
    if (effective !== 'neighborhood') return false;
    // createTurnSnapshot() deliberately seeds the current cursor into the generic
    // address neighborhood. That cursor may be an interior instruction, so it
    // must not become function-identity authority merely by exact membership.
    if (sameAddress(this.snapshot.currentAddress, address)) return false;
    return (this.snapshot.neighborhood || []).some((item) => sameAddress(item, address));
  }

  assertToolCall(tool, args = {}) {
    if (!this.scopeAllowsTool(this.effectiveScope, tool, args)) throw new AIError('scope_violation', `${tool} is outside ${this.effectiveScope} scope.`);
    for (const address of collectFunctionAddresses(args, '', tool)) {
      if (!this.scopeContainsFunction(this.effectiveScope, address)) throw new AIError('scope_violation', `Function ${addressText(address)} is outside ${this.effectiveScope} scope.`);
    }
    for (const address of collectAddresses(args, '', tool)) {
      if (!this.scopeContainsAddress(this.effectiveScope, address)) throw new AIError('scope_violation', `Address ${addressText(address)} is outside ${this.effectiveScope} scope.`);
    }
  }
}

function hasBinaryBinding(snapshot) {
  const binaryId = snapshot?.binaryId;
  if (binaryId == null || binaryId === '') return false;
  const identity = snapshot?.binaryIdentity;
  if (identity?.kind === 'fallback' && identity?.confidence === 'none') return false;
  if (String(binaryId) === 'fallback:unbound') return false;
  return true;
}

export function initialScope(snapshot) {
  if (snapshot?.selection?.start != null) return 'selection';
  if (snapshot?.currentFunction?.address != null) return 'function';
  return snapshot?.projectIdentity && !hasBinaryBinding(snapshot) ? 'project' : 'binary';
}

export function scopeForIntent(intent, snapshot = {}) {
  if (intent === 'find-behaviour' || intent === 'find-function') return 'binary';
  if (intent === 'project-query') return 'project';
  if (intent === 'runtime-verify') return 'runtime';
  if (intent === 'compare') return 'binary';
  if (intent === 'explain-selection') return snapshot?.selection?.start != null && snapshot?.selection?.end != null ? 'selection' : 'function';
  if (intent === 'explain-current-function' || intent === 'trace-value') return 'function';
  return null;
}

export function scopeContainsAddress(snapshot, scope, address) { return new ScopeController(snapshot, scope).scopeContainsAddress(scope, address); }
export function scopeContainsFunction(snapshot, scope, address) { return new ScopeController(snapshot, scope).scopeContainsFunction(scope, address); }
export function scopeAllowsTool(snapshot, scope, tool, args) { return new ScopeController(snapshot, scope).scopeAllowsTool(scope, tool, args); }

function atLeast(scope, minimum) {
  if (typeof scope !== 'string' || !Object.hasOwn(RANK, scope)) return false;
  if (typeof minimum !== 'string' || !Object.hasOwn(RANK, minimum)) return false;
  return RANK[scope] >= RANK[minimum];
}
function collectAddresses(value, key = '', tool = '', seen = new WeakSet(), depth = 0) {
  const out = [];
  if (depth > 64) return out;
  if (TOOL_NON_ADDRESS_KEYS.get(tool)?.has(key) || TOOL_FUNCTION_ADDRESS_ARRAY_KEYS.get(tool)?.has(key)) return out;
  if (isAddressKey(key)) {
    if (value != null) out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  try {
    if (Array.isArray(value)) { for (const item of value) out.push(...collectAddresses(item, key, tool, seen, depth + 1)); return out; }
    for (const [childKey, child] of Object.entries(value)) out.push(...collectAddresses(child, childKey, tool, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
  return out;
}
function collectFunctionAddresses(value, key = '', tool = '', seen = new WeakSet(), depth = 0) {
  const out = [];
  if (depth > 64) return out;
  if (TOOL_FUNCTION_ADDRESS_ARRAY_KEYS.get(tool)?.has(key)) {
    if (!Array.isArray(value)) return value == null ? out : [value];
    for (const item of value) if (item != null) out.push(item);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) out.push(...collectFunctionAddresses(item, key, tool, seen, depth + 1));
      return out;
    }
    for (const [childKey, child] of Object.entries(value)) out.push(...collectFunctionAddresses(child, childKey, tool, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
  return out;
}
function isAddressKey(key) {
  const text = String(key || '');
  return /^(address|addr|start|end|from|to|target)$/i.test(text)
    || /_(address|addr|start|end|from|to|target)$/i.test(text)
    || /(Address|Addr|Start|End|From|To|Target)$/.test(text);
}
function inFunction(target, fn) {
  if (fn?.address == null) return false;
  const start = toBigInt(fn.range?.start ?? fn.address);
  const endExclusive = toBigInt(fn.range?.end);
  if (start == null) return false;
  // Hex function ranges (SymbolIndex.functionAt / ProgramIndex) use an
  // exclusive end. Treating it as inclusive admits the next function's first
  // address into scope=function.
  if (endExclusive != null) return target >= start && target < endExclusive;
  return target === start;
}
function inRange(target, start, end) {
  const a = toBigInt(start), b = toBigInt(end);
  if (a == null) return false;
  if (b == null) return target === a;
  return target >= a && target <= b;
}
function sameAddress(a, b) { const x = toBigInt(a), y = toBigInt(b); return x != null && y != null && x === y; }
function toBigInt(value) {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
    if (typeof value === 'string') return value.trim() === '' ? null : BigInt(value);
    return null;
  } catch { return null; }
}
