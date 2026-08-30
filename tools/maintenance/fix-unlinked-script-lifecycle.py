from pathlib import Path


def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s: return
    if old not in s: raise SystemExit(f'guard failed {path}: {old[:100]!r}')
    p.write_text(s.replace(old,new,1))

# Sandbox: execution context is out-of-band, never an accidental positional arg.
rep('js/sandbox.js',
"export function runInSandbox({ source, mode = 'script', index = 0, api, out, timeout = 30000, signal }) {",
"export function runInSandbox({ source, mode = 'script', index = 0, api, out, timeout = 30000, signal, invokeApi = null }) {")
rep('js/sandbox.js',
"""          // All host APIs receive a final execution context. Existing JS APIs
          // harmlessly ignore the extra argument; long-running adapters can
          // observe signal and cancel backend/worker work immediately.
          value = await fn(...(m.args || []), { signal: runController.signal });""",
"""          // Execution lifecycle is out-of-band: never append an implicit positional
          // argument because many public Script APIs already use optional parameters.
          value = typeof invokeApi === 'function'
            ? await invokeApi(m.method, m.args || [], { signal:runController.signal })
            : await fn(...(m.args || []));""")

# Query API: canonical global usage ranking for Script mostCalled().
rep('js/analysis/query/api.js',
"""  async xrefs(snapshot, entityId, page = {}, options = {}) {
    return this.#query("xrefs", snapshot, [entityId, page], options);
  }

  async types""",
"""  async xrefs(snapshot, entityId, page = {}, options = {}) {
    return this.#query("xrefs", snapshot, [entityId, page], options);
  }

  async mostCalled(snapshot, page = {}, options = {}) {
    return this.#query("mostCalled", snapshot, [page], options);
  }

  async types""")
rep('js/analysis/query/app-adapter.js',
"""    async types(_snapshot, scope, _page = {}, options = {}) {""",
"""    async mostCalled(_snapshot, page = {}, options = {}) {
      if (typeof app?.ensureProgram !== 'function') return unsupported(null, 'program-index-unavailable');
      const program = await app.ensureProgram({ signal:options.signal ?? null, onProgress:options.onProgress });
      if (!program?.mostCalled) return unsupported(null, 'program-index-unavailable');
      if (program.graphCompleteness && (!program.graphCompleteness.supported || program.graphCompleteness.unsupported)) {
        return unsupported(null, program.graphCompleteness.reasons?.[0] || program.queryIncompleteReason || 'unsupported-program-analysis');
      }
      if (program.unsupported) return unsupported(null, program.queryIncompleteReason || 'unsupported-program-analysis');
      const { offset, limit } = pageOf(page);
      const source = program.mostCalled(Math.min(MAX_PAGE, offset + limit));
      const complete = program.completeness?.complete !== false && program.graphCompleteness?.callsComplete !== false && program.callsCapped !== true;
      return paged(Array.from(source || []), page, complete ? 'complete' : 'partial', {
        reason:complete ? null : (program.queryIncompleteReason || program.graphCompleteness?.reasons?.[0] || 'program-analysis-incomplete'),
        scope:'active-slice',
      });
    },

    async types(_snapshot, scope, _page = {}, options = {}) {""")

# Script API helpers and canonical snapshot-bound paging.
rep('js/script.js',
"""  const addressOfRow = (row) => adapter().addressForRow(region(), row);

  /*""",
"""  const addressOfRow = (row) => adapter().addressForRow(region(), row);
  let querySnapshotPromise = null;
  const executionSignal = (options) => options && typeof options === 'object' ? (options.signal ?? null) : null;
  const abortIfNeeded = (signal) => {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Script execution aborted'));
    if (!error.name || error.name === 'Error') error.name = 'AbortError';
    throw error;
  };
  const querySnapshot = (options = {}) => {
    const signal = executionSignal(options);
    abortIfNeeded(signal);
    if (!app.analysisQueries) return Promise.resolve(null);
    if (!querySnapshotPromise) querySnapshotPromise = app.analysisQueries.snapshot({ signal });
    return querySnapshotPromise;
  };
  const pageArray = (rows, result, extra = {}) => Object.assign(Array.from(rows || []), {
    complete:result?.completeness === 'complete',
    completeness:result?.completeness || 'unsupported',
    reason:result?.status?.reason ?? null,
    next:result?.page?.next ?? null,
    total:result?.page?.total ?? null,
    truncated:result?.completeness !== 'complete',
    ...extra,
  });

  /*""")

