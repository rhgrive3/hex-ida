/**
 * Control-flow structuring facts, with every edge accounted for.
 *
 * The claim a structurer has to be able to make is not "this function became a
 * tidy while loop". It is: *every edge in the original CFG is still there*, and
 * for each one you can say what became of it — a structured construct, an
 * explicit jump, or an explicit unknown. An edge that appears in none of those
 * three answers has been lost, and a lost edge is a path through the program the
 * reader will never see.
 *
 * So this pass is built around the accounting rather than around the prettiness.
 * It reads the canonical CFG, dominance, post-dominance and the P8-4 loop facts,
 * classifies each edge, and publishes the classification together with the
 * regions it implies. `lostCfgEdgeCount` is then a number a verifier can
 * recompute from the CFG alone, which is the point: the pass does not get to
 * mark its own work.
 *
 * Three rules follow from that.
 *
 * `gotoCount = 0` is not a goal and is not a gate. A correct `goto` beats a
 * false `while` every time, so an edge that cannot be structured safely is
 * accounted as a residual jump and left alone.
 *
 * An edge whose kind this pass does not recognise — an unwind edge, an indirect
 * candidate, anything a later phase adds — is never quietly folded into a
 * structured construct. It becomes an explicit constraint on the region that
 * contains it.
 *
 * A region is not split to make it structurable unless duplicating it is
 * provably free of observable effects, and even then this checkpoint only
 * publishes the candidate. Duplicating a call or a store to tidy a diamond is
 * the merge blocker this pass exists to avoid.
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const STRUCTURING_PASS = createPassDescriptor({
  id: 'phase8.structuring',
  version: '1.1.0',
  stage: 'structuring',
  budgetClass: 'standard',
  consumes: ['cfg', 'dominators', 'loops', 'ssa', 'induction'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'providerHints', 'origins'],
  invalidates: [],
  produces: ['structuredRegions'],
  description: 'Accounts for every CFG edge as a structured construct, an explicit jump or an explicit unknown, and publishes the regions that follow.',
});

export const STRUCTURING_SUMMARY_VERSION = 2;

/**
 * Edge kinds that describe ordinary structured control transfer.
 *
 * Anything outside this set is a constraint, not a candidate for structuring.
 * The set is deliberately closed: a kind added by a later phase — an unwind
 * edge, an exception edge — must be handled deliberately rather than inherit
 * whatever the fallback branch happens to do.
 */
const STRUCTURED_EDGE_KINDS = new Set([
  'branch', 'fallthrough', 'conditional-true', 'conditional-false', 'switch-case', 'switch-default',
]);

/** Constructs an edge may be accounted by. `unknown` is a real answer. */
export const EDGE_CONSTRUCTS = Object.freeze([
  'sequence',
  'if-branch',
  'if-join',
  'switch-case',
  'switch-join',
  'loop-entry',
  'loop-body',
  'loop-back-edge',
  'loop-guard-exit',
  'loop-break',
  'residual-goto',
  'constraint-edge',
  'unknown',
]);

/** Constructs that mean "an explicit jump survived here". Never a gate. */
const GOTO_CONSTRUCTS = new Set(['residual-goto']);

/** Operations whose duplication would duplicate something observable. */
const OBSERVABLE_OPS = new Set(['store', 'call', 'ret', 'clobber', 'unknown', 'intrinsic', 'trap', 'fence', 'syscall', 'load']);

const DEFAULT_LIMITS = Object.freeze({ maxBlocks: 4096, maxChainWalk: 4096 });

function originIdsOf(node) {
  const ids = node?.origin?.instructionIds;
  if (Array.isArray(ids)) return ids;
  if (typeof ids === 'string') return [ids];
  if (ids != null && typeof ids[Symbol.iterator] === 'function') return [...ids];
  return [];
}

function listOf(collection) {
  if (collection == null) return [];
  if (Array.isArray(collection)) return [...collection];
  if (typeof collection === 'string') return [];
  if (typeof collection[Symbol.iterator] === 'function') return [...collection];
  return [];
}

/** Reads a relation off upstream sets, falling back to the upstream tree. */
function createRelation(sets, tree, limits) {
  return function relates(ancestor, node) {
    if (ancestor == null || node == null) return null;
    const set = sets instanceof Map ? sets.get(node) : sets?.[node];
    if (set != null) {
      if (typeof set.has === 'function') return set.has(ancestor);
      if (Array.isArray(set)) return set.includes(ancestor);
    }
    if (tree == null) return null;
    let current = node;
    for (let step = 0; current != null && current >= 0 && step <= limits.maxChainWalk; step += 1) {
      if (current === ancestor) return true;
      const next = tree instanceof Map ? tree.get(current) : tree[current];
      if (next == null || next === current) return false;
      current = next;
    }
    return false;
  };
}

/**
 * The successor edges of a block: one record per distinct target, carrying every
 * kind the projection declared for it.
 *
 * The upstream CFG labels the not-taken arm of a conditional twice — once
 * `conditional-false` and once `fallthrough` — for the same target. Those are
 * two names for one edge, not two edges. Counting them separately would inflate
 * the edge total and, worse, would let the accounting agree with itself while
 * disagreeing with the CFG. So targets are merged and every label is kept: no
 * kind is dropped, and the edge count matches `succ`.
 */
export function successorEdgesOf(block) {
  const merged = new Map();
  const add = (to, kind) => {
    if (to == null) return;
    if (!merged.has(to)) merged.set(to, new Set());
    merged.get(to).add(kind);
  };
  const declared = listOf(block?.successorEdges);
  for (const edge of declared) add(edge?.to, edge?.kind ?? 'branch');
  const successors = listOf(block?.succ);
  for (const to of successors) if (!merged.has(to)) add(to, 'branch');
  return [...merged.entries()].map(([to, kinds]) => ({ to, kinds: [...kinds].sort() }));
}

function terminatorOf(block) {
  const insts = block?.insts ?? [];
  for (let index = insts.length - 1; index >= 0; index -= 1) {
    const op = insts[index]?.op;
    if (op === 'cbr' || op === 'br' || op === 'ret' || op === 'switch') return insts[index];
  }
  return null;
}

