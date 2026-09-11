import { OP, MK } from '../ir.js';
import { isExactOperandForwardMove } from './semantic-core.js';
import * as projector from '../semantics/compat/semantic-ir-v2-to-v1.js';
import * as facade from '../ir-core.js';
import { createProjectionIrObserver, PROJECTION_LIMITS } from '../core/identity/live-data.js';

const viewBatches = new WeakMap(), expectedViews = new WeakMap();
const MAX_VIEW_EVENTS = 1024, MAX_VIEW_WRITES = 4096, MAX_VIEW_HANDOFFS = 32;
const aggregateReaders = Object.freeze({
  preservedState:facade.readFacadePreservedStateHistory, location:facade.readFacadeLocationHistory,
  typedResult:facade.readFacadeTypedResultHistory, stackEscape:facade.readFacadeStackEscapeHistory,
  abiBinding:facade.readFacadeAbiBindingHistory,
});

export function semanticViewTransitionExpected(ir, source = null) {
  const expected = expectedViews.get(ir);
  return source == null ? (expected?.count || 0) > 0 : expected?.sources.has(source) === true;
}

export function readSemanticViewHistory(ir, source = null) {
  const batch = viewBatches.get(ir);
  if (!batch?.history.isCurrent()) return null;
  return source == null ? batch.history : batch.bySource.get(source) ?? null;
}

export function semanticViewStateCandidates(ir) {
  return viewBatches.get(ir)?.state ?? null;
}

// Readonly lookup of privately carried predecessor records. Neither the channel
// name nor a supplied object can register a record or authorize a write.
export function readSemanticViewPredecessor(ir, channel, source = null) {
  const record = semanticViewPredecessorCandidate(ir, channel, source);
  return record?.isCurrent() ? record : null;
}

export function semanticViewPredecessorCandidate(ir, channel, source = null) {
  return viewBatches.get(ir)?.carried.get(channel)?.get(source) ?? null;
}

function beginViewWriter(ir) {
  const prior = viewBatches.get(ir), expected = expectedViews.get(ir) ?? { count:0, sources:new WeakSet() };
  // A failed later writer must not leave a formerly complete publication in
  // place while the expected operation set has grown.
  viewBatches.delete(ir);
  expectedViews.set(ir, expected);
  const writer = { prior, expected, events:[], selections:[], writes:[], carried:new Map(), state:null,
    unavailable:!projector.isIssuedSemanticProjection(ir) || !!prior && (prior.depth >= MAX_VIEW_HANDOFFS || !prior.history.isCurrent())
      || !Array.isArray(ir.instructions) || ir.instructions.length > PROJECTION_LIMITS.nodes };
  if (writer.unavailable) return writer;
  const checks = new Map();
  const current = record => {
    if (!record) return false;
    if (!checks.has(record.isCurrent)) checks.set(record.isCurrent, record.isCurrent());
    return checks.get(record.isCurrent);
  };
  const remember = (channel, key, record) => {
    if (!current(record)) return;
    if (!writer.carried.has(channel)) writer.carried.set(channel, new Map());
    writer.carried.get(channel).set(key, record);
  };
  writer.state = prior?.state ?? facade.facadeStateTransitionCandidates(ir) ?? projector.projectedStateTransitionCandidates(ir);
  if (!current(writer.state)) writer.state = null;
  if (prior) {
    for (const [channel, records] of prior.carried) for (const [key, record] of records) remember(channel, key, record);
  } else {
    for (const [channel, read] of Object.entries(aggregateReaders)) {
      const history = read(ir);
      remember(channel, null, history);
      if (!history) continue;
      const groups = new Map();
      for (const event of history.events) {
        if (!groups.has(event.source)) groups.set(event.source, []);
        groups.get(event.source).push(event);
      }
      for (const [source, events] of groups) remember(channel, source,
        Object.freeze({ ...history, events:Object.freeze(events) }));
    }
    for (const source of ir.instructions) {
      remember('projectedConstant', source, facade.facadeProjectedConstantTransitionCandidate(ir, source)
        ?? projector.projectedConstantTransitionCandidate(ir, source));
      remember('facadeConstant', source, facade.facadeConstantTransitionCandidate(ir, source));
      remember('memoryOperand', source, facade.facadeProjectedMemoryOperandTransitionCandidate(ir, source)
        ?? projector.projectedMemoryOperandTransitionCandidate(ir, source));
    }
  }
  return writer;
}