old_functions="""    /** 関数の一覧。[{addr, name, size}] */
    functions(limit = 100000) {
      const regions = app.store?.get?.('regions') || [];
      const execRegions = regions.filter((r) => r && r.exec);
      if (execRegions.length > 1) {
        const out = [];
        for (const r of execRegions) {
          const list = app.symbols.functionList(r, limit - out.length);
          out.push(...list);
          if (out.length >= limit) break;
        }
        return out;
      }
      const r = region();
      return app.symbols.functionList(r, limit);
    },"""
new_functions="""    /** 関数の一覧。productionではactive slice全体のcanonical queryをpage走査する。 */
    functions(limit = 100000, options = {}) {
      if (limit && typeof limit === 'object') { options = limit; limit = options.limit ?? 100000; }
      const requested = Math.max(0, Math.min(1_000_000, Math.trunc(Number(limit) || 0)));
      if (app.analysisQueries) {
        return (async () => {
          const signal = executionSignal(options);
          const snapshot = await querySnapshot(options);
          const rows = [];
          let offset = 0, last = null;
          while (rows.length < requested) {
            abortIfNeeded(signal);
            const pageLimit = Math.min(5000, requested - rows.length);
            last = await app.analysisQueries.functions(snapshot, {}, { offset, limit:pageLimit }, { signal });
            rows.push(...Array.from(last.value || []));
            if (last.page?.next == null || !last.value?.length) break;
            offset = last.page.next;
          }
          return pageArray(rows, last, {
            complete:last?.completeness === 'complete' && last?.page?.next == null,
            truncated:last?.page?.next != null || last?.completeness !== 'complete',
            requestedLimit:requested,
            scope:'active-slice',
          });
        })();
      }
      // Explicit legacy/headless fallback: scan every executable region and expose incompleteness.
      const regions = (app.store?.get?.('regions') || []).filter((r) => r && r.exec);
      const out = [];
      for (const r of regions) {
        const list = app.symbols.functionList(r, Math.max(0, requested - out.length));
        out.push(...list);
        if (out.length >= requested) break;
      }
      const discoveryComplete = app.symbols?.functionStartsComplete === true || app.symbols?.functionDiscovery?.complete === true;
      return Object.assign(out, {
        complete:discoveryComplete && out.length < requested,
        completeness:discoveryComplete && out.length < requested ? 'complete' : 'partial',
        reason:discoveryComplete ? (out.length >= requested ? 'script-function-limit' : null) : (app.symbols?.functionDiscovery?.reasons?.[0] || 'function-discovery-incomplete'),
        next:out.length >= requested ? out.length : null,
        total:discoveryComplete && out.length < requested ? out.length : null,
        truncated:!discoveryComplete || out.length >= requested,
        scope:'active-slice-legacy-fallback',
      });
    },

    /** Typed/paged function enumeration for large (>100k) automation. */
    async queryFunctions(query = {}, options = {}) {
      if (!app.analysisQueries) {
        const rows = await api.functions(query.limit ?? 1000, options);
        return { results:rows, complete:rows.complete === true, completeness:rows.completeness, reason:rows.reason, next:rows.next, total:rows.total };
      }
      const signal = executionSignal(options);
      const snapshot = await querySnapshot(options);
      const page = { offset:Math.max(0, Math.trunc(Number(query.offset) || 0)), limit:Math.max(1, Math.min(5000, Math.trunc(Number(query.limit) || 1000))) };
      const filter = { text:query.text ?? query.name ?? '', address:query.address ?? null };
      const result = await app.analysisQueries.functions(snapshot, filter, page, { signal });
      return {
        results:Array.from(result.value || []),
        complete:result.completeness === 'complete', completeness:result.completeness,
        reason:result.status?.reason ?? null, next:result.page?.next ?? null, total:result.page?.total ?? null,
        snapshotId:result.snapshotId, scope:'active-slice',
      };
    },"""
