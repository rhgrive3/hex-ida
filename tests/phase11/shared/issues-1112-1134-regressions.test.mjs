import assert from 'node:assert/strict';
import { parseWasm } from '../../../js/managed/wasm/parser.js';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';
import { buildMinimalDex } from '../dex/dex-parser.test.mjs';
import { buildMinimalJvmClass } from '../jvm/jvm-parser.test.mjs';
import { buildMinimalCil } from '../cil/cil-parser.test.mjs';

console.log('[phase11] running issues #1112-#1134 regression tests...');

const wasm = (...sections) => Uint8Array.from([0x00,0x61,0x73,0x6d,0x01,0,0,0,...sections.flat()]);
const section = (id, payload) => [id, payload.length, ...payload];
const typePayload = (params=[], results=[]) => [0x01,0x60,params.length,...params,results.length,...results];
const uleb = (value) => { const out=[]; do { let b=value&0x7f; value >>>= 7; if(value)b|=0x80; out.push(b); } while(value); return out; };
const singleFuncModule = (instructions, {params=[], results=[]}={}) => wasm(
  section(1,typePayload(params,results)),
  section(3,[0x01,0x00]),
  section(10,[0x01,...uleb(1+instructions.length),0x00,...instructions]),
);

// #1112: import kind is mandatory and descriptor kind must be supported.
assert.throws(()=>parseWasm(wasm(section(2,[0x01,0x00,0x00]))), /wasm-truncated-import-kind/);
assert.throws(()=>parseWasm(wasm(section(2,[0x01,0x00,0x00,0x04]))), /wasm-invalid-import-kind/);

// #1113: every function expression must finish with the outer end.
assert.throws(()=>parseWasm(singleFuncModule([])), /wasm-function-missing-end/);

// #1114: magic-only/zeroed DEX headers are not valid DEX images.
const zeroDex = new Uint8Array(0x70); zeroDex.set([0x64,0x65,0x78,0x0a,0x30,0x33,0x35,0]);
assert.throws(()=>parseDex(zeroDex), /dex-file-size-mismatch|dex-invalid-header-size|dex-invalid-endian-tag/);

// #1115: mandatory DEX table references never fall back to empty/default metadata.
const badDex = buildMinimalDex(); new DataView(badDex.buffer).setUint32(0xa4,0xffff,true);
assert.throws(()=>parseDex(badDex), /dex-invalid-method-name-index/);

// #1118: mandatory JVM CP references are typed and bounds checked.
const badJvm = buildMinimalJvmClass(); new DataView(badJvm.buffer).setUint16(0x1a,0,false);
assert.throws(()=>parseJvm(badJvm), /jvm-invalid-this-class/);

// #1119: unreachable lexical blocks cannot leak stack values into reachable CFG state.
const leakMethod = createManagedMethodId('regression','stack-leak');
const leakFn = createVMEffectFunction({methodId:leakMethod,frontendId:'wasm',bundles:[
  createVMEffectBundle({frontendId:'wasm',methodId:leakMethod,operationId:createVMOperationId(leakMethod,0),bytecodeOffset:0,mnemonic:'i32.const',producedValues:[{bits:32,constant:1}],controlEffects:[{kind:'branch',targetOffset:3}],completeness:'exact'}),
  createVMEffectBundle({frontendId:'wasm',methodId:leakMethod,operationId:createVMOperationId(leakMethod,2),bytecodeOffset:2,mnemonic:'i32.const',producedValues:[{bits:32,constant:99}],completeness:'exact'}),
  createVMEffectBundle({frontendId:'wasm',methodId:leakMethod,operationId:createVMOperationId(leakMethod,3),bytecodeOffset:3,mnemonic:'drop',consumedValues:[{bits:32}],completeness:'exact'}),
]});
const leakLowered = lowerVMEffectsToSemanticIr(leakFn);
const dropNode = leakLowered.semanticIr.nodes.find((n)=>n.metadata?.mnemonic==='drop');
const const99 = leakLowered.semanticIr.nodes.find((n)=>n.metadata?.mnemonic==='i32.const' && n.outputs.some((id)=>leakLowered.semanticIr.values.find((v)=>v.id===id)?.metadata?.constant==='99'));
assert.ok(dropNode.inputs.length===1);
assert.ok(!const99 || !dropNode.inputs.includes(const99.outputs[0]));

