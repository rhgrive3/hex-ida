import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import {
  isRewriteProof,
  verifyDecompilerRewrite,
} from '../../../js/decompiler/verify/equivalence.js';
import { TieredBvBackend } from '../../../js/symbolic/solver/tiered-backend.js';
import { OP, MK } from '../../../js/ir.js';
import {
  analyzeTaint,
  TaintStore,
  queryTaint,
  projectTaint,
  sourceTaint,
  unknownTaint,
  joinTaint,
  sanitizeTaint,
  evaluateDeobfuscationGate,
  applyProofGatedDeobfuscation,
} from '../../../js/symbolic/index.js';

function source(id, def = id) {
  return { ir: id, ssaDef: def };
}

function identityPair(name = 'gate', def = `${name}-def`) {
  const variable = expr.variable(name, 8, false, source(name, def));
  const before = expr.binary('add', variable, expr.constant(0n, 8, false, source(`${name}-zero`)), 8, false);
  return { variable, before, after: variable };
}

class MutatingExactBackend extends TieredBvBackend {
  constructor(mutate) {
    super({ id: 't034-mutating-exact', version: '1.0.0' });
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

function taintIr() {
  const source = { id: 'source', kind: 'arg', reg: 'x0' };
  const dst = { id: 'loaded', bits: 32 };
  const loc = { kind: MK.GLOBAL, key: 'global:100', address: 0x100n, size: 4 };
  const store = { id: 'store', op: OP.STORE, row: 1, address: 1, loc, extra: { size: 4 }, args: [{ value: source }] };
  const load = { id: 'load', op: OP.LOAD, row: 2, address: 2, loc, extra: { size: 4 }, dst };
  dst.def = load;
  const ret = { id: 'ret', op: OP.RET, row: 3, address: 3, args: [{ value: dst }] };
  return { entry: 0, blocks: [{ index: 0, insts: [store, load, ret], succ: [] }] };
}

function branchTaintIr() {
  const left = { id: 'left-source', kind: 'arg', reg: 'x0' };
  const right = { id: 'right-source', kind: 'arg', reg: 'x1' };
  const leftValue = { id: 'merged', bits: 8 };
  const rightValue = { id: 'merged', bits: 8 };
  const branch = {
    id: 'branch', op: OP.CBR, address: 0, args: [{ value: { id: 'condition', const: 1n } }],
    extra: { target: 0x20n },
  };
  const leftMove = { id: 'left-move', op: OP.MOV, address: 0x20n, dst: leftValue, args: [{ value: left }] };
  const rightMove = { id: 'right-move', op: OP.MOV, address: 0x30n, dst: rightValue, args: [{ value: right }] };
  const leftRet = { id: 'left-ret', op: OP.RET, args: [{ value: leftValue }] };
  const rightRet = { id: 'right-ret', op: OP.RET, args: [{ value: rightValue }] };
  return {
    entry: 0,
    blocks: [
      { index: 0, insts: [branch], succ: [1, 2] },
      { index: 1, insts: [leftMove, leftRet], succ: [] },
      { index: 2, insts: [rightMove, rightRet], succ: [] },
    ],
  };
}

test('T034 propagates source taint through byte memory and exposes query/projection', () => {
  const analysis = analyzeTaint(taintIr(), {
    sources: [{ valueId: 'source', source: 'network', category: 'input' }],
    sinks: [{ id: 'ret', instructionId: 'ret' }],
  });
  assert.equal(analysis.version, 'symbolic-taint-proof-v1');
  assert.equal(analysis.status, 'complete');
  assert.equal(analysis.complete, true);
  assert.ok(analysis.paths[0].returnTaint.labels.some((label) => label.source === 'network'));
  assert.equal(queryTaint(analysis, 'loaded').exact, true);
  assert.ok(projectTaint(analysis).records.some((record) => record.valueId === 'id:loaded'));
});
test('T034 unknown sanitizer and incomplete aliases cannot clear taint', () => {
  const tainted = sourceTaint('network', { category: 'input' });
  const unknownSanitizer = sanitizeTaint(tainted, { id: 'maybe-clean' });
  assert.equal(unknownSanitizer.unknown, true);
  assert.ok(unknownSanitizer.labels.length > 0);

  const store = new TaintStore();
  store.storeMemory(0x100n, tainted, 8);
  const alias = store.loadMemory(0x100n, 8, { aliasRelation: 'may' });
  assert.equal(alias.unknown, true);

  const symbolicOverwrite = new TaintStore();
  symbolicOverwrite.storeMemory(0x200n, joinTaint(), 8);
  symbolicOverwrite.storeMemory({ kind: 'pointer', name: 'possible-200' }, joinTaint(), 8);
  assert.equal(symbolicOverwrite.memoryUnknown, true);
  assert.equal(symbolicOverwrite.loadMemory(0x200n, 8).unknown, true);

  const bounded = analyzeTaint(taintIr(), { maxWorkItems: 1 });
  assert.notEqual(bounded.status, 'complete');
});

test('T034 aggregate taint joins branch labels and incomplete queries stay unknown', () => {
  const analysis = analyzeTaint(branchTaintIr(), {
    sources: [
      { valueId: 'left-source', source: 'left-input', category: 'input' },
      { valueId: 'right-source', source: 'right-input', category: 'input' },
    ],
  });
  assert.equal(analysis.status, 'complete');
  const aggregate = analysis.taints['id:merged'];
  assert.ok(aggregate.labels.some((label) => label.source === 'left-input'));
  assert.ok(aggregate.labels.some((label) => label.source === 'right-input'));
  const queried = queryTaint(analysis, 'merged');
  assert.equal(queried.exact, true);
  assert.equal(queried.value, analysis.store.values.get('id:merged'));
  const projected = projectTaint(analysis);
  const record = projected.records.find((item) => item.valueId === 'id:merged');
  assert.equal(record.taintDigest, projectTaint({ ...analysis, taints: { 'id:merged': queried.value } }).records.find((item) => item.valueId === 'id:merged').taintDigest);

  const partial = { ...analysis, status: 'partial', complete: false };
  assert.equal(queryTaint(partial, 'merged').exact, false);
  assert.equal(projectTaint(partial).exact, false);
});

test('T034 adoption requires exact proof and complete, known taint', () => {
  const pair = identityPair();
  const taint = analyzeTaint(taintIr(), {
    sources: [{ valueId: 'source', source: 'network', category: 'input' }],
  });
  assert.equal(taint.status, 'complete');
  assert.equal(taint.complete, true);

  let calls = 0;
  const forged = applyProofGatedDeobfuscation({
    before: pair.before,
    after: pair.after,
    proof: { verdict: 'proved', solverStatus: 'unsat', completeness: { translation: 'complete', controlFlow: 'complete', memoryEffects: 'complete', pathCoverage: 'complete', queryScope: 'complete' } },
    taintAnalysis: taint,
    transform: () => { calls++; return pair.after; },
  });
  assert.equal(forged.status, 'withheld');
  assert.equal(forged.reason, 'proof-authority-untrusted');
  assert.equal(calls, 0);

  return verifyDecompilerRewrite(pair.before, pair.after).then(async (proof) => {
    assert.equal(isRewriteProof(proof), true);
    const wrong = identityPair('wrong', 'wrong-definition');
    const replay = applyProofGatedDeobfuscation({
      before: wrong.before,
      after: wrong.after,
      proof,
      taintAnalysis: taint,
      transform: () => { calls++; return wrong.after; },
    });
    assert.equal(replay.status, 'withheld');
    assert.equal(replay.reason, 'proof-pair-mismatch');
    assert.equal(calls, 0);

    const missingTaint = applyProofGatedDeobfuscation({
      before: pair.before,
      after: pair.after,
      proof,
      transform: () => { calls++; return pair.after; },
    });
    assert.equal(missingTaint.status, 'withheld');
    assert.equal(missingTaint.reason, 'taint-analysis-missing');
    assert.equal(calls, 0);

    const approved = applyProofGatedDeobfuscation({
      before: pair.before,
      after: pair.after,
      proof,
      taintAnalysis: taint,
      transform: () => { calls++; return pair.after; },
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.result, pair.after);
    assert.equal(calls, 1);

    const mutated = identityPair('mutating');
    const mutatingProof = await verifyDecompilerRewrite(mutated.before, mutated.after, {
      backend: new MutatingExactBackend(() => { mutated.variable.name = 'mutated-during-proof'; }),
    });
    assert.equal(isRewriteProof(mutatingProof), false);
    const mutationResult = applyProofGatedDeobfuscation({
      before: mutated.before,
      after: mutated.after,
      proof: mutatingProof,
      taintAnalysis: taint,
      transform: () => { calls++; return mutated.after; },
    });
    assert.equal(mutationResult.status, 'withheld');
    assert.equal(mutationResult.reason, 'proof-authority-untrusted');
    assert.equal(calls, 1);
  });
});