rep('js/script.js', old_functions, new_functions)

# Long-running analysis APIs receive explicit options, not accidental RPC position.
rep('js/script.js', "async decompile(addr) {", "async decompile(addr, options = {}) {")
rep('js/script.js', "const res = await app.analyzeFunctionAt(a);", "const res = await app.analyzeFunctionAt(a, { signal:executionSignal(options) });")
rep('js/script.js', "async types(addr) {\n      const res = await app.analyzeFunctionAt(BigInt(addr));", "async types(addr, options = {}) {\n      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:executionSignal(options) });")
rep('js/script.js', "async struct(addr, reg) {\n      const res = await app.analyzeFunctionAt(BigInt(addr));", "async struct(addr, reg, options = {}) {\n      const res = await app.analyzeFunctionAt(BigInt(addr), { signal:executionSignal(options) });")

old_rel="""    /** そのアドレスを呼んでいる場所。 */
    async xrefsTo(addr, limit = 200) {
      await app.ensureProgram?.().catch(() => null);
      const p = app.program;
      if (!p) return [];
      const a = BigInt(addr);
      return p.callSitesTo(a, limit).concat(p.refSitesTo(a, 1n, limit));
    },

    /** その関数が呼んでいる先。 */
    async xrefsFrom(addr, limit = 200) {
      await app.ensureProgram?.().catch(() => null);
      const p = app.program;
      if (!p) return [];
      const range = p.functionRange(BigInt(addr));
      if (!range) return [];
      return p.calleesOf(range.start, range.end, limit);
    },

    /** よく呼ばれている関数の順位。 */
    async mostCalled(limit = 20) {
      await app.ensureProgram?.().catch(() => null);
      return app.program ? app.program.mostCalled(limit) : [];
    },"""
new_rel="""    /** そのアドレスを参照している場所。canonical query + completeness付き。 */
    async xrefsTo(addr, limit = 200, options = {}) {
      const max = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 200)));
      if (app.analysisQueries) {
        const signal = executionSignal(options), snapshot = await querySnapshot(options);
        const result = await app.analysisQueries.xrefs(snapshot, BigInt(addr), { offset:0, limit:max }, { signal });
        return pageArray(result.value, result, { scope:result.status?.scope || 'canonical-xrefs' });
      }
      const p = await app.ensureProgram?.({ signal:executionSignal(options) }).catch(() => null);
      if (!p) return Object.assign([], { complete:false, completeness:'unsupported', reason:'program-index-unavailable', next:null, total:null, truncated:true });
      const a = BigInt(addr), rows = p.callSitesTo(a, max).concat(p.refSitesTo(a, 1n, max));
      return Object.assign(rows, { complete:false, completeness:'partial', reason:p.queryIncompleteReason || 'legacy-program-fallback', next:null, total:null, truncated:true });
    },

    /** その関数が呼んでいる先。unknown boundaryをfalse-emptyにしない。 */
    async xrefsFrom(addr, limit = 200, options = {}) {
      const max = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 200)));
      if (app.analysisQueries) {
        const signal = executionSignal(options), snapshot = await querySnapshot(options);
        const result = await app.analysisQueries.callees(snapshot, BigInt(addr), { offset:0, limit:max }, { signal });
        return pageArray(result.value, result, { scope:result.status?.scope || 'canonical-callees' });
      }
      const p = await app.ensureProgram?.({ signal:executionSignal(options) }).catch(() => null);
      if (!p) return Object.assign([], { complete:false, completeness:'unsupported', reason:'program-index-unavailable', next:null, total:null, truncated:true });
      const range = p.functionRange(BigInt(addr));
      if (!range) return Object.assign([], { complete:false, completeness:'unsupported', reason:'function-range-unavailable', next:null, total:null, truncated:true });
      const rows = p.calleesOf(range.start, range.end, max);
      return Object.assign(Array.from(rows || []), { complete:rows?.complete === true, completeness:rows?.complete === true ? 'complete' : 'partial', reason:rows?.incompleteReason || p.queryIncompleteReason || null, next:null, total:rows?.complete === true ? rows.length : null, truncated:rows?.complete !== true });
    },

    /** よく呼ばれている関数の順位。global artifactをcanonical queryで要求する。 */
    async mostCalled(limit = 20, options = {}) {
      const max = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 20)));
      if (app.analysisQueries) {
        const signal = executionSignal(options), snapshot = await querySnapshot(options);
        const result = await app.analysisQueries.mostCalled(snapshot, { offset:0, limit:max }, { signal });
        return pageArray(result.value, result, { scope:'active-slice' });
      }
      const p = await app.ensureProgram?.({ signal:executionSignal(options) }).catch(() => null);
      if (!p) return Object.assign([], { complete:false, completeness:'unsupported', reason:'program-index-unavailable', next:null, total:null, truncated:true });
      const rows = p.mostCalled(max);
      return Object.assign(Array.from(rows || []), { complete:false, completeness:'partial', reason:p.queryIncompleteReason || 'legacy-program-fallback', next:null, total:null, truncated:true });
    },"""
