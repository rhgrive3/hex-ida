/*
 * スクリプト（自動化）。IDAPython にあたるものです。
 *
 * 同じ作業を何百回も繰り返すとき、手で押していては終わりません。
 * 「名前に Login を含む関数を全部あげて、それぞれの呼び出し元を数える」
 * といったことを、数行で書けるようにします。言語は JavaScript です
 * （ブラウザの中で動くので、Python ではなくこちらを使います）。
 *
 * 例:
 *
 *   // 名前に "damage" が入る関数を探す
 *   for (const f of await hex.functions()) {
 *     if (f.name && f.name.includes('damage')) print(hex.hex(f.addr), f.name);
 *   }
 *
 *   // ある関数の逆コンパイル結果を表示する
 *   print(await hex.decompile(0x1000A3C0));
 *
 *   // 名前を付ける
 *   await hex.rename(0x1000A3C0, 'ダメージ計算');
 *
 * opaque-origin sandboxとCSPで、外へ通信する手段（fetch など）は使えません。
 * ファイルの中身も、あなたの端末から出ません。
 */

import { decompile, decompiledText } from './decompile.js';
import { readableName } from './rtti.js';
import { inferTypes, recoverStruct } from './types.js';
import { parseHexBytes, isHexBytes, validatePatchRange } from './patch.js';
import { architectureAdapter, unsupportedArchitectureResult, UnsupportedArchitectureError } from './architecture/index.js';
import { Emulator } from './emu.js';

export { UnsupportedArchitectureError } from './architecture/index.js';
import { runInSandbox } from './sandbox.js';
import { investigationServiceFor } from './analysis/investigation-service.js';

function executableRegionForAddress(app, address) {
  const target = BigInt(address);
  return (app?.store?.get?.('regions') || []).find((region) => {
    if (!region?.exec) return false;
    try {
      const start = BigInt(region.vmAddr);
      const size = BigInt(region.size ?? region.declaredSize ?? 0);
      return size > 0n && target >= start && target < start + size;
    } catch { return false; }
  }) || null;
}


function isExecutionContext(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'signal');
}
function scriptPage(result) {
  const status = result?.status || {};
  return {
    results:Array.from(result?.value || []),
    complete:status.completeness === 'complete',
    completeness:status.completeness || 'unsupported',
    reason:status.reason || null,
    truncationReason:status.truncationReason || status.reason || null,
    scannedRegionIds:Array.from(status.scannedRegionIds || []),
    unscannedRegionIds:Array.from(status.unscannedRegionIds || []),
    page:result?.page ? { ...result.page } : null,
  };
}
function legacyRows(page) {
  const rows = Array.from(page?.results || []);
  Object.assign(rows, {
    complete:page?.complete === true,
    completeness:page?.completeness || 'unsupported',
    reason:page?.reason || null,
    truncationReason:page?.truncationReason || null,
    scannedRegionIds:Array.from(page?.scannedRegionIds || []),
    unscannedRegionIds:Array.from(page?.unscannedRegionIds || []),
    page:page?.page ? { ...page.page } : null,
  });
  return rows;
}
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason == null ? 'Script execution cancelled' : String(signal.reason));
  error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal); }
