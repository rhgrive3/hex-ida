import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { createFunctionSummaryCache } from '../js/interproc.js';

const H = 0x1000n;
const G = 0x2000n;
const F = 0x3000n;

function modelAt(base, lines) {
  const rows = lines.map((line, i) => {
    const text = line.trim();
    const space = text.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: space < 0 ? text : text.slice(0, space),
      ops: space < 0 ? '' : text.slice(space + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(address) {
      const delta = address - base;
      if (delta < 0n || delta >= BigInt(rows.length * 4)) return null;
      return Number(delta / 4n);
    },
  });
}

function cacheWith(models, maxDepth) {
  return createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => models[address.toString()] || null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype-fixture' }),
  }, { maxDepth });
}

// #3970 acceptance 1: identity argument-return chain composes across 3 levels.
{
  const models = {
    [H.toString()]: modelAt(H, ['mov x0, x0', 'ret']),
    [G.toString()]: modelAt(G, ['mov x0, x0', `bl #0x${H.toString(16)}`, 'ret']),
    [F.toString()]: modelAt(F, ['mov x0, x0', `bl #0x${G.toString(16)}`, 'ret']),
  };
  const cache = cacheWith(models, 3);
  const summary = await cache.summaryFor(F);
  assert.equal(summary.returns[0].kind, 'argument', 'F must compose down to argument 0');
  assert.equal(summary.returns[0].index, 0);
  assert.equal(summary.returns[0].trusted, true, 'callee-summary trust must survive the compose');
  assert.equal(summary.returns[0].via, 'callee-summary');
}

// #3970 acceptance 2: constant call-site actual propagates as trusted upward.
{
  const models = {
    [H.toString()]: modelAt(H, ['mov x0, x0', 'ret']),
    [G.toString()]: modelAt(G, ['mov x0, x0', `bl #0x${H.toString(16)}`, 'ret']),
    [F.toString()]: modelAt(F, ['mov x0, #5', `bl #0x${G.toString(16)}`, 'ret']),
  };
  const cache = cacheWith(models, 3);
  const summary = await cache.summaryFor(F);
  assert.equal(summary.returns[0].kind, 'constant');
  assert.equal(summary.returns[0].value, 5n);
  assert.equal(summary.returns[0].trusted, true);
}

// #3970 acceptance 3: unknown actual must not fabricate a trusted return.
{
  const models = {
    [H.toString()]: modelAt(H, ['mov x0, x0', 'ret']),
    [G.toString()]: modelAt(G, ['mov x0, x0', `bl #0x${H.toString(16)}`, 'ret']),
    // F calls G without a resolvable argument origin for x0.
    [F.toString()]: modelAt(F, ['bl #0x' + G.toString(16), 'ret']),
  };
  const cache = cacheWith(models, 3);
  const summary = await cache.summaryFor(F);
  assert.equal(summary.returns[0].kind, 'call', 'uncomposable actual must keep the trusted call return');
  assert.notEqual(summary.returns[0].kind, 'unknown');
}

// #3970 acceptance 1 (2-level control): a single wrapper hop already composes.
{
  const models = {
    [H.toString()]: modelAt(H, ['mov x0, x0', 'ret']),
    [G.toString()]: modelAt(G, ['mov x0, x0', `bl #0x${H.toString(16)}`, 'ret']),
  };
  const cache = cacheWith(models, 2);
  const summary = await cache.summaryFor(G);
  assert.equal(summary.returns[0].kind, 'argument');
  assert.equal(summary.returns[0].index, 0);
  assert.equal(summary.returns[0].trusted, true);
}

console.log('issues #3970 trusted argument-return chain regressions PASS');