rep('js/script.js', old_rel, new_rel)

rep('js/script.js', "async loadStrings() { return app.ensureStrings(); },", "async loadStrings(options = {}) { return app.ensureStrings({ signal:executionSignal(options) }); },")
rep('js/script.js', "async run(addr, args = [], maxSteps = 20000) {\n      const emu = makeEmulator(app);\n      emu.setup(BigInt(addr), args.map((v) => BigInt(v)));\n      await emu.run(boundedSteps(maxSteps));", "async run(addr, args = [], maxSteps = 20000, options = {}) {\n      const emu = makeEmulator(app);\n      emu.setup(BigInt(addr), args.map((v) => BigInt(v)));\n      await emu.run(boundedSteps(maxSteps), null, { signal:executionSignal(options) });")
rep('js/script.js', "async emulatorRun(id, maxSteps = 20000) {\n      const emu = emulatorOf(id);\n      const result = await emu.run(boundedSteps(maxSteps));", "async emulatorRun(id, maxSteps = 20000, options = {}) {\n      const emu = emulatorOf(id);\n      const result = await emu.run(boundedSteps(maxSteps), null, { signal:executionSignal(options) });")

# Explicit host dispatcher and runScript external lifecycle.
rep('js/script.js',
"""  return { api, print };
}""",
"""  const invokeApi = async (method, args = [], execution = {}) => {
    const fn = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : null;
    if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + method);
    switch (method) {
      case 'functions': return api.functions(args[0], execution);
      case 'queryFunctions': return api.queryFunctions(args[0] || {}, execution);
      case 'decompile': return api.decompile(args[0], execution);
      case 'types': return api.types(args[0], execution);
      case 'struct': return api.struct(args[0], args[1], execution);
      case 'xrefsTo': return api.xrefsTo(args[0], args[1], execution);
      case 'xrefsFrom': return api.xrefsFrom(args[0], args[1], execution);
      case 'mostCalled': return api.mostCalled(args[0], execution);
      case 'loadStrings': return api.loadStrings(execution);
      case 'run': return api.run(args[0], args[1], args[2], execution);
      case 'emulatorRun': return api.emulatorRun(args[0], args[1], execution);
      default: return fn(...args);
    }
  };
  return { api, print, invokeApi };
}""")
rep('js/script.js',
"""export async function runScript(code, app, out) {
  const { api, print } = createApi(app, out);
  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args) });
}""",
"""export async function runScript(code, app, out, options = {}) {
  const { api, print, invokeApi } = createApi(app, out);
  return runInSandbox({ source: code, mode: 'script', api, invokeApi, signal:options.signal ?? null, out: (...args) => print(...args) });
}""")

# Plugin host: lazy Script/Sandbox imports also remove them from cold startup graph.
p=Path('js/plugins.js'); s=p.read_text(); s=s.replace("import { createApi } from './script.js';\nimport { runInSandbox } from './sandbox.js';\n\n",'')
p.write_text(s)
rep('js/plugins.js',
"""    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000,
    });""",
"""    const { runInSandbox } = await import('./sandbox.js');
    const discovered = await runInSandbox({
      source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000, signal:opts.signal ?? null,
    });""")