function awaitRequest(request, signal) {
  throwIfAborted(signal);
  if (!signal || !request || typeof request.then !== 'function') return Promise.resolve(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => { try { request.cancel?.(); } catch {} finish(reject, abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

/**
 * スクリプトから触れる道具一式を作る。
 * @param {object} app
 * @param {function} out 1 行出力する関数
 */
export function createApi(app, out, options = {}) {
  const print = (...args) => {
    out(args.map((a) => format(a)).join(' '));
  };
  const signalOf = (context) => isExecutionContext(context) ? context.signal : (options.signal ?? null);

  const region = () => app.codeRegion();
  const architecture = () => String(
    app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown'
  ).toLowerCase();
  const adapter = () => architectureAdapter(architecture());
  const rowOf = (addr) => adapter().rowForAddress(region(), BigInt(addr));
  const addressOfRow = (row) => adapter().addressForRow(region(), row);

  /*
   * Stateful objects cannot cross MessageChannel because methods/functions are
   * not structured-cloneable. Keep Emulator instances on the trusted side and
   * expose opaque handles. sandbox.js turns the handle back into an ergonomic
   * proxy for scripts (`const e = await hex.emulator()`).
   */
  const emulators = new Map();
  let emulatorSeq = 1;
  const MAX_EMULATORS = 16;
  const MAX_EMULATOR_STEPS = 100000;
  const MAX_EMULATOR_DUMP = 1024 * 1024;

  const emulatorOf = (id) => {
    const emu = emulators.get(String(id || ''));
    if (!emu) throw new Error('そのエミュレータは終了済みか、存在しません。');
    return emu;
  };
  const emulatorState = (emu) => ({
    x0: emu.x[0] || 0n,
    pc: emu.pc, sp: emu.sp, steps: emu.steps, stopped: emu.stopped,
    flags: emu.flagText(), regs: emu.registerList(),
    log: emu.log.slice(-256),
    callStack: emu.callStack.slice(-256),
    trace: emu.trace.slice(-256),
  });
  const boundedSteps = (n) => Math.max(1, Math.min(MAX_EMULATOR_STEPS, Math.trunc(Number(n) || 20000)));

  const api = {
    /* ── 基本 ─────────────────────────────────────────── */

    /** 数を 0x… の文字列にする。 */
    hex(v, pad = 8) { return '0x' + BigInt(v).toString(16).toUpperCase().padStart(pad, '0'); },

    /** 開いているファイルの情報。 */
    file() {
      const info = app.store.get('fileInfo');
      const f = app.store.get('file');
      const slice = app.currentSlice();
      return {
        name: f ? f.name : null,
        size: f ? f.size : 0,
        arch: app.store.get('architecture'),
        uuid: slice && slice.info ? slice.info.uuid : null,
        platform: slice && slice.info ? slice.info.platform : null,
        dylibs: slice && slice.info ? slice.info.dylibs : [],
        sections: (app.store.get('regions') || []).map((r) => ({
          name: r.name, addr: r.vmAddr, size: r.size, exec: !!r.exec,
        })),
        raw: info,
      };
    },

    /* ── 関数 ─────────────────────────────────────────── */

    /** 関数の一覧。legacy Array shapeを維持しつつpartial/capを明示する。 */
    functions(limit = 100000, context = null) {
      if (isExecutionContext(limit)) { context = limit; limit = 100000; }
      const signal=signalOf(context); throwIfAborted(signal);
      const max=Math.max(1,Math.min(400000,Math.trunc(Number(limit)||100000)));
      const regions = app.store?.get?.('regions') || [];
      const execRegions = regions.filter((r) => r && r.exec);
      const rows = [];
      for (const r of execRegions.length ? execRegions : [region()].filter(Boolean)) {
        throwIfAborted(signal);
        const list = app.symbols.functionList(r, Math.max(0, max - rows.length));
        rows.push(...list);
        if (rows.length >= max) break;
      }
      const total=Number(app.symbols?.funcs?.length ?? rows.length);
      const complete=app.symbols?.functionStartsComplete === true && rows.length === total && rows.length < max + 1;
      Object.assign(rows, {
        complete,
        completeness:complete?'complete':'partial',
        total:app.symbols?.functionStartsComplete === true ? total : null,
        capped:rows.length >= max && total > rows.length,
        reason:complete?null:(rows.length >= max && total > rows.length?'function-limit':'function-discovery-incomplete'),
        scannedRegionIds:execRegions.map((r)=>String(r.id)),
        unscannedRegionIds:[],
      });
      return rows;
    },

    /** Paged canonical function query for >100k automation. */
    async queryFunctions(page = {}, query = {}, context = null) {
      if (isExecutionContext(page)) { context=page; page={}; query={}; }
      else if (isExecutionContext(query)) { context=query; query={}; }
      const signal=signalOf(context); throwIfAborted(signal);
      const snapshot=await app.analysisQueries.snapshot({signal});
      const result=await app.analysisQueries.functions(snapshot,query,page,{signal});
      return scriptPage(result);
    },

    /** そのアドレスの関数名（自分で付けた名前が優先）。 */
    name(addr) {
      const a = BigInt(addr);
      return app.symbols.nameAt(a) || app.symbols.label(a) || null;
    },

    /** 読める形にした名前（C++ / Swift のマングル解除つき）。 */
    readableName(addr) {
      const n = api.name(addr);
      return n ? readableName(n) : null;
    },

    /** 名前を付ける（IDA の Rename）。 */
    rename(addr, name) {
      const a = BigInt(addr);
      app.notes.setName(a, name);
      app.symbols.rename(a, name);
      app.viewer.setSymbols(app.symbols);
      return true;
    },

    /** その行にメモを書く。 */
    comment(addr, text) {
      app.notes.setComment(BigInt(addr), text);
      return true;
    },

    /** そのアドレスを含む関数の {start, end}。 */
    functionAt(addr) {
      /* Bind containment to the active slice's executable regions before lookup. */
      app.symbols.setFunctionRegions(app.store.get('regions') || [], false);
      return app.symbols.functionAt(BigInt(addr));
    },

    /* ── 中身を読む ───────────────────────────────────── */

    /** 生バイトを読む。 */
    async bytes(addr, len = 16, context = null) {
      if (isExecutionContext(len)) { context=len; len=16; }
      const r = await awaitRequest(app.backend.readAt(BigInt(addr), len), signalOf(context));
      return r && r.found ? r.bytes : null;
    },

    /** 0 終端の文字列として読む。 */
    async string(addr, max = 200, context = null) {
      if (isExecutionContext(max)) { context=max; max=200; }
      const r = await awaitRequest(app.backend.readAt(BigInt(addr), max, true), signalOf(context));
      return r && r.found ? (r.text || null) : null;
    },

    /** 逆アセンブル。[{addr, mn, ops}] */
    async disasm(addr, count = 16, context = null) {
      if (isExecutionContext(count)) { context=count; count=16; }
      const signal=signalOf(context); throwIfAborted(signal);
      const a = BigInt(addr);
      const r = executableRegionForAddress(app, a);
      if (!r) return [];
      const arch = architecture();
      const archAdapter = adapter();
      const limit = Math.max(0, Math.min(10000, Math.trunc(Number(count) || 0)));
      if (!limit) return [];

      // Fixed-size legacy viewers have a stable row<->address mapping owned by
      // the architecture adapter. Variable-length ISAs must use decoder output.
      if (archAdapter.fixedInstructionSize != null) {
        const out2 = [];
        let row = archAdapter.rowForAddress(r, a);
        if (row == null) return [];
        for (let i = 0; i < limit; i++, row++) {
          throwIfAborted(signal);
          const instructionAddress = archAdapter.addressForRow(r, row);
          if (instructionAddress == null) break;
          const chunk = Math.floor(row / 1024);
          const e = await app.backend.fetchChunk(r.id, chunk, true);
          const k = row - chunk * 1024;
          if (!e.mn || !e.mn[k]) break;
          out2.push({ addr:instructionAddress, mn:e.mn[k], ops:e.ops ? e.ops[k] : '' });
        }
        return out2;
      }

      if (typeof app.backend.disassembleAt !== 'function') return unsupportedArchitectureResult('disassemble', arch);
      const decoded = await app.backend.disassembleAt(a, {
        architecture:arch,
        length:Math.min(1024 * 1024, Math.max(64, limit * 16)),
        signal,
      });
      if (!decoded?.supported) return unsupportedArchitectureResult('disassemble', arch);
      return (decoded.instructions || []).slice(0, limit).map((instruction) => ({
        addr:BigInt(instruction.address),
        size:Number(instruction.size || 0),
        mn:instruction.mnemonic || '',
        ops:instruction.opStr || '',
      }));
    },

    /** 逆コンパイル結果（文字列）。 */
    async decompile(addr, context = null) {
      const signal=signalOf(context); throwIfAborted(signal);
      const a = BigInt(addr);
      const arch = architecture();
      const archAdapter = adapter();
      if (archAdapter.fixedInstructionSize == null && arch !== 'arm64' && arch !== 'arm64e') {
        return unsupportedArchitectureResult('decompile', arch);
      }
      const r = executableRegionForAddress(app, a);
      if (!r) return null;
      const res = await app.analyzeFunctionAt(a, { signal });
      if (!res || !res.model) return null;
      const map = archAdapter.fixedInstructionSize != null ? {
        rowOfAddress: (value) => archAdapter.rowForAddress(r, BigInt(value)),
        addrOfRow: (row) => archAdapter.addressForRow(r, row),
      } : {
        rowOfAddress: (a) => a,
        addrOfRow: (row) => row,
      };
      const out2 = decompile(res.model, {
        name: api.name(a), addr:a,
        rowOfAddress: map.rowOfAddress,
        addrOfRow: map.addrOfRow,
        symbolFor: (a) => app.symbols.nameAt(a),
        notes: app.notes,
      });
      return decompiledText(out2);
    },

    /** 引数・戻り値・ローカル変数の推定。 */
    async types(addr, context = null) {
      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:signalOf(context) });
      return res ? inferTypes(res.model) : null;
    },

    /** 構造体の自動復元。 */
    async struct(addr, reg, context = null) {
      if (isExecutionContext(reg)) { context=reg; reg=null; }
      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:signalOf(context) });
      return res ? recoverStruct(res.model, reg) : null;
    },

    /* ── 参照関係 ─────────────────────────────────────── */

    /** Canonical typed incoming references. */
    async queryXrefsTo(addr, page = {}, context = null) {
      if (isExecutionContext(page)) { context=page; page={}; }
      const signal=signalOf(context); throwIfAborted(signal);
      const snapshot=await app.analysisQueries.snapshot({signal});
      return scriptPage(await app.analysisQueries.xrefs(snapshot,BigInt(addr),page,{signal}));
    },

    /** Legacy Array compatibility; completeness is preserved as metadata. */
    async xrefsTo(addr, limit = 200, context = null) {
      if (isExecutionContext(limit)) { context=limit; limit=200; }
      const page=await api.queryXrefsTo(addr,{offset:0,limit:Math.max(1,Math.min(5000,Number(limit)||200))},context);
      return legacyRows(page);
    },

    /** Canonical typed outgoing calls. */
    async queryXrefsFrom(addr, page = {}, context = null) {
      if (isExecutionContext(page)) { context=page; page={}; }
      const signal=signalOf(context); throwIfAborted(signal);
      const snapshot=await app.analysisQueries.snapshot({signal});
      return scriptPage(await app.analysisQueries.callees(snapshot,BigInt(addr),page,{signal}));
    },

    async xrefsFrom(addr, limit = 200, context = null) {
      if (isExecutionContext(limit)) { context=limit; limit=200; }
      const page=await api.queryXrefsFrom(addr,{offset:0,limit:Math.max(1,Math.min(5000,Number(limit)||200))},context);
      return legacyRows(page);
    },

    /** Global statistic: demand-start the shared Program producer, never read warm-cache presence. */
    async queryMostCalled(limit = 20, context = null) {
      if (isExecutionContext(limit)) { context=limit; limit=20; }
      const signal=signalOf(context); throwIfAborted(signal);
      const program=await investigationServiceFor(app).buildProgram({signal});
      throwIfAborted(signal);
      if (!program) return {results:[],complete:false,completeness:'unsupported',reason:'program-index-unavailable',page:null};
      const results=Array.from(program.mostCalled(Math.max(1,Math.min(5000,Number(limit)||20))) || []);
      const complete=program.graphCompleteness?.complete !== false && program.unsupported !== true && program.queryIncompleteReason == null;
      return {results,complete,completeness:complete?'complete':'partial',reason:complete?null:(program.queryIncompleteReason||program.graphCompleteness?.reasons?.[0]||'program-partial'),page:null};
    },

    async mostCalled(limit = 20, context = null) {
      if (isExecutionContext(limit)) { context=limit; limit=20; }
      return legacyRows(await api.queryMostCalled(limit,context));
    },

    /* ── 文字列 ───────────────────────────────────────── */

    /** 集めた文字列（あらかじめ「文字列」画面を開くか、await hex.loadStrings() が要る）。 */
    strings() { return app.stringIndex || []; },

    async loadStrings(context = null) { return investigationServiceFor(app).collectStrings({ signal:signalOf(context) }); },

    /** 文字列を検索する。 */
    findStrings(query, limit = 200) {
      const q = String(query ?? '').toLowerCase();
      const max = Math.max(1, Math.min(5000, Number(limit) || 200));
      const source = app.stringIndex || (app.strings?.items) || [];
      const results = [];
      for (const s of source) {
        const text = s?.text;
        if (typeof text !== 'string') continue;
        if (!q || text.toLowerCase().includes(q)) {
          results.push(s);
          if (results.length >= max) break;
        }
      }
      return results;
    },

    /* ── Objective-C ──────────────────────────────────── */

    /** クラス一覧。 */
    classes() {
      const m = app.objcModel;
      return m ? m.classes.map((c) => ({ name: c.name, superclass: c.superclass, methods: c.methods.length, ivars: c.ivars.length })) : [];
    },

    /** クラス 1 つの中身。 */
    classInfo(name) { return app.fields ? app.fields.classInfo(name) : null; },

    /* ── 書き換え ─────────────────────────────────────── */

    /** 現在のarchitecture用に命令を組み立てる。 */
    assemble(text, at) {
      const arch = architecture();
      const archAdapter = adapter();
      if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
      return archAdapter.assemble(text, BigInt(at));
    },

    /** 書き換えを登録する（保存するまでファイルは変わりません）。 */
    async patch(addr, textOrHex) {
      const a = BigInt(addr);
      const r = executableRegionForAddress(app, a);
      if (!r) return { error: 'セクションが選ばれていません。' };
      const raw = isHexBytes(textOrHex);
      const arch = architecture();
      const archAdapter = adapter();
      let built;
      if (raw) built = { bytes:parseHexBytes(textOrHex) };
      else {
        if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
        built = archAdapter.assemble(textOrHex, a);
      }
      if (!built?.bytes) return built;
      if (!raw) {
        const placement = archAdapter.validateInstructionPlacement(r, a, built.bytes.length);
        if (!placement?.ok) return placement;
      }
      const file = app.store.get('file');
      // Explicit raw bytes are ISA-neutral and may be any in-range length/alignment.
      const valid = validatePatchRange(r, a, built.bytes.length, file && file.size, false);
      if (valid.error) return valid;
      const before = await api.bytes(a, built.bytes.length);
      if (!before || before.length !== built.bytes.length) return { error: '元のバイトを読み取れません。' };
      const mode = raw ? 'raw' : 'assembly';
      app.patches.add(valid.fileOffset, before, built.bytes, { addr:a, text:textOrHex, mode, architecture:arch });
      return { ok:true, bytes:built.bytes, mode, architecture:arch };
    },

    /* ── 実行してみる ─────────────────────────────────── */

    /**
     * 関数を動かしてみる。
     * @returns {{x0, steps, stopped, log}}
     */
    async run(addr, args = [], maxSteps = 20000) {
      const emu = makeEmulator(app);
      emu.setup(BigInt(addr), args.map((v) => BigInt(v)));
      await emu.run(boundedSteps(maxSteps));
      return {
        x0: emu.x[0], steps: emu.steps, stopped: emu.stopped,
        log: emu.log.slice(-256), regs: emu.registerList(),
      };
    },

    /**
     * Stateful emulator for scripts. Only the handle crosses the sandbox RPC;
     * sandbox.js presents it as an object with setup/step/run/get/set/... methods.
     */
    emulatorCreate(addr = null, args = []) {
      if (emulators.size >= MAX_EMULATORS) throw new Error('同時に作れるエミュレータは16個までです。');
      const emu = makeEmulator(app);
      if (addr != null) emu.setup(BigInt(addr), (args || []).map((v) => BigInt(v)));
      const id = 'emu' + emulatorSeq++;
      emulators.set(id, emu);
      return { id, state: emulatorState(emu) };
    },

    /* Direct callers get the same clone-safe descriptor. In the sandbox, the
       special `hex.emulator()` proxy calls emulatorCreate automatically. */
    emulator(addr = null, args = []) { return api.emulatorCreate(addr, args); },

    emulatorSetup(id, addr, args = []) {
      const emu = emulatorOf(id);
      emu.setup(BigInt(addr), (args || []).map((v) => BigInt(v)));
      return emulatorState(emu);
    },

    async emulatorStep(id) {
      const emu = emulatorOf(id);
      const result = await emu.step();
      return { result, state: emulatorState(emu) };
    },

    async emulatorRun(id, maxSteps = 20000) {
      const emu = emulatorOf(id);
      const result = await emu.run(boundedSteps(maxSteps));
      return { result, state: emulatorState(emu) };
    },

    emulatorState(id) { return emulatorState(emulatorOf(id)); },
    emulatorGetRegister(id, reg) { return emulatorOf(id).get(String(reg || '')); },
    emulatorSetRegister(id, reg, value) {
      const emu = emulatorOf(id);
      emu.set(String(reg || ''), BigInt(value));
      return emu.get(String(reg || ''));
    },

    async emulatorDump(id, addr, len = 64) {
      const n = Math.max(0, Math.min(MAX_EMULATOR_DUMP, Math.trunc(Number(len) || 0)));
      return emulatorOf(id).dump(BigInt(addr), n);
    },

    async emulatorStore(id, addr, size, value) {
      const n = Math.trunc(Number(size));
      if (![1, 2, 4, 8].includes(n)) throw new Error('書き込みサイズは 1 / 2 / 4 / 8 バイトだけ使えます。');
      await emulatorOf(id).store(BigInt(addr), n, BigInt(value));
      return true;
    },

    emulatorAddBreakpoint(id, addr) {
      const emu = emulatorOf(id);
      emu.breakpoints.add(BigInt(addr).toString());
      return true;
    },
    emulatorRemoveBreakpoint(id, addr) {
      const emu = emulatorOf(id);
      return emu.breakpoints.delete(BigInt(addr).toString());
    },
    emulatorBreakpoints(id) { return Array.from(emulatorOf(id).breakpoints, (v) => BigInt(v)); },
    emulatorReset(id) { const emu = emulatorOf(id); emu.reset(); return emulatorState(emu); },
    emulatorDestroy(id) { return emulators.delete(String(id || '')); },

    /* ── 画面を動かす ─────────────────────────────────── */

    goto(addr) { app.goToAddress(BigInt(addr)); return true; },

    open(addr) { app.openFunctionReport(BigInt(addr)); return true; },
  };

  return { api, print };
}

