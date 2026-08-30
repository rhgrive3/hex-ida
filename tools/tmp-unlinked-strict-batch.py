from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"anchor missing: {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, count))

# #2807 — structured ARM64 shift descriptors must not be coerced.
replace('js/targets/architecture/arm64/effects/addressing.js',
"""  const op = String(shift.op || '').toLowerCase();
  const amount = shift.amount == null ? 0 : Number(shift.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');""",
"""  if (typeof shift.op !== 'string') fail('arm64-invalid-register-offset-shift');
  const op = shift.op.toLowerCase();
  const amount = shift.amount == null ? 0 : shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');""")
replace('js/targets/architecture/arm64/effects/common.js',
"""  function shiftImmediate(value, widthBits, kind, amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0 || n >= widthBits) return null;""",
"""  function shiftImmediate(value, widthBits, kind, amount) {
    const n = amount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= widthBits) return null;""")
replace('js/targets/architecture/arm64/effects/common.js',
"""    const kind = String(modifier.op || '').toLowerCase();
    const amount = modifier.amount == null ? 0 : Number(modifier.amount);""",
"""    if (typeof modifier.op !== 'string') return null;
    const kind = modifier.op.toLowerCase();
    const amount = modifier.amount == null ? 0 : modifier.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return null;""")
replace('js/targets/architecture/arm64/effects/common.js',
"""      const modifierKind = String(op.shift?.op || '').toLowerCase();""",
"""      const modifierKind = typeof op.shift?.op === 'string' ? op.shift.op.toLowerCase() : '';""")
replace('js/targets/architecture/arm64/effects/index.js',
"""  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;""",
"""  return typeof op.shift.op === 'string'
    && op.shift.op.toLowerCase() === 'lsl'
    && typeof op.shift.amount === 'number'
    && Number.isInteger(op.shift.amount)
    && op.shift.amount === 12;""")
replace('js/targets/architecture/arm64/effects/index.js',
"""  const kind = String(operand.shift.op || '').toLowerCase();
  const amount = Number(operand.shift.amount ?? 0);
  return ['lsl','lsr','asr','ror'].includes(kind) && Number.isInteger(amount) && amount >= 0 && amount < widthBits;""",
"""  if (typeof operand.shift.op !== 'string') return false;
  const kind = operand.shift.op.toLowerCase();
  const amount = operand.shift.amount ?? 0;
  return ['lsl','lsr','asr','ror'].includes(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < widthBits;""")
replace('js/targets/architecture/arm64/effects/integer.js',
"""  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;""",
"""  return typeof op.shift.op === 'string'
    && op.shift.op.toLowerCase() === 'lsl'
    && typeof op.shift.amount === 'number'
    && Number.isInteger(op.shift.amount)
    && op.shift.amount === 12;""")
replace('js/targets/architecture/arm64/effects/integer.js',
"""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) return false;""",
"""  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) return false;""", 1)
replace('js/targets/architecture/arm64/effects/integer.js',
"""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  return ['lsl','lsr','asr'].includes(kind)
    && Number.isInteger(amount) && amount >= 0 && amount < targetBits;""",
"""  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  return ['lsl','lsr','asr'].includes(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < targetBits;""")
replace('js/targets/architecture/arm64/effects/integer.js',
"""  const explicitExtend = EXTEND_KINDS.has(String(modifier?.op || '').toLowerCase());""",
"""  const explicitExtend = typeof modifier?.op === 'string' && EXTEND_KINDS.has(modifier.op.toLowerCase());""")
replace('js/targets/architecture/arm64/effects/integer.js',
"""  if (String(src.shift.op || '').toLowerCase() !== 'lsl') return false;
  const amount = Number(src.shift.amount);
  if (!Number.isInteger(amount)) return false;""",
"""  if (typeof src.shift.op !== 'string' || src.shift.op.toLowerCase() !== 'lsl') return false;
  const amount = src.shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false;""")

# #2809 and #2866 — structured system-register/barrier selectors are strings only.
replace('js/targets/architecture/arm64/effects/system.js',
"""function sysRegText(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}""",
"""function sysRegText(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}""")
replace('js/targets/architecture/arm64/effects/system.js',
"""function textOperand(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return text || null;
}""",
"""function textOperand(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return text || null;
}""")

# #2812 and #2864 — semantic function architecture/endianness are textual protocol fields.
replace('js/analysis/semantic-function-base.js',
"""function addressOf(instruction) { return BigInt(instruction.address); }""",
"""function normalizedProtocolString(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim().toLowerCase();
  if (!allowEmpty && !text) throw new TypeError(code);
  return text;
}

function addressOf(instruction) { return BigInt(instruction.address); }""")
replace('js/analysis/semantic-function-base.js',
"""  const architectureId = String(input.architecture || '').trim().toLowerCase();
  const architecturePlugin = architecturePluginV2(architectureId);""",
"""  const architectureId = normalizedProtocolString(input.architecture, 'semantic-function-architecture-required');
  const architecturePlugin = architecturePluginV2(architectureId);""")
