/*
 * symbolic/function-sandbox.js — deterministic concrete function sandbox.
 * Existing Emulator remains the execution engine; this layer supplies function-
 * level setup, fake object/stack memory and evidence-friendly result snapshots.
 */
import { Emulator } from '../emu.js';
import { symbolicExecute } from './executor.js';

export const DEFAULT_OBJECT_BASE = 0x0000600000001000n;
export const DEFAULT_SANDBOX_STEPS = 20000;
export const MAX_SANDBOX_STEPS = 1000000;
// Synthetic object memory is pre-mapped at setup, before any step budget or
// timeout applies, so it needs its own hard cap. 16 MiB is the documented
// backing limit (see setup below) and the adapter-layer maximum.
export const MAX_SANDBOX_OBJECT_SIZE = 16 * 1024 * 1024;

const STRICT_INTEGER_TEXT = /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;
function asBig(v, label = 'sandbox integer') {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && STRICT_INTEGER_TEXT.test(v)) return BigInt(v);
  throw new TypeError(`${label} must be a bigint, safe integer, or strict integer string`);
}
function asBigOrZero(v, label) { return v == null ? 0n : asBig(v, label); }
function asMachineWord64(v, label = 'sandbox integer') { return BigInt.asUintN(64, asBig(v, label)); }
function asMachineValue(v, size, label = 'sandbox memory value') {
  return BigInt.asUintN(Number(BigInt(size)) * 8, asBig(v, label));
}
function strictByteSize(v, label = 'sandbox size') {
  const size = v == null ? 8 : v;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return size;
}

function boundedStepBudget(value) {
  if (value == null) return DEFAULT_SANDBOX_STEPS;
  const n = value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n) || n < 1) {
    throw new RangeError('maxSteps must be a positive finite safe integer');
  }
  return Math.min(n, MAX_SANDBOX_STEPS);
}

function boundedObjectSize(value) {
  if (value == null) return 0x10000;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
    return 0x10000;
  }
  return Math.min(Math.max(0x100, value), MAX_SANDBOX_OBJECT_SIZE);
}

function normalizeWatch(watch, objectBase) {
  const out = [];
  const list = Array.isArray(watch) ? watch : [];
  for (const w of list) {
    if (!w) continue;
    const size = strictByteSize(w.size, 'watch size');
    const addr = w.address != null ? asBig(w.address, 'watch address') : objectBase + asBigOrZero(w.offset, 'watch offset');
    out.push({ name: w.name || null, address: addr, offset: addr - objectBase, size });
  }
  return out;
}

function watchesFromOptions(o, objectBase, canonicalObjectMemory = null) {
  if (Array.isArray(o.watch)) return normalizeWatch(o.watch, objectBase);
  if (Array.isArray(o.objectMemory)) {
    if (canonicalObjectMemory && canonicalObjectMemory.length > 0) {
      return canonicalObjectMemory.map((m) => ({
        name:null, address:objectBase + BigInt(m.offset), offset:BigInt(m.offset), size:m.size,
      }));
    }
    return normalizeWatch(o.objectMemory, objectBase);
  }
  if (o.objectMemory && typeof o.objectMemory === 'object') {
    if (canonicalObjectMemory && canonicalObjectMemory.length > 0) {
      return canonicalObjectMemory.map((m) => ({
        name:null, address:objectBase + BigInt(m.offset), offset:BigInt(m.offset), size:m.size,
      }));
    }
    return Object.keys(o.objectMemory).map((offset) => ({
      name:null, address:objectBase + BigInt(offset), offset:BigInt(offset), size:8,
    }));
  }
  return [];
}

async function snapshot(emu, watch) {
  const out = [];
  for (const w of watch) out.push({ ...w, value: await emu.load(w.address, w.size) });
  return out;
}

function sparseObjectBytes(emu, objectBase, maxObjectSize) {
  const bytes = new Map();
  const hi = objectBase + BigInt(maxObjectSize);
  for (const [key, page] of emu.mem || []) {
    const base = BigInt(key);
    for (let i = 0; i < page.mask.length; i++) {
      if (!page.mask[i]) continue;
      const addr = base + BigInt(i);
      if (addr < objectBase || addr >= hi) continue;
      bytes.set(addr.toString(), emu.byteAt(addr));
    }
  }
  return bytes;
}

function modifiedRanges(emu, objectBase, maxObjectSize, beforeBytes) {
  const afterBytes = sparseObjectBytes(emu, objectBase, maxObjectSize);
  const addresses = new Set([...beforeBytes.keys(), ...afterBytes.keys()]);
  const changed = [];
  for (const key of addresses) {
    const beforeHas = beforeBytes.has(key), afterHas = afterBytes.has(key);
    if (beforeHas && afterHas && beforeBytes.get(key) === afterBytes.get(key)) continue;
    if (!afterHas) continue;
    changed.push(BigInt(key));
  }
  changed.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const ranges = [];
  for (const addr of changed) {
    const last = ranges[ranges.length - 1];
    if (last && last.address + BigInt(last.size) === addr) last.size++;
    else ranges.push({ address: addr, offset: addr - objectBase, size: 1 });
  }
  return ranges;
}