/** app からエミュレータを作る（画面側でも使う）。 */
export function makeEmulator(app) {
  // Legacy callers predate architecture metadata and were ARM64-only. Keep that
  // compatibility path, while explicit unknown/foreign architectures fail closed.
  const detectedArchitecture = app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture;
  const architecture = String(detectedArchitecture || 'arm64').toLowerCase();
  const adapter = architectureAdapter(architecture);
  if (adapter.id !== 'arm64') throw new UnsupportedArchitectureError('emulate', architecture);
  const regions = (app.store.get('regions') || []).filter((r) => r.exec && r.size > 0n);
  const regionAt = (addr) => regions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.size) || null;
  return new Emulator({
    read: (addr, len) => app.backend.readAt(addr, len)
      .then((r) => (r && r.found ? r.bytes : null)).catch(() => null),
    fetch: async (addr) => {
      const r = regionAt(addr);
      if (!r) return null;
      const row = adapter.rowForAddress(r, addr);
      if (row == null) return null;
      const chunk = Math.floor(row / 1024);
      const e = await app.backend.fetchChunk(r.id, chunk, true);
      const k = row - chunk * 1024;
      return { mn: e.mn ? e.mn[k] : '', ops: e.ops ? e.ops[k] : '' };
    },
    isExecutable: (addr) => !!regionAt(addr),
    symbolFor: (addr) => app.symbols.nameAt(addr),
    labelFor: (addr) => app.symbols.label(addr),
  });
}