/**
 * Classifies one edge.
 *
 * Exported because the classification is the whole contract, and a rule that can
 * only be exercised through a full pass run is a rule nobody tests properly.
 */
export function classifyEdge(edge, context) {
  const { from, to } = edge;
  const kinds = edge.kinds ?? [edge.kind];
  const { byIndex, loopsByHeader, innermostLoopOf, postDominates, ipdom } = context;

  // 1. A kind this pass does not recognise makes the whole edge a constraint,
  //    even if another label on it looks ordinary. Folding an unwind edge into
  //    an `if` because it also carries a `branch` label is how an exception path
  //    disappears.
  const foreign = kinds.filter((kind) => !STRUCTURED_EDGE_KINDS.has(kind));
  if (foreign.length > 0) {
    return {
      construct: 'constraint-edge',
      reason: `edge kind ${foreign.map((kind) => `"${kind}"`).join(', ')} is not ordinary structured control transfer, so the edge is preserved as a constraint on the enclosing region`,
    };
  }

  const enclosing = innermostLoopOf(from);

  // 2. An edge inside an irreducible region is emitted as an explicit jump. The
  //    region has more than one entry, so no loop construct describes it.
  if (enclosing != null && enclosing.classification !== 'natural') {
    return {
      construct: 'residual-goto',
      reason: `block ${from} is inside a region classified ${enclosing.classification}, which no loop construct describes`,
    };
  }

  // 3. Back edge: the latch returning to its header.
  const targetLoop = loopsByHeader.get(to) ?? null;
  if (targetLoop != null && targetLoop.classification === 'natural' && targetLoop.latches.includes(from)) {
    return { construct: 'loop-back-edge', reason: `latch ${from} returns to header ${to}` };
  }

  // 4. Leaving a loop.
  const exitedLoop = context.loopExitedBy(from, to);
  if (exitedLoop != null) {
    if (exitedLoop.classification !== 'natural') {
      return { construct: 'residual-goto', reason: `the loop at header ${exitedLoop.header} is ${exitedLoop.classification}` };
    }
    if (from === exitedLoop.guardBlock) {
      return { construct: 'loop-guard-exit', reason: `the loop guard at block ${from} leaves the loop at header ${exitedLoop.header}` };
    }
    // The guard's own exit is the loop's normal way out; `break` is what every
    // other exit means, and it only says where to go if they all agree.
    const breakTargets = new Set(exitedLoop.exitEdges
      .filter((exit) => exit.from !== exitedLoop.guardBlock)
      .map((exit) => exit.to));
    if (breakTargets.size === 1) {
      return { construct: 'loop-break', reason: `block ${from} breaks out of the loop at header ${exitedLoop.header} to its single break target` };
    }
    return {
      construct: 'residual-goto',
      reason: `the loop at header ${exitedLoop.header} is left at ${breakTargets.size} different blocks besides its guard exit, so this exit is not a plain break`,
    };
  }

  // 5. Entering a loop from outside it.
  if (targetLoop != null && !targetLoop.nodes.includes(from)) {
    if (targetLoop.classification !== 'natural') {
      return { construct: 'residual-goto', reason: `the region at header ${to} is ${targetLoop.classification}` };
    }
    return { construct: 'loop-entry', reason: `block ${from} enters the loop at header ${to}` };
  }

  // 5b. The loop guard's other arm: it stays in the loop, so it is the body,
  //     not an unrelated `if`.
  if (enclosing != null && from === enclosing.guardBlock && enclosing.nodes.includes(to)) {
    return { construct: 'loop-body', reason: `the guard at block ${from} enters the body of the loop at header ${enclosing.header}` };
  }

  const block = byIndex.get(from);
  const successors = successorEdgesOf(block);
  const join = ipdom instanceof Map ? (ipdom.get(from) ?? null) : (ipdom?.[from] ?? null);

  // 6. A switch. Cases that do not converge on the join are explicit jumps.
  const terminator = terminatorOf(block);
  if (terminator?.op === 'switch' || kinds.includes('switch-case') || kinds.includes('switch-default')) {
    if (join == null) return { construct: 'residual-goto', reason: `the switch at block ${from} has no common join point` };
    if (to === join) return { construct: 'switch-join', reason: `block ${to} is the join of the switch at block ${from}` };
    if (postDominates(join, to) === true) return { construct: 'switch-case', reason: `case block ${to} converges on join ${join}` };
    return { construct: 'residual-goto', reason: `case block ${to} does not converge on the switch join ${join}` };
  }

  // 7. A two-way conditional. Without a join point there is no `if` region, and
  //    an arm that does not reach the join is not one either.
  if (successors.length === 2) {
    if (join == null) {
      // No join point does not automatically mean no `if`. `if (c) return a;`
      // has arms that never meet again inside the function, and that is an
      // ordinary conditional with an early return — provided they really never
      // meet. If they share any post-dominator the shape is something else and
      // an explicit jump is the honest answer.
      const [first, second] = successors.map((edge) => edge.to);
      const shared = context.sharedPostDominator(first, second);
      if (shared === null) {
        return { construct: 'if-branch', reason: `the arms of block ${from} never meet again; each leaves the function on its own path` };
      }
      return { construct: 'residual-goto', reason: `the conditional at block ${from} has no immediate join even though its arms meet at block ${shared}` };
    }
    if (to === join) return { construct: 'if-join', reason: `block ${to} is the join of the conditional at block ${from}` };
    if (postDominates(join, to) === true) return { construct: 'if-branch', reason: `arm ${to} converges on join ${join}` };
    return { construct: 'residual-goto', reason: `arm ${to} does not converge on the join ${join} of block ${from}` };
  }

  // 8. One successor is a sequence, whatever else merges into the target.
  if (successors.length === 1) {
    return { construct: 'sequence', reason: `block ${from} continues into block ${to}` };
  }

  return {
    construct: 'unknown',
    reason: `block ${from} has ${successors.length} successors and no construct this pass recognises`,
  };
}

/**
 * Accounts for every edge in the CFG.
 *
 * Returns one record per edge, in a deterministic order. Nothing is filtered:
 * the count of records is the count of edges, which is what makes the
 * independent recount in the verifier meaningful.
 */
