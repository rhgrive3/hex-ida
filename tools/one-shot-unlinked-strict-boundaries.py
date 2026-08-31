from pathlib import Path


def edit(path, replacements):
    p = Path(path)
    s = p.read_text()
    for old, new, label in replacements:
        if old not in s:
            raise SystemExit(f'{path}: anchor drift: {label}')
        s = s.replace(old, new, 1)
    p.write_text(s)


# #2588 + #2807: structured register identity and structured shift authority.
edit('js/targets/architecture/arm64/effects/addressing.js', [
    ("""    if (input.text != null) {
      const presented = arm64RegisterOperand(String(input.text));
      if (!sameStructuredRegisterIdentity(canonical, presented)) return null;
      canonical.view = String(input.text).trim().toLowerCase();
    }""",
     """    if (input.text != null) {
      if (typeof input.text !== 'string') return null;
      const presented = arm64RegisterOperand(input.text);
      if (!sameStructuredRegisterIdentity(canonical, presented)) return null;
      canonical.view = input.text.trim().toLowerCase();
    }""", 'structured register presentation'),
    ("""  const op = String(shift.op || '').toLowerCase();
  const amount = shift.amount == null ? 0 : Number(shift.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');""",
     """  if (typeof shift.op !== 'string') fail('arm64-invalid-register-offset-shift');
  const op = shift.op.toLowerCase();
  const amount = shift.amount == null ? 0 : shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');""", 'register offset shift'),
])

edit('js/targets/architecture/arm64/effects/common.js', [
    ("""  function shiftImmediate(value, widthBits, kind, amount) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0 || n >= widthBits) return null;""",
     """  function shiftImmediate(value, widthBits, kind, amount) {
    const n = amount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= widthBits) return null;""", 'shiftImmediate'),
    ("""    const kind = String(modifier.op || '').toLowerCase();
    const amount = modifier.amount == null ? 0 : Number(modifier.amount);""",
     """    if (typeof modifier.op !== 'string') return null;
    const kind = modifier.op.toLowerCase();
    const amount = modifier.amount == null ? 0 : modifier.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return null;""", 'applyModifier'),
    ("""      const modifierKind = String(op.shift?.op || '').toLowerCase();""",
     """      const modifierKind = typeof op.shift?.op === 'string' ? op.shift.op.toLowerCase() : '';""", 'readOperand modifier'),
])

edit('js/targets/architecture/arm64/effects/index.js', [
    ("""  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;""",
     """  return typeof op.shift.op === 'string'
    && op.shift.op.toLowerCase() === 'lsl'
    && typeof op.shift.amount === 'number'
    && Number.isInteger(op.shift.amount)
    && op.shift.amount === 12;""", 'imm12 shift'),
    ("""  const kind = String(operand.shift.op || '').toLowerCase();
  const amount = Number(operand.shift.amount ?? 0);
  return ['lsl','lsr','asr','ror'].includes(kind) && Number.isInteger(amount) && amount >= 0 && amount < widthBits;""",
     """  if (typeof operand.shift.op !== 'string') return false;
  const kind = operand.shift.op.toLowerCase();
  const amount = operand.shift.amount ?? 0;
  return ['lsl','lsr','asr','ror'].includes(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < widthBits;""", 'logical shifted source'),
])

edit('js/targets/architecture/arm64/effects/integer.js', [
    ("""  return String(op.shift.op || '').toLowerCase() === 'lsl' && Number(op.shift.amount) === 12;""",
     """  return typeof op.shift.op === 'string'
    && op.shift.op.toLowerCase() === 'lsl'
    && typeof op.shift.amount === 'number'
    && Number.isInteger(op.shift.amount)
    && op.shift.amount === 12;""", 'integer imm12'),
    ("""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) return false;""",
     """  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 4) return false;""", 'extended source'),
    ("""  const kind = String(modifier.op || '').toLowerCase();
  const amount = Number(modifier.amount ?? 0);
  return ['lsl','lsr','asr'].includes(kind)
    && Number.isInteger(amount) && amount >= 0 && amount < targetBits;""",
     """  if (typeof modifier.op !== 'string') return false;
  const kind = modifier.op.toLowerCase();
  const amount = modifier.amount ?? 0;
  return ['lsl','lsr','asr'].includes(kind)
    && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount < targetBits;""", 'shifted source'),
    ("""  const explicitExtend = EXTEND_KINDS.has(String(modifier?.op || '').toLowerCase());""",
     """  const explicitExtend = typeof modifier?.op === 'string' && EXTEND_KINDS.has(modifier.op.toLowerCase());""", 'explicit extend'),
    ("""  if (String(src.shift.op || '').toLowerCase() !== 'lsl') return false;
  const amount = Number(src.shift.amount);
  if (!Number.isInteger(amount)) return false;""",
     """  if (typeof src.shift.op !== 'string' || src.shift.op.toLowerCase() !== 'lsl') return false;
  const amount = src.shift.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false;""", 'move-wide shift'),
])

