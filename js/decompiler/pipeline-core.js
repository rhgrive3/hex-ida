/*
 * High-level semantic decompiler pipeline.
 * It consumes the existing Semantic IR/SSA/Memory-SSA and deliberately does not
 * re-interpret ARM64 instruction text. The legacy decompiler remains an isolated
 * fallback at the public facade.
 */
import { children, expr, mergeSource, sourceOf, mapChildren, structuralKey, sameExpr } from './ast/nodes.js';
import { RewriteEngine, expressionOriginHistory } from './rewrite/engine.js';
import { DEFAULT_RULES } from './rewrite/rules.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from './phase8/projection-origin.js';
import { recoverArm64ClangIdiom, recognizeClamp, recognizeDivisionByConstant } from './idioms/arm64-clang.js';
import { recoverHighVariables } from './types/high-variables.js';
import { recoverFunctionPrototype } from './types/prototype.js';
import { recoverAggregateLayouts } from './types/layout.js';
import { PassManager } from './passes/manager.js';
import { INTERACTIVE_STAGES as PHASE8_INTERACTIVE_STAGES, PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { printExpression, printProgram, expressionReadability } from './pretty/c.js';
import { explainSemanticFacts } from './explain.js';
import { readSwitchLineHistory, readSwitchRenderHistory } from './switch.js';
import { readSemanticStoreLineHistory, readSemanticStoreRenderHistory } from './semantic-core.js';
import { buildNZCVConditionExpression } from './flag-semantics.js';
import { readProjectedMemoryOperandTransition, projectedMemoryOperandTransitionExpected,
  readProjectedConstantTransitions, projectedConstantTransitionExpected } from '../semantics/compat/semantic-ir-v2-to-v1.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';

function valueOf(a) { return a?.value || null; }

// Presentation provenance belongs to the actual producer/consumer pair, not
// to an expression's text or a shared input's source IDs. No public metadata
// can issue a binding, and the expression/load identity is never modified.
const expressionHistoryConsumers = new WeakMap();
const storeSpellingProducers = new WeakMap();
const buildHistoryObservations = new WeakMap();
function valueHistoryRecord(record, valueId) {
  const copy = { ...record, valueId };
  const observation = buildHistoryObservations.get(record);
  if (observation) buildHistoryObservations.set(copy, observation);
  return copy;
}
function currentBuildHistory(records) {
  return records.every(record => buildHistoryObservations.get(record)?.matches() !== false);
}
function consumerObservationBudget(state) {
  const requested = state.opts?.renderProvenanceBindingBudget;
  const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
  return state.expressionBindingBudget ??= {
    consumers:cap(requested?.maxConsumers, 4096), edges:cap(requested?.maxEdges, PROJECTION_LIMITS.edges),
    reasons:new Set(),
  };
}

function fieldProjectionRecords(semantic, state) {
  if (!state.fieldLocations?.size) return [];
  // Only actual consumed locations get history. Equal names/offsets and
  // speculative aggregate layouts cannot identify an emitted access.
  const records = new Set(), seen = new Set(), pending = [semantic.expression];
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  const collect = location => {
    const producer = state.fieldLocations.get(location);
    if (!producer) return;
    if (!producer.record) {
      if ((state.fieldProjectionCount || 0) >= maximum) {
        consumerObservationBudget(state).reasons.add('field-projection-history-budget'); return;
      }
      producer.record = Object.freeze({ rule:'render-field-access', phase:'render',
        before:`memory:${producer.instruction.op}:${producer.instruction.id}`, after:structuralKey(producer.access),
        evidence:Object.freeze({ kind:'canonical-memory-access-projection', detail:'field spelling projects an existing memory access; a supplied field name is presentation metadata, not type or layout proof' }),
        originHistory:expressionOriginHistory({ source:mergeSource(origin(producer.instruction), producer.access.base?.source) }, producer.access),
      });
      (state.rewriteProof ??= []).push(producer.record);
      state.fieldProjectionCount = (state.fieldProjectionCount || 0) + 1;
    }
    records.add(producer.record);
    // Loads are leaves in the ordinary expression walker; an address can
    // itself contain a field load whose canonical origin must remain visible.
    pending.push(location.base);
  };
  collect(semantic.location);
  while (pending.length && seen.size < 4096) {
    const node = pending.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'load') collect(node.location);
    pending.push(...children(node));
  }
  if (pending.length) consumerObservationBudget(state).reasons.add('field-projection-traversal-budget');
  return [...records];
}

function containsExpression(root, expression) {
  const pending = [root], seen = new Set();
  while (pending.length && seen.size < 4096) {
    const node = pending.pop();
    if (node === expression) return true;
    if (!node || seen.has(node)) continue;
    seen.add(node); pending.push(...children(node));
  }
  return false;
}
function semanticExpressionConsumer(semantic, value, instruction, state, nested = false, rendered = null) {
  const produced = state.expressionProofs?.get(value?.id);
  const elisions = state.renderElisions?.get(instruction?.id);
  const fields = fieldProjectionRecords(semantic, state);
  const records = elisions?.length || fields.length || rendered?.records.length
    ? Object.freeze([...(produced?.records || []), ...(elisions || []), ...fields, ...(rendered?.records || [])]) : produced?.records;
  if (!records?.length) return semantic;
  if (!produced || (produced.expression !== semantic.expression
      && (!nested || !containsExpression(semantic.expression, produced.expression)))) {
    if (fields.length) consumerObservationBudget(state).reasons.add('field-projection-consumer-unavailable');
    return semantic;
  }
  return bindObservedExpressionConsumer(semantic, value, instruction, state, records, rendered);
}

function bindObservedExpressionConsumer(semantic, value, instruction, state, records, rendered = null) {
  if (!records?.length) return semantic;
  // Bound cumulative observation work for the function, not just each
  // individual graph: many consumers may share a large definition graph.
  const budget = consumerObservationBudget(state);
  if (budget.consumers <= 0 || budget.edges <= 0) {
    budget.reasons.add('binding-budget');
    return semantic;
  }
  budget.consumers--;
  try {
    const observation = captureProjectionIrData(
      [semantic.expression, records, value, instruction, semantic.location], state.opts?.shouldAbort);
    const remaining = budget.edges - observation.metrics.edges;
    budget.edges = Math.max(0, remaining);
    if (remaining < 0) {
      budget.reasons.add('binding-budget');
      return semantic;
    }
    if (!currentBuildHistory(records)) {
      budget.reasons.add('stale-expression-build-history'); return semantic;
    }
    if (rendered && !rendered.isCurrent()) {
      budget.reasons.add(rendered.reason ?? 'stale-store-render-history'); return semantic;
    }
    expressionHistoryConsumers.set(semantic, Object.freeze({
      ir:state.ir, expression:semantic.expression, op:semantic.op, instructionId:semantic.ir,
      location:semantic.location, records,
      isCurrent:() => observation.matches() && currentBuildHistory(records) && (!rendered || rendered.isCurrent()),
    }));
  } catch {
    // A failed bounded observation must not be retried for every later line.
    budget.edges = 0;
    budget.reasons.add('binding-observation-unavailable');
  }
  return semantic;
}

export function readExpressionHistoryConsumer(semantic, ir) {
  const binding = expressionHistoryConsumers.get(semantic);
  if (!binding || binding.ir !== ir) return null;
  const data = key => Object.getOwnPropertyDescriptor(semantic, key)?.value;
  if (data('expression') !== binding.expression || data('op') !== binding.op
      || data('ir') !== binding.instructionId || data('location') !== binding.location
      || !binding.isCurrent()) return null;
  return binding;
}

// A spelling transition needs the actual C AST node as well as the semantic
// expression consumer. Equal text, copied nodes or a public descriptor cannot
// establish which spelling this producer emitted.
export function readStoreSpellingProducer(node, ir) {
  const entry = storeSpellingProducers.get(node);
  return entry && entry.ir === ir && entry.observation.matches() && entry.consumer.isCurrent() ? entry : null;
}

function bindStoreSpelling(node, known, state) {
  if (!known?.storeSpelling || known.storeSpelling.form === 'assignment') return;
  const consumer = readExpressionHistoryConsumer(node.semantic, state.ir);
  if (!consumer) return;
  const budget = consumerObservationBudget(state);
  try {
    if (budget.edges <= 0) throw new Error('store-spelling-observation-budget');
    const observation = captureProjectionIrData([node], state.opts?.shouldAbort);
    budget.edges -= observation.metrics.edges;
    if (budget.edges < 0 || !consumer.isCurrent() || node.text !== known.text) throw new Error('store-spelling-observation-unavailable');
    storeSpellingProducers.set(node, Object.freeze({ ir:state.ir, consumer, observation,
      form:known.storeSpelling.form, text:known.text, valueId:known.storeSpelling.valueId,
    }));
  } catch { budget.edges = 0; budget.reasons.add('store-spelling-observation-unavailable'); }
}
function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}
function constNode(v, value = v?.const ?? 0n) { return expr.constant(value, v?.bits || 64, v?.signed ?? null, origin(v?.def, v)); }
function typeFor(state, v) { return state.types?.values?.get?.(v?.id) || null; }
function signedFor(state, v) { const t = typeFor(state, v); return t?.signed ?? v?.signed ?? null; }
function origin(inst, v = null, reason = null) {
  return sourceOf({ address: inst?.address ?? null, row: inst?.row ?? null, ir: inst?.id ?? null, ssaDef: v?.id ?? inst?.dst?.id ?? null,
    ssaUses: (inst?.args || []).map(valueOf).filter(Boolean).map((x) => x.id), evidence: reason ? [{ reason }] : [] });
}

