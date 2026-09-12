import assert from 'node:assert/strict';
import { forEachX86BrowserSession } from './helpers/x86-browser-effects.mjs';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { X86_LONG64_DECODER_WITNESSES } from '../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs';
import { bytesFromX86Long64WitnessHex } from '../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs';
import {
  X86_LONG64_CLOSURE_MATRIX_ID,
  X86_LONG64_CLOSURE_MATRIX_SCHEMA,
  evaluateX86Long64ClosureMatrix,
  validateX86Long64ClosureMatrix,
} from '../../tools/validation/machine-effects/x86-long64-closure-matrix.mjs';

// Exercise the default production path in BOTH engines before applying the
// terminal acceptance assertions. No forged provenance, Node semantic evidence,
// closureMatrixTerminal override, witness substitution or skipped partial row.
const matrices=[];
assert.equal(X86_LONG64_DECODER_WITNESSES.length,1487);
await forEachX86BrowserSession(async ({engine,browserVersion,decodeAndLift})=>{
  const decodedRows=[];
  const observed=new WeakMap();
  for(const [id,name,hex] of X86_LONG64_DECODER_WITNESSES) {
    const bytes=bytesFromX86Long64WitnessHex(hex);
    const [{decoded:instruction,effects}]=await decodeAndLift(bytes,0x100000n+BigInt(id)*0x20n);
    assert.equal(instruction.instructionCode,id,`${engine}: exact canonical witness ID: ${name}`);
    observed.set(instruction,effects);
    decodedRows.push({id,name,hex,instruction});
  }
  // Bundle metadata.family is diagnostic, not dispatcher ownership (e.g.
  // flags, bit-manipulation and foundation). Use the existing canonical
  // dispatcher ONLY for ownership; discard its unbranded Node effect result.
  // Completeness and effects must come exclusively from the actual receiver.
  const matrix=evaluateX86Long64ClosureMatrix(decodedRows,instruction=>{
    assert.ok(observed.has(instruction),'every counted effect must be from the receiver');
    const result=observed.get(instruction);
    const {ownerId}=dispatchX86MachineEffects({...instruction,
      instructionId:result.instructionId,origin:result.origin,mode:result.mode});
    return {ownerId,result};
  });
  matrices.push({engine,matrix});
  // Bounded diagnostics only; all 1487 rows still participate in the gate.
  console.log(JSON.stringify({engine,browserVersion,matrixId:matrix.matrixId,totalWitnessCount:matrix.totalWitnessCount,
    exactTotal:matrix.exactTotal,partialCount:matrix.partialCount,unownedCount:matrix.unownedCount,
    blockingGapCount:matrix.blockingGapCount,closed:matrix.closed,byCompleteness:matrix.byCompleteness,
    byOwner:matrix.byOwner,completenessByOwner:matrix.completenessByOwner,firstBlockingGaps:matrix.blockingGaps.slice(0,12)}));
});
assert.deepEqual(matrices.map(item=>item.engine),['chromium','webkit']);
for(const {engine,matrix} of matrices) {
  assert.equal(validateX86Long64ClosureMatrix(matrix),true);
  assert.equal(matrix.schemaVersion,X86_LONG64_CLOSURE_MATRIX_SCHEMA);
  assert.equal(matrix.matrixId,X86_LONG64_CLOSURE_MATRIX_ID);
  assert.equal(matrix.totalWitnessCount,1487);
  assert.equal(matrix.unownedCount,0,'No witness may be unowned');
  assert.equal(matrix.rows.length,1487);
  assert.equal(new Set(matrix.rows.map(row=>row.id)).size,1487);

  for(const row of matrix.rows) {
    assert.ok(row.id>=1 && row.id<=1523);
    assert.ok(typeof row.name==='string' && row.name.length>0);
    assert.ok(typeof row.hex==='string' && row.hex.length>0);
    assert.ok(['control','memory','lea','integer','string','atomic','fp','simd','system'].includes(row.ownerId));
    assert.ok(['exact','exact-with-intrinsic','partial'].includes(row.completeness));
    assert.ok(Array.isArray(row.registersRead));
    assert.ok(Array.isArray(row.registersWritten));
    assert.ok(Array.isArray(row.faultKinds));
    assert.ok(typeof row.requiredFeature==='string');
  }
  assert.equal(matrix.partialCount,0,`${engine}: no valid witness may remain partial (${matrix.partialCount}/1487)`);
  assert.equal(matrix.blockingGapCount,0,`${engine}: no semantic closure gap may remain`);
  assert.equal(matrix.closed,true,`${engine}: long-64 witness matrix must be terminal`);
}
console.log('x86 long-64 1487 semantic closure matrix: PASS (Chromium and WebKit)');