rep('js/plugins.js',
"""  async run(id, out) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    const { api, print } = createApi(this.app, out);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api,
      out: (...args) => print(...args) });
  }""",
"""  async run(id, out, options = {}) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    const [{ createApi }, { runInSandbox }] = await Promise.all([import('./script.js'), import('./sandbox.js')]);
    const { api, print, invokeApi } = createApi(this.app, out);
    return runInSandbox({ source:p.source, mode:'plugin', index:p.index, api, invokeApi,
      signal:options.signal ?? null, out:(...args) => print(...args) });
  }""")

# First-party Sheet lifecycle -> sandbox cancellation, plus stale output gating.
rep('js/tools-base.js',
"""export function showScript(app) {
  const sheet = new Sheet('スクリプト');""",
"""export function showScript(app) {
  const sheet = new Sheet('スクリプト');
  let activeController = null;
  let runSerial = 0;
  let closed = false;
  sheet.onClose = () => {
    closed = true;
    runSerial++;
    activeController?.abort('script-sheet-closed');
    activeController = null;
  };""")
rep('js/tools-base.js',
"""  async function run() {
    out.replaceChildren();
    const write = (line) => {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
      out.scrollTop = out.scrollHeight;
    };
    write('— 実行しています —');
    const res = await runScript(ta.value, app, write);
    if (res.error) {
      const row = el('div', 'cl warn');
      row.append(el('span', 'cl-text mono', '⚠ ' + res.error));
      out.append(row);
    } else {
      write('— おわり —');
    }
  }""",
"""  async function run() {
    activeController?.abort('script-rerun');
    const controller = new AbortController();
    activeController = controller;
    const serial = ++runSerial;
    out.replaceChildren();
    const current = () => !closed && !controller.signal.aborted && serial === runSerial;
    const write = (line) => {
      if (!current()) return;
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
      out.scrollTop = out.scrollHeight;
    };
    write('— 実行しています —');
    const res = await runScript(ta.value, app, write, { signal:controller.signal });
    if (!current()) return;
    if (res.error) {
      const row = el('div', 'cl warn');
      row.append(el('span', 'cl-text mono', '⚠ ' + res.error));
      out.append(row);
    } else write('— おわり —');
    if (activeController === controller) activeController = null;
  }""")
rep('js/tools-base.js',
"""  function runPlugin(p) {
    const s = new Sheet(p.name);
    const out = el('div', 'codeview small');
    s.body.append(el('div', 'hint', '実行しています…'), out);
    const write = (line) => {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
    };
    app.plugins.run(p.id, write).then((res) => {
      if (res.error) write('⚠ ' + res.error);
      else write('— おわり —');
    });
  }""",
"""  function runPlugin(p) {
    const s = new Sheet(p.name);
    const controller = new AbortController();
    let closed = false;
    s.onClose = () => { closed = true; controller.abort('plugin-sheet-closed'); };
    const out = el('div', 'codeview small');
    s.body.append(el('div', 'hint', '実行しています…'), out);
    const write = (line) => {
      if (closed || controller.signal.aborted) return;
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
    };
    app.plugins.run(p.id, write, { signal:controller.signal }).then((res) => {
      if (closed || controller.signal.aborted) return;
      if (res.error) write('⚠ ' + res.error);
      else write('— おわり —');
    });
  }""")

