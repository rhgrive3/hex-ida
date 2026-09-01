import assert from 'node:assert/strict';
import test from 'node:test';

import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';
import { applyPhase8Projection, verifyLineProvenance } from '../../../js/decompiler/phase8/projection.js';

function source(valueId, row = 3) {
  return sourceOf({ row, address:0x1000n + BigInt(row) * 4n, ssaDef:valueId, evidence:[{ reason:'fixture-origin' }] });
}

function resultWith(expression, { condition = null } = {}) {
  const returnNode = { kind:'stmt', indent:1, text:'return old;', source:source(99, 4), semantic:{ op:'return', expression, ir:9 } };
  const body = [returnNode];
  const conditions = [];
  if (condition) {
    body.unshift({ kind:'ctrl', indent:1, text:'if (v12 != 0) goto loc_2000;', source:source(12, 3), semantic:null });
    conditions.push({ kind:'SemanticCondition', expression:condition, text:'v12 != 0', row:3, address:0x100cn, ir:7 });
  }
  return {
    semantic:true,
    semanticAst:{ values:[{ kind:'SemanticValue', valueId:99, expression, source:expression.source }], stores:[], calls:[], conditions, inputs:[], outputs:[{ name:'return', expression }] },
    cAst:{ kind:'CProgram', body, source:sourceOf() },
    metrics:{ rawAssemblyFallbacks:0, gotos:condition ? 1 : 0, temporaries:condition ? 1 : 0, redundantCasts:3, structured:true },
  };
}

function analysis(induction = null) {
  return {
    get(key) {
      if (key !== 'induction') return null;
      return induction ?? { completeness:'complete', loops:[] };
    },
  };
}

test('C4-03: merged transform keeps every consumed origin id on the produced source', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const signed = expr.unary('sext', narrow, 32, true, source(4));
  const result = applyPhase8Projection(resultWith(signed), analysis());

  assert.ok(result.phase8Projection.transforms.some((entry) => entry.kind === 'exact-view-collapse'));
  const produced = result.semanticAst.values[0].expression;
  const producedSource = sourceOf(produced.source);
  for (const id of [1, 2, 3, 4]) {
    assert.ok(producedSource.ssaDefs.map(Number).includes(id), `produced source must retain ssaDef ${id}`);
  }
  assert.ok(producedSource.rows.map(Number).includes(3));
  for (const record of result.phase8Projection.transforms) {
    if (record.kind !== 'exact-view-collapse') continue;
    for (const key of ['addresses', 'rows', 'ir', 'ssaDefs', 'ssaUses']) {
      for (const id of record.origin[key]) {
        assert.ok(
          producedSource[key].map(String).includes(String(id)),
          `transform origin ${key}:${id} must survive onto the produced source`,
        );
      }
    }
  }
});

test('C4-03: every rendered line resolves through lineProvenance and the verifier passes', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const signed = expr.unary('sext', narrow, 32, true, source(4));
  const condition = expr.compare('ne', expr.variable('v12', 64, false, source(12, 3)), expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  const returned = expr.constant(0, 64, false, source(99, 4));
  const induction = {
    completeness:'complete',
    loops:[{ header:1, classification:'natural', inductions:[{ valueId:12, step:1n, stepReason:null, origin:{ instructionIds:['insn-12'] } }] }],
  };
  const result = applyPhase8Projection(resultWith(returned, { condition }), analysis(induction));
  assert.equal(verifyLineProvenance(result), true);

  const mapping = result.phase8Projection.lineProvenance;
  assert.ok(mapping.length >= 2);
  for (const entry of mapping) {
    assert.ok(Number.isSafeInteger(entry.outputStartLine) && entry.outputEndLine >= entry.outputStartLine);
  }
  // The condition-replaced control line carries the union of the statement
  // origin and the semantic condition origin.
  const conditionLine = mapping.find((entry) => entry.kind === 'ctrl');
  assert.ok(conditionLine, 'the rendered condition line must be mapped');
  const conditionRow = conditionLine.origin.rows.map(Number).includes(3);
  assert.ok(conditionRow, 'condition line must retain its statement row origin');
  // The transformed return line intersects its own transform record(s).
  const returnLine = mapping.find((entry) => entry.kind === 'stmt');
  assert.ok(returnLine, 'the rendered return line must be mapped');
});

test('C4-03: provenance is deterministic across replays', () => {
  const build = () => {
    const value = expr.variable('a1', 64, true, source(1));
    const wide = expr.unary('trunc', value, 32, false, source(2));
    const narrow = expr.unary('trunc', wide, 8, false, source(3));
    return applyPhase8Projection(resultWith(expr.unary('sext', narrow, 32, true, source(4))), analysis());
  };
  const first = build().phase8Projection.lineProvenance;
  const second = build().phase8Projection.lineProvenance;
  assert.deepEqual(second, first);
  assert.ok(Object.isFrozen(first));
});

test('C4-03: a forged mapping is rejected, not trusted', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const result = applyPhase8Projection(resultWith(expr.unary('trunc', value, 8, false, source(2))), analysis());
  assert.equal(verifyLineProvenance(result), true);
  const forgedEntry = {
    ...result.phase8Projection.lineProvenance[0],
    origin:{
      ...result.phase8Projection.lineProvenance[0].origin,
      ssaDefs:[...result.phase8Projection.lineProvenance[0].origin.ssaDefs, 424242],
    },
  };
  const forged = {
    ...result,
    sourceMap:result.sourceMap,
    phase8Projection:{
      ...result.phase8Projection,
      lineProvenance:[forgedEntry, ...result.phase8Projection.lineProvenance.slice(1)],
    },
  };
  assert.throws(() => verifyLineProvenance(forged), /phase8-provenance-forged-id/);
});

test('C4-03: pseudocode text is unchanged versus the pre-feature projection', () => {
  const value = expr.variable('a1', 64, true, source(1));
  const wide = expr.unary('trunc', value, 32, false, source(2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3));
  const signed = expr.unary('sext', narrow, 32, true, source(4));
  const result = applyPhase8Projection(resultWith(signed), analysis());
  assert.match(result.pseudocode, /return \(int32_t\)\(uint8_t\)a1;/);
});
