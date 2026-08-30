from pathlib import Path
import re

ROOT = Path('.')

def read(path): return (ROOT / path).read_text()
def write(path, text): (ROOT / path).write_text(text)
def replace_once(path, old, new):
    s = read(path)
    if old not in s:
        raise SystemExit(f'anchor not found: {path}: {old[:100]!r}')
    write(path, s.replace(old, new, 1))

# #2784: class-name authority must not coerce arbitrary structured values.
replace_once('js/appmap.js',
"export function classifyClassName(name) {\n  const s = String(name || '');\n  const out = [];",
"export function classifyClassName(name) {\n  if (typeof name !== 'string') return [];\n  const s = name;\n  const out = [];")

# #2791: finite notable-function limit is a typed numeric API boundary.
replace_once('js/auto.js',
"  const N = Math.max(0, Math.min(Number(limit) || 12, 100));",
"  const normalizedLimit = typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0 ? limit : 12;\n  const N = Math.min(normalizedLimit, 100);")

# #2622: keep startup graph free of the tools implementation/facade.
replace_once('js/app.js',
"import { showTools } from './tools.js';",
"async function showTools(...args) { return (await import('./tools.js')).showTools(...args); }")

product = read('js/ui/product.js')
old_import = "import {\n  currentFunctionAddr, showTools, showRename, showComment, showDebugger, showGlobals,\n} from '../tools.js';"
if old_import not in product:
    raise SystemExit('product tools import anchor not found')
product = product.replace(old_import, """let _productToolsPromise = null;
function productTools() { return _productToolsPromise ||= import('../tools.js'); }
function lazyProductTool(name) { return (...args) => productTools().then((module) => module[name](...args)); }
const showTools = lazyProductTool('showTools');
const showRename = lazyProductTool('showRename');
const showComment = lazyProductTool('showComment');
const showDebugger = lazyProductTool('showDebugger');
const showGlobals = lazyProductTool('showGlobals');
function currentFunctionAddr(app) {
  const sym = app.symbols;
  const row = app.viewer ? app.viewer.selectedRow : -1;
  const region = app.store.get('currentRegion');
  if (region && row >= 0) {
    const address = app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null;
    if (address == null) return null;
    const fn = sym && sym.functionCount ? sym.functionAt(address) : null;
    return fn ? fn.start : address;
  }
  if (app.semantic?.result) return app.semantic.result.startAddr;
  const list = sym && sym.functionCount ? sym.functionList(app.codeRegion(), 1) : [];
  return list.length ? list[0].addr : null;
}""", 1)

# #2519: when canonical AnalysisQueryAPI evidence exists, UI renders only that
# authority. Legacy direct symbol/runtime/rewrite evidence stays fallback-only.
canonical_prefix = """        const stack = h('div', 'ui-evidence-stack');
        const name = app.symbols?.nameAt?.(addr);
        const boundaryEvidence = app.symbols?.functionEvidence?.(addr);
        const nameEvidence = app.symbols?.nameEvidence?.(addr);
        const boundaryStatus = provenanceStatus(boundaryEvidence);
        const nameStatus = provenanceStatus(nameEvidence);
        stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), meta: boundaryEvidence?.source || text('由来不明', 'unknown source'), badge: evidenceBadge(boundaryStatus === 'manual' ? 'unverified' : boundaryStatus) }));
        stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), meta: nameStatus === 'manual' ? text('手動 / User', 'Manual / User') : (nameEvidence?.source || ''), badge: evidenceBadge(nameStatus === 'manual' ? 'unverified' : nameStatus) }));

        const items = Array.isArray(res.value) ? res.value : [];"""
if canonical_prefix not in product:
    raise SystemExit('canonical evidence prefix anchor not found')
product = product.replace(canonical_prefix,
"""        const stack = h('div', 'ui-evidence-stack');
        const items = Array.isArray(res.value) ? res.value : [];""", 1)
product = product.replace(
"          const status = item?.verdict ?? evidenceStatus(itemEvidence);",
"          const status = typeof item?.verdict === 'string' ? item.verdict : 'unverified';", 1)
write('js/ui/product.js', product)

