from pathlib import Path


def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor missing: {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,count))

# #2810 — candidate truncation is part of schema completeness.
p=Path('js/schema.js'); s=p.read_text()
old="""  const limit = o.limit || 300;
  const cancelled = o.isCancelled || (() => false);"""
new="""  const limit = typeof o.limit === 'number' && Number.isSafeInteger(o.limit) && o.limit >= 0 ? o.limit : 300;
  const cancelled = o.isCancelled || (() => false);"""
if old not in s: raise SystemExit('schema limit anchor missing')
s=s.replace(old,new,1)
old="""  const targets = Array.from(byFunction.values()).map((e) => {
    const r = program.functionRange(e.addr);
    return Object.assign({}, e, { range: r, size: r ? Number(r.end - r.start) : 0 });
  }).filter((e) => e.range && e.size > 16 && e.size <= 64 * 1024).sort((a, b) => b.files.length - a.files.length).slice(0, limit);
  for (let i = 0; i < targets.length; i++) {"""
new="""  const candidates = Array.from(byFunction.values()).map((e) => {
    const r = program.functionRange(e.addr);
    return Object.assign({}, e, { range: r, size: r ? Number(r.end - r.start) : 0 });
  }).filter((e) => e.range && e.size > 16 && e.size <= 64 * 1024).sort((a, b) => b.files.length - a.files.length);
  const targets = candidates.slice(0, limit);
  if (targets.length < candidates.length) {
    const reasons = [...new Set([out.incompleteReason, 'schema-recovery-limit'].filter(Boolean))];
    Object.defineProperties(out, {
      complete: { value:false, enumerable:false, configurable:true },
      incompleteReason: { value:reasons.join(';'), enumerable:false, configurable:true },
    });
  }
  for (let i = 0; i < targets.length; i++) {"""
if old not in s: raise SystemExit('schema targets anchor missing')
p.write_text(s.replace(old,new,1))

# #2811 — partial strings are budget-scoped, not a global canonical cache.
p=Path('js/analysis/investigation-service.js'); s=p.read_text()
anchor="""function budgetConfig(options, key, defaults) {
  const override = options?.budget?.[key];
  if (!override || typeof override !== 'object') return defaults;
  const out = { ...defaults };
  for (const name of Object.keys(defaults)) out[name] = boundedBudget(override[name], defaults[name]);
  return out;
}
"""
helper=anchor+"""
function budgetProfileKey(config) {
  return Object.keys(config).sort().map((key) => `${key}:${config[key]}`).join('|');
}
"""
if anchor not in s: raise SystemExit('investigation budget helper anchor missing')
s=s.replace(anchor,helper,1)
old="""  collectStrings(options = {}) {
    if (this.app.stringIndex) return Promise.resolve(this.app.stringIndex);
    const epoch = epochOf(this.app);
    return this.#shared(`strings:${epoch}`, async (signal) => {
      const budget = new StringCollectionBudget(budgetConfig(options, 'strings', STRING_SCAN_BUDGET));"""
new="""  collectStrings(options = {}) {
    if (this.app.stringIndex?.complete === true) return Promise.resolve(this.app.stringIndex);
    const epoch = epochOf(this.app);
    const config = budgetConfig(options, 'strings', STRING_SCAN_BUDGET);
    const profile = budgetProfileKey(config);
    return this.#shared(`strings:${epoch}:${profile}`, async (signal) => {
      const budget = new StringCollectionBudget(config);"""
if old not in s: raise SystemExit('collectStrings key anchor missing')
s=s.replace(old,new,1)
old="""      Object.assign(rows, {
        complete:!truncated,
        truncated,
        truncationReason:budget.truncationReason || (skipped.length ? 'input-budget' : backendPartial ? 'backend-partial' : null),
        scannedBytes,
        unscannedRegions:[...new Set(skipped.map((r) => r.id))],
      });
      if (epoch === epochOf(this.app)) this.app.stringIndex = rows;
      return rows;"""
