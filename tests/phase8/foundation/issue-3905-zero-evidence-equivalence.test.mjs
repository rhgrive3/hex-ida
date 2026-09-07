import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRewrite, verifyWithFunctionSandbox } from '../../../js/decompiler/verify/equivalence.js';
import { verifyAstAgainstFunctionSandbox } from '../../../js/decompiler/verify/sandbox-adapter.js';

const constExpr = (value, bits = 64) => ({ kind: 'const', value: BigInt(value), bits });
const callExpr = { kind: 'call', callee: 'side_effecting_function', args: [], bits: 64 };

function returningIo() {
  return {
    async fetch(address) {
      if (BigInt(address) === 0x1000n) return { mn: 'ret', ops: '' };
      return null;
    },
  };
}

function nonReturningIo() {
  return { async fetch() { return null; } };
}

test('verifyRewrite does not certify equivalence with zero evaluator coverage', () => {
  const result = verifyRewrite(callExpr, constExpr(0));

  assert.equal(result.equivalent, null);
  assert.equal(result.checked, 0);
  assert.ok(result.skipped > 0);
  assert.equal(result.reason, 'no-evaluable-samples');
});

test('verifyRewrite preserves full-coverage equivalence and counterexamples', () => {
  const x = { kind: 'var', name: 'x', bits: 32 };
  const equivalent = verifyRewrite(x, x, { widths: [32], samples: [0n, 1n] });
  assert.equal(equivalent.equivalent, true);
  assert.equal(equivalent.checked, 2);

  const mismatch = verifyRewrite(constExpr(0, 32), constExpr(1, 32), { widths: [32], samples: [0n] });
  assert.equal(mismatch.equivalent, false);
  assert.equal(mismatch.checked, 1);
  assert.ok(mismatch.counterexample);
});

test('verifyRewrite fails closed on partial evaluator coverage', () => {
  const condition = { kind: 'var', name: 'x', bits: 32 };
  const partiallyEvaluable = {
    kind: 'select',
    condition,
    whenFalse: constExpr(0, 32),
    whenTrue: callExpr,
    bits: 32,
  };
  const rewritten = {
    kind: 'select',
    condition,
    whenFalse: constExpr(0, 32),
    whenTrue: callExpr,
    bits: 32,
  };

  const result = verifyRewrite(partiallyEvaluable, rewritten, { widths: [32], samples: [0n, 1n] });
  assert.equal(result.equivalent, null);
  assert.equal(result.checked, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.reason, 'incomplete-evaluator-coverage');
});

test('generic sandbox verifier does not certify an empty case corpus', async () => {
  const adapter = { async execute() { return 0; } };
  const result = await verifyWithFunctionSandbox(adapter, constExpr(0), constExpr(0), []);

  assert.equal(result.available, true);
  assert.equal(result.equivalent, null);
  assert.equal(result.checked, 0);
  assert.equal(result.reason, 'no-cases');
});

test('function sandbox verifier rejects evaluator-zero coverage and unobserved returns', async () => {
  const evaluatorGap = await verifyAstAgainstFunctionSandbox({
    io: returningIo(),
    address: 0x1000n,
    expression: callExpr,
    cases: [{ args: [] }],
  });
  assert.equal(evaluatorGap.equivalent, null);
  assert.equal(evaluatorGap.checked, 0);
  assert.equal(evaluatorGap.skipped, 1);

  const unobservedReturn = await verifyAstAgainstFunctionSandbox({
    io: nonReturningIo(),
    address: 0x1000n,
    expression: constExpr(0),
    cases: [{ args: [] }],
  });
  assert.equal(unobservedReturn.equivalent, null);
  assert.equal(unobservedReturn.checked, 0);
  assert.equal(unobservedReturn.skipped, 1);
});

test('function sandbox verifier preserves observed equivalence and mismatch', async () => {
  const equivalent = await verifyAstAgainstFunctionSandbox({
    io: returningIo(),
    address: 0x1000n,
    expression: constExpr(0),
    cases: [{ args: [] }],
  });
  assert.equal(equivalent.equivalent, true);
  assert.equal(equivalent.checked, 1);

  const mismatch = await verifyAstAgainstFunctionSandbox({
    io: returningIo(),
    address: 0x1000n,
    expression: constExpr(1),
    cases: [{ args: [] }],
  });
  assert.equal(mismatch.equivalent, false);
  assert.equal(mismatch.checked, 1);
  assert.equal(mismatch.mismatches.length, 1);
});
