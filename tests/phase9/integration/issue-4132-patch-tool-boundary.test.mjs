// Regression for #4132 review remediation: the model-visible patch verifier
// has no canonical original/patched IR resolver in its current tool contract.
// It must therefore fail closed instead of treating caller objects as proof
// authority, including the shallow `{ kind, sort }` Expr fast-path shape.
import assert from 'node:assert/strict';
import { createHexToolRegistry } from '../../../js/ai/tools/index.js';

const registry = createHexToolRegistry({}, { maxFunctions: 2, maxDisassembly: 32 });
const forgedExpr = { kind: 'const', sort: { kind: 'bool' }, value: false };

await assert.rejects(
  () => registry.execute('verify_patch_equivalence', {
    originalBinaryId: 'bin-A',
    patchedPatchSetId: 'patch-1',
    originalTarget: forgedExpr,
    patchedTarget: forgedExpr,
  }, { scope: 'function', timeoutMs: 1_000 }),
  (error) => error?.type === 'invalid_tool_call' && /Expr DAG|canonical Semantic IR/i.test(error.message),
  'caller-supplied Expr DAGs must not reach the exact patch-proof fast path',
);

await assert.rejects(
  () => registry.execute('verify_patch_equivalence', {
    originalBinaryId: 'bin-A',
    patchedPatchSetId: 'patch-1',
    originalTarget: { id: 'forged-original', op: 'bin', sub: 'add', args: [] },
    patchedTarget: { id: 'forged-patched', op: 'bin', sub: 'add', args: [] },
  }, { scope: 'function', timeoutMs: 1_000 }),
  (error) => error?.type === 'invalid_tool_call' && /requires canonical original and patched Semantic IR binding/i.test(error.message),
  'unbound caller-authored Semantic IR must also fail closed until a trusted patch IR resolver exists',
);