replace('js/analysis/semantic-function-base.js',
"""  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null && requestedInstructionEndianness !== 'unknown') {
    const endian = String(requestedInstructionEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedInstructionEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null && requestedMemoryEndianness !== 'unknown') {
    const endian = String(requestedMemoryEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedMemoryEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
  }""",
"""  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null) {
    const endian = normalizedProtocolString(requestedInstructionEndianness, 'semantic-function-invalid-instruction-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedInstructionEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
    }
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null) {
    const endian = normalizedProtocolString(requestedMemoryEndianness, 'semantic-function-invalid-memory-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedMemoryEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
    }
  }""")

# #2817 — alias relation enum must already be a string.
replace('js/semantics/memoryssa/build.js',
"""function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  const normalized = relation == null ? 'unknown' : String(relation);
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');""",
"""function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  if (relation != null && typeof relation !== 'string') fail('memory-ssa-build-invalid-alias-relation');
  const normalized = relation ?? 'unknown';
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');""")

# #2818 — MemorySSA identities/enums are canonical string fields.
replace('js/semantics/memoryssa/contract.js',
"""function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}""",
"""function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}""")

# #2823 — validation indexes must not stringify structured IDs.
replace('js/semantics/memoryssa/validate.js',
"""    const actual = memorySsa.defUseLinks
      .map((link) => ({ definitionId: String(link.definitionId), useIds: [...link.useIds].map(String).sort() }))
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));""",
"""    const actual = memorySsa.defUseLinks
      .map((link) => {
        if (!link || typeof link !== 'object' || typeof link.definitionId !== 'string' || !link.definitionId.trim() || !Array.isArray(link.useIds)) {
          fail('memory-ssa-validate-invalid-def-use-index');
        }
        const useIds = link.useIds.map((id) => {
          if (typeof id !== 'string' || !id.trim()) fail('memory-ssa-validate-invalid-def-use-index');
          return id;
        }).sort();
        return { definitionId:link.definitionId, useIds };
      })
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));""")
replace('js/semantics/memoryssa/validate.js',
"""      const id = String(item.memorySsaEntityId ?? '');
      if (!id) fail('memory-ssa-validate-access-metadata-id-required');
      if (metadataIds.has(`${id}\\u0000${item.regionId}`)) fail('memory-ssa-validate-duplicate-access-metadata');
      metadataIds.add(`${id}\\u0000${item.regionId}`);
      if (!definitionIds.has(id) && !useIds.has(id)) fail('memory-ssa-validate-dangling-access-metadata');
      if (!regionIds.has(String(item.regionId))) fail('memory-ssa-validate-access-metadata-region-mismatch');""",
"""      if (typeof item.memorySsaEntityId !== 'string' || !item.memorySsaEntityId.trim()) fail('memory-ssa-validate-access-metadata-id-required');
      if (typeof item.regionId !== 'string' || !item.regionId.trim()) fail('memory-ssa-validate-access-metadata-region-mismatch');
      const id = item.memorySsaEntityId;
      if (metadataIds.has(`${id}\\u0000${item.regionId}`)) fail('memory-ssa-validate-duplicate-access-metadata');
      metadataIds.add(`${id}\\u0000${item.regionId}`);
      if (!definitionIds.has(id) && !useIds.has(id)) fail('memory-ssa-validate-dangling-access-metadata');
      if (!regionIds.has(item.regionId)) fail('memory-ssa-validate-access-metadata-region-mismatch');""")

# #2826 — CFG identities/edge enums must already be strings.
replace('js/semantics/cfg/index.js',
"""function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}""",
"""function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}""")

# #2833 — stack access coverage follows the existing load/store classifier.
p = Path('js/analyze.js')
s = p.read_text()
old = """      if (/^stp?$/.test(b) || b === 'stp' || b === 'str') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') {
          res.stackAccess++;
          if (mem.mode === 'pre' && mem.disp && mem.disp.value != null && mem.disp.value < 0n) res.frameBytes += Number(-mem.disp.value);
        }
      }
      if (b === 'ldr' || b === 'ldp' || b === 'ldur') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') res.stackAccess++;
      }"""
new = """      if (catg === 'load' || catg === 'store') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') {
          res.stackAccess++;
          if (catg === 'store' && mem.mode === 'pre' && mem.disp && mem.disp.value != null && mem.disp.value < 0n) {
            res.frameBytes += Number(-mem.disp.value);
          }
        }
      }"""
if old not in s: raise SystemExit('anchor missing: analyze stack access')
p.write_text(s.replace(old, new, 1))