# #2809 + #2866: system-register / barrier selector presentation must be a string.
edit('js/targets/architecture/arm64/effects/system.js', [
    ("""function sysRegText(op) {
  if (!hasNoOperandModifier(op)) return null;
  const text = String(op?.text || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}""",
     """function sysRegText(op) {
  if (!hasNoOperandModifier(op) || typeof op?.text !== 'string') return null;
  const text = op.text.trim().toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(text) ? text : null;
}""", 'sysRegText'),
    ("""function barrier(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain:String(operand?.text || instruction?.operands || 'sy').toLowerCase(),
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };""",
     """function barrier(instruction, context, mnemonic, ops) {
  const operand = ops[0];
  let domain = 'sy';
  if (operand?.k === 'imm') {
    if (typeof operand.value !== 'bigint' || operand.shift != null || operand.extend != null) {
      return partial(instruction, context, `${mnemonic}-operand-shape-invalid`, ['other']);
    }
    domain = typeof operand.text === 'string' && operand.text.trim()
      ? operand.text.trim().toLowerCase()
      : `#${operand.value.toString()}`;
  } else if (operand != null) {
    if (!hasNoOperandModifier(operand) || typeof operand.text !== 'string') {
      return partial(instruction, context, `${mnemonic}-operand-shape-invalid`, ['other']);
    }
    domain = operand.text.trim().toLowerCase();
    if (!domain) return partial(instruction, context, `${mnemonic}-operand-shape-invalid`, ['other']);
  }
  const allowed = mnemonic === 'dsb'
    ? new Set([...DATA_BARRIER_OPTIONS, ...DSB_NXS_OPTIONS])
    : DATA_BARRIER_OPTIONS;
  if (!allowed.has(domain) && !/^#(?:[0-9]|1[0-5])$/.test(domain)) {
    return partial(instruction, context, `${mnemonic}-barrier-option-invalid`, ['other']);
  }
  const scope = {
    architecture:'arm64',
    barrier:mnemonic,
    domain,
    semantics:mnemonic === 'isb' ? 'instruction-synchronization' : mnemonic === 'dsb' ? 'data-synchronization' : 'data-memory-ordering',
  };""", 'barrier selector'),
])

# #2973: empty/structured evidence IDs cannot establish static identity.
edit('js/runtime/trace-provider.js', [
    ("""      const identityEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const hasProvenStaticIdentity = module.binaryId != null && (module.identityState === 'exact' || module.identityState === 'resolved' || identityEvidenceIds.length > 0);""",
     """      const identityEvidenceIds = Array.isArray(module.identityEvidenceIds) ? module.identityEvidenceIds : [];
      const hasValidIdentityEvidence = identityEvidenceIds.length > 0
        && identityEvidenceIds.every((id) => typeof id === 'string' && id.trim().length > 0);
      const hasProvenStaticIdentity = module.binaryId != null && (
        module.identityState === 'exact' ||
        module.identityState === 'resolved' ||
        hasValidIdentityEvidence
      );""", 'trace identity evidence'),
])