new="""      Object.assign(rows, {
        complete:!truncated,
        truncated,
        truncationReason:budget.truncationReason || (skipped.length ? 'input-budget' : backendPartial ? 'backend-partial' : null),
        scannedBytes,
        unscannedRegions:[...new Set(skipped.map((r) => r.id))],
      });
      Object.defineProperty(rows, 'budgetProfile', { value:Object.freeze({ ...config }), enumerable:false, configurable:true });
      if (epoch === epochOf(this.app) && rows.complete === true) this.app.stringIndex = rows;
      return rows;"""
if old not in s: raise SystemExit('collectStrings publish anchor missing')
p.write_text(s.replace(old,new,1))

# #2814 — BinaryId producer has its own lifetime; caller signals only detach waiters.
p=Path('js/analysis/demand-driven-runtime.js'); s=p.read_text()
old="""      if (!entry.settled && entry.waiters === 0) entry.request?.cancel?.();
      reject(abortError(signal));"""
new="""      if (!entry.settled && entry.waiters === 0) {
        entry.cancel?.();
        entry.request?.cancel?.();
      }
      reject(abortError(signal));"""
if old not in s: raise SystemExit('waitForShared cancellation anchor missing')
s=s.replace(old,new,1)
old="""  backend.ensureBinaryId = function ensureBinaryIdFromPlatformWorker(options = {}) {
    if (this.binaryId) return Promise.resolve(this.binaryId);
    if (!this.file) return Promise.reject(new Error('binary-id-file-unavailable'));
    if (!this._binaryIdPromise) {
      const file = this.file; const epoch = this.gen;
      this._binaryIdPromise = scheduleBackgroundIdentity(options.signal).then(() => this.ensureContentHash(options.onProgress, options.signal ?? null)).then((hash) => {
        abortIfNeeded(options.signal);
        if (this.file !== file || this.gen !== epoch) { const error = new Error('stale binary identity'); error.stale = true; throw error; }
        const binaryId = createBinaryIdFromDigest(hash); this.binaryId = binaryId; return binaryId;
      }).catch((error) => { this._binaryIdPromise = null; throw error; });
    }
    return this._binaryIdPromise;
  };"""
new="""  backend.ensureBinaryId = function ensureBinaryIdFromPlatformWorker(options = {}) {
    if (this.binaryId) return Promise.resolve(this.binaryId);
    if (!this.file) return Promise.reject(new Error('binary-id-file-unavailable'));
    let entry = this._binaryIdEntry;
    if (!entry) {
      const file = this.file; const epoch = this.gen;
      const controller = new AbortController();
      entry = {
        controller,
        waiters:0,
        settled:false,
        promise:null,
        cancel:() => { if (!controller.signal.aborted) controller.abort('binary-id-no-consumers'); },
      };
      entry.promise = scheduleBackgroundIdentity(controller.signal)
        .then(() => this.ensureContentHash(options.onProgress, controller.signal))
        .then((hash) => {
          abortIfNeeded(controller.signal);
          if (this.file !== file || this.gen !== epoch) { const error = new Error('stale binary identity'); error.stale = true; throw error; }
          const binaryId = createBinaryIdFromDigest(hash); this.binaryId = binaryId; return binaryId;
        })
        .finally(() => {
          entry.settled = true;
          if (this._binaryIdEntry === entry) this._binaryIdEntry = null;
          if (this._binaryIdPromise === entry.promise) this._binaryIdPromise = null;
        });
      this._binaryIdEntry = entry;
      this._binaryIdPromise = entry.promise;
    }
    return waitForShared(entry, options.signal ?? null);
  };"""
if old not in s: raise SystemExit('ensureBinaryId anchor missing')
s=s.replace(old,new,1)
old="""export const __demandDrivenInternalsForTests = Object.freeze({ addressOf, mergeShapeMaps, recognitionInputKey, localRegionPlan, regionScanLimits });"""
new="""export const __demandDrivenInternalsForTests = Object.freeze({ addressOf, mergeShapeMaps, recognitionInputKey, localRegionPlan, regionScanLimits, installWorkerBackedIdentity });"""
if old not in s: raise SystemExit('demand internals anchor missing')
p.write_text(s.replace(old,new,1))