function viewFields(source, values) {
  if (!Array.isArray(source.args) || source.args.length > 512 || values.size > 512) throw Error('view-write-field-budget');
  const fields = [], seen = new Map();
  const add = (object, key) => {
    if (!object) return;
    if (!seen.has(object)) seen.set(object, new Set());
    if (seen.get(object).has(key)) return;
    seen.get(object).add(key);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw Error('view-write-accessor');
    fields.push({ object, key, before:descriptor?.value, beforePresent:descriptor != null });
  };
  for (const key of ['op','sub','extra','args','loc','addr','reachingStore','memUse']) add(source, key);
  for (const argument of source.args || []) {
    add(argument, 'value'); add(argument, 'bits'); values.add(argument.value);
  }
  for (const value of values) if (value) {
    add(value, 'uses');
    if (Array.isArray(value.uses)) {
      add(value.uses, 'length'); add(value.uses, String(value.uses.length));
    }
  }
  if (fields.length > 512) throw Error('view-write-field-budget');
  return fields;
}

function performView(ir, writer, source, operation, before, after, inputs, related, blocks, change, argumentIndex = null) {
  writer.expected.count++; writer.expected.sources.add(source);
  let fields = null, selection = null, event = null;
  if (!writer.unavailable && writer.events.length + (writer.prior?.history.events.length || 0) < MAX_VIEW_EVENTS) try {
    const values = new Set([source.dst, before, after, ...inputs].filter(Boolean));
    fields = viewFields(source, values);
    selection = createProjectionIrObserver().captureOriginGraph([ir.compat, source, ...values, ...related, ...blocks]);
    event = { source, output:source.dst ?? null, op:source.op, sub:source.sub,
      stage:'decompiler-committed-view', operation, ordinal:writer.expected.count - 1,
      before, after, beforeOp:source.op, beforeSub:source.sub, argumentIndex,
      beforeInputs:Object.freeze([...values]),
      inputs:Object.freeze([...values].map(value => Object.freeze({ value, definition:value.def }))),
      related:Object.freeze([...related]), offset:writer.writes.length };
  } catch { writer.unavailable = true; }
  else writer.unavailable = true;
  change();
  if (!fields || writer.unavailable) return;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(field.object, field.key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) { writer.unavailable = true; return; }
    const after = descriptor?.value, afterPresent = descriptor != null;
    if (Object.is(field.before, after) && field.beforePresent === afterPresent) continue;
    if (writer.writes.length >= MAX_VIEW_WRITES) { writer.unavailable = true; return; }
    writer.writes.push(Object.freeze({ ...field, after, afterPresent }));
  }
  writer.events.push(Object.freeze({ ...event, afterOp:source.op, afterSub:source.sub }));
  writer.selections.push({ selection, offset:event.offset });
}

