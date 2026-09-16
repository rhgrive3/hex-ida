/*
 * query/causal.js — compact causal paths over SSA / Memory SSA slices.
 */
import { backwardSlice, forwardSlice, causalChain } from '../slice.js';
import { semanticFacts, semanticEvidenceIds } from '../semantic.js';
import { valueInfo } from '../ir.js';

function evidenceAt(facts, row) {
  return semanticEvidenceIds(facts.filter((f) => f.row === row));
}

function boundedOption(value, fallback, min, max = Infinity) {
  /* #3189: explicit budgets must be finite primitive numbers. Structured
     values (arrays/objects) and numeric strings must not gain budget
     authority through Number coercion; they fail closed to the fallback. */
  if (value == null || value === '' || value === false) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.floor(Math.max(min, Math.min(max, value)));
}

function nodeOf(step, index, ir, facts, fn) {
  const value = step && step.value ? valueInfo(step.value) : null;
  return {
    id: 'causal:' + index + ':' + String(step && step.row),
    address: step && step.address != null ? step.address : null,
    function: fn != null ? fn : (ir.startAddress != null ? ir.startAddress : null),
    row: step && step.row != null ? step.row : null,
    kind: step && step.kind || 'unknown',
    value,
    relation: index === 0 ? 'source' : 'flows-to',
    evidence: evidenceAt(facts, step && step.row),
    confidence: 1,
    confidenceSource: 'semantic-ir',
    detail: step ? {
      op: step.op || step.sub || null,
      target: step.target == null ? null : step.target,
      location: step.location || null,
      slot: step.slot || null,
    } : null,
  };
}

/** Minimal human-sized causal path for one SSA/Memory-SSA seed. */
export function minimalCausalPath(ir, seed, opts) {
  if (!ir || !seed) return { nodes: [], edges: [], truncated: false, elided: 0, engine: 'semantic-ir' };
  const limit = boundedOption(opts && opts.limit, 8, 2);
  const chain = causalChain(ir, seed, { ...(opts || {}), limit });
  const facts = semanticFacts(ir);
  const fn = opts && opts.function != null ? opts.function : ir.startAddress;
  const nodes = chain.steps.map((step, i) => nodeOf(step, i, ir, facts, fn));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id, relation: nodes[i].relation, confidenceSource: 'semantic-ir' });
  }
  return {
    nodes,
    edges,
    source: nodes[0] || null,
    sink: nodes[nodes.length - 1] || null,
    truncated: !!chain.truncated,
    elided: chain.elided || 0,
    engine: 'semantic-ir',
  };
}

export function sliceResult(ir, seed, direction, opts) {
  if (!ir || !seed) return { nodes: [], truncated: false, engine: 'semantic-ir' };
  const result = direction === 'forward' ? forwardSlice(ir, seed, opts) : backwardSlice(ir, seed, opts);
  const facts = semanticFacts(ir);
  const fn = opts && opts.function != null ? opts.function : ir.startAddress;
  const nodes = (result.instructions || []).map((inst, index) => ({
    id: 'slice:' + inst.id,
    instructionId: inst.id,
    address: inst.address == null ? null : inst.address,
    function: fn == null ? null : fn,
    row: inst.row,
    op: inst.op,
    sub: inst.sub || null,
    evidence: evidenceAt(facts, inst.row),
    relation: direction === 'forward' ? 'use' : 'dependency',
    confidence: 1,
    confidenceSource: 'semantic-ir',
    order: index,
  }));
  return { nodes, truncated: !!result.truncated, engine: 'semantic-ir' };
}

/**
 * Bounded call-graph paths using ProgramIndex without forcing function analysis.
 * The result is deliberately explicit about incompleteness: [] is only proof
 * of absence when complete is true.
 *
 * Frontiers are represented with parent-linked states rather than copied
 * prefix arrays so that retaining the live queue costs O(1) per pending state,
 * and a solver-owned `maxFrontier` admission bound stops growth *before* the
 * BFS can retain millions of path arrays (issue #8915). When that bound is
 * reached the search fails closed with `frontier-limit` rather than exhausting
 * the heap before `visited-limit` becomes observable.
 */
