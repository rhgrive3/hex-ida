/**
 * Canonical Phase 8 natural-loop control projection.
 *
 * This is the loop half of the same proof-bound seam as
 * `structured-control-projection.js`. Phase 8 structuring already classified
 * every CFG edge of every function as `loop-entry`, `loop-body`,
 * `loop-back-edge`, `loop-guard-exit`, `loop-break`, a structured construct or
 * an explicit residual jump, and Phase 8 induction already proved each loop's
 * header, latches, guard block, exit edges and natural/irreducible
 * classification. Nothing in this file re-derives any of that.
 *
 * What was missing is the downstream consumer: a stage that takes the proven
 * loop facts and projects them into the rendered C body. That is all this
 * module is. It reads three artifacts and nothing else:
 *
 * - `facts.regions` (`kind === 'loop'`) from the structuring pass,
 * - `facts.edges`, the per-edge accounting,
 * - `induction.loops`, the per-loop guard/latch/exit proof.
 *
 * Three rules shape it.
 *
 * The first is that the rendered text is never read for meaning. A `goto` is
 * matched to a canonical edge by resolving its label address to a block index,
 * and a `while` is only ever emitted for the header a region and an induction
 * record both name. "It looks like a loop" is not evidence, and a label name is
 * not evidence either — the address is only a handle for finding the node.
 *
 * The second is that a projection has to be safe in the *emitted* order, not
 * only in the CFG. A `while` is placed where the loop's label was, so the
 * construct has to fall through to the block the guard leaves to; the guard must
 * not own statements that would move relative to the condition; and the loop's
 * rendered nodes must be one contiguous run with no foreign node inside it.
 * Each of those is checked, and failing any of them refuses the loop.
 *
 * The third is that refusing is always a complete fallback. A refused loop keeps
 * the legacy label/goto representation exactly as the renderer produced it —
 * including when only the `break`/`continue` rewrite is unproven, because a
 * correct jump inside a projected `while` is still a correct program.
 */

import { successorEdgesOf } from './structuring.js';
import { readSemanticControlLineHistory, registerSemanticControlLineHistory } from '../semantic-core.js';
import { mergeSource } from '../ast/nodes.js';
import { expressionOriginHistory } from '../rewrite/engine.js';

// Version 2 adds refinement of an already-emitted loop construct: break and
// continue rewrites still run when the upstream renderer already published the
// while/do-while/for header for this region, instead of refusing the whole
// projection. A consumer that understood version 1 as "the body was refused
// whenever a loop header already existed" must not assume that of version 2.
export const LOOP_CONTROL_PROJECTION_VERSION = 2;

/**
 * Returned instead of `null` when the caller's abort predicate reports
 * cancellation mid-projection. The two are not the same thing and must not share
 * a representation: `null` means "nothing was provable, keep the legacy render",
 * while this means "stop, publish nothing" — including adoption work an earlier
 * stage already finished. A caller that re-polls the predicate instead of reading
 * this marker only catches an abort that happens to still be reported at the
 * moment it asks again.
 */
export const LOOP_PROJECTION_CANCELLED = Object.freeze({ cancelled: true });

/**
 * The rewrite-proof rule name for an adopted canonical loop. A consumer that
 * sees this rule knows the record came from the loop projection and not from the
 * conditional one.
 */
export const LOOP_PROJECTION_RULE = 'project-canonical-natural-loop';

/**
 * Edge constructs that may appear *inside* a projected loop.
 *
 * Everything listed is either the loop's own scaffolding or a construct this
 * projection leaves alone verbatim: an `if` that was already structured stays
 * structured, and a residual `goto` between two blocks of the same loop body is
 * still a legal jump to a retained label.
 *
 * `constraint-edge`, `unknown` and `residual-goto` are deliberately absent. A
 * constraint edge is how an unwind or otherwise foreign edge is preserved, and
 * an unclassified edge means the structurer did not manage to account for it —
 * neither may be swallowed by a loop.
 */
const SAFE_LOOP_EDGE_CONSTRUCTS = new Set([
  'sequence',
  'loop-body',
  'loop-back-edge',
  'loop-guard-exit',
  'loop-break',
  // A nested loop's entry edge starts inside the outer loop and lands on a
  // block the outer loop also owns. Ownership is still checked below, so an
  // edge that leaves the region under this construct is refused there.
  'loop-entry',
  'if-branch',
  'if-join',
  'switch-case',
  'switch-join',
]);

/** Edge kinds that mean "this is not ordinary structured control transfer". */
const UNSAFE_EDGE_KINDS = new Set(['unwind', 'exception']);