function sealViewWriter(ir, writer) {
  if (writer.unavailable || !writer.events.length && !writer.prior) return;
  try {
    const writes = Object.freeze(writer.writes), selections = writer.selections.map(({ selection, offset }) =>
      ({ selection, writes:Object.freeze(writes.slice(offset)) }));
    const events = Object.freeze([...(writer.prior?.history.events || []), ...writer.events]);
    const output = projector.observeProjectedOperationData(ir, events.flatMap(event => [event,
      ...event.related.map(source => ({ source, beforeInputs:[] }))]));
    const priorCheck = writer.prior?.history.isCurrent;
    const matches = following => (following == null || Array.isArray(following) && following.length + writes.length <= PROJECTION_LIMITS.nodes)
      && (following == null ? output() : output.matchesThroughWrites(following))
      && (!priorCheck || priorCheck.matchesThroughWrites([...writes, ...(following || [])]))
      && selections.every(item => item.selection.matchesThroughWrites([...item.writes, ...(following || [])]));
    const isCurrent = Object.freeze(Object.assign(() => matches(null), { matchesThroughWrites:matches }));
    if (!isCurrent()) return;
    const checks = new Map();
    const carry = record => {
      if (!record) return null;
      const original = record.isCurrent;
      if (!checks.has(original)) {
        const through = following => (following == null || Array.isArray(following) && following.length + writes.length <= PROJECTION_LIMITS.nodes) && (original.matchesThroughWrites
          ? original.matchesThroughWrites([...writes, ...(following || [])]) : original())
          && (following == null ? isCurrent() : isCurrent.matchesThroughWrites(following));
        const current = Object.freeze(Object.assign(() => through(null), { matchesThroughWrites:through }));
        checks.set(original, current() ? current : null);
      }
      const current = checks.get(original);
      return current ? Object.freeze({ ...record, isCurrent:current }) : null;
    };
    const carried = new Map();
    for (const [channel, records] of writer.carried) {
      const successors = new Map();
      for (const [key, record] of records) { const successor = carry(record); if (successor) successors.set(key, successor); }
      carried.set(channel, successors);
    }
    let state = null;
    if (writer.state) {
      const source = writer.state, original = Object.freeze(Object.assign(() => source.isCurrent(), {
        matchesThroughWrites:following => source.matchesThroughWrites(following),
      }));
      const batch = carry({ isCurrent:original });
      if (batch) {
        const cached = new Map(), current = batch.isCurrent;
        state = Object.freeze({ isCurrent:current, matchesThroughWrites:current.matchesThroughWrites,
          normalization:Object.freeze({ ...source.normalization, isCurrent:current }), get(key) {
            const record = source.get(key); if (!record) return null;
            if (!cached.has(record)) cached.set(record, Object.freeze({ ...record, isCurrent:current }));
            return cached.get(record);
          } });
      }
    }
    const history = Object.freeze({ events, isCurrent,
      completeness:events.length === writer.expected.count ? 'complete' : 'incomplete' });
    const bySource = new Map();
    for (const event of events) {
      if (!bySource.has(event.source)) bySource.set(event.source, []);
      bySource.get(event.source).push(event);
    }
    for (const [source, selected] of bySource) bySource.set(source, Object.freeze({ events:Object.freeze(selected), isCurrent }));
    viewBatches.set(ir, Object.freeze({ history, bySource, carried, state, depth:(writer.prior?.depth || 0) + 1 }));
  } catch { /* The existing view transform still runs; missing bounded history remains explicit. */ }
}

export function projectSemanticViews(ir, opts = {}) {
  const writer = beginViewWriter(ir);
  projectLegacyCfgSetShape(ir, writer);
  projectCommittedComparisonViews(ir, writer);
  projectCommittedPhiSnapshots(ir, writer);
  projectCommittedSnapshotViews(ir, writer);
  projectDeclaredReturnView(ir, opts, writer);
  sealViewWriter(ir, writer);
  return ir;
}

function declaredIntegerReturnBits(opts = {}) {
  const explicit = Number(opts.returnBits ?? opts.functionPrototype?.returnBits ?? opts.prototype?.returnBits ?? 0);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const type = String(opts.returnType ?? opts.functionPrototype?.returnType ?? opts.prototype?.returnType ?? '').trim().toLowerCase();
  if (/^(?:u?int(?:8|16|32|64)(?:_t)?|char|signed char|unsigned char|short|unsigned short|int|unsigned int|long long|unsigned long long)$/.test(type)) {
    if (/8/.test(type) || /char/.test(type)) return 8;
    if (/16/.test(type) || /short/.test(type)) return 16;
    if (/64/.test(type) || /long long/.test(type)) return 64;
    return 32;
  }
  return null;
}

function detachUse(value, inst) {
  if (Array.isArray(value?.uses)) value.uses = value.uses.filter((use) => use !== inst);
}
function attachUse(value, inst) {
  if (!value) return;
  if (!Array.isArray(value.uses)) value.uses = [];
  if (!value.uses.includes(inst)) value.uses.push(inst);
}
function replaceArgValue(inst, index, value) {
  const prior = inst?.args?.[index]?.value ?? null;
  if (!inst?.args?.[index] || !value || prior === value) return false;
  detachUse(prior, inst);
  inst.args[index].value = value;
  inst.args[index].bits = value.bits || inst.args[index].bits;
  attachUse(value, inst);
  return true;
}

const EXACT_VIEW_MOV_SUBS = new Set([null, 'copy', 'bitcast', 'trunc', 'zext']);