# #2975: runtime evidence enum/relation/confidence boundaries are explicit.
edit('js/runtime/evidence-bridge.js', [
    ("""function completeness(value, fallback = 'partial') {
  const normalized = String(value ?? fallback);
  if (!EVIDENCE_COMPLETENESS.includes(normalized)) throw new DebugAdapterError('runtime-invalid-completeness', `invalid evidence completeness: ${normalized}`);
  return normalized;
}""",
     """function completeness(value, fallback = 'partial') {
  const normalized = value == null ? fallback : value;
  if (typeof normalized !== 'string' || !EVIDENCE_COMPLETENESS.includes(normalized)) {
    throw new DebugAdapterError('runtime-invalid-completeness', 'invalid evidence completeness');
  }
  return normalized;
}

function evidenceConfidence(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DebugAdapterError('runtime-invalid-confidence', 'runtime evidence confidence must be a finite number');
  }
  return value;
}""", 'evidence completeness'),
    ("""      confidence: options.confidence == null ? null : Number(options.confidence),""",
     """      confidence: evidenceConfidence(options.confidence),""", 'evidence confidence'),
    ("""  linkClaim(claimId, evidenceId, relation, resolution = null) {
    const type = String(relation);
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);""",
     """  linkClaim(claimId, evidenceId, relation, resolution = null) {
    if (typeof relation !== 'string') throw new DebugAdapterError('runtime-invalid-evidence-relation', 'runtime evidence relation must be a string');
    const type = relation;
    if (!RELATIONS.includes(type)) throw new DebugAdapterError('runtime-invalid-evidence-relation', `invalid runtime evidence relation: ${type}`);""", 'evidence relation'),
])

# #3003: authority epoch/sequence/counts are number-only primitives, not numeric strings.
edit('js/runtime/authority.js', [
    ("""function numericPrimitive(value, code) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  throw new TypeError(code);
}""",
     """function numericPrimitive(value, code) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(code);
}""", 'authority numeric primitive'),
])

# #3006: module binding equality cannot erase type differences through String().
edit('js/runtime/debugger-provider.js', [
    ("""function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const scalar = (value) => value == null ? null : String(value);
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return scalar(current.runtimeBase) === scalar(next.runtimeBase)
    && scalar(current.runtimeSize) === scalar(next.runtimeSize)
    && scalar(current.staticBase) === scalar(next.staticBase)
    && scalar(current.pathHint) === scalar(next.pathHint)
    && scalar(current.binaryId) === scalar(next.binaryId)
    && scalar(current.sliceId) === scalar(next.sliceId)
    && scalar(current.imageId) === scalar(next.imageId)
    && scalar(current.identityState) === scalar(next.identityState)""",
     """function sameModuleBinding(current, next) {
  if (!current || !next) return false;
  const currentEvidence = current.identityEvidenceIds ?? [];
  const nextEvidence = next.identityEvidenceIds ?? [];
  return current.runtimeBase === next.runtimeBase
    && current.runtimeSize === next.runtimeSize
    && current.staticBase === next.staticBase
    && current.pathHint === next.pathHint
    && current.binaryId === next.binaryId
    && current.sliceId === next.sliceId
    && current.imageId === next.imageId
    && current.identityState === next.identityState""", 'debugger sameModuleBinding'),
])

# #3052/#3053/#3092/#3101: discovery registry, budget, region-size and raw-start authority.
p = Path('js/analysis/discovery/fusion.js')
s = p.read_text()
anchor = """export const DISCOVERY_DEFAULT_BUDGET = Object.freeze({
  maxCandidates: 200000,
  maxEvidencePerCandidate: 64,
});
"""
helper = anchor + """
function canonicalDiscoveryInteger(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const out = BigInt(value);
    return out >= 0n ? out : null;
  } catch {
    return null;
  }
}

function normalizeDiscoveryBudget(value) {
  if (value == null) return DISCOVERY_DEFAULT_BUDGET;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('discovery-budget-invalid');
  const out = { ...DISCOVERY_DEFAULT_BUDGET };
  for (const key of ['maxCandidates', 'maxEvidencePerCandidate']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new TypeError(`discovery-budget-${key}-invalid`);
    }
    out[key] = value[key];
  }
  return Object.freeze(out);
}
"""
if anchor not in s:
    raise SystemExit('fusion: budget helper anchor drift')
s = s.replace(anchor, helper, 1)
old = """  constructor() {
    this.producers = new Map();
  }

  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    const id = String(producer.id ?? '');
    if (!id) throw new TypeError('discovery-producer-id-required');
    this.producers.set(id, producer);
    return this;
  }

  /** Producers applicable to one architecture, in deterministic order. */
  for(architectureId) {
    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  collect(input, architectureId, options = {}) {
    const evidence = [];
    const producerIds = [];
    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const produced = producer.produce(input, options) ?? [];
      for (const item of produced) evidence.push({ ...item, producerId: producer.id, architectureId: producer.architectureId ?? null });
      producerIds.push(producer.id);
    }
    return { evidence, producerIds };
  }"""
