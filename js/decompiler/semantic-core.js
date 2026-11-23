/*
 * Semantic IR first decompiler.
 *
 * The decompiler never reparses an ARM64 instruction when Semantic IR already
 * represents it. Unsupported IR/control-flow falls back to explicit labels and
 * gotos rather than manufacturing source structure.
 */

import { irFor, readModifyWrite, OP, VK, MK, COND, inverseCondition, mayAliasProvenance } from '../ir.js';
import { analyzeGraph } from '../controlflow.js';
import { inferSemanticTypes, semanticSignature, typeNameOf } from './type-recovery.js';
import { cppMemberTypeLabel, currentCppMember, currentCppReceiver, currentCppVirtualSlot, isCppReceiverAlias } from './cxx-evidence.js';
import { buildAppleRuntimeIndex, resolveAppleCall, shouldFoldRuntimeCall, runtimeOriginForSymbol } from '../apple/runtime.js';
import { callArgumentIndices, knownCallPrototype, knownCallSignature } from './call-prototypes.js';
import { sourceOf, mergeSource } from './ast/nodes.js';
import { isNZCVCondition, renderNZCVCondition } from './flag-semantics.js';
import { renderIndexedMemory, renderExtendedIndex } from './address-semantics.js';
import { integerText } from './pretty/c.js';
import { captureProjectionIrData, captureRecoveryIrData, captureRecoveryDominators, PROJECTION_LIMITS } from './phase8/projection-origin.js';
import { createProjectionIrObserver, createValidationBatch, ownDataEntries } from '../core/identity/live-data.js';
import { expressionOriginHistory } from './rewrite/engine.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';
import { applyDecompilerProfile } from './profiles.js';
export { resolveDecompilerProfile, applyDecompilerProfile } from './profiles.js';

const MAX_EXPR_DEPTH = 48;
const MAX_EXPR_NODES = 512;
const MAX_BLOCKS = 6000;
const MAX_TERMINAL_PROOF_STEPS = MAX_BLOCKS * 4;

function terminalProofSteps(opts) {
  const requested = opts?.controlFlowProofBudget?.maxTerminalProofSteps;
  if (!Number.isSafeInteger(requested) || requested < 0) return MAX_TERMINAL_PROOF_STEPS;
  return Math.min(requested, MAX_TERMINAL_PROOF_STEPS);
}

const storeRenderLines = new WeakMap(), storeRenderHistories = new WeakMap();
const statementRenderLines = new WeakMap(), statementRenderHistories = new WeakMap();
const orderedMaterializationBindings = new WeakMap();

/** Producer-owned ordered load bindings. These are presentation identities,
 * not alias/equivalence proofs; consumers may only reuse the exact SSA value. */
export function readSemanticOrderedMaterializations(result, ir) {
  const entry = orderedMaterializationBindings.get(result);
  try { return entry?.ir === ir && entry.isCurrent() ? entry.bindings : null; }
  catch { return null; }
}
const controlRenderLines = new WeakMap(), controlRenderHistories = new WeakMap();
const conditionalRegionHistories = new WeakMap(), conditionalRegionsByRecord = new WeakMap();

/** Initial-emitter identity only. This never authorizes a CFG transform or a
 * copied C AST span. A later carrier must bind every copied node explicitly. */
export function readSemanticConditionalRegions(result) {
  const binding = conditionalRegionHistories.get(result);
  try { return binding?.isCurrent() ? binding.history : null; } catch { return null; }
}

export function readSemanticConditionalRegion(record, ir) {
  const binding = conditionalRegionsByRecord.get(record);
  try { return binding?.ir === ir && binding.isCurrent() ? binding.region : null; } catch { return null; }
}

function beginConditionalRegion(ctx, out, state) {
  const history = ctx.conditionalRegionHistory;
  if (!history) return null;
  if (history.events.length >= history.limit || state.visited.size > history.remaining || history.remaining <= 0) {
    history.reasons.add('conditional-region-budget'); return null;
  }
  // Reserve before allocation: nested open regions must not each retain a
  // fresh full visited set against the same still-unspent budget.
  history.remaining -= state.visited.size;
  return { start:out.length, visited:new Set(state.visited), armStart:null, arms:[] };
}

function startConditionalArm(marker, out) {
  if (marker) marker.armStart = out.length;
}

function finishConditionalArm(marker, out, state, role, ctx) {
  if (!marker) return;
  const history = ctx.conditionalRegionHistory;
  const work = state.visited.size * 4;
  if (work > history.remaining || out.length - marker.start > history.remaining) {
    history.reasons.add('conditional-region-budget'); marker.failed = true; return;
  }
  history.remaining -= work;
  const blocks = [...state.visited].filter(index => !marker.visited.has(index)).map(index => ctx.ir.blocks[index]);
  marker.arms.push({ role, start:marker.armStart, end:out.length, blocks });
  marker.visited = new Set(state.visited);
}

function finishConditionalRegion(marker, out, ctx, branch, selection, separator, close) {
  if (!marker || marker.failed) return;
  const history = ctx.conditionalRegionHistory, size = out.length - marker.start;
  const joinBlock = ctx.ir.blocks[selection.join], phis = joinBlock?.phis ?? [];
  const cost = size * 2 + phis.length + marker.arms.reduce((sum, arm) => sum + arm.blocks.length, 0);
  if (history.events.length >= history.limit || cost > history.remaining) {
    history.reasons.add('conditional-region-budget'); return;
  }
  const header = out[marker.start], binding = readSemanticControlLineHistory(header, ctx.ir);
  if (!binding || binding.instruction !== branch || !joinBlock || !Array.isArray(phis)) {
    history.reasons.add('conditional-region-producer-unavailable'); return;
  }
  history.remaining -= cost;
  history.events.push(Object.freeze({ record:binding.records[0], branch,
    selection:Object.freeze({ ...selection }), header, separator, close,
    nodes:Object.freeze(out.slice(marker.start).filter(n => !n || n.__emptyBlockAnchor === undefined)), joinBlock, joinPhis:Object.freeze([...phis]),
    arms:Object.freeze(['yes', 'no'].map(role => {
      const arm = marker.arms.find(item => item.role === role);
      return Object.freeze({ role, entryBlock:ctx.ir.blocks[selection[role]],
        nodes:Object.freeze(arm ? out.slice(arm.start, arm.end).filter(n => !n || n.__emptyBlockAnchor === undefined) : []), emittedBlocks:Object.freeze(arm?.blocks ?? []) });
    })),
  }));
}

function bindConditionalRegionHistory(result, ctx) {
  const pending = ctx.conditionalRegionHistory;
  if (!pending) return result;
  const lines = result.lines, canonical = ctx.controlRenderHistory.canonical;
  let observation = null;
  try {
    if (result.coverage.mode !== 'structured') pending.reasons.add('conditional-region-cfg-fallback');
    if (ctx.opts.shouldAbort?.()) pending.reasons.add('conditional-region-cancelled');
    if (!canonical?.isCurrent()) pending.reasons.add('conditional-region-stale-input');
    if (!pending.reasons.size) {
      // One final output observation for all nested regions, rather than a
      // recursive full-line scan per region. Node identity, order and contents
      // are certified before any downstream copying or representation pass.
      // Empty complete histories also observe their input and output: absence
      // of emitted regions cannot outlive the program it describes.
      observation = captureProjectionIrData([lines], ctx.opts.shouldAbort);
      if (observation.metrics.edges > pending.maxEdges) pending.reasons.add('conditional-region-budget');
      const positions = new Map(lines.map((node, index) => [node, index]));
      if (positions.size !== lines.length || pending.events.some(region => {
        const start = positions.get(region.header);
        return start == null || region.nodes.some((node, index) => lines[start + index] !== node)
          || region.nodes.at(-1) !== region.close;
      })) pending.reasons.add('conditional-region-output-identity');
    }
  } catch { pending.reasons.add('conditional-region-observation-unavailable'); }
  const history = Object.freeze({ version:1, scope:'initial-emitter-spans-only-not-cfg-proof',
    completeness:pending.reasons.size ? 'incomplete' : 'complete', transformAuthorization:false,
    reasons:Object.freeze([...pending.reasons]), regions:Object.freeze(pending.reasons.size ? [] : [...pending.events]) });
  const isCurrent = () => !ctx.opts.shouldAbort?.() && result.ir === ctx.ir && result.lines === lines
    && (history.completeness === 'incomplete' || canonical?.isCurrent()) && (!observation || observation.matches());
  const binding = Object.freeze({ history, isCurrent });
  conditionalRegionHistories.set(result, binding);
  try {
    if (isCurrent()) for (const region of history.regions) {
      conditionalRegionsByRecord.set(region.record, Object.freeze({ ir:ctx.ir, region, isCurrent }));
    }
  } catch { /* A throwing cancellation observer cannot issue a record binding. */ }
  return result;
}
// Issued only by the real initial function renderer. Primitive string returns
// stay unchanged; invocation tickets never become semantic identities.
const initialValueTraces = new WeakMap();

function beginInitialValueTrace(ctx) {
  initialValueTraces.set(ctx, { active:null, roots:[], memo:new Map(), calls:new Map(),
    remaining:historyCap(ctx.opts.renderProvenanceBudget?.maxTransformRecords, 1024),
    reasons:new Set(), canonical:ctx.statementRenderHistory.canonical });
}

function initialValueCursor(ctx) {
  const trace = initialValueTraces.get(ctx);
  const list = trace && (trace.active?.children || trace.roots);
  return list ? { list, start:list.length } : null;
}

function selectInitialValueTickets(cursor, selected = []) {
  if (cursor) cursor.list.splice(cursor.start, cursor.list.length - cursor.start, ...selected.filter(Boolean));
}

function resetInitialValueOwner(ctx) {
  const trace = initialValueTraces.get(ctx);
  if (trace) trace.roots.length = 0;
}

function initialValueForm(ctx, form, text) {
  const frame = initialValueTraces.get(ctx)?.active;
  if (frame) frame.form = form;
  return text;
}

function takeInitialValueRecords(ctx, owner) {
  const trace = initialValueTraces.get(ctx);
  if (!trace) return [];
  for (const reason of trace.reasons) owner.reasons.add(reason);
  const pending = [...trace.roots], seen = new Set(), records = [];
  trace.roots.length = 0;
  while (pending.length) {
    const ticket = pending.pop();
    if (!ticket || seen.has(ticket)) continue;
    seen.add(ticket);
    if (seen.size > 1024) { owner.reasons.add('initial-expression-history-budget'); break; }
    if (ticket.record) records.push(ticket.record);
    else owner.reasons.add('initial-expression-history-unavailable');
    pending.push(...ticket.children);
  }
  return records;
}
export const INITIAL_CONTROL_RENDER_FORMS = Object.freeze([
  'unsupported-statement', 'while-loop', 'for-loop', 'revisit-goto', 'loop-continue', 'loop-break',
  'residual-branch-goto', 'switch-header', 'switch-case-goto', 'switch-default-goto', 'one-sided-if', 'if-else',
  'residual-conditional-goto', 'residual-false-goto', 'cfg-label', 'cfg-conditional-goto', 'cfg-false-goto', 'cfg-branch-goto',
]);
const historyCap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;

export function readSemanticStatementLineHistory(line, ir) {
  const entry = statementRenderLines.get(line);
  return entry && entry.ir === ir && entry.isCurrent() ? entry : null;
}

export function readSemanticStatementRenderHistory(result) {
  const entry = statementRenderHistories.get(result);
  return entry && entry.ir === result.ir && entry.disposition === result.semanticStatementRenderHistory ? entry : null;
}

function beginStatementRenderHistory(ctx) {
  const history = ctx.statementRenderHistory;
  if (!ctx.ir.instructions.some(inst => [OP.CALL, OP.RET, OP.STORE, OP.BR, OP.CBR, OP.UNKNOWN].includes(inst.op))) return;
  try {
    if (history.limit <= 0 || history.edges <= 0 || history.consumers <= 0) throw new Error('initial-statement-budget');
    // One bounded preimage, before rendering or prototype/symbol callbacks.
    // Reaching selection scans values beyond the finally selected operands;
    // reusing the existing IR observer keeps those rejected candidates too.
    const callsDescriptor = Object.getOwnPropertyDescriptor(ctx.model, 'calls');
    if (callsDescriptor && (!Object.hasOwn(callsDescriptor, 'value') || !callsDescriptor.enumerable)) throw new Error('initial-statement-model-data-required');
    const calls = callsDescriptor?.value, argsDescriptor = Object.getOwnPropertyDescriptor(ctx.ir, 'args');
    if (argsDescriptor && (!Object.hasOwn(argsDescriptor, 'value') || !argsDescriptor.enumerable)) throw new Error('initial-statement-args-data-required');
    const args = argsDescriptor?.value;
    if (args != null && (Object.getPrototypeOf(args) !== Map.prototype || Reflect.ownKeys(args).length)) throw new Error('initial-statement-args-map-required');
    const bindings = args == null ? [] : [...Map.prototype.entries.call(args)];
    if (bindings.length > 512) throw new Error('initial-statement-args-budget');
    const observation = captureRecoveryIrData(ctx.ir, [calls, bindings, ...ctx.ir.values.map(value => Object.getOwnPropertyDescriptor(value, 'uses')?.value)]);
    history.edges -= observation.metrics.edges;
    if (history.edges < 0) throw new Error('initial-statement-budget');
    const sameData = (object, key, descriptor) => {
      const now = Object.getOwnPropertyDescriptor(object, key);
      return descriptor ? !!now && Object.hasOwn(now, 'value') && now.enumerable && now.value === descriptor.value : !now;
    };
    const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    const rawIsCurrent = () => sameData(ctx.model, 'calls', callsDescriptor) && sameData(ctx.ir, 'args', argsDescriptor)
      && (args == null || Object.getPrototypeOf(args) === Map.prototype && !Reflect.ownKeys(args).length && size.call(args) === bindings.length
        && bindings.every(([key, value]) => Map.prototype.has.call(args, key) && Map.prototype.get.call(args, key) === value)) && observation.matches();
    const token = {};
    history.canonical = { isCurrent:() => {
      const batch = ctx.validationBatch;
      if (!batch) return rawIsCurrent();
      const known = batch.known(token, null);
      if (known !== undefined) return known;
      const current = rawIsCurrent();
      batch.remember(token, null, current, rawIsCurrent);
      return current;
    } };
  } catch { history.edges = 0; }
}

export function readSemanticControlLineHistory(line, ir) {
  const entry = controlRenderLines.get(line);
  return entry && entry.ir === ir && entry.isCurrent() ? entry : null;
}

export function registerSemanticControlLineHistory(line, entry) {
  if (line && typeof line === 'object' && entry && typeof entry === 'object') {
    controlRenderLines.set(line, entry);
  }
}

export function readSemanticControlRenderHistory(result) {
  const entry = controlRenderHistories.get(result);
  return entry && entry.ir === result.ir && entry.disposition === result.semanticControlRenderHistory ? entry : null;
}

function beginControlRenderHistory(ctx) {
  const history = ctx.controlRenderHistory;
  if (!ctx.conditionalRegionHistory && !ctx.ir.instructions.some(inst => [OP.BR, OP.CBR, OP.UNKNOWN].includes(inst.op))) return;
  try {
    if (history.limit <= 0 || history.edges <= 0 || !ctx.statementRenderHistory.canonical) throw new Error('initial-control-budget');
    // Structural facts are the existing graph producer's data, not a second
    // CFG/dominance calculation. Sets are observed natively and not iterated
    // through caller-supplied has()/iterator implementations.
    const loops = ctx.graph.loops, loopEntries = ownDataEntries(loops, MAX_BLOCKS);
    const members = [ctx.graph.reachable], plain = [ctx.graph.immediatePostDominators, ctx.model.instructions];
    const records = loopEntries.map(([key, loop]) => {
      const fields = ownDataEntries(loop, 16);
      for (const [name, value] of fields) {
        if (['nodes', 'exits', 'latches'].includes(name)) members.push(value); else plain.push(value);
      }
      return { key, loop, fields };
    });
    // Conditional-region identity also depends on the function envelope. Keep
    // this observation at the original producer, before any later AST copy.
    const regionInputKeys = ctx.conditionalRegionHistory
      ? ['entry', 'architecture', 'addressBits', 'origin', 'extra', 'truncated'] : [];
    const roots = [[ctx.ir, 'loops'], [ctx.ir, 'ipdom'], [ctx.ir, 'postDominators'], [ctx.model, 'instructions'],
      ...regionInputKeys.map(key => [ctx.ir, key]),
      [ctx.opts, 'switches'], [ctx.model, 'switches']].map(([object, key]) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) throw new Error('initial-control-data-required');
      if (key === 'switches' || regionInputKeys.includes(key)) plain.push(descriptor?.value);
      return { object, key, descriptor };
    });
    const switches = [...Map.prototype.entries.call(ctx.switchByRow)];
    plain.push(switches);
    const sets = captureRecoveryDominators(members), post = captureRecoveryDominators(ctx.graph.postDominators);
    const data = captureProjectionIrData(plain);
    history.edges -= sets.edges + post.edges + data.metrics.edges;
    if (history.edges < 0) throw new Error('initial-control-budget');
    const rawIsCurrent = () => { try { return ctx.statementRenderHistory.canonical.isCurrent()
      && roots.every(({ object, key, descriptor }) => {
        const now = Object.getOwnPropertyDescriptor(object, key);
        return descriptor ? !!now && Object.hasOwn(now, 'value') && now.enumerable && now.value === descriptor.value : !now;
      }) && loops.length === loopEntries.length && records.every(({ key, loop, fields }) => {
        if (Object.getOwnPropertyDescriptor(loops, key)?.value !== loop) return false;
        const now = ownDataEntries(loop, 16);
        return now.length === fields.length && fields.every(([name, value], index) => now[index][0] === name && now[index][1] === value);
      }) && sets.matches() && post.matches() && data.matches(); } catch { return false; } };
    const token = {};
    history.canonical = { isCurrent:() => {
      const batch = ctx.validationBatch;
      if (!batch) return rawIsCurrent();
      const known = batch.known(token, null);
      if (known !== undefined) return known;
      const current = rawIsCurrent();
      batch.remember(token, null, current, rawIsCurrent);
      return current;
    } };
  } catch { history.edges = 0; }
}

function retainStatementRenderLine(node, inst, detail, ctx, control = null, resultBinding = null) {
  const history = control ? ctx.controlRenderHistory : ctx.statementRenderHistory;
  const expressions = takeInitialValueRecords(ctx, history);
  const prefix = control ? 'initial-control' : 'initial-statement';
  if (history.events.length >= history.limit) { history.reasons.add(`${prefix}-history-budget`); return; }
  const own = (object, key) => object == null ? undefined : Object.getOwnPropertyDescriptor(object, key)?.value;
  const source = control ? mergeSource(node.source, inst ? sourceOf({ address:own(inst, 'address'), row:own(inst, 'row'),
    ir:own(inst, 'id'), ssaDef:own(own(inst, 'dst'), 'id') }) : null, detail?.source) : node.source;
  const record = Object.freeze({ rule:control ? `render-initial-${control}` : inst.op === OP.CALL ? 'render-initial-call' : 'render-initial-return', phase:'initial-semantic-render',
    before:`canonical:${inst?.op ?? 'block'}:${inst?.id ?? 'target'}`, after:control ? `control:${control}` : `statement:${inst.op}`,
    evidence:Object.freeze({ kind:control ? 'observed-control-render-not-cfg-equivalence' : 'observed-call-return-render-not-abi-equivalence',
      detail:control ? 'actual selected control/unsupported-statement emission; source/target identities retained, not a new CFG, flag or scalar equivalence proof'
        : 'actual emitted call/return statement; existing source identities retained, not a new ABI, scalar or control-flow proof' }),
    originHistory:expressionOriginHistory({ source }, { source }),
  });
  const records = Object.freeze([record, ...expressions]);
  history.events.push({ node, record, records });
  try {
    if (history.edges <= 0 || history.consumers <= 0 || !history.canonical?.isCurrent()) throw new Error(`${prefix}-binding-unavailable`);
    history.consumers--;
    // A selected canonical return value is already inside the pre-render
    // whole-IR observation, including every candidate and reverse-use index.
    // Do not recursively observe the same SSA cycle from a single value again.
    // Nonmember details and call/control bindings still need their own capture.
    const sharedReturn = !control && inst.op === OP.RET && resultBinding == null && detail != null && ctx.ir.values.includes(detail);
    const inputs = sharedReturn ? { metrics:{ edges:0 }, matches:() => ctx.ir.values.includes(detail) }
      : captureProjectionIrData([detail, resultBinding]);
    const output = captureProjectionIrData([node]);
    history.edges -= inputs.metrics.edges + output.metrics.edges;
    const canonical = Object.freeze({ isCurrent:() => history.canonical.isCurrent() && inputs.matches() });
    if (history.edges < 0 || ctx.opts.shouldAbort?.() || !canonical.isCurrent() || !output.matches()) throw new Error(`${prefix}-binding-unavailable`);
    (control ? controlRenderLines : statementRenderLines).set(node, Object.freeze({ ir:ctx.ir, instruction:inst, canonical, records, resultBinding,
      ...(control ? { selection:detail } : {}),
      isCurrent:() => canonical.isCurrent() && output.matches() }));
  } catch { history.edges = 0; history.reasons.add(`${prefix}-binding-unavailable`); }
}

function retainControlRenderLine(node, inst, form, selection, ctx) {
  if (!INITIAL_CONTROL_RENDER_FORMS.includes(form)) {
    ctx.controlRenderHistory.reasons.add('unregistered-control-render-form'); return node;
  }
  retainStatementRenderLine(node, inst, selection, ctx, form);
  return node;
}

function bindStatementRenderHistory(result, ctx, control = false) {
  const history = control ? ctx.controlRenderHistory : ctx.statementRenderHistory;
  if (!history.events.length && !history.reasons.size) return result;
  const disposition = Object.freeze({ scope:control ? 'initial-control-render-producer' : 'initial-call-return-render-producer',
    completeness:history.reasons.size ? 'incomplete' : 'complete', reasons:Object.freeze([...history.reasons]) });
  result[control ? 'semanticControlRenderHistory' : 'semanticStatementRenderHistory'] = disposition;
  (control ? controlRenderHistories : statementRenderHistories).set(result, Object.freeze({ ir:ctx.ir, disposition,
    records:Object.freeze([...new Set(history.events.flatMap(event => event.records || [event.record]))]), reasons:disposition.reasons }));
  return result;
}

export function readSemanticStoreLineHistory(line, ir) {
  const entry = storeRenderLines.get(line);
  return entry && entry.ir === ir && entry.isCurrent() ? entry : null;
}

export function readSemanticStoreRenderHistory(result) {
  const entry = storeRenderHistories.get(result);
  return entry && entry.ir === result.ir && entry.disposition === result.semanticStoreRenderHistory ? entry : null;
}