/*
 * Return an architecture-neutral proof trace through v1 MOV nodes that are
 * already marked as exact state/cast projections. Identity state moves are not
 * semantic transforms; trunc/zext steps are retained so two equal-width views
 * are considered identical only when their cast histories are identical.
 */
export function exactViewTrace(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  let current = value;
  const steps = [];
  while (current?.def?.op === OP.MOV && current.def.args?.length === 1) {
    const def = current.def;
    const sub = def.sub ?? null;
    const exactIdentity = sub == null || sub === 'copy' || sub === 'bitcast'
      || def.extra?.stateRead || def.extra?.stateWrite
      || isExactOperandForwardMove(def);
    if (!exactIdentity && !EXACT_VIEW_MOV_SUBS.has(sub)) break;
    const source = def.args[0]?.value ?? null;
    if (!source || active.has(source.id)) break;
    if (sub === 'trunc' || sub === 'zext') {
      steps.push(`${sub}:${Number(source.bits || 0)}>${Number(current.bits || 0)}`);
    }
    active.add(source.id);
    current = source;
  }
  return { root: current, bits: Number(value.bits || 0), steps };
}

function sameExactView(left, right) {
  if (!left || !right || Number(left.bits || 0) !== Number(right.bits || 0)) return false;
  const a = exactViewTrace(left), b = exactViewTrace(right);
  if (!a?.root || !b?.root || a.root.id !== b.root.id || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => step === b.steps[index]);
}

/* A stored narrow view may be the exact projection of an incoming wider state. */
function storedViewProjectsIncoming(stored, incoming, store) {
  if (!stored || !incoming || !store) return false;
  if (stored === incoming) return true;
  const a = exactViewTrace(stored), b = exactViewTrace(incoming);
  if (!a?.root || !b?.root || a.root.id !== b.root.id) return false;
  const widthBits = Number((store.loc?.size ?? store.addr?.size ?? store.extra?.size ?? 0) * 8);
  if (widthBits > 0 && Number(stored.bits || 0) !== widthBits) return false;
  if (a.steps.length < b.steps.length) return false;
  const suffix = a.steps.slice(a.steps.length - b.steps.length);
  return suffix.every((step, index) => step === b.steps[index]);
}

function canonicalLocationBase(value, active = new Set()) {
  if (!value || active.has(value.id)) return value;
  active.add(value.id);
  const trace = exactViewTrace(value);
  let root = trace?.root ?? value;
  const def = root?.def;
  if (def?.op === OP.LOAD && def.reachingStore?.args?.[0]?.value) {
    root = canonicalLocationBase(def.reachingStore.args[0].value, active) ?? root;
  } else if (isExactOperandForwardMove(def)) {
    // The forwarded operand is the exact stored identity of the load it
    // replaced; its location base is the stored value's base.
    root = canonicalLocationBase(def.args[0]?.value, active) ?? root;
  } else if (def?.op === OP.PHI && Array.isArray(def.incoming) && def.incoming.length) {
    const roots = def.incoming.map((item) => canonicalLocationBase(item.value, new Set(active))).filter(Boolean);
    const first = roots[0] ?? null;
    if (first && roots.every((candidate) => candidate.id === first.id)) root = first;
  }
  active.delete(value.id);
  return root;
}

function sameLocationBase(left, right) {
  const a = canonicalLocationBase(left), b = canonicalLocationBase(right);
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  return a.kind === 'arg' && b.kind === 'arg' && a.reg && a.reg === b.reg;
}

function sameCommittedFieldLocation(left, right) {
  if (!left || !right || left.kind !== MK.FIELD || right.kind !== MK.FIELD) return false;
  try {
    if (BigInt(left.disp ?? 0) !== BigInt(right.disp ?? 0)) return false;
  } catch { return false; }
  const leftSize = Number(left.size ?? 0), rightSize = Number(right.size ?? 0);
  if (leftSize > 0 && rightSize > 0 && leftSize !== rightSize) return false;
  return sameLocationBase(left.base, right.base);
}

function hasBarrierAfterStore(block, store) {
  return (block?.insts || []).some((inst) => Number(inst.row) > Number(store.row)
    && (inst.op === OP.CALL || inst.op === OP.UNKNOWN || inst.op === OP.STORE));
}

