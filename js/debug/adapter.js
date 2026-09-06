export const DEBUG_PROTOCOL_VERSION = 1;
export const BREAKPOINT_KINDS = Object.freeze(['address', 'function', 'conditional', 'memory']);
export const WATCHPOINT_ACCESS = Object.freeze(['read', 'write', 'readwrite']);
export const DEBUG_CAPABILITIES = Object.freeze([
  'connect','disconnect','attach','launch','pause','resume','stepInto','stepOver','stepOut',
  'breakpointAddress','breakpointFunction','breakpointConditional','watchpointMemory',
  'removeBreakpoint','listBreakpoints',
  'readRegisters','writeRegister','readMemory','writeMemory','threads','modules','backtrace',
  'evaluate','traceFunction','traceCall','traceReturn','traceBranch','traceMemoryWrite','traceMemoryRead',
  'objcRuntime','swiftRuntime','cancel','replay'
]);

export class DebugAdapterError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'DebugAdapterError';
    this.code = code;
    this.details = details;
  }
}

export function asAddress(value, name = 'address') {
  try {
    if (typeof value === 'bigint') {
      if (value < 0n) throw new Error('negative');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe-number');
      if (value < 0) throw new Error('negative');
      return BigInt(value);
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) throw new Error('empty');
      const out = BigInt(text);
      if (out < 0n) throw new Error('negative');
      return out;
    }
    throw new Error('invalid-type');
  } catch {
    throw new DebugAdapterError('invalid-address', `${name} must be a non-negative integer`);
  }
}

/** Strict protocol integer validation. UI convenience clamping belongs at the UI boundary. */
export function boundedInteger(value, fallback, min, max, name = 'value') {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || !Number.isInteger(candidate)) {
    throw new DebugAdapterError('invalid-number', `${name} must be a finite integer`, { name, value });
  }
  const n = candidate;
  if (n < min || n > max) {
    throw new DebugAdapterError('out-of-range', `${name} must be between ${min} and ${max}`, { name, value: n, min, max });
  }
  return n;
}

export function normalizeCapabilities(input = {}) {
  const source = input instanceof Set ? Object.fromEntries([...input].map((k) => [k, true])) : input;
  const out = {};
  for (const key of DEBUG_CAPABILITIES) out[key] = source[key] === true;
  return Object.freeze(out);
}

function breakpointId(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !value.trim()) {
    throw new DebugAdapterError('invalid-breakpoint', 'breakpoint id must be a non-empty string');
  }
  return value;
}

export function normalizeBreakpoint(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new DebugAdapterError('invalid-breakpoint', 'breakpoint must be an object');
  const kind = spec.kind == null
    ? (spec.address != null ? 'address' : typeof spec.function === 'string' && spec.function.trim() ? 'function' : null)
    : spec.kind;
  if (!BREAKPOINT_KINDS.includes(kind)) throw new DebugAdapterError('invalid-breakpoint', `unsupported breakpoint kind: ${kind}`);
  if (kind === 'address') {
    const address = asAddress(spec.address);
    const id = breakpointId(spec.id, `bp:address:${address}`);
    return { id, kind, address, enabled: spec.enabled !== false };
  }
  if (kind === 'function') {
    if (typeof spec.function !== 'string') throw new DebugAdapterError('invalid-breakpoint', 'function breakpoint requires function');
    const fn = spec.function.trim();
    if (!fn) throw new DebugAdapterError('invalid-breakpoint', 'function breakpoint requires function');
    const address = spec.address == null ? null : asAddress(spec.address);
    const id = breakpointId(spec.id, `bp:function:${fn}:${address ?? ''}`);
    return { id, kind, function: fn, address, enabled: spec.enabled !== false };
  }
  if (kind === 'conditional') {
    if (spec.address == null) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires address');
    const address = asAddress(spec.address);
    if (typeof spec.condition !== 'string') throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires condition');
    const condition = spec.condition.trim();
    if (!condition) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires condition');
    const id = breakpointId(spec.id, `bp:conditional:${address}:${condition}`);
    return { id, kind, address, condition, enabled: spec.enabled !== false };
  }
  const address = asAddress(spec.address);
  const size = boundedInteger(spec.size, 1, 1, 4096, 'watchpoint size');
  if (spec.access != null && typeof spec.access !== 'string') {
    throw new DebugAdapterError('invalid-watchpoint-access', 'watchpoint access must be a string', { access: spec.access, allowed: WATCHPOINT_ACCESS });
  }
  const access = spec.access == null ? 'write' : spec.access.toLowerCase();
  if (!WATCHPOINT_ACCESS.includes(access)) {
    throw new DebugAdapterError('invalid-watchpoint-access', `unsupported watchpoint access: ${spec.access}`, { access: spec.access, allowed: WATCHPOINT_ACCESS });
  }
  const id = breakpointId(spec.id, `bp:memory:${address}:${size}:${access}`);
  return { id, kind: 'memory', address, size, access, enabled: spec.enabled !== false };
}

