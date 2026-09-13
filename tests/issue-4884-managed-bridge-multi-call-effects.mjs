// Regression for #4884: the managed bridge must lower every `callEffects`
// entry of one VMEffects bundle, not only `callEffects[0]`. Dropping the tail
// silently loses callee identity and call-level side effects (memory write,
// mayThrow, noreturn) while the input aggregate stays exact.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';

function directCall(target, summary = {}) {
  return {
    target,
    dispatchKind: 'direct',
    effectSummary: {
      completeness: 'complete',
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      ...summary,
    },
  };
}

function bridged(callEffects, extra = {}) {
  const bundle = createVMEffectBundle({
    frontendId: 'dex',
    methodId: 'm',
    operationId: 'op0',
    bytecodeOffset: 0,
    mnemonic: 'multi-call-op',
    completeness: 'exact',
    callEffects,
    ...extra,
  });
  return lowerVMEffectsToSemanticIr(createVMEffectFunction({
    frontendId: 'dex',
    methodId: 'm',
    bundles: [bundle],
  }));
}

function callNodes(lowered) {
  return lowered.semanticIr.nodes.filter((node) => node.kind === 'call');
}

function targetsOf(nodes) {
  return nodes.flatMap((node) => node.call?.targetEntityIds ?? []);
}

test('#4884 a single call effect keeps the existing one-node lowering', () => {
  const lowered = bridged([directCall('callee:A')]);
  const nodes = callNodes(lowered);
  assert.equal(nodes.length, 1, `expected exactly one call node: ${JSON.stringify(targetsOf(nodes))}`);
  assert.deepEqual([...nodes[0].call.targetEntityIds], ['callee:A']);
  assert.equal(nodes[0].completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4884 two direct call effects keep both callee identities', () => {
  const lowered = bridged([directCall('callee:A'), directCall('callee:B')]);
  const nodes = callNodes(lowered);
  assert.equal(nodes.length, 2, `second call effect was dropped: ${JSON.stringify(targetsOf(nodes))}`);
  const targets = new Set(targetsOf(nodes));
  assert.ok(targets.has('callee:A'), `callee:A missing: ${[...targets]}`);
  assert.ok(targets.has('callee:B'), `callee:B missing: ${[...targets]}`);
});

test('#4884 a memory write carried only by the second call effect survives', () => {
  const lowered = bridged([
    directCall('callee:A'),
    directCall('callee:B', { memoryWrite: { scope: 'all', addressSpaces: ['memory'] } }),
  ]);
  const writes = callNodes(lowered).map((node) => ({
    target: node.call.targetEntityIds[0] ?? null,
    scope: node.call.memoryWrite.scope,
  }));
  const broad = writes.find((entry) => entry.scope === 'all');
  assert.ok(broad, `broad memory write lost: ${JSON.stringify(writes)}`);
  assert.equal(broad.target, 'callee:B');
});

test('#4884 mayThrow and noreturn on the second call effect survive', () => {
  const lowered = bridged([
    directCall('callee:A'),
    directCall('callee:B', { mayThrow: true, noreturn: true }),
  ]);
  const nodes = callNodes(lowered);
  const second = nodes.find((node) => node.call.targetEntityIds.includes('callee:B'));
  assert.ok(second, `callee:B node missing: ${JSON.stringify(targetsOf(nodes))}`);
  assert.equal(second.call.mayThrow, true, 'mayThrow lost from the tail call effect');
  assert.equal(second.call.noreturn, true, 'noreturn lost from the tail call effect');
  const first = nodes.find((node) => node.call.targetEntityIds.includes('callee:A'));
  assert.equal(first.call.mayThrow, false);
  assert.equal(first.call.noreturn, false);
});

test('#4884 every lowered call effect keeps its source VM operation', () => {
  const lowered = bridged([directCall('callee:A'), directCall('callee:B'), directCall('callee:C')]);
  const nodes = callNodes(lowered);
  assert.equal(nodes.length, 3, `expected three call nodes: ${JSON.stringify(targetsOf(nodes))}`);
  for (const node of nodes) {
    assert.deepEqual([...node.sourceEffectIds], ['op0'], `provenance missing on ${node.id}`);
    assert.equal(node.blockId, nodes[0].blockId);
  }
  assert.deepEqual(
    nodes.map((node) => node.call.targetEntityIds[0]),
    ['callee:A', 'callee:B', 'callee:C'],
    'call effects must lower in source order',
  );
});

test('#4884 an unresolvable second call demotes instead of claiming complete', () => {
  const lowered = bridged([
    directCall('callee:A'),
    { target: 'callee:B', dispatchKind: 'virtual', unresolved: true },
  ]);
  const nodes = callNodes(lowered);
  assert.equal(nodes.length, 2, `tail call lost even in the unresolved shape: ${JSON.stringify(targetsOf(nodes))}`);
  const second = nodes.find((node) => node.call.targetEntityIds.includes('callee:B'));
  assert.equal(second.call.completeness, 'partial');
  assert.equal(second.completeness, 'partial');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((entry) => entry.reason === 'managed-call-effects-unresolved'));
});

test('#4884 a malformed tail call effect stays an explicit unknown', () => {
  const lowered = bridged([directCall('callee:A'), null]);
  const nodes = callNodes(lowered);
  assert.equal(nodes.length, 2, `tail entry lost without an unknown marker: ${nodes.length}`);
  assert.equal(nodes[1].completeness, 'partial');
  assert.ok(nodes[1].unknown, 'tail call node must carry an explicit unknown');
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