# #2842 — revision/epoch identity scalars reject coercion.
p = Path('js/analysis/query/app-adapter.js')
s = p.read_text()
anchor = """function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
"""
helper = anchor + """
function nonNegativeSafeInteger(value, fallback, code) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(code);
  return value;
}
"""
if anchor not in s: raise SystemExit('anchor missing: app-adapter helper')
s = s.replace(anchor, helper, 1)
old = """      const projectRevision = Number(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0);
      const analysisEpoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return { binaryId:binaryId.trim(), projectRevision:Number.isFinite(projectRevision) ? projectRevision : 0, artifactVersions:artifactVersions(app), analysisEpoch:Number.isFinite(analysisEpoch) ? analysisEpoch : 0 };"""
new = """      const projectRevision = nonNegativeSafeInteger(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision, 0, 'analysis-query-project-revision-invalid');
      const analysisEpoch = nonNegativeSafeInteger(app?.backend?.gen ?? app?.analysisEpoch, 0, 'analysis-query-epoch-invalid');
      return { binaryId:binaryId.trim(), projectRevision, artifactVersions:artifactVersions(app), analysisEpoch };"""
if old not in s: raise SystemExit('anchor missing: app-adapter identity')
p.write_text(s.replace(old, new, 1))

# #2848 — close abort-registration windows after installing listeners.
replace('js/analysis/investigation-service.js',
"""      signal?.addEventListener('abort', onAbort, { once:true });
      requestIdleCallback(() => finish(resolve), { timeout:250 });""",
"""      signal?.addEventListener('abort', onAbort, { once:true });
      if (signal?.aborted) { onAbort(); return; }
      requestIdleCallback(() => finish(resolve), { timeout:250 });""")
replace('js/analysis/investigation-service.js',
"""    signal?.addEventListener('abort', onAbort, { once:true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));""",
"""    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) { onAbort(); return; }
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));""")
replace('js/analysis/investigation-service.js',
"""  return new Promise((resolve, reject) => {
    const onAbort = () => { try { request.cancel?.(); } catch { /* best effort */ } reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(request).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });""",
"""  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      if (settled) return;
      try { request.cancel?.(); } catch { /* best effort */ }
      finish(reject, abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once:true });
    if (signal?.aborted) { onAbort(); return; }
    Promise.resolve(request).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });""")

# #2865 — product-surface pagination accepts only numeric integers.
replace('js/analysis/query/product-surface.js',
"""function pageOf(page = {}) {
  const offset = Number(page.offset ?? 0);
  const limit = Number(page.limit ?? 200);
  return {
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(5000, limit) : 200,
  };
}""",
"""function pageOf(page = {}) {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 200;
  return {
    offset: typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? Math.min(5000, limit) : 200,
  };
}""")

# #2871 — canonical identity returns the exact normalized BinaryId it validates.
replace('js/analysis/query/product-adapter.js',
"""  return {
    binaryId,
    projectRevision: nonNegativeSafeInteger(""",
"""  return {
    binaryId:binaryId.trim(),
    projectRevision: nonNegativeSafeInteger(""")

