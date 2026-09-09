import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation as enhanceCore, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis } from './fixture.js';

const rule = 'reconstruct-flag-condition';
const records = result => result.renderProvenance.ledger.filter(record => record.rule === rule);

function fixture({ bits = 32, sub = 'sub', cond = 'eq', conditional = false, select = false,
  unknown = false, direct = false, secondBranch = false, field = false, publicPipeline = false, options = {} } = {}) {
  const values = [], instructions = [];
  const value = (kind = 'def', width = bits) => {
    const v = { id:values.length + 1, kind, bits:width, reg:`x${values.length + 1}`, const:null, def:null, uses:[] };
    values.push(v); return v;
  };
  const instruction = (op, dst, args, extra = {}) => {
    const row = instructions.length;
    const inst = { id:100 + row, row, address:0x5000n + BigInt(row * 4), block:0, op, dst,
      args:args.map(value => ({ value })), ...extra };
    if (dst) dst.def = inst;
    for (const v of args) v.uses.push(inst);
    instructions.push(inst); return inst;
  };
  const left = value('arg'), right = value('arg'), moved = value();
  const mov = field ? instruction('load', moved, [], { loc:{ kind:'field', key:'field:16', base:left, disp:16n, size:bits / 8 } })
    : instruction('mov', moved, [left]);
  let previous = null, previousCmp = null;
  if (conditional) {
    previous = value('def', 1);
    previousCmp = instruction('cmp', previous, [right, left], { sub:'add', bits });
  }
  const flags = value(unknown ? 'arg' : 'def', 1);
  const cmp = unknown ? null : instruction('cmp', flags, [moved, right, ...(previous ? [previous] : [])],
    { sub, bits, extra:conditional ? { conditional:true, cond:'ne', fallbackNzcv:0 } : {} });
  let target = left, branch = null, branch2 = null;
  if (select) {
    target = value();
    instruction('sel', target, [left, right, flags], { sub:'sel', cond });
  } else {
    branch = instruction('cbr', null, [direct ? moved : flags], { cond, extra:direct ? { kind:'cbnz' } : {} });
    if (secondBranch) branch2 = instruction('cbr', null, [flags], { cond:'ne', extra:{} });
  }
  const ret = instruction('ret', null, [target]);
  const blocks = [{ index:0, startRow:0, endRow:ret.row, succ:[], insts:instructions, phis:[] }];
  const ir = { values, instructions, blocks, args:new Map([['x1', left], ['x2', right]]) };
  const canonical = structuredClone(ir);
  const lines = [branch, branch2, ret].filter(Boolean).map(inst => ({ kind:inst.op === 'cbr' ? 'ctrl' : 'stmt', indent:1,
    text:inst.op === 'cbr' ? 'if (old) goto loc_taken;' : 'return old;', row:inst.row, addr:inst.address }));
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() }, lines,
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = (publicPipeline ? enhancePublic : enhanceCore)(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  return { ir, canonical, result, left, right, moved, mov, flags, cmp, previousCmp, branch, branch2, target };
}

function projected(f) { return applyPhase8Projection(f.result, analysis()); }
function unchanged(f) { assert.deepEqual(f.ir, f.canonical); }