// The compatibility facade's existing spelling normalization is an owned
// transition. Public copies/edits cannot substitute for the observed input line.
export function normalizeSemanticCompatibilityLine(line, ir) {
  if (!line || typeof line.text !== 'string') return;
  const text = line.text.replace(/\blocal_([0-9a-f]+)\b/gi, (_m, h) => 'var_' + h.toUpperCase())
    .replace(/\bvar_([0-9a-f]+)\b/gi, (_m, h) => 'var_' + h.toUpperCase());
  if (text === line.text) return;
  const entry = readSemanticStoreLineHistory(line, ir);
  const statement = readSemanticStatementLineHistory(line, ir);
  const control = readSemanticControlLineHistory(line, ir);
  line.text = text;
  for (const [binding, table] of [[entry, storeRenderLines], [statement, statementRenderLines], [control, controlRenderLines]]) {
    if (!binding) continue;
    try {
      const observation = captureProjectionIrData([line]);
      table.set(line, Object.freeze({ ...binding,
        ...(binding.spelling ? { spelling:Object.freeze({ ...binding.spelling, text:line.text }) } : {}),
        isCurrent:() => binding.canonical.isCurrent() && observation.matches(),
      }));
    } catch { /* No inferred continuity when the exact line cannot be observed. */ }
  }
}

function initialStoreCaptureFailure(error, phase) {
  const detail = typeof error?.message === 'string' ? error.message : '';
  if (/^initial-store-[a-z0-9-]+$/.test(detail)) return detail;
  if (/^projection-[a-z0-9-]+$/.test(detail)) return `initial-store-${phase}-${detail}`;
  return `initial-store-${phase}-unavailable`;
}

function observeStoreSelection(inst, rmw, upd, ctx) {
  const history = ctx.storeRenderHistory;
  if (history.events.length >= history.limit) { history.reasons.add('initial-store-history-budget'); return null; }
  const source = storeSource(inst, ctx), ir = ctx.ir, instructions = ir.instructions, position = instructions.indexOf(inst);
  let observation = null;
  try {
    if (history.edges <= 0 || history.consumers <= 0 || position < 0) throw new Error('initial-store-binding-budget');
    // Capture before renderValue can invoke a symbol callback. This is a
    // display selection, not an independent proof of the RMW analysis fact.
    // These roots enumerate the complete cyclic SSA objects needed by this
    // store selection. Root-distance graph observation avoids treating nesting
    // in the cycle as an arbitrary semantic-depth cutoff.
    observation = ctx.projectionIrObserver.captureGraph([inst, rmw, upd], ctx.opts.shouldAbort);
    history.edges -= observation.metrics.edges;
    if (history.edges < 0) throw new Error('initial-store-binding-budget');
  } catch (error) { observation = null; history.edges = 0; history.reasons.add(initialStoreCaptureFailure(error, 'observation')); }
  return Object.freeze({ source, valueId:valueOf(inst.args?.[0])?.id ?? null,
    isCurrent:() => Object.getOwnPropertyDescriptor(ir, 'instructions')?.value === instructions
    && Object.getOwnPropertyDescriptor(instructions, position)?.value === inst && observation?.matches() === true });
}

function retainStoreRenderLine(node, inst, rendered, ctx) {
  const history = ctx.storeRenderHistory;
  const expressions = takeInitialValueRecords(ctx, history);
  const selected = rendered.history, originalValues = ctx.statementRenderHistory.canonical;
  const canonical = selected && expressions.length ? Object.freeze({ ...selected,
    isCurrent:() => selected.isCurrent() && originalValues?.isCurrent() === true })
    : selected || (expressions.length && originalValues ? Object.freeze({ isCurrent:() => originalValues.isCurrent() }) : null);
  if (!canonical) return;
  const record = rendered.history ? Object.freeze({ rule:'render-initial-compound-store', phase:'initial-semantic-render',
    before:'store:assignment', after:`store:${rendered.form}`, valueId:canonical.valueId,
    evidence:Object.freeze({ kind:'observed-store-spelling-not-memory-equivalence',
      detail:'actual initial RMW renderer output, not an independent alias/atomicity/overflow/memory proof' }),
    originHistory:expressionOriginHistory({ source:canonical.source }, { source:canonical.source }),
  }) : null;
  const records = Object.freeze([...(record ? [record] : []), ...expressions]);
  history.events.push({ node, record, records });
  try {
    if (history.consumers <= 0 || history.edges <= 0 || !canonical.isCurrent()) throw new Error('initial-store-binding-unavailable');
    history.consumers--;
    const observation = ctx.projectionIrObserver.capture([node], ctx.opts.shouldAbort);
    history.edges -= observation.metrics.edges;
    if (history.edges < 0 || !canonical.isCurrent()) throw new Error('initial-store-binding-unavailable');
    storeRenderLines.set(node, Object.freeze({ ir:ctx.ir, instruction:inst, canonical, records,
      spelling:Object.freeze({ form:rendered.form || 'assignment', text:node.text }),
      isCurrent:() => canonical.isCurrent() && observation.matches(),
    }));
  } catch (error) { history.edges = 0; history.reasons.add(initialStoreCaptureFailure(error, 'binding')); }
}

function bindStoreRenderHistory(result, ctx) {
  const history = ctx.storeRenderHistory;
  if (!history.events.length && !history.reasons.size) return result;
  const disposition = Object.freeze({ scope:'initial-store-render-producer',
    completeness:history.reasons.size ? 'incomplete' : 'complete', reasons:Object.freeze([...history.reasons]) });
  result.semanticStoreRenderHistory = disposition;
  storeRenderHistories.set(result, Object.freeze({ ir:ctx.ir, disposition,
    records:Object.freeze([...new Set(history.events.flatMap(event => event.records || [event.record]))]), reasons:disposition.reasons }));
  return result;
}

// Historical display events, not a proof that the suppressed operation is
// semantically dead. Only the actual emitter can issue this private binding.
const suppressionHistories = new WeakMap();
export function readSemanticSuppressionHistory(result) {
  const entry = suppressionHistories.get(result?.ctx?.suppressed);
  return entry && entry.ir === result.ir && entry.disposition === result.semanticSuppressionHistory
    && entry.isCurrent() ? entry : null;
}

function recordSuppression(ctx, inst, reason, rule) {
  ctx.suppressed.push(evidenceOf(inst, reason));
  const history = ctx.suppressionHistory;
  if (history.events.length >= history.limit) { history.reasons.add('semantic-suppression-history-budget'); return; }
  history.events.push({ inst, reason, rule, id:inst.id, row:inst.row, address:inst.address, op:inst.op });
}

function bindSuppressionHistory(result, ctx) {
  const history = ctx.suppressionHistory;
  let observation = null, locations = [];
  const ir = ctx.ir, instructions = ir.instructions;
  try {
    const positions = history.events.length ? new Map(instructions.map((inst, index) => [inst, index])) : new Map();
    locations = history.events.map(event => [positions.get(event.inst), event.inst]);
    if (locations.some(([index]) => index == null)) throw new TypeError('suppression-instruction-unavailable');
    observation = captureProjectionIrData([ctx.suppressed, ...history.events.map(event => event.inst)], ctx.opts.shouldAbort);
    if (history.events.some(event => ['id', 'row', 'address', 'op'].some(key => !Object.is(event[key], event.inst[key])))) {
      throw new TypeError('suppression-source-changed-during-render');
    }
    const maxEdges = ctx.opts.renderProvenanceBindingBudget?.maxEdges;
    if (Number.isSafeInteger(maxEdges) && maxEdges >= 0 && observation.metrics.edges > maxEdges) {
      throw new TypeError('suppression-observation-budget');
    }
  } catch { observation = null; history.reasons.add('semantic-suppression-observation-unavailable'); }
  const records = Object.freeze(observation ? history.events.map(({ id, row, address, reason, rule }) => Object.freeze({
    kind:'display-suppression', proof:'observed-display-event-not-semantic-equivalence', rule,
    targets:Object.freeze([`ir:${id}`]),
    origin:Object.freeze({ addresses:Object.freeze(address == null ? [] : [address]),
      rows:Object.freeze(row == null ? [] : [row]), ir:Object.freeze([id]),
      ssaDefs:Object.freeze([]), ssaUses:Object.freeze([]) }),
    suppressedRender:Object.freeze({ scope:'initial-semantic-render', operation:'omit', reason }),
  })) : []);
  result.semanticSuppressionHistory = Object.freeze({ scope:'semantic-render-producer',
    completeness:history.reasons.size ? 'incomplete' : 'complete', reasons:Object.freeze([...history.reasons]) });
  const disposition = result.semanticSuppressionHistory;
  suppressionHistories.set(ctx.suppressed, Object.freeze({ ir, disposition, records,
    isCurrent() {
      return !!observation && ir.instructions === instructions && locations.every(([index, inst]) =>
        Object.getOwnPropertyDescriptor(instructions, index)?.value === inst) && observation.matches();
    } }));
  return result;
}

function line(kind, indent, text, row = null, addr = null, extra = null) {
  return { kind, indent, text, row, addr, note: null, ...(extra || {}) };
}

function valueOf(a) { return a && a.value ? a.value : null; }
function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}
function paren(s) { return /^[-+]?\w+(?:->\w+|\.\w+|\[[^\]]+\])*$/.test(s) || /^0x[0-9A-F]+$/.test(s) ? s : `(${s})`; }
function isZeroVal(v) {
  return !!v && (v.const === 0n || v.const === 0 || v.reg === 'xzr' || v.reg === 'wzr' || v.reg === 'zr');
}
function unwrapValue(v) {
  let cur = v;
  const seen = new Set();
  while (cur && cur.def && cur.def.op === OP.MOV && cur.def.args?.length === 1 && cur.def.args[0]?.value) {
    // A cyclic MOV chain carries no forward progress; stop instead of looping
    // forever and resolve to the values seen so far.
    if (cur.id != null) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
    }
    const next = cur.def.args[0].value;
    if (next === cur) break;
    cur = next;
  }
  return cur || v;
}
function sameValue(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (isZeroVal(a) && isZeroVal(b)) return true;
  const ua = unwrapValue(a), ub = unwrapValue(b);
  if (ua && ub && ua.id === ub.id) return true;
  if (isZeroVal(ua) && isZeroVal(ub)) return true;
  return false;
}

function sourceForInst(inst, reason = null) {
  if (!inst) return sourceOf();
  return sourceOf({
    address: inst.address ?? null, row: inst.row ?? null, ir: inst.id ?? null,
    evidence: reason ? [{ reason }] : [],
  });
}

/*
 * A `memory-forward` MOV carries the canonical MemorySSA exact stack-operand
 * proof attached by the v2→v1 projection: its single argument is the exact
 * stored operand identity of the load it replaced. Such a move stands in for
 * the original LOAD, so provenance treats it like that load and its argument
 * like the load's reaching store — an exact identity, not a computed value.
 */
export function isExactOperandForwardMove(def) {
  if (def?.sub !== 'memory-forward' || def?.extra?.originalMemoryOp !== OP.LOAD) return false;
  const proof = def.extra?.memoryOperandForwarding;
  return proof?.status === 'exact' && proof?.exact === true
    && proof?.proofKind === 'canonical-memoryssa-direct-stack-operand-identity'
    && Array.isArray(def.args) && def.args.length === 1;
}

function dependencySource(value, ctx, seen = null, depth = 0) {
  if (!value || depth > MAX_EXPR_DEPTH) return sourceOf();
  const isTopLevel = seen === null && depth === 0;
  if (isTopLevel && ctx?.depSourceCache?.has(value.id)) {
    return ctx.depSourceCache.get(value.id);
  }
  const visited = seen || new Set();
  if (visited.has(value.id)) return sourceOf();
  visited.add(value.id);
  const d = value.def;
  if (!d) {
    const res = sourceOf({ ssaUse: value.id });
    if (isTopLevel && ctx?.depSourceCache) ctx.depSourceCache.set(value.id, res);
    return res;
  }
  const parts = [sourceForInst(d), sourceOf({ ssaDef: value.id })];
  if (d.op === OP.PHI) {
    for (const incoming of d.incoming || []) parts.push(dependencySource(incoming.value, ctx, visited, depth + 1));
  } else if (d.op === OP.LOAD) {
    // A fixed stack slot's SP/FP arithmetic is frame-construction provenance,
    // not source provenance for the value loaded from that slot. Including it
    // makes unrelated prologue instructions (for example 0x...490 STP) appear
    // to own later C statements. Keep the load itself, but stop at the stack
    // memory boundary. Non-stack addressing still retains its base/index defs.
    if (d.loc?.kind !== MK.STACK) {
      parts.push(dependencySource(d.addr?.base, ctx, visited, depth + 1));
      parts.push(dependencySource(d.addr?.index, ctx, visited, depth + 1));
    }
  } else if (isExactOperandForwardMove(d)) {
    // The forwarded operand is the exact stored identity behind the replaced
    // fixed-stack load. Provenance stops here exactly like the stack-load
    // boundary above: the spill/reload plumbing is not source provenance.
  } else {
    for (const arg of d.args || []) parts.push(dependencySource(valueOf(arg), ctx, visited, depth + 1));
  }
  const merged = mergeSource(...parts);
  if (isTopLevel && ctx?.depSourceCache) ctx.depSourceCache.set(value.id, merged);
  return merged;
}

/**
 * HEX-C4-03: a residual goto is a control-flow claim about the block it jumps
 * into, so its provenance is the block's canonical instruction evidence. Blocks
 * with a real terminator use it; otherwise the block's own instruction evidence
 * (row/address/ir id of its last concrete instruction) is the honest bound.
 */
function jumpTargetSource(bi, ctx) {
  const block = ctx?.ir?.blocks?.[bi];
  if (!block) return sourceOf();
  const term = blockTerm(block);
  if (term) return controlSource(term, ctx);
  const insts = block.insts || [];
  return sourceForInst(insts[insts.length - 1] ?? null, 'residual jump target');
}

function controlSource(inst, ctx = null) {
  if (!inst) return sourceOf();
  const flags = valueOf(inst.args?.[inst.args.length - 1]);
  const cmp = cmpFromFlags(flags);
  const parts = [
    sourceForInst(cmp, cmp ? 'condition compare' : null),
    sourceForInst(inst, 'control transfer'),
  ];
  if (ctx && inst.block != null) {
    const block = ctx.ir?.blocks?.[inst.block];
    if (block) {
      const insts = block.insts || [];
      let lastStatementRow = -1;
      for (const i of insts) {
        if (i === inst) break;
        if (i.op === OP.STORE || i.op === OP.CALL || i.op === OP.RET) {
          if (i.row != null && i.row > lastStatementRow) lastStatementRow = i.row;
        }
      }
      for (const i of insts) {
        if (i === inst) break;
        if (i.row != null && i.row > lastStatementRow) {
          if (i.op === OP.LOAD || i.op === OP.CMP || i.op === OP.MOV || i.op === OP.UN || i.op === OP.BIN || i.op === OP.CONST || i.op === OP.SEL || i.op === OP.BFX || i.op === OP.BFI) {
            parts.push(sourceForInst(i));
          }
        }
      }
    }
  }
  return mergeSource(...parts);
}

function storeSource(inst, ctx) {
  return mergeSource(
    dependencySource(valueOf(inst.args?.[0]), ctx),
    dependencySource(inst.addr?.base, ctx),
    dependencySource(inst.addr?.index, ctx),
    sourceForInst(inst, 'memory store'),
  );
}

function callSource(inst, call, ctx) {
  const parts = [sourceForInst(inst, 'call')];
  for (const index of call?.sourceArgIndices || []) {
    parts.push(dependencySource(reachingRegisterValue(ctx.ir, inst, `x${index}`), ctx));
  }
  return mergeSource(...parts);
}

function buildStoredValueAliases(ir) {
  const out = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst.op !== OP.STORE) continue;
    const value = valueOf(inst.args?.[0]);
    if (!value) continue;
    if (!out.has(value.id)) out.set(value.id, []);
    out.get(value.id).push(inst);
  }
  return out;
}

/*
 * Once `v = old_field - damage` has been committed by a STORE, a following CMP
 * of v is a comparison of the new field value. Re-expanding v as
 * `field - damage` after emitting `field -= damage` would apply the subtraction
 * twice in the source program. Alias it back to the committed lvalue only when
 * same-basic-block ordering and the absence of an intervening memory/call
 * barrier prove that substitution safe.
 */
function storedValueAlias(value, atInst, ctx) {
  if (!value || !atInst) return null;
  const stores = ctx.storedValueAliases?.get(value.id) || [];
  for (let n = stores.length - 1; n >= 0; n--) {
    const store = stores[n];
    if (store.block !== atInst.block || store.row == null || atInst.row == null || store.row >= atInst.row) continue;
    const blocked = (ctx.ir.blocks?.[atInst.block]?.insts || []).some((inst) =>
      inst.row > store.row && inst.row < atInst.row && (inst.op === OP.STORE || inst.op === OP.CALL || inst.op === OP.UNKNOWN));
    if (blocked) continue;
    return renderMemoryLocation(store.loc, store, ctx);
  }
  return null;
}

function renderValueAt(value, atInst, ctx) {
  return storedValueAlias(value, atInst, ctx) || renderValue(value, ctx);
}

function canonicalRegister(reg) {
  const text = String(reg || '').toLowerCase();
  const m = /^[wx](\d+)$/.exec(text);
  return m ? `r${m[1]}` : text;
}

function loadReachedByStore(load, store, ctx) {
  if (load?.op !== OP.LOAD || load.loc?.key !== store.loc?.key || load.row <= store.row) return false;
  const fact = load.memoryForwarding;
  if (!isCanonicalExactMemoryForwarding(fact,
    canonicalMemoryForwardingContextForLoad(fact, load,
      load.memoryForwardingContext ?? load.extra?.memoryForwardingContext))) return false;
  const definitionId = store.memDef?.definitionId ?? store.extra?.memoryDefinitionId ?? null;
  return definitionId != null && fact.contributingDefinitionIds.includes(String(definitionId));
}

function returnRegisterForContext(ctx) {
  const type=String(ctx.opts?.returnType || ctx.opts?.functionPrototype?.returnType || ctx.opts?.prototype?.returnType || ctx.types?.ret?.type || '').toLowerCase();
  if (!type || type === 'void') return null;
  // The calling convention owns this, not the decompiler. Assuming `x0` is the
  // result register is an AArch64 fact; on RISC-V `x0` is hardwired zero, so a
  // hardcoded name would read the wrong location entirely. Callers that supply
  // no ABI adapter are the legacy AArch64 IR facade, whose behaviour is kept.
  const adapter = ctx.opts?.abiAdapter || null;
  // A scalar compatibility value is publishable only when the canonical ABI
  // reports exactly one complete register location.  Aggregate returns must
  // remain represented by their complete physical pieces downstream.
  if (typeof adapter?.returnLocations === 'function') {
    let locations = null;
    try { locations = adapter.returnLocations({ returnType:type }); }
    catch { return null; }
    if (!Array.isArray(locations)) return null;
    if (locations.length !== 1 || locations[0]?.kind !== 'register' || locations[0]?.aggregate === true) return null;
    return locations[0]?.reg == null ? null : String(locations[0].reg);
  }
  const fromAbi = adapter?.returnRegister?.({ returnType: type });
  if (fromAbi) return String(fromAbi);
  if (adapter) return null;
  // The v2->v1 compatibility projection is architecture-neutral.  Its
  // canonical ABI adapter is the only authority allowed to publish a return
  // location; a missing adapter therefore stays unknown instead of inheriting
  // the legacy ARM64 x0/v0 convention.
  if (ctx.ir?.compat?.projection === 'semantic-ir-v2-to-v1') return null;
  // Legacy AArch64 IR has no ABI envelope.  Keep this presentation-only
  // fallback for that explicit facade (covered by the legacy compatibility
  // regression), but never let it leak into Semantic IR v2.
  return /^(float|double|__fp16)/.test(type) || /vector|simd/.test(type) ? 'v0' : 'x0';
}

/*
 * Registers whose spill/restore is call-frame bookkeeping rather than program
 * data. The ABI names them; `r29`/`r30` are AArch64's frame pointer and link
 * register and mean nothing on another target.
 */
function frameBookkeepingRegisters(ctx) {
  const declared = ctx.opts?.abiAdapter?.frameBookkeepingRegisters?.();
  if (Array.isArray(declared)) return new Set(declared.map(canonicalRegister));
  if (ctx.opts?.abiAdapter) return new Set();
  // No register-name fallback is valid for an architecture-neutral v2
  // projection.  The legacy r29/r30 view is presentation-only.
  if (ctx.ir?.compat?.projection === 'semantic-ir-v2-to-v1') return new Set();
  return new Set(['r29', 'r30']);
}
function returnValueAt(ret, ctx) {
  const explicit=valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForContext(ctx);
  return reg ? reachingRegisterValue(ctx.ir, ret, reg) : null;
}

function feedsReturn(value, ctx) {
  if (!value) return false;
  for (const ret of ctx.returnInsts || []) {
    const rv = returnValueAt(ret, ctx);
    if (sameValue(value, rv)) return true;
  }
  return false;
}

const LOAD_INDEX_CACHE = new WeakMap();

function getLoadLookupIndex(ir) {
  const instructions = ir?.instructions || [];
  let cached = LOAD_INDEX_CACHE.get(ir);
  if (cached && cached.length === instructions.length && cached.ref === instructions) return cached;
  const memByLocKey = new Map();
  const loadsByForwardingDefId = new Map();
  for (const x of instructions) {
    if (x?.op !== OP.LOAD) continue;
    const locKey = x.loc?.key;
    if (locKey != null) {
      let bucket = memByLocKey.get(locKey);
      if (!bucket) { bucket = []; memByLocKey.set(locKey, bucket); }
      bucket.push(x);
    }
    const defIds = x.memoryForwarding?.contributingDefinitionIds;
    if (Array.isArray(defIds)) {
      for (const id of defIds) {
        const key = String(id);
        let bucket = loadsByForwardingDefId.get(key);
        if (!bucket) { bucket = []; loadsByForwardingDefId.set(key, bucket); }
        if (bucket[bucket.length - 1] !== x) bucket.push(x);
      }
    }
  }
  cached = { length: instructions.length, ref: instructions, memByLocKey, loadsByForwardingDefId };
  LOAD_INDEX_CACHE.set(ir, cached);
  return cached;
}

/* Hide only stack stores whose loads prove register preservation/return spill. */
function isMechanicalStackSpill(inst, ctx) {
  if (inst?.op !== OP.STORE || inst.loc?.kind !== MK.STACK) return false;
  const stored = valueOf(inst.args?.[0]);
  const reg = canonicalRegister(stored?.reg);
  if (reg && frameBookkeepingRegisters(ctx).has(reg)) return true; // frame pointer / return address save
  const definitionId = inst.memDef?.definitionId ?? inst.extra?.memoryDefinitionId ?? null;
  if (definitionId == null) return false;
  const idx = getLoadLookupIndex(ctx.ir);
  const byDef = idx.loadsByForwardingDefId.get(String(definitionId)) || [];
  const byLoc = inst.loc?.key != null ? (idx.memByLocKey.get(inst.loc.key) || []) : byDef;
  const candidates = byDef.length <= byLoc.length ? byDef : byLoc;
  const loads = candidates.filter((x) => loadReachedByStore(x, inst, ctx));
  if (!loads.length) return false;
  return loads.every((load) =>
    (reg && canonicalRegister(load.dst?.reg) === reg) || feedsReturn(load.dst, ctx));
}