export function accountEdges(context) {
  const records = [];
  for (const index of context.blockOrder) {
    const block = context.byIndex.get(index);
    for (const edge of successorEdgesOf(block)) {
      const input = { from: index, to: edge.to, kinds: edge.kinds };
      const { construct, reason } = classifyEdge(input, context);
      records.push(Object.freeze({
        from: index,
        to: edge.to,
        kinds: Object.freeze([...edge.kinds]),
        construct,
        reason,
        origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
      }));
    }
  }
  return records;
}

/** Whether duplicating a block would duplicate something observable. */
export function observableEffectsIn(block) {
  const reasons = [];
  for (const instruction of block?.insts ?? []) {
    if (OBSERVABLE_OPS.has(instruction?.op)) reasons.push(`${instruction.op}/${instruction.sub ?? '-'}`);
  }
  return reasons;
}

const SAFE_REGION_CONSTRUCTS = new Set([
  'sequence', 'if-branch', 'if-join', 'switch-case', 'switch-join',
  'loop-entry', 'loop-body', 'loop-back-edge', 'loop-guard-exit', 'loop-break',
]);

const REGION_KINDS = new Set(['conditional', 'switch', 'loop', 'irreducible', 'exception-constraint', 'residual-edge']);
const PRESERVATION_ACTIONS = new Set(['withhold', 'preserve-goto', 'preserve-exception-constraint']);

function edgeKey(edge) { return `${edge.from}->${edge.to}`; }

function sortedUniqueNumbers(values) {
  return [...new Set(listOf(values).filter((value) => Number.isSafeInteger(value)))].sort((left, right) => left - right);
}

function exceptionLikeKind(kind) {
  return /(?:exception|unwind|landing|throw|trap|indirect)/i.test(String(kind));
}

/**
 * Expand a conditional/switch region through its arms until the declared join.
 * The CFG is already canonical; this bounded walk only collects the edge set a
 * consumer would be allowed to rewrite. A walk that cannot finish is withheld
 * rather than silently treating a partial region as a complete one.
 */