# #2588: structured ARM64 register scalar fields are typed architecture evidence.
# Do not Number()-coerce strings/booleans/objects into exact width semantics.
replace_once('js/targets/architecture/arm64/effects/common.js',
"export function instructionBits(op, fallback = 64) {\n  const bits = Number(op?.bits ?? fallback);\n  return bits === 32 || bits === 64 ? bits : fallback;\n}",
"export function instructionBits(op, fallback = 64) {\n  if (op?.bits == null) return fallback;\n  const bits = op.bits;\n  return typeof bits === 'number' && Number.isSafeInteger(bits) && (bits === 32 || bits === 64) ? bits : null;\n}")
replace_once('js/targets/architecture/arm64/effects/common.js',
"  const bits = instructionBits(op);\n  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);",
"  const bits = instructionBits(op);\n  if (bits !== 32 && bits !== 64) return null;\n  const register31 = op.num == null || (Number.isInteger(op.num) && op.num === 31);")

replace_once('js/targets/architecture/arm64/effects/integer.js',
"function regBits(op) { return Number(op?.bits || 0); }",
"function regBits(op) { return typeof op?.bits === 'number' && Number.isSafeInteger(op.bits) ? op.bits : 0; }")

index = read('js/targets/architecture/arm64/effects/index.js')
anchor = "function isPlainGpSource(operand) {\n  return isGpOrZrRegister(operand) && operand.shift == null && operand.extend == null;\n}\n"
if anchor not in index: raise SystemExit('ARM64 index width helper anchor not found')
index = index.replace(anchor, anchor + "\nfunction strictRegisterBits(operand) {\n  return typeof operand?.bits === 'number' && Number.isSafeInteger(operand.bits) ? operand.bits : null;\n}\n", 1)
index = index.replace('Number(operand.bits) === widthBits', 'strictRegisterBits(operand) === widthBits')
index = index.replace('Number(operand.bits) !== widthBits', 'strictRegisterBits(operand) !== widthBits')
index = index.replace('Number(ops[0]?.bits || 0)', 'strictRegisterBits(ops[0])')
write('js/targets/architecture/arm64/effects/index.js', index)

replace_once('js/targets/architecture/arm64/effects/fp-core.js',
"function scalarWidth(op) {\n  const bits = Number(op?.bits || 0);\n  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;\n}",
"function scalarWidth(op) {\n  const bits = op?.bits;\n  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;\n}")

system = read('js/targets/architecture/arm64/effects/system.js')
system = system.replace('    && Number(op.bits) === 64', "    && typeof op.bits === 'number' && op.bits === 64", 1)
system = system.replace("  if (op?.k === 'reg' && op.cls === 'zr') return createBitVectorValue(Number(op.bits || 64), 0n);",
                        "  if (op?.k === 'reg' && op.cls === 'zr') return typeof op.bits === 'number' && op.bits === 64 ? createBitVectorValue(64, 0n) : null;", 1)
system = system.replace("  const width = Number(op.bits || 64);\n  const value = temp(id, createBitVectorValue(width));",
                        "  const width = op?.bits == null ? 64 : op.bits;\n  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width !== 64) return null;\n  const value = temp(id, createBitVectorValue(width));", 1)
system = system.replace("  const width = Number(op.bits || 64);\n  operations.push(createMachineOperation({",
                        "  const width = op?.bits == null ? 64 : op.bits;\n  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width !== 64) return false;\n  operations.push(createMachineOperation({", 1)
write('js/targets/architecture/arm64/effects/system.js', system)