// Scanner string text is a display form with tab/CR/LF already written as
// \t, \r, \n. JSON.stringify would double those backslashes and the
// pseudocode showed "%d\\n"; keep the existing escapes single.
function cStringLiteral(text) {
  return JSON.stringify(text).replace(/\\\\([nrt])/g, '\\$1');
}

function stringLiteralAt(addr, ctx) {
  if (addr == null) return null;
  try {
    const direct = ctx.opts.stringFor?.(BigInt(addr));
    if (typeof direct === 'string') return cStringLiteral(direct);
  } catch { /* optional resolver */ }
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(addr)) return cStringLiteral(ref.text); } catch { /* malformed ref */ }
  }
  return null;
}

function stringLiteralForValue(value, ctx) {
  if (value?.const == null) return null;
  const defRow = value.def?.row;
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.row !== defRow || ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(value.const)) return cStringLiteral(ref.text); } catch { /* malformed ref */ }
  }
  // A direct ADR/ADRP value is intrinsically address-like. For arithmetic
  // constants require the exact row+addressRef proof above.
  return value.def?.op === OP.ADDR ? stringLiteralAt(value.const, ctx) : null;
}

function formatFloatConst(v, bits = 64) {
  const n=Number(v);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text=Object.is(n,-0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function formatConst(v, bits = 64, signed = null) {
  if (v == null) return 'unknown';
  return integerText(v, bits, signed);
}

const DOM_DEPTH_CACHE = new WeakMap();

function dominatorDepth(ir, block) {
  if (block == null || block < 0) return 0;
  const blocks = ir?.blocks || [];
  let cached = DOM_DEPTH_CACHE.get(ir);
  if (!cached || cached.blockCount !== blocks.length || cached.idomRef !== ir.idom) {
    cached = { blockCount: blocks.length, idomRef: ir.idom, depths: new Int32Array(blocks.length) };
    DOM_DEPTH_CACHE.set(ir, cached);
  }
  const depths = cached.depths;
  if (block < depths.length && depths[block] > 0) return depths[block];
  const maxSteps = blocks.length + 1;
  let d = 0, b = block, guard = 0;
  const path = [];
  while (b != null && b >= 0 && guard++ <= maxSteps) {
    if (b < depths.length && depths[b] > 0) {
      d += depths[b];
      break;
    }
    path.push(b);
    d++;
    b = ir.idom?.[b] ?? blocks[b]?.idom ?? -1;
  }
  if (guard <= maxSteps) {
    for (let i = 0; i < path.length; i++) {
      const bi = path[i];
      if (bi >= 0 && bi < depths.length) depths[bi] = d - i;
    }
  }
  return d;
}

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

const BLOCK_REACH_CACHE = new WeakMap();
const VALUES_BY_REG_CACHE = new WeakMap();

function getReachableBlockSet(ir, from) {
  let perIr = BLOCK_REACH_CACHE.get(ir);
  const blockCount = ir?.blocks?.length || 0;
  if (!perIr || perIr.blockCount !== blockCount) {
    perIr = { blockCount, map: new Map() };
    BLOCK_REACH_CACHE.set(ir, perIr);
  }
  let seen = perIr.map.get(from);
  if (seen) return seen;
  seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const current = stack.pop();
    const successors = ir.blocks?.[current]?.succ ?? ir.blocks?.[current]?.successors ?? [];
    for (const edge of successors) {
      const next = edge && typeof edge === 'object' ? (edge.to ?? edge.block ?? edge.id) : edge;
      if (next == null || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  perIr.map.set(from, seen);
  return seen;
}

function getValuesByReg(ir) {
  const values = ir?.values || [];
  let cached = VALUES_BY_REG_CACHE.get(ir);
  if (cached && cached.length === values.length) return cached.byReg;
  const byReg = new Map();
  for (const v of values) {
    if (!v?.reg || !v.def) continue;
    let list = byReg.get(v.reg);
    if (!list) { list = []; byReg.set(v.reg, list); }
    list.push(v);
  }
  VALUES_BY_REG_CACHE.set(ir, { length: values.length, byReg });
  return byReg;
}

function blockCanReach(ir, from, to) {
  if (from === to) return true;
  if (from == null || to == null) return false;
  return getReachableBlockSet(ir, from).has(to);
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

export function reachingRegisterValue(ir, atInst, reg) {
  if (!ir || !atInst || !reg) return null;
  const regValues = getValuesByReg(ir).get(reg) || [];
  let best = ir.args?.get?.(reg) || null;
  let bestDepth = -1, bestRow = -Infinity, bestSameBlock = false;
  for (const v of regValues) {
    if (v.reg !== reg || !v.def) continue;
    const d = v.def;
    if (d === atInst) continue;
    if (d.block === atInst.block) {
      if (d.row == null || atInst.row == null || d.row >= atInst.row) continue;
      if (!bestSameBlock || d.row > bestRow) {
        best = v; bestRow = d.row; bestSameBlock = true;
      }
      continue;
    }
    if (bestSameBlock || !defBlockDominates(ir, d.block, atInst.block)) continue;
    const depth = dominatorDepth(ir, d.block);
    if (depth > bestDepth || (depth === bestDepth && (d.row ?? -Infinity) > bestRow)) {
      best = v; bestDepth = depth; bestRow = d.row ?? -Infinity;
    }
  }
  if (bestSameBlock) return best?.clobbered ? null : best;

  const candidateDefinition = best?.def ?? null;
  for (const v of regValues) {
    if (v === best || v.reg !== reg || !v.def) continue;
    const d = v.def;
    if (d === atInst || !definitionCanReachUse(ir, d, atInst)) continue;
    if (definitionMayOverrideCandidate(ir, d, candidateDefinition)) return null;
  }
  return best?.clobbered ? null : best;
}

function objcIvar(ctx, base, offset) {
  const index = ctx.runtime?.objc;
  const t = ctx.types?.values?.get(base?.id);
  const className = t?.className || t?.semanticType?.className || ctx.opts.receiverType || null;
  if (!index || !className) return null;
  let name = String(className).replace(/\s*\*$/, '');
  const seen = new Set();
  while (name && !seen.has(name)) {
    seen.add(name);
    const c = index.classes.get(name);
    if (!c) break;
    for (const iv of c.ivars || []) {
      if (Number(iv.offset) === Number(offset)) return { name: iv.name || `field_${hex(offset)}`, type: iv.type || null, className: name };
    }
    name = c.superName || null;
  }
  return null;
}

function stackName(ctx, loc) {
  const hit = (ctx.ir.stackSlots || []).find((s) => s.key === loc.key || String(s.offset ?? s.disp) === String(loc.disp));
  return hit?.name || `var_${loc.disp < 0n ? 'm' : ''}${hex(loc.disp < 0n ? -loc.disp : loc.disp)}`;
}

function concreteRecoveredType(type) {
  const name = typeNameOf(type);
  return name && name !== 'unknown' ? name : null;
}

function valueTypeThroughCopies(value, ctx, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  const direct = concreteRecoveredType(ctx.types?.values?.get?.(value.id));
  if (direct) { active.delete(value.id); return direct; }
  const def = value.def;
  if (!def || def.op !== OP.MOV) { active.delete(value.id); return null; }
  const sources = (def.args || []).map((arg) => arg?.value).filter(Boolean);
  const names = new Set(sources.map((source) => valueTypeThroughCopies(source, ctx, active)).filter(Boolean));
  active.delete(value.id);
  return names.size === 1 ? [...names][0] : null;
}

function semanticLocalDeclarationType(local, ctx) {
  const funcAddr = ctx.opts.addr ?? ctx.model.instructions?.[0]?.address ?? null;
  try {
    const noteType = ctx.opts.notes?.typeOf?.(funcAddr, local.slot);
    if (noteType && noteType !== 'unknown') return noteType;
  } catch { /* optional user type notes */ }

  const recovered = concreteRecoveredType(local.type) || concreteRecoveredType(local.semanticType);
  if (recovered) return recovered;

  const slot = (ctx.ir.stackSlots || []).find((candidate) =>
    candidate.name === local.slot || Number(candidate.offset ?? candidate.disp ?? NaN) === Number(local.offset));
  if (!slot?.key) return null;

  const observed = new Set();
  for (const inst of ctx.ir.instructions || []) {
    if (inst.loc?.key !== slot.key) continue;
    const value = inst.op === OP.STORE ? inst.args?.[0]?.value : inst.op === OP.LOAD ? inst.dst : null;
    const name = valueTypeThroughCopies(value, ctx);
    if (name) observed.add(name);
    if (observed.size > 1) return null;
  }
  return observed.size === 1 ? [...observed][0] : null;
}

const localDeclarationOwners = new WeakMap();

export function readSemanticLocalDeclaration(node, ir) {
  const owner = localDeclarationOwners.get(node);
  return owner && owner.ir === ir && ir.stackSlots?.includes(owner.slot)
    && owner.slot.key === owner.key && node.text === `${owner.type} ${owner.name};`
    ? owner : null;
}

function semanticLocalDeclarations(types, body, ctx) {
  const text = body.map((item) => item.text || '').join('\n');
  const out = [];
  const seen = new Set();
  for (const local of types.locals || []) {
    const name = String(local.slot || '');
    if (!/^[A-Za-z_]\w*$/.test(name) || seen.has(name)) continue;
    if (!new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text)) continue;
    const type = semanticLocalDeclarationType(local, ctx);
    if (!type) continue;
    seen.add(name);
    const node = line('decl', 1, `${type} ${name};`, null);
    const slot = (ctx.ir.stackSlots || []).find(candidate => candidate.name === local.slot);
    if (slot?.key) localDeclarationOwners.set(node, Object.freeze({ ir:ctx.ir, slot, key:slot.key, name, type }));
    out.push(node);
  }
  for (const [id, name] of ctx.materialNames || []) {
    const value = (ctx.ir.values || []).find((candidate) => candidate.id === id);
    if (value?.def?.op !== OP.LOAD || seen.has(name) || !text.includes(name)) continue;
    const recovered = concreteRecoveredType(ctx.types?.values?.get?.(id));
    const bits = [8, 16, 32, 64].includes(Number(value.bits)) ? Number(value.bits) : 64;
    const type = recovered || `${value.signed === true ? 'int' : 'uint'}${bits}`;
    seen.add(name);
    out.push(line('decl', 1, `${type} ${name};`, null));
  }
  const phiLowering = ctx.phiLowering;
  if (phiLowering) {
    const phiEntries = [
      ...(phiLowering.vars ? phiLowering.vars.values() : []),
      ...(phiLowering.temps ? phiLowering.temps.values() : []),
    ];
    for (const entry of phiEntries) {
      const name = entry?.name;
      if (!name || seen.has(name)) continue;
      if (!new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text)) continue;
      seen.add(name);
      out.push(line('decl', 1, `${entry.type || 'uint64'} ${name};`, null));
    }
  }
  return out;
}

function isReceiverAlias(val, _rec, ctx) {
  const rec = currentCppReceiver(ctx?.opts || {}, ctx?.ir || null);
  return rec ? isCppReceiverAlias(val, rec, ctx?.ir || null) : false;
}

function cppMemberTypeSuffix(base, offset, ctx) {
  const member = currentCppMember(ctx?.opts || {}, ctx?.ir || null, base, offset);
  const label = cppMemberTypeLabel(member);
  return label ? ` /* ${label} */` : '';
}

export function memoryElementType(inst, sizeBytes, types = null) {
  const raw = Number(sizeBytes || 0);
  const bytes = (raw === 1 || raw === 2 || raw === 4 || raw === 8 || raw === 16) ? raw : 8;
  const val = inst?.op === OP.STORE ? inst?.args?.[0]?.value : inst?.dst;
  const inferred = val && types?.values?.get?.(val.id);
  const isFp = inst?.float === true
    || inst?.isFloat === true
    || inst?.extra?.float === true
    || inst?.extra?.isFloat === true
    || inst?.addr?.float === true
    || val?.constKind === 'float'
    || val?.floatConst != null
    || (val?.float != null && val?.const == null)
    || (val?.reg != null && /^[sd]\d+$/i.test(String(val.reg)))
    || inferred?.kind === 'float'
    || inferred?.kind === 'floating'
    || inferred?.cType === 'float'
    || inferred?.cType === 'double'
    || inferred?.name === 'float'
    || inferred?.name === 'double'
    || (typeof inst?.sub === 'string' && /^(?:fldr|fstr|fload|fstore|movss|movsd|vmovss|vmovsd)/i.test(inst.sub))
    || (typeof inst?.mnemonic === 'string' && /^(?:fldr|fstr|movss|movsd|vmovss|vmovsd)/i.test(inst.mnemonic));
  if (isFp && bytes === 4) return 'float';
  if (isFp && bytes === 8) return 'double';
  if (bytes === 16) return 'uint128';
  const isSigned = inst?.signed === true
    || inst?.extra?.signed === true
    || inst?.addr?.signed === true
    || (typeof inst?.sub === 'string' && /^(?:ldrs[bhw]|ldurs[bhw]|sload|signed)/i.test(inst.sub))
    || (typeof inst?.mnemonic === 'string' && /^(?:ldrs[bhw]|ldurs[bhw]|movs[xzb]|movsxd)/i.test(inst.mnemonic))
    || (inst?.op === OP.LOAD && inst?.dst?.signed === true);
  const prefix = isSigned ? 'int' : 'uint';
  return `${prefix}${bytes * 8}_t`;
}

export function renderMemoryLocation(loc, inst, ctx) {
  if (!loc) return 'memory_unknown';
  if (loc.kind === MK.STACK) return stackName(ctx, loc);
  if (loc.kind === MK.GLOBAL) {
    const name = ctx.opts.symbolFor?.(loc.address);
    return name ? safeIdent(name, `global_${hex(loc.address)}`) : `global_${hex(loc.address)}`;
  }
  const addr = inst?.addr || {};
  if (loc.kind === MK.UNKNOWN) {
    if (addr.base && addr.index) {
      const base = renderValue(addr.base, ctx);
      const index = renderValue(addr.index, ctx);
      const scale = Number(addr.scale || 0);
      const size = Number(addr.size || inst?.size || loc?.size || 0);
      const disp = addr.disp != null ? BigInt(addr.disp) : 0n;
      const indexed = renderIndexedMemory(base, index, {
        extend: addr.extend || null,
        scale,
        size,
      });
      const baseType = ctx.types?.values?.get?.(addr.base.id);
      const isPtr = baseType?.kind === 'pointer' && baseType?.cType && baseType.cType !== 'void *' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(base);
      const scaleBytes = Number.isInteger(scale) && scale >= 0 && scale <= 4 ? (2 ** scale) : -1;
      const elemType = memoryElementType(inst, size, ctx.types);
      const idxExpr = renderExtendedIndex(index, addr.extend || null);
      if (!isPtr && size > 0 && scaleBytes === size && disp === 0n) {
        return `((${elemType} *)(uintptr_t)(${base}))[${idxExpr}]`;
      }
      if (size > 0 && scaleBytes > 0 && ((!isPtr && (scaleBytes !== size || disp !== 0n)) || (isPtr && disp !== 0n)) && ctx.opts?.phase8Optimize !== true) {
        const offsetExpr = scaleBytes === 1 ? `(${idxExpr})` : `(${idxExpr}) * ${scaleBytes}`;
        const dispExpr = disp !== 0n ? (disp < 0n ? ` - ${(-disp).toString()}` : ` + ${disp.toString()}`) : '';
        return `*(${elemType} *)((uintptr_t)(${base}) + ${offsetExpr}${dispExpr})`;
      }
      return indexed;
    }
    if (addr.base && addr.disp != null) {
      const cxxRec = ctx.opts?.cxxEvidence?.receiver;
      if (isReceiverAlias(addr.base, cxxRec, ctx)) {
        const off = addr.disp;
        let known = null;
        try { known = ctx.opts.fieldFor?.(addr.baseReg || addr.base?.reg || null, off, inst?.row); } catch { known = null; }
        if (!known) known = objcIvar(ctx, addr.base, off);
        const field = safeIdent(known?.name || `field_${hex(off)}`, `field_${hex(off)}`);
        return `this->${field}${cppMemberTypeSuffix(addr.base, off, ctx)}`;
      }
    }
    if (addr.base && ctx.opts?.phase8Optimize !== true) {
      const base = renderValue(addr.base, ctx);
      const size = Number(addr.size || inst?.size || loc?.size || 8);
      const elemType = memoryElementType(inst, size, ctx.types);
      const disp = addr.disp != null ? BigInt(addr.disp) : 0n;
      if (disp !== 0n) {
        return disp < 0n
          ? `*(${elemType} *)((uintptr_t)(${base}) - ${(-disp).toString()})`
          : `*(${elemType} *)((uintptr_t)(${base}) + ${disp.toString()})`;
      }
      return `*(${elemType} *)(uintptr_t)(${base})`;
    }
    return 'memory_unknown';
  }
  if (loc.kind === MK.FIELD) {
    const base = loc.base || addr.base;
    const off = loc.disp ?? 0n;
    const cxxRec = ctx.opts?.cxxEvidence?.receiver;
    const isReceiver = isReceiverAlias(base, cxxRec, ctx);
    const rawBaseText = isReceiver ? 'this' : renderValue(base, ctx, { asBase: true });
    const baseText = /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawBaseText) ? rawBaseText : `(${rawBaseText})`;
    let known = null;
    try { known = ctx.opts.fieldFor?.(addr.baseReg || base?.reg || null, off, inst?.row); } catch { known = null; }
    if (!known) known = objcIvar(ctx, base, off);
    const field = safeIdent(known?.name || `field_${hex(off)}`, `field_${hex(off)}`);
    const typeSuffix = isReceiver ? cppMemberTypeSuffix(base, off, ctx) : '';
    return `${baseText}->${field}${typeSuffix}`;
  }
  return 'memory_unknown';
}

function argName(v, ctx) {
  const cxxRec = ctx.opts?.cxxEvidence?.receiver;
  if (isReceiverAlias(v, cxxRec, ctx)) return 'this';
  if (!v?.reg) return `v${v?.id ?? 0}`;
  const m = /^x([0-7])$/.exec(v.reg);
  if (!m) return safeIdent(v.label || v.reg);
  const n = Number(m[1]);
  if (n === 0 && (ctx.opts.receiverType || ctx.opts.methodKind === 'objc')) return 'self';
  return ctx.opts.argNames?.[n] || `a${n + 1}`;
}

function cmpFromFlags(flagValue) {
  const d = flagValue?.def;
  return d && d.op === OP.CMP ? d : null;
}

function renderCmp(cmp, cond, ctx, atInst = cmp) {
  if (!cmp) return cond ? `condition_${cond}` : 'condition';
  const aValue = valueOf(cmp.args?.[0]);
  const bValue = valueOf(cmp.args?.[1]);
  const a = renderValueAt(aValue, atInst, ctx);
  const b = renderValueAt(bValue, atInst, ctx);
  const bits = Number(cmp.bits || aValue?.bits || bValue?.bits || 64);
  const rendered = renderNZCVCondition(cmp.sub || 'sub', cond, a, b, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    evidence: [{ reason: `AArch64 ${cmp.sub || 'unknown'} NZCV semantics` }],
  });
  return rendered || `${a} /* ${cond || 'flags'} */`;
}

export function renderBranchCondition(inst, ctx, invert = false) {
  if (!inst || inst.op !== OP.CBR) return 'condition';
  const kind = inst.extra?.kind || inst.sub || '';
  let s;
  if (kind === 'cbz' || kind === 'cbnz') {
    s = `${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} ${kind === 'cbz' ? '==' : '!='} 0`;
  } else if (kind === 'tbz' || kind === 'tbnz') {
    const bit = inst.extra?.bit ?? 0;
    s = `((${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} >> ${bit}) & 1) ${kind === 'tbz' ? '==' : '!='} 0`;
  } else {
    let cond = inst.cond || inst.extra?.cond || null;
    if (!cond || !isNZCVCondition(cond)) {
      return `__arm64_condition_${safeIdent(cond || 'unknown')}(/* NZCV */)`;
    }
    if (invert) {
      const inverse = inverseCondition(cond);
      if (!inverse || !isNZCVCondition(inverse)) {
        return `!(__arm64_condition_${safeIdent(cond)}(/* NZCV */))`;
      }
      cond = inverse;
    }
    const flags = valueOf(inst.args?.[inst.args.length - 1]);
    return renderCmp(cmpFromFlags(flags), cond, ctx, inst);
  }
  return invert ? `!(${s})` : s;
}

function selectAsMinMax(inst, ctx) {
  if (!inst || inst.op !== OP.SEL || inst.args.length < 3) return null;
  const t = valueOf(inst.args[0]), f = valueOf(inst.args[1]), flags = valueOf(inst.args[2]);
  const cmp = cmpFromFlags(flags);
  if (!cmp || cmp.args.length < 2 || cmp.sub !== 'sub' || cmp.extra?.conditional) return null;
  const a = valueOf(cmp.args[0]), b = valueOf(cmp.args[1]);
  const cond = inst.cond;
  const cursor = initialValueCursor(ctx);
  const tt = renderValue(t, ctx), ff = renderValue(f, ctx);
  // These two existing evaluations populate the original expression cache,
  // but their strings are not selected by this min/max producer.
  selectInitialValueTickets(cursor);
  const aa = renderValue(a, ctx), bb = renderValue(b, ctx);
  if (cond === 'gt' || cond === 'hi') {
    if (sameValue(t, b) && sameValue(f, a)) return initialValueForm(ctx, 'select-min', `min(${aa}, ${bb})`);
    if (sameValue(t, a) && sameValue(f, b)) return initialValueForm(ctx, 'select-max', `max(${aa}, ${bb})`);
  }
  if (cond === 'lt' || cond === 'lo') {
    if (sameValue(t, b) && sameValue(f, a)) return initialValueForm(ctx, 'select-max', `max(${aa}, ${bb})`);
    if (sameValue(t, a) && sameValue(f, b)) return initialValueForm(ctx, 'select-min', `min(${aa}, ${bb})`);
  }
  selectInitialValueTickets(cursor);
  return null;
}

function binText(inst, ctx) {
  const a = renderValue(valueOf(inst.args?.[0]), ctx);
  const b = renderValue(valueOf(inst.args?.[1]), ctx);
  const op = {
    add: '+', sub: '-', mul: '*', smull: '*', umull: '*', sdiv: '/', udiv: '/',
    and: '&', or: '|', xor: '^', bic: '& ~', shl: '<<', lshr: '>>', ashr: '>>', ror: 'ror',
    fadd: '+', fsub: '-', fmul: '*', fdiv: '/',
  }[inst.sub];
  if (inst.sub === 'ror') return `ror(${a}, ${b})`;
  if (!op) return `unknown_${safeIdent(inst.sub || 'bin')}(${a}${inst.args?.length > 1 ? ', ' + b : ''})`;
  return `${paren(a)} ${op} ${paren(b)}`;
}

function unaryText(inst, ctx) {
  const a = renderValue(valueOf(inst.args?.[0]), ctx);
  if (inst.sub === 'neg' || inst.sub === 'fneg') return `-${paren(a)}`;
  if (inst.sub === 'not') return `~${paren(a)}`;
  if (inst.sub === 'abs' || inst.sub === 'fabs') return `abs(${a})`;
  if (inst.sub === 'sqrt' || inst.sub === 'fsqrt') return `sqrt(${a})`;
  const extMap = { sxtb: 'int8', sxth: 'int16', sxtw: 'int32', uxtb: 'uint8', uxth: 'uint16', uxtw: 'uint32' };
  if (extMap[inst.sub]) return `(${extMap[inst.sub]})${paren(a)}`;
  if (/^sxt/.test(inst.sub || '')) return `(${inst.sub.replace('sxt', 'int')})${paren(a)}`;
  if (/^uxt/.test(inst.sub || '')) return `(${inst.sub.replace('uxt', 'uint')})${paren(a)}`;
  return `${safeIdent(inst.sub || 'un')}(${a})`;
}

function callRecord(inst, ctx) {
  if (ctx.callCache.has(inst.id)) {
    const trace = initialValueTraces.get(ctx), cursor = initialValueCursor(ctx);
    if (cursor) selectInitialValueTickets(cursor, trace.calls.get(inst.id) || []);
    return ctx.callCache.get(inst.id);
  }
  const target = inst.extra?.target ?? null;
  const modelCall = ctx.callByRow ? (ctx.callByRow.get(inst.row) || null) : ((ctx.model.calls || []).find((c) => c.row === inst.row) || null);
  let name = modelCall?.name || (target != null ? ctx.opts.symbolFor?.(target) : null) || inst.extra?.name || '';
  // A direct call whose target address has neither a symbol nor a model name must keep
  // that proven target explicit. Falling through to renderCall's operand fallback would
  // print the first argument as the callee and drop the only callee identity the IR
  // holds. Address-form naming matches this module's function-header fallback and the
  // legacy renderer (`sub_<HEX>`), and leaves genuinely indirect calls untouched.
  if (!name && target != null) name = `sub_${hex(target)}`;

  const values = [];
  for (let i = 0; i < 8; i++) values.push(reachingRegisterValue(ctx.ir, inst, 'x' + i));
  const slotEv = currentCppVirtualSlot(ctx.opts, ctx.ir, inst, values[0]);

  if (slotEv && slotEv.exactTargetKnown && slotEv.exactTargetAddress != null) {
    const resolved = ctx.opts.symbolFor?.(slotEv.exactTargetAddress) || slotEv.exactTargetName || null;
    if (resolved) {
      name = resolved;
    }
  }
  const cursor = initialValueCursor(ctx), argumentTickets = [];
  const argText = values.map((v) => {
    const input = initialValueCursor(ctx);
    const text = v ? renderValue(v, ctx) : null;
    argumentTickets.push(input ? input.list.slice(input.start) : []);
    return text;
  });
  const origin = runtimeOriginForSymbol(name);
  const objc = origin === 'objc' || /objc_msgSend/.test(name);
  let selector = modelCall?.selector || null;
  let receiverType = null;
  if (objc) {
    const selValue = values[1];
    const selAddr = selValue?.const ?? (selValue?.def?.op === OP.ADDR ? selValue.const : null);
    if (!selector && selAddr != null) selector = ctx.opts.selectorFor?.(selAddr) || ctx.runtime?.selectors?.byAddress?.get(selAddr.toString())?.[0]?.selector || null;
    receiverType = typeNameOf(ctx.types.values.get(values[0]?.id));
    if (receiverType === 'unknown' || receiverType === 'id' || receiverType === 'void *') receiverType = ctx.opts.receiverType || null;
  }

  let logicalArgs = [];
  let sourceArgIndices = [];
  let arityKnown = true;
  let variadicPrefixOnly = false;
  if (objc) {
    const selectorArity = selector ? (selector.match(/:/g) || []).length : null;
    if (selectorArity == null) {
      arityKnown = false;
      sourceArgIndices = [0, 1].filter((i) => values[i]);
    } else {
      const indexes = Array.from({ length: selectorArity }, (_, i) => i + 2).filter((i) => i < 8);
      logicalArgs = indexes.map((i) => argText[i]).filter((x) => x != null);
      sourceArgIndices = [0, 1, ...indexes].filter((i) => values[i]);
    }
  } else {
    let override = null;
    try { override = ctx.opts.callPrototypeFor?.(target, name, inst) || null; } catch { override = null; }
    const knownProto = knownCallPrototype(name);
    let indexes = callArgumentIndices({ name, modelCall, override, defaultCallArgs: ctx.opts.defaultCallArgs });
    if (knownProto && !knownProto.variadic && Array.isArray(indexes) && indexes.length > knownProto.arity) {
      indexes = indexes.slice(0, knownProto.arity);
    }
    if (indexes == null) {
      if (slotEv) {
        if (slotEv.argumentCount != null) {
          logicalArgs = Array.from({ length: slotEv.argumentCount }, (_, i) => argText[i] ?? 'unknown');
          sourceArgIndices = Array.from({ length: slotEv.argumentCount }, (_, i) => i).filter((i) => values[i]);
          arityKnown = true;
        } else {
          // The virtual-dispatch proof establishes the receiver, not the full
          // callee prototype. Preserve receiver readability as a lower bound
          // but keep arity unknown so additional arguments are never erased.
          logicalArgs = values[0] ? [argText[0] || 'this'] : [];
          sourceArgIndices = values[0] ? [0] : [];
          arityKnown = false;
          ctx.unknownCallArities++;
        }
      } else {
        arityKnown = false;
        ctx.unknownCallArities++;
      }
    } else {
      logicalArgs = indexes.map((i) => argText[i] ?? 'unknown');
      sourceArgIndices = indexes.filter((i) => values[i]);
      variadicPrefixOnly = !!knownCallPrototype(name)?.variadic && !override;
    }
  }

  const objcCMode = ctx.opts?.objcSyntax === 'c';
  const objcCallee = /objc_msgSendSuper2/.test(name || '') ? 'objc_msgSendSuper2' : 'objc_msgSend';
  const info = {
    name, target, runtime: origin, args: logicalArgs, arityKnown, variadicPrefixOnly, sourceArgIndices,
    receiver: argText[0] || 'receiver', receiverType, selector,
    ...(objcCMode ? { style: 'c', callee: objcCallee } : {}),
    stubAddress: target, callingConvention: ctx.opts.swiftCallingConventionFor?.(target, name) || null,
    kind: ctx.opts.swiftDispatchFor?.(inst)?.kind || (inst.extra?.indirect ? 'indirect' : 'direct'),
    virtualSlot: slotEv,
    ...(ctx.opts.swiftDispatchFor?.(inst) || {}),
  };
  const resolved = resolveAppleCall(ctx.runtime, info);
  const rec = { ...info, resolved };
  ctx.callCache.set(inst.id, rec);
  const trace = initialValueTraces.get(ctx);
  if (trace) {
    const selected = sourceArgIndices.flatMap(index => argumentTickets[index]);
    if (selected.length) trace.calls.set(inst.id, Object.freeze(selected));
    selectInitialValueTickets(cursor, selected);
  }
  return rec;
}

function renderCall(inst, ctx) {
  const c = callRecord(inst, ctx);
  if (c.resolved.runtime === 'objc' && c.resolved.message) {
    if (ctx.opts?.objcSyntax === 'c' && /^\[/.test(c.resolved.message.text || '')) {
      const callee = c.callee || 'objc_msgSend';
      const cArgs = [c.receiver, JSON.stringify(c.selector), ...(c.args || []).map((a) => String(a).replace(/^@(?=")/, ''))];
      return `${callee}(${cArgs.join(', ')})`;
    }
    return c.resolved.message.text;
  }
  if (c.resolved.runtime === 'swift' && c.resolved.text) return c.resolved.text;
  const name = c.name ? safeIdent(c.name, 'unknown_call') : null;
  if (name) {
    const args = !c.arityKnown
      ? (c.virtualSlot && c.receiver ? `${c.receiver} /* , additional arguments unknown */` : '/* arguments unknown */')
      : c.args.join(', ') + (c.variadicPrefixOnly ? (c.args.length ? ' /* , varargs unknown */' : '/* varargs unknown */') : '');
    return `${name}(${args})`;
  }
  const targetValue = valueOf(inst.args?.[0]);
  if (c.virtualSlot && c.virtualSlot.virtualSlotKnown) {
    const receiver = c.receiver || 'this';
    const args = c.arityKnown
      ? (c.args.length ? c.args.join(', ') : receiver)
      : `${receiver} /* , additional arguments unknown */`;
    return `(*(code **)(...))(${args})`;
  }
  return `unknown_call(${targetValue ? renderValue(targetValue, ctx) : '/* target unknown */'})`;
}

/** Reconstruct one SSA value as an expression with memoization and hard budgets. */
export function renderValue(value, ctx, flags = {}) {
  const trace = initialValueTraces.get(ctx);
  if (!trace) return renderValueText(value, ctx, flags);
  if (trace.remaining <= 0) {
    trace.reasons.add('initial-expression-history-budget');
    // Stop allocating tickets, not evaluating the original renderer. Removing
    // this private observer during the synchronous call also prevents a nested
    // unobserved value from overwriting its parent's selected form.
    initialValueTraces.delete(ctx);
    try { return renderValueText(value, ctx, flags); }
    finally { initialValueTraces.set(ctx, trace); }
  }
  trace.remaining--;
  const parent = trace.active, frame = { form:null, children:[], record:null };
  trace.active = frame;
  try {
    const text = renderValueText(value, ctx, flags);
    try {
      if (!trace.canonical || !frame.form) throw new Error('initial-expression-history-unavailable');
      const own = (object, key) => object == null ? undefined : Object.getOwnPropertyDescriptor(object, key)?.value;
      const definition = own(value, 'def');
      const source = sourceOf({ ir:own(definition, 'id'), address:own(definition, 'address'),
        row:own(definition, 'row'), ssaDef:own(value, 'id') });
      frame.record = Object.freeze({ rule:`render-initial-value-${frame.form}`, phase:'initial-expression-render',
        valueId:own(value, 'id') ?? null, before:'canonical:value', after:`initial-expression:${frame.form}`,
        evidence:Object.freeze({ kind:'observed-initial-expression-not-equivalence',
          detail:'actual initial string-render selection; invocation and canonical identities retained, not a new scalar, memory or ABI proof' }),
        originHistory:expressionOriginHistory({ source }, { source }),
      });
    } catch { trace.reasons.add('initial-expression-history-unavailable'); }
    Object.freeze(frame.children); Object.freeze(frame);
    (parent?.children || trace.roots).push(frame);
    return text;
  } finally { trace.active = parent; }
}

function renderValueText(value, ctx, flags) {
  if (!value) return initialValueForm(ctx, 'unknown', 'unknown');
  const cxxRec = ctx.opts?.cxxEvidence?.receiver;
  if (ctx.materialNames?.has(value.id) && !flags.ignoreMaterial) {
    if (flags.asBase && isReceiverAlias(value, cxxRec, ctx)) return initialValueForm(ctx, 'cxx-this-receiver', 'this');
    return initialValueForm(ctx, 'materialized-reference', ctx.materialNames.get(value.id));
  }
  const key = `${value.id}:${flags.asBase ? 'b' : 'v'}`;
  if (ctx.exprCache.has(key)) {
    const trace = initialValueTraces.get(ctx), cached = trace?.memo.get(key);
    if (trace?.active) {
      if (cached) trace.active.children.push(cached);
      else trace.reasons.add('initial-expression-memo-unavailable');
    }
    return initialValueForm(ctx, 'memo-reuse', ctx.exprCache.get(key));
  }
  if (ctx.exprActive.has(value.id) || ctx.exprNodes++ > MAX_EXPR_NODES) return initialValueForm(ctx, 'bounded-fallback', value.reg ? safeIdent(value.reg) : `v${value.id}`);
  ctx.exprActive.add(value.id);
  let out = null;
  if (flags.asBase && isReceiverAlias(value, cxxRec, ctx)) out = initialValueForm(ctx, 'cxx-this-receiver', 'this');
  if (!out && (value.constKind === 'float' || value.floatConst != null || (value.float != null && value.const == null))) out = initialValueForm(ctx, 'precomputed-float', formatFloatConst(value.floatConst ?? value.float, value.bits));
  if (!out && value.const != null && value.def?.op !== OP.ADDR) out = initialValueForm(ctx, 'precomputed-integer-or-literal', stringLiteralForValue(value, ctx) || formatConst(value.const, value.bits));
  if (!out && value.kind === VK.ARG) out = initialValueForm(ctx, 'argument', argName(value, ctx));
  const d = value.def;
  if (!out && d) {
    if (d.op === OP.CONST) out = initialValueForm(ctx, 'constant-definition', (value.constKind === 'float' || value.floatConst != null || value.float != null)
      ? formatFloatConst(value.floatConst ?? value.float, value.bits)
      : formatConst(value.const ?? d.extra?.value ?? 0n, value.bits, value.signed ?? null));
    else if (d.op === OP.MOV) out = initialValueForm(ctx, 'mov-operand', renderValue(valueOf(d.args?.[0]), ctx));
    else if (d.op === OP.BIN) out = initialValueForm(ctx, 'binary', binText(d, ctx));
    else if (d.op === OP.UN) out = initialValueForm(ctx, 'unary', unaryText(d, ctx));
    else if (d.op === OP.MAC) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b0 = renderValue(valueOf(d.args?.[1]), ctx), c0 = renderValue(valueOf(d.args?.[2]), ctx);
      const widen=d.extra?.widen;
      const b=widen==='signed'?`(int64_t)(int32_t)${paren(b0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(b0)}`:b0;
      const c=widen==='signed'?`(int64_t)(int32_t)${paren(c0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(c0)}`:c0;
      out = initialValueForm(ctx, 'multiply-accumulate', d.sub === 'msub' ? `${paren(a)} - ${paren(b)} * ${paren(c)}` : `${paren(a)} + ${paren(b)} * ${paren(c)}`);
    } else if (d.op === OP.BFX) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? 0;
      if (d.extra?.toward === 'left') out = initialValueForm(ctx, 'bitfield-insert-zero', `${d.extra?.signed?'__arm64_sbfiz':'__arm64_ubfiz'}(${a}, ${l}, ${w})`);
      else out = initialValueForm(ctx, 'bit-extract', `${d.extra?.signed?'__arm64_sbfx':'bit_extract'}(${a}, ${l}, ${w})`);
    } else if (d.op === OP.BFI) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b = renderValue(valueOf(d.args?.[1]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? 0;
      out = initialValueForm(ctx, 'bit-insert', d.extra?.bitfieldKind === 'bfxil' ? `bit_insert(${a}, bit_extract(${b}, ${l}, ${w}), 0, ${w})` : `bit_insert(${a}, ${b}, ${l}, ${w})`);
    } else if (d.op === OP.LOAD) {
      if (isCanonicalExactMemoryForwarding(d.memoryForwarding,
        canonicalMemoryForwardingContextForLoad(d.memoryForwarding, d,
          d.memoryForwardingContext ?? d.extra?.memoryForwardingContext))
          && !flags.noMemoryFold && d.memoryForwarding.value != null) {
        out = initialValueForm(ctx, 'canonical-load-constant', formatConst(d.memoryForwarding.value, value.bits, value.signed ?? null));
      }
      if (!out) out = initialValueForm(ctx, 'memory-load', renderMemoryLocation(d.loc, d, ctx));
    } else if (d.op === OP.SEL) {
      out = selectAsMinMax(d, ctx);
      if (!out) {
        const t = renderValue(valueOf(d.args?.[0]), ctx), f = renderValue(valueOf(d.args?.[1]), ctx);
        const cond = renderCmp(cmpFromFlags(valueOf(d.args?.[2])), d.cond, ctx);
        out = initialValueForm(ctx, 'select-conditional', `(${cond} ? ${t} : ${f})`);
      }
    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      const literal = stringLiteralForValue(value, ctx) || stringLiteralAt(addr, ctx);
      out = initialValueForm(ctx, 'address', literal || (addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown'));
    } else if (d.op === OP.CALL) {
      const canonical = d.dst || ctx.callResultByInst?.get(d) || null;
      if (ctx.opts?.phase8Optimize !== true && value !== canonical && !isSameCallReturnFamily(value.reg, canonical?.reg)) {
        if (isCallClobberedValue(value)) {
          out = initialValueForm(ctx, 'call-clobber', '0');
        } else {
          out = initialValueForm(ctx, 'register-fallback', value.reg ? safeIdent(value.reg) : `v${value.id}`);
        }
      } else {
        out = initialValueForm(ctx, 'call', renderCall(d, ctx));
      }
    }
    else if (d.op === OP.PHI) {
      if (ctx.phiVarNames?.has(value.id) && !flags.ignorePhiVar) {
        out = initialValueForm(ctx, 'phi-variable', ctx.phiVarNames.get(value.id));
      } else {
        const nonSelf = (d.incoming || []).filter((x) => x?.value && x.value.id !== value.id);
        const sourceList = nonSelf.length ? nonSelf : (d.incoming || []);
        const parts = sourceList.map((x) => renderValue(x.value, ctx)).filter(Boolean);
        const uniq = [...new Set(parts)];
        if (uniq.length === 1) out = initialValueForm(ctx, 'phi-deduplication', uniq[0]);
        else out = initialValueForm(ctx, 'phi-multiple', `phi(${uniq.join(', ')})`);
      }
    }
  }
  if (!out) out = initialValueForm(ctx, 'register-fallback', value.reg ? safeIdent(value.reg) : `v${value.id}`);
  ctx.exprActive.delete(value.id);
  ctx.exprCache.set(key, out);
  const trace = initialValueTraces.get(ctx);
  if (trace?.active) trace.memo.set(key, trace.active);
  return out;
}

function targetBlock(ir, cbr, rowOfAddress) {
  // Prefer the taken-edge block the semantic projection already proved. The
  // v2->v1 projection resolves conditional-branch targets from Semantic IR
  // control targets, so the block index is direct evidence and needs no
  // address round-trip. Callers that build IR from a linear listing (the legacy
  // js/ir.js facade) have no such evidence and still resolve by address.
  const provenBlock = cbr?.extra?.targetBlock;
  if (Number.isInteger(provenBlock) && ir.blocks?.[provenBlock] != null) return provenBlock;
  const addr = cbr?.extra?.target;
  if (addr == null) return null;
  const row = rowOfAddress?.(addr);
  if (row == null) return null;
  return ir.blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function branchSucc(ir, block, term, ctx) {
  const succ = block.succ || [];
  if (term?.op !== OP.CBR || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null, exact: term?.op !== OP.CBR };
  const yes = targetBlock(ir, term, ctx.opts.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: null, no: null, exact: false };
  return { yes, no: succ.find((x) => x !== yes) ?? null, exact: true };
}

function blockTerm(block) {
  const xs = block.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if ([OP.CBR, OP.BR, OP.RET].includes(xs[i].op)) return xs[i];
  return null;
}

// A canonical unknown control effect with no CFG successor is still a proven
// control-flow sink: execution does not fall through to another basic block,
// even though the exact destination/behavior is unavailable.  Keep this
// architecture-neutral by consuming only the published unknown category, never
// instruction text or decoder mnemonics.
function opaqueTerminalControlBlock(block, ctx) {
  if (!block || blockTerm(block) != null) return false;
  const insts = block.insts || [];
  const last = insts.at(-1);
  if (!last || last.op !== OP.UNKNOWN) return false;
  const reason = last.extra?.reason ?? last.reason ?? null;
  if (reason !== 'unresolved-indirect-control-flow') return false;
  const categories = last.extra?.unknownCategories ?? last.unknownCategories ?? [];
  if (!Array.isArray(categories) || !categories.includes('control')) return false;

  const succ = block.succ || [];
  if (succ.length === 0) return true;
  if (succ.length !== 1) return false;

  // Canonical Semantic IR represents an unresolved indirect transfer with a
  // typed unknown-control node followed by one synthetic empty successor.  The
  // successor is not executable fallthrough: it is a placeholder for the
  // unknown destination.  Accept that shape only when the placeholder is an
  // empty sink with this block as its sole predecessor.
  const sink = ctx?.ir?.blocks?.[succ[0]];
  if (!sink || (sink.insts || []).length !== 0 || (sink.phis || []).length !== 0
      || (sink.succ || []).length !== 0) return false;
  const predecessors = ctx?.graph?.predecessors?.[sink.index] ?? sink.pred ?? [];
  return predecessors.length === 1 && predecessors[0] === block.index;
}

function terminalProofExit(block, ctx) {
  const term = blockTerm(block), succ = block?.succ || [];
  if (term?.op === OP.RET && succ.length === 0) return 'return';
  if (opaqueTerminalControlBlock(block, ctx)) return 'opaque-control';
  return null;
}

function provenBranchPredicate(inst) {
  if (inst?.op !== OP.CBR) return false;
  const kind = inst.extra?.kind || inst.sub || '';
  if (kind === 'cbz' || kind === 'cbnz' || kind === 'tbz' || kind === 'tbnz') {
    return valueOf(inst.args?.[0]) != null;
  }
  const cond = inst.cond || inst.extra?.cond || null;
  return isNZCVCondition(cond) && cmpFromFlags(valueOf(inst.args?.[inst.args.length - 1])) != null;
}

// This does not discover a loop.  It only checks whether the canonical
// natural-loop record already attached to ctx.graph can safely be reached as
// the continuation of a terminal conditional arm.  In particular, a source
// `if (c) return; <loop>` is allowed to expose the already-proven loop, while
// a side entry, an early exit, or a nested owner remains faithful CFG output.
//
// The initial renderer owns loop construction, so keep this proof local to the
// one new control-flow composition rather than deriving a second loop view.
function provenNaturalLoopContinuation(outerHeader, continuation, ctx, state, allowed = null) {
  if (state.activeLoop != null || continuation == null) return null;
  const graph = ctx.graph;
  const blocks = ctx.ir.blocks || [];
  const continuationBlock = blocks[continuation];
  if (graph.loopAnalysis?.complete !== true || !continuationBlock
      || !provenBranchPredicate(blockTerm(blocks[outerHeader]))) return null;

  let loop = graph.loopByHeader?.get(continuation) ?? null;
  let loopHeader = continuation;
  let preheader = null;
  if (!loop) {
    const targets = continuationBlock.succ || [];
    if (targets.length !== 1) return null;
    loopHeader = targets[0];
    loop = graph.loopByHeader?.get(loopHeader) ?? null;
    preheader = continuation;
  }
  if (!loop || loop.header !== loopHeader || !loop.nodes?.has?.(loopHeader) || !loop.latches?.has?.(loopHeader)) return null;

  const nodes = loop.nodes;
  const latches = [...loop.latches];
  const exits = [...(loop.exits || [])];
  const loopHeaderBlock = blocks[loopHeader];
  const term = blockTerm(loopHeaderBlock);
  if (!loopHeaderBlock || latches.length !== 1 || latches[0] !== loopHeader
      || exits.length !== 1 || term?.op !== OP.CBR || !provenBranchPredicate(term)
      || (loopHeaderBlock.succ || []).length !== 2) return null;

  // This lane handles the canonical self-latch form only.  Normal and nested
  // natural loops continue through the established loop renderer; accepting a
  // second owner here would risk moving a child exit onto the parent loop.
  if (nodes.size !== 1 || nodes.has(continuation) && continuation !== loopHeader) return null;
  if (preheader != null) {
    const predecessors = graph.predecessors?.[preheader] || [];
    if (predecessors.length !== 1 || predecessors[0] !== outerHeader) return null;
  }

  const exit = exits[0];
  const internalSuccessors = (loopHeaderBlock.succ || []).filter((target) => nodes.has(target));
  const outsideSuccessors = (loopHeaderBlock.succ || []).filter((target) => !nodes.has(target));
  if (internalSuccessors.length !== 1 || internalSuccessors[0] !== loopHeader
      || outsideSuccessors.length !== 1 || outsideSuccessors[0] !== exit) return null;

  // Header dominance/back-edge membership are already canonical graph facts,
  // but bind this transformation to those exact facts instead of treating a
  // self branch as sufficient proof by itself.
  if (graph.dominators?.[loopHeader]?.has?.(loopHeader) !== true
      || !graph.backEdges?.some?.((edge) => edge.from === loopHeader && edge.to === loopHeader)) return null;

  // A loop has one source entry here: the direct continuation path.  A branch
  // to any non-header member, or an extra header predecessor, would make the
  // source placement below hide an independent entry.
  const headerPredecessors = graph.predecessors?.[loopHeader] || [];
  const outsidePredecessors = headerPredecessors.filter((predecessor) => !nodes.has(predecessor));
  const expectedEntry = preheader ?? outerHeader;
  if (outsidePredecessors.length !== 1 || outsidePredecessors[0] !== expectedEntry) return null;
  for (const node of nodes) {
    for (const predecessor of graph.predecessors?.[node] || []) {
      if (!nodes.has(predecessor) && node !== loopHeader) return null;
    }
  }

  // Do not compose through a child/parent ownership boundary.  This is an
  // ownership check over the existing loop set, not a new loop detector.
  for (const candidate of graph.loops || []) {
    if (candidate === loop || !candidate?.nodes || candidate.nodes.size <= nodes.size) continue;
    if ([...nodes].every((node) => candidate.nodes.has(node))) return null;
  }

  // A header store/call/unknown would be emitted outside the while by the
  // established renderer.  Refuse it here rather than moving or duplicating a
  // side effect.  Loads are also rejected because this proof does not establish
  // their fault/volatile behaviour independently of the source header.
  if ((loopHeaderBlock.insts || []).some((inst) => [OP.STORE, OP.CALL, OP.LOAD, OP.UNKNOWN].includes(inst.op))) return null;

  // The renderer expresses a self-latch by re-evaluating the header condition.
  // Every phi must therefore have exactly the proven external entry and the
  // canonical self back-edge; an unaccounted incoming edge is rejected.
  for (const phi of loopHeaderBlock.phis || []) {
    const incoming = phi?.incoming || [];
    if (incoming.length !== 2) return null;
    const outside = incoming.filter((edge) => !nodes.has(edge.from));
    const inside = incoming.filter((edge) => nodes.has(edge.from));
    if (outside.length !== 1 || outside[0].from !== expectedEntry
        || inside.length !== 1 || inside[0].from !== loopHeader) return null;
  }

  if ([...nodes].some((node) => state.visited.has(node))) return null;
  if (allowed && (![...nodes, exit].every((node) => allowed.has(node)))) return null;

  const budget = state.terminalProofBudget;
  const proofCost = 8 + (loopHeaderBlock.phis || []).length * 2;
  if (!budget || budget.remaining < proofCost) return null;
  budget.remaining -= proofCost;
  return { loop, header:loopHeader, exit, preheader };
}

// Some reducible conditionals do not have a concrete post-dominator because
// one nested path returns before a shared continuation/cleanup is reached.  If
// one direct successor can be used as that continuation, prove that the other
// arm is a closed acyclic region whose only exits are either the continuation
// or explicit returns.  This recovers source-level early-exit shapes without
// pretending the continuation post-dominates the header.
function earlyExitConditionalContinuation(header, yes, no, ctx, state, stop = null, allowed = null) {
  if (yes == null || no == null || yes === no) return null;
  const reachable = ctx.graph.reachable || new Set();
  const predecessors = ctx.graph.predecessors || [];
  const proofBudget = state.terminalProofBudget;
  if (!proofBudget || proofBudget.remaining <= 0) return null;

  const candidates = [
    { bodyStart:yes, continuation:no, invert:false },
    { bodyStart:no, continuation:yes, invert:true },
  ];
  for (const candidate of candidates) {
    const { bodyStart, continuation } = candidate;
    if (continuation === header || state.visited.has(continuation)) continue;
    if (allowed && (!allowed.has(bodyStart) || !allowed.has(continuation))) continue;

    const done = new Set(), active = new Set();
    let work = 0, reachedContinuation = false, sawTerminalExit = false, failed = false;
    function visit(bi) {
      if (bi === continuation) { reachedContinuation = true; return true; }
      if (++work > MAX_BLOCKS || proofBudget.remaining-- <= 0 || bi === header || state.visited.has(bi)) return false;
      if (allowed && !allowed.has(bi)) return false;
      if (active.has(bi)) return false;
      if (done.has(bi)) return true;
      const block = ctx.ir.blocks[bi];
      if (!block) return false;
      active.add(bi);
      const term = blockTerm(block), succ = block.succ || [], terminalExit = terminalProofExit(block, ctx);
      if (terminalExit) {
        sawTerminalExit = true;
      } else {
        if (term?.op === OP.BR && succ.length !== 1) failed = true;
        else if (term?.op === OP.CBR && succ.length !== 2) failed = true;
        else if (!term && succ.length !== 1) failed = true;
        else if (term && ![OP.BR, OP.CBR].includes(term.op)) failed = true;
        else if (!succ.length) failed = true;
        if (!failed) for (const next of succ) if (!visit(next)) { failed = true; break; }
      }
      active.delete(bi);
      if (failed) return false;
      done.add(bi); return true;
    }
    if (!visit(bodyStart) || !sawTerminalExit) continue;
    // Mixed exit-to-continuation + return is the shared-cleanup case.  When
    // structuring inside an already bounded region, a purely terminal arm is
    // also safe if the sibling successor is itself proven to reach that bound.
    const continuationReachesStop = stop != null && (continuation === stop
      || ctx.graph.postDominators?.[continuation]?.has?.(stop) === true);
    const loopContinuation = !reachedContinuation && !continuationReachesStop
      ? provenNaturalLoopContinuation(header, continuation, ctx, state, allowed) : null;
    if (!reachedContinuation && !continuationReachesStop && !loopContinuation) continue;

    let closed = true;
    for (const bi of done) {
      for (const pred of predecessors[bi] || []) {
        if (!reachable.has(pred) || done.has(pred)) continue;
        if (bi === bodyStart && pred === header) continue;
        closed = false; break;
      }
      if (!closed) break;
    }
    if (!closed) continue;
    return { ...candidate, bodyBlocks:done, loopContinuation };
  }
  return null;
}

// A conditional can have a real shared continuation without that continuation
// post-dominating the header: an early-return path may bypass it.  Find the
// nearest common reachable continuation and prove each pre-continuation arm is
// closed and acyclic, with every path ending either at that continuation or an
// explicit return.  This is deliberately narrower than general region
// structuring and rejects side entries, cycles, and ambiguous shared prefixes.
function sharedEarlyExitContinuation(header, yes, no, ctx, state, allowed = null) {
  if (yes == null || no == null || yes === no) return null;
  const reachable = ctx.graph.reachable || new Set();
  const predecessors = ctx.graph.predecessors || [];
  const dominators = ctx.graph.dominators || [];
  const proofBudget = state.terminalProofBudget;
  if (!proofBudget || proofBudget.remaining <= 0) return null;

  function distances(start) {
    const dist = new Map([[start, 0]]), queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const bi = queue[qi];
      if (proofBudget.remaining-- <= 0) return null;
      if (bi === header || state.visited.has(bi) || (allowed && !allowed.has(bi))) continue;
      const block = ctx.ir.blocks[bi];
      if (!block || blockTerm(block)?.op === OP.RET) continue;
      for (const next of block.succ || []) {
        if (next === header || state.visited.has(next) || (allowed && !allowed.has(next))) continue;
        if (!dist.has(next)) { dist.set(next, dist.get(bi) + 1); queue.push(next); }
      }
    }
    return dist;
  }

  const yesDist = distances(yes), noDist = distances(no);
  if (!yesDist || !noDist) return null;
  const candidates = [...yesDist.keys()].filter((bi) => noDist.has(bi)
    && bi !== header && !state.visited.has(bi)
    && (!allowed || allowed.has(bi))
    && dominators[bi]?.has?.(header) === true)
    .sort((a, b) => Math.max(yesDist.get(a), noDist.get(a)) - Math.max(yesDist.get(b), noDist.get(b))
      || yesDist.get(a) + noDist.get(a) - yesDist.get(b) - noDist.get(b)
      || (ctx.ir.blocks[a]?.startRow ?? a) - (ctx.ir.blocks[b]?.startRow ?? b));

  function proveArm(start, continuation) {
    const done = new Set(), active = new Set();
    let reachedContinuation = false, sawTerminalExit = false;
    function visit(bi) {
      if (bi === continuation) { reachedContinuation = true; return true; }
      if (proofBudget.remaining-- <= 0 || bi === header || state.visited.has(bi)) return false;
      if (allowed && !allowed.has(bi)) return false;
      if (active.has(bi)) return false;
      if (done.has(bi)) return true;
      if (dominators[bi]?.has?.(header) !== true) return false;
      const block = ctx.ir.blocks[bi];
      if (!block) return false;
      active.add(bi);
      const term = blockTerm(block), succ = block.succ || [], terminalExit = terminalProofExit(block, ctx);
      if (terminalExit) {
        sawTerminalExit = true;
      } else {
        if (term?.op === OP.BR && succ.length !== 1) return false;
        if (term?.op === OP.CBR && succ.length !== 2) return false;
        if (!term && succ.length !== 1) return false;
        if (term && ![OP.BR, OP.CBR].includes(term.op)) return false;
        if (!succ.length) return false;
        for (const next of succ) if (!visit(next)) return false;
      }
      active.delete(bi); done.add(bi); return true;
    }
    return visit(start) && reachedContinuation ? { blocks:done, sawTerminalExit } : null;
  }

  for (const continuation of candidates.slice(0, 32)) {
    const yesArm = proveArm(yes, continuation), noArm = proveArm(no, continuation);
    if (!yesArm || !noArm || (!yesArm.sawTerminalExit && !noArm.sawTerminalExit)) continue;
    let overlap = false;
    for (const bi of yesArm.blocks) if (noArm.blocks.has(bi)) { overlap = true; break; }
    if (overlap) continue;

    const body = new Set([...yesArm.blocks, ...noArm.blocks]);
    let closed = true;
    for (const [entry, nodes] of [[yes, yesArm.blocks], [no, noArm.blocks]]) {
      for (const bi of nodes) {
        for (const pred of predecessors[bi] || []) {
          if (!reachable.has(pred) || nodes.has(pred)) continue;
          if (bi === entry && pred === header) continue;
          closed = false; break;
        }
        if (!closed) break;
      }
      if (!closed) break;
    }
    if (!closed) continue;
    // The continuation itself must not have a reachable side entry outside
    // the two proven arms; otherwise moving it after the if/else hides a real
    // control-flow entry.
    for (const pred of predecessors[continuation] || []) {
      if (!reachable.has(pred) || body.has(pred)) continue;
      if (pred === header && (continuation === yes || continuation === no)) continue;
      closed = false; break;
    }
    if (!closed) continue;
    return { continuation, yesBlocks:yesArm.blocks, noBlocks:noArm.blocks };
  }
  return null;
}

// A conditional whose arms never reconverge has no concrete post-dominator,
// but it can still be represented as a source-level if/else when both arms are
// closed, acyclic regions whose every path ends in an explicit return.  Keep
// this proof deliberately narrower than general SESE structuring: it must not
// absorb shared tails, loop paths, or another reachable entry into either arm.
function terminalConditionalPartition(header, yes, no, ctx, state, allowed = null) {
  if (yes == null || no == null || yes === no) return null;
  const reachable = ctx.graph.reachable || new Set();
  const predecessors = ctx.graph.predecessors || [];
  const proofBudget = state.terminalProofBudget;
  if (!proofBudget || proofBudget.remaining <= 0) return null;

  function collect(start) {
    const done = new Set(), active = new Set();
    let work = 0;
    function visit(bi) {
      if (++work > MAX_BLOCKS || proofBudget.remaining-- <= 0 || bi === header || state.visited.has(bi)) return false;
      if (allowed && !allowed.has(bi)) return false;
      if (active.has(bi)) return false;
      if (done.has(bi)) return true;
      const block = ctx.ir.blocks[bi];
      if (!block) return false;
      active.add(bi);
      const term = blockTerm(block), succ = block.succ || [], terminalExit = terminalProofExit(block, ctx);
      if (terminalExit) {
        // The sink itself is emitted normally.  The proof only establishes
        // that no successor edge can escape this arm.
      } else {
        if (term?.op === OP.BR && succ.length !== 1) return false;
        if (term?.op === OP.CBR && succ.length !== 2) return false;
        if (!term && succ.length !== 1) return false;
        if (term && ![OP.BR, OP.CBR].includes(term.op)) return false;
        if (!succ.length) return false;
        for (const next of succ) if (!visit(next)) return false;
      }
      active.delete(bi); done.add(bi); return true;
    }
    return visit(start) ? done : null;
  }

  const yesBlocks = collect(yes), noBlocks = collect(no);
  if (!yesBlocks || !noBlocks) return null;
  for (const bi of yesBlocks) if (noBlocks.has(bi)) return null;

  const closedEntry = (nodes, entry) => {
    for (const bi of nodes) {
      for (const pred of predecessors[bi] || []) {
        if (!reachable.has(pred) || nodes.has(pred)) continue;
        if (bi === entry && pred === header) continue;
        return false;
      }
    }
    return true;
  };
  if (!closedEntry(yesBlocks, yes) || !closedEntry(noBlocks, no)) return null;
  return { yesBlocks, noBlocks };
}

function materialization(ctx) {
  const names = new Map();
  const instructions = ctx.ir.instructions || [];
  const position = new Map(instructions.map((inst, index) => [inst, index]));
  const strongPrefix = new Array(instructions.length + 1).fill(0);
  const storePositions = [];
  const strongOrderingBarrier = (inst) => inst?.op === OP.CALL ||
    inst?.op === OP.CLOBBER || inst?.op === OP.UNKNOWN;
  for (let i = 0; i < instructions.length; i++) {
    strongPrefix[i + 1] = strongPrefix[i] + (strongOrderingBarrier(instructions[i]) ? 1 : 0);
    if (instructions[i]?.op === OP.STORE) storePositions.push(i);
  }
  const barrierBetween = (load, current, from, to) => {
    if (to <= from + 1) return false;
    if (strongPrefix[to] - strongPrefix[from + 1] > 0) return true;
    let lo = 0, hi = storePositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (storePositions[mid] <= from) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < storePositions.length; k++) {
      const index = storePositions[k];
      if (index >= to) break;
      const store = instructions[index];
      if (!mayAliasProvenance(load?.loc, store?.loc)) continue;
      // Even a store of the same SSA value is an ordering barrier. Re-rendering
      // a prior load after that store would introduce a second memory observation
      // that did not exist in the machine program (and is observably wrong for
      // MMIO/faulting memory). Preserve the original load instead.
      return true;
    }
    return false;
  };
  const crossesBarrier = (value) => {
    const def = value?.def;
    const di = position.get(def);
    if (di == null) return false;
    const originBlock = def.block;
    const seenValues = new Set();
    const queue = [value];
    while (queue.length) {
      const current = queue.pop();
      if (!current || seenValues.has(current.id)) continue;
      seenValues.add(current.id);
      for (const use of current.uses || []) {
        if (use === current.def || use?.clobbered) continue;
        const ui = position.get(use);
        if (ui == null || ui <= di) continue;
        // Moving an observation into another Basic Block can make it conditional
        // (or move it to another path), changing faults/MMIO semantics even if
        // no explicit store/call sits between the two textual rows.
        if (use.block !== originBlock) return true;
        const currentDef = current.def || def;
        const currentIndex = position.get(currentDef);
        if (currentIndex != null && barrierBetween(def, current, currentIndex, ui)) return true;
        // Follow pure SSA transforms transitively. A load feeding add/cmp/select
        // can otherwise appear safe at its direct use while the derived value is
        // finally consumed only after a side-effect barrier.
        if (use.dst && use.op !== OP.CALL && use.op !== OP.LOAD &&
            use.op !== OP.STORE && use.op !== OP.CLOBBER && use.op !== OP.UNKNOWN) {
          queue.push(use.dst);
        }
      }
    }
    return false;
  };
  for (const v of ctx.ir.values || []) {
    if (!v.def) continue;
    const meaningfulUses = (v.uses || []).filter((u) => u !== v.def && !u.clobbered);
    if (!meaningfulUses.length) continue;
    if (v.def.op === OP.CALL) {
      names.set(v.id, `call_${v.id}`);
      continue;
    }
    /*
     * A load is an observation at a specific point in the machine program.
     * Re-rendering that load only at a later consumer is unsound across a call,
     * store, unknown effect or explicit clobber: the intervening operation may
     * change the memory being observed. Preserve the observation by binding it
     * at the original load. Pure values remain freely inlineable.
     */
    if (v.def.op === OP.LOAD && crossesBarrier(v)) names.set(v.id, `load_${v.id}`);
  }
  return names;
}

const CALL_INT_RETURN_REG_ORDER = [
  'x0', 'w0', 'rax', 'eax', 'ax', 'al', 'r0', 'a0', 'x10',
];
const CALL_FP_RETURN_REG_ORDER = [
  'd0', 's0', 'v0', 'q0', 'h0', 'b0', 'xmm0', 'ymm0', 'zmm0', 'fa0', 'f10', 'st0',
];
const CALL_RETURN_REG_ORDER = [
  ...CALL_INT_RETURN_REG_ORDER,
  ...CALL_FP_RETURN_REG_ORDER,
];
const CALL_FP_FIRST_REG_ORDER = [
  ...CALL_FP_RETURN_REG_ORDER,
  ...CALL_INT_RETURN_REG_ORDER,
];
const CALL_INT_RETURN_REGS = new Set(CALL_INT_RETURN_REG_ORDER);
const CALL_FP_RETURN_REGS = new Set(CALL_FP_RETURN_REG_ORDER);
const CALL_MULTI_RETURN_REGS = new Set([
  'x1', 'w1', 'rdx', 'edx', 'dx', 'dl', 'r1', 'a1', 'x11',
  'd1', 's1', 'v1', 'q1', 'h1', 'b1',
  'd2', 's2', 'v2', 'q2', 'h2', 'b2',
  'd3', 's3', 'v3', 'q3', 'h3', 'b3',
  'xmm1', 'ymm1', 'zmm1', 'fa1', 'f11', 'st1',
]);

function callReturnRegFamily(reg) {
  if (!reg) return null;
  const r = String(reg).toLowerCase();
  if (CALL_INT_RETURN_REGS.has(r)) return 'int';
  if (CALL_FP_RETURN_REGS.has(r)) return 'fp';
  return null;
}

export function isSameCallReturnFamily(aReg, bReg) {
  if (!aReg || !bReg) return false;
  const a = String(aReg).toLowerCase();
  const b = String(bReg).toLowerCase();
  if (a === b) return true;
  const fa = callReturnRegFamily(a);
  return fa != null && fa === callReturnRegFamily(b);
}

export function isCallClobberedValue(v) {
  if (!v) return false;
  if (v.clobbered === true) return true;
  if (v.kind === VK.UNDEF && v.unknown === true) {
    const r = String(v.reg || '').toLowerCase();
    if (r && !CALL_INT_RETURN_REGS.has(r) && !CALL_FP_RETURN_REGS.has(r) && !CALL_MULTI_RETURN_REGS.has(r)) {
      return true;
    }
  }
  return false;
}

function callCalleeNameForOrder(inst, opts = null) {
  if (!inst) return null;
  if (inst.extra?.name) return inst.extra.name;
  const fromRow = opts?.callByRow?.get?.(inst.row)?.name;
  if (fromRow) return fromRow;
  const target = inst.extra?.target ?? inst.target;
  if (target != null && opts?.symbolFor) {
    try { return opts.symbolFor(target) || null; } catch { return null; }
  }
  return null;
}

export function buildCallResultMap(ir, materialNames = null, opts = null) {
  const byInst = new Map();
  const candidatesByInst = new Map();
  for (const v of ir?.values || []) {
    const def = v?.def;
    if (!def || def.op !== OP.CALL) continue;
    if (def.dst === v) {
      byInst.set(def, v);
      continue;
    }
    if (materialNames) {
      if (!materialNames.has(v.id)) continue;
    } else if (!(v.uses || []).some((u) => u !== def && !u.clobbered)) {
      continue;
    }
    let list = candidatesByInst.get(def);
    if (!list) {
      list = [];
      candidatesByInst.set(def, list);
    }
    list.push(v);
  }
  for (const [inst, list] of candidatesByInst) {
    if (byInst.has(inst)) continue;
    if (inst.dst) {
      byInst.set(inst, inst.dst);
      continue;
    }
    if (inst.returnReg) {
      const targetReg = String(inst.returnReg).toLowerCase();
      const exact = list.find((v) => String(v.reg || '').toLowerCase() === targetReg);
      if (exact) {
        byInst.set(inst, exact);
        continue;
      }
    }
    const calleeName = callCalleeNameForOrder(inst, opts);
    const sig = calleeName ? knownCallSignature(calleeName) : null;
    const prefersFp = sig?.retType === 'float' || sig?.retType === 'double' || sig?.retType === 'long double';
    const order = prefersFp ? CALL_FP_FIRST_REG_ORDER : CALL_RETURN_REG_ORDER;
    let picked = null;
    for (const reg of order) {
      const match = list.find((v) => String(v.reg || '').toLowerCase() === reg);
      if (match) {
        picked = match;
        break;
      }
    }
    if (!picked && list.length === 1 && !list[0].reg) {
      picked = list[0];
    }
    if (picked) byInst.set(inst, picked);
  }
  return byInst;
}

function callResultValue(inst, ctx) {
  if (!inst) return null;
  if (inst.dst) return ctx.materialNames.has(inst.dst.id) ? inst.dst : null;
  const candidate = ctx.callResultByInst?.get(inst) || null;
  return candidate && ctx.materialNames.has(candidate.id) ? candidate : null;
}

function rmwOperand(rmw, ctx) {
  void ctx;
  const loadValue=rmw.load?.dst;
  const written=valueOf(rmw.store?.args?.[0]);
  // Width/cast copies sit between the computed arithmetic value and the store
  // (the apply_damage store is `mov trunc` of the `sub`), so follow the same
  // one-argument MOV chain the operand comparison below uses. A cyclic chain
  // cannot reach arithmetic; only exact BIN identity counts.
  const updateRoot=unwrapValue(written);
  const inst=updateRoot?.def;
  if (!inst || inst.op !== OP.BIN || !['add','sub','mul','sdiv','udiv'].includes(inst.sub)) return null;
  const a=valueOf(inst.args?.[0]), b=valueOf(inst.args?.[1]);
  if (sameValue(a,loadValue)) return { op:inst.sub, other:b, reversed:false };
  if (sameValue(b,loadValue)) return { op:inst.sub, other:a, reversed:true };
  return null;
}

const compoundAdmissionCache = new WeakMap();
/**
 * The compound-spelling admission the initial emitter itself uses for a store:
 * the read/modify/write proof for this exact store, no select in the update
 * chain, and a direct non-reversed qualifying update reached through only
 * one-argument MOV copies (a MOV cycle, or any non-MOV step between the
 * computed arithmetic and the store, keeps the plain assignment spelling).
 * The C AST store renderer consults
 * this same authority so display spelling and initial history can never drift:
 * re-deriving compound eligibility from the collapsed expression alone would
 * spell compound assignments the initial renderer refused.
 */
export function readSemanticStoreCompoundAdmission(ir, store) {
  if (!ir || !store) return null;
  let entries = compoundAdmissionCache.get(ir);
  if (!entries) { entries = readModifyWrite(ir); compoundAdmissionCache.set(ir, entries); }
  const rmw = entries.find((entry) => entry.store === store || entry.store?.id === store?.id);
  if (!rmw) return null;
  if ((rmw.chain || []).some((x) => x.op === OP.SEL)) return null;
  const upd = rmwOperand(rmw, null);
  return upd && !upd.reversed ? upd : null;
}

function statementForStore(inst, ctx) {
  const lhs = renderMemoryLocation(inst.loc, inst, ctx);
  const rmw = ctx.rmwByStore.get(inst.id);
  if (rmw) {
    const hasSelect = (rmw.chain || []).some((x) => x.op === OP.SEL);
    const upd = rmwOperand(rmw, ctx);
    if (upd && !hasSelect && !upd.reversed) {
      const history = observeStoreSelection(inst, rmw, upd, ctx);
      const rhs = renderValue(upd.other, ctx);
      const op = { add: '+=', sub: '-=', mul: '*=', sdiv: '/=', udiv: '/=' }[upd.op];
      if (upd.op === 'add' && upd.other?.const === 1n) return { text:`${lhs}++;`, form:'post-increment', history };
      if (upd.op === 'sub' && upd.other?.const === 1n) return { text:`${lhs}--;`, form:'post-decrement', history };
      if (op) return { text:`${lhs} ${op} ${rhs};`, form:`${upd.op}-assignment`, history };
    }
  }
  const rhs = renderValue(valueOf(inst.args?.[0]), ctx, { noMemoryFold: true });
  return { text:`${lhs} = ${rhs};` };
}

function evidenceOf(inst, reason) {
  return { row: inst.row, address: inst.address ?? null, ir: inst.id, op: inst.op, text: inst.text || null, reason };
}

function escapePhiRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function samePhiIncomingValue(a, b) {
  if (sameValue(a, b)) return true;
  const ua = unwrapValue(a), ub = unwrapValue(b);
  if (!ua || !ub) return false;
  if (ua.const != null && ub.const != null && ua.const === ub.const && ua.def?.op !== OP.ADDR && ub.def?.op !== OP.ADDR) {
    return true;
  }
  if (ua.floatConst != null && ub.floatConst != null && Object.is(ua.floatConst, ub.floatConst)) {
    return true;
  }
  return false;
}

function phiVariableType(value, ctx) {
  const safeDeclType = (t) => (t && !/[\[\]()]/.test(t) ? t : null);
  const recovered = safeDeclType(concreteRecoveredType(ctx.types?.values?.get?.(value.id)));
  if (recovered) return recovered;
  if (value.constKind === 'float' || value.floatConst != null || (value.float != null && value.const == null)) {
    return Number(value.bits) === 32 ? 'float' : 'double';
  }
  const incomingTypes = new Set();
  for (const edge of value.def?.incoming || []) {
    if (!edge?.value || edge.value.id === value.id) continue;
    const t = safeDeclType(concreteRecoveredType(ctx.types?.values?.get?.(edge.value.id)));
    if (t) incomingTypes.add(t);
  }
  if (incomingTypes.size === 1) return [...incomingTypes][0];
  const bits = [8, 16, 32, 64].includes(Number(value.bits)) ? Number(value.bits) : 64;
  return `${value.signed === true ? 'int' : 'uint'}${bits}`;
}

function buildPhiLowering(ctx) {
  if (ctx?.opts?.phase8Optimize === true) {
    return { varNames: new Map(), edgeCopies: new Map(), decls: [], skippedPhiIds: new Set(), temps: new Map(), tempCounter: 0, baseReserved: new Set(), reserved: new Set() };
  }
  const ir = ctx.ir;
  const blocks = ir.blocks || [];
  const reachable = ctx.graph?.reachable || new Set(blocks.map((_, i) => i));
  const reserved = new Set();
  for (const local of ctx.types?.locals || []) {
    if (local?.slot) reserved.add(String(local.slot));
  }
  for (const name of ctx.materialNames?.values?.() || []) reserved.add(name);
  for (const iv of ctx.inductions || []) {
    if (iv?.name) reserved.add(iv.name);
  }
  const argCount = ir.args instanceof Map ? ir.args.size : 0;
  for (let i = 1; i <= argCount; i++) reserved.add(`a${i}`);

  const vars = new Map();
  const varNames = new Map();
  const edgeCopies = new Map();

  const allocName = (base) => {
    let name = base;
    let suffix = 1;
    while (reserved.has(name)) name = `${base}_${suffix++}`;
    reserved.add(name);
    return name;
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    if (!reachable.has(bi)) continue;
    const block = blocks[bi];
    if (!block) continue;
    const seenPhiIds = new Set();
    const phis = [...(block.phis || []), ...(block.insts || []).filter((inst) => inst?.op === OP.PHI)];
    for (const phi of phis) {
      if (!phi || phi.op !== OP.PHI || !phi.dst || phi.dst.id == null) continue;
      if (seenPhiIds.has(phi.dst.id)) continue;
      seenPhiIds.add(phi.dst.id);

      const v = phi.dst;
      const meaningfulUses = (v.uses || []).filter((u) => u !== phi && !u?.clobbered);
      if (!meaningfulUses.length) continue;

      const rawIncoming = Array.isArray(phi.incoming) ? phi.incoming.filter((e) => e && e.value != null) : [];
      if (rawIncoming.length < 2) continue;

      let validCfg = true;
      const byPred = new Map();
      for (const edge of rawIncoming) {
        const from = edge.from;
        if (!Number.isInteger(from) || !blocks[from] || !(blocks[from].succ || []).includes(bi)) {
          validCfg = false;
          break;
        }
        if (byPred.has(from)) {
          if (!samePhiIncomingValue(byPred.get(from), edge.value)) {
            validCfg = false;
            break;
          }
        } else {
          byPred.set(from, edge.value);
        }
      }
      if (!validCfg || byPred.size < 2) continue;

      const nonSelf = [...byPred.values()].filter((val) => val.id !== v.id);
      if (nonSelf.length <= 1) continue;
      const first = nonSelf[0];
      if (nonSelf.every((val) => samePhiIncomingValue(val, first))) continue;

      const name = allocName(`phi_${v.id}`);
      const type = phiVariableType(v, ctx);
      vars.set(v.id, { id: v.id, name, type, value: v, phi, block: bi });
      varNames.set(v.id, name);

      for (const [from, val] of byPred) {
        if (!reachable.has(from)) continue;
        const edgeKey = `${from}->${bi}`;
        if (!edgeCopies.has(edgeKey)) edgeCopies.set(edgeKey, []);
        edgeCopies.get(edgeKey).push({ phi, dstId: v.id, dstName: name, dstType: type, value: val });
      }
    }
  }

  return {
    vars,
    varNames,
    edgeCopies,
    reserved,
    baseReserved: new Set(reserved),
    temps: new Map(),
    tempCounter: 0,
    skippedPhiIds: new Set(),
  };
}

function exprReferencesIdent(expr, ident) {
  if (!expr || !ident || !expr.includes(ident)) return false;
  const stripped = expr.replace(/"(?:\\.|[^"\\])*"/g, '""');
  return new RegExp(`(?<![A-Za-z0-9_])${escapePhiRegExp(ident)}(?![A-Za-z0-9_])`).test(stripped);
}

function replaceIdentInExpr(expr, ident, replacement) {
  if (!expr || !ident || !expr.includes(ident)) return expr;
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapePhiRegExp(ident)}(?![A-Za-z0-9_])`, 'g');
  return expr.replace(/"(?:\\.|[^"\\])*"|[^"]+/g, (seg) => (seg.startsWith('"') ? seg : seg.replace(re, replacement)));
}

function activeEdgeCopies(fromBi, toBi, ctx) {
  const lowering = ctx.phiLowering;
  if (!lowering || fromBi == null || toBi == null) return [];
  const raw = lowering.edgeCopies.get(`${fromBi}->${toBi}`);
  if (!raw || !raw.length) return [];
  const skipped = lowering.skippedPhiIds;
  return skipped?.size ? raw.filter((c) => !skipped.has(c.dstId)) : raw;
}

function hasPhiCopiesForEdge(fromBi, toBi, ctx) {
  const copies = activeEdgeCopies(fromBi, toBi, ctx);
  if (!copies.length) return false;
  return copies.some((c) => c.value?.id !== c.dstId);
}

function emitPhiCopiesForEdge(fromBi, toBi, out, ctx, indent, anchorInst = null) {
  const copies = activeEdgeCopies(fromBi, toBi, ctx);
  if (!copies.length) return 0;
  const lowering = ctx.phiLowering;

  const pending = [];
  for (const c of copies) {
    if (c.value?.id === c.dstId) continue;
    resetInitialValueOwner(ctx);
    const rhs = renderValue(c.value, ctx);
    if (rhs === c.dstName) continue;
    pending.push({
      dst: c.dstName,
      dstType: c.dstType,
      rhs,
      phi: c.phi,
      value: c.value,
    });
  }
  resetInitialValueOwner(ctx);
  if (!pending.length) return 0;

  const fallbackRow = anchorInst?.row ?? ctx.ir.blocks[fromBi]?.endRow ?? null;
  const fallbackAddr = anchorInst?.address ?? ctx.blockAddress(fromBi);
  const makeCopyLine = (lhs, rhs, phi, incomingValue) => {
    const source = mergeSource(
      sourceForInst(phi, 'phi-out-of-ssa'),
      dependencySource(incomingValue, ctx),
      anchorInst ? sourceForInst(anchorInst, 'phi-edge') : sourceOf(),
    );
    return line('stmt', indent, `${lhs} = ${rhs};`, fallbackRow, fallbackAddr, { source });
  };

  let emitted = 0;
  while (pending.length) {
    let readyIdx = -1;
    for (let i = 0; i < pending.length; i++) {
      const dst = pending[i].dst;
      let usedByOther = false;
      for (let j = 0; j < pending.length; j++) {
        if (i === j) continue;
        if (exprReferencesIdent(pending[j].rhs, dst)) {
          usedByOther = true;
          break;
        }
      }
      if (!usedByOther) {
        readyIdx = i;
        break;
      }
    }

    if (readyIdx >= 0) {
      const item = pending.splice(readyIdx, 1)[0];
      out.push(makeCopyLine(item.dst, item.rhs, item.phi, item.value));
      emitted++;
    } else {
      const victim = pending[0];
      let tmpName = `phi_tmp_${lowering.tempCounter++}`;
      while (lowering.reserved.has(tmpName)) tmpName = `phi_tmp_${lowering.tempCounter++}`;
      lowering.reserved.add(tmpName);
      lowering.temps.set(tmpName, { name: tmpName, type: victim.dstType });
      out.push(makeCopyLine(tmpName, victim.dst, victim.phi, victim.phi.dst));
      emitted++;
      for (const item of pending) {
        item.rhs = replaceIdentInExpr(item.rhs, victim.dst, tmpName);
      }
    }
  }
  return emitted;
}

function loopExitHasCompetingPhiEdges(loop, exit, ctx) {
  if (!hasPhiCopiesForEdge(loop.header, exit, ctx)) return false;
  for (const node of loop.nodes || []) {
    if (node === loop.header) continue;
    const succs = ctx.ir.blocks[node]?.succ || [];
    if (succs.includes(exit)) return true;
  }
  return false;
}

function computeForLoopHandledPhis(ctx) {
  const skipped = new Set();
  const loops = ctx.ir.loops || [];
  for (const loop of loops) {
    const block = ctx.ir.blocks[loop.header];
    const term = block ? blockTerm(block) : null;
    if (!term || term.op !== OP.CBR || (block.succ || []).length !== 2) continue;
    const { yes, no } = branchSucc(ctx.ir, block, term, ctx);
    const yesInside = loop.nodes.has(yes), noInside = loop.nodes.has(no);
    if (yesInside === noInside) continue;
    const exit = yesInside ? no : yes;
    if (loop.exits.size !== 1) continue;
    if (loopExitHasCompetingPhiEdges(loop, exit, ctx)) continue;
    // Check if nested loop would be rejected by emitRegion's nestedLoop guard
    let blockedByOuter = false;
    for (const outer of loops) {
      if (outer === loop || outer.nodes.size <= loop.nodes.size) continue;
      if ([...loop.nodes].every((n) => outer.nodes.has(n))) {
        const exitsInside = [...loop.exits].every((e) => outer.nodes.has(e));
        const pureHeader = (block.insts || []).every((inst) => ![OP.CALL, OP.STORE, OP.UNKNOWN, OP.CLOBBER].includes(inst.op));
        if (!exitsInside || !pureHeader) { blockedByOuter = true; break; }
      }
    }
    if (blockedByOuter) continue;
    const iv = (ctx.inductions || []).find((x) => x.loop.header === loop.header);
    if (iv && iv.init && iv.conditionInst === term && iv.value?.id != null) {
      skipped.add(iv.value.id);
    }
  }
  return skipped;
}

function emitBlockStatements(block, out, ctx, indent) {
  const term = blockTerm(block);
  for (const inst of block.insts || []) {
    resetInitialValueOwner(ctx);
    if (inst === term || inst.op === OP.CMP || inst.op === OP.PHI || inst.op === OP.CONST || inst.op === OP.MOV || inst.op === OP.BIN || inst.op === OP.UN || inst.op === OP.SEL || inst.op === OP.ADDR || inst.op === OP.MAC || inst.op === OP.BFX || inst.op === OP.BFI || inst.op === OP.CLOBBER) continue;
    if (inst.op === OP.LOAD) {
      if (!inst.dst || !ctx.materialNames.has(inst.dst.id)) continue;
      const rhs = renderValue(inst.dst, ctx, { ignoreMaterial: true });
      const node = line('stmt', indent, `${ctx.materialNames.get(inst.dst.id)} = ${rhs};`, inst.row, inst.address,
        { source: mergeSource(dependencySource(inst.dst, ctx), sourceForInst(inst, 'load-order')) });
      out.push(node);
      ctx.evidence.push(evidenceOf(inst, 'ordered memory load'));
    } else if (inst.op === OP.STORE) {
      if (isMechanicalStackSpill(inst, ctx)) {
        recordSuppression(ctx, inst, 'compiler-only stack spill', 'omit-mechanical-stack-spill');
        continue;
      }
      const rendered = statementForStore(inst, ctx);
      const node = line('stmt', indent, rendered.text, inst.row, inst.address, { source: storeSource(inst, ctx) });
      retainStoreRenderLine(node, inst, rendered, ctx);
      out.push(node);
      ctx.evidence.push(evidenceOf(inst, 'Memory SSA store'));
    } else if (inst.op === OP.CALL) {
      const c = callRecord(inst, ctx);
      if (shouldFoldRuntimeCall(c.name, { expert: ctx.opts.expert })) {
        recordSuppression(ctx, inst, `folded runtime noise: ${c.name}`, 'omit-runtime-noise-call'); continue;
      }
      const call = renderCall(inst, ctx);
      const extra = { source: callSource(inst, c, ctx) };
      const callDst = callResultValue(inst, ctx);
      const callDstName = callDst ? ctx.materialNames.get(callDst.id) : null;
      const node = callDstName
        ? line('stmt', indent, `${callDstName} = ${call};`, inst.row, inst.address, extra)
        : line('stmt', indent, `${call};`, inst.row, inst.address, extra);
      const resultBinding = callDstName
        ? Object.freeze({ name: callDstName, callText: `${call};`, value: callDst }) : null;
      retainStatementRenderLine(node, inst, c, ctx, null, resultBinding);
      out.push(node);
      ctx.evidence.push(evidenceOf(inst, c.resolved.runtime === 'objc' ? 'Objective-C dispatch' : c.resolved.runtime === 'swift' ? 'Swift dispatch' : 'call'));
    } else if (inst.op === OP.UNKNOWN) {
      // Unknown semantics do not erase known SSA inputs. In particular, an
      // unresolved indirect transfer still depends on its computed target.
      // Follow only those inputs, using the same bounded traversal and stack
      // boundaries as other statements; nearby instructions are not evidence.
      const seen = new Set();
      const source = mergeSource(sourceForInst(inst, 'unsupported instruction'),
        ...(inst.args || []).map(arg => dependencySource(valueOf(arg), ctx, seen)));
      out.push(retainControlRenderLine(line('stmt', indent, `__asm(${JSON.stringify(inst.text || 'unknown')});`, inst.row, inst.address, { source }),
        inst, 'unsupported-statement', { op:inst.op }, ctx)); ctx.unknown++;
      ctx.evidence.push(evidenceOf(inst, 'unsupported IR instruction retained faithfully'));
    }
  }
  resetInitialValueOwner(ctx);
  return term;
}

/** Recover canonical SSA induction variables. */
export function recoverInductionVariables(ir, ctx = null) {
  const out = [];
  for (const loop of ir.loops || []) {
    const block = ir.blocks[loop.header];
    for (const phi of block?.phis || []) {
      if (!phi.dst || (phi.incoming || []).length !== 2) continue;
      const outside = phi.incoming.find((x) => !loop.nodes.has(x.from));
      const inside = phi.incoming.find((x) => loop.nodes.has(x.from));
      if (!outside || !inside) continue;
      const stepDef = inside.value?.def;
      if (!stepDef || stepDef.op !== OP.BIN || !['add', 'sub'].includes(stepDef.sub)) continue;
      const a = valueOf(stepDef.args?.[0]), b = valueOf(stepDef.args?.[1]);
      let step = null;
      if (sameValue(a, phi.dst) && b?.const != null) step = stepDef.sub === 'add' ? b.const : -b.const;
      else if (stepDef.sub === 'add' && sameValue(b, phi.dst) && a?.const != null) step = a.const;
      if (step == null) continue;
      const term = blockTerm(block);
      if (!term || term.op !== OP.CBR) continue;
      const name = `i${out.length || ''}`;
      out.push({ loop, phi, value: phi.dst, name, init: outside.value, step, conditionInst: term,
        initText: ctx ? renderValue(outside.value, ctx) : null,
        conditionText: ctx ? renderBranchCondition(term, ctx) : null });
    }
  }
  return out;
}

function loopRender(loop, block, term, ctx, state, indent, stop) {
  if (!term || term.op !== OP.CBR || block.succ.length !== 2) return null;
  const { yes, no } = branchSucc(ctx.ir, block, term, ctx);
  const yesInside = loop.nodes.has(yes), noInside = loop.nodes.has(no);
  if (yesInside === noInside) return null;
  const bodyStart = yesInside ? yes : no;
  const exit = yesInside ? no : yes;
  if (loopExitHasCompetingPhiEdges(loop, exit, ctx)) return null;
  const earlyReturnProof = loop.exits.size === 1 ? null : provenTerminalLoopExits(loop, exit, ctx, state);
  if (loop.exits.size !== 1 && !earlyReturnProof) return null;
  const invert = !yesInside;
  const iv = ctx.inductions.find((x) => x.loop.header === loop.header);
  let head, form = 'while-loop';
  if (iv && iv.init && iv.conditionInst === term && (!ctx.phiLowering || ctx.phiLowering.skippedPhiIds.has(iv.value.id))) {
    form = 'for-loop';
    ctx.materialNames.set(iv.value.id, iv.name);
    ctx.exprCache.clear();
    const init = renderValue(iv.init, ctx, { ignoreMaterial: true });
    let cond = renderBranchCondition(term, ctx, invert);
    const step = iv.step === 1n ? `${iv.name}++` : iv.step === -1n ? `${iv.name}--` : `${iv.name} += ${iv.step}`;
    head = `for (${typeNameOf(ctx.types.values.get(iv.value.id)) === 'unknown' ? 'int64' : typeNameOf(ctx.types.values.get(iv.value.id))} ${iv.name} = ${init}; ${cond}; ${step})`;
  } else head = `while (${renderBranchCondition(term, ctx, invert)})`;
  const lines = [retainControlRenderLine(line('ctrl', indent, `${head} {`, term.row, term.address, { source: controlSource(term, ctx) }),
    term, form, { header:loop.header, bodyStart, exit, invert, inductionValueId:form === 'for-loop' ? iv.value.id : null }, ctx)];
  emitPhiCopiesForEdge(loop.header, bodyStart, lines, ctx, indent + 1, term);
  const local = { ...state, activeLoop: loop, loopHeader: loop.header, loopExit: exit,
    loopBreakProof:provenSingleExitLoop(loop, exit, ctx, state), loopEarlyReturnProof:earlyReturnProof };
  emitRegion(bodyStart, loop.header, lines, ctx, local, indent + 1, loop.nodes, term);
  lines.push(line('ctrl', indent, '}'));
  emitPhiCopiesForEdge(loop.header, exit, lines, ctx, indent, term);
  return { lines, next: exit === stop ? stop : exit };
}

// Bind a conditional `break` to the existing loop record.  This is deliberately
// a proof over the canonical loop data, not another loop detector: the header,
// membership, latches, and exit set were all materialized by analyzeGraph.
function provenSingleExitLoop(loop, exit, ctx, state) {
  if (!loop || exit == null || state.activeLoop === loop) return null;
  const nodes = loop.nodes;
  const graph = ctx.graph;
  if (graph.loopAnalysis?.complete !== true || !nodes?.has?.(loop.header)
      || !loop.exits?.has?.(exit) || loop.exits.size !== 1
      || !provenBranchPredicate(blockTerm(ctx.ir.blocks[loop.header]))) return null;
  const latches = [...(loop.latches || [])];
  if (!latches.length) return null;
  const entry = Number.isInteger(ctx.ir.entry) ? ctx.ir.entry : 0;
  const externalHeaderPredecessors = (graph.predecessors?.[loop.header] || [])
    .filter((predecessor) => !nodes.has(predecessor));
  if (loop.header === entry ? externalHeaderPredecessors.length !== 0 : externalHeaderPredecessors.length !== 1) return null;
  for (const node of nodes) {
    const term = blockTerm(ctx.ir.blocks[node]);
    if (graph.dominators?.[node]?.has?.(loop.header) !== true || (node !== loop.header && state.visited.has(node))
        || (term?.op === OP.CBR && !provenBranchPredicate(term))
        || (ctx.ir.blocks[node]?.insts || []).some((inst) => inst.op === OP.UNKNOWN)) return null;
    for (const predecessor of graph.predecessors?.[node] || []) {
      if (!nodes.has(predecessor) && node !== loop.header) return null;
    }
  }
  for (const latch of latches) {
    const latchBlock = ctx.ir.blocks[latch];
    if (!latchBlock || !(latchBlock.succ || []).includes(loop.header)
        || !graph.backEdges?.some?.((edge) => edge.from === latch && edge.to === loop.header)) return null;
  }
  // A child loop receives its own activeLoop record in loopRender.  A target
  // outside that record is never treated as this loop's break.
  return Object.freeze({ loop, header:loop.header, exit });
}

function phiTransitionFrom(block, predecessor) {
  for (const phi of block?.phis || []) {
    const incoming = phi?.incoming;
    if (!Array.isArray(incoming) || !incoming.some((edge) => edge?.from === predecessor)) return false;
  }
  return true;
}

// A loop may have a normal guard exit plus a direct terminal return from its
// body.  Those are not interchangeable `break` destinations: the return arm
// carries its own stores/calls and bypasses the normal continuation.  Admit the
// shape only when every non-guard exit is a direct, single-owner return block.
function provenTerminalLoopExits(loop, normalExit, ctx, state) {
  if (!loop || normalExit == null || state.activeLoop != null) return null;
  const graph = ctx.graph;
  const blocks = ctx.ir.blocks || [];
  const nodes = loop.nodes;
  const header = loop.header;
  const headerBlock = blocks[header];
  if (graph.loopAnalysis?.complete !== true || !nodes?.has?.(header) || !headerBlock || !provenBranchPredicate(blockTerm(headerBlock))
      || !loop.exits?.has?.(normalExit) || loop.exits.size < 2) return null;
  const latches = [...(loop.latches || [])];
  if (latches.length !== 1) return null;
  const latch = latches[0];
  if (!(blocks[latch]?.succ || []).includes(header)
      || !graph.backEdges?.some?.((edge) => edge.from === latch && edge.to === header)) return null;

  for (const node of nodes) {
    const term = blockTerm(blocks[node]);
    if (graph.dominators?.[node]?.has?.(header) !== true || (node !== header && state.visited.has(node))
        || (term?.op === OP.CBR && !provenBranchPredicate(term))
        || ![OP.BR, OP.CBR].includes(term?.op)) return null;
    if ((blocks[node]?.insts || []).some((inst) => inst.op === OP.UNKNOWN)) return null;
    for (const predecessor of graph.predecessors?.[node] || []) {
      if (!nodes.has(predecessor) && node !== header) return null;
    }
  }
  const externalHeaderPredecessors = (graph.predecessors?.[header] || []).filter((predecessor) => !nodes.has(predecessor));
  const entry = Number.isInteger(ctx.ir.entry) ? ctx.ir.entry : 0;
  if (header === entry ? externalHeaderPredecessors.length !== 0 : externalHeaderPredecessors.length !== 1) return null;
  if (!phiTransitionFrom(blocks[normalExit], header)) return null;

  // Nested ownership is intentionally excluded from this root fix.  A child
  // return is safe only after a separate proof that it does not bypass parent
  // cleanup, so it remains faithful rather than becoming a parent-loop exit.
  for (const candidate of graph.loops || []) {
    if (candidate === loop || !candidate?.nodes || candidate.nodes.size <= nodes.size) continue;
    if ([...nodes].every((node) => candidate.nodes.has(node))) return null;
  }

  const earlyTargets = new Set();
  for (const node of nodes) {
    for (const target of blocks[node]?.succ || []) {
      if (nodes.has(target)) continue;
      if (node === header && target === normalExit) continue;
      const targetBlock = blocks[target];
      if (!targetBlock || blockTerm(targetBlock)?.op !== OP.RET || (targetBlock.succ || []).length !== 0) return null;
      const targetPredecessors = graph.predecessors?.[target] || [];
      if (targetPredecessors.length !== 1 || targetPredecessors[0] !== node) return null;
      if (!phiTransitionFrom(targetBlock, node)) return null;
      earlyTargets.add(target);
    }
  }
  if (!earlyTargets.size) return null;

  const budget = state.terminalProofBudget;
  const proofCost = 12 + nodes.size * 3 + earlyTargets.size * 2;
  if (!budget || budget.remaining < proofCost) return null;
  budget.remaining -= proofCost;
  return Object.freeze({ loop, header, normalExit, targets:Object.freeze([...earlyTargets].sort((a, b) => a - b)) });
}

function emitRegion(start, stop, out, ctx, state, indent, allowed = null, fromTerm = null) {
  let bi = start, guard = 0, prevTerm = fromTerm;
  while (bi != null && bi !== stop && guard++ < MAX_BLOCKS) {
    resetInitialValueOwner(ctx);
    if (allowed && !allowed.has(bi)) return;
    if (state.activeLoop && bi === state.loopHeader) return;
    if (state.visited.has(bi)) {
      // HEX-C4-03: a residual goto is a control-flow claim, so it must carry
      // the canonical origin of both the jumping instruction (when known) and
      // the block it jumps into. Attributing a revisit goto solely to its
      // target block causes downstream control projection to misclassify it as
      // belonging to the target block rather than the predecessor branch.
      state.gotoTargets?.add(bi);
      const gotoSource = prevTerm
        ? mergeSource(controlSource(prevTerm, ctx), jumpTargetSource(bi, ctx))
        : jumpTargetSource(bi, ctx);
      out.push(retainControlRenderLine(
        line('stmt', indent, `goto loc_${hex(ctx.blockAddress(bi))};`, prevTerm?.row ?? null, prevTerm?.address ?? null, { source: gotoSource }),
        prevTerm ?? null, 'revisit-goto', { target:bi, stop, loopHeader:state.loopHeader ?? null }, ctx));
      state.gotos++; return;
    }
    state.visited.add(bi);
    const block = ctx.ir.blocks[bi];
    if (!block) return;
    const currentBi = bi;
    const blockStartLen = out.length;
    try {

    const loop = ctx.graph.loopByHeader.get(bi);
    const term = blockTerm(block);
    // Reuse the same natural-loop emitter inside a containing loop. Every
    // inner node and exit must remain in the parent's body; a cross-level exit
    // still needs an explicit edge rather than an inner break with new meaning.
    const nestedLoop = loop && state.activeLoop && loop.header !== state.loopHeader
      && loop.nodes.size < state.activeLoop.nodes.size
      && [...loop.nodes].every(node => state.activeLoop.nodes.has(node))
      && [...loop.exits].every(exit => state.activeLoop.nodes.has(exit))
      // loopRender emits header statements before the loop. A newly nested
      // loop must not move a repeated statement out of it. LOAD expressions
      // remain in the condition/body and are evaluated on each iteration.
      && block.insts.every(inst => ![OP.CALL,OP.STORE,OP.UNKNOWN,OP.CLOBBER].includes(inst.op));
    let term2;
    if (loop && (!state.activeLoop || nestedLoop)) {
      term2 = emitBlockStatements(block, out, ctx, indent);
      const lr = loopRender(loop, block, term, ctx, state, indent, stop);
      if (lr) { out.push(...lr.lines); prevTerm = term2 ?? term ?? block.insts?.[block.insts.length - 1] ?? null; bi = lr.next; continue; }
    } else {
      term2 = emitBlockStatements(block, out, ctx, indent);
    }
    if (!term2) {
      const lastInst = block.insts?.[block.insts.length - 1] ?? null;
      const next = block.succ.length === 1 ? block.succ[0] : null;
      if (next != null) emitPhiCopiesForEdge(bi, next, out, ctx, indent, lastInst);
      prevTerm = lastInst; bi = next; continue;
    }
    if (term2.op === OP.RET) {
      const rv = returnValueAt(term2, ctx);
      const text = rv && ((rv.uses || []).length || rv.const != null || rv.def) ? `return ${renderValue(rv, ctx)};` : 'return;';
      const node = line('stmt', indent, text, term2.row, term2.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term2, 'return')) });
      retainStatementRenderLine(node, term2, rv, ctx);
      out.push(node); ctx.evidence.push(evidenceOf(term2, 'return')); return;
    }
    if (term2.op === OP.BR) {
      const next = block.succ[0] ?? null;
      if (next != null) emitPhiCopiesForEdge(bi, next, out, ctx, indent, term2);
      if (state.activeLoop && next === state.loopHeader) { out.push(retainControlRenderLine(line('ctrl', indent, 'continue;', term2.row, term2.address, { source: controlSource(term2, ctx) }),
        term2, 'loop-continue', { target:next, header:state.loopHeader }, ctx)); return; }
      if (state.activeLoop && next === state.loopExit) { out.push(retainControlRenderLine(line('ctrl', indent, 'break;', term2.row, term2.address, { source: controlSource(term2, ctx) }),
        term2, 'loop-break', { target:next, header:state.loopHeader }, ctx)); return; }
      if (next === stop) return;
      if (next != null && !state.visited.has(next) && (!allowed || allowed.has(next))) { prevTerm = term2; bi = next; continue; }
      if (next != null) { state.gotoTargets?.add(next); out.push(retainControlRenderLine(line('stmt', indent, `goto loc_${hex(ctx.blockAddress(next))};`, term2.row, term2.address, { source: mergeSource(controlSource(term2, ctx), jumpTargetSource(next, ctx)) }),
        term2, 'residual-branch-goto', { target:next, stop }, ctx)); state.gotos++; }
      return;
    }
    if (term2.op === OP.CBR) {
      const sw = ctx.switchByRow.get(term2.row);
      if (sw) {
        const expr = sw.expr || renderValue(reachingRegisterValue(ctx.ir, term2, sw.reg || 'x0'), ctx);
        out.push(retainControlRenderLine(line('ctrl', indent, `switch (${expr}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
          term2, 'switch-header', { switch:sw }, ctx));
        for (const c of sw.cases || []) {
          state.gotoTargets?.add(c.block);
          if (hasPhiCopiesForEdge(bi, c.block, ctx)) {
            out.push(line('ctrl', indent + 1, `case ${c.value}: {`, null, null, { source: jumpTargetSource(c.block, ctx) }));
            emitPhiCopiesForEdge(bi, c.block, out, ctx, indent + 2, term2);
            out.push(retainControlRenderLine(line('stmt', indent + 2, `goto loc_${hex(ctx.blockAddress(c.block))};`, null, null, { source: jumpTargetSource(c.block, ctx) }),
              term2, 'switch-case-goto', { switch:sw, case:c }, ctx));
            out.push(line('ctrl', indent + 1, '}'));
          } else {
            out.push(retainControlRenderLine(line('ctrl', indent + 1, `case ${c.value}: goto loc_${hex(ctx.blockAddress(c.block))};`, null, null, { source: jumpTargetSource(c.block, ctx) }),
              term2, 'switch-case-goto', { switch:sw, case:c }, ctx));
          }
        }
        if (sw.defaultBlock != null) {
          state.gotoTargets?.add(sw.defaultBlock);
          if (hasPhiCopiesForEdge(bi, sw.defaultBlock, ctx)) {
            out.push(line('ctrl', indent + 1, 'default: {', null, null, { source: jumpTargetSource(sw.defaultBlock, ctx) }));
            emitPhiCopiesForEdge(bi, sw.defaultBlock, out, ctx, indent + 2, term2);
            out.push(retainControlRenderLine(line('stmt', indent + 2, `goto loc_${hex(ctx.blockAddress(sw.defaultBlock))};`, null, null, { source: jumpTargetSource(sw.defaultBlock, ctx) }),
              term2, 'switch-default-goto', { switch:sw, target:sw.defaultBlock }, ctx));
            out.push(line('ctrl', indent + 1, '}'));
          } else {
            out.push(retainControlRenderLine(line('ctrl', indent + 1, `default: goto loc_${hex(ctx.blockAddress(sw.defaultBlock))};`, null, null, { source: jumpTargetSource(sw.defaultBlock, ctx) }),
              term2, 'switch-default-goto', { switch:sw, target:sw.defaultBlock }, ctx));
          }
        }
        out.push(line('ctrl', indent, '}')); state.gotos += (sw.cases || []).length + (sw.defaultBlock != null ? 1 : 0); return;
      }
      const branch = branchSucc(ctx.ir, block, term2, ctx);
      const { yes, no } = branch;
      // A body edge to a direct return block is structurally an early return,
      // not a break.  The proof was attached by loopRender only after checking
      // exact loop ownership, normal guard exit, target predecessor ownership,
      // PHI inputs, side entries, and the bounded canonical loop facts.
      const earlyReturnProof = state.loopEarlyReturnProof;
      const earlyTarget = earlyReturnProof?.targets?.includes(yes) ? yes
        : earlyReturnProof?.targets?.includes(no) ? no : null;
      if (branch.exact && provenBranchPredicate(term2) && earlyReturnProof?.loop === state.activeLoop && earlyTarget != null
          && ((yes === earlyTarget && no === earlyReturnProof.header)
            || (no === earlyTarget && yes === earlyReturnProof.header))
          && earlyReturnProof.loop.nodes.has(bi)
          && phiTransitionFrom(ctx.ir.blocks[earlyTarget], bi)) {
        const invert = no === earlyTarget;
        const cond = renderBranchCondition(term2, ctx, invert);
        out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source:controlSource(term2, ctx) }),
          term2, 'one-sided-if', { yes, no, earlyReturn:true, target:earlyTarget, header:earlyReturnProof.header, invert }, ctx));
        emitPhiCopiesForEdge(bi, earlyTarget, out, ctx, indent + 1, term2);
        emitRegion(earlyTarget, null, out, ctx, state, indent + 1, null, term2);
        out.push(line('ctrl', indent, '}'));
        emitPhiCopiesForEdge(bi, earlyReturnProof.header, out, ctx, indent, term2);
        return;
      }
      // A conditional whose two proven targets are this loop's own header and
      // its one canonical exit is a source `break`.  This does not infer a
      // break from an arbitrary outward branch: the loop renderer attached an
      // exact ownership/exit proof above, the edge source remains a member, and
      // every PHI at the destination explicitly accepts this predecessor.
      const breakProof = state.loopBreakProof;
      const breakTarget = breakProof?.exit;
      const continueTarget = breakProof?.header;
      if (branch.exact && provenBranchPredicate(term2) && breakProof?.loop === state.activeLoop
          && breakTarget != null && continueTarget != null
          && ((yes === breakTarget && no === continueTarget) || (no === breakTarget && yes === continueTarget))
          && breakProof.loop.nodes.has(bi)
          && !breakProof.loop.nodes.has(breakTarget)
          && phiTransitionFrom(ctx.ir.blocks[breakTarget], bi)) {
        const invert = no === breakTarget;
        const cond = renderBranchCondition(term2, ctx, invert);
        const breakNode = retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source:controlSource(term2, ctx) }),
          term2, 'loop-break', { target:breakTarget, header:continueTarget, conditional:true, invert }, ctx);
        out.push(breakNode);
        emitPhiCopiesForEdge(bi, breakTarget, out, ctx, indent + 1, term2);
        out.push(retainControlRenderLine(line('ctrl', indent + 1, 'break;', term2.row, term2.address, { source:mergeSource(controlSource(term2, ctx), jumpTargetSource(breakTarget, ctx)) }),
          term2, 'loop-break', { target:breakTarget, header:continueTarget, conditional:true, invert }, ctx));
        out.push(line('ctrl', indent, '}'));
        emitPhiCopiesForEdge(bi, continueTarget, out, ctx, indent, term2);
        return;
      }
      const join = ctx.graph.immediatePostDominators?.[bi];
      const structural = join != null && join !== bi && yes != null && no != null && (!allowed || (allowed.has(yes) && allowed.has(no)));
      if (structural) {
        const region = beginConditionalRegion(ctx, out, state);
        let separator = null, close;
        const yesEmpty = yes === join;
        const noEmpty = no === join;
        if (yesEmpty !== noEmpty) {
          const invert = yesEmpty;
          const bodyStart = yesEmpty ? no : yes;
          const cond = renderBranchCondition(term2, ctx, invert);
          out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
            term2, 'one-sided-if', { yes, no, join, invert, bodyStart }, ctx));
          startConditionalArm(region, out);
          emitPhiCopiesForEdge(bi, bodyStart, out, ctx, indent + 1, term2);
          emitRegion(bodyStart, join, out, ctx, state, indent + 1, allowed, term2);
          finishConditionalArm(region, out, state, yesEmpty ? 'no' : 'yes', ctx);
          if (hasPhiCopiesForEdge(bi, join, ctx)) {
            separator = line('ctrl', indent, '} else {'); out.push(separator);
            startConditionalArm(region, out);
            emitPhiCopiesForEdge(bi, join, out, ctx, indent + 1, term2);
            finishConditionalArm(region, out, state, yesEmpty ? 'yes' : 'no', ctx);
          }
          close = line('ctrl', indent, '}'); out.push(close);
        } else {
          const cond = renderBranchCondition(term2, ctx);
          out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
            term2, 'if-else', { yes, no, join }, ctx));
          startConditionalArm(region, out);
          emitPhiCopiesForEdge(bi, yes, out, ctx, indent + 1, term2);
          emitRegion(yes, join, out, ctx, state, indent + 1, allowed, term2);
          finishConditionalArm(region, out, state, 'yes', ctx);
          separator = line('ctrl', indent, '} else {'); out.push(separator);
          startConditionalArm(region, out);
          emitPhiCopiesForEdge(bi, no, out, ctx, indent + 1, term2);
          emitRegion(no, join, out, ctx, state, indent + 1, allowed, term2);
          finishConditionalArm(region, out, state, 'no', ctx);
          close = line('ctrl', indent, '}'); out.push(close);
        }
        finishConditionalRegion(region, out, ctx, term2,
          { header:bi, yes, no, join, invert:yesEmpty !== noEmpty && yesEmpty, form:(yesEmpty !== noEmpty && !separator) ? 'one-sided-if' : 'if-else' }, separator, close);
        prevTerm = null; bi = join; continue;
      }
      const earlyExit = join == null && branch.exact
        ? earlyExitConditionalContinuation(bi, yes, no, ctx, state, stop, allowed) : null;
      if (earlyExit) {
        const cond = renderBranchCondition(term2, ctx, earlyExit.invert);
        out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
          term2, 'one-sided-if', { yes, no, join:earlyExit.continuation, invert:earlyExit.invert,
            bodyStart:earlyExit.bodyStart, earlyExit:true }, ctx));
        emitPhiCopiesForEdge(bi, earlyExit.bodyStart, out, ctx, indent + 1, term2);
        emitRegion(earlyExit.bodyStart, earlyExit.continuation, out, ctx, state, indent + 1, allowed, term2);
        out.push(line('ctrl', indent, '}'));
        emitPhiCopiesForEdge(bi, earlyExit.continuation, out, ctx, indent, term2);
        prevTerm = null; bi = earlyExit.continuation; continue;
      }
      const sharedEarlyExit = join == null && branch.exact
        ? sharedEarlyExitContinuation(bi, yes, no, ctx, state, allowed) : null;
      if (sharedEarlyExit) {
        const cond = renderBranchCondition(term2, ctx);
        out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
          term2, 'if-else', { yes, no, join:sharedEarlyExit.continuation, earlyExitShared:true }, ctx));
        emitPhiCopiesForEdge(bi, yes, out, ctx, indent + 1, term2);
        emitRegion(yes, sharedEarlyExit.continuation, out, ctx, state, indent + 1, allowed, term2);
        out.push(line('ctrl', indent, '} else {'));
        emitPhiCopiesForEdge(bi, no, out, ctx, indent + 1, term2);
        emitRegion(no, sharedEarlyExit.continuation, out, ctx, state, indent + 1, allowed, term2);
        out.push(line('ctrl', indent, '}'));
        prevTerm = null; bi = sharedEarlyExit.continuation; continue;
      }
      const terminal = join == null && branch.exact
        ? terminalConditionalPartition(bi, yes, no, ctx, state, allowed) : null;
      if (terminal) {
        const cond = renderBranchCondition(term2, ctx);
        out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
          term2, 'if-else', { yes, no, join:null, terminal:true }, ctx));
        emitPhiCopiesForEdge(bi, yes, out, ctx, indent + 1, term2);
        emitRegion(yes, null, out, ctx, state, indent + 1, allowed, term2);
        out.push(line('ctrl', indent, '} else {'));
        emitPhiCopiesForEdge(bi, no, out, ctx, indent + 1, term2);
        emitRegion(no, null, out, ctx, state, indent + 1, allowed, term2);
        out.push(line('ctrl', indent, '}'));
        return;
      }
      const cond = renderBranchCondition(term2, ctx);
      if (yes != null) {
        state.gotoTargets?.add(yes);
        if (hasPhiCopiesForEdge(bi, yes, ctx)) {
          const copyLines = [];
          emitPhiCopiesForEdge(bi, yes, copyLines, ctx, indent + 1, term2);
          if (copyLines.length) {
            const copyStmts = copyLines.map((l) => l.text).join(' ');
            out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) { ${copyStmts} goto loc_${hex(ctx.blockAddress(yes))}; }`, term2.row, term2.address, { source: mergeSource(controlSource(term2, ctx), jumpTargetSource(yes, ctx)) }),
              term2, 'residual-conditional-goto', { yes, no, join }, ctx));
          } else {
            out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
              term2, 'residual-conditional-goto', { yes, no, join }, ctx));
          }
        } else {
          out.push(retainControlRenderLine(line('ctrl', indent, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term2.row, term2.address, { source: controlSource(term2, ctx) }),
            term2, 'residual-conditional-goto', { yes, no, join }, ctx));
        }
      }
      if (no != null) {
        state.gotoTargets?.add(no);
        emitPhiCopiesForEdge(bi, no, out, ctx, indent, term2);
        out.push(retainControlRenderLine(line('stmt', indent, `goto loc_${hex(ctx.blockAddress(no))};`, term2.row, term2.address, { source: mergeSource(controlSource(term2, ctx), jumpTargetSource(no, ctx)) }),
          term2, 'residual-false-goto', { yes, no, join }, ctx));
      }
      state.gotos += (yes != null ? 1 : 0) + (no != null ? 1 : 0); return;
    }
    } finally {
      if (state.blockAnchors && !state.blockAnchors.has(currentBi)) {
        if (out.length > blockStartLen) {
          state.blockAnchors.set(currentBi, { firstNode: out[blockStartLen], indent });
        } else {
          const marker = { __emptyBlockAnchor: currentBi, indent };
          out.push(marker);
          state.blockAnchors.set(currentBi, { firstNode: marker, empty: true, indent });
        }
      }
    }
  }
}

export function hasUnbalancedBracesInLines(nodes) {
  let depth = 0;
  let inBlockComment = false;
  for (const n of nodes) {
    const raw = n?.text;
    if (!raw) continue;
    let inString = false;
    let inChar = false;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (inChar) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === '\'') inChar = false;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        break;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '\'') {
        inChar = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth < 0) return true;
      }
    }
  }
  return depth !== 0;
}

function faithfulCfg(ctx, indent = 1) {
  const out = [];
  const emittedLabels = new Set();
  const reachable = ctx.graph.reachable || new Set(ctx.ir.blocks.map((b) => b.index));
  for (const bi of [...reachable].sort((a, b) => ctx.ir.blocks[a].startRow - ctx.ir.blocks[b].startRow)) {
    const block = ctx.ir.blocks[bi];
    const labelText = `loc_${hex(ctx.blockAddress(bi))}:`;
    if (!emittedLabels.has(labelText)) {
      emittedLabels.add(labelText);
      const label = line('label', indent, labelText, block.startRow, ctx.blockAddress(bi));
      // Keep the public label shape unchanged; its private producer retains the
      // canonical destination source without inventing a branch instruction.
      out.push(retainControlRenderLine(label, null, 'cfg-label', { target:bi,
        source:sourceOf({ row:block.startRow, address:label.addr, ir:block.insts.map(inst => Object.getOwnPropertyDescriptor(inst, 'id')?.value) }) }, ctx));
    }
    const term = emitBlockStatements(block, out, ctx, indent + 1);
    if (!term) {
      if ((block.succ || []).length === 1) {
        const lastInst = block.insts?.[block.insts.length - 1] ?? null;
        emitPhiCopiesForEdge(bi, block.succ[0], out, ctx, indent + 1, lastInst);
      }
      continue;
    }
    if (term.op === OP.RET) {
      const rv = returnValueAt(term, ctx);
      const node = line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term, 'return')) });
      retainStatementRenderLine(node, term, rv, ctx);
      out.push(node);
    } else if (term.op === OP.CBR) {
      const { yes, no } = branchSucc(ctx.ir, block, term, ctx);
      if (yes != null) {
        const cond = renderBranchCondition(term, ctx);
        if (hasPhiCopiesForEdge(bi, yes, ctx)) {
          const copyLines = [];
          emitPhiCopiesForEdge(bi, yes, copyLines, ctx, indent + 2, term);
          if (copyLines.length) {
            const copyStmts = copyLines.map((l) => l.text).join(' ');
            out.push(retainControlRenderLine(line('ctrl', indent + 1, `if (${cond}) { ${copyStmts} goto loc_${hex(ctx.blockAddress(yes))}; }`, term.row, term.address, { source: mergeSource(controlSource(term, ctx), jumpTargetSource(yes, ctx)) }),
              term, 'cfg-conditional-goto', { yes, no }, ctx));
          } else {
            out.push(retainControlRenderLine(line('ctrl', indent + 1, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term.row, term.address, { source: controlSource(term, ctx) }),
              term, 'cfg-conditional-goto', { yes, no }, ctx));
          }
        } else {
          out.push(retainControlRenderLine(line('ctrl', indent + 1, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term.row, term.address, { source: controlSource(term, ctx) }),
            term, 'cfg-conditional-goto', { yes, no }, ctx));
        }
      }
      if (no != null) {
        emitPhiCopiesForEdge(bi, no, out, ctx, indent + 1, term);
        out.push(retainControlRenderLine(line('stmt', indent + 1, `goto loc_${hex(ctx.blockAddress(no))};`, term.row, term.address, { source: mergeSource(controlSource(term, ctx), jumpTargetSource(no, ctx)) }),
          term, 'cfg-false-goto', { yes, no }, ctx));
      }
    } else if (term.op === OP.BR && block.succ[0] != null) {
      const next = block.succ[0];
      emitPhiCopiesForEdge(bi, next, out, ctx, indent + 1, term);
      out.push(retainControlRenderLine(line('stmt', indent + 1, `goto loc_${hex(ctx.blockAddress(next))};`, term.row, term.address, { source: mergeSource(controlSource(term, ctx), jumpTargetSource(next, ctx)) }),
        term, 'cfg-branch-goto', { target:next }, ctx));
    }
  }
  return out;
}

function summarize(lines, ctx) {
  const text = lines.map((l) => l.text).join('\n');
  const rmw = text.match(/(self->\w+)\s*=\s*max\(\1\s*-\s*([^,]+),\s*0\)/);
  if (rmw) return `${rmw[1].replace('self->', '')}から${rmw[2].trim()}を引き、0未満にならないよう制限して保存しています。`;
  const add = text.match(/(self->\w+)\s*\+=\s*([^;]+)/);
  if (add) return `${add[1].replace('self->', '')}に${add[2].trim()}を加えて保存しています。`;
  if (ctx.evidence.some((e) => e.reason === 'Objective-C dispatch')) return 'Objective-C のメッセージ送信を型・selector情報付きで実行しています。';
  if (ctx.evidence.some((e) => e.reason === 'Swift dispatch')) return 'Swift の呼び出しをABI情報付きで実行しています。';
  if (ctx.rmw.length) return '同じメモリ位置を読み、計算結果を書き戻す更新処理を行っています。';
  return 'Semantic IR から復元できた処理を、確認できる範囲でC風に表示しています。';
}

function pseudocode(lines) {
  return lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text}`).join('\n');
}