const LOOP_NODE_TEXT = /^(?:while|for|do)\b/;
const SWITCH_NODE_TEXT = /^switch\b/;
const EMITTED_WHILE_TEXT = /^while\b/;
const CONDITIONAL_TEXT = /^if\s*\(/;
const JUMP_TEXT = /\bgoto\s+loc_[0-9a-fA-F]+\s*;/g;
const TRAILING_JUMP_TEXT = /\bgoto\s+loc_[0-9a-fA-F]+\s*;\s*$/;

function asAddress(value) {
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function terminatorOf(block) {
  const insts = block?.insts ?? [];
  for (let index = insts.length - 1; index >= 0; index -= 1) {
    const op = insts[index]?.op;
    if (op === 'cbr' || op === 'br' || op === 'ret' || op === 'switch') return insts[index];
  }
  return null;
}

/** Every `goto loc_XXXX;` target address in a rendered line, in order. */
function jumpTargetsOf(text) {
  if (typeof text !== 'string') return [];
  const targets = [];
  const pattern = /\bgoto\s+loc_([0-9a-fA-F]+)\s*;/g;
  let match;
  while ((match = pattern.exec(text)) != null) {
    const address = asAddress(`0x${match[1]}`);
    if (address != null) targets.push(address);
  }
  return targets;
}

function copyNodePreservingControlHistory(node, patch, ir) {
  const copy = { ...node, ...patch };
  const history = readSemanticControlLineHistory(node, ir);
  if (history) registerSemanticControlLineHistory(copy, history);
  return copy;
}

/**
 * Reads which successor a conditional terminator actually takes.
 *
 * Only canonical evidence answers this: an explicit `conditional-true` label on
 * the edge, or the target block the IR branch instruction itself names. Successor
 * order is not polarity, and inferred rendering text is not polarity either, so
 * when neither canonical source answers the branch is refused rather than
 * guessed.
 */
function branchPolarity(block) {
  const term = terminatorOf(block);
  if (term?.op !== 'cbr') return null;
  const succ = block?.succ ?? [];
  if (succ.length !== 2 || succ[0] === succ[1]) return null;
  for (const edge of block.successorEdges ?? []) {
    if (edge?.kind !== 'conditional-true') continue;
    const taken = edge.to;
    if (!succ.includes(taken)) continue;
    const other = succ.find((target) => target !== taken) ?? null;
    if (other == null) continue;
    return { term, taken, other };
  }
  const declared = term?.extra?.targetBlock;
  if (Number.isInteger(declared) && succ.includes(declared)) {
    const other = succ.find((target) => target !== declared) ?? null;
    if (other != null) return { term, taken: declared, other };
  }
  return null;
}

/**
 * Proves one candidate loop region against the canonical loop facts.
 *
 * Returns the projection proof, or null. Every field of the proof is read from
 * the canonical artifacts; nothing is inferred from the rendered body, which is
 * not passed in at all.
 */
export function proveNaturalLoopRegion(region, facts, cfg, dominators, induction, trace = null) {
  void dominators;
  // `trace` is diagnosis only: it records why a loop was refused so an operator
  // can tell a fail-closed refusal from a missing candidate. It never changes
  // the proof or the emitted body.
  const refuse = (reason) => { if (trace) trace.push(reason); return null; };
  if (!region || region.kind !== 'loop') return refuse('not-a-loop-region');
  if (!Number.isInteger(region.entry)) return refuse('region-entry-missing');
  if (!Array.isArray(region.members) || region.members.length === 0) return refuse('region-members-missing');
  if ((region.constraints ?? []).length > 0) return refuse('region-constraints');
  if ((region.residualGotos ?? []).length > 0) return refuse('region-residual-gotos');

  const loop = (induction?.loops ?? []).find((entry) => entry?.header === region.entry) ?? null;
  if (!loop || loop.classification !== 'natural') return refuse('no-natural-loop-fact');
  // A refused loop is published with `completeness: 'unknown'`. Zero loop-carried
  // values is the ordinary `partial` case and is about induction variables, not
  // about control flow, so it is not a reason to refuse the projection.
  if (loop.completeness === 'unknown') return refuse('loop-fact-unknown');
  if (!Number.isInteger(loop.guardBlock)) return refuse('no-guard-block');
  if (!Array.isArray(loop.latches) || loop.latches.length === 0) return refuse('no-latches');
  if (!Array.isArray(loop.exitEdges)) return refuse('no-exit-edges');
  if (!Array.isArray(loop.earlyExitEdges)) return refuse('no-early-exit-edges');
  if (!Array.isArray(loop.nodes) || loop.nodes.length === 0) return refuse('no-loop-nodes');

  // The region and the induction record have to describe the same loop. A
  // disagreement about ownership means at least one of them is stale.
  const members = new Set(region.members);
  if (members.size !== loop.nodes.length) return refuse('region-loop-ownership-mismatch');
  for (const node of loop.nodes) if (!members.has(node)) return refuse('region-loop-ownership-mismatch');

  const byIndex = new Map((cfg?.blocks ?? []).map((block) => [block.index, block]));
  const headerBlock = byIndex.get(region.entry);
  if (!headerBlock) return refuse('header-block-missing');

  // Every edge that starts inside the loop must be one the structurer accounted
  // for as loop scaffolding or as a construct this projection leaves alone.
  for (const edge of facts?.edges ?? []) {
    if (!members.has(edge.from)) continue;
    if (!SAFE_LOOP_EDGE_CONSTRUCTS.has(edge.construct)) return refuse(`unsafe-edge-construct:${edge.construct}`);
    if ((edge.kinds ?? []).some((kind) => UNSAFE_EDGE_KINDS.has(kind))) return refuse('unsafe-edge-kind');
    if (edge.to !== region.entry && !members.has(edge.to) && edge.construct !== 'loop-guard-exit'
      && edge.construct !== 'loop-break') return refuse(`edge-leaves-region:${edge.from}->${edge.to}`);
  }

  // A guard at the header is a pre-test loop. A guard at the single latch is a
  // post-test loop, and only then does the body run at least once by
  // construction.
  const isPreTest = loop.guardBlock === region.entry;
  const isPostTest = !isPreTest && loop.latches.includes(loop.guardBlock);
  if (!isPreTest && !isPostTest) return refuse('guard-not-header-or-latch');

  const guardBlock = byIndex.get(loop.guardBlock);
  const polarity = branchPolarity(guardBlock);
  if (!polarity) return refuse('guard-polarity-unknown');
  const { term, taken, other } = polarity;

  // The induction proof and the per-edge accounting are two artifacts; a loop is
  // only adoptable while they agree. A disagreement means one of them is stale,
  // and a stale proof is never a licence to restructure control flow.
  const edgeByKey = new Map();
  for (const edge of facts?.edges ?? []) {
    if (!Number.isInteger(edge?.from) || !Number.isInteger(edge?.to)) continue;
    edgeByKey.set(`${edge.from}->${edge.to}`, edge);
  }
  for (const latch of loop.latches) {
    const latchEdge = edgeByKey.get(`${latch}->${region.entry}`);
    if (latchEdge?.construct !== 'loop-back-edge') {
      return refuse(`latch-edge-not-canonical:${latch}->${region.entry}:${latchEdge?.construct ?? 'missing'}`);
    }
  }

  let stayIsTaken;
  let exitTarget;
  let bodyStart;
  if (isPreTest) {
    const takenInside = members.has(taken);
    const otherInside = members.has(other);
    // A guard has exactly one arm that stays in the loop and one that leaves it.
    if (takenInside === otherInside) return refuse('guard-arms-not-split');
    stayIsTaken = takenInside;
    bodyStart = takenInside ? taken : other;
    exitTarget = takenInside ? other : taken;
  } else {
    // The post-test guard's back edge is the only way back to the header.
    if (loop.latches.length !== 1) return refuse('post-test-latches');
    if (taken === other) return refuse('post-test-arms-identical');
    if (taken === region.entry) {
      stayIsTaken = true;
      exitTarget = other;
    } else if (other === region.entry) {
      stayIsTaken = false;
      exitTarget = taken;
    } else {
      return refuse('post-test-guard-not-header');
    }
    if (members.has(exitTarget)) return refuse('post-test-exit-inside');
    // "The body runs at least once" is a claim about every path out of the
    // header: the header may not leave the loop and may not fall off the graph.
    const headerEdges = successorEdgesOf(headerBlock);
    if (headerEdges.length === 0) return refuse('post-test-header-dead-end');
    if (headerEdges.some((edge) => !members.has(edge.to))) return refuse('post-test-header-can-leave');
    bodyStart = region.entry;
  }

  // The guard is the loop's normal exit, and a loop with two normal exits has no
  // single condition to hoist.
  // Distinct *targets*, not distinct records: the loop facts may list the same
  // guard exit twice (as the loop exit and as the guard's other arm), and one
  // target is still one condition to hoist.
  const guardExits = [...new Set(loop.exitEdges
    .filter((edge) => edge.from === loop.guardBlock).map((edge) => edge.to))];
  if (guardExits.length !== 1 || guardExits[0] !== exitTarget) return refuse('guard-exit-not-unique');

  // Early exits. The structurer only calls an exit a `loop-break` when every
  // non-guard exit of the loop agrees on one target, so anything else here means
  // the exit set is not a plain sequence of breaks.
  const breakTargets = [...new Set(loop.earlyExitEdges.map((edge) => edge.to))].sort((left, right) => left - right);
  if (breakTargets.length > 1) return refuse('multiple-break-targets');
  for (const edge of loop.earlyExitEdges) {
    if (members.has(edge.to)) return refuse('break-target-inside');
    // `break;` lands where the construct ends, so an early exit the structurer
    // does not itself name `loop-break` is not a proven break.
    const breakEdge = edgeByKey.get(`${edge.from}->${edge.to}`);
    if (breakEdge?.construct !== 'loop-break') {
      return refuse(`break-edge-not-canonical:${edge.from}->${edge.to}:${breakEdge?.construct ?? 'missing'}`);
    }
  }
  const breakTarget = breakTargets.length === 1 ? breakTargets[0] : null;

  // A loop with two distinct exit targets has no single construct end, so its
  // early exit cannot be a `break;` and the loop keeps its legacy jumps.
  if (breakTarget != null && breakTarget !== exitTarget) return refuse('multi-exit-loop');

  // Every exit the induction proof lists has to be accounted for as either this
  // loop's own guard exit or one of those proven breaks.
  const breakKeys = new Set(loop.earlyExitEdges.map((edge) => `${edge.from}->${edge.to}`));
  for (const edge of loop.exitEdges) {
    const key = `${edge.from}->${edge.to}`;
    if (!edgeByKey.has(key)) return refuse(`exit-edge-accounting-mismatch:${key}:missing`);
    if (key === `${loop.guardBlock}->${exitTarget}`) continue;
    if (!breakKeys.has(key)) return refuse(`exit-edge-accounting-mismatch:${key}:not-a-break`);
  }

  return {
    header: region.entry,
    loop,
    members,
    guardBlock: loop.guardBlock,
    guardTerminator: term,
    // The block the branch instruction actually takes. The rendered guard line
    // has to name this block; when the artifact and the rendered text disagree,
    // neither is trusted.
    takenBlock: taken,
    otherBlock: other,
    bodyStart,
    exitTarget,
    breakTarget,
    // Both `break;` and `continue;` are only safe for an edge this very loop
    // proved: a nested loop's jump belongs to the nested loop, and an edge into
    // the loop is not an exit at all.
    breakUsable: breakTarget != null,
    breakEdgeKeys: breakKeys,
    latchEdgeKeys: new Set(loop.latches.map((latch) => `${latch}->${region.entry}`)),
    form: isPreTest ? 'while' : 'do-while',
    // The rendered condition describes the arm the branch takes, so the loop
    // condition has to be asked for in the other polarity when the taken arm is
    // the one that leaves.
    invert: !stayIsTaken,
  };
}

/** Whether a candidate loop region is provable and safe for adoption. */
export function isAdoptableLoopRegion(region, facts, cfg, dominators, induction) {
  return proveNaturalLoopRegion(region, facts, cfg, dominators, induction) != null;
}

function dominatorDepth(dominators, block) {
  let depth = 0;
  let current = block;
  const idom = dominators?.idom;
  const visited = new Set();
  while (current != null && current >= 0 && !visited.has(current) && visited.size < 4096) {
    visited.add(current);
    const next = idom?.[current];
    if (next == null || next === current) break;
    depth += 1;
    current = next;
  }
  return depth;
}

function loopDepth(proof, dominators) {
  if (Number.isInteger(proof.loop.depth)) return proof.loop.depth;
  return dominatorDepth(dominators, proof.header);
}

/** The single line that closes a projected loop. */
function closeTextOf(form, conditionText) {
  return form === 'do-while' ? `} while (${conditionText});` : '}';
}

/**
 * Locates the brace-matched span of an already-emitted loop construct.
 *
 * Returns `{ start, end }` where `start` is the header index and `end` is the
 * index of the `}` (or `} while (...);`) that closes it, or null when the
 * construct is not a braced loop header or never closes.
 */
function findAlreadyProjectedSpan(body, headerIndex) {
  const header = body[headerIndex];
  if (header?.kind !== 'ctrl' || typeof header.text !== 'string') return null;
  if (!/\{\s*$/.test(header.text.trim())) return null;
  let depth = 0;
  for (let index = headerIndex; index < body.length; index += 1) {
    const node = body[index];
    if (node?.kind !== 'ctrl' || typeof node.text !== 'string') continue;
    const opens = (node.text.match(/\{/g) ?? []).length;
    const closes = (node.text.match(/\}/g) ?? []).length;
    depth += opens - closes;
    if (depth === 0 && index > headerIndex) return { start: headerIndex, end: index };
    if (depth < 0) return null;
  }
  return null;
}

/**
 * Refines break/continue gotos inside a loop the upstream renderer already
 * emitted for this region.
 *
 * The construct itself is left exactly as found — only residual jumps whose
 * canonical edges this very proof owns are rewritten. Returns `{ body, record,
 * form }` when at least one jump was proven and rewritten, null when nothing
 * was provable (including a malformed or unclosed construct), which always
 * means "leave the body alone".
 */
function refineAlreadyProjectedLoop(body, proof, ctx, headerIndex, blockOf, blockIndexAt) {
  const span = findAlreadyProjectedSpan(body, headerIndex);
  if (!span) return null;

  // A jump whose target sits inside a nested already-emitted loop or switch
  // must not become a bare `break`/`continue` here: those statements bind to
  // the innermost construct. Leaving the goto is the fail-closed answer.
  const nestedRanges = [];
  for (let index = span.start + 1; index < span.end; index += 1) {
    const node = body[index];
    if (node?.kind !== 'ctrl' || typeof node.text !== 'string') continue;
    const text = node.text.trim();
    if (!LOOP_NODE_TEXT.test(text) && !SWITCH_NODE_TEXT.test(text)) continue;
    if (blockOf(node) === proof.header) continue;
    const nested = findAlreadyProjectedSpan(body, index);
    if (!nested) continue;
    nestedRanges.push(nested);
    index = nested.end;
  }
  const insideNestedConstruct = (index) =>
    nestedRanges.some((range) => index >= range.start && index <= range.end);

  // The emitted header text — not the CFG proof form — decides whether a
  // latch goto may become `continue`. A proof-while paired with an emitted
  // `for (...)` would run the for-increment on continue while the original
  // goto bypassed it.
  const emittedHeader = String(body[span.start]?.text ?? '').trim();
  const emittedWhileHeader = EMITTED_WHILE_TEXT.test(emittedHeader);
  // A source-level break lands on the first rendered statement after the loop.
  // Only rewrite when that rendered destination is the exact CFG exit proven
  // by this loop; an intervening rendered block would change control flow.
  const afterLoop = span.end + 1 < body.length ? body[span.end + 1] : null;
  const breakLandsAtExit = afterLoop != null && blockOf(afterLoop) === proof.exitTarget;

  const rewrites = [];
  for (let index = span.start + 1; index < span.end; index += 1) {
    if (insideNestedConstruct(index)) continue;
    const node = body[index];
    const owner = blockOf(node);
    // Ownership is breakEdgeKeys/latchEdgeKeys from this proof: a jump whose
    // block is not a member cannot be refined under this construct.
    if (owner == null || !proof.members.has(owner)) continue;
    const targets = jumpTargetsOf(node.text);
    if (targets.length === 0) continue;
    for (const target of targets) {
      const targetBlock = blockIndexAt(target);
      if (targetBlock == null) return null;
      const edge = (ctx.facts?.edges ?? []).find((record) =>
        record.from === owner && record.to === targetBlock) ?? null;
      if (!edge) return null;
      if (targets.length > 1) continue;
      if (edge.construct === 'loop-break') {
        if (!breakLandsAtExit || !proof.breakUsable
          || !proof.breakEdgeKeys.has(`${edge.from}->${edge.to}`)) continue;
        rewrites.push({ index, text: 'break', edge, targetBlock });
        continue;
      }
      if (edge.construct === 'loop-back-edge') {
        if (!proof.latchEdgeKeys.has(`${edge.from}->${edge.to}`)) continue;
        // The construct is already closed with `}`, so there is no closing bare
        // jump to absorb. An interior back edge may become `continue` only when
        // both the CFG form is a pre-test loop and the emitted C header is a
        // `while` — for/do headers rebind continue to a different target.
        if (proof.form !== 'while' || !emittedWhileHeader) continue;
        rewrites.push({ index, text: 'continue', edge, targetBlock });
      }
    }
  }
  if (rewrites.length === 0) return null;

  const selection = Object.freeze({
    header: proof.header,
    bodyStart: proof.bodyStart,
    exit: proof.exitTarget,
    form: proof.form === 'do-while' ? 'do-while' : 'while-loop',
    invert: proof.invert,
    breakTarget: proof.breakUsable ? proof.breakTarget : null,
  });
  const headerNode = body[span.start];
  const record = Object.freeze({
    rule: LOOP_PROJECTION_RULE,
    phase: 'phase8-control-projection',
    before: 'control:natural-loop-goto',
    after: 'control:loop-break-continue-refine',
    evidence: Object.freeze({
      kind: 'canonical-loop-facts-adoption',
      version: LOOP_CONTROL_PROJECTION_VERSION,
      regionEntry: proof.header,
      regionExits: Object.freeze([...(proof.loop.exitEdges ?? [])].map((edge) => `${edge.from}->${edge.to}`)),
      regionForm: proof.form,
      guardBlock: proof.guardBlock,
      latches: Object.freeze([...(proof.loop.latches ?? [])]),
      bodyStart: proof.bodyStart,
      exitTarget: proof.exitTarget,
      breakTarget: proof.breakTarget,
      detail: 'refined proven break/continue edges inside an already-emitted loop construct; the construct and every canonical edge are preserved',
    }),
    originHistory: expressionOriginHistory(
      { source: headerNode?.source ?? null },
      { source: headerNode?.source ?? null },
    ),
  });

  const rewriteByIndex = new Map(rewrites.map((rewrite) => [rewrite.index, rewrite]));
  const next = [];
  for (let index = 0; index < body.length; index += 1) {
    const node = body[index];
    const rewrite = rewriteByIndex.get(index);
    if (!rewrite) {
      next.push(node);
      continue;
    }
    if (typeof node.text !== 'string' || !TRAILING_JUMP_TEXT.test(node.text)) return null;
    const text = node.text.replace(TRAILING_JUMP_TEXT, `${rewrite.text};`);
    const rewritten = { ...node, text };
    const previous = readSemanticControlLineHistory(node, ctx.ir);
    registerSemanticControlLineHistory(rewritten, Object.freeze({
      ir: ctx.ir ?? null,
      instruction: null,
      canonical: { isCurrent: () => true },
      records: Object.freeze([...(previous?.records ?? []), record]),
      selection: Object.freeze({
        ...selection,
        form: rewrite.text === 'break' ? 'loop-break' : 'loop-continue',
        target: rewrite.targetBlock,
      }),
      isCurrent: () => true,
    }));
    next.push(rewritten);
  }
  return { body: next, record, form: proof.form };
}

/**
 * Projects one already-proven loop into the rendered body.
 *
 * Returns `{ body, record, form }` or null. Null is the fallback answer and it
 * always means the body is to be left exactly as it was found.
 */
function projectOneLoop(body, proof, ctx) {
  const blockOf = (node) => {
    try {
      const index = ctx.blockOfNode(node);
      return Number.isInteger(index) ? index : null;
    } catch {
      return null;
    }
  };

  const addressToBlock = new Map();
  const blockIndexAt = (address) => {
    if (address == null) return null;
    const key = String(address);
    if (addressToBlock.has(key)) return addressToBlock.get(key);
    let resolved = null;
    for (const block of ctx.cfg?.blocks ?? []) {
      const candidate = asAddress(ctx.blockAddress(block?.index));
      if (candidate != null && candidate === address) { resolved = block.index; break; }
    }
    addressToBlock.set(key, resolved);
    return resolved;
  };

  // The upstream renderer may already have emitted this loop. Projecting it a
  // second time would nest two constructs over one region, so the construct is
  // left alone — but proven break/continue gotos inside it are still refined.
  // The refine path does not need header/exit addresses, so it runs first.
  for (let index = 0; index < body.length; index += 1) {
    const node = body[index];
    if (node?.kind !== 'ctrl' || typeof node.text !== 'string') continue;
    if (!LOOP_NODE_TEXT.test(node.text.trim())) continue;
    if (blockOf(node) !== proof.header) continue;
    return refineAlreadyProjectedLoop(body, proof, ctx, index, blockOf, blockIndexAt);
  }

  const headerAddress = asAddress(ctx.blockAddress(proof.header));
  const exitAddress = asAddress(ctx.blockAddress(proof.exitTarget));
  if (headerAddress == null || exitAddress == null) return null;

  // Ownership. Every rendered node whose block belongs to the loop must form one
  // contiguous run: a loop whose nodes are interleaved with nodes nobody owns
  // cannot be lifted into a construct without moving something.
  const owned = [];
  for (let index = 0; index < body.length; index += 1) {
    const owner = blockOf(body[index]);
    if (owner != null && proof.members.has(owner)) owned.push(index);
  }
  if (owned.length === 0) return null;
  const spanStart = owned[0];
  const spanEnd = owned[owned.length - 1];
  if (owned.length !== spanEnd - spanStart + 1) return null;

  // The construct is spliced where the loop began, so whatever executes next
  // after it must be the block the guard leaves to. This is the emitted-order
  // half of "the normal exit is unique".
  const after = spanEnd + 1 < body.length ? body[spanEnd + 1] : null;
  if (after == null || blockOf(after) !== proof.exitTarget) return null;

  const removeIndices = new Set();
  const rewrites = [];
  const guardNodes = [];
  let conditionalGuardIndex = -1;
  // Provenance of the nodes the construct replaces. A `while` line stands in for
  // the guard's condition and its exit jump, so it has to carry the addresses
  // those two lines carried: dropping them would silently shrink the emitted
  // source map, which the frozen corpus reads as a provenance loss.
  let closingSource = null;

  for (let index = spanStart; index <= spanEnd; index += 1) {
    const node = body[index];
    const owner = blockOf(node);
    if (owner === proof.guardBlock) {
      // The deciding block contributes exactly the branch that becomes the loop
      // condition. A statement here would have to move across the condition
      // check, which is a reordering of observable work.
      if (node.kind === 'label') continue;
      if (typeof node.text !== 'string') return null;
      if (node.kind === 'ctrl' && CONDITIONAL_TEXT.test(node.text)) {
        if (conditionalGuardIndex >= 0) return null;
        conditionalGuardIndex = index;
        guardNodes.push(index);
        continue;
      }
      if (node.kind === 'ctrl' && node.text.trim() === '}') return null;
      if (node.kind === 'stmt' && /^goto\s/.test(node.text.trim())) { guardNodes.push(index); continue; }
      return null;
    }
    const targets = jumpTargetsOf(node.text);
    if (targets.length === 0) continue;
    // A jump the CFG does not know about is a stale node, not a construct.
    for (const target of targets) {
      const targetBlock = blockIndexAt(target);
      if (targetBlock == null) return null;
      const edge = (ctx.facts?.edges ?? []).find((record) =>
        record.from === owner && record.to === targetBlock) ?? null;
      if (!edge) return null;
      if (targets.length > 1) continue;
      if (edge.construct === 'loop-break') {
        if (!proof.breakUsable || !proof.breakEdgeKeys.has(`${edge.from}->${edge.to}`)) continue;
        rewrites.push({ index, text: 'break', edge, targetBlock });
        continue;
      }
      if (edge.construct === 'loop-back-edge') {
        if (!proof.latchEdgeKeys.has(`${edge.from}->${edge.to}`)) continue;
        // The rendered back edge is only `continue;` when it is not the edge that
        // closes the construct, and only in a pre-test loop, where `continue`
        // re-tests the same condition that jumping to the header does. A
        // post-test loop would have to fall through the condition instead.
        //
        // Only a bare jump closes the construct: a conditional arm to the header
        // is a `continue`-shaped edge, and deleting it would delete a test.
        const bareJump = /^goto\s+loc_[0-9a-fA-F]+\s*;$/.test(node.text.trim());
        if (index === spanEnd && bareJump) { closingSource = node.source ?? null; removeIndices.add(index); continue; }
        if (proof.form !== 'while' || index === spanEnd) continue;
        rewrites.push({ index, text: 'continue', edge, targetBlock });
      }
    }
  }

  if (guardNodes.length === 0 || guardNodes.length > 2) return null;
  const guardSource = mergeSource(...guardNodes.map((index) => body[index]?.source ?? null));
  for (const index of guardNodes) removeIndices.add(index);

  const headerLabelIndex = (() => {
    for (let index = spanStart; index <= spanEnd; index += 1) {
      const node = body[index];
      if (node?.kind !== 'label' || typeof node.text !== 'string') continue;
      if (!/^loc_[0-9a-fA-F]+:$/.test(node.text.trim())) continue;
      if (blockOf(node) !== proof.header) continue;
      return index;
    }
    return -1;
  })();

  // The guard has exactly one conditional line and exactly one line that leaves
  // to the proven exit. The conditional line must also name the block the branch
  // instruction canonically takes: a guard whose rendered target and whose edge
  // polarity disagree is refused instead of being rendered with the wrong
  // polarity, which is how a loop would silently invert.
  if (conditionalGuardIndex < 0) return null;
  const takenAddress = asAddress(ctx.blockAddress(proof.takenBlock));
  if (takenAddress == null) return null;
  if (!ctx.textJumpsToAddress(body[conditionalGuardIndex].text, takenAddress)) return null;
  let leavesToExit = 0;
  for (const index of guardNodes) {
    if (ctx.textJumpsToAddress(body[index].text, exitAddress)) leavesToExit += 1;
  }
  if (leavesToExit !== 1) return null;

  // The condition is asked of the canonical branch instruction first. The
  // fallback reuses the expression the renderer already emitted for that same
  // instruction in the guard line, negated when the loop continues on the arm
  // the branch does not take; a condition neither source can express refuses the
  // loop rather than inventing one.
  const takenExpression = (() => {
    const match = String(body[conditionalGuardIndex].text).match(/^if\s*\((.*)\)\s*goto\s+loc_[0-9a-fA-F]+\s*;\s*$/);
    const expression = match?.[1]?.trim() ?? null;
    return expression != null && expression.length > 0 ? expression : null;
  })();
  const conditionText = (() => {
    try {
      const rendered = ctx.renderCondition(proof.guardTerminator, proof.invert);
      if (typeof rendered === 'string') {
        const text = rendered.trim();
        if (text.length > 0 && text !== 'condition' && !text.includes('unknown')) return text;
      }
    } catch { /* Fall through to the rendered guard expression. */ }
    if (takenExpression == null) return null;
    return proof.invert ? `!(${takenExpression})` : takenExpression;
  })();
  if (conditionText == null) return null;

  // The construct replaces the guard line, which is where the condition used to
  // be emitted, so the guard's own indentation is the construct's. Body lines
  // keep their relative depth one level inside it. This is the same placement
  // rule the conditional projection uses for its entry branch.
  const entryIndent = (() => {
    const guard = conditionalGuardIndex >= 0 ? body[conditionalGuardIndex] : null;
    if (guard && Number.isInteger(guard.indent)) return guard.indent;
    const label = headerLabelIndex >= 0 ? body[headerLabelIndex] : null;
    if (label && Number.isInteger(label.indent)) return label.indent;
    const first = body[spanStart];
    return Number.isInteger(first?.indent) ? first.indent : 1;
  })();

  const headerSource = mergeSource(ctx.controlSource(proof.guardTerminator, proof.guardBlock), guardSource);
  const record = Object.freeze({
    rule: LOOP_PROJECTION_RULE,
    phase: 'phase8-control-projection',
    before: 'control:natural-loop-goto',
    after: proof.form === 'do-while' ? 'control:do-while-loop' : 'control:while-loop',
    evidence: Object.freeze({
      kind: 'canonical-loop-facts-adoption',
      version: LOOP_CONTROL_PROJECTION_VERSION,
      regionEntry: proof.header,
      regionExits: Object.freeze([...(proof.loop.exitEdges ?? [])].map((edge) => `${edge.from}->${edge.to}`)),
      regionForm: proof.form,
      guardBlock: proof.guardBlock,
      latches: Object.freeze([...(proof.loop.latches ?? [])]),
      bodyStart: proof.bodyStart,
      exitTarget: proof.exitTarget,
      breakTarget: proof.breakTarget,
      detail: proof.form === 'do-while'
        ? 'adopted a natural loop whose header cannot leave the region and whose single latch holds the guard, so the body runs at least once; the guard condition and every canonical edge are preserved'
        : 'adopted a natural loop whose header holds the guard with one arm inside the region and one proven exit; the guard condition and every canonical edge are preserved',
    }),
    originHistory: expressionOriginHistory({ source: headerSource }, { source: headerSource }),
  });

  const headerNode = {
    kind: 'ctrl',
    indent: entryIndent,
    text: proof.form === 'do-while' ? 'do {' : `while (${conditionText}) {`,
    block: proof.header,
    row: proof.guardTerminator?.row ?? null,
    addr: proof.guardTerminator?.address ?? headerAddress,
    source: headerSource,
    semantic: { op: 'control-render', ir: proof.guardTerminator?.id ?? null, expression: null },
  };
  const closeNode = {
    kind: 'ctrl',
    indent: entryIndent,
    text: closeTextOf(proof.form, conditionText),
    block: proof.loop.latches[0] ?? proof.guardBlock,
    row: null,
    addr: null,
    source: mergeSource(headerSource, closingSource),
    semantic: { op: 'control-render', ir: proof.guardTerminator?.id ?? null, expression: null },
  };

  const selection = Object.freeze({
    header: proof.header,
    bodyStart: proof.bodyStart,
    exit: proof.exitTarget,
    form: proof.form === 'do-while' ? 'do-while' : 'while-loop',
    invert: proof.invert,
    breakTarget: proof.breakUsable ? proof.breakTarget : null,
  });
  const history = Object.freeze({
    ir: ctx.ir ?? null,
    instruction: proof.guardTerminator ?? null,
    canonical: { isCurrent: () => true },
    records: Object.freeze([record]),
    selection,
    isCurrent: () => true,
  });
  registerSemanticControlLineHistory(headerNode, history);
  registerSemanticControlLineHistory(closeNode, Object.freeze({ ...history, selection: undefined }));

  const rewriteByIndex = new Map(rewrites.map((rewrite) => [rewrite.index, rewrite]));
  const bodyNodes = [];
  for (let index = spanStart; index <= spanEnd; index += 1) {
    if (removeIndices.has(index)) continue;
    // The header label is either hoisted in front of the construct or dropped;
    // it is never a node of the loop body.
    if (index === headerLabelIndex) continue;
    const node = body[index];
    const rewrite = rewriteByIndex.get(index);
    if (!rewrite) {
      bodyNodes.push(copyNodePreservingControlHistory(
        node,
        { indent: (node.indent ?? entryIndent) + 1 },
        ctx.ir,
      ));
      continue;
    }
    if (typeof node.text !== 'string' || !TRAILING_JUMP_TEXT.test(node.text)) return null;
    const text = node.text.replace(TRAILING_JUMP_TEXT, `${rewrite.text};`);
    const rewritten = { ...node, indent: (node.indent ?? entryIndent) + 1, text };
    registerSemanticControlLineHistory(rewritten, Object.freeze({
      ir: ctx.ir ?? null,
      instruction: null,
      canonical: { isCurrent: () => true },
      records: Object.freeze([record]),
      selection: Object.freeze({
        ...selection,
        form: rewrite.text === 'break' ? 'loop-break' : 'loop-continue',
        target: rewrite.targetBlock,
      }),
      isCurrent: () => true,
    }));
    bodyNodes.push(rewritten);
  }

  const constructed = [headerNode, ...bodyNodes, closeNode];

  // The label survives as long as something that is still emitted jumps to it.
  // A jump into the loop from outside stays a jump into the loop; the label only
  // disappears once nothing references the address any more.
  const labelStillReferenced = (() => {
    if (headerLabelIndex < 0) return false;
    const retained = [];
    for (let index = 0; index < body.length; index += 1) {
      if (index === headerLabelIndex) continue;
      if (index >= spanStart && index <= spanEnd) continue;
      if (removeIndices.has(index)) continue;
      retained.push(body[index]);
    }
    return [...retained, ...constructed].some((node) => ctx.textJumpsToAddress(node?.text, headerAddress));
  })();

  const prefix = [];
  if (headerLabelIndex >= 0) {
    if (labelStillReferenced) prefix.push(body[headerLabelIndex]);
    else removeIndices.add(headerLabelIndex);
  }

  // A dropped label's addresses have to survive too, and the label is not
  // replaced by anything in particular: its provenance belongs to the construct
  // that took over its block.
  if (headerLabelIndex >= 0 && !labelStillReferenced) {
    headerNode.source = mergeSource(headerNode.source, body[headerLabelIndex]?.source ?? null);
    closeNode.source = mergeSource(closeNode.source, body[headerLabelIndex]?.source ?? null);
  }

  const next = [];
  for (let index = 0; index < body.length; index += 1) {
    if (index === spanStart) next.push(...prefix, ...constructed);
    if (index >= spanStart && index <= spanEnd) continue;
    if (!removeIndices.has(index)) next.push(body[index]);
  }

  return { body: next, record, form: proof.form };
}

/**
 * Absorbs a jump whose target is emitted immediately after it.
 *
 * The legacy renderer emits one `goto loc_XXXX;` per unconditional block edge,
 * which means a loop body that used to be a jump chain keeps a jump that lands
 * on the very next emitted line. That jump is not an edge decision any more: the
 * fallthrough performs it already, so the same block sequence is executed with
 * or without it. Nothing here is inferred from the CFG — adjacency in the body
 * that is about to be emitted is the whole proof, and the label itself is left
 * in place for whatever still jumps to it.
 */
function absorbFallthroughJumps(body, ir) {
  const out = [];
  for (let index = 0; index < body.length; index += 1) {
    const node = body[index];
    const next = body[index + 1];
    if (node?.kind === 'stmt' && typeof node.text === 'string' && next?.kind === 'label') {
      const jump = /^goto\s+loc_([0-9a-fA-F]+)\s*;$/.exec(node.text.trim());
      const label = /^loc_([0-9a-fA-F]+):$/.exec(String(next.text).trim());
      if (jump && label && jump[1].toLowerCase() === label[1].toLowerCase()) {
        // The label that took the jump over keeps the jump's provenance: the
        // block is still entered, just without the branch.
        out.push(copyNodePreservingControlHistory(
          next,
          { source: mergeSource(next.source, node.source) },
          ir,
        ));
        index += 1;
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

/**
 * Drops labels the projected body no longer jumps to.
 *
 * A label is only ever a handle for a jump. Once a loop's guard and back edge
 * become the construct itself, the labels that only those jumps addressed have
 * no reader left, and emitting them would leave the body jumping nowhere while
 * still claiming an address. The test is text-level on purpose: it is performed
 * on the exact body that is about to be emitted, so a label survives iff some
 * emitted line still references it.
 */
function pruneDanglingLabels(body, ir) {
  const referenced = new Set();
  for (const node of body) {
    for (const target of jumpTargetsOf(node?.text)) referenced.add(String(target));
  }
  const out = [];
  let carried = null;
  for (const node of body) {
    if (!isDanglingLabel(node, referenced)) {
      out.push(carried == null ? node : copyNodePreservingControlHistory(
        node,
        { source: mergeSource(node.source, carried) },
        ir,
      ));
      carried = null;
      continue;
    }
    // Nothing jumps here any more, but the block still exists: hand the label's
    // addresses to the line that took its place so the source map does not lose
    // the address the label was the last carrier of.
    carried = mergeSource(carried, node.source);
  }
  if (carried != null && out.length > 0) {
    out[out.length - 1] = copyNodePreservingControlHistory(
      out[out.length - 1],
      { source: mergeSource(out[out.length - 1].source, carried) },
      ir,
    );
  }
  return out;
}

function isDanglingLabel(node, referenced) {
  if (node?.kind !== 'label' || typeof node.text !== 'string') return false;
  const match = /^loc_([0-9a-fA-F]+):$/.exec(node.text.trim());
  if (!match) return false;
  const address = asAddress(`0x${match[1]}`);
  if (address == null) return false;
  return !referenced.has(String(address));
}

/**
 * Projects every proven natural loop in a rendered body.
 *
 * Returns `{ body, records, adopted }` when something was adopted, `null` when
 * nothing was provable — the caller then keeps the body it already had,
 * referentially — or `LOOP_PROJECTION_CANCELLED` when the abort predicate fired,
 * which the caller must treat as "publish nothing", not as "no changes".
 */
export function projectNaturalLoops(body, ctx = {}) {
  if (!Array.isArray(body) || body.length === 0) return null;
  const facts = ctx.facts;
  const induction = ctx.induction;
  if (!facts || !induction) return null;
  if (typeof ctx.blockOfNode !== 'function') return null;
  if (typeof ctx.blockAddress !== 'function') return null;
  if (typeof ctx.textJumpsToAddress !== 'function') return null;
  if (typeof ctx.renderCondition !== 'function') return null;
  if (typeof ctx.controlSource !== 'function') return null;

  const candidates = [];
  for (const region of facts.regions ?? []) {
    if (region?.kind !== 'loop') continue;
    const proof = proveNaturalLoopRegion(region, facts, ctx.cfg, ctx.dominators, induction);
    if (proof) candidates.push({ region, proof });
  }
  if (candidates.length === 0) return null;

  // Innermost first. An inner loop that is projected before its parent stays part
  // of the parent's owned nodes, so the parent's ownership proof sees one
  // construct instead of two competing claims over the same blocks.
  candidates.sort((left, right) => {
    const depthLeft = loopDepth(left.proof, ctx.dominators);
    const depthRight = loopDepth(right.proof, ctx.dominators);
    if (depthLeft !== depthRight) return depthRight - depthLeft;
    return right.proof.header - left.proof.header;
  });

  let workingBody = [...body];
  const records = [];
  const adopted = [];
  for (const candidate of candidates) {
    if (typeof ctx.shouldAbort === 'function' && ctx.shouldAbort() === true) return LOOP_PROJECTION_CANCELLED;
    const outcome = projectOneLoop(workingBody, candidate.proof, ctx);
    if (!outcome) continue;
    workingBody = outcome.body;
    records.push(outcome.record);
    adopted.push(candidate.region);
  }
  if (records.length === 0) return null;
  return { body: pruneDanglingLabels(absorbFallthroughJumps(workingBody, ctx.ir), ctx.ir), records, adopted };
}