const METHOD_CAPABILITY = Object.freeze({
  attach:'attach', launch:'launch', pause:'pause', resume:'resume', stepInto:'stepInto', stepOver:'stepOver', stepOut:'stepOut',
  setBreakpoint:null, removeBreakpoint:'removeBreakpoint', listBreakpoints:'listBreakpoints',
  readRegisters:'readRegisters', writeRegister:'writeRegister', readMemory:'readMemory', writeMemory:'writeMemory',
  getThreads:'threads', getModules:'modules', getBacktrace:'backtrace', evaluate:'evaluate',
  trace:'traceFunction', traceCall:'traceCall', traceReturn:'traceReturn', traceBranch:'traceBranch',
  traceMemoryWrite:'traceMemoryWrite', traceMemoryRead:'traceMemoryRead', watchMemory:'watchpointMemory',
  getObjCRuntimeInfo:'objcRuntime', getSwiftRuntimeInfo:'swiftRuntime', cancel:'cancel', replay:'replay'
});

export function capabilityMethod(capability) {
  for (const [method, cap] of Object.entries(METHOD_CAPABILITY)) if (cap === capability) return method;
  return null;
}

function notImplemented(adapter, capability, method) {
  adapter.require(capability);
  throw new DebugAdapterError('not-implemented', `${method} is advertised but not implemented`, { capability, method });
}

function capabilityImplemented(adapter, capability) {
  const method = capabilityMethod(capability);
  if (!method) return true;
  const implementation = adapter[method];
  if (typeof implementation !== 'function') return false;
  if (implementation !== DebugAdapter.prototype[method]) return true;
  return capability !== 'traceFunction'
    && capability.startsWith('trace')
    && adapter.trace !== DebugAdapter.prototype.trace;
}