# #2819 — schema tasks are keyed by budget profile; partial results never poison app.schemas.
p=Path('js/analysis/schema-recovery-task.js'); s=p.read_text()
anchor="""function taskMap(app) {
  let map = TASKS.get(app);
  if (!map) { map = new Map(); TASKS.set(app, map); }
  return map;
}
"""
helper=anchor+"""
function stableBudgetKey(value, seen = new Set()) {
  if (value == null) return 'default';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? `n:${value}` : `n:${String(value)}`;
  if (type === 'string') return `s:${value}`;
  if (type === 'boolean') return `b:${value}`;
  if (type !== 'object') return `${type}:${String(value)}`;
  if (seen.has(value)) return 'cycle';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableBudgetKey(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${key}:${stableBudgetKey(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}
"""
if anchor not in s: raise SystemExit('schema taskMap anchor missing')
s=s.replace(anchor,helper,1)
s=s.replace('function createTask(app, epoch, { onProgress, priority, budget } = {}) {','function createTask(app, taskKey, epoch, { onProgress, priority, budget } = {}) {',1)
s=s.replace('    app.schemas = entry.result;\n    return entry.result;','    if (entry.result.complete === true) app.schemas = entry.result;\n    return entry.result;',1)
s=s.replace('    if (!entry.result) map.delete(epoch);','    if (!entry.result) map.delete(taskKey);',1)
s=s.replace('  map.set(epoch, entry);','  map.set(taskKey, entry);',1)
old="""export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  if (app?.schemas) return Promise.resolve(app.schemas);
  const epoch = app?.backend?.gen ?? -1;
  const map = taskMap(app);
  let entry = map.get(epoch);
  if (!entry) entry = createTask(app, epoch, { onProgress, priority, budget });"""
new="""export function recoverSchemasForUi(app, { signal = null, onProgress = null, priority = 'interactive', budget = null } = {}) {
  if (app?.schemas?.complete === true) return Promise.resolve(app.schemas);
  const epoch = app?.backend?.gen ?? -1;
  const map = taskMap(app);
  const taskKey = `${epoch}:${stableBudgetKey(budget)}`;
  let entry = map.get(taskKey);
  if (!entry) entry = createTask(app, taskKey, epoch, { onProgress, priority, budget });"""
if old not in s: raise SystemExit('recoverSchemasForUi key anchor missing')
p.write_text(s.replace(old,new,1))

