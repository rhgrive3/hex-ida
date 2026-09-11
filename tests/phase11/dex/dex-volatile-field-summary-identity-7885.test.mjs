import assert from 'node:assert/strict';
import test from 'node:test';

import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { buildManagedMethodSummary, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { functionSummaryDigest } from '../../../js/analysis/summary/contract.js';
import { buildDex } from '../fixtures/medium-dex.mjs';

const ACC_PUBLIC = 0x01;
const ACC_STATIC = 0x08;
const ACC_VOLATILE = 0x40;

async function volatileRead(name) {
  const { bytes } = buildDex({
    fields: [{ classType:'LTest;', type:'I', name, flags:ACC_PUBLIC | ACC_STATIC | ACC_VOLATILE, static:true }],
    methods: [{
      classType:'LTest;', name:'read', returnType:'I', params:[], flags:ACC_PUBLIC | ACC_STATIC,
      words:[0x0060, 0, 0x000f], registers:1,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId:`dex-volatile-summary-${name}` });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const memoryEffect = decoded.bundles.find((bundle) => bundle.memoryEffects?.length)?.memoryEffects?.[0];
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const summary = buildManagedMethodSummary(lowered);
  return { memoryEffect, lowered, summary };
}

function orderingFact(summary) {
  const facts = summary.summary.semanticFacts.filter((fact) => fact.kind === 'managed-memory-ordering');
  assert.equal(facts.length, 1, 'one volatile field access must publish one ordering fact');
  return facts[0];
}

test('#7885 summary binds volatile ordering to the exact DEX field identity', async () => {
  const x = await volatileRead('x');
  const fact = orderingFact(x.summary);
  assert.equal(fact.fieldIdentity, x.memoryEffect.fieldIdentity);
  assert.equal(fact.ordering, 'acquire');
  assert.equal(fact.volatility, true);
  assert.equal(fact.atomic, true);
  assert.equal(x.summary.completeness, 'complete');
  assert.equal(x.summary.summary.status.completeness, 'complete');
});

test('#7885 different fields keep distinct ordering facts and summary dependency identity', async () => {
  const x = await volatileRead('x');
  const y = await volatileRead('y');
  assert.notEqual(orderingFact(x.summary).fieldIdentity, orderingFact(y.summary).fieldIdentity);
  assert.notEqual(functionSummaryDigest(x.summary.summary), functionSummaryDigest(y.summary.summary),
    'field identity must participate in the canonical FunctionSummary digest');
});

test('#7885 field ordering without recoverable field identity fails closed at summary publication', async () => {
  const x = await volatileRead('x');
  const memoryNode = x.lowered.semanticIr.nodes.find((node) => node.kind === 'load');
  const addressValue = x.lowered.semanticIr.values.find((value) => value.id === memoryNode.memory.addressExpr.valueId);
  const addressNodeId = addressValue?.definitionNodeId;
  assert.ok(addressNodeId, 'DEX field access must have a canonical address definition');

  const nodes = x.lowered.semanticIr.nodes.map((node) => node.id === addressNodeId
    ? { ...node, attributes:{} }
    : node.id === memoryNode.id
      ? { ...node, attributes:{} }
      : node);
  const degraded = {
    ...x.lowered,
    semanticIr:{ ...x.lowered.semanticIr, nodes },
  };
  const summary = buildManagedMethodSummary(degraded);
  assert.equal(summary.completeness, 'partial');
  assert.equal(summary.summary.status.completeness, 'partial');
  assert.equal(orderingFact(summary).fieldIdentity, undefined,
    'an unbound ordering fact must not fabricate a field identity');
});