function isConditionalBranchText(text) { return /^((b\.[a-z]+)|cbz|cbnz|tbz|tbnz)\b/i.test(text || ''); }

function branchTrace(trace, finalPc = null) {
  const out = [];
  for (let i = 0; i < (trace || []).length; i++) {
    const cur = trace[i];
    if (!cur || !isConditionalBranchText(cur.text)) continue;
    const next = i + 1 < trace.length ? trace[i + 1].addr : finalPc;
    if (next == null) continue;
    const authoritative = !!cur.branch && cur.branch.conditional === true && typeof cur.branch.taken === 'boolean';
    const ambiguous = !authoritative && next === cur.addr + 4n;
    let taken = true;
    if (authoritative) taken = cur.branch.taken;
    else if (ambiguous) taken = null;
    const record = { address: cur.addr, text: cur.text, next, taken };
    if (ambiguous) record.ambiguous = true;
    out.push(record);
  }
  return out;
}

export class FunctionSandbox {
  constructor(io, opts) {
    this.emulator = new Emulator(io || {});
    this._initialHeapBase = this.emulator.heap;
    this._setupCount = 0;
    this.objectBase = opts && opts.objectBase != null ? asBig(opts.objectBase) : DEFAULT_OBJECT_BASE;
    this.maxObjectSize = boundedObjectSize(opts && opts.maxObjectSize);
    this.watch = [];
    this.before = [];
    this.beforeObjectBytes = new Map();
  }

  async setup(address, opts) {
    const o = opts || {};
    // #5268: setup is the longest launch phase (mapping + memory stores); an
    // aborted signal must stop the remaining setup work, not just be observed
    // by the caller afterwards. Each checkpoint re-samples signal.aborted.
    const signal = o.signal && typeof o.signal === 'object' && typeof o.signal.addEventListener === 'function' ? o.signal : null;
    const throwIfCancelled = () => {
      if (signal && signal.aborted) {
        throw Object.assign(new Error('sandbox setup cancelled'), { code: 'sandbox-setup-cancelled' });
      }
    };
    throwIfCancelled();
    const args = (o.args || []).map((v) => v == null ? 0n : asBig(v, 'argument'));
    const objectBase = o.objectBase != null ? asBig(o.objectBase) : this.objectBase;
    this.objectBase = objectBase;
    if (o.objectAsArg0 !== false && args.length === 0) args.push(objectBase);
    else if (o.objectAsArg0 !== false && args[0] == null) args[0] = objectBase;
    const firstSetupHeapOverride = this._setupCount === 0 && this.emulator.heap !== this._initialHeapBase ? this.emulator.heap : null;
    this.emulator.reset();
    if (firstSetupHeapOverride != null) {
      this.emulator.heapBase = firstSetupHeapOverride;
      this.emulator.heap = firstSetupHeapOverride;
    }
    this._setupCount++;
    // Synthetic object memory is explicit. Chunk into 1 MiB mappings so
    // maxObjectSize up to MAX_SANDBOX_OBJECT_SIZE can be backed without exceeding single-mapping limit.
    const CHUNK_SIZE = 1024 * 1024;
    let remaining = this.maxObjectSize;
    let currentBase = objectBase;
    while (remaining > 0) {
      throwIfCancelled();
      const chunkSize = Math.min(remaining, CHUNK_SIZE);
      this.emulator.mapZero(currentBase, chunkSize, 'sandbox-object');
      currentBase += BigInt(chunkSize);
      remaining -= chunkSize;
    }
    throwIfCancelled();
    const machineAddress = asMachineWord64(address, 'address');
    const machineArgs = args.map((v) => BigInt.asUintN(64, v));
    this.emulator.setup(machineAddress, machineArgs);

    this.canonicalInput = {
      address:machineAddress.toString(),
      objectBase:objectBase.toString(),
      args:machineArgs.map((v) => v.toString()),
      registers:{}, objectMemory:[], stackMemory:[], watch:[], breakpoints:[],
    };
    for (const [reg, value] of Object.entries(o.registers || {})) {
      const canonicalRegister = asMachineWord64(value, 'register value');
      this.emulator.set(reg, canonicalRegister);
      this.canonicalInput.registers[reg] = canonicalRegister.toString();
    }

    if (Array.isArray(o.objectMemory)) {
      for (const item of o.objectMemory) {
        throwIfCancelled();
        if (!item) continue;
        const canonicalOffset = asBigOrZero(item.offset, 'objectMemory offset');
        const canonicalSize = strictByteSize(item.size, 'objectMemory size');
        if (canonicalOffset < 0n || canonicalOffset + BigInt(canonicalSize) > BigInt(this.maxObjectSize)) {
          throw new RangeError(`objectMemory offset ${canonicalOffset} (+${canonicalSize}) is outside the sandbox object region (maxObjectSize=${this.maxObjectSize})`);
        }
        const canonicalValue = asMachineValue(item.value, canonicalSize, 'objectMemory value');
        await this.emulator.store(objectBase + canonicalOffset, canonicalSize, canonicalValue);
        this.canonicalInput.objectMemory.push({ offset:canonicalOffset.toString(), size:canonicalSize, value:canonicalValue.toString() });
      }
    } else if (o.objectMemory && typeof o.objectMemory === 'object') {
      for (const [offset, value] of Object.entries(o.objectMemory)) {
        throwIfCancelled();
        if (typeof offset !== 'string' || !STRICT_INTEGER_TEXT.test(offset)) {
          throw new TypeError('objectMemory offset key must be a strict integer string');
        }
        const canonicalOffset = BigInt(offset);
        if (canonicalOffset < 0n || canonicalOffset + 8n > BigInt(this.maxObjectSize)) {
          throw new RangeError(`objectMemory offset ${canonicalOffset} (+8) is outside the sandbox object region (maxObjectSize=${this.maxObjectSize})`);
        }
        const canonicalValue = asMachineValue(value, 8, 'objectMemory value');
        await this.emulator.store(objectBase + canonicalOffset, 8, canonicalValue);
        this.canonicalInput.objectMemory.push({ offset:canonicalOffset.toString(), size:8, value:canonicalValue.toString() });
      }
    }

    for (const item of o.stackMemory || []) {
      throwIfCancelled();
      if (!item) continue;
      const canonicalOffset = asBigOrZero(item.offset, 'stackMemory offset');
      const canonicalSize = strictByteSize(item.size, 'stackMemory size');
      const canonicalValue = asMachineValue(item.value, canonicalSize, 'stackMemory value');
      await this.emulator.store(this.emulator.sp + canonicalOffset, canonicalSize, canonicalValue);
      this.canonicalInput.stackMemory.push({ offset:canonicalOffset.toString(), size:canonicalSize, value:canonicalValue.toString() });
    }
    for (const bp of o.breakpoints || []) {
      const canonicalBreakpoint = asBig(bp, 'breakpoint address').toString();
      this.emulator.breakpoints.add(canonicalBreakpoint);
      this.canonicalInput.breakpoints.push(canonicalBreakpoint);
    }
    throwIfCancelled();
    this.watch = watchesFromOptions(o, objectBase, this.canonicalInput.objectMemory);
    this.canonicalInput.watch = this.watch.map((w) => ({ name:w.name || null, address:w.address.toString(), offset:w.offset.toString(), size:w.size }));
    this.before = await snapshot(this.emulator, this.watch);
    this.beforeObjectBytes = sparseObjectBytes(this.emulator, objectBase, this.maxObjectSize);
    return this.state();
  }