export function functionPaths(program, from, to, opts) {
  const maxDepth = boundedOption(opts && opts.maxDepth, 6, 1, 12);
  const maxPaths = boundedOption(opts && opts.maxPaths, 8, 1, 32);
  const maxVisited = boundedOption(opts && opts.maxVisited, 10000, 16, 20000);
  // Retained-frontier ceiling. It is independent of maxVisited so a valid
  // high-fanout graph cannot require memory proportional to (fanout ^ depth)
  // just to *discover* that the visited budget was already exceeded.
  const maxFrontier = boundedOption(opts && opts.maxFrontier, 20000, 16, 50000);
  const result = { paths: [], complete: true, truncated: false, reasons: [], visited: 0 };
  if (!program) {
    result.complete = false;
    result.truncated = true;
    result.reasons = ['program-unavailable'];
    return result;
  }
  if (from == null || to == null) {
    result.complete = false;
    result.truncated = true;
    result.reasons = ['invalid-endpoint'];
    return result;
  }

  const reasons = new Set();
  // Ancestor walk is bounded by maxDepth + 1, so the per-state work of the
  // simple-path cycle guard stays O(depth) — the same semantics #4529 and
  // #6308 rely on, now without copying a full prefix per queued edge.
  const onPath = (node, addr) => { for (let n = node; n; n = n.parent) { if (n.addr === addr) return true; } return false; };
  const reconstruct = (node) => { const out = []; for (let n = node; n; n = n.parent) out.push(n.addr); out.reverse(); return out; };

  const q = [{ addr: from, parent: null, depth: 0 }];
  let cursor = 0;
  let frontierReached = false;
  while (cursor < q.length && result.paths.length < maxPaths) {
    if (result.visited >= maxVisited) { reasons.add('visited-limit'); break; }
    const node = q[cursor++];
    result.visited++;
    const head = node.addr;
    if (head === to) { result.paths.push(reconstruct(node)); continue; }
    // The source is depth zero; only traversed call edges consume depth.
    if (node.depth >= maxDepth) { reasons.add('depth-limit'); continue; }

    let range = null;
    try {
      range = program.functionRange(head);
    } catch {
      reasons.add('function-range-error');
      range = null;
    }
    // Unknown end means "unknown body", never "from here to EOF" — the same
    // contract rank.js applies. Callee evidence is valid only for an exact,
    // bounded containing function; expanding an unbounded head would claim
    // later functions' call sites as this function's callees (issue #6308).
    if (!range || range.end == null) {
      reasons.add('function-range-unknown');
      continue;
    }
    let callees = [];
    try {
      callees = program.calleesOf(head, range.end, 201) || [];
    } catch {
      reasons.add('callee-query-error');
      callees = [];
    }
    if (callees.length > 200) { reasons.add('callee-limit'); callees = callees.slice(0, 200); }
    for (const c of callees) {
      const addr = c && c.addr != null ? c.addr : c;
      if (addr == null || onPath(node, addr)) continue;
      // Admit the child only while the live frontier stays within budget;
      // stop before allocating the next retained state, not after.
      if (q.length - cursor >= maxFrontier) { frontierReached = true; break; }
      q.push({ addr, parent: node, depth: node.depth + 1 });
    }
    if (frontierReached) break;
  }
  if (frontierReached) reasons.add('frontier-limit');

  if (result.paths.length >= maxPaths && cursor < q.length) reasons.add('path-limit');
  if (program.graphCompleteness && program.graphCompleteness.callsComplete === false) reasons.add('program-calls-incomplete');
  result.paths.sort((a, b) => a.length - b.length);
  result.reasons = [...reasons];
  result.truncated = result.reasons.length > 0;
  result.complete = !result.truncated;
  return result;
}
