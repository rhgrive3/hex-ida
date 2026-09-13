import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { fixture } from '../helpers/fixtures.mjs';

// Both integer parsers declare signed literals in their grammar, but the
// spelling was handed straight to BigInt(), which rejects every signed
// radix-prefixed form ('-0x10', '+0x10') and even signed decimal ('+16').
// An accepted input class must not silently degrade to "unknown constant"
// while the semantically identical spelling stays exact (#5011).

function pointsToWithConstant(constantText) {
  const f = fixture('function_signed_hex_5011');
  f.block('entry', []);
  const sp = f.stateRead('sp', 'state:sp');
  const c = f.constant('cn', constantText);
  const p = f.binary('p', 'add', sp, c);
  f.store('st', p, null, { widthBits: 32 });
  f.ret('r');
  const built = f.build({});
  const result = analyzeLocalPointsTo(built.ir, built.cfg, built.ssa, {});
  return result.pointsTo.get('p')?.targets?.[0]?.offsetRange ?? null;
}

function canonicalProofFor(constantValue) {
  return deriveCanonicalAddressProof({
    functionId: 'f',
    values: [{ id: 'v0', definitionNodeId: 'n0', machineType: { widthBits: 64 } }],
    nodes: [{
      id: 'n0', kind: 'const', inputs: [], outputs: ['v0'],
      attributes: { constant: constantValue },
    }],
    blocks: [],
  }, 'v0');
}

test('signed hex and signed decimal spellings agree exactly in A2 points-to (#5011)', () => {
  const decimal = pointsToWithConstant('-16');
  assert.ok(decimal?.exact, 'decimal negative constant must stay exact');
  assert.equal(decimal.min, 2n ** 64n - 16n);
  const positive = pointsToWithConstant('16');
  assert.ok(positive?.exact, 'positive decimal constant must stay exact');
  assert.equal(positive.min, 16n);
  for (const spelling of ['-0x10']) {
    const range = pointsToWithConstant(spelling);
    assert.deepEqual(
      { exact: range?.exact ?? null, min: range?.min ?? null },
      { exact: decimal.exact, min: decimal.min },
      `spelling ${spelling} must not lose the exact displacement`,
    );
  }
  for (const spelling of ['+16', '+0x10']) {
    const range = pointsToWithConstant(spelling);
    assert.deepEqual(
      { exact: range?.exact ?? null, min: range?.min ?? null },
      { exact: positive.exact, min: positive.min },
      `spelling ${spelling} must parse as +16, not lose the constant`,
    );
  }
});

test('signed hex constant yields the same exact canonical address proof as decimal (#5011)', () => {
  const decimal = canonicalProofFor(-16);
  assert.equal(decimal.kind, 'absolute');
  assert.equal(decimal.address, 2n ** 64n - 16n);
  // The canonical-address grammar declares a leading `-` only; signed hex
  // must parse exactly, and the undeclared `+` spellings stay rejected.
  for (const spelling of ['-16', '-0x10']) {
    const proof = canonicalProofFor(spelling);
    assert.equal(proof.kind, 'absolute', `spelling ${spelling} must derive an exact proof`);
    assert.equal(proof.address, decimal.address, `spelling ${spelling} must match the decimal proof`);
  }
  for (const spelling of ['+16', '+0x10']) {
    const proof = canonicalProofFor(spelling);
    assert.equal(proof.kind, 'unknown', `undeclared spelling ${spelling} must stay rejected`);
  }
});