function abiArgumentLocationsForState(state) {
  const functionPrototype = state.opts?.functionPrototype || state.opts?.prototype || state.prototype || null;
  try {
    const locations = state.opts?.abiAdapter?.argumentLocations?.({ functionPrototype });
    if (Array.isArray(locations)) return locations
      .filter((location) => location && typeof location.reg === 'string')
      .map((location, ordinal) => ({
        index:Number.isInteger(Number(location.index)) ? Number(location.index) : ordinal,
        reg:String(location.reg),
        abiClass:location.abiClass ?? null,
        aggregate:location.aggregate === true,
        pieceIndex:location.pieceIndex ?? null,
        pieces:location.pieces ?? null,
      }));
    const registers = state.opts?.abiAdapter?.argumentRegisters?.({ functionPrototype });
    return Array.isArray(registers) ? registers.map((reg, index) => ({ index, reg:String(reg), abiClass:null })) : [];
  } catch { return []; }
}

function abiArgumentLocationForRegister(state, reg) {
  const name = String(reg || '');
  return abiArgumentLocationsForState(state).find((location) => location.reg === name) || null;
}

function argumentName(v, state) {
  const groupId = state.highVariables?.valueToGroup?.get(v?.id);
  const group = state.highVariables?.groups?.find((g) => g.id === groupId);
  if (group?.name) return group.name;
  const reg = String(v?.reg || '');
  const location = abiArgumentLocationForRegister(state, reg);
  if (!location) return safeIdent(reg || `value_${v?.id}`);
  const index = location.index;
  if (index === 0 && (state.opts?.receiverType || state.opts?.methodKind === 'objc')) return 'self';
  return state.opts?.argNames?.[index] || `a${index + 1}`;
}

function encodedLocationIdentity(value) {
  return [...String(value ?? '')].map((char) => /[A-Za-z0-9]/.test(char)
    ? char
    : `_${char.codePointAt(0).toString(16).toUpperCase()}_`).join('');
}

function stackLocationName(loc, addr) {
  const key = typeof loc?.key === 'string' ? loc.key : '';
  const canonical = /^stack:([+-]?\d+)$/.exec(key);
  if (canonical) {
    const coordinate = BigInt(canonical[1]);
    if (coordinate === 0n) return 'local_0';
    const magnitude = (coordinate < 0n ? -coordinate : coordinate).toString(16).toUpperCase();
    return coordinate < 0n ? `local_m${magnitude}` : `local_p${magnitude}`;
  }
  // A malformed/noncanonical key must not collapse onto another slot merely
  // because their local displacements have the same absolute value. Encode the
  // full available identity losslessly enough for a stable C identifier.
  const fallbackIdentity = key || `disp:${String(loc?.disp ?? addr?.disp ?? 'unknown')}`;
  return `local_slot_${encodedLocationIdentity(fallbackIdentity) || 'unknown'}`;
}

function memoryLocation(inst, state) {
  const loc = inst?.loc || {};
  const addr = inst?.addr || {};
  if (loc.kind === 'stack') {
    const name = stackLocationName(loc, addr);
    return { kind: 'stack', key: loc.key, name, text: name };
  }
  if (loc.kind === 'global') {
    const name = state.opts?.symbolFor?.(loc.address);
    return { kind: 'global', key: loc.key, address: loc.address, name: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}`, text: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}` };
  }
  if (loc.kind === 'field') {
    const off = BigInt(loc.disp ?? addr.disp ?? 0);
    let known = null;
    try { known = state.opts?.fieldFor?.(addr.baseReg || loc.base?.reg || null, off, inst?.row) || null; } catch { known = null; }
    const base = buildValue(loc.base || addr.base, state, { forAddress: true });
    const name = safeIdent(known?.name || `field_${off.toString(16).toUpperCase()}`);
    const access = expr.field(base, name, off, Number(loc.size || inst?.size || 64), origin(inst));
    const location = { kind: 'field', key: loc.key, offset: off, base, name, expression: access, text: printExpression(access) };
    (state.fieldLocations ??= new Map()).set(location, { instruction:inst, access });
    return location;
  }
  if (addr.base && addr.index) {
    const base = buildValue(addr.base, state, { forAddress: true });
    const index = buildValue(addr.index, state, { forAddress: true });
    const scale = 1 << Number(addr.scale || 0);
    if (Number(addr.size || inst?.size || 0) === scale) {
      const access = expr.index(base, index, scale, Number(addr.size || inst?.size || 64), origin(inst));
      return { kind: 'index', key: loc.key, base, index, scale, expression: access, text: printExpression(access) };
    }
  }
  return { kind: 'unknown', key: loc.key || `memory:${inst?.id || '?'}`, name: 'memory_unknown', text: 'memory_unknown' };
}

function nzcvCondition(value, cond) {
  if (value == null) return null;
  const f = Number(value) & 15;
  const n=!!(f&8), z=!!(f&4), c=!!(f&2), v=!!(f&1);
  switch (cond) {
    case 'eq': return z; case 'ne': return !z;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return !c;
    case 'mi': return n; case 'pl': return !n; case 'vs': return v; case 'vc': return !v;
    case 'hi': return c && !z; case 'ls': return !c || z;
    case 'ge': return n === v; case 'lt': return n !== v;
    case 'gt': return !z && n === v; case 'le': return z || n !== v;
    case 'al': case 'nv': return true; default: return null;
  }
}

function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const selection = observeBuildSelection(flagValue, d, state, 'flag-condition');
  const expression = compareFromFlagsRaw(flagValue, cond, state);
  const observation = finishBuildSelection(expression, selection, state);
  if (observation) {
    const before = { source:mergeSource(origin(d, flagValue), ...(d.args || []).map(arg => {
      const value = valueOf(arg); return origin(value?.def, value);
    })) };
    const record = Object.freeze({ rule:'reconstruct-flag-condition', phase:'expression-build',
      before:`cmp:${d.sub || 'sub'}:${cond || 'flags'}`, after:`expression:${expression.kind}`,
      evidence:Object.freeze({ kind:'observed-flag-reconstruction-not-equivalence',
        detail:'actual existing NZCV/conditional-compare display construction and visited inputs; not an independent flag, scalar, path or CFG equivalence proof' }),
      originHistory:expressionOriginHistory(before, expression),
    });
    buildHistoryObservations.set(record, observation);
    (state.buildHistoryFrame.records ??= new Set()).add(record);
  }
  return expression;
}

function compareFromFlagsRaw(flagValue, cond, state) {
  const d = flagValue.def;
  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching (#356).
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), false, b.source);
  let normal;
  if (cond === 'al' || cond === 'nv') normal = expr.constant(1, 1, false, origin(d));
  else normal = buildNZCVConditionExpression(d.sub || 'sub', cond, a, b, Number(d.bits || a.bits || b.bits || 64), origin(d))
    || expr.intrinsic(`__arm64_nzcv_${d.sub || 'unknown'}_${cond || 'flags'}`, [a,b], 1, false, origin(d), { nzcvCondition:true });
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.extra?.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false, origin(d))
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}