function committedStoreForIncoming(ir, incoming) {
  const block = ir?.blocks?.[incoming?.from];
  if (!block || !incoming?.value) return null;
  const stores = (block.insts || [])
    .filter((inst) => inst.op === OP.STORE && inst.loc?.kind === MK.FIELD
      && storedViewProjectsIncoming(inst.args?.[0]?.value, incoming.value, inst))
    .sort((left, right) => Number(right.row) - Number(left.row));
  for (const store of stores) {
    if (!hasBarrierAfterStore(block, store)) return store;
  }
  return null;
}

/*
 * A scalar PHI may represent the value already committed to one logical field on
 * every predecessor. Replace only the decompiler-facing PHI operation with a
 * snapshot LOAD when every incoming edge proves such a store, all stores target
 * the same field, and no later store/call/unknown exists before the edge.
 * Canonical SSA and MemorySSA contracts are not modified.
 */
function projectCommittedPhiSnapshots(ir, writer) {
  for (const phi of ir?.instructions || []) {
    if (phi.op !== OP.PHI || !Array.isArray(phi.incoming) || phi.incoming.length < 2 || !phi.dst) continue;
    const stores = phi.incoming.map((incoming) => committedStoreForIncoming(ir, incoming));
    if (stores.some((store) => !store)) continue;
    const first = stores[0];
    if (!stores.every((store) => sameCommittedFieldLocation(first.loc, store.loc))) continue;
    const viewBits = Number((first.loc?.size ?? first.addr?.size ?? first.extra?.size ?? 0) * 8)
      || Number(first.args?.[0]?.value?.bits ?? 0) || null;
    performView(ir, writer, phi, 'project-committed-phi-snapshot', phi.dst, phi.dst,
      [...phi.incoming.map(edge => edge.value), ...stores.map(store => store.args[0].value)], stores,
      [...new Set([ir.blocks[phi.block], ...phi.incoming.map(edge => ir.blocks[edge.from])])], () => {
    phi.extra = {
      ...(phi.extra ?? {}),
      compatOriginalOp: OP.PHI,
      committedPhiSnapshot: true,
      committedStoreRows: stores.map((store) => store.row),
      committedLocationKey: first.loc.key,
      committedViewBits: viewBits,
    };
    phi.op = OP.LOAD;
    phi.sub = null;
    phi.loc = first.loc;
    phi.addr = first.addr ?? null;
    phi.reachingStore = null;
    phi.memUse = null;
    });
  }
  return ir;
}

/*
 * Once a committed PHI snapshot is proven to represent a narrower memory field,
 * an exact truncation of that snapshot to the field width is not a source-level
 * cast. Re-express only that exact view as a decompiler-facing LOAD with the
 * existing 32/16/8-bit destination. The physical-state SSA remains unchanged.
 */
function projectCommittedSnapshotViews(ir, writer) {
  for (const inst of ir?.instructions || []) {
    if (inst.op !== OP.MOV || inst.sub !== 'trunc' || !inst.dst || inst.args?.length !== 1) continue;
    const source = inst.args[0]?.value ?? null;
    const trace = exactViewTrace(source);
    const snapshot = trace?.root?.def;
    const viewBits = Number(snapshot?.extra?.committedViewBits ?? 0);
    if (snapshot?.op !== OP.LOAD || snapshot.extra?.committedPhiSnapshot !== true
        || viewBits <= 0 || Number(inst.dst.bits || 0) !== viewBits) continue;
    performView(ir, writer, inst, 'project-committed-snapshot-view', source, inst.dst,
      [source], [snapshot], [ir.blocks[inst.block]], () => {
    detachUse(source, inst);
    inst.op = OP.LOAD;
    inst.sub = null;
    inst.args = [];
    inst.loc = snapshot.loc;
    inst.addr = snapshot.addr ?? null;
    inst.reachingStore = null;
    inst.memUse = null;
    inst.extra = {
      ...(inst.extra ?? {}),
      compatOriginalOp: OP.MOV,
      compatOriginalSub: 'trunc',
      committedSnapshotView: true,
      committedViewBits: viewBits,
      committedStoreRows: [...(snapshot.extra?.committedStoreRows ?? [])],
      committedLocationKey: snapshot.extra?.committedLocationKey ?? snapshot.loc?.key ?? null,
    };
    });
  }
  return ir;
}