new = """  constructor() {
    this.producers = new Map();
    this.producerIds = new WeakMap();
  }

  register(producer) {
    if (typeof producer?.produce !== 'function') throw new TypeError('discovery-producer-must-implement-produce');
    if (typeof producer.id !== 'string' || !producer.id.trim()) throw new TypeError('discovery-producer-id-required');
    const id = producer.id;
    this.producers.set(id, producer);
    this.producerIds.set(producer, id);
    return this;
  }

  /** Producers applicable to one architecture, in deterministic order. */
  for(architectureId) {
    return [...this.producers.values()]
      .filter((producer) => producer.architectureId == null || producer.architectureId === architectureId)
      .sort((left, right) => this.producerIds.get(left).localeCompare(this.producerIds.get(right)));
  }

  collect(input, architectureId, options = {}) {
    const evidence = [];
    const producerIds = [];
    for (const producer of this.for(architectureId)) {
      if (options.signal?.aborted) break;
      const producerId = this.producerIds.get(producer);
      const produced = producer.produce(input, options) ?? [];
      for (const item of produced) evidence.push({ ...item, producerId, architectureId: producer.architectureId ?? null });
      producerIds.push(producerId);
    }
    return { evidence, producerIds };
  }"""
if old not in s:
    raise SystemExit('fusion: registry anchor drift')
s = s.replace(old, new, 1)
old = "const budget = { ...DISCOVERY_DEFAULT_BUDGET, ...(options.budget ?? {}) };"
if old not in s:
    raise SystemExit('fusion: budget use anchor drift')
s = s.replace(old, "const budget = normalizeDiscoveryBudget(options.budget);", 1)
old = """  const byStart = new Map();
  const orderedEvidence = [...evidence].sort(compareEvidence);
  for (const item of orderedEvidence) {
    if (item.start == null) continue;
    const key = BigInt(item.start).toString();"""
new = """  const byStart = new Map();
  const canonicalEvidence = evidence.filter((item) => item?.start == null || canonicalDiscoveryInteger(item.start) != null);
  const orderedEvidence = [...canonicalEvidence].sort(compareEvidence);
  for (const item of orderedEvidence) {
    if (item.start == null) continue;
    const canonicalStart = canonicalDiscoveryInteger(item.start);
    if (canonicalStart == null) continue;
    const key = canonicalStart.toString();"""
if old not in s:
    raise SystemExit('fusion: raw start anchor drift')
s = s.replace(old, new, 1)
old = """export function regionFromSize(start, sizeBytes, ownership = 'exclusive') {
  const begin = BigInt(start);
  const size = BigInt(sizeBytes);
  if (size <= 0n) return null;
  return createRegion({ start: begin, end: begin + size, ownership });
}"""
new = """export function regionFromSize(start, sizeBytes, ownership = 'exclusive') {
  const begin = canonicalDiscoveryInteger(start);
  const size = canonicalDiscoveryInteger(sizeBytes);
  if (begin == null || size == null || size <= 0n) return null;
  return createRegion({ start: begin, end: begin + size, ownership });
}"""
if old not in s:
    raise SystemExit('fusion: regionFromSize anchor drift')
s = s.replace(old, new, 1)
p.write_text(s)

# Regression tests. Root-owner tests are paired with full subsystem suites below.
Path('tests/machine-effects/arm64-unlinked-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { arm64RegisterOperand } from '../../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const gp=(num,bits=64,extra={})=>({k:'reg',cls:'gp',num,bits,text:`${bits===32?'w':'x'}${num}`,...extra});
const vec=(num,bits=128,extra={})=>({k:'reg',cls:'vec',num,bits,text:`${bits===128?'q':bits===64?'d':'s'}${num}`,...extra});
const mem=(base=gp(2),extra={})=>({k:'mem',mode:'offset',base,disp:{k:'imm',value:0n},...extra});
let seq=0;
const lift=(mnemonic,ops)=>{const instructionId=`unlinked-arm64:${++seq}`;return liftArm64MachineEffects({instructionId,mnemonic,mode:'a64',ops,origin:{instructionIds:[instructionId]}});};
const failClosed=(bundle,label)=>{assert.ok(bundle,label);assert.equal(bundle.completeness,'partial',label);assert.equal(bundle.operations.some((op)=>['register-read','register-write','memory-read','memory-write'].includes(op.kind)),false,label);};

assert.equal(arm64RegisterOperand({k:'reg',cls:'gp',num:0,bits:64,text:'x1'}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'gp',num:0,bits:64,text:['x0']}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'sp',num:31,bits:64,text:'x1'}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'zr',num:31,bits:64,text:'x1'}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'vec',num:0,bits:128,text:'q1'}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'gp',num:99,bits:64,text:'x0'}),null);
assert.equal(arm64RegisterOperand({k:'reg',cls:'gp',num:29,bits:64,text:'fp'})?.physicalId,'x29');
assert.equal(arm64RegisterOperand({k:'reg',cls:'gp',num:30,bits:64,text:'lr'})?.physicalId,'x30');
assert.equal(arm64RegisterOperand({k:'reg',cls:'sp',num:31,bits:64,text:'sp'})?.physicalId,'sp');
assert.equal(arm64RegisterOperand({k:'reg',cls:'zr',num:31,bits:64,text:'xzr'})?.zero,true);