function applyShift(base, shift) {
  if (!base || !shift?.op) return base;
  const bits = Number(base.bits || 64);
  const amount = expr.constant(BigInt(shift.amount || 0), bits, false, base.source);
  switch (shift.op) {
    case 'lsl': return expr.binary('shl', base, amount, bits, base.signed, base.source);
    case 'lsr': return expr.binary('lshr', base, amount, bits, false, base.source);
    case 'asr': return expr.binary('ashr', base, amount, bits, true, base.source);
    case 'uxtb': { const e=expr.unary('zext', expr.unary('trunc', base, 8, false, base.source), bits, false, base.source, { fromBits:8 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'uxth': { const e=expr.unary('zext', expr.unary('trunc', base, 16, false, base.source), bits, false, base.source, { fromBits:16 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'uxtw': { const e=expr.unary('zext', expr.unary('trunc', base, 32, false, base.source), bits, false, base.source, { fromBits:32 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'sxtb': { const e=expr.unary('sext', expr.unary('trunc', base, 8, true, base.source), bits, true, base.source, { fromBits:8 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    case 'sxth': { const e=expr.unary('sext', expr.unary('trunc', base, 16, true, base.source), bits, true, base.source, { fromBits:16 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    case 'sxtw': { const e=expr.unary('sext', expr.unary('trunc', base, 32, true, base.source), bits, true, base.source, { fromBits:32 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    default: return base;
  }
}

function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && out?.kind === 'const') {
    // Constants have no inherent signedness at the machine level. Canonicalize
    // every operand-width constant, even when the SSA constant already happens
    // to have that width, so cmp #0 and wzr are structurally identical.
    out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, false, out.source);
  } else if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}

function selectExpression(d, state) {
  const t = buildArg(d.args?.[0], state), f = buildArg(d.args?.[1], state), flags = valueOf(d.args?.[2]);
  const condition = compareFromFlags(flags, d.cond, state);
  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  // CINC/CINV/CNEG aliases carry one source. The operation applies when the
  // alias condition is true; treating them as ordinary CS* false arms reverses semantics.
  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits), t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));
  return expr.select(condition, t, f, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
}

function branchCondition(inst, state) {
  const kind = inst?.extra?.kind || inst?.sub || '';
  const v = valueOf(inst?.args?.[0]);
  if (kind === 'cbz' || kind === 'cbnz') return expr.compare(kind === 'cbz' ? 'eq' : 'ne', expressionFor(v, state), expr.constant(0, v?.bits || 64), null, origin(inst));
  if (kind === 'tbz' || kind === 'tbnz') {
    const value = expressionFor(v, state);
    const bit = Number(inst.extra?.bit ?? 0);
    if (bit === Number(v?.bits || value.bits || 64) - 1) return expr.compare(kind === 'tbz' ? 'ge' : 'lt', value, expr.constant(0, v?.bits || value.bits || 64, true), true, origin(inst));
    const tested = expr.binary('and', expr.binary('lshr', value, expr.constant(bit, value.bits || 64), value.bits || 64, false), expr.constant(1, value.bits || 64), value.bits || 64, false);
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', tested, expr.constant(0, value.bits || 64), false, origin(inst));
  }
  return compareFromFlags(valueOf(inst?.args?.at?.(-1)), inst?.cond || inst?.extra?.cond, state);
}

function semanticBranchCondition(inst, state) {
  const kind = inst.extra?.kind || inst.sub || '';
  const direct = ['cbz', 'cbnz', 'tbz', 'tbnz'].includes(kind);
  if (direct) {
    const e = branchCondition(inst, state);
    return semanticExpressionConsumer({ expression:e, text:printExpression(e), row:inst.row, address:inst.address, ir:inst.id },
      valueOf(inst.args?.[0]), inst, state, true);
  }
  // Flag reconstruction consumes buildArg rather than expressionFor. Keep its
  // actual visited frame, never borrow/overwrite an unrelated SSA value proof.
  const flags = valueOf(inst.args?.at?.(-1)), parent = state.buildHistoryFrame, frame = { records:null };
  const selected = flags?.def?.op === 'cmp'
    ? observeBuildSelection(flags, inst, state, 'flag-branch', [], false) : null;
  state.buildHistoryFrame = frame;
  try {
    const e = branchCondition(inst, state);
    const semantic = { expression:e, text:printExpression(e), row:inst.row, address:inst.address, ir:inst.id };
    const built = [...(frame.records || [])].map(record => valueHistoryRecord(record, null));
    (state.rewriteProof ??= []).push(...built);
    const records = Object.freeze([...built, ...fieldProjectionRecords(semantic, state)]);
    const observation = finishBuildSelection(e, selected, state);
    if (!observation) return semantic;
    return bindObservedExpressionConsumer(semantic, flags, inst, state, records,
      { isCurrent:observation.matches, reason:'stale-flag-branch-history' });
  } finally { state.buildHistoryFrame = parent; }
}

function buildValue(v, state, flags = {}) {
  // Follow only dependencies actually visited by this existing builder. A
  // matching expression pointer/source is not evidence that a consumer used a
  // collapsed phi: unrelated values can legitimately share the same AST node.
  const parent = state.buildHistoryFrame, frame = { records:null };
  const key = `${v?.id}:${flags.forAddress ? 'a' : 'v'}`;
  state.buildHistoryFrame = frame;
  try {
    const result = buildValueRaw(v, state, flags);
    const cached = state.buildHistories?.get(key);
    const records = frame.records ? Object.freeze([...frame.records]) : cached;
    if (records?.length) {
      if (state.expressionMemo.get(key) === result) (state.buildHistories ??= new Map()).set(key, records);
      if (parent) for (const record of records) (parent.records ??= new Set()).add(record);
    }
    return result;
  } finally { state.buildHistoryFrame = parent; }
}

function recordPhiCollapse(v, instruction, incoming, expression, state) {
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  if ((state.phiHistoryCount || 0) >= maximum) {
    consumerObservationBudget(state).reasons.add('phi-collapse-history-unavailable'); return;
  }
  const budget = consumerObservationBudget(state);
  let observation;
  try {
    if (budget.edges <= 0) throw new Error('phi-history-budget');
    // Observe the actual choice before polling a caller callback. A later
    // change cannot attach yesterday's selected input to today's phi edges.
    observation = captureProjectionIrData([instruction, incoming]);
    budget.edges = Math.max(-1, budget.edges - observation.metrics.edges);
    if (budget.edges < 0 || state.opts?.shouldAbort?.() || !observation.matches()) throw new Error('phi-history-unavailable');
  } catch {
    budget.edges = 0; budget.reasons.add('phi-collapse-observation-unavailable'); return;
  }
  const before = { source:mergeSource(origin(instruction, v), ...incoming.map(node => node?.source),
    ...(instruction.incoming || []).map(item => origin(item.value?.def, item.value))) };
  const record = Object.freeze({ rule:'collapse-equal-incoming-phi', phase:'expression-build',
    before:'phi:equal-incoming-expressions', after:`expression:${expression.kind}`,
    evidence:Object.freeze({ kind:'observed-phi-view-collapse-not-equivalence',
      detail:'actual legacy expression-builder selection; canonical phi/edges are retained, not independently proved eliminated' }),
    originHistory:expressionOriginHistory(before, expression),
  });
  buildHistoryObservations.set(record, observation);
  (state.buildHistoryFrame.records ??= new Set()).add(record);
  state.phiHistoryCount = (state.phiHistoryCount || 0) + 1;
}

function observeBuildSelection(value, instruction, state, kind = 'mov', related = [], reserve = true) {
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  const budget = consumerObservationBudget(state);
  if (reserve && (state.buildSelectionHistoryCount || 0) >= maximum) {
    budget.reasons.add(`${kind}-selection-history-budget`); return null;
  }
  // Reserve before recursive input construction; nested selections cannot all see
  // the same last free record. Failed observations never refill this budget.
  // A branch consumer only observes roots; the actual CMP producer reserves its
  // transform slot. Both observations still spend the shared edge budget.
  if (reserve) state.buildSelectionHistoryCount = (state.buildSelectionHistoryCount || 0) + 1;
  try {
    if (budget.edges <= 0) throw new Error('build-selection-observation-budget');
    const values = state.ir.values, valueIndex = values?.indexOf(value);
    const blocks = state.ir.blocks, flat = state.ir.instructions;
    const locations = [instruction, ...related].map(selected => {
      const block = blocks?.find(item => item.index === selected.block);
      const blockIndex = blocks?.indexOf(block), listKey = block?.phis?.includes(selected) ? 'phis' : 'insts';
      const instructions = block?.[listKey];
      const instructionIndex = instructions?.indexOf(selected), flatIndex = flat?.indexOf(selected);
      if (!(valueIndex >= 0) || !(instructionIndex >= 0) || flat != null && !(flatIndex >= 0)) throw new Error('build-definition-unavailable');
      return { selected, block, blockIndex, blockId:block.index, listKey, instructions, instructionIndex, flatIndex };
    });
    // Snapshot BEFORE buildArg can invoke an input's symbol/type callback.
    // Exact roots/positions bind the observed definition, not just its ID.
    const captured = captureProjectionIrData([value, instruction, ...related]);
    budget.edges -= captured.metrics.edges;
    if (budget.edges < 0) throw new Error('build-selection-observation-budget');
    const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
    return Object.freeze({ kind, matches:() => own(state.ir, 'values') === values && own(values, valueIndex) === value
      && own(state.ir, 'blocks') === blocks && own(state.ir, 'instructions') === flat
      && locations.every(({ selected, block, blockIndex, blockId, listKey, instructions, instructionIndex, flatIndex }) =>
        own(blocks, blockIndex) === block && own(block, 'index') === blockId
        && own(block, listKey) === instructions && own(instructions, instructionIndex) === selected
        && (flat == null || own(flat, flatIndex) === selected)) && captured.matches() });
  } catch {
    budget.edges = 0; budget.reasons.add(`${kind}-selection-observation-unavailable`); return null;
  }
}

function finishBuildSelection(expression, selection, state) {
  if (!selection) return null;
  const budget = consumerObservationBudget(state);
  let observation;
  try {
    if (budget.edges <= 0) throw new Error('build-selection-observation-budget');
    const output = captureProjectionIrData([expression]);
    budget.edges -= output.metrics.edges;
    if (budget.edges < 0 || state.opts?.shouldAbort?.() || !selection.matches() || !output.matches()) throw new Error('build-selection-unavailable');
    observation = Object.freeze({ matches:() => selection.matches() && output.matches() });
  } catch {
    budget.edges = 0; budget.reasons.add(`${selection.kind}-selection-observation-unavailable`); return null;
  }
  return observation;
}

function recordMovSelection(value, instruction, expression, selection, state, flags) {
  const observation = finishBuildSelection(expression, selection, state);
  if (!observation) return;
  const input = valueOf(instruction.args?.[0]);
  const before = { source:mergeSource(origin(instruction, value), origin(input?.def, input), expression.source) };
  const record = Object.freeze({ rule:'select-mov-operand', phase:'expression-build',
    before:`mov:${flags.forAddress ? 'address' : 'value'}`, after:`expression:${expression.kind}`,
    evidence:Object.freeze({ kind:'observed-mov-view-selection-not-equivalence',
      detail:'actual legacy builder operand selection including existing operand-width/shift views; canonical MOV and memory facts remain, not independently proved copy elimination or forwarding' }),
    originHistory:expressionOriginHistory(before, expression),
  });
  buildHistoryObservations.set(record, observation);
  (state.buildHistoryFrame.records ??= new Set()).add(record);
}

function recordAddressLoadSelection(value, instruction, store, expression, selection, state) {
  const observation = finishBuildSelection(expression, selection, state);
  if (!observation) return;
  const input = valueOf(store.args?.[0]);
  const before = { source:mergeSource(origin(instruction, value), origin(store), origin(input?.def, input), expression.source) };
  const record = Object.freeze({ rule:'select-address-load-store-operand', phase:'expression-build',
    before:'load:address-reaching-store', after:`expression:${expression.kind}`,
    evidence:Object.freeze({ kind:'observed-address-load-selection-not-memory-equivalence',
      detail:'actual legacy address-mode reachingStore operand selection; canonical load/store and unknown access qualifiers remain, not independent memory forwarding or alias proof' }),
    originHistory:expressionOriginHistory(before, expression),
  });
  buildHistoryObservations.set(record, observation);
  (state.buildHistoryFrame.records ??= new Set()).add(record);
}

function selectedValueOrigins(value, state) {
  const pending = [value], seen = new Set(), definitions = new Set(), sources = [], memoryChecks = [];
  const started = performance.now();
  let incomplete = false;
  while (pending.length && seen.size < 512) {
    if (performance.now() - started >= 250) { incomplete = true; break; }
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const definition = current.def;
    sources.push(origin(definition, current));
    if (!definition) continue;
    definitions.add(definition);
    pending.push(...(definition.args || []).map(valueOf), ...(definition.incoming || []).map(item => item.value),
      definition.addr?.base, definition.addr?.index, definition.loc?.base);
    if (definition.op === 'load') {
      const fact = definition.memoryForwarding;
      // The observed supplied constant/load origin needs no memory theorem.
      // Only an explicit exact-forwarding claim offers additional store roots;
      // absent/non-exact facts must not invent those roots or an upstream trace.
      if (fact?.status !== 'exact') continue;
      const isCurrent = () => isCanonicalExactMemoryForwarding(fact, canonicalMemoryForwardingContextForLoad(fact, definition,
        definition.memoryForwardingContext ?? definition.extra?.memoryForwardingContext));
      const width = Number(current.bits);
      if (!isCurrent() || current.constKind === 'float' || current.floatConst != null || current.float != null
        || current.const != null && (typeof current.const !== 'bigint' || !Number.isSafeInteger(width) || width <= 0 || width > 1024
          || current.const !== BigInt.asUintN(width, fact.value))) {
        incomplete = true; continue;
      }
      memoryChecks.push(isCurrent);
      // Only the existing proof issuer can supply store dependencies. A bare
      // reachingStore link is not a source certificate for a numeric constant.
      for (const id of fact.provenance.sourceEntityIds) {
        const matches = (state.ir.instructions || []).filter(inst => inst.semanticNodeId === id || inst.sourceEntityId === id);
        if (matches.length !== 1) { incomplete = true; continue; }
        const store = matches[0];
        definitions.add(store); sources.push(origin(store));
        pending.push(...(store.args || []).map(valueOf));
      }
    }
  }
  if (pending.length) incomplete = true;
  return { source:mergeSource(...sources), definitions:[...definitions], incomplete, memoryChecks };
}

function constantValueSelection(value, state, kind = 'precomputed') {
  // A literal has no selected-away computation. Other precomputed values do,
  // but this consumer must not invent which upstream folding passes ran.
  if (!value.def || value.def.op === 'const') return null;
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  if ((state.buildSelectionHistoryCount || 0) >= maximum || consumerObservationBudget(state).edges <= 0) {
    observeBuildSelection(value, value.def, state, kind); return null;
  }
  const origins = selectedValueOrigins(value, state);
  const observation = observeBuildSelection(value, value.def, state, kind,
    origins.definitions.filter(definition => definition !== value.def));
  if (origins.incomplete) consumerObservationBudget(state).reasons.add(`${kind}-source-history-incomplete`);
  return { origins, observation, kind };
}

function recordConstantValueSelection(value, expression, selected, state) {
  if (!selected) return;
  const observation = finishBuildSelection(expression, selected.observation, state);
  if (!observation) return;
  const history = expressionOriginHistory({ source:selected.origins.source }, expression);
  const canonicalLoad = selected.kind === 'canonical-load';
  const record = Object.freeze({ rule:canonicalLoad ? 'select-canonical-load-constant' : 'select-precomputed-value', phase:'expression-build',
    before:canonicalLoad ? 'load:canonical-numeric-forwarding' : `precomputed:${value.def.op}`, after:`expression:${expression.kind}`,
    evidence:Object.freeze({ kind:canonicalLoad ? 'observed-canonical-load-selection-not-new-memory-proof' : 'observed-precomputed-value-selection-not-equivalence',
      detail:canonicalLoad
        ? 'actual numeric constant selection admitted by the existing current canonical forwarding gate and its contributing sources; not an upstream pass trace or a new memory proof'
        : 'actual supplied constant selection and declared dependency sources; not an upstream folding trace, executed path, scalar equivalence or new memory proof' }),
    originHistory:selected.origins.incomplete ? Object.freeze({ ...history, truncated:true }) : history,
  });
  buildHistoryObservations.set(record, Object.freeze({ matches:() => observation.matches() && selected.origins.memoryChecks.every(current => current()) }));
  (state.buildHistoryFrame.records ??= new Set()).add(record);
}

function compatMemorySelection(value, state) {
  const instruction = value.def;
  const expected = projectedMemoryOperandTransitionExpected(state.ir, instruction);
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  // Do not repeatedly scan the sealed upstream graph after the downstream
  // cumulative observation/record allowance has already been exhausted.
  if (expected && ((state.buildSelectionHistoryCount || 0) >= maximum || consumerObservationBudget(state).edges <= 0)) {
    observeBuildSelection(value, instruction, state, 'compat-memory'); return null;
  }
  const transition = readProjectedMemoryOperandTransition(state.ir, instruction);
  if (!transition) {
    if (expected
      || instruction?.sub === 'memory-forward' || instruction?.extra?.originalMemoryOp === 'load') {
      consumerObservationBudget(state).reasons.add('compat-memory-transition-unavailable');
    }
    return null;
  }
  const related = [transition.store, transition.input.def, ...transition.beforeInputs.map(input => input.def)]
    .filter(instruction => instruction && instruction !== value.def);
  return { transition, observation:observeBuildSelection(value, instruction, state, 'compat-memory', [...new Set(related)]) };
}

function recordCompatMemorySelection(value, expression, selected, state) {
  if (!selected) return;
  const observation = finishBuildSelection(expression, selected.observation, state);
  if (!observation) return;
  const transition = selected.transition;
  if (!transition.isCurrent()) {
    consumerObservationBudget(state).reasons.add('compat-memory-transition-stale'); return;
  }
  const before = { source:mergeSource(origin(transition.source, value), origin(transition.store),
    origin(transition.input.def, transition.input), ...transition.beforeInputs.map(input => origin(input.def, input))) };
  const record = Object.freeze({ rule:'project-stack-load-to-operand', phase:'compatibility-projection',
    before:'load:canonical-stack-operand', after:'mov:memory-forward',
    evidence:Object.freeze({ kind:'observed-compat-memory-transition-not-new-proof',
      detail:'actual compatibility LOAD-to-MOV operation admitted by the existing canonical stack operand-identity query; original access and store sources retained, not a new memory theorem' }),
    originHistory:expressionOriginHistory(before, expression),
  });
  buildHistoryObservations.set(record, Object.freeze({ matches:() => observation.matches() && transition.isCurrent() }));
  (state.buildHistoryFrame.records ??= new Set()).add(record);
}

function compatConstantSelection(value, state) {
  const pending = [value.def], seen = new Set(), selected = [];
  const budget = consumerObservationBudget(state);
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  while (pending.length && seen.size < 512) {
    const source = pending.pop();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    if (!projectedConstantTransitionExpected(state.ir, source)) continue;
    if ((state.buildSelectionHistoryCount || 0) >= maximum || budget.edges <= 0) {
      observeBuildSelection(value, source, state, 'compat-constant'); return selected;
    }
    const transition = readProjectedConstantTransitions(state.ir, source);
    if (!transition) { budget.reasons.add('compat-constant-transition-unavailable'); continue; }
    for (const event of transition.events) {
      // Traverse actual recorded input definitions, not a guessed upstream pass
      // inferred from a supplied constant. Precomputed rendering need not visit
      // these expressions, but it still consumes their observed folding chain.
      pending.push(...event.inputs.map(input => input.definition));
      if ((state.buildSelectionHistoryCount || 0) >= maximum || budget.edges <= 0) {
        observeBuildSelection(value, source, state, 'compat-constant'); return selected;
      }
      const origins = event.op === 'load' ? selectedValueOrigins(event.output, state) : null;
      const related = [...new Set([...event.beforeInputs.map(input => input.def), ...(origins?.definitions || [])])]
        .filter(definition => definition && definition !== source);
      if (origins?.incomplete) budget.reasons.add('compat-constant-source-history-incomplete');
      selected.push({ event, transition, origins,
        observation:observeBuildSelection(value, source, state, 'compat-constant', related) });
    }
  }
  if (pending.length) budget.reasons.add('compat-constant-dependency-budget');
  return selected;
}

function recordCompatConstantSelection(value, expression, selected, state) {
  for (const { event, transition, origins, observation:selection } of selected) {
    const observation = finishBuildSelection(expression, selection, state);
    if (!observation) continue;
    if (!transition.isCurrent()) {
      consumerObservationBudget(state).reasons.add('compat-constant-transition-stale'); continue;
    }
    const source = mergeSource(origin(event.source, event.output), origin(value.def, value), origins?.source,
      ...event.beforeInputs.map(input => origin(input.def, input)));
    const history = expressionOriginHistory({ source }, expression);
    const record = Object.freeze({ rule:'fold-compatibility-constant', phase:'compatibility-projection',
      before:`${event.stage}:${event.round}:${event.ordinal}:${event.op}:${event.sub ?? ''}:${String(event.beforeConstant)}`,
      after:`constant:${event.bits}:${String(event.afterConstant)}`,
      evidence:Object.freeze({ kind:'observed-compat-constant-write-not-equivalence',
        detail:'actual compatibility constant write and its original input facts, retained through the consuming expression; not a new scalar or memory theorem' }),
      originHistory:origins?.incomplete ? Object.freeze({ ...history, truncated:true }) : history,
    });
    buildHistoryObservations.set(record, Object.freeze({ matches:() => observation.matches() && transition.isCurrent()
      && (origins?.memoryChecks || []).every(current => current()) }));
    (state.buildHistoryFrame.records ??= new Set()).add(record);
  }
}

function buildValueRaw(v, state, flags = {}) {
  if (!v) return expr.variable('unknown', 64, null);
  const memoKey = `${v.id}:${flags.forAddress ? 'a' : 'v'}`;
  if (state.expressionMemo.has(memoKey)) return state.expressionMemo.get(memoKey);
  if (state.expressionActive.has(v.id)) return expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(v.def, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  state.expressionActive.add(v.id);
  let out = null;
  const d = v.def;
  const compatSelection = compatMemorySelection(v, state);
  const compatConstants = compatConstantSelection(v, state);
  if (v.constKind === 'float' || v.floatConst != null || (v.float != null && v.const == null)) {
    const selected = constantValueSelection(v, state);
    out = expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v));
    recordConstantValueSelection(v, out, selected, state);
  }
  if (!out && v.const != null && d?.op !== 'addr') {
    const selected = constantValueSelection(v, state);
    out = constNode(v);
    recordConstantValueSelection(v, out, selected, state);
  }
  if (!out && (v.kind === 'arg' || !d)) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  if (!out && d) {
    if (d.op === 'const') out = (v.constKind === 'float' || v.floatConst != null || v.float != null)
      ? expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v))
      : constNode(v, v.const ?? d.extra?.value ?? 0n);
    else if (d.op === 'mov') {
      const selection = observeBuildSelection(v, d, state);
      out = buildArg(d.args?.[0], state, flags);
      recordMovSelection(v, d, out, selection, state, flags);
    }
    else if (d.op === 'bin') {
      const a = buildArg(d.args?.[0], state), b = d.args?.[1] ? buildArg(d.args[1], state) : expr.constant(0, v.bits || 64);
      if (d.sub === 'bic') out = expr.binary('and', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'orn') out = expr.binary('or', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'eon') out = expr.unary('not', expr.binary('xor', a, b, v.bits || 64, signedFor(state, v)), v.bits || 64, signedFor(state, v), origin(d, v));
      else out = expr.binary(d.sub, a, b, v.bits || 64, signedFor(state, v), origin(d, v));
      if (d.extra?.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'un') {
      const a = buildArg(d.args?.[0], state);
      const sub = String(d.sub || '');
      if (/^sxt/.test(sub)) out = expr.unary('sext', a, v.bits || 64, true, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else if (/^uxt/.test(sub)) out = expr.unary('zext', a, v.bits || 64, false, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else out = expr.unary(sub, a, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'mac') {
      const addend = buildArg(d.args?.[0], state);
      let a = buildArg(d.args?.[1], state), b = buildArg(d.args?.[2], state);
      if (d.extra?.widen === 'signed' || d.extra?.widen === 'unsigned') {
        const signed = d.extra.widen === 'signed';
        const op = signed ? 'sext' : 'zext';
        a = expr.unary(op, a, v.bits || 64, signed, origin(d, v), { fromBits:32 });
        b = expr.unary(op, b, v.bits || 64, signed, origin(d, v), { fromBits:32 });
      }
      const mult = expr.binary('mul', a, b, v.bits || 64, d.extra?.widen === 'unsigned' ? false : d.extra?.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {
      const src=buildArg(d.args?.[0], state), lsb=Number(d.extra?.lsb ?? 0), width=Math.max(1, Number(d.extra?.width ?? v.bits ?? 64)), bits=Number(v.bits || 64);
      if (d.extra?.toward === 'left') {
        const maskValue=(1n << BigInt(Math.min(width, bits))) - 1n;
        let inserted=expr.binary('shl', expr.binary('and', src, expr.constant(maskValue, bits, false), bits, false), expr.constant(lsb, bits, false), bits, false, origin(d,v));
        if (d.extra?.signed) { const fieldBits=Math.min(bits, lsb + width); inserted=expr.unary('sext', expr.unary('trunc', inserted, fieldBits, true, origin(d,v)), bits, true, origin(d,v), { fromBits:fieldBits }); }
        out=inserted;
      } else out=expr.intrinsic('bit_extract', [src, expr.constant(lsb,64), expr.constant(width,64)], bits, d.extra?.signed ?? d.signed ?? false, origin(d,v));
    } else if (d.op === 'bfi') {
      const old=buildArg(d.args?.[0], state), src=buildArg(d.args?.[1], state), lsb=Number(d.extra?.lsb ?? 0), width=Math.max(1,Number(d.extra?.width ?? 16)), bits=Number(v.bits || 64);
      if (d.extra?.bitfieldKind === 'bfxil') {
        const maskValue=(1n << BigInt(Math.min(width,bits))) - 1n;
        const extracted=expr.binary('and', expr.binary('lshr', src, expr.constant(lsb,bits,false), bits, false), expr.constant(maskValue,bits,false), bits, false);
        const cleared=expr.binary('and', old, expr.constant(BigInt.asUintN(bits, ~maskValue),bits,false), bits, false);
        out=expr.binary('or', cleared, extracted, bits, signedFor(state,v), origin(d,v));
      } else out=expr.intrinsic('bit_insert', [old,src,expr.constant(lsb,64),expr.constant(width,64)], bits, signedFor(state,v), origin(d,v));
    } else if (d.op === 'sel') out = selectExpression(d, state);
    else if (d.op === 'addr') {
      const address = v.const ?? d.extra?.value ?? d.extra?.target;
      const name = address != null ? state.opts?.symbolFor?.(address) : null;
      out = expr.variable(name ? safeIdent(name) : `global_${BigInt(address || 0).toString(16).toUpperCase()}`, 64, false, origin(d, v), { address });
    } else if (d.op === 'load') {
      const loc = memoryLocation(d, state);
      if (isCanonicalExactMemoryForwarding(d.memoryForwarding,
        canonicalMemoryForwardingContextForLoad(d.memoryForwarding, d,
          d.memoryForwardingContext ?? d.extra?.memoryForwardingContext))
        && d.memoryForwarding.value != null) {
        const selection = constantValueSelection(v, state, 'canonical-load');
        out = constNode(v, d.memoryForwarding.value);
        recordConstantValueSelection(v, out, selection, state);
      } else if (flags.forAddress && d.reachingStore && d.reachingStore !== d) {
        const store = d.reachingStore;
        const selection = observeBuildSelection(v, d, state, 'address-load', [store]);
        out = buildArg(store.args?.[0], state, flags);
        recordAddressLoadSelection(v, d, store, out, selection, state);
      } else {
        out = expr.load(loc, v.bits || Number((d.size || 8) * 8), origin(d, v), { signed: d.signed ?? signedFor(state, v), volatile: !!d.volatile });
      }
    } else if (d.op === 'call') {
      out = expr.variable(`call_${d.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { materializedCall: true });
    } else if (d.op === 'phi') {
      const incoming = (d.incoming || []).map((x) => buildValue(x.value, state));
      const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
      out = unique.size === 1 ? incoming[0] : expr.variable(`local_phi_${v.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { phi: true, incoming });
      if (unique.size === 1) recordPhiCollapse(v, d, incoming, out, state);
    }
  }
  if (!out) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  recordCompatMemorySelection(v, out, compatSelection, state);
  recordCompatConstantSelection(v, out, compatConstants, state);
  state.expressionActive.delete(v.id);
  state.expressionMemo.set(memoKey, out);
  return out;
}

function rewriteAll(state, budget) {
  const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: Math.max(4, Math.min(22, budget.timeBudgetMs / 2)), nodeBudget: Math.min(4096, budget.nodeBudget) });
  state.expressions = new Map();
  state.expressionProofs = new Map();
  state.rewriteProof = [];
  state.rewriteStats = { applications: 0, budgetExceeded: false, byRule: {} };
  for (const v of state.ir.values || []) {
    let root = buildValue(v, state);
    const idiomRecords = [];
    root = walkIdiom(root, state, idiomRecords);
    // `deterministicTransforms` is an opt-in measurement mode: it removes the
    // rewrite engine's wall-clock cutoff so the fixed point depends only on the
    // input and the rules. Work bounds still apply. Production leaves it unset.
    const r = engine.rewrite(root, { state, deterministicTransforms: state.opts?.deterministicTransforms === true });
    state.expressions.set(v.id, r.root);
    const built = state.buildHistories?.get(`${v.id}:v`) || [];
    const records = Object.freeze([...built, ...idiomRecords, ...r.proof].map(p => valueHistoryRecord(p, v.id)));
    state.rewriteProof.push(...records);
    state.expressionProofs.set(v.id, { expression:r.root, records });
    state.rewriteStats.applications += r.stats.applications;
    state.rewriteStats.budgetExceeded ||= r.stats.budgetExceeded;
    for (const [k, n] of Object.entries(r.stats.byRule)) state.rewriteStats.byRule[k] = (state.rewriteStats.byRule[k] || 0) + n;
  }
  // A truncated rewrite is a truncated result. Before this, `rewriteStats.budgetExceeded`
  // could be true while the pipeline still reported `degraded: false`, so a consumer
  // reading the pipeline's own completeness flag was told the output was complete
  // when it was not. Budget truncation is a completeness state, and it has to
  // propagate to the one place consumers look.
  if (state.rewriteStats.budgetExceeded) state.degraded = true;
  return state;
}

function walkIdiom(n, state, records) {
  if (!n) return n;
  const mapped = mapChildren(n, child => walkIdiom(child, state, records));
  const recovered = recoverArm64ClangIdiom(mapped);
  if (recovered !== mapped) {
    const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
    const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
    if ((state.idiomHistoryCount || 0) >= maximum || state.opts?.shouldAbort?.()) {
      consumerObservationBudget(state).reasons.add('idiom-history-unavailable');
    } else {
      // This is an observed legacy display transformation, not an independently
      // verified rewrite. Shape labels are descriptive, never semantic IDs or
      // equivalence certificates. The existing consumer owns the actual edge.
      records.push(Object.freeze({ rule:`recognize-${recovered.name}`, phase:'idiom',
        before:`${mapped.kind}:${mapped.op}`, after:`${recovered.kind}:${recovered.name}`,
        evidence:Object.freeze({ kind:'legacy-idiom-recognition-not-equivalence',
          detail:'actual existing recognizer application; no independent equivalence proof is claimed' }),
        originHistory:expressionOriginHistory(mapped, recovered),
      }));
      state.idiomHistoryCount = (state.idiomHistoryCount || 0) + 1;
    }
  }
  return recovered;
}

// Dominance walk shared by the reaching-definition queries. Prefer the
// precomputed dominator sets, then fall back to walking immediate dominators.
function defBlockDominates(ir, from, to) {
  if (from === to) return true;
  if (from == null || to == null) return false;
  const dom = ir.dominators?.[to];
  if (dom && typeof dom.has === 'function') return dom.has(from);
  let cur = to, guard = 0;
  while (cur != null && cur >= 0 && guard++ <= (ir.blocks?.length || 0) + 1) {
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
    if (cur === from) return true;
  }
  return false;
}

function blockCanReach(ir, from, to) {
  if (from === to) return true;
  if (from == null || to == null) return false;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const current = stack.pop();
    const successors = ir.blocks?.[current]?.succ ?? ir.blocks?.[current]?.successors ?? [];
    for (const edge of successors) {
      const next = edge && typeof edge === 'object' ? (edge.to ?? edge.block ?? edge.id) : edge;
      if (next == null || seen.has(next)) continue;
      if (next === to) return true;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

function defBlockDepth(ir, block) {
  let depth = 0, cur = block, guard = 0;
  while (cur != null && cur >= 0 && guard++ <= (ir.blocks?.length || 0) + 1) {
    depth++;
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
  }
  return depth;
}

function definitionCanReachUse(ir, definition, atInst) {
  if (definition.block === atInst.block) {
    return definition.row != null && atInst.row != null && definition.row < atInst.row;
  }
  return blockCanReach(ir, definition.block, atInst.block);
}

function definitionMayOverrideCandidate(ir, definition, candidateDefinition) {
  if (!candidateDefinition) return true;
  if (definition.block === candidateDefinition.block) {
    if (definition.row == null || candidateDefinition.row == null) return false;
    return definition.row > candidateDefinition.row;
  }
  return blockCanReach(ir, candidateDefinition.block, definition.block);
}

// CFG-aware reaching definition for a physical register. Same-block defs must
// precede the use; foreign-block defs qualify only when their block dominates
// the use. A branch-local write after the selected candidate makes the merge
// ambiguous unless a later same-block definition overwrites it on every path.
function reachingRegisterValue(ir, atInst, reg) {
  if (!ir || !atInst || !reg) return null;
  let best = ir.args?.get?.(reg) || null;
  let bestDepth = -1, bestRow = -Infinity, bestSameBlock = false;
  for (const v of ir.values || []) {
    if (v.reg !== reg || !v.def || v.clobbered) continue;
    const d = v.def;
    if (d === atInst) continue;
    if (d.block === atInst.block) {
      if (d.row == null || atInst.row == null || d.row >= atInst.row) continue;
      if (!bestSameBlock || d.row > bestRow) {
        best = v;
        bestRow = d.row;
        bestSameBlock = true;
      }
      continue;
    }
    if (bestSameBlock || !defBlockDominates(ir, d.block, atInst.block)) continue;
    const depth = defBlockDepth(ir, d.block);
    if (depth > bestDepth || (depth === bestDepth && (d.row ?? -Infinity) > bestRow)) {
      best = v;
      bestDepth = depth;
      bestRow = d.row ?? -Infinity;
    }
  }
  if (bestSameBlock) return best;

  const candidateDefinition = best?.def ?? null;
  for (const v of ir.values || []) {
    if (v === best || v.reg !== reg || !v.def || v.clobbered) continue;
    const d = v.def;
    if (d === atInst || !definitionCanReachUse(ir, d, atInst)) continue;
    if (definitionMayOverrideCandidate(ir, d, candidateDefinition)) return null;
  }
  return best;
}

function expressionFor(v, state) {
  const existing = state.expressions?.get(v?.id);
  if (existing) return existing;
  // The mandatory representation fallback also executes the recognizer when
  // optional passes did not run. Retain those actual events and their current
  // consumer instead of treating a degraded pipeline as history-free.
  const history = [], root = walkIdiom(buildValue(v, state), state, history);
  const built = state.buildHistories?.get(`${v?.id}:v`) || [];
  const records = Object.freeze([...built, ...history].map(record => valueHistoryRecord(record, v?.id ?? null)));
  (state.rewriteProof ??= []).push(...records);
  (state.expressionProofs ??= new Map()).set(v?.id, { expression:root, records });
  return root;
}
// A read-modify-write claim is only sound when the selected operator operand is
// directly the load of the canonical location being overwritten. A nested load
// proves only a dependency, not that the outer operator is a compound update.
function readsSameLocation(node, location, key = location?.key) {
  return !!node && key != null && node.kind === 'load' && node.location?.key === key;
}
function sameLocationRmwOperand(expression, location, ops, side = 'any') {
  if (side === 'left') return readsSameLocation(expression.left, location) ? expression.right : null;
  if (readsSameLocation(expression.left, location)) return expression.right;
  if (readsSameLocation(expression.right, location)) return expression.left;
  return null;
}
function returnRegisterForState(state) {
  const type=String(state.opts?.returnType || state.opts?.functionPrototype?.returnType || state.opts?.prototype?.returnType || state.prototype?.returnType || '').toLowerCase();
  if (!type || type === 'void') return null;
  try {
    return state.opts?.abiAdapter?.returnRegister?.({
      returnType:type,
      functionPrototype:state.opts?.functionPrototype || state.opts?.prototype || state.prototype || null,
    }) ?? null;
  } catch { return null; }
}
function returnValueAt(inst, state) {
  const explicit=valueOf(inst?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForState(state);
  return reg ? reachingRegisterValue(state.ir, inst, reg) : null;
}

function semanticFacts(state, result) {
  const facts = { inputs: [], outputs: [], stores: [], calls: [], conditions: [], evidence: [], warnings: [] };
  const abiArgumentRegisters = new Set(abiArgumentLocationsForState(state).map((location) => location.reg));
  for (const [reg, v] of state.ir.args || []) {
    if (abiArgumentRegisters.has(String(reg)) && (v.uses || []).length) facts.inputs.push({ name: argumentName(v, state), reg, type: typeFor(state, v), valueId: v.id });
  }
  for (const inst of state.ir.instructions || []) {
    if (inst.op === 'store') {
      const location = memoryLocation(inst, state), value = valueOf(inst.args?.[0]), expression = expressionFor(value, state);
      const store = { location, lhsText: location.text, expression, source: origin(inst, inst.dst, 'Memory SSA store') };
      const clampSub = expression?.kind === 'intrinsic' && expression.name === 'max' && expression.args?.[1]?.kind === 'const' && expression.args[1].value === 0n && expression.args[0]?.kind === 'binary' && expression.args[0].op === 'sub' ? expression.args[0] : null;
      const clampOperand = clampSub && readsSameLocation(clampSub.left, location) ? clampSub.right : null;
      if (clampOperand != null) {
        store.readModifyWrite = { kind: 'clamp-zero-sub', operand: printExpression(clampOperand) };
      } else if (expression?.kind === 'binary' && expression.op === 'add') {
        const operand = sameLocationRmwOperand(expression, location, ['add']);
        if (operand != null) store.readModifyWrite = { kind: 'add', operand: printExpression(operand) };
      }
      facts.stores.push(store); facts.outputs.push({ name: location.text, type: state.types?.locations?.get?.(inst.loc?.key) || null });
      facts.evidence.push({ row: inst.row, address: inst.address, ir: inst.id, reason: 'Memory SSA store' });
    } else if (inst.op === 'call') {
      const modelCall = (state.model.calls || []).find((c) => c.row === inst.row) || null;
      const name = modelCall?.name || inst.extra?.name || (inst.extra?.target != null ? state.opts?.symbolFor?.(inst.extra.target) : null) || 'unknown_call';
      const runtime = /objc_msgSend/.test(name) ? 'objc' : /^_?swift_/.test(name) ? 'swift' : null;
      facts.calls.push({ name, runtime, row: inst.row, address: inst.address, ir: inst.id });
    } else if (inst.op === 'cbr') {
      facts.conditions.push(semanticBranchCondition(inst, state));
    } else if (inst.op === 'ret') {
      const rv = returnValueAt(inst, state);
      if (rv) facts.outputs.push({ name: 'return', type: typeFor(state, rv), expression: expressionFor(rv, state) });
    }
  }
  facts.warnings.push(...(result.warnings || []));
  return facts;
}

function valueDependsOnAny(value, targetValueIds, active = new Set()) {
  if (!value || active.has(value.id)) return false;
  if (targetValueIds.has(value.id)) return true;
  active.add(value.id);
  const def = value.def;
  if (!def) { active.delete(value.id); return false; }
  const inputs = [
    ...(def.args || []).map((arg) => arg?.value).filter(Boolean),
    ...(def.incoming || []).map((item) => item?.value).filter(Boolean),
  ];
  const result = inputs.some((input) => valueDependsOnAny(input, targetValueIds, active));
  active.delete(value.id);
  return result;
}

/*
 * Hide only a stack slot proven to be machine-level return preservation across
 * a call. MemorySSA must identify one exact store and one exact reaching load;
 * that load must feed the function return, and no call argument may depend on
 * the spill address base. This keeps ordinary locals/address-taken slots
 * visible while avoiding an invalid duplicate `var_* = expr; return expr;`.
 */
function isElidableReturnSpillStore(store, state) {
  if (!store || store.op !== 'store' || store.loc?.kind !== 'stack' || !store.loc?.key) return false;
  const instructions = state.ir?.instructions || [];
  const sameLocationMemory = instructions.filter((inst) =>
    (inst.op === 'load' || inst.op === 'store') && inst.loc?.key === store.loc.key);
  const storeDefinitionId = store.memDef?.definitionId ?? store.extra?.memoryDefinitionId ?? null;
  const loads = sameLocationMemory.filter((inst) => {
    if (inst.op !== 'load') return false;
    if (inst.reachingStore === store) return true;
    if (!isCanonicalExactMemoryForwarding(inst.memoryForwarding,
      canonicalMemoryForwardingContextForLoad(inst.memoryForwarding, inst,
        inst.memoryForwardingContext ?? inst.extra?.memoryForwardingContext))) return false;
    return storeDefinitionId != null
      && inst.memoryForwarding.contributingDefinitionIds.includes(String(storeDefinitionId));
  });
  if (loads.length !== 1 || sameLocationMemory.some((inst) => inst.op === 'store' && inst !== store)) return false;
  const load = loads[0];
  if (store.row == null || load.row == null || Number(load.row) <= Number(store.row) || !load.dst) return false;

  const calls = instructions.filter((inst) => inst.op === 'call' && inst.row != null
    && Number(inst.row) > Number(store.row) && Number(inst.row) < Number(load.row));
  if (!calls.length) return false;

  const addressBaseId = store.addr?.base?.id ?? null;
  if (addressBaseId != null) {
    const addressBase = new Set([addressBaseId]);
    if (calls.some((call) => (call.args || []).some((arg) => valueDependsOnAny(arg?.value, addressBase)))) return false;
  }

  const loadIds = new Set([load.dst.id]);
  const storedValue = valueOf(store.args?.[0]);
  if (!storedValue) return false;
  const storedKey = structuralKey(expressionFor(storedValue, state));
  if (!storedKey) return false;

  for (const ret of instructions) {
    if (ret.op !== 'ret' || ret.row == null || Number(ret.row) <= Number(load.row)) continue;
    const returned = returnValueAt(ret, state);
    if (!returned || !valueDependsOnAny(returned, loadIds)) continue;
    if (structuralKey(expressionFor(returned, state)) === storedKey) return { ret, returned, load, storedValue };
  }
  return false;
}

function compoundStoreHistory(instruction, value, expression, location, form, state) {
  const budget = consumerObservationBudget(state);
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  if ((state.compoundStoreHistoryCount || 0) >= maximum) {
    budget.reasons.add('compound-store-history-budget'); return null;
  }
  // This is the actual text-rendering branch, not the readModifyWrite analysis
  // fact or a memory-equivalence proof. The repeated load and the arithmetic
  // remain semantic inputs even when their spelling is implicit in ++ or +=.
  const source = mergeSource(origin(instruction, value), expression.source,
    location.expression?.source, location.base?.source, location.index?.source);
  const record = Object.freeze({ rule:'render-compound-store', phase:'render', valueId:value?.id ?? null,
    before:'store:assignment', after:`store:${form}`,
    evidence:Object.freeze({ kind:'observed-store-spelling-not-memory-equivalence',
      detail:'actual C AST store spelling; no atomicity, alias, overflow or memory-equivalence proof is issued' }),
    originHistory:expressionOriginHistory({ source }, { source }),
  });
  (state.rewriteProof ??= []).push(record);
  state.compoundStoreHistoryCount = (state.compoundStoreHistoryCount || 0) + 1;
  const ir = state.ir, instructions = ir.instructions, position = instructions.indexOf(instruction);
  let observation = null;
  try {
    if (budget.edges <= 0 || position < 0) throw new Error('store-render-observation-budget');
    // Observe the selected inputs before invoking a caller's abort hook. A
    // callback must not bind yesterday's spelling to today's changed operands.
    observation = captureProjectionIrData([instruction, value, expression, location]);
    budget.edges -= observation.metrics.edges;
    if (budget.edges < 0 || state.opts?.shouldAbort?.() || !observation.matches()) throw new Error('store-render-observation-unavailable');
  } catch {
    observation = null; budget.edges = 0; budget.reasons.add('compound-store-observation-unavailable');
  }
  return { records:Object.freeze([record]), isCurrent:() => Object.getOwnPropertyDescriptor(ir, 'instructions')?.value === instructions
    && Object.getOwnPropertyDescriptor(instructions, position)?.value === instruction && observation?.matches() === true };
}

function initialStoreExpansion(initialStore, instruction, value, expression, location, state) {
  const requested = state.opts?.renderProvenanceBudget?.maxTransformRecords;
  const maximum = Number.isSafeInteger(requested) && requested >= 0 ? Math.min(requested, 1024) : 1024;
  if ((state.initialStoreExpansionCount || 0) >= maximum) {
    consumerObservationBudget(state).reasons.add('initial-store-expansion-history-budget'); return [];
  }
  const source = mergeSource(initialStore.records[0].originHistory.after, origin(instruction, value), expression.source,
    location.expression?.source, location.base?.source, location.index?.source);
  const record = Object.freeze({ rule:'expand-initial-store-spelling', phase:'c-ast-render', valueId:value?.id ?? null,
    before:`store:${initialStore.spelling.form}`, after:'store:assignment',
    evidence:Object.freeze({ kind:'observed-store-spelling-not-memory-equivalence',
      detail:'actual owned initial-line to C AST assignment transition; no memory equivalence proof' }),
    originHistory:expressionOriginHistory({ source }, { source }),
  });
  (state.rewriteProof ??= []).push(record);
  state.initialStoreExpansionCount = (state.initialStoreExpansionCount || 0) + 1;
  return [record];
}

function knownStatementForLine(line, state, lineIndex, initialStore = null) {
  if (line?.row == null || line.kind !== 'stmt') return null;
  const insts = (state.ir.instructions || []).filter((i) => i.row === line.row);
  const store = insts.find((i) => i.op === 'store');
  if (store) {
    const elision = isElidableReturnSpillStore(store, state);
    if (elision) {
      const hasVisibleStatement = String(line.text || '').trim().length > 0;
      const maximum = Number.isSafeInteger(state.opts?.renderProvenanceBudget?.maxTransformRecords)
        ? Math.max(0, Math.min(1024, state.opts.renderProvenanceBudget.maxTransformRecords)) : 1024;
      if (hasVisibleStatement && (state.renderElisionCount || 0) < maximum) {
        const expression = expressionFor(elision.returned, state);
        const record = Object.freeze({ rule:'suppress-return-spill-statement', phase:'render',
          evidence:Object.freeze({ kind:'memoryssa-return-spill', detail:'existing C AST producer suppressed this return-preservation spill statement' }),
          originHistory:expressionOriginHistory({ source:mergeSource(line.source, origin(store, elision.storedValue), origin(elision.load)) }, expression),
          renderedRemoval:Object.freeze({ scope:'pre-transform-render', operation:'suppress', lineIndex, kind:line.kind || 'null' }),
        });
        state.renderElisions ??= new Map();
        const records = state.renderElisions.get(elision.ret.id) || [];
        state.renderElisions.set(elision.ret.id, [...records, record]);
        (state.rewriteProof ??= []).push(record);
        state.renderElisionCount = (state.renderElisionCount || 0) + 1;
      } else if (hasVisibleStatement) {
        state.expressionBindingBudget ??= { consumers:0, edges:0, reasons:new Set() };
        state.expressionBindingBudget.reasons.add('render-removal-history-budget');
      }
      return {
        text:'',
        semantic:{ op:'elided-return-spill', ir:store.id },
        source:sourceOf({ ir:store.id, value:valueOf(store.args?.[0]), reason:'memoryssa-return-spill' }),
      };
    }
    const location = memoryLocation(store, state), value = valueOf(store.args?.[0]), e = expressionFor(value, state);
    let text = `${location.text} = ${printExpression(e)};`, rendered = null, form = 'assignment';
    if (e?.kind === 'binary' && ['add','sub','mul'].includes(e.op) && e.left?.kind === 'load' && e.left.location?.key === location.key) {
      const rhs = printExpression(e.right);
      if (e.op === 'add' && e.right?.kind === 'const' && e.right.value === 1n) { text = `${location.text}++;`; form = 'post-increment'; }
      else if (e.op === 'sub' && e.right?.kind === 'const' && e.right.value === 1n) { text = `${location.text}--;`; form = 'post-decrement'; }
      else { text = `${location.text} ${{add:'+=',sub:'-=',mul:'*='}[e.op]} ${rhs};`; form = `${e.op}-assignment`; }
      rendered = compoundStoreHistory(store, value, e, location, form, state);
    }
    if (initialStore?.instruction === store) {
      const current = rendered;
      const expanded = form === 'assignment' && initialStore.spelling.text !== text
        ? initialStoreExpansion(initialStore, store, value, e, location, state) : [];
      rendered = { records:Object.freeze([...(current?.records || []), ...initialStore.records, ...expanded]),
        isCurrent:() => (!current || current.isCurrent()) && initialStore.isCurrent() };
    }
    return { text, semantic: semanticExpressionConsumer({ op: 'store', location, expression: e, ir: store.id }, value, store, state, false, rendered),
      source: mergeSource(line.source, e?.source, origin(store, store.dst)), storeSpelling:{ form, valueId:value?.id ?? null } };
  }
  const ret = insts.find((i) => i.op === 'ret');
  if (ret && /^return\b/.test(String(line.text || ''))) {
    const rv = returnValueAt(ret, state);
    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: semanticExpressionConsumer({ op: 'return', expression: e, ir: ret.id }, rv, ret, state), source: mergeSource(line.source, e?.source, origin(ret, rv)) }; }
  }
  return null;
}

function cAstFromLines(result, state) {
  const body = [];
  const initialStores = readSemanticStoreRenderHistory(result);
  if (initialStores) {
    state.rewriteProof.push(...initialStores.records);
    for (const reason of initialStores.reasons) consumerObservationBudget(state).reasons.add(reason);
  } else if (result.semanticStoreRenderHistory) consumerObservationBudget(state).reasons.add('initial-store-history-unavailable');
  const switchHistory = readSwitchRenderHistory(result);
  if (switchHistory) {
    state.rewriteProof.push(...switchHistory.records);
    for (const reason of switchHistory.reasons) consumerObservationBudget(state).reasons.add(reason);
  } else if (result.switchRenderHistory) consumerObservationBudget(state).reasons.add('switch-history-unavailable');
  for (const line of result.lines || []) {
    const initialStore = initialStores && readSemanticStoreLineHistory(line, state.ir);
    const known = knownStatementForLine(line, state, body.length, initialStore);
    const carried = line.source || { address: line.addr, row: line.row };
    const source = known?.source || sourceOf({
      ...carried,
      evidence: [...(carried.evidence || []), ...(line.note ? [{ reason: line.note }] : [])],
    });
    let semantic = known?.semantic || null;
    const switched = switchHistory && readSwitchLineHistory(line, state.ir);
    if (switched && !known) semantic = { op:'switch-render', expression:null, ir:null };
    const node = { kind: line.kind || 'raw', indent: line.indent || 0, text: known?.text ?? line.text ?? '', source, semantic };
    bindStoreSpelling(node, known, state);
    if (switched && !known) {
      const budget = consumerObservationBudget(state);
      try {
        if (budget.consumers <= 0 || budget.edges <= 0) throw new Error('switch-consumer-budget');
        budget.consumers--;
        const observation = captureProjectionIrData([node], state.opts?.shouldAbort);
        budget.edges -= observation.metrics.edges;
        if (budget.edges < 0) throw new Error('switch-consumer-budget');
        expressionHistoryConsumers.set(semantic, Object.freeze({ ...switched,
          expression:null, op:semantic.op, instructionId:null, location:undefined,
          isCurrent:() => switched.isCurrent() && observation.matches(),
        }));
      } catch { budget.edges = 0; budget.reasons.add('switch-consumer-unavailable'); }
    }
    body.push(node);
  }
  return { kind: 'CProgram', body, source: mergeSource(...body.map((x) => x.source)) };
}

function semanticAstOf(state, facts) {
  return {
    kind: 'SemanticFunction',
    values: [...state.expressions.entries()].map(([valueId, expression]) => ({ kind: 'SemanticValue', valueId, expression, type: state.types?.values?.get?.(valueId) || null, source: expression.source })),
    stores: facts.stores.map((s) => ({ kind: 'SemanticStore', ...s })),
    calls: facts.calls.map((c) => ({ kind: 'SemanticCall', ...c })),
    conditions: facts.conditions.map((c) => {
      const condition = { kind:'SemanticCondition', ...c };
      const binding = readExpressionHistoryConsumer(c, state.ir);
      if (binding) expressionHistoryConsumers.set(condition, binding);
      return condition;
    }),
    inputs: facts.inputs,
    outputs: facts.outputs,
  };
}

function metricsOf(result, state, printed) {
  const text = printed.text;
  const exprMetrics = [...state.expressions.values()].map(expressionReadability);
  return {
    rawAssemblyFallbacks: (text.match(/__asm\(/g) || []).length,
    gotos: (text.match(/\bgoto\b/g) || []).length,
    temporaries: (text.match(/\b(?:v|tmp|call_)\d+\b/g) || []).length,
    redundantCasts: exprMetrics.reduce((a, x) => a + x.casts, 0),
    rewrittenExpressions: state.rewriteStats?.applications || 0,
    rewriteBudgetExceeded: !!state.rewriteStats?.budgetExceeded,
    structured: result.coverage?.mode === 'structured',
    sourceMappedNodes: printed.mapping.length,
    passElapsedMs: state.passElapsedMs || 0,
  };
}

/**
 * The weakest completeness any stage of the pipeline reached.
 *
 * `complete` here means every stage ran to its own fixed point. `partial` means
 * at least one stage stopped early — the output is still valid, but it is not
 * the canonical output for this input and must not be compared as if it were.
 */
function pipelineCompleteness(state) {
  if (state.degraded) return 'partial';
  if (state.rewriteStats?.budgetExceeded) return 'partial';
  if (state.passDeadlineExceeded) return 'partial';
  const ledger = state.phase8;
  if (ledger && (!ledger.published || ledger.completeness !== 'complete')) return 'partial';
  return 'complete';
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  if (!result?.semantic || !result.ir) return result;
  const state = {
    ir: result.ir, model, opts, types: result.types || null,
    expressionMemo: new Map(), expressionActive: new Set(),
    warnings: [],
  };
  // Phase 8 runs as its own stage with its own declared budget, before the
  // representation passes. It observes canonical semantic facts and publishes a
  // frozen ledger or publishes nothing; it never mutates `state` beyond
  // attaching that ledger. Keeping it out of the PassManager deadline is not a
  // detail: sharing the rewrite allowance measurably changed the rewrite fixed
  // point on budget-saturated functions, which would make a no-op stage a
  // quality regression (P8-1 substrate contract).
  // Optimizer stages are opt-in. The interactive path publishes canonical facts
  // only; a caller that wants constants, ranges and the rest asks for them and
  // gets a budget sized for the work rather than an interactive allowance that
  // would make publication depend on how fast the machine is that day.
  const phase8Optimize = opts.phase8Optimize === true;
  const phase8Budget = {
    stages: phase8Optimize ? PHASE8_ALL_STAGES : PHASE8_INTERACTIVE_STAGES,
    ...(opts.phase8TimeBudgetMs != null ? { timeBudgetMs: Number(opts.phase8TimeBudgetMs) } : {}),
    ...(opts.phase8WorkBudget != null ? { maxWorkItems: opts.phase8WorkBudget } : {}),
    shouldAbort: opts.shouldAbort,
  };
  const phase8 = runPhase8Stage(
    { ir: state.ir, types: state.types, opts },
    phase8Budget,
  );
  state.phase8 = phase8.ledger;
  state.phase8Timings = phase8.timings;
  state.phase8ElapsedMs = phase8.elapsedMs;

  const manager = new PassManager([
    { name: 'high-variable-recovery', run(s) { s.highVariables = recoverHighVariables(s.ir, s.types, opts); return s; } },
    { name: 'prototype-recovery', run(s) { s.prototype = recoverFunctionPrototype(s.ir, s.types, opts); return s; } },
    { name: 'aggregate-layout-recovery', run(s) { s.aggregateLayouts = recoverAggregateLayouts(s.ir, s.types, opts); return s; } },
    { name: 'canonical-expression-build', run(s) { for (const v of s.ir.values || []) buildValue(v, s); return s; } },
    { name: 'semantic-rewrite', run: rewriteAll },
    { name: 'semantic-facts', run(s) { s.facts = semanticFacts(s, result); return s; } },
    { name: 'typed-semantic-ast', run(s) { s.semanticAst = semanticAstOf(s, s.facts); return s; } },
    { name: 'c-ast', run(s) { s.cAst = cAstFromLines(result, s); return s; } },
    { name: 'pretty-print', run(s) { s.printed = printProgram(s.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 }); return s; } },
  ], { timeBudgetMs: Number(opts.decompilerTimeBudgetMs || 250), nodeBudget: Number(opts.decompilerNodeBudget || 12000), maxIterations: Number(opts.decompilerIterationCap || 16) });
  const advanced = manager.run(state);
  // Budgets are a degradation boundary, not a validity boundary. If a large function
  // exhausts the optional pass budget, finish the mandatory representation layers
  // once without additional fixed-point work so callers always receive a coherent AST.
  advanced.expressions ||= new Map([...advanced.expressionMemo.entries()]
    .filter(([key]) => String(key).endsWith(':v'))
    .map(([key, value]) => [Number(String(key).split(':')[0]), value]));
  advanced.rewriteProof ||= [];
  advanced.rewriteStats ||= { iterations: 0, applications: 0, budgetExceeded: true, elapsedMs: 0, byRule: {} };
  advanced.highVariables ||= recoverHighVariables(advanced.ir, advanced.types, opts);
  advanced.prototype ||= recoverFunctionPrototype(advanced.ir, advanced.types, opts);
  advanced.aggregateLayouts ||= recoverAggregateLayouts(advanced.ir, advanced.types, opts);
  advanced.facts ||= semanticFacts(advanced, result);
  advanced.semanticAst ||= semanticAstOf(advanced, advanced.facts);
  advanced.cAst ||= cAstFromLines(result, advanced);
  advanced.printed ||= printProgram(advanced.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
  const explanation = explainSemanticFacts(advanced.facts, result.summary);
  const lines = advanced.cAst.body.map((n) => ({ kind: n.kind, indent: n.indent, text: n.text, row: n.source.rows[0] ?? null, addr: n.source.addresses[0] ?? null, note: null, source: n.source }));
  return {
    ...result,
    lines,
    pseudocode: advanced.printed.text,
    semanticAst: advanced.semanticAst,
    cAst: advanced.cAst,
    semanticFacts: advanced.facts,
    sourceMap: advanced.printed.mapping,
    highVariables: advanced.highVariables,
    prototype: advanced.prototype,
    aggregateLayouts: advanced.aggregateLayouts,
    rewriteProof: advanced.rewriteProof,
    expressionHistoryBinding:Object.freeze({
      scope:'producer-consumer-observations',
      completeness:advanced.expressionBindingBudget?.reasons.size ? 'incomplete' : 'complete',
      reasons:Object.freeze([...(advanced.expressionBindingBudget?.reasons ?? [])]),
    }),
    rewriteStats: advanced.rewriteStats,
    passMetrics: advanced.passMetrics,
    // Phase 8's frozen ledger. It is published or withheld as a whole; a missing
    // ledger is an explicit unknown, never an implied "nothing to optimize".
    phase8: advanced.phase8 ?? null,
    summary: explanation.summary,
    importantInputs: explanation.importantInputs,
    importantOutputs: explanation.importantOutputs,
    sideEffects: explanation.sideEffects,
    conditions: explanation.conditions,
    evidence: [...(result.evidence || []), ...(advanced.facts?.evidence || [])],
    warnings: [...new Set([...(result.warnings || []), ...(advanced.warnings || []), ...(advanced.rewriteStats?.budgetExceeded ? ['Decompiler rewrite budget reached; output was conservatively degraded.'] : [])])],
    metrics: metricsOf(result, advanced, advanced.printed),
    ctx: { ...(result.ctx || {}), decompilerPipeline: {
      phases: advanced.passMetrics,
      degraded: !!advanced.degraded,
      // One completeness answer, weakest-wins across every source that can
      // truncate: the pass deadline, the rewrite budget, and Phase 8's own
      // ledger. Separate flags that disagree are how a consumer ends up
      // trusting an incomplete result.
      completeness: pipelineCompleteness(advanced),
      rewriteStats: advanced.rewriteStats,
      phase8: advanced.phase8 ?? null,
      phase8Timings: advanced.phase8Timings ?? null,
      phase8ElapsedMs: advanced.phase8ElapsedMs ?? null,
    } },
  };
}

export function buildExpressionForTesting(value, state) {
  const s = { expressionMemo: new Map(), expressionActive: new Set(), opts: {}, types: { values: new Map() }, highVariables: null, ...state };
  return buildValue(value, s);
}

export function reachingRegisterValueForTesting(ir, atInst, reg) {
  return reachingRegisterValue(ir, atInst, reg);
}

export function directSameLocationLoadForTesting(node, location) {
  return readsSameLocation(node, location);
}
