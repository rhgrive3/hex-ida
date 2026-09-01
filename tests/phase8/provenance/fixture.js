import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';

export { expr, sourceOf };

export function source(valueId, row = 3) {
  return sourceOf({ row, address:0x1000n + BigInt(row) * 4n, ssaDef:valueId, evidence:[{ reason:'fixture-origin' }] });
}

export function resultWith(expression, { condition = null, sourcelessLine = false } = {}) {
  const returnNode = { kind:'stmt', indent:1, text:'return old;', source:source(99, 4), semantic:{ op:'return', expression, ir:9 } };
  const body = [returnNode];
  if (sourcelessLine) body.unshift({ kind:'label', indent:0, text:'loc_1000:', source:sourceOf(), semantic:null });
  const conditions = [];
  if (condition) {
    body.unshift({ kind:'ctrl', indent:1, text:'if (v12 != 0) goto loc_2000;', source:source(12, 3), semantic:null });
    conditions.push({ kind:'SemanticCondition', expression:condition, text:'v12 != 0', row:3, address:0x100cn, ir:7 });
  }
  return {
    semantic:true,
    ir:{ values:[], blocks:[] },
    semanticAst:{ values:[{ kind:'SemanticValue', valueId:99, expression, source:expression.source }], stores:[], calls:[], conditions, inputs:[], outputs:[{ name:'return', expression }] },
    cAst:{ kind:'CProgram', body, source:sourceOf() },
    metrics:{ rawAssemblyFallbacks:0, gotos:condition ? 1 : 0, temporaries:condition ? 1 : 0, redundantCasts:3, structured:true },
  };
}

export function analysis(induction = null) {
  return {
    get(key) {
      if (key !== 'induction') return null;
      return induction ?? { completeness:'complete', loops:[] };
    },
  };
}

export function inductionFact(valueId = 12) {
  return {
    completeness:'complete',
    loops:[{
      header:1,
      classification:'natural',
      inductions:[{ valueId, step:1n, stepReason:null, origin:{ instructionIds:['insn-12'] } }],
    }],
  };
}