// #1120: logical state reads are inputs to the read op, but only its produced VM value is pushed.
const addImage = parseWasm(singleFuncModule([0x20,0x00,0x20,0x01,0x6a,0x1a,0x0b],{params:[0x7f,0x7f]}));
const addLowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0,addImage));
const addNode = addLowered.semanticIr.nodes.find((n)=>n.metadata?.mnemonic==='i32.add');
assert.equal(addNode.inputs.length,2);
assert.notEqual(addNode.inputs[0],addNode.inputs[1]);
const getNodes = addLowered.semanticIr.nodes.filter((n)=>n.metadata?.mnemonic==='local.get');
assert.deepEqual(new Set(addNode.inputs),new Set(getNodes.flatMap((n)=>n.outputs)));

// #1121: unresolved unconditional branch terminates the block and never invents fallthrough.
const unresolvedMethod = createManagedMethodId('regression','unresolved-branch');
const unresolvedFn = createVMEffectFunction({methodId:unresolvedMethod,frontendId:'wasm',bundles:[
  createVMEffectBundle({frontendId:'wasm',methodId:unresolvedMethod,operationId:createVMOperationId(unresolvedMethod,0),bytecodeOffset:0,mnemonic:'br',controlEffects:[{kind:'branch',targetOffset:null}],completeness:'exact'}),
  createVMEffectBundle({frontendId:'wasm',methodId:unresolvedMethod,operationId:createVMOperationId(unresolvedMethod,1),bytecodeOffset:1,mnemonic:'nop',completeness:'exact'}),
]});
const unresolvedLowered = lowerVMEffectsToSemanticIr(unresolvedFn);
assert.equal(unresolvedLowered.cfg.blocks[0].successors.length,0);
assert.equal(unresolvedLowered.semanticIr.completeness,'partial');

// #1122 + #1128: structured branch/switch labels are finalized to canonical offsets.
const tableImage = parseWasm(singleFuncModule([0x02,0x40,0x41,0x00,0x0e,0x00,0x00,0x0b,0x0b]));
const tableFn = liftWasmFunction(0,tableImage);
const tableEffect = tableFn.bundles.find((b)=>b.mnemonic==='br_table').controlEffects[0];
assert.ok(Array.isArray(tableEffect.targetOffsets));
assert.equal(typeof tableEffect.defaultTargetOffset,'number');
const branchImage = parseWasm(singleFuncModule([0x02,0x40,0x0c,0x00,0x01,0x0b,0x0b]));
const branchEffect = liftWasmFunction(0,branchImage).bundles.find((b)=>b.mnemonic==='br').controlEffects[0];
assert.equal(typeof branchEffect.targetOffset,'number');

// #1123: known target identity does not prove call memory/throw effects.
const callImage = parseWasm(wasm(section(1,[0x02,0x60,0,0,0x60,0,0]),section(3,[0x02,0,1]),section(10,[0x02,0x04,0,0x10,1,0x0b,0x02,0,0x0b])));
const callLowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0,callImage));
const callNode = callLowered.semanticIr.nodes.find((n)=>n.kind==='call');
assert.equal(callNode.call.completeness,'partial');
assert.equal(callNode.call.memoryWrite.scope,'all');
assert.equal(callNode.call.mayThrow,'unknown');

// #1124: invalid operand-stack underflow fails closed.
assert.throws(()=>liftWasmFunction(0,parseWasm(singleFuncModule([0x6a,0x1a,0x0b]))), /wasm-stack-underflow/);

// #1125: direct calls consume parameters and produce results from the callee type.
const typedCall = parseWasm(wasm(section(1,[0x02,0x60,0x01,0x7f,0x60,0x01,0x7f,0x01,0x7f]),section(3,[0x02,0x00,0x01]),section(10,[0x02,0x04,0,0x41,0x07,0x0b,0x06,0,0x41,0x09,0x10,0,0x0b])));
const typedCallBundle = liftWasmFunction(1,typedCall).bundles.find((b)=>b.mnemonic==='call');
assert.equal(typedCallBundle.consumedValues.length,1);
assert.equal(typedCallBundle.producedValues.length,1);

// #1126: the declared VMEffects operation budget is enforced by every managed lifter.
const budget = {maxOperations:0,maxValues:100,maxExceptionRegions:10};
assert.throws(()=>liftWasmFunction(0,addImage,{budget}), /vm-effect-resource-limit-operations/);
const dexImage = parseDex(buildMinimalDex());
assert.throws(()=>liftDexMethod(0,dexImage,{budget}), /vm-effect-resource-limit-operations/);
const jvmImage = parseJvm(buildMinimalJvmClass());
assert.throws(()=>liftJvmMethod(0,jvmImage,{budget}), /vm-effect-resource-limit-operations/);
const cilImage = parseCil(buildMinimalCil());
assert.throws(()=>liftCilMethod(0,cilImage,{budget}), /vm-effect-resource-limit-operations/);