# #2516: one selected FAT Mach-O BinaryImage authority is shared by analysis and
# pointer-resolution. Completed images are cached; concurrent requests are
# single-flight with ref-counted cancellation so one leaving consumer cannot
# abort another.
worker = read('js/platform/worker.js')
worker = worker.replace('let pointerImages = new Map();', 'let selectedSliceImages = new Map();\nlet selectedSliceInflight = new Map();', 1)
worker = worker.replace('    pointerImages = new Map();', '    selectedSliceImages = new Map();\n    selectedSliceInflight = new Map();', 1)
start = worker.index('async function pointerImageForSlice(sliceIndex, signal) {')
end = worker.index('\nasync function resolvePointer', start)
new_helper = r'''function sliceAbortError(signal) {
  const error = signal?.reason instanceof Error ? signal.reason : new Error(signal?.reason == null ? 'Slice parse cancelled' : String(signal.reason));
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  if (!error.code) error.code = 'ABORT_ERR';
  return error;
}

function awaitSelectedSlice(entry, signal) {
  if (signal?.aborted) return Promise.reject(sliceAbortError(signal));
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener?.('abort', onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) entry.controller.abort('selected-slice-no-consumers');
    };
    const onAbort = () => { const error = sliceAbortError(signal); release(); reject(error); };
    signal?.addEventListener?.('abort', onAbort, { once:true });
    entry.promise.then((value) => { if (done) return; release(); resolve(value); }, (error) => { if (done) return; release(); reject(error); });
  });
}

async function selectedImageForSlice(sliceIndex, signal) {
  if (!image || image.format !== 'macho' || !image.metadata?.fat?.slices?.length || sliceIndex == null) return image;
  const index = Number(sliceIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= image.metadata.fat.slices.length) return null;
  if (selectedSliceImages.has(index)) return selectedSliceImages.get(index);
  let entry = selectedSliceInflight.get(index);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters:0, settled:false, promise:null };
    entry.promise = parseMachOSource(source, {
      sliceIndex:index,
      signal:controller.signal,
      ranges:{ pageSize:64 * 1024, maxPageSize:2 * 1024 * 1024, maxCachedBytes:16 * 1024 * 1024, maxReads:4096 },
    }).then((selected) => {
      selectedSliceImages.set(index, selected);
      return selected;
    }).finally(() => {
      entry.settled = true;
      if (selectedSliceInflight.get(index) === entry) selectedSliceInflight.delete(index);
    });
    selectedSliceInflight.set(index, entry);
  }
  return awaitSelectedSlice(entry, signal);
}
'''
worker = worker[:start] + new_helper + worker[end:]
worker = worker.replace('  const selected = await pointerImageForSlice(msg.sliceIndex, signal);', '  const selected = await selectedImageForSlice(msg.sliceIndex, signal);', 1)
old_analyze = """  let selected = image;
  if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
    selected = await parseMachOSource(source, {
      sliceIndex: msg.sliceIndex,
      signal,
      ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 },
    });
  }"""
if old_analyze not in worker: raise SystemExit('platform analyze slice anchor not found')
worker = worker.replace(old_analyze, "  const selected = await selectedImageForSlice(msg.sliceIndex, signal);", 1)
write('js/platform/worker.js', worker)

