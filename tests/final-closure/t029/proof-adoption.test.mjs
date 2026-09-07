import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import {
  RewriteEngine,
  adoptProofGatedCandidates,
} from '../../../js/decompiler/rewrite/engine.js';
import {
  createRewriteProofGate,
  isRewriteProof,
  isRewriteProofFor,
  verifyDecompilerRewrite,
} from '../../../js/decompiler/verify/equivalence.js';
import { generateEGraphCandidates } from '../../../js/decompiler/phase8/egraph.js';
import { rewriteExpressionWithProof } from '../../../js/decompiler/pipeline.js';
import { TieredBvBackend } from '../../../js/symbolic/solver/tiered-backend.js';

function source(id, def = id) {
  return { ir: id, ssaDef: def };
}

function identityPair(name = 'x', def = `${name}-def`) {
  const variable = expr.variable(name, 8, false, source(name, def));
  const before = expr.binary('add', variable, expr.constant(0n, 8, false, source(`${name}-zero`)), 8, false);
  return { variable, before, after: variable };
}

class MutatingExactBackend extends TieredBvBackend {
  constructor(mutate) {
    super({ id: 't029-mutating-exact', version: '1.0.0' });
    this.mutate = mutate;
  }

  createSession(options = {}) {
    const session = super.createSession(options);
    const check = session.check.bind(session);
    session.check = async (...args) => {
      const result = await check(...args);
      this.mutate();
      return result;
    };
    return session;
  }
}

test('T029 exact proof tokens bind the complete AST pair and SSA provenance', async () => {
  const pair = identityPair();
  const token = await verifyDecompilerRewrite(pair.before, pair.after);

  assert.equal(isRewriteProof(token), true);
  assert.equal(token.accepted, true);
  assert.equal(isRewriteProofFor(token, pair.before, pair.after), true);
  assert.equal(isRewriteProofFor(token, pair.after, pair.before), false);
  const scoped = await verifyDecompilerRewrite(pair.before, pair.after, { refinement: 'scope-a', inputDigest: 'input-a' });
  assert.equal(isRewriteProofFor(scoped, pair.before, pair.after, { refinement: 'scope-a', inputDigest: 'input-a' }), true);
  assert.equal(isRewriteProofFor(scoped, pair.before, pair.after, { refinement: 'scope-b', inputDigest: 'input-a' }), false);

  const other = identityPair('x', 'different-definition');
  assert.equal(isRewriteProofFor(token, other.before, other.after), false);
  const stale = await verifyDecompilerRewrite(pair.before, pair.after, { provenanceStatus: 'stale' });
  assert.equal(isRewriteProof(stale), false);
  assert.equal(stale.reasonCode, 'stale-transform-provenance');
});

test('T029 withholds a proof when the AST mutates during exact verification', async () => {
  const pair = identityPair();
  const backend = new MutatingExactBackend(() => { pair.variable.name = 'mutated_after_query'; });
  const result = await verifyDecompilerRewrite(pair.before, pair.after, { backend });

  assert.equal(isRewriteProof(result), false);
  assert.equal(result.reasonCode, 'mutable-proof-input-changed-during-verification');
  assert.equal(isRewriteProofFor(result, pair.before, pair.after), false);
});

test('T029 refuses memory, undefined arithmetic, and copied proof-shaped values', async () => {
  const pair = identityPair();
  const load = expr.load({ key: 'stack:0' }, 8, source('load', 'load-def'));
  const memoryResult = await verifyDecompilerRewrite(load, pair.after);
  assert.equal(isRewriteProof(memoryResult), false);
  assert.equal(memoryResult.reasonCode, 'observable-effect-not-modeled');

  const divide = expr.binary('udiv', pair.variable, expr.constant(0n, 8), 8, false);
  const ubResult = await verifyDecompilerRewrite(divide, pair.after);
  assert.equal(isRewriteProof(ubResult), false);
  assert.equal(ubResult.reasonCode, 'undefined-arithmetic-domain-requires-precondition');

  const forged = { accepted: true, verdict: 'proved', solverStatus: 'unsat', queryHash: 'copied' };
  const engine = new RewriteEngine(DEFAULT_RULES, {
    deterministic: true, timeBudgetMs: 1000, maxIterations: 8, nodeBudget: 1024,
  });
  const blocked = engine.rewrite(pair.before, {
    deterministicTransforms: true,
    requireProof: true,
    proofGate: () => forged,
  });
  assert.equal(structuralKey(blocked.root), structuralKey(pair.before));
  assert.ok(blocked.stats.proofWithheld > 0);
  assert.equal(blocked.proof.length, 0);
});

test('T029 proof-gated production rewrite consumes only a branded exact token', async () => {
  const pair = identityPair();
  const rewritten = await rewriteExpressionWithProof(pair.before, {
    deterministicTransforms: true,
    timeBudgetMs: 1000,
    nodeBudget: 2048,
    maxIterations: 8,
  });

  assert.equal(structuralKey(rewritten.root), structuralKey(pair.after));
  assert.equal(rewritten.stats.proofAccepted, 1);
  assert.equal(rewritten.stats.proofWithheld, 0);
  assert.equal(isRewriteProof(rewritten.proof[0].verifierProof), true);
});

test('T029 e-graph proposals enter the production bridge only after pair-bound proof', async () => {
  const pair = identityPair();
  const generated = generateEGraphCandidates(pair.before);
  assert.equal(generated.status, 'complete');
  assert.equal(generated.candidates.length, 1);
  const candidate = generated.candidates[0];

  const accepted = await adoptProofGatedCandidates(pair.before, generated.candidates, {
    proofGate: createRewriteProofGate({}),
  });
  assert.equal(accepted.status, 'complete');
  assert.equal(accepted.adopted.length, 1);
  assert.equal(structuralKey(accepted.root), structuralKey(pair.after));

  const wrong = identityPair('y', 'unrelated-definition');
  const wrongToken = await verifyDecompilerRewrite(wrong.before, wrong.after);
  const replay = await adoptProofGatedCandidates(pair.before, [candidate], {
    proofGate: () => wrongToken,
  });
  assert.equal(replay.adopted.length, 0);
  assert.equal(replay.withheld[0].reason, 'proof-unknown-or-ineligible');
  assert.equal(structuralKey(replay.root), structuralKey(pair.before));

  let cancelled = false;
  const late = await adoptProofGatedCandidates(pair.before, [candidate], {
    proofGate: async (...args) => {
      const token = await createRewriteProofGate({})(...args);
      cancelled = true;
      return token;
    },
    shouldAbort: () => cancelled,
  });
  assert.equal(late.status, 'cancelled');
  assert.equal(late.adopted.length, 0);
  assert.equal(structuralKey(late.root), structuralKey(pair.before));
});
