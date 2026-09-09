import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../../js/decompiler/pipeline-core.js';
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

export function proofOnlySpillFixture({ committed = true, duplicate = false } = {}) {
  const global = { kind:'global', key:'global:24576', text:'global_value', size:8 };
  const stack = { kind:'stack', key:'stack:16', text:'local_spill', size:8 };
  const stored = { id:1, bits:64, reg:'x1' }, loaded = { id:2, bits:64, reg:'x0' };
  const snapshot = { id:10, row:0, address:0x7000n, block:0, op:'load', dst:stored, loc:global,
    extra:{ committedPhiSnapshot:committed } };
  stored.def = snapshot;
  const store = { id:11, row:1, address:0x7004n, block:0, op:'store', loc:stack, args:[{ value:stored }] };
  const load = { id:12, row:2, address:0x7008n, block:0, op:'load', loc:stack, dst:loaded };
  loaded.def = load;
  const ret = { id:13, row:3, address:0x700cn, block:0, op:'ret', args:[{ value:loaded }] };
  const instructions = [snapshot, store, load, ret];
  const old = expr.load(stack, 64, { ir:load.id, row:load.row, address:load.address, ssaDef:loaded.id });
  const value = expr.load(global, 64, { ir:snapshot.id, row:snapshot.row, address:snapshot.address, ssaDef:stored.id });
  const removedNode = { kind:'stmt', indent:1, text:'local_spill = global_value;',
    source:sourceOf({ ir:store.id, row:store.row, address:store.address }), semantic:{ op:'store', ir:store.id, expression:value } };
  const unrelated = { kind:'stmt', indent:1, text:'local_other = 1;', source:sourceOf({ ir:99, row:9, address:0x7024n }) };
  const returnNode = { kind:'stmt', indent:1, text:'return local_spill;',
    source:sourceOf({ ir:ret.id, row:ret.row, address:ret.address }), semantic:{ op:'return', ir:ret.id, expression:old } };
  return { store, ret, removedNode, returnNode, result:{ semantic:true,
    ir:{ values:[stored, loaded], instructions, blocks:[{ index:0, pred:[], succ:[], insts:instructions }] },
    semanticAst:{ values:[{ valueId:stored.id, expression:value }, { valueId:loaded.id, expression:old }],
      outputs:[{ name:'return', expression:old }], conditions:[], stores:[] },
    cAst:{ body:[removedNode, ...(duplicate ? [{ ...removedNode }] : []), unrelated, returnNode] }, metrics:{} } };
}

export function suppressedSpillFixture({ matching = true, alreadyHidden = false, options = {} } = {}) {
  const stored = { id:1, bits:64, signed:false, reg:'x1', kind:'def', const:5n, uses:[] };
  const loaded = { id:2, bits:64, signed:false, reg:'x0', kind:'def', const:matching ? 5n : 6n, uses:[] };
  const constant = { id:10, row:0, address:0x5000n, block:0, op:'const', dst:stored, args:[], extra:{ value:5n } };
  stored.def = constant;
  const location = { kind:'stack', key:'stack:16', disp:16n, size:8 };
  const store = { id:11, row:1, address:0x5004n, block:0, op:'store', loc:location, args:[{ value:stored }] };
  const call = { id:12, row:2, address:0x5008n, block:0, op:'call', args:[], memKills:[] };
  const load = { id:13, row:3, address:0x500cn, block:0, op:'load', dst:loaded, loc:location, reachingStore:store };
  loaded.def = load;
  const ret = { id:14, row:4, address:0x5010n, block:0, op:'ret', args:[{ value:loaded }] };
  stored.uses.push(store); loaded.uses.push(ret);
  const instructions = [constant, store, call, load, ret];
  const ir = { values:[stored, loaded], instructions, args:new Map(),
    blocks:[{ index:0, startRow:0, endRow:4, pred:[], succ:[], insts:instructions }] };
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[store, call, ret].map(inst => ({ kind:'stmt', indent:1, row:inst.row, addr:inst.address,
      text:inst.op === 'ret' ? 'return old;' : inst.op === 'call' ? 'opaque();' : alreadyHidden ? '' : 'local_spill = value;' })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  return { store, ret, result:enhanceCore(seed, { calls:[] }, { deterministicTransforms:true, ...options }) };
}
