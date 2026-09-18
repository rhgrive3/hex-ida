import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { canonicalLoad } from '../helpers/canonical-load-fixture.mjs';
import { renderValue, decompileSemantic, readSemanticStatementLineHistory, readSemanticStoreLineHistory } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis } from './fixture.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { buildIR } from '../../../js/ir-core.js';
import { BRANCH, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

// A test-first denominator for the INITIAL string renderer. Later expression
// builder records do not prove these choices. These assertions freeze display
// selection, not equivalence, producer-history completeness or compiler truth.
const MATRIX = [
  ['precomputed-integer', null, '7'], ['precomputed-float', null, '1.5f'],
  ['argument', null, 'a1'], ['const-definition', 'CONST', '9'],
  ['mov-operand', 'MOV', 'a1'], ['binary', 'BIN', 'a1 + a2'],
  ['unary', 'UN', '-a1'], ['multiply-accumulate', 'MAC', 'a1 + a2 * a1'],
  ['bit-extract', 'BFX', 'bit_extract(a1, 2, 5)'],
  ['bit-insert', 'BFI', 'bit_insert(a1, a2, 2, 5)'],
  ['memory-load', 'LOAD', 'var_10'],
  ['select-max', 'SEL', 'max(a1, a2)'], ['select-min', 'SEL', 'min(a1, a2)'],
  ['select-conditional', 'SEL', '(condition_gt ? a1 : a2)'],
  ['address-global', 'ADDR', '&global_2000'], ['address-symbol', 'ADDR', 'symbol_name'],
  ['address-string', 'ADDR', '"hello"'], ['address-unknown', 'ADDR', 'address_unknown'],
  ['call', 'CALL', 'callee()'],
  ['phi-deduplication', 'PHI', 'a1'], ['phi-multiple', 'PHI', 'phi(a1, a2)'],
  ['register-fallback', null, 'x9'],
];

function fixture(kind) {
  const f=irFixture('initial_expression_'+kind);f.block(0);
  const a=f.opaque(32), b=f.opaque(32);a.reg='x0';b.reg='x1';
  const opts={defaultCallArgs:0,deterministicTransforms:true};
  let value=a;
  if(kind==='precomputed-integer')value=f.constant(7n,32);
  else if(kind==='precomputed-float'){value=f.opaque(32);value.floatConst=1.5;}
  else if(kind==='const-definition'){value=f.constant(9n,32);value.const=null;}
  else if(kind==='mov-operand')value=f.copy(a,32);
  else if(kind==='binary')value=f.binary('add',a,b,32);
  else if(kind==='unary')value=f.unary('neg',a,32);
  else if(kind==='multiply-accumulate'){
    value=f.binary('madd',a,b,32);value.def.op='mac';value.def.args.push({value:a});
  }else if(kind==='bit-extract'){
    value=f.unary('extract',a,32);value.def.op='bfx';value.def.extra={lsb:2,width:5};
  }else if(kind==='bit-insert'){
    value=f.binary('insert',a,b,32);value.def.op='bfi';value.def.extra={lsb:2,width:5};
  }else if(kind==='memory-load'){
    value=f.load(32);value.def.loc={kind:'stack',key:'stack:16',disp:16n};
  }else if(kind.startsWith('select-')){
    const flags=f.binary('sub',a,b,32);flags.def.op='cmp';
    value=f.binary('select',a,b,32);value.def.op='sel';value.def.args.push({value:flags});
    value.def.cond=kind==='select-min'?'lt':'gt';
    if(kind==='select-conditional')flags.def.op='unknown';
  }else if(kind.startsWith('address-')){
    value=f.constant(0x2000n,64);value.def.op='addr';
    if(kind==='address-symbol')opts.symbolFor=()=> 'symbol_name';
    if(kind==='address-string')opts.stringFor=()=> 'hello';
    if(kind==='address-unknown'){value.const=null;value.def.extra={};}
  }else if(kind==='call'){
    value=f.unknown(32);value.def.op='call';value.def.extra={name:'callee'};
  }else if(kind.startsWith('phi-')){
    // Isolated phi spelling recipe, not proof of a valid two-entry CFG.
    value=f.phi([[0,a],[0,kind==='phi-multiple'?b:a]],32);
  }else if(kind==='register-fallback'){value=f.opaque(32);value.kind='unknown';value.reg='x9';}
  else if(kind!=='argument')throw Error('unregistered matrix kind');
  f.ret();const ir=f.build();
  ir.instructions=ir.blocks.flatMap(block=>[...block.phis,...block.insts]);
  ir.instructions.forEach((inst,index)=>{inst.id=9000+index;inst.row=index;inst.address=0x9000n+BigInt(index*4);});
  ir.blocks[0].startRow=0;ir.blocks[0].endRow=ir.instructions.length-1;
  ir.instructions.at(-1).args=[{value}];
  value.uses.push(ir.instructions.at(-1));
  ir.args=new Map([['x0',a],['x1',b]]);
  const model={name:'initial_expression_'+kind,instructions:ir.instructions,calls:[]};
  opts.ir=ir;
  const ctx={ir,model,opts,types:{values:new Map(),locations:new Map()},runtime:{},
    exprCache:new Map(),exprActive:new Set(),exprNodes:0,materialNames:new Map(),callCache:new Map(),unknownCallArities:0};
  return {ir,model,opts,ctx,value,a,b};
}

test('initial expression matrix pins each existing definition opcode and selected display',()=>{
  assert.equal(MATRIX.length,22);assert.equal(new Set(MATRIX.map(([kind])=>kind)).size,MATRIX.length);
  const source=fs.readFileSync(new URL('../../../js/decompiler/semantic-core.js',import.meta.url),'utf8');
  const start=source.indexOf('export function renderValue('),end=source.indexOf('\nfunction targetBlock(',start);
  assert.ok(start>=0&&end>start);
  const routes=[...new Set([...source.slice(start,end).matchAll(/d\.op === OP\.([A-Z]+)/g)].map(match=>match[1]))].sort();
  assert.deepEqual(routes,[...new Set(MATRIX.map(([,op])=>op).filter(Boolean))].sort());
  for(const [kind,,expected] of MATRIX){
    const f=fixture(kind),canonical=structuredClone([f.ir.values,f.ir.instructions]);
    assert.equal(renderValue(f.value,f.ctx),expected,kind);
    const seed=decompileSemantic(f.model,f.opts),ret=seed.lines.find(line=>/^return\b/.test(line.text));
    assert.ok(ret,kind);
    if(kind==='call')assert.equal(ret.text,`return call_${f.value.id};`);
    else assert.equal(ret.text,`return ${expected};`,kind+' actual initial line');
    assert.deepEqual([f.ir.values,f.ir.instructions],canonical,kind+' canonical values/instructions unchanged');
  }
});

test('initial binary and unary spelling variants retain their actual selected forms',()=>{
  const binary=[['add','+'],['sub','-'],['mul','*'],['smull','*'],['umull','*'],['sdiv','/'],['udiv','/'],
    ['and','&'],['or','|'],['xor','^'],['bic','& ~'],['shl','<<'],['lshr','>>'],['ashr','>>'],
    ['fadd','+'],['fsub','-'],['fmul','*'],['fdiv','/']];
  assert.equal(binary.length,18);
  for(const [sub,operator] of binary){const f=fixture('binary');f.value.def.sub=sub;assert.equal(renderValue(f.value,f.ctx),`a1 ${operator} a2`,sub);}
  for(const [sub,expected] of [['ror','ror(a1, a2)'],['unsupported','unknown_unsupported(a1, a2)']]){
    const f=fixture('binary');f.value.def.sub=sub;assert.equal(renderValue(f.value,f.ctx),expected,sub);
  }
  const unary=[['neg','-a1'],['fneg','-a1'],['not','~a1'],['abs','abs(a1)'],['fabs','abs(a1)'],
    ['sqrt','sqrt(a1)'],['fsqrt','sqrt(a1)'],['sxt32','(int32)a1'],['uxt32','(uint32)a1'],['unsupported','unsupported(a1)']];
  assert.equal(unary.length,10);
  for(const [sub,expected] of unary){const f=fixture('unary');f.value.def.sub=sub;assert.equal(renderValue(f.value,f.ctx),expected,sub);}
});

test('initial multiply and bitfield variants preserve existing signedness and extraction spellings',()=>{
  const mac=[['madd',null,'a1 + a2 * a1'],['msub',null,'a1 - a2 * a1'],
    ['madd','signed','a1 + ((int64_t)(int32_t)a2) * ((int64_t)(int32_t)a1)'],
    ['msub','unsigned','a1 - ((uint64_t)(uint32_t)a2) * ((uint64_t)(uint32_t)a1)']];
  for(const [sub,widen,expected] of mac){
    const f=fixture('multiply-accumulate');f.value.def.sub=sub;f.value.def.extra.widen=widen;
    assert.equal(renderValue(f.value,f.ctx),expected,sub+'/'+widen);
  }
  for(const [signed,toward,name] of [[false,null,'bit_extract'],[true,null,'__arm64_sbfx'],[false,'left','__arm64_ubfiz'],[true,'left','__arm64_sbfiz']]){
    const f=fixture('bit-extract');Object.assign(f.value.def.extra,{signed,toward});
    assert.equal(renderValue(f.value,f.ctx),`${name}(a1, 2, 5)`);
  }
  const f=fixture('bit-insert');f.value.def.extra.bitfieldKind='bfxil';
  assert.equal(renderValue(f.value,f.ctx),'bit_insert(a1, bit_extract(a2, 2, 5), 0, 5)');
});

test('initial min/max choices cover all actual condition and operand-order arms',()=>{
  let cells=0;
  for(const [cond,normal,reversed] of [['gt','max','min'],['hi','max','min'],['lt','min','max'],['lo','min','max']]){
    for(const reverse of [false,true]){
      const f=fixture('select-max');f.value.def.cond=cond;
      if(reverse)[f.value.def.args[0],f.value.def.args[1]]=[f.value.def.args[1],f.value.def.args[0]];
      assert.equal(renderValue(f.value,f.ctx),`${reverse?reversed:normal}(a1, a2)`);cells++;
    }
  }
  assert.equal(cells,8);
});

test('initial floating display handles nonfinite, negative-zero and width variants',()=>{
  const cells=[[NaN,32,'NAN'],[Infinity,64,'INFINITY'],[-Infinity,64,'-INFINITY'],[-0,32,'-0.0f'],[2,64,'2.0']];
  assert.equal(cells.length,5);
  for(const [value,bits,expected] of cells){const f=fixture('precomputed-float');f.value.floatConst=value;f.value.bits=bits;
    assert.equal(renderValue(f.value,f.ctx),expected);}
});

test('initial memo reuse and materialized references preserve actual callback and work counts',()=>{
  const f=fixture('address-symbol');let calls=0;f.opts.symbolFor=()=>{calls++;return 'stable_symbol';};
  assert.equal(renderValue(f.value,f.ctx),'stable_symbol');assert.equal(calls,2);
  const work=f.ctx.exprNodes;
  assert.equal(renderValue(f.value,f.ctx),'stable_symbol');assert.equal(calls,2);assert.equal(f.ctx.exprNodes,work);
  f.ctx.materialNames.set(f.value.id,'materialized');
  assert.equal(renderValue(f.value,f.ctx),'materialized');assert.equal(calls,2);assert.equal(f.ctx.exprNodes,work);
  assert.equal(renderValue(f.value,f.ctx,{ignoreMaterial:true}),'stable_symbol');assert.equal(calls,2);
  assert.equal(renderValue(f.value,f.ctx,{ignoreMaterial:true,asBase:true}),'stable_symbol');assert.equal(calls,4);
});

test('initial exact load forwarding uses the existing canonical producer at four widths and respects noMemoryFold',()=>{
  for(const bits of [8,16,32,64])for(const noMemoryFold of [false,true]){
    const m=canonicalLoad(bits),f=fixture('memory-load');
    // Same cache-removal fixture as the existing lower expression-builder test:
    // the canonical MemorySSA fact and its independent context stay untouched.
    m.load.dst.const=null;f.ctx.ir=m.ir;f.ctx.model={instructions:m.ir.instructions,calls:[]};
    assert.equal(renderValue(m.load.dst,f.ctx,{noMemoryFold}),noMemoryFold?'global_4000':'37');
  }
  const m=canonicalLoad(),f=fixture('memory-load');m.load.dst.const=null;
  f.ctx.ir=m.ir;f.ctx.model={instructions:m.ir.instructions,calls:[]};
  m.load.memoryForwarding={...m.load.memoryForwarding};
  assert.equal(renderValue(m.load.dst,f.ctx),'global_4000','copied exact fact is not authority');
});

test('initial null, cycle and exhausted-node paths do not reevaluate expression callbacks',()=>{
  const f=fixture('address-symbol');let calls=0;f.opts.symbolFor=()=>{calls++;return 'unreached';};
  assert.equal(renderValue(null,f.ctx),'unknown');assert.equal(f.ctx.exprNodes,0);
  f.ctx.exprActive.add(f.value.id);
  assert.equal(renderValue(f.value,f.ctx),`v${f.value.id}`);assert.equal(f.ctx.exprNodes,0);assert.equal(calls,0);
  f.ctx.exprActive.clear();f.ctx.exprNodes=513;
  assert.equal(renderValue(f.value,f.ctx),`v${f.value.id}`);assert.equal(f.ctx.exprNodes,514);assert.equal(calls,0);
  assert.equal(f.ctx.exprCache.size,0);
});

test('initial string selection uses exact row/address evidence for numeric constants',()=>{
  for(const [rowDelta,addressDelta,expected] of [[0,0n,'"literal"'],[1,0n,'7'],[0,1n,'7']]){
    const f=fixture('precomputed-integer');
    f.model.addressRefs=[{row:f.value.def.row+rowDelta,addr:f.value.const+addressDelta,text:'literal'}];
    let callbacks=0;f.opts.stringFor=()=>{callbacks++;return 'not-address-evidence';};
    assert.equal(renderValue(f.value,f.ctx),expected);assert.equal(callbacks,0);
  }
});

test('normal decoded initial expressions retain their existing output before later expression rewriting',()=>{
  for(const [instructions,expected] of [
    [['add w0, w0, w1','ret'],'return a1 + a2;'],
    [['neg w0, w0','ret'],'return 0 - a1;'],
    [['mov w0, #7','ret'],'return 7;'],
  ]){
    const rows=instructions.map((text,row)=>{const split=text.indexOf(' ');return{row,address:0x100000000n+BigInt(row*4),
      mn:split<0?text:text.slice(0,split),ops:split<0?'':text.slice(split+1)};});
    const rowOfAddress=address=>rows.find(row=>row.address===BigInt(address))?.row??null;
    const model=buildSemanticModel(rows,{rowOfAddress,startRow:0,endRow:rows.length-1});
    const ir=buildIR(model,{rowOfAddress,returnType:'int32',semanticMigrationMode:'semantic-v2-compat'});
    const seed=decompileSemantic(model,{ir,rowOfAddress,deterministicTransforms:true});
    assert.ok(seed.lines.some(line=>line.text===expected),seed.pseudocode);
  }
});

test('initial-expression matrix is an exact owned path, without an unowned wildcard exemption',()=>{
  const files=['tests/phase8/helpers/canonical-load-fixture.mjs','tests/phase8/provenance/initial-expression-render-matrix.test.mjs'];
  assert.deepEqual(validateRoadmapInventory(BRANCH,'phase8',files),files);
  assert.throws(()=>validateRoadmapInventory(BRANCH,'phase8',['tests/phase8/provenance/unowned-initial-expression.test.mjs']));
});

const initialRecords = map => map.ledger.filter(record=>record.phase==='initial-expression-render');

test('each primary initial expression selection has its own actual return producer and canonical identity',()=>{
  for(const [kind] of MATRIX){
    const f=fixture(kind),seed=decompileSemantic(f.model,f.opts);
    const line=seed.lines.find(line=>/^return\b/.test(line.text)),binding=readSemanticStatementLineHistory(line,f.ir);
    assert.ok(binding,kind);assert.ok(Object.isFrozen(binding.canonical));
    const own=binding.records.filter(record=>record.phase==='initial-expression-render'&&record.valueId===f.value.id);
    assert.ok(own.length,kind);assert.ok(own.every(record=>record.evidence.kind==='observed-initial-expression-not-equivalence'));
    const map=buildRenderProvenance({result:seed,snapshotId:'initial-expression'});
    for(const record of own){
      const retained=initialRecords(map).find(item=>item.rule===record.rule&&item.valueId===record.valueId);
      assert.ok(retained,kind);assert.equal(retained.renderedBinding,'producer-bound');
      assert.deepEqual(retained.producedRefs,[`L${seed.lines.indexOf(line)}:stmt`]);
      assert.ok(retained.originHistory.consumedRefs.includes(`ssa:def:${f.value.id}`));
    }
    assert.deepEqual(validateRenderProvenance(map).reasons,[]);
  }
});

test('actual call argument selection excludes computed but unused argument render tickets',()=>{
  for(const count of [0,1]){
    const f=fixture('call');f.opts.defaultCallArgs=count;
    const seed=decompileSemantic(f.model,f.opts),call=seed.lines.find(line=>/ = callee\(/.test(line.text));
    const entry=readSemanticStatementLineHistory(call,f.ir);assert.ok(entry);
    const values=entry.records.filter(record=>record.phase==='initial-expression-render').map(record=>record.valueId);
    assert.equal(values.includes(f.a.id),count===1);assert.equal(values.includes(f.b.id),false);
  }
});

test('real memo reuse retains its original evaluated value history without issuing a fresh semantic value',()=>{
  const f=fixture('binary');f.value.def.args[1]={value:f.a};
  const seed=decompileSemantic(f.model,f.opts),line=seed.lines.find(line=>/^return/.test(line.text));
  const records=readSemanticStatementLineHistory(line,f.ir).records.filter(record=>record.phase==='initial-expression-render');
  assert.ok(records.some(record=>record.rule==='render-initial-value-memo-reuse'&&record.valueId===f.a.id));
  assert.equal(records.filter(record=>record.rule==='render-initial-value-argument'&&record.valueId===f.a.id).length,1);
  assert.ok(records.every(record=>f.ir.values.some(value=>value.id===record.valueId)));
});

test('a later actual memo consumer retains an earlier argument evaluation that was not printed by its call',()=>{
  const f=fixture('call'),ret=f.ir.instructions.at(-1);ret.args=[{value:f.a}];f.a.uses.push(ret);
  const seed=decompileSemantic(f.model,f.opts),call=seed.lines.find(line=>/callee\(/.test(line.text));
  const line=seed.lines.find(line=>/^return/.test(line.text));assert.equal(line.text,'return a1;');
  assert.equal(readSemanticStatementLineHistory(call,f.ir).records.filter(record=>record.phase==='initial-expression-render').length,0);
  const records=readSemanticStatementLineHistory(line,f.ir).records;
  for(const form of ['memo-reuse','argument'])assert.ok(records.some(record=>record.rule==='render-initial-value-'+form&&record.valueId===f.a.id),form);
  const map=buildRenderProvenance({result:seed,snapshotId:'initial-expression'});
  const original=initialRecords(map).find(record=>record.rule==='render-initial-value-argument'&&record.valueId===f.a.id);
  assert.deepEqual(original.producedRefs,[`L${seed.lines.indexOf(line)}:stmt`]);
});

test('core and public C AST return consumers preserve initial expression histories through replay',()=>{
  for(const enhance of [enhanceCore,enhancePublic])for(const kind of ['binary','mov-operand','select-max','phi-deduplication','address-global']){
    const f=fixture(kind),seed=decompileSemantic(f.model,f.opts),initial=buildRenderProvenance({result:seed,snapshotId:'initial-expression'});
    const wanted=initialRecords(initial).map(record=>[record.rule,record.valueId]);
    let result=applyPhase8Projection(enhance(seed,f.model,f.opts),analysis());
    for(const [rule,valueId] of wanted){
      const record=initialRecords(result.renderProvenance).find(record=>record.rule===rule&&record.valueId===valueId);
      assert.ok(record,kind+'/'+rule);assert.equal(record.renderedBinding,'producer-bound',kind+'/'+rule);
    }
    const ledger=result.renderProvenance.ledger;
    result=applyPhase8Projection(result,analysis());assert.deepEqual(result.renderProvenance.ledger,ledger);
  }
});

test('changed initial inputs, copied lines and forged public validators cannot renew expression history',()=>{
  for(const mutate of [f=>{f.value.def.sub='sub';},f=>{f.ir.values=[...f.ir.values];},f=>{f.a.reg='x6';}]){
    const f=fixture('binary'),seed=decompileSemantic(f.model,f.opts),line=seed.lines.find(line=>/^return/.test(line.text));
    const entry=readSemanticStatementLineHistory(line,f.ir);assert.ok(entry);
    assert.throws(()=>{entry.canonical.isCurrent=()=>true;},TypeError);
    assert.equal(readSemanticStatementLineHistory({...line},f.ir),null);
    mutate(f);assert.equal(readSemanticStatementLineHistory(line,f.ir),null);
    const map=buildRenderProvenance({result:seed,snapshotId:'initial-expression'});
    assert.ok(initialRecords(map).every(record=>record.producedRefs.length===0));
  }
});

test('a real resolver mutation cannot bind an initial expression to a later canonical preimage',()=>{
  const f=fixture('address-symbol');f.opts.symbolFor=()=>{f.a.reg='x6';return 'symbol_name';};
  const seed=decompileSemantic(f.model,f.opts),line=seed.lines.find(line=>/^return/.test(line.text));
  assert.equal(line.text,'return symbol_name;');assert.equal(readSemanticStatementLineHistory(line,f.ir),null);
  assert.equal(seed.semanticStatementRenderHistory.completeness,'incomplete');
});

test('initial expression budget failure leaves the selected output and canonical inputs intact',()=>{
  const f=fixture('binary'),before=decompileSemantic(f.model,f.opts);
  const after=decompileSemantic(f.model,{...f.opts,renderProvenanceBudget:{maxTransformRecords:1}});
  assert.equal(after.pseudocode,before.pseudocode);
  assert.equal(after.semanticStatementRenderHistory.completeness,'incomplete');
  assert.ok(after.semanticStatementRenderHistory.reasons.includes('initial-expression-history-budget'));
});

test('ordinary assignment owners retain initial expressions without claiming a compound-store expansion',()=>{
  const f=fixture('binary'),ret=f.ir.instructions.at(-1);
  ret.op='store';ret.loc={kind:'global',key:'global:40960',address:40960n};
  const exit={id:9900,row:ret.row+1,address:ret.address+4n,block:0,op:'ret',args:[]};
  f.ir.instructions.push(exit);f.ir.blocks[0].insts.push(exit);f.ir.blocks[0].endRow=exit.row;
  const seed=decompileSemantic(f.model,f.opts),line=seed.lines.find(line=>line.row===ret.row);
  const entry=readSemanticStoreLineHistory(line,f.ir);assert.ok(entry);assert.equal(entry.spelling.form,'assignment');
  assert.ok(Object.isFrozen(entry.canonical));
  assert.ok(entry.records.some(record=>record.rule==='render-initial-value-binary'));
  const result=applyPhase8Projection(enhancePublic(seed,f.model,f.opts),analysis());
  assert.ok(initialRecords(result.renderProvenance).some(record=>record.rule==='render-initial-value-binary'&&record.producedRefs.length));
  assert.equal(result.renderProvenance.ledger.filter(record=>record.rule==='expand-initial-store-spelling').length,0);
});