export class DebugAdapter {
  constructor({ id, kind = 'generic', capabilities = {} } = {}) {
    if (typeof kind !== 'string' || !kind.trim()) {
      throw new DebugAdapterError('invalid-adapter-kind', 'adapter kind must be a non-empty string');
    }
    if (id != null && (typeof id !== 'string' || !id.trim())) {
      throw new DebugAdapterError('invalid-adapter-id', 'adapter id must be a non-empty string');
    }
    this.id = id == null ? `${kind}-adapter` : id;
    this.kind = kind;
    this.capabilities = normalizeCapabilities({ connect: true, disconnect: true, ...capabilities });
    this.connected = false;
  }
  negotiate(requested = null) {
    if (!requested) {
      const out = {};
      for (const key of DEBUG_CAPABILITIES) {
        Object.defineProperty(out, key, {
          value: !!this.capabilities[key] && capabilityImplemented(this, key),
          enumerable: true, configurable: true, writable: true,
        });
      }
      return Object.freeze(out);
    }
    const requestedMap = requested instanceof Set || Array.isArray(requested) ? null : requested;
    const keys = requestedMap ? Object.keys(requestedMap) : [...requested];
    const out = {};
    for (const key of keys) {
      const explicitlyRequested = !requestedMap || requestedMap[key] === true;
      const value = explicitlyRequested && DEBUG_CAPABILITIES.includes(key)
        ? !!this.capabilities[key] && capabilityImplemented(this, key)
        : false;
      Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
    }
    return Object.freeze(out);
  }
  require(capability) {
    if (!this.capabilities[capability]) throw new DebugAdapterError('unsupported', `${this.kind} adapter does not support ${capability}`, { capability });
  }
  requireMethod(method) {
    if (!Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, method)) {
      throw new DebugAdapterError('unsupported-method', `unknown debug adapter method: ${method}`, { method });
    }
    const cap = METHOD_CAPABILITY[method];
    if (cap) this.require(cap);
  }
  async connect() { this.connected = true; return { adapter: this.id, capabilities: this.capabilities }; }
  async disconnect() { this.connected = false; return { disconnected: true }; }
  async attach() { return notImplemented(this, 'attach', 'attach'); }
  async launch() { return notImplemented(this, 'launch', 'launch'); }
  async pause() { return notImplemented(this, 'pause', 'pause'); }
  async resume() { return notImplemented(this, 'resume', 'resume'); }
  async stepInto() { return notImplemented(this, 'stepInto', 'stepInto'); }
  async stepOver() { return notImplemented(this, 'stepOver', 'stepOver'); }
  async stepOut() { return notImplemented(this, 'stepOut', 'stepOut'); }
  async setBreakpoint(spec) {
    const bp = normalizeBreakpoint(spec);
    const cap = bp.kind === 'address' ? 'breakpointAddress' : bp.kind === 'function' ? 'breakpointFunction' : bp.kind === 'conditional' ? 'breakpointConditional' : 'watchpointMemory';
    this.require(cap);
    return bp;
  }
  async removeBreakpoint() { this.require('removeBreakpoint'); throw new DebugAdapterError('not-implemented', 'removeBreakpoint is not implemented'); }
  async listBreakpoints() { this.require('listBreakpoints'); throw new DebugAdapterError('not-implemented', 'listBreakpoints is not implemented'); }
  async readRegisters() { return notImplemented(this, 'readRegisters', 'readRegisters'); }
  async writeRegister() { return notImplemented(this, 'writeRegister', 'writeRegister'); }
  async readMemory() { return notImplemented(this, 'readMemory', 'readMemory'); }
  async writeMemory() { return notImplemented(this, 'writeMemory', 'writeMemory'); }
  async getThreads() { return notImplemented(this, 'threads', 'getThreads'); }
  async getModules() { return notImplemented(this, 'modules', 'getModules'); }
  async getBacktrace() { return notImplemented(this, 'backtrace', 'getBacktrace'); }
  async evaluate() { return notImplemented(this, 'evaluate', 'evaluate'); }
  async trace(...args) { this.require('traceFunction'); return this._traceCapability('traceFunction', ...args); }
  async traceCall(...args) { this.require('traceCall'); return this._traceCapability('traceCall', ...args); }
  async traceReturn(...args) { this.require('traceReturn'); return this._traceCapability('traceReturn', ...args); }
  async traceBranch(...args) { this.require('traceBranch'); return this._traceCapability('traceBranch', ...args); }
  async traceMemoryWrite(...args) { this.require('traceMemoryWrite'); return this._traceCapability('traceMemoryWrite', ...args); }
  async traceMemoryRead(...args) { this.require('traceMemoryRead'); return this._traceCapability('traceMemoryRead', ...args); }
  async _traceCapability(capability, ...args) {
    if (capability !== 'traceFunction' && this.trace !== DebugAdapter.prototype.trace) {
      return this.trace({ capability, args });
    }
    throw new DebugAdapterError('not-implemented', `${capability} is advertised but not implemented`, { capability });
  }
  async watchMemory() { return notImplemented(this, 'watchpointMemory', 'watchMemory'); }
  async getObjCRuntimeInfo() { return notImplemented(this, 'objcRuntime', 'getObjCRuntimeInfo'); }
  async getSwiftRuntimeInfo() { return notImplemented(this, 'swiftRuntime', 'getSwiftRuntimeInfo'); }
  async cancel() { return notImplemented(this, 'cancel', 'cancel'); }
  async replay() { return notImplemented(this, 'replay', 'replay'); }
}
