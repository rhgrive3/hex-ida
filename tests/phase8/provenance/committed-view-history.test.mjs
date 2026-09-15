import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { buildMemorySsa } from '../../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { projectSemanticViews, readSemanticViewHistory, semanticViewTransitionExpected,
  semanticViewStateCandidates, readSemanticViewPredecessor } from '../../../js/decompiler/semantic-views.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, provenanceFromSourceMap } from '../../../tools/validation/phase8/decompile-corpus.mjs';
import { loadFrozenProvenance } from '../../../tools/validation/phase8/metrics.mjs';
import { readLineExpressionHistory } from '../../../js/decompiler/phase8/projection.js';

const origin = id => ({ instructionIds:[id], operationIds:[`operation:${id}`] });
const type = bits => ({ kind:'bitvector', widthBits:bits });
const entry = (id, bits) => ({ id, kind:'entry', machineType:type(bits), sourceEntityId:'views', origin:origin(id) });
const def = (id, bits) => ({ id, kind:'definition', machineType:type(bits), definitionNodeId:`n_${id}`,
  sourceEntityId:`n_${id}`, origin:origin(id) });
const node = (id, kind, blockId, inputs = [], outputs = [], extra = {}) =>
  ({ id:`n_${id}`, kind, blockId, inputs, outputs, origin:origin(id), ...extra });
const memory = bits => ({ addressSpace:'memory', addressExpr:{ valueId:'address' }, widthBits:bits,
  endian:'little', alignment:bits / 8, volatility:false, atomic:false, ordering:'unknown', faults:[] });
