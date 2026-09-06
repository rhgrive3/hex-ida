import assert from 'node:assert/strict';

import { abiPhysicalIntervalsValid, normalizeAbiPieces } from '../../../js/targets/abi/evidence.js';
import { classifySysVAMD64Arguments } from '../../../js/targets/abi/sysv-amd64.js';

function registerAggregate(classes, registers, { bits = classes.length * 64, byteOffsets = null } = {}) {
  const pieces = classes.map((abiClass, pieceIndex) => ({
    index:pieceIndex,
    pieceIndex,
    order:pieceIndex,
    abiClass,
    reg:registers[pieceIndex],
    bits:64,
    bytes:8,
    byteOffset:byteOffsets?.[pieceIndex] ?? pieceIndex * 8,
  }));
  return {
    aggregate:true,
    location:'registers',
    regs:[...new Set(registers)],
    bits,
    bytes:classes.length * 8,
    eightbyteClasses:classes,
    pieces,
  };
}

const canonical = registerAggregate(['SSE','SSEUP'], ['xmm0','xmm0']);
const normalized = normalizeAbiPieces(canonical, canonical.pieces);
assert.ok(normalized, 'canonical SSE/SSEUP lanes may share one XMM register');
assert.deepEqual(normalized.map((piece) => piece.reg), ['xmm0','xmm0']);
assert.equal(abiPhysicalIntervalsValid({ arguments:[canonical], stackArguments:[] }), true);

const independentSse = registerAggregate(['SSE','SSE'], ['xmm0','xmm1']);
assert.ok(normalizeAbiPieces(independentSse, independentSse.pieces));

const duplicateSse = registerAggregate(['SSE','SSE'], ['xmm0','xmm0']);
assert.equal(normalizeAbiPieces(duplicateSse, duplicateSse.pieces), null,
  'independent SSE pieces must not reuse one register');

const duplicateInteger = registerAggregate(['INTEGER','INTEGER'], ['rax','rax']);
assert.equal(normalizeAbiPieces(duplicateInteger, duplicateInteger.pieces), null,
  'independent INTEGER pieces must not reuse one register');

const leadingSseup = registerAggregate(['SSEUP','SSEUP'], ['xmm0','xmm0']);
assert.equal(normalizeAbiPieces(leadingSseup, leadingSseup.pieces), null,
  'SSEUP cannot start a register lane chain');

const wrongSseupRegister = registerAggregate(['SSE','SSEUP'], ['xmm0','xmm1']);
assert.equal(normalizeAbiPieces(wrongSseupRegister, wrongSseupRegister.pieces), null,
  'SSEUP must continue the immediately preceding SSE register');

const interruptedSseup = registerAggregate(['SSE','INTEGER','SSEUP'], ['xmm0','rax','xmm0']);
assert.equal(normalizeAbiPieces(interruptedSseup, interruptedSseup.pieces), null,
  'SSEUP cannot resume a non-contiguous register lane chain');

const overlappingRanges = registerAggregate(['SSE','SSEUP'], ['xmm0','xmm0'], { byteOffsets:[0, 4] });
assert.equal(normalizeAbiPieces(overlappingRanges, overlappingRanges.pieces), null,
  'SSEUP sharing does not weaken logical byte-range overlap checks');

const classified = classifySysVAMD64Arguments({
  callPrototype:{
    parameters:[{
      aggregate:true,
      bits:128,
      eightbyteClasses:['SSE','SSEUP'],
    }],
  },
});
assert.equal(classified.partial, false);
assert.equal(classified.arguments.length, 1);
assert.deepEqual(classified.arguments[0].regs, ['xmm0']);
assert.deepEqual(classified.arguments[0].pieces.map((piece) => [piece.abiClass, piece.reg]), [
  ['SSE','xmm0'],
  ['SSEUP','xmm0'],
]);
assert.ok(normalizeAbiPieces(classified.arguments[0], classified.arguments[0].pieces),
  'production SysV SSE/SSEUP placement must satisfy shared aggregate proof');
assert.equal(abiPhysicalIntervalsValid(classified), true,
  'production SysV SSE/SSEUP result must satisfy the publication-boundary validator');

console.log('issue-5625 SysV SSEUP shared-register proof: ok');
