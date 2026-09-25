import assert from 'node:assert/strict';
import test from 'node:test';

import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';

/**
 * The human-readable truncation warning must not assert a cause the decompiler
 * cannot prove.
 *
 * `ir.truncated` is the legacy projection of the canonical Semantic IR's
 * `completeness` (`js/semantics/compat/semantic-ir-v2-to-v1.js`). That
 * completeness is not `complete` for several independent reasons — unsupported
 * instructions kept as `__asm`, call context effects that cannot be minted from
 * an ABI-neutral projection, and genuine work/time budget exhaustion. The
 * semantic core sees only the boolean, so "budget truncated this function" was a
 * claim it had no evidence for: the p8triage lane measured
 * `x86_64.quality.aggregate_array_stride.O2`, whose truncated source is 61
 * vector-family instructions left as `__asm`, with `rewriteBudgetExceeded:false`
 * and no budget diagnostic anywhere in the result.
 *
 * This pins the honest wording at the real product entry point: the truncation
 * is reported, the result is reported as partial, and no cause is invented.
 */

function fixture({ truncated }) {
  const value = { id: 1, reg: 'x0', bits: 32, kind: 'arg', uses: [], def: null, const: null,
    origin: { kind: 'instruction', address: 0x1000n } };
  const ret = { id: 1, op: 'ret', row: 0, block: 0, address: 0x1000n, args: [] };
  const model = {
    name: 'truncated_fixture',
    instructions: [{ row: 0, address: 0x1000n, size: 4, mn: 'ret', ops: '' }],
    switches: [],
  };
  const ir = {
    truncated,
    name: 'truncated_fixture',
    functionId: 'truncated_fixture',
    startAddress: 0x1000n,
    origin: { kind: 'function', address: 0x1000n },
    values: [value],
    instructions: [ret],
    args: new Map([['x0', value]]),
    blocks: [{ index: 0, startRow: 0, endRow: 0, succ: [], insts: [ret] }],
    entry: 0,
    locations: new Map(),
    byRow: new Map(),
  };
  return { model, ir };
}

test('a truncated source is reported as partial without inventing a budget cause', () => {
  const { model, ir } = fixture({ truncated: true });
  const result = decompileSemantic(model, { ir, addr: 0x1000n, name: 'truncated_fixture' });
  assert.ok(result, 'the semantic core must decompile the fixture');
  assert.equal(result.ir.truncated, true, 'the fixture must really be a truncated source');
  const truncationWarnings = result.warnings.filter((warning) => /\btruncated\b/i.test(warning));
  assert.equal(truncationWarnings.length, 1,
    `exactly one truncation warning is expected: ${JSON.stringify(result.warnings)}`);
  const [warning] = truncationWarnings;
  assert.match(warning, /\bpartial\b/i, 'the warning must still say the result is partial');
  assert.doesNotMatch(warning, /\bbudget\b/i,
    `the semantic core cannot prove a budget cause for ir.truncated: ${JSON.stringify(warning)}`);
});

test('a complete source emits no truncation warning', () => {
  const { model, ir } = fixture({ truncated: false });
  const result = decompileSemantic(model, { ir, addr: 0x1000n, name: 'truncated_fixture' });
  assert.ok(result, 'the semantic core must decompile the fixture');
  assert.notEqual(result.ir.truncated, true);
  assert.deepEqual(result.warnings.filter((warning) => /\btruncated\b/i.test(warning)), []);
});