function regionNodes(region, edges, byIndex, maxChainWalk) {
  const initial = new Set(sortedUniqueNumbers([region?.entry, ...(region?.members ?? [])]));
  const exits = new Set(sortedUniqueNumbers(region?.exits));
  if (!['conditional', 'switch'].includes(region?.kind)) {
    return { nodes: initial, truncated: false };
  }
  const queue = [...initial];
  let steps = 0;
  while (queue.length > 0) {
    if (steps++ >= maxChainWalk) return { nodes: initial, truncated: true };
    const from = queue.shift();
    for (const edge of edges) {
      if (edge.from !== from || exits.has(edge.to) || !byIndex.has(edge.to)) continue;
      if (initial.has(edge.to)) continue;
      initial.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { nodes: initial, truncated: false };
}

function regionEdgeRecords(region, edges, byIndex, maxChainWalk) {
  const walked = regionNodes(region, edges, byIndex, maxChainWalk);
  const records = edges.filter((edge) => walked.nodes.has(edge.from));
  return { ...walked, records };
}

function originRefsFor(region, records) {
  const refs = new Set(originIdsOf({ origin: region?.origin }));
  for (const edge of records) for (const ref of edge.origin?.instructionIds ?? []) refs.add(String(ref));
  return [...refs].sort();
}

/**
 * Independently validates one region plan against the edge ledger it claims to
 * consume. This is deliberately a data-only check: a producer cannot certify a
 * transform by repeating its own graph walk or by trusting a `safe` flag.
 */
export function validateRegionTransform(candidate, facts = {}) {
  const edges = Array.isArray(facts) ? facts : (Array.isArray(facts?.edges) ? facts.edges : []);
  const accountingFailures = Array.isArray(facts?.accountingFailures) ? facts.accountingFailures : [];
  const failures = [];
  if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, failures: [{ problem: 'candidate-invalid', detail: 'region transform is not an object' }] };
  }
  const edgeByKey = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (edgeByKey.has(key)) failures.push({ problem: 'duplicate-ledger-edge', detail: key });
    edgeByKey.set(key, edge);
  }
  const keys = listOf(candidate.edgeKeys).map(String);
  const rawMembers = listOf(candidate.members);
  const rawExits = listOf(candidate.exits);
  const members = sortedUniqueNumbers(rawMembers);
  const exits = sortedUniqueNumbers(rawExits);
  const entry = candidate.entry;
  const withhold = candidate.action === 'withhold';
  if (!REGION_KINDS.has(candidate.kind)) failures.push({ problem: 'region-kind-invalid', detail: String(candidate.kind) });
  if (!['validated', 'fallback'].includes(candidate.status)) failures.push({ problem: 'region-status-invalid', detail: String(candidate.status) });
  if (!Number.isSafeInteger(entry)) failures.push({ problem: 'region-entry-invalid', detail: String(entry) });
  if (rawMembers.some((member) => !Number.isSafeInteger(member))) failures.push({ problem: 'region-member-invalid', detail: String(rawMembers.find((member) => !Number.isSafeInteger(member))) });
  if (rawExits.some((exit) => !Number.isSafeInteger(exit))) failures.push({ problem: 'region-exit-invalid', detail: String(rawExits.find((exit) => !Number.isSafeInteger(exit))) });
  if (new Set(rawMembers).size !== rawMembers.length) failures.push({ problem: 'duplicate-region-member', detail: String(candidate.id ?? candidate.entry) });
  if (new Set(rawExits).size !== rawExits.length) failures.push({ problem: 'duplicate-region-exit', detail: String(candidate.id ?? candidate.entry) });
  if (members.length === 0 && !withhold) failures.push({ problem: 'region-members-empty', detail: String(candidate.id ?? candidate.entry) });
  if (Number.isSafeInteger(entry) && !members.includes(entry) && !withhold) {
    failures.push({ problem: 'region-entry-not-member', detail: String(entry) });
  }
  if (exits.length === 0 && !withhold) failures.push({ problem: 'region-exits-empty', detail: String(candidate.id ?? candidate.entry) });
  const expectedAction = candidate.kind === 'conditional' ? 'structure-if'
    : candidate.kind === 'switch' ? 'structure-switch'
      : candidate.kind === 'loop' ? 'structure-loop' : null;
  if (candidate.status === 'validated' && (expectedAction == null || candidate.action !== expectedAction)) {
    failures.push({ problem: 'validated-action-shape-invalid', detail: `${candidate.kind}:${candidate.action}` });
  }
  if (candidate.status === 'fallback' && !PRESERVATION_ACTIONS.has(candidate.action)) {
    failures.push({ problem: 'fallback-action-shape-invalid', detail: `${candidate.kind}:${candidate.action}` });
  }
  // A withheld plan is an explicit refusal to materialize a partial or
  // unverifiable region. It may have no edge set because the bounded walk did
  // not reach one; that is a valid preservation decision, not a malformed
  // transform. Every other plan must identify at least one ledger edge.
  if (keys.length === 0 && candidate.action !== 'withhold') {
    failures.push({ problem: 'region-edge-set-empty', detail: String(candidate.id ?? candidate.entry) });
  }
  if (new Set(keys).size !== keys.length) failures.push({ problem: 'duplicate-region-edge', detail: String(candidate.id ?? candidate.entry) });
  for (const key of keys) if (!edgeByKey.has(key)) failures.push({ problem: 'region-edge-missing', detail: key });
  if (accountingFailures.length > 0 && candidate.status === 'validated') {
    failures.push({ problem: 'edge-accounting-failed', detail: accountingFailures[0]?.detail ?? 'independent recount failed' });
  }

  const claimed = keys.map((key) => edgeByKey.get(key)).filter(Boolean);
  const memberSet = new Set(members);
  const exitSet = new Set(exits);
  for (const edge of claimed) {
    if (!memberSet.has(edge.from)) failures.push({ problem: 'region-edge-source-outside', detail: edgeKey(edge) });
    if (!memberSet.has(edge.to) && !exitSet.has(edge.to)) {
      failures.push({ problem: 'region-edge-target-outside', detail: edgeKey(edge) });
    }
  }
  // A complete plan owns every ledger edge leaving one of its member blocks.
  // Comparing this recomputed closure catches both silent edge removal and an
  // invented edge that happened to exist elsewhere in the function.
  const edgeScoped = candidate.kind === 'exception-constraint' || candidate.kind === 'residual-edge';
  const expectedEdges = edgeScoped ? claimed : edges.filter((edge) => memberSet.has(edge.from));
  const expectedKeys = expectedEdges.map(edgeKey).sort();
  const claimedKeys = [...keys].sort();
  if (!withhold) {
    for (const key of expectedKeys) {
      if (!claimedKeys.includes(key)) failures.push({ problem: 'region-edge-omitted', detail: key });
    }
    for (const key of claimedKeys) {
      if (!expectedKeys.includes(key)) failures.push({ problem: 'region-edge-unexpected', detail: key });
    }
    const actualExits = [...new Set(expectedEdges.filter((edge) => !memberSet.has(edge.to)).map((edge) => edge.to))].sort((left, right) => left - right);
    if (actualExits.length !== exits.length || actualExits.some((exit, index) => exit !== exits[index])) {
      failures.push({ problem: 'region-exits-mismatch', detail: `declared ${exits.join(',')} but ledger leaves ${actualExits.join(',')}` });
    }
    // Every member must be reachable from the declared entry without crossing
    // an exit. This rejects an injected external entry/member even when all of
    // its edge keys happen to exist in the ledger.
    const reachable = new Set(Number.isSafeInteger(entry) ? [entry] : []);
    const queue = [...reachable];
    while (queue.length > 0) {
      const from = queue.shift();
      for (const edge of expectedEdges) {
        if (edge.from !== from || exitSet.has(edge.to) || !memberSet.has(edge.to) || reachable.has(edge.to)) continue;
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
    for (const member of members) {
      if (!reachable.has(member)) failures.push({ problem: 'region-member-unreachable', detail: String(member) });
    }
  }
  const unsafe = claimed.filter((edge) => !SAFE_REGION_CONSTRUCTS.has(edge.construct));
  if (candidate.status === 'validated' && unsafe.length > 0) {
    failures.push({ problem: 'unsafe-region-edge', detail: unsafe.map(edgeKey).join(',') });
  }
  if (candidate.status === 'validated' && candidate.action === 'preserve-goto') {
    failures.push({ problem: 'validated-fallback-mismatch', detail: String(candidate.id ?? candidate.entry) });
  }
  if (candidate.status === 'validated' && candidate.kind === 'conditional') {
    const entryEdges = expectedEdges.filter((edge) => edge.from === entry);
    if (entryEdges.length !== 2) failures.push({ problem: 'conditional-entry-shape-invalid', detail: `${entryEdges.length} outgoing edges` });
  }
  if (candidate.status === 'validated' && candidate.kind === 'switch') {
    const entryEdges = expectedEdges.filter((edge) => edge.from === entry);
    if (entryEdges.length < 2) failures.push({ problem: 'switch-entry-shape-invalid', detail: `${entryEdges.length} outgoing edges` });
  }
  if (candidate.action === 'withhold' && candidate.status !== 'fallback') {
    failures.push({ problem: 'withhold-status-mismatch', detail: String(candidate.id ?? candidate.entry) });
  }
  return { valid: failures.length === 0, failures };
}

/**
 * Builds the region plans consumed by downstream rendering/refinement. A plan
 * marked `validated` is safe to materialize because its complete bounded edge
 * set contains only ordinary constructs. Exception, indirect and irreducible
 * regions receive an explicit preservation plan; no caller is allowed to turn
 * those into an if/loop merely because a prettier shape is available.
 */
export function buildRegionTransforms(regions = [], edges = [], {
  byIndex = new Map(),
  maxChainWalk = DEFAULT_LIMITS.maxChainWalk,
  completeness = 'complete',
  accountingFailures = [],
} = {}) {
  const plans = [];
  let truncated = false;
  const addPlan = (candidate) => {
    const validation = validateRegionTransform(candidate, { edges, accountingFailures });
    if (!validation.valid && candidate.status === 'validated') {
      candidate.status = 'fallback';
      candidate.action = 'withhold';
      candidate.safe = false;
      candidate.preservesSemantics = false;
      candidate.reason = 'pass-local region validation failed';
      candidate.proof = `withheld: ${validation.failures.map((failure) => failure.detail).join('; ')}`;
    }
    plans.push(Object.freeze({
      ...candidate,
      exits: Object.freeze([...candidate.exits]),
      members: Object.freeze([...candidate.members]),
      edgeKeys: Object.freeze([...candidate.edgeKeys]),
      constraintEdgeKeys: Object.freeze([...candidate.constraintEdgeKeys]),
      exceptionEdgeKeys: Object.freeze([...candidate.exceptionEdgeKeys]),
      residualEdgeKeys: Object.freeze([...candidate.residualEdgeKeys]),
      unknownEdgeKeys: Object.freeze([...candidate.unknownEdgeKeys]),
      originRefs: Object.freeze([...candidate.originRefs]),
      validation: Object.freeze({
        status: validation.valid ? 'passed' : 'failed',
        failures: Object.freeze(validation.failures.map((failure) => Object.freeze({ ...failure }))),
      }),
    }));
  };
  for (const region of listOf(regions)) {
    const collected = regionEdgeRecords(region, edges, byIndex, maxChainWalk);
    truncated ||= collected.truncated;
    const records = collected.records;
    const keys = records.map(edgeKey).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const constraintEdges = records.filter((edge) => edge.construct === 'constraint-edge');
    const exceptionEdges = records.filter((edge) => edge.kinds.some(exceptionLikeKind));
    const residualEdges = records.filter((edge) => edge.construct === 'residual-goto');
    const unknownEdges = records.filter((edge) => edge.construct === 'unknown');
    const hasUnsafeEdges = constraintEdges.length > 0 || residualEdges.length > 0 || unknownEdges.length > 0;
    const entry = region.entry;
    const id = `region:${region.kind}:${entry}`;
    let action = region.kind === 'conditional' ? 'structure-if'
      : region.kind === 'switch' ? 'structure-switch'
        : region.kind === 'loop' ? 'structure-loop' : 'preserve-goto';
    let status = 'validated';
    let safe = true;
    let preservesSemantics = true;
    let reason = `the ${region.kind} region has a bounded edge set containing only ordinary structured constructs`;
    if (completeness !== 'complete') {
      status = 'fallback';
      action = 'withhold';
      safe = false;
      preservesSemantics = false;
      reason = 'upstream structuring facts are partial, so no region transform is published';
    } else if (collected.truncated) {
      status = 'fallback';
      action = 'withhold';
      safe = false;
      preservesSemantics = false;
      reason = 'the bounded region walk did not reach a fixed point';
    } else if (accountingFailures.length > 0) {
      status = 'fallback';
      action = 'withhold';
      safe = false;
      preservesSemantics = false;
      reason = 'the independent CFG edge recount failed';
    } else if (region.kind === 'irreducible') {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the region has multiple entries or an unverified loop shape; residual gotos preserve every path';
    } else if (exceptionEdges.length > 0 || constraintEdges.length > 0) {
      status = 'fallback';
      action = 'preserve-exception-constraint';
      safe = false;
      reason = `${exceptionEdges.length > 0 ? 'an exception/unwind/indirect edge' : 'a foreign edge kind'} is a region constraint, not an ordinary branch`;
    } else if (hasUnsafeEdges) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'a residual or unknown edge prevents a semantics-preserving structured transform';
    } else if (region.kind === 'loop' && (region.loopCompleteness !== 'complete' || region.loopGuard == null || region.loopLatches !== 1)) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the loop lacks a complete single-guard/single-latch proof';
    } else if (region.kind === 'conditional' && (records.filter((edge) => edge.from === entry).length !== 2 || region.exits.length !== 1)) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the conditional does not expose exactly two arms and one join';
    } else if (region.kind === 'switch' && (records.filter((edge) => edge.from === entry).length < 2 || region.exits.length !== 1)) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the switch does not expose at least two cases and one join';
    } else if (region.kind === 'loop' && records.filter((edge) => edge.from === region.loopGuard).length < 2) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the loop guard does not expose both a body edge and an exit edge';
    } else if (!['conditional', 'switch', 'loop'].includes(region.kind) || records.length === 0) {
      status = 'fallback';
      action = 'preserve-goto';
      safe = false;
      reason = 'the region shape is not one this consumer can materialize';
    }
    if (status === 'fallback' && action === 'withhold') preservesSemantics = false;
    const candidate = {
      id,
      kind: region.kind,
      action,
      status,
      safe,
      entry,
      exits: Object.freeze(sortedUniqueNumbers(region.exits)),
      members: Object.freeze(sortedUniqueNumbers(collected.nodes)),
      edgeKeys: Object.freeze(keys),
      constraintEdgeKeys: Object.freeze(constraintEdges.map(edgeKey).sort()),
      exceptionEdgeKeys: Object.freeze(exceptionEdges.map(edgeKey).sort()),
      residualEdgeKeys: Object.freeze(residualEdges.map(edgeKey).sort()),
      unknownEdgeKeys: Object.freeze(unknownEdges.map(edgeKey).sort()),
      originRefs: Object.freeze(originRefsFor(region, records)),
      preservesSemantics,
      reason,
      proof: safe
        ? `validated ${action}: every covered edge is independently accounted and has an ordinary structured construct`
        : `preservation plan: ${reason}`,
    };
    addPlan(candidate);
  }

  // Constraint and residual edges are meaningful even when no enclosing
  // region was recoverable (for example, a linear block with an unwind edge).
  // Publish one explicit preservation plan for each such edge so the
  // production consumer cannot mistake an empty region list for permission to
  // drop the path.
  const covered = new Set(plans.flatMap((plan) => plan.edgeKeys));
  for (const edge of edges) {
    if (!['constraint-edge', 'residual-goto', 'unknown'].includes(edge.construct)) continue;
    const key = edgeKey(edge);
    if (covered.has(key)) continue;
    const isConstraint = edge.construct === 'constraint-edge';
    const candidate = {
      id: `edge:${edge.construct}:${key}`,
      kind: isConstraint ? 'exception-constraint' : 'residual-edge',
      action: isConstraint ? 'preserve-exception-constraint' : 'preserve-goto',
      status: 'fallback',
      safe: false,
      preservesSemantics: true,
      entry: edge.from,
      exits: [edge.to],
      members: [edge.from],
      edgeKeys: [key],
      constraintEdgeKeys: isConstraint ? [key] : [],
      exceptionEdgeKeys: isConstraint && edge.kinds.some(exceptionLikeKind) ? [key] : [],
      residualEdgeKeys: edge.construct === 'residual-goto' ? [key] : [],
      unknownEdgeKeys: edge.construct === 'unknown' ? [key] : [],
      originRefs: Object.freeze([...(edge.origin?.instructionIds ?? [])].map(String).sort()),
      reason: isConstraint
        ? 'an exception, unwind or foreign edge has no verified structured region and is preserved explicitly'
        : 'an edge has no verified structured region and remains an explicit jump',
      proof: isConstraint
        ? 'preservation plan: the constraint edge remains visible to downstream consumers'
        : 'preservation plan: the residual edge remains visible to downstream consumers',
    };
    addPlan(candidate);
    covered.add(key);
  }
  return { plans: Object.freeze(plans), truncated };
}

