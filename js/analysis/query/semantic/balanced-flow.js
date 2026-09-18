/** Finite query-kind state over borrowed canonical relation edges.
 * These selectors are not symbolic/taint's clean/tainted/unknown lattice.
 * They describe the kind of dependence; they never evaluate instructions or
 * replace SSA, MemorySSA, dispatch, ABI or executable-path proof owners.
 */
import { deepFreeze, createEntityId } from '../../../core/identity/index.js';
import { exactString, contractFail } from '../../../core/identity/structured.js';

export const SCOPED_FLOW_KINDS = Object.freeze(['data', 'address', 'control', 'capture', 'return', 'memory', 'exception']);
export const BALANCED_FLOW_VERSION = '1.0.0';
const ALL_FACTS = (1 << SCOPED_FLOW_KINDS.length) - 1;
const CLOSURES = new WeakMap();

export function flowKindMask(kinds = SCOPED_FLOW_KINDS) {
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > SCOPED_FLOW_KINDS.length) contractFail('flow-fact-domain');
  let mask = 0;
  for (const kind of kinds) {
    const index = SCOPED_FLOW_KINDS.indexOf(kind);
    if (index < 0 || mask & (1 << index)) contractFail('flow-fact-kind');
    mask |= 1 << index;
  }
  return mask;
}
export function flowKindsFromMask(mask) { return SCOPED_FLOW_KINDS.filter((_kind, index) => mask & (1 << index)); }
export function flowStateKey(nodeId, context, waypoint, kindMask) { return JSON.stringify([nodeId, context, waypoint, kindMask]); }

/** Intersection distributes over fact union. A neutral SSA edge preserves the
 * fact instead of converting an address/control dependence into value data.
 * Returning through a different callsite is impossible in either direction.
 */
export function transferBalancedFlow(state, edge, { direction, maxCallDepth, flowKinds }) {
  const facts = flowKinds === null ? state.kindMask
    : state.kindMask & (edge.flowKinds == null ? ALL_FACTS : flowKindMask(edge.flowKinds));
  if (!facts) return { state: null, cut: null };
  if (!edge.boundary) return { state: { context: state.context, kindMask: facts }, cut: null };
  const boundary = edge.boundary;
  if (!['enter', 'return'].includes(boundary.direction)) contractFail('flow-boundary-direction');
  exactString(boundary.callSite, 'flow-boundary-callsite');
  const enter = direction === 'forward' ? boundary.direction === 'enter' : boundary.direction === 'return';
  if (enter) {
    if (state.context.length >= maxCallDepth) return { state: null, cut: 'call-context-depth-cut' };
    return { state: { context: [...state.context, boundary.callSite], kindMask: facts }, cut: null };
  }
  if (!state.context.length) return { state: null, cut: 'unmatched-initial-caller-context' };
  if (state.context.at(-1) !== boundary.callSite) return { state: null, cut: null };
  return { state: { context: state.context.slice(0, -1), kindMask: facts }, cut: null };
}

/** Exhaustion of a finite relation graph is separately recorded from sound
 * semantic closure. The latter still needs the existing evidence admission.
 * The private freshness check is mandatory before reusing an owned report;
 * a detached JSON copy is explanatory data, not a negative-proof capability.
 */
export function createScopedFlowClosure({ plan, scopes, searches, cuts, enumerationComplete, possiblePaths, isCurrent }) {
  if (typeof isCurrent !== 'function' || isCurrent() !== true) contractFail('flow-closure-stale');
  const exhausted = enumerationComplete && cuts.length === 0;
  const body = { schema: 'scoped-flow-relation-closure/v1', version: BALANCED_FLOW_VERSION,
    planId: plan.id, worldId: plan.worldId, assumptionsId: plan.assumptionsId,
    scope: plan.query.scope, flowKinds: plan.query.flow.flowKinds,
    flowKindPolicy: plan.query.flow.flowKinds === null ? 'mixed-dependence-navigation' : 'homogeneous-kind-selection',
    scopes: scopes.map(scope => ({ ...scope })),
    searches: searches.map(search => ({ ...search, reachedSinks: search.reachedSinks.map(sink => ({ ...sink })) })),
    cuts: [...cuts], enumerationComplete,
    relationClosure: exhausted ? 'closed' : 'open',
    absence: exhausted && possiblePaths === 0 ? 'NO_PATH_IN_BOUND_RELATION_GRAPH' : 'UNKNOWN',
    semanticClosure: 'unknown', semanticAbsenceProven: false,
    authority: 'finite-balanced-relation-exhaustion; requires-sound-upper-and-world-cut-admission' };
  const report = deepFreeze({ ...body, id: createEntityId({ binaryId: 'flow-closure', kind: body.schema, identity: body }) });
  CLOSURES.set(report, isCurrent); return report;
}
export function assertScopedFlowClosureCurrent(report) {
  const current = CLOSURES.get(report);
  if (!current) contractFail('flow-closure-owned-report-required');
  if (current() !== true) contractFail('flow-closure-stale');
  return report;
}