const copy = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function fixture(kind = 'comparison', bits = 32, barrier = false) {
  let values, nodes, edges, ssa;
  if (kind === 'return') {
    values = [entry('value', bits), def('wide', 64)];
    nodes = [node('wide', 'zext', 'entry', ['value'], ['wide'], { attributes:{ fromBits:bits, toBits:64 } }),
      node('ret', 'return', 'entry', ['wide'])];
    edges = { entry:[] };
  } else if (kind === 'comparison') {
    values = [entry('address',64), entry('value',bits), entry('other',bits), def('view',bits), def('cmp',1),
      ...(barrier ? [entry('barrierValue',bits)] : [])];
    nodes = [node('view','copy','entry',['value'],['view']),
      node('store','store','entry',['address','value'],[],{ memory:memory(bits) }),
      ...(barrier ? [node('barrier','store','entry',['address','barrierValue'],[],{ memory:memory(bits) })] : []),
      node('cmp','compare','entry',['view','other'],['cmp'],{ operator:'eq' }),
      node('ret','return','entry',['cmp'])];
    edges = { entry:[] };
  } else {
    values = [entry('address',64), entry('condition',1), entry('left',64), entry('right',64), entry('merged',64),
      def('leftView',bits), def('rightView',bits), def('narrow',bits)];
    nodes = [node('branch','conditional-branch','entry',['condition'],[],{ targets:['left','right'] }),
      ...['left','right'].flatMap(side => [
        node(`${side}View`,'trunc',side,[side],[`${side}View`],{ attributes:{ fromBits:64, toBits:bits } }),
        node(`${side}Store`,'store',side,['address',`${side}View`],[],{ memory:memory(bits) }),
        node(`${side}Branch`,'branch',side,[],[],{ targets:['merge'] }),
      ]),
      node('narrow','trunc','merge',['merged'],['narrow'],{ attributes:{ fromBits:64, toBits:bits } }),
      node('ret','return','merge',['narrow'])];
    edges = { entry:['left','right'], left:['merge'], right:['merge'], merge:[] };
    ssa = { contractVersion:'2.0.0', functionId:'views', definitions:[
      ...['left','right'].map(id => ({ definitionId:`d_${id}`, valueId:id, kind:'entry', blockId:null,
        variableKey:'state:value', sourceEntityId:'views', incoming:[], origin:origin(id) })),
      { definitionId:'d_merged', valueId:'merged', kind:'phi', blockId:'merge', variableKey:'state:value',
        sourceEntityId:null, incoming:['left','right'].map(side => ({ predecessorBlockId:side, valueId:side })), origin:origin('phi') },
    ], uses:[{ useId:'u_narrow', valueId:'merged', blockId:'merge', sourceEntityId:'n_narrow', origin:origin('narrow') }] };
  }
  const blocks = Object.keys(edges).map(id => ({ id, nodeIds:nodes.filter(node => node.blockId === id).map(node => node.id), origin:origin(id) }));
  const canonical = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId:'views',
    entryBlockId:'entry', blocks, nodes, values, completeness:'complete', unknowns:[], origin:origin('function') });
  const cfg = createSemanticCfg({ functionId:'views', entryBlockId:'entry',
    blocks:Object.entries(edges).map(([id, successors]) => ({ id,
      successors:successors.map((to, index) => ({ to,
        kind:successors.length === 2 ? index === 0 ? 'conditional-true' : 'conditional-false' : 'branch' })) })) });
  const region = createMemoryRegionRef({ id:'field', kind:'rooted-offset', functionId:'views', rootEntityId:'address',
    offset:'0', widthBits:bits, origin:origin('field') });
  const memorySsa = buildMemorySsa(canonical, cfg, { regions:[region], resolveRegion:() => region,
    // Every access in this synthetic fixture is the same declared address and
    // byte interval. The native test below supplies the real compiler corpus.
    queryAlias:() => ({ relation:'must', reasonCodes:['same-fixture-field'], evidenceIds:['fixture-field'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.1', completeness:'complete', stopReason:null } }),
    ...(ssa ? { ssa } : {}) });
  const ir = projectSemanticIrV2ToLegacyV1(canonical, { cfg, memorySsa, ...(ssa ? { ssa } : {}) });
  return { ir, options:kind === 'return' ? { returnBits:bits } : {} };
}

test('all four existing view writers retain original operations and exact live input dependencies', () => {
  const operations = new Set();
  for (const kind of ['comparison','phi','return']) for (const bits of [8,16,32]) {
    const { ir, options } = fixture(kind, bits);
    assert.equal(readSemanticViewHistory(ir), null);
    projectSemanticViews(ir, options);
    const history = readSemanticViewHistory(ir);
    assert.ok(history, `${kind}/${bits}`);
    assert.equal(history.completeness, 'complete');
    assert.equal(history.events.length, kind === 'phi' ? 2 : 1);
    for (const event of history.events) {
      operations.add(event.operation);
      assert.equal(event.stage, 'decompiler-committed-view');
      assert.ok(Object.isFrozen(event) && Object.isFrozen(event.inputs) && Object.isFrozen(event.beforeInputs));
      assert.ok(event.beforeInputs.includes(event.before));
      assert.equal(semanticViewTransitionExpected(ir, event.source), true);
      assert.ok(readSemanticViewHistory(ir, event.source));
      assert.equal(readSemanticViewHistory({ ...ir }, event.source), null);
    }
    const [event] = history.events;
    if (kind === 'phi') assert.deepEqual(history.events.map(event => [event.beforeOp,event.afterOp]), [['phi','load'],['mov','load']]);
    else assert.notEqual(event.before, event.after);
    event.before.bits++;
    assert.equal(history.isCurrent(), false);
    assert.equal(readSemanticViewHistory(ir), null);
  }
  assert.deepEqual([...operations].sort(), ['project-committed-comparison-view','project-committed-phi-snapshot',
    'project-committed-snapshot-view','project-declared-return-view']);
});

test('view selection respects real store barriers and does not issue history on copied projections', () => {
  const blocked = fixture('comparison',32,true);
  projectSemanticViews(blocked.ir);
  assert.equal(semanticViewTransitionExpected(blocked.ir), false);
  assert.equal(readSemanticViewHistory(blocked.ir), null);
  const forged = copy(fixture().ir);
  projectSemanticViews(forged);
  assert.equal(semanticViewTransitionExpected(forged), true);
  assert.equal(readSemanticViewHistory(forged), null);
});

test('caller write arrays cannot reseal views and exact CFG, store and root mutations invalidate reads', () => {
  for (const mutation of [
    ir => { ir.instructions = [...ir.instructions]; },
    ir => { ir.blocks[0].insts = [...ir.blocks[0].insts]; },
    ir => { ir.blocks[0].pred = [...ir.blocks[0].pred]; },
    ir => { ir.instructions.find(inst => inst.op === 'store').loc.size++; },
    ir => { ir.instructions.find(inst => inst.op === 'cmp').args[0] = { ...ir.instructions.find(inst => inst.op === 'cmp').args[0] }; },
  ]) {
    const { ir } = fixture(); projectSemanticViews(ir);
    const history = readSemanticViewHistory(ir); assert.ok(history);
    mutation(ir);
    assert.equal(history.isCurrent(), false);
    assert.equal(readSemanticViewHistory(ir), null);
  }
  const { ir } = fixture(); projectSemanticViews(ir);
  const history = readSemanticViewHistory(ir), arg = ir.instructions.find(inst => inst.op === 'cmp').args[0];
  assert.ok(history);
  assert.equal(history.isCurrent.matchesThroughWrites({}), false);
  assert.equal(history.isCurrent.matchesThroughWrites(new Array(10001)), false);
  const before = arg.value, after = { ...before }; arg.value = after;
  const writes = [{ object:arg, key:'value', before, after }];
  assert.equal(history.isCurrent.matchesThroughWrites(writes), true);
  assert.equal(history.isCurrent(writes), false);
  assert.equal(readSemanticViewHistory(ir), null);
  projectSemanticViews(ir);
  assert.equal(readSemanticViewHistory(ir), null, 'a repeated public call cannot recover a stale private predecessor');
});

test('repeated actual view projection carries its original private history across CFG normalization', () => {
  for (const kind of ['comparison','phi','return']) {
    const { ir, options } = fixture(kind); projectSemanticViews(ir, options);
    const original = readSemanticViewHistory(ir); assert.ok(original);
    projectSemanticViews(ir, options);
    const current = readSemanticViewHistory(ir); assert.ok(current);
    assert.equal(current.completeness, 'complete');
    assert.ok(original.events.every(event => current.events.includes(event)));
    ir.values = [...ir.values];
    assert.equal(current.isCurrent(), false);
  }
});

test('observation and repeated-handoff limits leave the real display replacement intact but never complete', () => {
  const { ir } = fixture();
  const comparison = ir.instructions.find(inst => inst.op === 'cmp'), original = comparison.args[0].value;
  let deep = {}; for (let index = 0; index < 120; index++) deep = { child:deep };
  comparison.extra.deep = deep;
  projectSemanticViews(ir);
  assert.notEqual(comparison.args[0].value, original);
  assert.equal(semanticViewTransitionExpected(ir), true);
  assert.equal(readSemanticViewHistory(ir), null);
  const repeated = fixture().ir;
  for (let index = 0; index < 35; index++) projectSemanticViews(repeated);
  assert.equal(semanticViewTransitionExpected(repeated), true);
  assert.notEqual(readSemanticViewHistory(repeated)?.completeness, 'complete');
});

test('native x86 switch retains all rendered provenance and carried constants through real comparison views', () => {
  const corpus = loadCorpus(), id = 'x86_64.quality.structure_switch.O0';
  const index = corpus.functions.findIndex(entry => entry.id === id); assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], { index,
    decompilerTimeBudgetMs:20000, toolchain:corpus.toolchain ?? null });
  assert.equal(failure ?? null, null);
  assert.equal(result.expressionHistoryBinding.completeness, 'complete');
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.deepEqual(result.renderProvenance.reasons, []);
  const history = readSemanticViewHistory(result.ir); assert.ok(history);
  assert.equal(history.events.length, 1, 'one real comparison write, retained by multiple rendered consumers');
  const records = result.renderProvenance.ledger.filter(record => record.rule === 'project-committed-comparison-view');
  assert.ok(records.length >= 2);
  assert.ok(records.every(record => record.proof === 'observed-committed-view-not-equivalence'));
  assert.ok(records.some(record => record.producedRefs.length > 0));
  assert.ok(semanticViewStateCandidates(result.ir)?.isCurrent());
  assert.ok(result.ir.instructions.some(source => readSemanticViewPredecessor(result.ir,'projectedConstant',source)));
  const reference = loadFrozenProvenance().observations.find(entry => entry.id === id);
  const actual = provenanceFromSourceMap(result.sourceMap);
  assert.deepEqual(reference.sourceAddresses.filter(address => !actual.sourceAddresses.includes(address)), []);
  const lines = result.lines.filter(line => readLineExpressionHistory(line, result.ir)?.length);
  assert.ok(lines.length > 1);
  result.ir.instructions = [...result.ir.instructions];
  assert.equal(history.isCurrent(), false);
  assert.ok(lines.every(line => readLineExpressionHistory(line, result.ir) === null));
});