/**
 * Publishes the structured-region facts.
 *
 * Rewrites nothing. What it produces is the accounting, the regions the
 * accounting implies, the residual jumps it could not remove and would not
 * pretend away, and node-split candidates that are provably safe to consider.
 */
export function runStructuringPass(context = {}, budget = {}, area = null) {
  if (area == null) throw new TypeError('phase8-structuring-requires-staging-area');
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const dominatorFacts = analysis?.get('dominators');
  const inductionFacts = analysis?.get('induction');
  const limits = { ...DEFAULT_LIMITS, ...(budget?.limits ?? {}) };
  if (!Number.isSafeInteger(limits.maxBlocks) || limits.maxBlocks < 0
      || !Number.isSafeInteger(limits.maxChainWalk) || limits.maxChainWalk < 0) {
    return createPassResult({
      descriptor: STRUCTURING_PASS,
      status: 'unsupported',
      changed: false,
      completeness: 'unknown',
      transforms: [],
      produced: [],
      diagnostics: [{ severity: 'warning', code: 'phase8.structuring.invalid-limit', message: 'Structuring limits are malformed; no CFG facts were published.', reason: 'invalid-limit' }],
      invalidated: [],
      stopReason: 'invalid-limit',
    });
  }

  const allBlocks = cfg?.blocks ?? [];
  // Cutting the CFG to fit maxBlocks drops blocks and edges from the analysis,
  // so the truncation marks the published accounting partial (#5475).
  const truncatedByLimit = allBlocks.length > limits.maxBlocks;
  const blocks = allBlocks.slice(0, limits.maxBlocks);
  const byIndex = new Map(blocks.map((block) => [block.index, block]));
  const blockOrder = blocks.map((block) => block.index).sort((left, right) => left - right);
  const postDominates = createRelation(dominatorFacts?.postDominators, dominatorFacts?.ipdom, limits);
  const ipdom = dominatorFacts?.ipdom ?? null;

  // Loop facts come from P8-4. This pass does not re-derive loops, latches,
  // exits or guards; it consumes the artifact that already proved them.
  const loops = (inductionFacts?.loops ?? []).map((loop) => ({
    header: loop.header,
    classification: loop.classification,
    latches: [...loop.latches],
    nodes: [...loop.nodes],
    exitEdges: [...loop.exitEdges],
    guardBlock: loop.guardBlock,
    depth: loop.depth,
    parentHeader: loop.parentHeader,
    completeness: loop.completeness ?? 'unknown',
  }));
  const loopsByHeader = new Map(loops.map((loop) => [loop.header, loop]));
  const nodeSets = new Map(loops.map((loop) => [loop.header, new Set(loop.nodes)]));

  const innermostLoopOf = (index) => {
    let best = null;
    for (const loop of loops) {
      if (!nodeSets.get(loop.header).has(index)) continue;
      if (best == null || loop.nodes.length < best.nodes.length) best = loop;
    }
    return best;
  };
  // The loop an edge actually leaves: the smallest one containing the source and
  // not the target. A nested edge leaves the inner loop, not the outer.
  const loopExitedBy = (from, to) => {
    let best = null;
    for (const loop of loops) {
      const nodes = nodeSets.get(loop.header);
      if (!nodes.has(from) || nodes.has(to)) continue;
      if (best == null || loop.nodes.length < best.nodes.length) best = loop;
    }
    return best;
  };

  const abortedNow = () => {
    try { return typeof budget?.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  // A block that post-dominates both arms, if there is one. Read off the
  // upstream post-dominator sets; nothing is recomputed here.
  const postDominatorSets = dominatorFacts?.postDominators ?? null;
  const sharedPostDominator = (left, right) => {
    const leftSet = postDominatorSets instanceof Map ? postDominatorSets.get(left) : postDominatorSets?.[left];
    const rightSet = postDominatorSets instanceof Map ? postDominatorSets.get(right) : postDominatorSets?.[right];
    if (leftSet == null || rightSet == null) return undefined; // Not known.
    const candidates = listOf(leftSet).filter((block) => block !== left && block !== right
      && (typeof rightSet.has === 'function' ? rightSet.has(block) : listOf(rightSet).includes(block)));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => a - b)[0];
  };

  const accountingContext = { byIndex, blockOrder, loopsByHeader, innermostLoopOf, loopExitedBy, postDominates, ipdom, sharedPostDominator };
  const edges = abortedNow() ? [] : accountEdges(accountingContext);
  let budgetExhausted = truncatedByLimit || abortedNow();

  const byConstruct = new Map(EDGE_CONSTRUCTS.map((construct) => [construct, 0]));
  for (const record of edges) byConstruct.set(record.construct, (byConstruct.get(record.construct) ?? 0) + 1);

  const residualGotoEdges = edges.filter((record) => GOTO_CONSTRUCTS.has(record.construct));
  const constraintEdges = edges.filter((record) => record.construct === 'constraint-edge');
  const unknownEdges = edges.filter((record) => record.construct === 'unknown');

  // Regions. A loop region per loop the artifact proved; a conditional or switch
  // region per branching block that has a join. Nothing is invented for a block
  // whose shape was not established.
  const regions = [];
  for (const loop of loops) {
    const exits = [...new Set(loop.exitEdges.map((edge) => edge.to))].sort((left, right) => left - right);
    regions.push(Object.freeze({
      kind: loop.classification === 'natural' ? 'loop' : 'irreducible',
      entry: loop.header,
      exits: Object.freeze(exits),
      members: Object.freeze([...loop.nodes].sort((left, right) => left - right)),
      depth: loop.depth,
      parentEntry: loop.parentHeader,
      loopCompleteness: loop.completeness,
      loopGuard: loop.guardBlock,
      loopLatches: loop.latches.length,
      // Edges the region must honour but no construct describes.
      constraints: Object.freeze(constraintEdges.filter((edge) => nodeSets.get(loop.header).has(edge.from))
        .map((edge) => `${edge.from}->${edge.to}:${edge.kinds.join('|')}`)),
      residualGotos: Object.freeze(residualGotoEdges.filter((edge) => nodeSets.get(loop.header).has(edge.from))
        .map((edge) => `${edge.from}->${edge.to}`)),
      origin: Object.freeze({ instructionIds: Object.freeze([...new Set(loop.nodes.flatMap((index) => originIdsOf(byIndex.get(index))))].sort()) }),
    }));
  }
  for (const index of blockOrder) {
    const block = byIndex.get(index);
    const successors = successorEdgesOf(block);
    if (successors.length < 2) continue;
    if (loopsByHeader.has(index) && loopsByHeader.get(index).guardBlock === index) continue;
    const terminator = terminatorOf(block);
    const isSwitch = terminator?.op === 'switch' || successors.some((edge) => edge.kinds.includes('switch-case') || edge.kinds.includes('switch-default'));
    const join = ipdom instanceof Map ? (ipdom.get(index) ?? null) : (ipdom?.[index] ?? null);
    if (join == null) continue;
    regions.push(Object.freeze({
      kind: isSwitch ? 'switch' : 'conditional',
      entry: index,
      exits: Object.freeze([join]),
      members: Object.freeze(successors.map((edge) => edge.to).filter((target) => target !== join).sort((left, right) => left - right)),
      depth: innermostLoopOf(index)?.depth ?? null,
      parentEntry: innermostLoopOf(index)?.header ?? null,
      constraints: Object.freeze(constraintEdges.filter((edge) => edge.from === index).map((edge) => `${edge.from}->${edge.to}:${edge.kinds.join('|')}`)),
      residualGotos: Object.freeze(residualGotoEdges.filter((edge) => edge.from === index).map((edge) => `${edge.from}->${edge.to}`)),
      origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
    }));
  }
  regions.sort((left, right) => (left.entry - right.entry) || left.kind.localeCompare(right.kind));

  // Node-split candidates. A split is only ever *offered*: it is applied by
  // nobody in this checkpoint. A block carrying an observable effect is not
  // offered at all, because duplicating it would duplicate the effect.
  const splitCandidates = [];
  const gotoTargets = new Map();
  for (const record of residualGotoEdges) {
    if (!gotoTargets.has(record.to)) gotoTargets.set(record.to, []);
    gotoTargets.get(record.to).push(record);
  }
  for (const [target, records] of [...gotoTargets.entries()].sort((left, right) => left[0] - right[0])) {
    const block = byIndex.get(target);
    if (block == null) continue;
    const effects = observableEffectsIn(block);
    splitCandidates.push(Object.freeze({
      blockIndex: target,
      predecessorCount: (block.pred ?? []).length,
      gotoEdges: Object.freeze(records.map((record) => `${record.from}->${record.to}`)),
      observableEffects: Object.freeze(effects),
      offered: effects.length === 0,
      proof: effects.length === 0
        ? `block ${target} contains no store, call, load or unrepresented operation, so a copy of it would compute the same values with no second observable effect`
        : `block ${target} would duplicate observable operations (${[...new Set(effects)].join(', ')}), so it is not offered for splitting`,
      origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
    }));
  }

  // This recount is independent of the pass's region walk. A region transform
  // may only be materialized after both the edge ledger and its local claim
  // agree; a bounded or malformed ledger therefore produces preservation or
  // withheld plans rather than an optimistic structured shape.
  const accountingFailures = edgeAccountingFailures(cfg, { edges });
  let regionTransforms = buildRegionTransforms(regions, edges, {
    byIndex,
    maxChainWalk: limits.maxChainWalk,
    completeness: budgetExhausted ? 'partial' : 'complete',
    accountingFailures,
  });
  if (regionTransforms.truncated) {
    budgetExhausted = true;
    // The walk itself discovered a bounded fixed-point failure. Rebuild with
    // partial completeness so every plan records the same conservative state.
    regionTransforms = buildRegionTransforms(regions, edges, {
      byIndex,
      maxChainWalk: limits.maxChainWalk,
      completeness: 'partial',
      accountingFailures,
    });
  }
  const plans = regionTransforms.plans;
  const planFailures = plans.flatMap((plan) => (plan.validation?.failures ?? []).map((failure) => ({
    planId: plan.id,
    ...failure,
  })));
  const regionValidation = Object.freeze({
    status: budgetExhausted ? 'partial' : (accountingFailures.length > 0 || planFailures.length > 0 ? 'failed' : 'passed'),
    accountingFailures: Object.freeze(accountingFailures.map((failure) => Object.freeze({ ...failure }))),
    planFailures: Object.freeze(planFailures.map((failure) => Object.freeze({ ...failure }))),
    checkedRegionCount: plans.length,
    validatedRegionCount: plans.filter((plan) => plan.status === 'validated' && plan.validation?.status === 'passed').length,
    preservedRegionCount: plans.filter((plan) => plan.preservesSemantics === true).length,
    withheldRegionCount: plans.filter((plan) => plan.action === 'withhold').length,
  });

  const facts = Object.freeze({
    contractVersion: STRUCTURING_PASS.contractVersion,
    passVersion: STRUCTURING_PASS.version,
    summaryVersion: STRUCTURING_SUMMARY_VERSION,
    blockCount: blocks.length,
    edgeCount: edges.length,
    edges: Object.freeze(edges),
    edgesByConstruct: Object.freeze(Object.fromEntries([...byConstruct.entries()].sort())),
    regions: Object.freeze(regions),
    // Reported, never gated. A correct jump is a better answer than a false
    // loop, so driving this number down is not an objective.
    residualGotoCount: residualGotoEdges.length,
    constraintEdgeCount: constraintEdges.length,
    unknownEdgeCount: unknownEdges.length,
    splitCandidates: Object.freeze(splitCandidates),
    regionTransforms: plans,
    regionValidation,
    // This pass publishes classifications only; there is no hidden iterative
    // transform loop that can stop halfway through a region. A bounded run is
    // explicitly partial above, while a full run has reached this fixed point.
    convergence: budgetExhausted ? 'partial' : 'fixed-point',
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('structuredRegions', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.structuring.budget',
      message: 'Edge accounting stopped before every edge was classified.',
      reason: truncatedByLimit
        ? 'A deterministic resource limit (maxBlocks) cut the CFG; the accounting published is incomplete and must not be read as proof that no edge was lost.'
        : regionTransforms.truncated
          ? 'A deterministic resource limit (maxChainWalk) cut a region walk; the accounting published is incomplete and must not be read as proof that no edge was lost.'
          : 'The pass was cancelled; the accounting published is incomplete and must not be read as proof that no edge was lost.',
    });
  }
  if (accountingFailures.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.structuring.validation',
      message: 'The independent CFG recount rejected structured-region adoption.',
      reason: accountingFailures.slice(0, 3).map((failure) => failure.detail).join('; '),
    });
  }
  const preservedPlans = plans.filter((plan) => plan.status === 'fallback' && plan.action !== 'withhold');
  if (preservedPlans.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.structuring.preservation',
      message: `${preservedPlans.length} region/edge plan(s) retain explicit control-flow constraints.`,
      reason: [...new Set(preservedPlans.map((plan) => plan.reason))].slice(0, 4).join('; '),
    });
  }
  if (constraintEdges.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.structuring.constraint-edges',
      message: `${constraintEdges.length} edge(s) are constraints rather than structured control transfer.`,
      reason: [...new Set(constraintEdges.flatMap((edge) => edge.kinds))].slice(0, 4).join('; '),
    });
  }
  if (residualGotoEdges.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.structuring.residual-goto',
      message: `${residualGotoEdges.length} edge(s) remain explicit jumps.`,
      reason: [...new Set(residualGotoEdges.map((edge) => edge.reason))].slice(0, 4).join('; '),
    });
  }
  if (unknownEdges.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.structuring.unknown-edges',
      message: `${unknownEdges.length} edge(s) could not be classified at all.`,
      reason: [...new Set(unknownEdges.map((edge) => edge.reason))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: STRUCTURING_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['structuredRegions'],
    diagnostics,
    invalidated: [],
  });
}

