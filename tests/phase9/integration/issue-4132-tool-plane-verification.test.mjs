// Regression for #4132 review remediation: proof tools must consume canonical
// analyzed IR, the model-visible Semantic IR projection must preserve operation
// discriminators, and model-supplied Expr-shaped objects must never bypass the
// translation/source-binding boundary and mint exact proof authority.
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../../js/blocks.js';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';
import { BV_BINARY_OP, EXPR_KIND } from '../../../js/symbolic/expr/kinds.js';

const BASE = 0x1000n;

function modelOf(lines) {
  const instructions = lines.map((line, row) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    return delta >= 0n && delta < BigInt(instructions.length * 4) ? Number(delta / 4n) : null;
  };
  return buildSemanticModel(instructions, {
    startRow: 0,
    endRow: instructions.length - 1,
    rowOfAddress,
  });
}

// Exact reviewer counterexample: real production `sub x0,x1,x2` must retain
// the canonical discriminator through the model-visible inspect tool.
const variableModel = modelOf(['sub x0, x1, x2', 'ret']);
const variableRegistry = createHexToolRegistry({
  analyze: async () => variableModel,
  addressExists: () => true,
}, { maxFunctions: 4, maxDisassembly: 128 });
const variableInspect = await variableRegistry.execute('inspect_function_region', {
  functionAddress: '0x1000', view: 'semantic-ir', start: 0, count: 100,
}, { scope: 'function' });
assert.ok(
  variableInspect.result.results.some((inst) => inst.op === 'bin' && inst.sub === 'sub'),
  'production `sub x0,x1,x2` must retain its canonical `sub` discriminator',
);

// Use a constant-source SUB for the proof query so the exact local backend can
// construct a query without an unrelated input-correspondence requirement.
const model = modelOf(['sub x0, xzr, xzr', 'ret']);
const registry = createHexToolRegistry({
  analyze: async () => model,
  addressExists: () => true,
}, { maxFunctions: 4, maxDisassembly: 128 });
const inspected = await registry.execute('inspect_function_region', {
  functionAddress: '0x1000', view: 'semantic-ir', start: 0, count: 100,
}, { scope: 'function' });
const projectedSub = inspected.result.results.find((inst) => inst.op === 'bin' && inst.sub === 'sub');
assert.ok(projectedSub, 'production constant SUB must be projected with its canonical discriminator');

// Deliberately tamper the projected discriminator. The proof tool must bind the
// stable projected identity back to canonical analyzed IR rather than trusting
// caller/model fields. The resulting query therefore contains SUB, not ADD.
const forgedProjection = { ...projectedSub, sub: 'add' };
const verified = await registry.execute('verify_bounded_equivalence', {
  beforeFunctionAddress: '0x1000',
  afterFunctionAddress: '0x1000',
  beforeTarget: forgedProjection,
  afterTarget: forgedProjection,
}, { scope: 'function', timeoutMs: 2_000 });
assert.equal(verified.result.completeness.translation, 'complete', 'canonical producer IR must reach the translator exactly');
assert.equal(verified.result.query.assertion.kind, EXPR_KIND.COMPARE);
assert.equal(verified.result.query.assertion.left.kind, EXPR_KIND.BINARY);
assert.equal(verified.result.query.assertion.left.op, BV_BINARY_OP.SUB, 'canonical target binding must preserve SUB semantics');
assert.equal(verified.result.query.assertion.right.op, BV_BINARY_OP.SUB, 'both equivalence sides must use canonical SUB semantics');
assert.notEqual(verified.result.query.assertion.left.op, BV_BINARY_OP.ADD, 'tampered model projection must not rewrite source semantics');

// A non-Expr object must not become trusted merely because no function source
// was supplied. The old wrapper returned the caller object unchanged when the
// canonical IR lookup was absent, reopening the translation/proof fast path.
await assert.rejects(
  () => registry.execute('verify_bounded_equivalence', {
    beforeTarget: forgedProjection,
    afterTarget: forgedProjection,
  }, { scope: 'function', timeoutMs: 2_000 }),
  (error) => error?.type === 'invalid_tool_call' && /both function addresses|canonical Semantic IR/i.test(error.message),
  'unbound semantic targets must fail closed when canonical producer IR is unavailable',
);

// Expr rejection is recursive: hiding a forged DAG under a precondition object
// must not bypass the model boundary while otherwise-valid canonical targets
// are used for both sides.
await assert.rejects(
  () => registry.execute('verify_bounded_equivalence', {
    beforeFunctionAddress: '0x1000',
    afterFunctionAddress: '0x1000',
    beforeTarget: projectedSub,
    afterTarget: projectedSub,
    preconditions: { nested: { kind: 'const', sort: { kind: 'bool' }, value: true } },
  }, { scope: 'function', timeoutMs: 2_000 }),
  (error) => error?.type === 'invalid_tool_call' && /Expr DAG|canonical Semantic IR/i.test(error.message),
  'nested caller-supplied Expr DAGs must be rejected before solver translation',
);

// A JSON object can mimic the shallow Expr `{kind, sort}` shape. Before this
// remediation that object skipped translation and a forged Bool false could
// receive an exact UNSAT/PROVED verdict. Model tool input is untrusted, so Expr
// DAG-shaped objects are rejected rather than treated as internally-built ASTs.
await assert.rejects(
  () => registry.execute('verify_edge_feasibility', {
    functionAddress: '0x1000',
    fromBlock: 0,
    edgeCondition: { kind: 'const', sort: { kind: 'bool' }, value: false },
  }, { scope: 'function', timeoutMs: 2_000 }),
  (error) => error?.type === 'invalid_tool_call' && /Expr DAG|canonical Semantic IR/i.test(error.message),
  'caller-supplied Expr shape must not bypass source translation and mint exact proof authority',
);
