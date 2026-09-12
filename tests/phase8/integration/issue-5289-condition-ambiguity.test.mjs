import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';

function source(row) {
  return sourceOf({ row, address:0x1000n + BigInt(row) * 4n, evidence:[{ reason:'issue-5289-fixture' }] });
}

function condition(row, name, value) {
  return {
    kind:'SemanticCondition',
    row,
    address:0x1000n + BigInt(row) * 4n,
    ir:value,
    expression:expr.compare(
      'eq',
      expr.variable(name, 32, false, source(row)),
      expr.constant(value, 32, false, source(row)),
      false,
      source(row),
    ),
  };
}

function resultWithConditions(conditions, row = 42) {
  const nodeSource = source(row);
  return {
    semantic:true,
    semanticAst:{ values:[], stores:[], calls:[], conditions, inputs:[], outputs:[] },
    cAst:{
      kind:'CProgram',
      body:[{ kind:'ctrl', indent:1, text:'if (original_condition) {', source:nodeSource, semantic:null }],
      source:sourceOf(),
    },
    metrics:{ rawAssemblyFallbacks:0, gotos:0, temporaries:0, redundantCasts:0, structured:true },
  };
}

const analysis = { get() { return { completeness:'complete', loops:[] }; } };

test('issue #5289 keeps a row ambiguous after three conditions instead of selecting the third', () => {
  const conditions = [
    condition(42, 'a', 1),
    condition(42, 'b', 2),
    condition(42, 'c', 3),
  ];
  const projected = applyPhase8Projection(resultWithConditions(conditions), analysis);

  assert.match(projected.pseudocode, /if \(original_condition\) \{/);
  assert.doesNotMatch(projected.pseudocode, /\bc == 3\b/);
});

test('condition projection is unique for one condition and fail-closed for every multiplicity >= 2', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const conditions = Array.from({ length:count }, (_, index) => condition(42, `v${index}`, index + 1));
    const projected = applyPhase8Projection(resultWithConditions(conditions), analysis);
    if (count === 1) {
      assert.match(projected.pseudocode, /if \(v0 == 1\) \{/);
    } else {
      assert.match(projected.pseudocode, /if \(original_condition\) \{/,
        `row must remain ambiguous after ${count} conditions`);
    }
  }
});

test('ambiguous-row outcome is invariant to condition order while another unique row still projects', () => {
  for (const ambiguous of [
    [condition(42, 'a', 1), condition(42, 'b', 2), condition(42, 'c', 3)],
    [condition(42, 'c', 3), condition(42, 'a', 1), condition(42, 'b', 2)],
  ]) {
    const unique = condition(43, 'only', 9);
    const result = resultWithConditions([...ambiguous, unique], 42);
    result.cAst.body.push({
      kind:'ctrl', indent:1, text:'while (unique_original) {', source:source(43), semantic:null,
    });
    const projected = applyPhase8Projection(result, analysis);
    assert.match(projected.pseudocode, /if \(original_condition\) \{/);
    assert.match(projected.pseudocode, /while \(only == 9\) \{/);
  }
});