test('flag reconstruction retains CMP and visited operand history across producers, conditions and widths', () => {
  let cells = 0;
  for (const bits of [8, 16, 32, 64]) for (const sub of ['sub', 'add', 'and', 'fsub']) {
    for (const cond of ['eq', 'ne', 'hs', 'cs', 'lo', 'cc', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv']) {
      const f = fixture({ bits, sub, cond }), result = projected(f), history = records(result);
      assert.equal(history.length, 1, `${bits}/${sub}/${cond}`);
      const [record] = history;
      assert.equal(record.before, `cmp:${sub}:${cond}`);
      assert.equal(record.proof, 'observed-flag-reconstruction-not-equivalence');
      assert.equal(record.renderedBinding, 'producer-bound');
      assert.deepEqual(record.producedRefs, ['L0:ctrl']);
      assert.equal(record.valueId, null, 'the condition does not invent an SSA result');
      for (const inst of [f.cmp, f.mov]) {
        assert.ok(record.originHistory.consumedRefs.includes(`ir:${inst.id}`));
        assert.ok(result.renderProvenance.reverse[`addr:${inst.address}`].includes('L0:ctrl'));
      }
      assert.ok(result.renderProvenance.ledger.some(record => record.rule === 'select-mov-operand' && record.producedRefs.includes('L0:ctrl')));
      assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
      assert.deepEqual(result.renderProvenance.entities['L1:stmt'].recordRefs, [], 'shared operand return did not consume this condition');
      unchanged(f); cells++;
    }
  }
  assert.equal(cells, 288, 'source coverage cells, not equivalence proofs');
});

test('conditional CMP preserves both actual comparisons through public projection and replay', () => {
  const f = fixture({ conditional:true, publicPipeline:true });
  assert.equal(f.result.semanticAst.conditions[0].expression.kind, 'select');
  let result = projected(f);
  assert.equal(records(result).length, 2);
  assert.ok(records(result).every(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:ctrl')));
  for (const inst of [f.previousCmp, f.cmp]) assert.ok(result.renderProvenance.reverse[`addr:${inst.address}`].includes('L0:ctrl'));
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  unchanged(f);
});

test('select-value construction carries the actual flag event through its existing value consumer', () => {
  const f = fixture({ select:true, conditional:true }), result = projected(f);
  const history = records(result);
  assert.equal(history.length, 2);
  assert.ok(history.every(record => record.valueId === f.target.id && record.renderedBinding === 'producer-bound'
    && record.producedRefs.includes('L0:stmt')));
  assert.ok(result.renderProvenance.reverse[`addr:${f.previousCmp.address}`].includes('L0:stmt'));
  unchanged(f);
});

test('two branches on the same flag value retain distinct condition producers', () => {
  const f = fixture({ secondBranch:true }), result = projected(f);
  const history = records(result);
  assert.equal(history.length, 2);
  assert.deepEqual(history.find(record => record.before === 'cmp:sub:eq').producedRefs, ['L0:ctrl']);
  assert.deepEqual(history.find(record => record.before === 'cmp:sub:ne').producedRefs, ['L1:ctrl']);
  assert.deepEqual(result.renderProvenance.reverse[`addr:${f.cmp.address}`], ['L0:ctrl', 'L1:ctrl']);
  unchanged(f);
});

test('field rendering inside a reconstructed condition retains its existing field producer as well as CMP history', () => {
  const f = fixture({ field:true, publicPipeline:true, options:{ fieldFor:() => ({ name:'count' }) } });
  const result = projected(f);
  assert.ok(result.renderProvenance.ledger.some(record => record.rule === 'render-field-access'
    && record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:ctrl')));
  assert.equal(records(result)[0].renderedBinding, 'producer-bound');
  assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
  unchanged(f);
});

test('unknown flags and direct-value branches cannot borrow a CMP reconstruction event', () => {
  for (const options of [{ unknown:true }, { direct:true }]) {
    const f = fixture(options), result = projected(f);
    assert.deepEqual(records(result), []);
    unchanged(f);
  }
  const f = fixture({ sub:'opaque-producer', cond:'opaque-condition' }), result = projected(f);
  assert.equal(f.result.semanticAst.conditions[0].expression.kind, 'intrinsic');
  assert.equal(records(result)[0].proof, 'observed-flag-reconstruction-not-equivalence');
  unchanged(f);
});

test('changed CMP, branch, root lists and public descriptor copies cannot replay flag binding authority', () => {
  for (const mutate of [
    f => { f.cmp.sub = 'and'; },
    f => { f.previousCmp.args[0].value = f.left; },
    f => { f.branch.cond = 'ne'; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
    f => { f.result.semanticAst.conditions[0] = { ...f.result.semanticAst.conditions[0] }; },
  ]) {
    const f = fixture({ conditional:true });
    assert.ok(readExpressionHistoryConsumer(f.result.semanticAst.conditions[0], f.ir));
    mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.result.semanticAst.conditions[0], f.ir), null);
    const history = records(projected(f));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('copied public flag records lose projected authority without revoking the original private consumer', () => {
  const f = fixture();
  f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record }));
  assert.ok(readExpressionHistoryConsumer(f.result.semanticAst.conditions[0], f.ir));
  assert.ok(records(projected(f)).every(record => record.renderedBinding === 'unresolved'));
});

test('getters replacing observed branch context are refused without evaluation', () => {
  const f = fixture(), original = f.branch.cond;
  let reads = 0;
  Object.defineProperty(f.branch, 'cond', { enumerable:true, configurable:true, get:() => { reads++; return original; } });
  assert.equal(readExpressionHistoryConsumer(f.result.semanticAst.conditions[0], f.ir), null);
  assert.equal(reads, 0);
});

test('optional-pass fallback retains actual flag history while resource limits report incomplete mapping', () => {
  const baseline = fixture().result.pseudocode;
  for (const options of [
    { deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 },
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ options }), result = projected(f);
    assert.equal(f.result.pseudocode, baseline);
    if (options.deterministicTransforms === false) assert.ok(records(result).some(record => record.renderedBinding === 'producer-bound'));
    else assert.equal(result.renderProvenance.completeness, 'incomplete');
    unchanged(f);
  }
});

test('malformed or ambiguous rendered condition matches do not inherit flag history', () => {
  for (const mode of ['malformed', 'ambiguous']) {
    const f = fixture();
    if (mode === 'malformed') f.result.cAst.body[0].text = 'if (unclosed';
    else f.result.semanticAst.conditions.push({ ...f.result.semanticAst.conditions[0] });
    assert.ok(records(projected(f)).every(record => !record.producedRefs.includes('L0:ctrl')));
  }
});

test('nested conditional comparisons reserve history capacity before recursion without changing output', () => {
  const baseline = fixture({ conditional:true }).result.pseudocode;
  for (const maxTransformRecords of [1, 2, 3]) {
    const f = fixture({ conditional:true, options:{ renderProvenanceBudget:{ maxTransformRecords } } });
    const result = projected(f);
    assert.equal(f.result.pseudocode, baseline);
    // The MOV was built first and reserves one producer slot; value/branch
    // consumer copies are ledger entries, not additional producer reservations.
    assert.equal(records(result).length, Math.max(0, maxTransformRecords - 1));
    if (maxTransformRecords < 3) assert.equal(result.renderProvenance.completeness, 'incomplete');
    unchanged(f);
  }
});

test('query navigation reaches the real flag branch and refuses stale snapshots', async () => {
  const f = fixture({ conditional:true }), result = projected(f);
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'flag-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.previousCmp.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.ok(selected.transforms.some(record => record.rule === rule));
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.previousCmp.address)).reason, 'stale-query-snapshot');
});
