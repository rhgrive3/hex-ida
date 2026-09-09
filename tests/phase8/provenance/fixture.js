import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { expr, sourceOf } from '../../../js/decompiler/ast/nodes.js';

export { expr, sourceOf };

export function source(valueId, row = 3) {
  return sourceOf({ row, address:0x1000n + BigInt(row) * 4n, ssaDef:valueId, evidence:[{ reason:'fixture-origin' }] });
}

export function resultWith(expression, { condition = null, sourcelessLine = false } = {}) {
  const returnNode = { kind:'stmt', indent:1, text:'return old;', source:source(99, 4), semantic:{ op:'return', expression, ir:9 } };
  const body = [returnNode];
  if (sourcelessLine) body.unshift({ kind:'stmt', indent:1, text:'broken();', source:sourceOf(), semantic:{ op:'call', expression:null, ir:null } });
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

export function consumerFixture({ load = false, branch = false, bindingBudget = undefined } = {}) {
  const value = (id, kind = 'def') => ({ id, kind, reg:`x${id}`, bits:64, signed:false, uses:[], def:null, const:null });
  const input = value(1, load ? 'def' : 'arg'), zero = value(2), sum = value(3);
  zero.const = 0n;
  const instructions = [];
  const instruction = (op, dst, args, extra = {}) => {
    const row = instructions.length;
    const inst = { id:row + 10, row, address:0x1000n + BigInt(row * 4), block:0, op, dst, args:args.map(value => ({ value })), ...extra };
    if (dst) dst.def = inst;
    for (const value of args) value.uses.push(inst);
    instructions.push(inst);
    return inst;
  };
  if (load) instruction('load', input, [], { loc:{ kind:'global', key:'global:12288', address:0x3000n }, args:[] });
  instruction('const', zero, [], { extra:{ value:0n } });
  const add = instruction('bin', sum, [input, zero], { sub:'add' });
  const store = instruction('store', null, [sum], { loc:{ kind:'global', key:'global:8192', address:0x2000n } });
  const unrelated = instruction('store', null, [input], { loc:{ kind:'global', key:'global:8200', address:0x2008n } });
  const condition = branch ? instruction('cbr', null, [sum], { extra:{ kind:'cbnz' } }) : null;
  const ret = instruction('ret', null, [sum]);
  const elseRet = branch ? instruction('ret', null, [input]) : null;
  const blocks = [{ index:0, startRow:0, endRow:ret.row, succ:[], insts:instructions }];
  if (branch) {
    ret.block = 1; elseRet.block = 2;
    condition.target = elseRet.address;
    blocks[0] = { index:0, startRow:0, endRow:condition.row, succ:[1, 2], insts:instructions.slice(0, condition.row + 1) };
    blocks.push({ index:1, startRow:ret.row, endRow:ret.row, pred:[0], succ:[], insts:[ret] },
      { index:2, startRow:elseRet.row, endRow:elseRet.row, pred:[0], succ:[], insts:[elseRet] });
  }
  const ir = { values:[input, zero, sum], instructions, args:new Map(load ? [] : [['x1', input]]),
    blocks };
  const result = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[store, unrelated, condition, ret, elseRet].filter(Boolean).map(inst => ({ kind:inst.op === 'cbr' ? 'ctrl' : 'stmt', indent:1,
      text:inst.op === 'ret' ? 'return old;' : inst.op === 'cbr' ? 'if (old) goto loc_taken;' : 'old = value;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, { deterministicTransforms:true, renderProvenanceBindingBudget:bindingBudget });
  if (!enhanced.rewriteProof.some(record => record.rule === 'add-zero-right')) throw new Error('fixture did not exercise the actual RewriteEngine');
  return { enhanced, ir, input, zero, sum, add, store, unrelated, ret };
}