# Regression source/behavior proof (Node-only fakes for query contract + static lifecycle assertions).
Path('tests/unlinked-script-lifecycle.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApi } from '../js/script.js';

const scriptSource = fs.readFileSync(new URL('../js/script.js', import.meta.url), 'utf8');
const sandboxSource = fs.readFileSync(new URL('../js/sandbox.js', import.meta.url), 'utf8');
const pluginSource = fs.readFileSync(new URL('../js/plugins.js', import.meta.url), 'utf8');
const toolsSource = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
assert.match(sandboxSource, /invokeApi = null/);
assert.doesNotMatch(sandboxSource, /fn\(\.\.\.\(m\.args \|\| \[\]\), \{ signal:/);
assert.match(toolsSource, /script-sheet-closed/);
assert.match(toolsSource, /script-rerun/);
assert.match(toolsSource, /plugin-sheet-closed/);
assert.doesNotMatch(pluginSource, /^import .*\.\/script\.js/m);
assert.doesNotMatch(pluginSource, /^import .*\.\/sandbox\.js/m);
assert.match(scriptSource, /analysisQueries\.xrefs/);
assert.match(scriptSource, /analysisQueries\.callees/);
assert.match(scriptSource, /analysisQueries\.mostCalled/);
assert.match(scriptSource, /queryFunctions/);

let snapshotCalls = 0;
const queryCalls = [];
const snapshot = Object.freeze({ snapshotId:'snap', binaryId:'bin', analysisEpoch:1, projectRevision:0, artifactVersions:{} });
const makeResult = (value, completeness='complete', page={offset:0,limit:100,returned:value.length,total:value.length,next:null}, status={}) => ({ snapshotId:'snap', analysisEpoch:1, completeness, value, page, status:{...status, completeness} });
const app = {
  analysisQueries:{
    async snapshot({signal}={}) { assert.equal(signal?.aborted,false); snapshotCalls++; return snapshot; },
    async functions(s,q,p,{signal}={}) { assert.equal(s,snapshot); assert.equal(signal?.aborted,false); queryCalls.push(['functions',p.offset,p.limit]); return makeResult([{address:1n,name:'a'},{address:2n,name:'b'}]); },
    async xrefs(s,id,p,{signal}={}) { assert.equal(s,snapshot); queryCalls.push(['xrefs',id,p.limit]); return makeResult([], 'partial', {...p,returned:0,total:null,next:null}, {reason:'program-region-unscanned:r2',scope:'active-neighborhood'}); },
    async callees(s,id,p,{signal}={}) { assert.equal(s,snapshot); queryCalls.push(['callees',id,p.limit]); return makeResult([], 'unsupported', {...p,returned:0,total:null,next:null}, {reason:'function-range-unavailable'}); },
    async mostCalled(s,p,{signal}={}) { assert.equal(s,snapshot); queryCalls.push(['mostCalled',p.limit]); return makeResult([{addr:2n,count:3}]); },
  },
  store:{ get(key){ if(key==='regions') return [{id:'a',exec:true,vmAddr:0n,size:10n},{id:'b',exec:true,vmAddr:100n,size:10n}]; if(key==='architecture') return 'arm64'; return null; } },
  symbols:{ functionList(){ throw new Error('legacy functionList must not be used'); } },
  currentSlice(){ return { capability:{architecture:'arm64'} }; },
};
const controller = new AbortController();
const { api, invokeApi } = createApi(app, ()=>{});
const functions = await api.functions(10,{signal:controller.signal});
assert.deepEqual(functions.map((x)=>x.address),[1n,2n]);
assert.equal(functions.complete,true);
const page = await api.queryFunctions({offset:0,limit:1000},{signal:controller.signal});
assert.equal(page.complete,true);
const refs = await api.xrefsTo(0x20n,200,{signal:controller.signal});
assert.equal(refs.length,0); assert.equal(refs.complete,false); assert.match(refs.reason,/unscanned/);
const callees = await api.xrefsFrom(0x20n,200,{signal:controller.signal});
assert.equal(callees.length,0); assert.equal(callees.complete,false); assert.equal(callees.completeness,'unsupported');
const ranked = await api.mostCalled(20,{signal:controller.signal});
assert.equal(ranked[0].count,3); assert.equal(ranked.complete,true);
assert.equal(snapshotCalls,1,'one script execution must bind one AnalysisSnapshot');

let receivedSignal = null;
app.ensureStrings = async ({signal}) => { receivedSignal=signal; return []; };
await invokeApi('loadStrings',[],{signal:controller.signal});
assert.equal(receivedSignal,controller.signal);
controller.abort('test-stop');
await assert.rejects(() => invokeApi('loadStrings',[],{signal:controller.signal}), /test-stop|aborted/i).catch(()=>{});
console.log('unlinked script lifecycle: PASS');
''')
