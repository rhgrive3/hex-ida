// Regression for #7937: CIL `div` (0x5B) carries specified exceptional
// control-flow authority — ECMA-335 Partition III: integral division throws
// System.DivideByZeroException (divisor == 0) and System.ArithmeticException
// (signed MIN_VALUE / -1); floating-point division throws neither. The lifter
// has no typed operand-stack authority, so the integral-vs-floating
// distinction that selects the exception contract cannot be resolved
// losslessly: the bundle must fail closed to partial instead of publishing
// exception-free exact/complete semantics (and must not fabricate predicates
// that would let FP division inherit integral-only exceptions).
import assert from 'node:assert/strict';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { buildMinimalCil } from './cil-parser.test.mjs';

console.log('[phase11] running cil div exception authority regression #7937...');

const METHOD = 0x400;

// Tiny body: ldc.i4.1, ldc.i4.0, <op>, pop, ret.
function fixture(op) {
  const b = buildMinimalCil();
  b[METHOD] = (5 << 2) | 0x02;
  b.set([0x17, 0x16, op, 0x26, 0x2a], METHOD + 1);
  return b;
}

{
  const effects = liftCilMethod(0, parseCil(fixture(0x5b)));
  const div = effects.bundles.find((b) => b.mnemonic === 'div');
  assert.ok(div, 'div bundle present');
  assert.equal(div.completeness, 'partial');
  assert.ok(div.unknownEffects.some((e) => e.reason === 'cil-div-exception-authority-unresolved'));
  assert.equal(div.possibleExceptions.length, 0, 'no fabricated exception predicates');
  assert.equal(effects.aggregateCompleteness, 'partial');
}

// Non-trapping integral arithmetic keeps its exact contract.
{
  const effects = liftCilMethod(0, parseCil(fixture(0x58)));
  const add = effects.bundles.find((b) => b.mnemonic === 'add');
  assert.equal(add.completeness, 'exact');
  assert.equal(add.unknownEffects.length, 0);
}

// The validator must not report semanticEffect:'complete' for the div bundle.
{
  const frontend = new CilFrontend();
  const image = parseCil(fixture(0x5b));
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  assert.notEqual(validation.status, 'valid');
  assert.equal(validation.completeness.semanticEffect, 'partial');
}

// The shared Semantic IR must not publish complete semantics for the division
// function; the exceptional authority loss must surface as an unknown.
{
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, parseCil(fixture(0x5b))));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === 'cil-div-exception-authority-unresolved'));
  const divNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'div');
  assert.ok(divNode, 'div node present in lowered IR');
  assert.equal(divNode.completeness, 'partial');
}

console.log('[phase11] cil div exception authority regression #7937 passed');