function runtimeFromOpts(opts) {
  if (opts.appleRuntime?.runtime === 'mixed') return opts.appleRuntime;
  return buildAppleRuntimeIndex({
    objc: opts.objcRuntimeIndex || opts.objcModel || opts.appleRuntime?.objc || null,
    swift: opts.swiftModel || opts.appleRuntime?.swift || null,
    selectorRefs: opts.selectorRefs || [], selectorStubs: opts.selectorStubs || [], fixups: opts.fixups || [],
  });
}

/** Main IR-first entry point. */
export function decompileSemantic(model, rawOpts = {}) {
  const opts = applyDecompilerProfile(rawOpts);
  const ir = opts.ir != null ? opts.ir : irFor(model, { rowOfAddress: opts.rowOfAddress });
  if (!ir || !ir.instructions?.length) return null;
  const runtime = runtimeFromOpts(opts);
  const types = inferSemanticTypes(ir, model, { runtime, abiAdapter: opts.abiAdapter ?? null });
  const graph = analyzeGraph(ir.blocks.map((b) => b.succ), ir.entry || 0);
  ir.loops = graph.loops;
  // Post-dominance is already computed by analyzeGraph. Attaching it here is
  // what lets P8-5 read the join point of a conditional from the canonical
  // control-flow analysis instead of deriving a second opinion about it.
  ir.postDominators = graph.postDominators;
  ir.ipdom = graph.immediatePostDominators;
  const rmw = readModifyWrite(ir);
  const firstAddr = model.instructions?.[0]?.address ?? opts.addr ?? 0n;
  const missingAddress = Symbol('missing block address');
  const rowToAddress = new Map();
  for (const block of ir.blocks) rowToAddress.set(block.startRow, missingAddress);
  if (Array.isArray(model.instructions)) {
    for (const inst of model.instructions) {
      if (inst && !Number.isNaN(inst.row) && rowToAddress.get(inst.row) === missingAddress) {
        rowToAddress.set(inst.row, inst.address);
      }
    }
  }
  const ctx = {
    ir, model, opts, runtime, types, graph, rmw,
    projectionIrObserver:createProjectionIrObserver({ deterministicTransforms:opts.deterministicTransforms === true }),
    rmwByStore: new Map(rmw.map((r) => [r.store.id, r])),
    storedValueAliases: buildStoredValueAliases(ir),
    returnInsts: (ir.instructions || []).filter((i) => i.op === OP.RET),
    exprCache: new Map(), exprActive: new Set(), exprNodes: 0,
    callCache: new Map(), depSourceCache: new Map(), validationBatch: null,
    callByRow: (() => {
      const map = new Map();
      for (const c of model.calls || []) {
        if (c && !map.has(c.row)) map.set(c.row, c);
      }
      return map;
    })(),
    evidence: [], suppressed: [], unknown: 0, unknownCallArities: 0,
    suppressionHistory: { events:[], reasons:new Set(), limit:Number.isSafeInteger(opts.renderProvenanceBudget?.maxTransformRecords)
      && opts.renderProvenanceBudget.maxTransformRecords >= 0 ? Math.min(opts.renderProvenanceBudget.maxTransformRecords, 1024) : 1024 },
    storeRenderHistory: { events:[], reasons:new Set(), limit:historyCap(opts.renderProvenanceBudget?.maxTransformRecords, 1024),
      consumers:historyCap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096),
      edges:historyCap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges) },
    statementRenderHistory: { events:[], reasons:new Set(), limit:historyCap(opts.renderProvenanceBudget?.maxTransformRecords, 1024),
      consumers:historyCap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096),
      edges:historyCap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges), canonical:null },
    controlRenderHistory: { events:[], reasons:new Set(), limit:historyCap(opts.renderProvenanceBudget?.maxTransformRecords, 1024),
      consumers:historyCap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096),
      edges:historyCap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges), canonical:null },
    conditionalRegionHistory: opts.phase8PrepareRegionProof === true ? { events:[], reasons:new Set(),
      limit:historyCap(opts.renderProvenanceBudget?.maxTransformRecords, 1024),
      remaining:historyCap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096),
      maxEdges:historyCap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges) } : null,
    materialNames: new Map(), switchByRow: new Map((opts.switches || model.switches || []).map((s) => [s.row, s])),
    blockAddress: (bi) => {
      const startRow = ir.blocks[bi]?.startRow;
      const address = rowToAddress.get(startRow);
      return address === missingAddress || address == null
        ? firstAddr + BigInt(startRow || 0) * 4n
        : address;
    },
  };
  beginStatementRenderHistory(ctx);
  beginControlRenderHistory(ctx);
  beginInitialValueTrace(ctx);
  ctx.materialNames = materialization(ctx);
  ctx.callResultByInst = buildCallResultMap(ir, ctx.materialNames, {
    callByRow: ctx.callByRow,
    symbolFor: ctx.opts?.symbolFor,
  });
  for (const v of ir.values || []) {
    const def = v?.def;
    if (!def || def.op !== OP.CALL || !ctx.materialNames.has(v.id)) continue;
    const canonical = def.dst || ctx.callResultByInst.get(def) || null;
    if (canonical && v !== canonical) {
      if (isSameCallReturnFamily(v.reg, canonical.reg)) {
        const canonicalCallName = `call_${canonical.id}`;
        ctx.materialNames.set(v.id, canonicalCallName);
        ctx.materialNames.set(canonical.id, canonicalCallName);
      } else if (isCallClobberedValue(v) && ctx.opts?.phase8Optimize !== true) {
        ctx.materialNames.delete(v.id);
      }
    } else if (!canonical && isCallClobberedValue(v) && ctx.opts?.phase8Optimize !== true) {
      ctx.materialNames.delete(v.id);
    }
  }
  ctx.inductions = recoverInductionVariables(ir, ctx);
  ctx.phiLowering = buildPhiLowering(ctx);
  ctx.phiVarNames = ctx.phiLowering.varNames;
  ctx.exprCache.clear();
  const baseMaterialNames = new Map(ctx.materialNames);
  ctx.phiLowering.skippedPhiIds = computeForLoopHandledPhis(ctx);

  const name = safeIdent(opts.notes?.nameOf?.(opts.addr) || opts.name || model.name || `sub_${hex(opts.addr ?? firstAddr)}`, 'sub');
  const signature = semanticSignature(name, types, opts.notes, opts.addr ?? firstAddr, opts, ir);
  const body = [];
  const state = { visited: new Set(), gotos: 0, activeLoop: null, loopHeader: null, loopExit: null,
    gotoTargets: new Set(), blockAnchors: new Map(),
    terminalProofBudget: { remaining: terminalProofSteps(opts) } };
  const runBatchedEmission = (fn) => {
    const validation = createValidationBatch();
    ctx.validationBatch = validation;
    try {
      validation.run(fn);
    } finally {
      ctx.validationBatch = null;
    }
    if (validation.settle() > 0) {
      if (ctx.statementRenderHistory.events.length || ctx.statementRenderHistory.canonical?.isCurrent() === false) {
        ctx.statementRenderHistory.edges = 0;
        ctx.statementRenderHistory.reasons.add('initial-statement-binding-unavailable');
      }
      if (ctx.controlRenderHistory.events.length || ctx.controlRenderHistory.canonical?.isCurrent() === false) {
        ctx.controlRenderHistory.edges = 0;
        ctx.controlRenderHistory.reasons.add('initial-control-binding-unavailable');
      }
      if (ctx.storeRenderHistory.events.length) {
        ctx.storeRenderHistory.edges = 0;
        ctx.storeRenderHistory.reasons.add('initial-store-binding-unavailable');
      }
    }
  };

  let missing = [];
  let hasUndefinedLabel = false;
  let hasUnbalancedBraces = false;
  const reachable = graph.reachable || new Set();
  let coverage;
  runBatchedEmission(() => {
    emitRegion(ir.entry || 0, null, body, ctx, state, 1);
    missing = [...reachable].filter((b) => !state.visited.has(b));
    coverage = { mode: 'structured', reachable: reachable.size, emitted: state.visited.size, missing: missing.length, recovered: 0, structuredMissing: missing.length };
    if (!missing.length) {
      const anchorToBi = new Map();
      for (const [bi, anchor] of state.blockAnchors) {
        if (!anchor?.firstNode) continue;
        let list = anchorToBi.get(anchor.firstNode);
        if (!list) {
          list = [];
          anchorToBi.set(anchor.firstNode, list);
        }
        list.push({ bi, empty: !!anchor.empty, indent: anchor.indent });
      }
      const emittedLabels = new Set();
      const resolvedBody = [];
      for (let i = 0; i < body.length; i += 1) {
        const node = body[i];
        const infos = anchorToBi.get(node);
        if (infos) {
          for (const info of infos) {
            if (state.gotoTargets.has(info.bi)) {
              const block = ctx.ir.blocks[info.bi];
              const labelText = `loc_${hex(ctx.blockAddress(info.bi))}:`;
              if (!emittedLabels.has(labelText) && block) {
                emittedLabels.add(labelText);
                const label = line('label', Math.max(0, info.indent - 1), labelText, block.startRow, ctx.blockAddress(info.bi));
                resolvedBody.push(retainControlRenderLine(label, null, 'cfg-label', { target: info.bi,
                  source: sourceOf({ row: block.startRow, address: label.addr, ir: block.insts.map(inst => Object.getOwnPropertyDescriptor(inst, 'id')?.value) }) }, ctx));
                if (info.empty) {
                  resolvedBody.push(line('stmt', info.indent, ';', block.startRow, ctx.blockAddress(info.bi), { source: jumpTargetSource(info.bi, ctx) }));
                }
              }
            }
          }
        }
        if (node && node.__emptyBlockAnchor !== undefined) continue;
        resolvedBody.push(node);
      }
      for (const bi of state.gotoTargets) {
        const labelText = `loc_${hex(ctx.blockAddress(bi))}:`;
        if (!emittedLabels.has(labelText)) {
          hasUndefinedLabel = true;
          break;
        }
      }
      if (!hasUndefinedLabel) {
        for (const n of resolvedBody) {
          const text = n?.text;
          if (!text || !text.includes('goto ')) continue;
          for (const m of text.matchAll(/\bgoto\s+(loc_[0-9A-Fa-f]+)\s*;/g)) {
            if (!emittedLabels.has(`${m[1]}:`)) {
              hasUndefinedLabel = true;
              break;
            }
          }
          if (hasUndefinedLabel) break;
        }
      }
      if (!hasUndefinedLabel && hasUnbalancedBracesInLines(resolvedBody)) {
        hasUnbalancedBraces = true;
      }
      body.length = 0;
      for (const node of resolvedBody) body.push(node);
      if (ctx.conditionalRegionHistory?.events?.length) {
        const bodyIndex = new Map(body.map((n, idx) => [n, idx]));
        ctx.conditionalRegionHistory.events = ctx.conditionalRegionHistory.events.map((region) => {
          const startIdx = bodyIndex.get(region.header);
          const endIdx = bodyIndex.get(region.close);
          if (startIdx == null || endIdx == null || endIdx < startIdx) return region;
          const updatedNodes = Object.freeze(body.slice(startIdx, endIdx + 1));
          if (updatedNodes.length === region.nodes.length && updatedNodes.every((n, idx) => n === region.nodes[idx])) return region;
          const sepIdx = region.separator ? bodyIndex.get(region.separator) : null;
          const firstRole = region.selection?.invert ? 'no' : 'yes';
          const updatedArms = Object.freeze(region.arms.map((arm) => {
            if (region.separator && sepIdx != null) {
              const armNodes = arm.role === firstRole
                ? body.slice(startIdx + 1, sepIdx)
                : body.slice(sepIdx + 1, endIdx);
              return Object.freeze({ ...arm, nodes: Object.freeze(armNodes) });
            }
            const armNodes = arm.role === firstRole ? body.slice(startIdx + 1, endIdx) : [];
            return Object.freeze({ ...arm, nodes: Object.freeze(armNodes) });
          }));
          return Object.freeze({ ...region, nodes: updatedNodes, arms: updatedArms });
        });
      }
    }
  });
  if (missing.length || hasUndefinedLabel || hasUnbalancedBraces) {
    body.length = 0; state.visited.clear(); state.gotos = 0;
    ctx.materialNames = new Map(baseMaterialNames);
    ctx.exprCache.clear();
    if (ctx.phiLowering) {
      ctx.phiLowering.skippedPhiIds.clear();
      ctx.phiLowering.temps.clear();
      ctx.phiLowering.tempCounter = 0;
      ctx.phiLowering.reserved = new Set(ctx.phiLowering.baseReserved);
    }
    // Only the selected final emission belongs to the history. Keep legacy
    // ctx.suppressed diagnostics unchanged, including the abandoned attempt.
    ctx.suppressionHistory.events.length = 0; ctx.suppressionHistory.reasons.clear();
    ctx.storeRenderHistory.events.length = 0; ctx.storeRenderHistory.reasons.clear();
    ctx.statementRenderHistory.events.length = 0; ctx.statementRenderHistory.reasons.clear();
    ctx.controlRenderHistory.events.length = 0; ctx.controlRenderHistory.reasons.clear();
    if (ctx.conditionalRegionHistory) ctx.conditionalRegionHistory.events.length = 0;
    runBatchedEmission(() => {
      body.push(...faithfulCfg(ctx, 1));
    });
    coverage = { mode: 'linear', reachable: reachable.size, emitted: reachable.size, missing: 0, recovered: missing.length, structuredMissing: missing.length };
  }

  const lines = [
    line('sig', 0, signature, model.instructions?.[0]?.row ?? null, firstAddr, { source: sourceOf({ address: firstAddr, row: model.instructions?.[0]?.row ?? null, evidence: [{ reason: 'function entry' }] }) }),
    line('ctrl', 0, '{'),
  ];
  for (const l of semanticLocalDeclarations(types, body, ctx)) lines.push(l);
  for (const l of body) lines.push(l);
  lines.push(line('ctrl', 0, '}'));

  const warnings = [...(types.warnings || [])];
  if (state.gotos) warnings.push(`${state.gotos} control-flow edge(s) remain explicit because a safe source structure was not proven.`);
  if (coverage.mode === 'linear') warnings.push('Structured CFG proof was incomplete; faithful address/edge mode was used.');
  if (ctx.unknown) warnings.push(`${ctx.unknown} unsupported IR instruction(s) remain as __asm.`);
  if (ctx.unknownCallArities) warnings.push(`${ctx.unknownCallArities} call site(s) have unknown arity; live argument registers were intentionally not guessed.`);
  // `ir.truncated` is the legacy projection of the canonical Semantic IR's
  // completeness (`semantics/compat/semantic-ir-v2-to-v1.js`), which is not
  // `complete` for independent reasons: unsupported instructions kept as
  // `__asm`, call context that cannot be minted, and genuine work/time budget
  // exhaustion. This layer cannot tell those apart, so it must state only the
  // truncation it observed and never assert the budget cause it cannot prove
  // (#8653; see the p8triage evidence for an x86-64 vector-family function that
  // carries no budget truncation at all).
  // `ir.truncated` is the legacy projection of the canonical Semantic IR's
  // completeness (`semantics/compat/semantic-ir-v2-to-v1.js`), which is not
  // `complete` for independent reasons: unsupported instructions kept as
  // `__asm`, call context that cannot be minted, and genuine work/time budget
  // exhaustion. This layer cannot tell those apart, so it must state only the
  // truncation it observed and never assert the budget cause it cannot prove
  // (#8653; see the p8triage evidence for an x86-64 vector-family function that
  // carries no budget truncation at all).
  if (ir.truncated) warnings.push('Semantic IR is explicitly truncated; the result is partial.');
  // #8887: canonical natural-loop materialization is resource-fenced. When the fence
  // fires the graph keeps its exact dominance/SCC facts but publishes no loops, so
  // this result must say so instead of reading like a loop-free function.
  if (graph.loopAnalysis && graph.loopAnalysis.complete === false) {
    warnings.push(`Natural-loop analysis stopped at the graph resource budget (${graph.loopAnalysis.stopReason}); loop structure is not proven and this result is not loop-structured.`);
  }

  const summary = summarize(body, ctx);
  const result = bindConditionalRegionHistory(bindStatementRenderHistory(bindStatementRenderHistory(bindStoreRenderHistory(bindSuppressionHistory({
    lines, signature, types, summary, pseudocode: pseudocode(lines),
    evidence: ctx.evidence, warnings, labels: new Set(body.filter((l) => l.kind === 'label').map((l) => l.text.replace(/:$/, ''))),
    coverage, ir, ctx: { runtime, suppressed: ctx.suppressed, inductions: ctx.inductions, irPrimary: true, unknownInstructions: ctx.unknown, phase8Optimize: opts.phase8Optimize === true },
    semantic: true,
  }, ctx), ctx), ctx), ctx, true), ctx);
  const bindings = new Map();
  for (const [id, name] of ctx.materialNames) {
    const value = (ir.values || []).find((candidate) => candidate.id === id);
    if (value?.def?.op === OP.LOAD) bindings.set(id, Object.freeze({ name, value, definition:value.def }));
  }
  if (bindings.size) {
    const values = ir.values;
    orderedMaterializationBindings.set(result, Object.freeze({ ir, bindings,
      isCurrent:() => Object.getOwnPropertyDescriptor(ir, 'values')?.value === values
        && [...bindings.values()].every((binding) => values.includes(binding.value) && binding.value.def === binding.definition),
    }));
  }
  return result;
}