failClosed(lift('ldr',[gp(0,64,{text:'x1'}),mem()]),'LDR data identity contradiction');
failClosed(lift('str',[gp(0),mem(gp(2,64,{text:'x3'}))]),'STR base identity contradiction');
failClosed(lift('ldr',[gp(0),mem(gp(2),{index:gp(3,64,{text:'x4'}),shift:{op:'lsl',amount:0}})]),'LDR index identity contradiction');
failClosed(lift('ldr',[gp(0),{k:'mem',mode:'pre',base:gp(2,64,{text:'x3'}),disp:{k:'imm',value:8n}}]),'pre-index base contradiction');
failClosed(lift('ldr',[vec(0,128,{text:'q1'}),mem()]),'vector destination contradiction');

// Structured shift values must not be Number/String coerced.
for (const shift of [{op:'lsl',amount:'1'},{op:'lsl',amount:true},{op:'lsl',amount:[1]},{op:{toString(){return 'lsl';}},amount:1},{op:'lsl',amount:1.5}]) {
  failClosed(lift('add',[gp(0),gp(1),gp(2,64,{shift})]),`ADD malformed shift ${String(shift.amount)}`);
}
const validShift=lift('add',[gp(0),gp(1),gp(2,64,{shift:{op:'lsl',amount:1}})]);
assert.notEqual(validShift.completeness,'partial');

// System selectors reject structured presentation values; legal text remains exact.
for (const bad of [['nzcv'],{toString(){return 'nzcv';}},true,1]) failClosed(lift('mrs',[gp(0),{k:'sysreg',text:bad}]),'MRS malformed sysreg');
for (const bad of [['sy'],{toString(){return 'ish';}},true,1]) failClosed(lift('dmb',[{k:'other',text:bad}]),'DMB malformed barrier');
const barrier=lift('dmb',[{k:'other',text:'ish'}]);
assert.equal(barrier.completeness,'exact');
assert.ok(barrier.operations.some((op)=>op.kind==='barrier');

// Memory and atomic owners both consume the same strict root helper.
for (const path of ['js/targets/architecture/arm64/effects/memory.js','js/targets/architecture/arm64/effects/atomic.js']) {
  const source=fs.readFileSync(path,'utf8');
  assert.ok(source.includes('arm64RegisterOperand'),`${path} must retain strict root-owner wiring`);
}
console.log('arm64 unlinked strict boundaries: PASS');
''')

Path('tests/phase10/runtime-unlinked-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RuntimeEvidenceBridge, conservativeCompleteness } from '../../js/runtime/evidence-bridge.js';
import { createRuntimeAuthorityBinding, createRuntimeObservation } from '../../js/runtime/authority.js';
import { TraceProvider } from '../../js/runtime/trace-provider.js';

assert.throws(()=>conservativeCompleteness(['complete']),/runtime-invalid-completeness/);
const bridge=new RuntimeEvidenceBridge();
const event={runtimeSessionId:'s',providerId:'p',providerVersion:'1',sessionEpoch:1,sequence:1,kind:'trace-marker',observationMode:'observed',completeness:'partial'};
assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:'0.9'}),/runtime-invalid-confidence/);
assert.throws(()=>bridge.eventToEvidence(event,null,{confidence:true}),/runtime-invalid-confidence/);
assert.throws(()=>bridge.linkClaim('c','e',['supports']),/runtime-invalid-evidence-relation/);

const input={providerIdentity:'p',runtimeInstanceIdentity:'r',targetIdentity:'t',binaryIdentity:'b',moduleIdentity:'m',loadMappingIdentity:'l',sessionIdentity:'s',capabilityVersion:'1',epoch:1};
const binding=createRuntimeAuthorityBinding(input);
assert.throws(()=>createRuntimeAuthorityBinding({...input,epoch:'1'}),/runtime-epoch-invalid/);
assert.throws(()=>createRuntimeObservation({binding,sequence:'1',observedAt:'now',kind:'trace-marker',payload:{}}),/runtime-observation-sequence-invalid/);

const source=fs.readFileSync(new URL('../../js/runtime/debugger-provider.js',import.meta.url),'utf8');
const start=source.indexOf('function sameModuleBinding');
const end=source.indexOf('export class DebuggerProvider');
const body=source.slice(start,end);
assert.ok(start>=0&&end>start);
assert.ok(!body.includes('String(value)'));
assert.ok(body.includes('current.binaryId === next.binaryId'));
assert.ok(body.includes('current.runtimeBase === next.runtimeBase'));

// A structured evidence ID must not prove an otherwise-unresolved trace module.
const provider=new TraceProvider({recordingId:'r',sourceProvider:'p',sourceProviderVersion:'1',binaryId:'binary',modules:[{bindingKey:'m',runtimeBase:4096n,runtimeSize:4096n,binaryId:'module-bin',identityState:'unresolved',identityEvidenceIds:[['e1']]}],events:[]});
const session=await provider.openSession();
const module=session.modules.get('m');
assert.equal(module.binaryId,null);
assert.equal(module.identityState,'unresolved');
await session.close();
console.log('runtime unlinked strict boundaries: PASS');
''')

