import { createFunctionSandbox } from '../../symbolic/function-sandbox.js';
import { evaluateExpression } from './equivalence.js';

function envForArgs(args = [], names = []) {
  const env = {};
  for (let i = 0; i < args.length; i++) {
    const v = BigInt(args[i] ?? 0);
    env[`arg${i + 1}`] = v;
    env[`a${i + 1}`] = v;
    if (names[i]) env[names[i]] = v;
  }
  return env;
}

/**
 * Cross-check a decompiler return expression against the existing concrete
 * FunctionSandbox. The sandbox executes the real function; the AST evaluator
 * independently executes the recovered semantics for the same bounded inputs.
 */
export async function verifyAstAgainstFunctionSandbox({ io, address, expression, cases = [], argNames = [], sandboxOptions = {}, runOptions = {} }) {
  if (!io || address == null || !expression) return { available: false, reason: 'binary IO/address/expression unavailable' };
  const mismatches = [];
  let checked = 0;
  let skipped = 0;
  for (const test of cases) {
    const args = (test?.args || []).map((v) => BigInt(v));
    const sandbox = createFunctionSandbox(io, sandboxOptions);
    await sandbox.setup(address, { ...sandboxOptions, ...test?.setup, args, objectAsArg0: test?.objectAsArg0 ?? false });
    const actual = await sandbox.run({ maxSteps: 20000, ...runOptions, ...test?.run });
    const expected = evaluateExpression(expression, { ...envForArgs(args, argNames), ...(test?.env || {}) }, test?.memory || {});
    if (expected == null || actual?.finalPc !== 0n || actual?.returnValue == null) { skipped++; continue; }
    checked++;
    const bits = Number(expression.bits || 64);
    const real = BigInt.asUintN(bits, BigInt(actual.returnValue));
    const want = BigInt.asUintN(bits, BigInt(expected));
    if (real !== want) mismatches.push({ args, expected: want, actual: real, stopped: actual.stopped, steps: actual.steps });
  }
  if (mismatches.length > 0) return { available: true, equivalent: false, checked, mismatches: mismatches.slice(0, 8) };
  if (checked === 0) return { available: true, equivalent: null, checked, skipped, mismatches, reason: 'no-comparable-cases' };
  if (skipped > 0) return { available: true, equivalent: null, checked, skipped, mismatches, reason: 'incomplete-case-coverage' };
  return { available: true, equivalent: true, checked, mismatches };
}