/*
 * If a comparison consumes another exact view of the value just committed by a
 * same-block store, use that stored value object for this comparison only. This
 * preserves the legacy "compare committed lvalue" behavior without globally
 * collapsing register/cast provenance (which would break threshold evidence).
 */
function projectCommittedComparisonViews(ir, writer) {
  for (const cmp of ir?.instructions || []) {
    if (cmp.op !== OP.CMP || cmp.row == null) continue;
    const block = ir.blocks?.[cmp.block];
    if (!block) continue;
    for (let index = 0; index < (cmp.args?.length ?? 0); index++) {
      const value = cmp.args[index]?.value;
      if (!value) continue;
      const stores = (block.insts || [])
        .filter((store) => store.op === OP.STORE && store.loc?.kind !== MK.UNKNOWN
          && store.row != null && Number(store.row) < Number(cmp.row)
          && sameExactView(store.args?.[0]?.value, value))
        .sort((left, right) => Number(right.row) - Number(left.row));
      const store = stores[0] ?? null;
      if (!store) continue;
      const blocked = (block.insts || []).some((candidate) => Number(candidate.row) > Number(store.row) && Number(candidate.row) < Number(cmp.row)
        && (candidate.op === OP.STORE || candidate.op === OP.CALL || candidate.op === OP.UNKNOWN));
      if (blocked) continue;
      performView(ir, writer, cmp, 'project-committed-comparison-view', value, store.args[0].value,
        [value, store.args[0].value], [store], [block], () => {
        replaceArgValue(cmp, index, store.args[0].value);
        cmp.extra = { ...(cmp.extra ?? {}), committedComparisonView: true, committedStoreRow: store.row };
      }, index);
    }
  }
  return ir;
}

/*
 * AArch64 W returns live in the low view of physical X0. Semantic v2 correctly
 * models that as a 32-bit value -> zext -> 64-bit X0 state assignment. For a
 * source-language 32-bit return, project the already-proven inner value back to
 * the decompiler instead of presenting the physical-storage-width wrapper.
 */
function exactNarrowReturnSource(value, bits) {
  if (!value || !Number.isSafeInteger(bits) || bits <= 0) return value;
  if (Number(value.bits) === bits) return value;
  let current = value;
  const stateWrite = current.def;
  if (stateWrite?.op === OP.MOV && stateWrite.extra?.stateWrite && stateWrite.args?.length === 1) {
    current = stateWrite.args[0]?.value ?? current;
  }
  const extension = current?.def;
  if (extension?.op === OP.MOV && extension.sub === 'zext' && extension.args?.length === 1) {
    const inner = extension.args[0]?.value ?? null;
    if (inner && Number(inner.bits) === bits && Number(current.bits) > bits) return inner;
  }
  return value;
}

function projectDeclaredReturnView(ir, opts, writer) {
  const bits = declaredIntegerReturnBits(opts);
  if (!bits || !ir?.instructions) return ir;
  for (const ret of ir.instructions) {
    if (ret.op !== OP.RET || ret.args?.length !== 1) continue;
    const prior = ret.args[0]?.value ?? null;
    const projected = exactNarrowReturnSource(prior, bits);
    if (!projected || projected === prior) continue;
    performView(ir, writer, ret, 'project-declared-return-view', prior, projected,
      [prior, projected], [], [ir.blocks[ret.block]], () => {
      replaceArgValue(ret, 0, projected);
      ret.extra = { ...(ret.extra ?? {}), sourceLanguageReturnBits: bits, exactReturnViewProjection: true };
    }, 0);
  }
  return ir;
}

function projectLegacyCfgSetShape(ir, writer) {
  for (const block of ir?.blocks || []) {
    for (const key of ['succ', 'pred']) if (Array.isArray(block[key])) {
      const before = block[key];
      block[key] = [...new Set(before)];
      if (writer.writes.length < MAX_VIEW_WRITES) writer.writes.push(Object.freeze({
        object:block, key, before, after:block[key], beforePresent:true, afterPresent:true,
      }));
      else writer.unavailable = true;
    }
  }
  return ir;
}