// #1127: drop and return are explicit stack consumers.
const dropImage = parseWasm(singleFuncModule([0x41,0x01,0x1a,0x41,0x02,0x0b],{results:[0x7f]}));
const dropFn = liftWasmFunction(0,dropImage);
assert.equal(dropFn.bundles.find((b)=>b.mnemonic==='drop').consumedValues.length,1);
assert.equal(dropFn.bundles.at(-1).controlEffects[0].kind,'return');
assert.equal(dropFn.bundles.at(-1).consumedValues.length,1);

// #1129: non-custom standard sections are unique and ordered.
assert.throws(()=>parseWasm(wasm(section(1,[0x00]),section(1,[0x00]))), /wasm-duplicate-section-1/);
assert.throws(()=>parseWasm(wasm(section(3,[0x00]),section(1,[0x00]))), /wasm-out-of-order-section-1/);

// #1130: standard memory section is preserved instead of silently discarded.
const memoryOnly = parseWasm(wasm(section(5,[0x01,0x00,0x01])));
assert.equal(memoryOnly.memories.length,1);
assert.equal(memoryOnly.memories[0].min,1);

// #1131: invalid cross-section type indexes and function/code count mismatches fail at parse boundary.
assert.throws(()=>parseWasm(wasm(section(1,typePayload([],[])),section(3,[0x01,0x01]),section(10,[0x01,0x02,0x00,0x0b]))), /wasm-invalid-function-type-index/);
assert.throws(()=>parseWasm(wasm(section(1,typePayload([],[])),section(3,[0x01,0x00]))), /wasm-function-code-count-mismatch/);

// #1132: multi-byte signed-LEB type-index blocktype is consumed as one block signature.
const syntheticTypes = Array.from({length:65},()=>({params:[],results:[]}));
const syntheticBlockModule = {moduleId:'managed-mod:test:blocktype',vmSpecEdition:'core-3.0',imports:[],functions:[0],types:syntheticTypes,tables:[],globals:[],codeBodies:[{bodyOffset:100,locals:[],bytecode:Uint8Array.from([0x02,0xc0,0x00,0x0b,0x0b])}]};
const blockFn = liftWasmFunction(0,syntheticBlockModule);
assert.equal(blockFn.bundles.length,3);
assert.equal(blockFn.bundles[0].mnemonic,'block');
assert.deepEqual(blockFn.bundles[0].origin.byteRanges,[{start:'100',end:'103'}]);

// #1133: if/else has a false target and then-arm branch to the join.
const ifImage = parseWasm(singleFuncModule([0x41,0x00,0x04,0x7f,0x41,0x01,0x05,0x41,0x02,0x0b,0x0b],{results:[0x7f]}));
const ifFn = liftWasmFunction(0,ifImage);
const ifEffect = ifFn.bundles.find((b)=>b.mnemonic==='if').controlEffects[0];
const elseEffect = ifFn.bundles.find((b)=>b.mnemonic==='else').controlEffects[0];
assert.equal(typeof ifEffect.targetOffset,'number');
assert.equal(typeof elseEffect.targetOffset,'number');
assert.notEqual(ifEffect.targetOffset,elseEffect.targetOffset);

// #1134: trapping operations retain explicit fault/trap predicates while remaining exact.
const divImage = parseWasm(singleFuncModule([0x41,0x01,0x41,0x00,0x6e,0x1a,0x0b]));
const divBundle = liftWasmFunction(0,divImage).bundles.find((b)=>b.mnemonic==='i32.div_u');
assert.ok(divBundle.possibleExceptions.some((e)=>e.kind==='integer-divide-by-zero'));
assert.equal(divBundle.completeness,'exact');
const memInstructions = [0x41,0x00,0x28,0x02,0x00,0x1a,0x0b];
const memImage = parseWasm(wasm(section(1,typePayload([],[])),section(3,[0x01,0x00]),section(5,[0x01,0x00,0x01]),section(10,[0x01,...uleb(1+memInstructions.length),0x00,...memInstructions])));
const loadBundle = liftWasmFunction(0,memImage).bundles.find((b)=>b.mnemonic==='i32.load');
assert.ok(loadBundle.possibleExceptions.some((e)=>e.kind==='linear-memory-oob'));

console.log('  ok issues #1112-#1134 regressions passed');