  state() {
    return {
      pc: this.emulator.pc,
      sp: this.emulator.sp,
      registers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['x' + i, this.emulator.get('x' + i)])),
      stopped: this.emulator.stopped,
      steps: this.emulator.steps,
    };
  }

  setRegister(reg, value) { this.emulator.set(reg, asBig(value, 'register value')); }
  getRegister(reg) { return this.emulator.get(reg); }
  addBreakpoint(address) { this.emulator.breakpoints.add(asBig(address, 'breakpoint address').toString()); }
  removeBreakpoint(address) { this.emulator.breakpoints.delete(asBig(address, 'breakpoint address').toString()); }

  async step() { return this.emulator.step(); }

  async run(opts) {
    const o = opts || {};
    const maxSteps = boundedStepBudget(o.maxSteps);
    const signal = o.signal == null ? null : o.signal;
    const result = await this.emulator.run(maxSteps, o.onProgress, { signal });
    const after = await snapshot(this.emulator, this.watch);
    const beforeBy = new Map(this.before.map((x) => [x.address.toString() + ':' + x.size, x]));
    const touchedFields = [];
    for (const a of after) {
      const b = beforeBy.get(a.address.toString() + ':' + a.size);
      if (!b || b.value !== a.value) touchedFields.push({
        name: a.name, address: a.address, offset: a.offset, size: a.size,
        before: b ? b.value : null, after: a.value,
      });
    }
    const traceMeta = this.emulator.traceSnapshot();
    const branchFinalPc = result.hitBreakpoint === true ? result.finalPc : (result.steps > 0 && (traceMeta.events?.length || 0) > 0 ? this.emulator.pc : null);
    return {
      ...result,
      stopped: this.emulator.stopped,
      faultCode: this.emulator.faultCode || null,
      returnValue: this.emulator.get('x0'),
      before: this.before,
      after,
      touchedFields,
      modifiedObjectRanges: modifiedRanges(this.emulator, this.objectBase, this.maxObjectSize, this.beforeObjectBytes),
      takenBranches: branchTrace(traceMeta.events, branchFinalPc),
      trace: traceMeta.events,
      traceMeta:{ truncated:traceMeta.truncated, dropped:traceMeta.dropped, limit:traceMeta.limit },
      log: (this.emulator.log || []).slice(),
      steps: this.emulator.steps,
      engine: 'function-sandbox',
    };
  }

  symbolic(ir, opts) { return symbolicExecute(ir, opts); }
}

export function createFunctionSandbox(io, opts) { return new FunctionSandbox(io, opts); }
