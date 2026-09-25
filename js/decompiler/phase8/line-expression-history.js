import { createProjectionIrObserver } from '../../core/identity/live-data.js';

// Expression histories are authority-bearing private metadata. Keep them keyed by
// the concrete rendered line, and use AST-node carriers only to prove that a
// later projection copied an already-current binding from its exact owner.
const lineExpressionHistories = new WeakMap();
const nodeExpressionHistories = new WeakMap();

function observeLine(line, shouldAbort) {
  return createProjectionIrObserver().captureCertifiedData([line], shouldAbort);
}

function currentEntry(line, ir) {
  const entry = lineExpressionHistories.get(line);
  try {
    return entry && entry.ir === ir && entry.consumers.every(consumer => consumer.isCurrent())
      && entry.observation.matches() ? entry : null;
  } catch {
    return null;
  }
}

export function readLineExpressionHistory(line, ir) {
  return currentEntry(line, ir)?.records ?? null;
}

export function registerNodeExpressionHistory(node, line, ir, consumers, records, shouldAbort) {
  if (!node || !line || !Array.isArray(consumers) || consumers.length === 0) return false;
  try {
    if (!consumers.every(consumer => consumer.isCurrent())) return false;
    const observation = observeLine(line, shouldAbort);
    const entry = { ir, consumers: Object.freeze([...consumers]),
      records: Object.freeze([...new Set(records ?? [])]), observation };
    lineExpressionHistories.set(line, entry);
    nodeExpressionHistories.set(node, { line, entry });
    return true;
  } catch {
    return false;
  }
}

/** Refresh only the writer's own line after its fixed compatibility spelling. */
export function refreshLineExpressionHistory(line, ir, shouldAbort) {
  const entry = lineExpressionHistories.get(line);
  try {
    if (!entry || entry.ir !== ir || !entry.consumers.every(consumer => consumer.isCurrent())) return false;
    entry.observation = observeLine(line, shouldAbort);
    return true;
  } catch {
    return false;
  }
}

/** Carry a binding only across an exact AST-node copy (no semantic text edit). */
export function carryNodeExpressionHistory(source, target, ir) {
  if (!source || !target || source === target || source.kind !== target.kind
      || source.text !== target.text || source.source !== target.source
      || source.semantic !== target.semantic) return false;
  const carrier = nodeExpressionHistories.get(source);
  if (!carrier || carrier.entry.ir !== ir || currentEntry(carrier.line, ir) !== carrier.entry) return false;
  nodeExpressionHistories.set(target, carrier);
  return true;
}

/** Re-authorize a carried binding against the newly materialized rendered line. */
export function bindNodeExpressionHistory(node, line, ir, shouldAbort) {
  const carrier = nodeExpressionHistories.get(node);
  if (!carrier || carrier.entry.ir !== ir || currentEntry(carrier.line, ir) !== carrier.entry) return false;
  try {
    if (!carrier.entry.consumers.every(consumer => consumer.isCurrent())) return false;
    const entry = { ...carrier.entry, observation: observeLine(line, shouldAbort) };
    lineExpressionHistories.set(line, entry);
    nodeExpressionHistories.set(node, { line, entry });
    return true;
  } catch {
    return false;
  }
}