Path('tests/phase7/discovery-unlinked-strict-boundaries.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { DiscoveryProducerRegistry, fuseFunctionCandidates, regionFromSize } from '../../js/analysis/discovery/fusion.js';

for (const id of [['p1'],1,true,{toString(){return 'p1';}},'']) {
  const registry=new DiscoveryProducerRegistry();
  assert.throws(()=>registry.register({id,produce(){return[];}}),/discovery-producer-id-required/);
}
const producer={id:'p1',architectureId:null,produce(){return[{kind:'loader-function-start',authority:'authoritative',start:'4096',extentRole:'complete',regions:[]}];}};
const registry=new DiscoveryProducerRegistry();
registry.register(producer);
producer.id=['mutated'];
const collected=registry.collect({},'arm64');
assert.deepEqual(collected.producerIds,['p1']);
assert.equal(collected.evidence[0].producerId,'p1');

for (const malformed of ['1',['1'],true,1.5,0,-1,Infinity]) {
  assert.throws(()=>fuseFunctionCandidates([], {budget:{maxCandidates:malformed}}),/discovery-budget-maxCandidates-invalid/);
  assert.throws(()=>fuseFunctionCandidates([], {budget:{maxEvidencePerCandidate:malformed}}),/discovery-budget-maxEvidencePerCandidate-invalid/);
}
assert.throws(()=>fuseFunctionCandidates([], {budget:['bad']}),/discovery-budget-invalid/);

for (const [start,size] of [[['4096'],32n],[4096n,['32']],[4096n,true],[4096n,{valueOf(){return 32;}}],[4096n,1.5],[4096n,Infinity]]) {
  assert.equal(regionFromSize(start,size),null);
}
assert.equal(regionFromSize(4096n,32n)?.end,'4128');
assert.equal(regionFromSize('4096','32')?.end,'4128');

const badStarts=[['4096'],true,{valueOf(){return 4096;}},{toString(){return '4096';}}];
for (const bad of badStarts) {
  const out=fuseFunctionCandidates([{kind:'loader-function-start',authority:'authoritative',producerId:'loader',start:bad,extentRole:'complete',regions:[]}]);
  assert.equal(out.candidates.length,0,`malformed start ${typeof bad} must not produce candidate`);
}
for (const good of [4096n,4096,'4096','0x1000']) {
  const out=fuseFunctionCandidates([{kind:'loader-function-start',authority:'authoritative',producerId:'loader',start:good,extentRole:'complete',regions:[]}]);
  assert.equal(out.candidates.length,1);
  assert.equal(out.candidates[0].start,'4096');
  assert.equal(out.candidates[0].startState,'exact');
}
console.log('discovery unlinked strict boundaries: PASS');
''')