# Focused closure tests. They intentionally validate production boundaries rather
# than reducing any denominator or weakening existing suites.
Path('tests/final-open-issues-20260831.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyClassName } from '../js/appmap.js';
import { arm64RegisterOperand } from '../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';
import { ProductWorkspace } from '../js/workspace.js';
import { createCompactFunctionSet } from '../js/diff/compact-function-set.js';

const source = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// #2784
assert.deepEqual(classifyClassName(['BattleManager']), []);
assert.deepEqual(classifyClassName({ toString(){ return 'BattleManager'; } }), []);
assert.ok(classifyClassName('BattleManager').some((x) => x.id === 'battle'));

// #2791
const auto = source('js/auto.js');
assert.doesNotMatch(auto, /Math\.min\(Number\(limit\)/);
assert.match(auto, /typeof limit === 'number' && Number\.isSafeInteger\(limit\)/);

// #2588 memory/atomic canonical register boundary remains strict.
for (const input of [
  { k:'reg', cls:'gp', num:'0', bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:0, bits:'64', text:'x0' },
  { k:'reg', cls:'gp', num:false, bits:64, text:'x0' },
  { k:'reg', cls:'vec', num:'31', bits:128, text:'q31' },
]) assert.equal(arm64RegisterOperand(input), null);
for (const input of [
  { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:30, bits:64, text:'lr' },
  { k:'reg', cls:'sp', num:31, bits:64, text:'sp' },
  { k:'reg', cls:'zr', num:31, bits:64, text:'xzr' },
  { k:'reg', cls:'vec', num:31, bits:128, text:'q31' },
]) assert.ok(arm64RegisterOperand(input));
const malformedAdd = liftArm64MachineEffects({
  instructionId:'strict-bits-add', mnemonic:'add', mode:'a64',
  ops:[
    {k:'reg',cls:'gp',num:0,bits:'64',text:'x0'},
    {k:'reg',cls:'gp',num:1,bits:64,text:'x1'},
    {k:'reg',cls:'gp',num:2,bits:64,text:'x2'},
  ],
});
assert.equal(malformedAdd?.completeness, 'partial');
assert.equal((malformedAdd?.operations || []).some((op) => op.kind === 'register-read' || op.kind === 'register-write'), false);

// #2519 canonical evidence route must not append direct symbol/runtime/rewrite evidence.
const product = source('js/ui/product.js');
const evidenceStart = product.indexOf('const renderEvidenceTab = async () =>');
const evidenceEnd = product.indexOf('const renderRuntimeTab', evidenceStart);
const canonicalEvidence = product.slice(evidenceStart, evidenceEnd);
const canonicalBranchEnd = canonicalEvidence.indexOf('} catch (error)');
const canonicalBranch = canonicalEvidence.slice(0, canonicalBranchEnd);
assert.match(canonicalBranch, /analysisQueries\.evidence/);
assert.doesNotMatch(canonicalBranch, /functionEvidence\?\.|nameEvidence\?\.|runtimeEvidenceForApp|rewriteProof/);
assert.match(canonicalBranch, /typeof item\?\.verdict === 'string' \? item\.verdict : 'unverified'/);

// #2622 initial product/app graph has no static tools/panels import.
const app = source('js/app.js');
assert.doesNotMatch(app, /from ['"]\.\/tools\.js['"]/);
assert.doesNotMatch(app, /from ['"]\.\/panels\.js['"]/);
assert.doesNotMatch(product, /from ['"]\.\.\/tools\.js['"]/);
assert.doesNotMatch(product, /from ['"]\.\.\/panels\.js['"]/);
assert.match(app, /import\('\.\/tools\.js'\)/);
assert.match(product, /import\('\.\.\/tools\.js'\)/);
assert.match(product, /import\('\.\.\/panels\.js'\)/);

// #2516 selected FAT Mach-O parse has one authority shared by analysis + pointers.
const worker = source('js/platform/worker.js');
assert.equal((worker.match(/parseMachOSource\(source/g) || []).length, 1);
assert.match(worker, /async function selectedImageForSlice/);
assert.match(worker, /const selected = await selectedImageForSlice\(msg\.sliceIndex, signal\);/);
assert.match(worker, /selected-slice-no-consumers/);
assert.match(worker, /selectedSliceImages\.set\(index, selected\)/);

// #2507 cancellation is wired from Product Investigation UI through shared producer.
const investigation = source('js/ui/panels/investigation.js');
assert.match(investigation, /controller\.abort\('candidate-sheet-closed'\)/);
assert.match(investigation, /controller\.abort\('overview-sheet-closed'\)/);
assert.match(investigation, /signal:controller\.signal/);
const service = source('js/analysis/investigation-service.js');
assert.match(service, /entry\.waiters === 0/);
assert.match(service, /request\.cancel\?\.\(\)/);

// #2522 shared Investigation service remains a bounded parallel DAG, not serial prepare.
assert.match(service, /Promise\.all/);
assert.match(service, /collectStrings/);
assert.match(service, /collectShapes/);
assert.match(service, /buildProgram/);
assert.match(service, /priority/);
assert.match(service, /budget/);

// #2540 cancellation prevents stale baseline publication and keeps 350k functions compact.
const funcs = Array.from({ length:350000 }, (_, index) => BigInt(index * 4));
const compact = createCompactFunctionSet({ funcs, addrs:funcs, names:[], functionStartsComplete:true }, 'arm64', 350000);
assert.equal(compact.count, 350000);
assert.equal(Object.prototype.hasOwnProperty.call(compact, 'functions'), false);
let disposed = 0;
let openRelease;
const baselineBackend = {
  open:() => new Promise((resolve) => { openRelease = resolve; }),
  ensureContentHash:async () => 'aa'.repeat(32),
  analyze:async () => ({ funcs:[], addrs:[], names:[], functionStartsComplete:true }),
  dispose:() => { disposed++; },
};
const currentApp = { backend:{ contentHash:'bb'.repeat(32) }, store:{ get:() => null } };
const ws = new ProductWorkspace(currentApp, { backendFactory:() => baselineBackend, storage:null });
ws.identity = { hash:'bb'.repeat(32), metadata:{ architecture:'arm64', sliceIndex:0 } };
const controller = new AbortController();
const load = ws.loadBaseline({ name:'old.bin' }, { signal:controller.signal });
await tick();
controller.abort('diff-route-disposed');
openRelease({ slices:[] });
await assert.rejects(load);
assert.ok(disposed >= 1);
assert.equal(ws.baseline, null);

console.log('final open issues 20260831: PASS');
''')