/** 何を渡されても、1 行の文字列にする。 */
function format(v) {
  if (v == null) return String(v);
  if (typeof v === 'bigint') return '0x' + v.toString(16).toUpperCase();
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) {
    return Array.from(v.slice(0, 64)).map((b) => b.toString(16).padStart(2, '0')).join(' ') +
      (v.length > 64 ? ' …' : '');
  }
  if (Array.isArray(v)) return '[' + v.slice(0, 20).map(format).join(', ') + (v.length > 20 ? ', …' : '') + ']';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? '0x' + val.toString(16).toUpperCase() : val), 1);
    } catch { return String(v); }
  }
  return String(v);
}

/**
 * スクリプトを走らせる。
 * @param {string} code
 * @param {object} app
 * @param {function} out 出力を受け取る
 */
export async function runScript(code, app, out, options = {}) {
  const { api, print } = createApi(app, out, options);
  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args), signal:options.signal ?? null });
}

/* ── はじめての人のためのお手本 ─────────────────────────── */

export const SAMPLES = [
  {
    title: 'よく呼ばれている関数を 20 個',
    why: 'アプリの本筋は、たいてい「たくさん呼ばれている関数」の中にあります。',
    code: `for (const f of await hex.mostCalled(20)) {
  print(hex.hex(f.addr), ((await hex.name(f.addr)) || '(名前なし)'), f.count + ' 回');
}`,
  },
  {
    title: '名前で関数を探す',
    why: '知りたい言葉（login, damage, purchase…）で関数を絞り込みます。',
    code: `const word = 'init';
let n = 0;
for (const f of await hex.functions()) {
  if (f.name && f.name.toLowerCase().includes(word)) { print(hex.hex(f.addr), f.name); if (++n >= 30) break; }
}
print('見つかった数:', n);`,
  },
  {
    title: '逆コンパイル結果を見る',
    why: 'アドレスを 1 つ決めて、C 風の書き方で読みます。',
    code: `const f = (await hex.functions())[0];
print(hex.hex(f.addr), f.name || '');
print(await hex.decompile(f.addr));`,
  },
  {
    title: '動かしてみる（引数を変えて）',
    why: '同じ関数に違う値を渡して、戻り値がどう変わるかを見ます。',
    code: `const addr = (await hex.functions())[0].addr;
for (const v of [0, 1, 100]) {
  const r = await hex.run(addr, [v], 5000);
  print('引数', v, '→ 戻り値', r.x0, '(' + r.steps + ' 命令)');
}`,
  },
  {
    title: '文字列を使っている関数を数える',
    why: '「どの画面の文字がどこで使われているか」をたどります。',
    code: `await hex.loadStrings();
const hits = await hex.findStrings('error', 10);
for (const s of hits) {
  const refs = await hex.xrefsTo(s.addr, 20);
  print(JSON.stringify(s.text).slice(0, 40), '→ 参照', refs.length, '件');
}`,
  },
];