Path('tests/unlinked-cache-completeness-20260831.mjs').write_text(r'''import assert from 'node:assert/strict';
import { recoverSchemas } from '../js/schema.js';
import { InvestigationService } from '../js/analysis/investigation-service.js';
import { recoverSchemasForUi, clearSchemaRecoveryTasks } from '../js/analysis/schema-recovery-task.js';
import { __demandDrivenInternalsForTests } from '../js/analysis/demand-driven-runtime.js';

function schemaFixture() {
  const strings=[{addr:1n,text:'a.csv'},{addr:2n,text:'b.json'}];
  Object.defineProperty(strings,'complete',{value:true,configurable:true});
  const program={
    complete:true, unsupported:false, graphCompleteness:{callsComplete:true,refsComplete:true},
    functionsReferencing(addr){ return [{addr:addr===1n?0x1000n:0x2000n}]; },
    functionRange(addr){ return {start:addr,end:addr+32n}; },
  };
  return {strings,program};
}

// #2810: limit truncation is observable even when no candidate decodes to a schema.
{
  const {strings,program}=schemaFixture();
  const out=await recoverSchemas({strings,program,architecture:'arm64',limit:1,read:async()=>null});
  assert.equal(out.complete,false);
  assert.match(out.incompleteReason,/schema-recovery-limit/);
  const full=await recoverSchemas({strings,program,architecture:'arm64',limit:300,read:async()=>null});
  assert.equal(full.complete,true);
}

// #2811: a tiny partial string budget cannot poison the canonical string cache.
{
  let calls=0;
  const region={id:'r',size:100n,section:'__cstring',cstrings:true};
  const app={
    backend:{gen:1,strings:async({maxBytes})=>{calls++; return {complete:maxBytes>=100,scannedBytes:maxBytes,results:[{addr:1n,text:'abc'}]};}},
    store:{get(key){if(key==='regions')return [region]; if(key==='currentRegion')return region; return null;}},
  };
  const service=new InvestigationService(app);
  const partial=await service.collectStrings({budget:{strings:{inputBytes:1,resultLimit:10,estimatedHeapBytes:10000}}});
  assert.equal(partial.complete,false);
  assert.equal(app.stringIndex,undefined,'partial budget result must not become global cache');
  const complete=await service.collectStrings();
  assert.equal(complete.complete,true);
  assert.equal(calls,2,'stronger/default budget must run after partial budget');
  assert.equal(app.stringIndex,complete);
}

// #2814: one BinaryId consumer abort detaches only that waiter; the shared hash survives.
{
  let resolveHash, producerSignal;
  const backend={
    file:{name:'x'}, gen:1,
    ensureContentHash(_progress,signal){producerSignal=signal; return new Promise((resolve,reject)=>{
      resolveHash=resolve;
      signal.addEventListener('abort',()=>reject(Object.assign(new Error('hash aborted'),{name:'AbortError'})),{once:true});
    });},
  };
  __demandDrivenInternalsForTests.installWorkerBackedIdentity({backend});
  const a=new AbortController(), b=new AbortController();
  const first=backend.ensureBinaryId({signal:a.signal});
  const second=backend.ensureBinaryId({signal:b.signal});
  await new Promise((resolve)=>setTimeout(resolve,0));
  a.abort('consumer-a-left');
  await assert.rejects(first,(error)=>error?.name==='AbortError');
  assert.equal(producerSignal.aborted,false,'remaining waiter keeps producer alive');
  resolveHash('a'.repeat(64));
  const binaryId=await second;
  assert.equal(typeof binaryId,'string');
  assert.ok(binaryId.length>10);
}
{
  let producerSignal;
  const backend={
    file:{name:'x'}, gen:1,
    ensureContentHash(_progress,signal){producerSignal=signal; return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('hash aborted'),{name:'AbortError'})),{once:true}));},
  };
  __demandDrivenInternalsForTests.installWorkerBackedIdentity({backend});
  const a=new AbortController(), b=new AbortController();
  const first=backend.ensureBinaryId({signal:a.signal});
  const second=backend.ensureBinaryId({signal:b.signal});
  await new Promise((resolve)=>setTimeout(resolve,0));
  a.abort('a'); b.abort('b');
  await Promise.allSettled([first,second]);
  await new Promise((resolve)=>setTimeout(resolve,0));
  assert.equal(producerSignal.aborted,true,'last waiter abort cancels producer');
}

// #2819: a maxSchemas=1 partial task is budget-local; the default task reruns and can publish complete.
{
  const {strings,program}=schemaFixture();
  let stringsCalls=0, programCalls=0, reads=0;
  const app={
    backend:{gen:1,readAt:async()=>{reads++;return {found:false};}},
    ensureStrings:async()=>{stringsCalls++;return strings;},
    ensureProgram:async()=>{programCalls++;return program;},
    store:{get(key){return key==='architecture'?'arm64':null;}},
    currentSlice:()=>({capability:{architecture:'arm64'}}),
  };
  const partial=await recoverSchemasForUi(app,{budget:{maxSchemas:1}});
  assert.equal(partial.complete,false);
  assert.match(partial.incompleteReason,/schema-recovery-limit/);
  assert.equal(app.schemas,undefined);
  const complete=await recoverSchemasForUi(app);
  assert.equal(complete.complete,true);
  assert.equal(app.schemas,complete);
  assert.equal(stringsCalls,2);
  assert.equal(programCalls,2);
  assert.ok(reads>=2);
  clearSchemaRecoveryTasks(app);
}
console.log('unlinked cache/completeness: PASS');
''')