/**
 * The independent edge-accounting check.
 *
 * Recomputes the edge set straight from the CFG and compares it with what the
 * pass published. The pass does not get to mark its own work: an edge the
 * accounting never mentions, or mentions twice, is reported here.
 */
export function edgeAccountingFailures(ir, facts) {
  const failures = [];
  if (facts == null) {
    return [{ problem: 'no-accounting', detail: 'the structuring pass published nothing for this function' }];
  }
  if (!Array.isArray(facts.edges)) {
    return [{ problem: 'malformed-accounting', detail: 'the structuring artifact has no edge record list' }];
  }
  const seen = new Map();
  for (const record of facts.edges) {
    const key = `${record.from}->${record.to}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!EDGE_CONSTRUCTS.includes(record.construct)) {
      failures.push({ problem: 'unknown-construct', detail: `${key} was accounted as "${record.construct}"` });
    }
    if (record.reason == null || record.reason.length === 0) {
      failures.push({ problem: 'no-reason', detail: `${key} was accounted with no reason` });
    }
  }
  // The expectation is rebuilt from the CFG's own successor list and its
  // declared edge labels, independently of how the pass merged them. Reusing the
  // pass's own view here would let it agree with itself.
  const expected = new Map();
  for (const block of ir?.blocks ?? []) {
    for (const target of listOf(block?.succ)) {
      if (target == null) continue;
      const key = `${block.index}->${target}`;
      if (!expected.has(key)) expected.set(key, new Set());
    }
    for (const edge of listOf(block?.successorEdges)) {
      if (edge?.to == null) continue;
      const key = `${block.index}->${edge.to}`;
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key).add(edge.kind ?? 'branch');
    }
  }
  const recorded = new Map(facts.edges.map((record) => [`${record.from}->${record.to}`, new Set(record.kinds ?? [])]));
  for (const [key, kinds] of expected) {
    if (!seen.has(key)) {
      failures.push({ problem: 'unaccounted-edge', detail: `${key} is in the CFG and not in the accounting` });
      continue;
    }
    for (const kind of kinds) {
      if (!recorded.get(key)?.has(kind)) {
        failures.push({ problem: 'dropped-edge-kind', detail: `${key} is declared "${kind}" in the CFG and the accounting does not carry that kind` });
      }
    }
  }
  for (const [key, count] of seen) {
    if (!expected.has(key)) failures.push({ problem: 'invented-edge', detail: `${key} was accounted but is not in the CFG` });
    else if (count > 1) failures.push({ problem: 'duplicated-edge', detail: `${key} was accounted ${count} times` });
  }
  return failures;
}

/** A readable summary of one function's accounting, for evidence. */
export function describeStructuring(facts) {
  if (facts == null) return 'no structuring facts';
  const parts = Object.entries(facts.edgesByConstruct).filter(([, count]) => count > 0).map(([construct, count]) => `${construct} ${count}`);
  return `${facts.edgeCount} edges: ${parts.join(', ')}`;
}