# Focused regressions. Public-contract assertions are complemented by source checks
# for private orchestration helpers; full repository CI exercises the integrations.
Path('tests/unlinked-strict-boundaries-20260831.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';
import { analyzeDecodedSemanticFunction } from '../js/analysis/semantic-function-base.js';
import { createMemoryRegionRef } from '../js/semantics/memoryssa/contract.js';
import { createSemanticCfg } from '../js/semantics/cfg/index.js';
import { createAppAnalysisQueryAdapter as createBaseAdapter } from '../js/analysis/query/app-adapter.js';
import { createAppAnalysisQueryAdapter as createProductAdapter } from '../js/analysis/query/product-adapter.js';
import { createProductSurfaceQueries } from '../js/analysis/query/product-surface.js';

let seq = 0;
const gp = (num, bits = 64, extra = {}) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}`, ...extra });
const imm = (value, extra = {}) => ({ k:'imm', value:BigInt(value), text:`#${value}`, ...extra });
function lift(mnemonic, ops) {
  const instructionId = `strict:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{ instructionIds:[instructionId] } });
}
function failClosed(bundle, label) {
  assert.ok(bundle, label);
  assert.equal(bundle.completeness, 'partial', label);
  assert.ok(bundle.operations.every((op) => op.kind === 'unknown'), label);
}
for (const shift of [
  {op:'lsl',amount:'1'}, {op:'lsl',amount:true}, {op:'lsl',amount:[1]},
  {op:'lsl',amount:{valueOf(){return 1;}}}, {op:{toString(){return 'lsl';}},amount:1},
  {op:'lsl',amount:1.5}, {op:'lsl',amount:NaN}, {op:'lsl',amount:Infinity},
]) failClosed(lift('add',[gp(0),gp(1),gp(2,64,{shift})]), 'structured shift must fail closed');
assert.notEqual(lift('add',[gp(0),gp(1),gp(2,64,{shift:{op:'lsl',amount:1}})]).completeness, 'partial');
failClosed(lift('movz',[gp(0),imm(1,{shift:{op:'lsl',amount:'16'}})]),'move-wide string shift');

for (const text of [{toString(){return 'nzcv';}}, ['nzcv']]) {
  failClosed(lift('mrs',[gp(0),{k:'sysreg',text}]), 'sysreg text must be string');
}
for (const text of [{toString(){return 'ish';}}, ['ish']]) {
  failClosed(lift('dmb',[{k:'barrier',text}]), 'barrier selector must be string');
}

assert.throws(() => analyzeDecodedSemanticFunction({ instructions:[], architecture:{toString(){return 'arm64';}} }), TypeError);
assert.throws(() => analyzeDecodedSemanticFunction({ instructions:[], architecture:['arm64'] }), TypeError);
assert.throws(() => analyzeDecodedSemanticFunction({ instructions:[], architecture:'arm64', instructionEndianness:['little'] }), TypeError);
assert.throws(() => analyzeDecodedSemanticFunction({ instructions:[], architecture:'arm64', dataEndianness:{toString(){return 'little';}} }), TypeError);

for (const bad of [{toString(){return 'r';}}, ['r'], 1, true]) {
  assert.throws(() => createMemoryRegionRef({ id:bad, kind:'unknown', functionId:'f', uncertaintyIdentity:{source:'t'} }), TypeError);
  assert.throws(() => createSemanticCfg({ functionId:'f', entryBlockId:bad, blocks:[{id:'b',successors:[]}] }), TypeError);
}
assert.equal(createMemoryRegionRef({ id:' r ', kind:'unknown', functionId:'f', uncertaintyIdentity:{source:'t'} }).id, 'r');
assert.equal(createSemanticCfg({ functionId:'f', entryBlockId:' b ', blocks:[{id:'b',successors:[]}] }).entryBlockId, 'b');

const baseApp = {
  backend:{ binaryId:'bin', gen:1 },
  workspace:{ bindingRevision:0 },
  store:{ get(){ return null; } },
};
const base = createBaseAdapter(baseApp);
assert.equal((await base.currentIdentity()).analysisEpoch, 1);
for (const bad of ['1', true, [1], {valueOf(){return 1;}}]) {
  const app = { ...baseApp, backend:{ binaryId:'bin', gen:bad } };
  await assert.rejects(() => createBaseAdapter(app).currentIdentity(), TypeError);
}

const product = createProductAdapter({ backend:{binaryId:'  bin-normalized  ',gen:0}, workspace:{bindingRevision:0}, store:{get(){return null;}} });
assert.equal((await product.currentIdentity()).binaryId, 'bin-normalized');

const snapshot = Object.freeze({ snapshotId:'s', analysisEpoch:0 });
const surfaceApp = {
  analysisQueries:{ snapshot:async()=>snapshot },
  autoReport:{ report:{ findings:Array.from({length:5},(_,i)=>({id:`c${i}`,title:`c${i}`,verdict:'supported'})) } },
};
const surface = createProductSurfaceQueries(surfaceApp);
for (const bad of ['1', true, [1], {valueOf(){return 1;}}]) {
  const result = await surface.claims(snapshot, {}, {offset:bad,limit:bad});
  assert.equal(result.page.offset,0);
  assert.equal(result.page.limit,200);
}

const inv = fs.readFileSync(new URL('../js/analysis/investigation-service.js', import.meta.url),'utf8');
assert.ok((inv.match(/if \(signal\?\.aborted\) \{ onAbort\(\); return; \}/g)||[]).length >= 3, 'all abort-listener windows recheck after registration');
assert.match(inv,/let settled = false;[\s\S]*request\.cancel\?\.\(\)/);
const memoryBuild = fs.readFileSync(new URL('../js/semantics/memoryssa/build.js', import.meta.url),'utf8');
assert.match(memoryBuild,/relation != null && typeof relation !== 'string'/);
const memoryValidate = fs.readFileSync(new URL('../js/semantics/memoryssa/validate.js', import.meta.url),'utf8');
assert.doesNotMatch(memoryValidate,/definitionId: String\(link\.definitionId\)/);
assert.doesNotMatch(memoryValidate,/\.map\(String\)\.sort\(\)/);
const analyze = fs.readFileSync(new URL('../js/analyze.js', import.meta.url),'utf8');
assert.match(analyze,/if \(catg === 'load' \|\| catg === 'store'\)/);
assert.doesNotMatch(analyze,/if \(b === 'ldr' \|\| b === 'ldp' \|\| b === 'ldur'\)/);
console.log('unlinked strict boundaries: PASS');
''')
