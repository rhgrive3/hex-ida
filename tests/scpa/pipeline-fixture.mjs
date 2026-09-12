// Known A64 words, decoded by the existing model owner and lifted by the real
// canonical pipeline. This is not a new ISA oracle or a fabricated SSA graph.
import { makeInstruction } from '../../js/blocks.js';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';
export const rows = [
  { mn: 'mov', ops: 'x0, #1', word: 0xd2800020 },
  { mn: 'add', ops: 'x1, x0, #2', word: 0x91000801 },
  { mn: 'str', ops: 'x1, [sp]', word: 0xf90003e1 },
  { mn: 'ldr', ops: 'x2, [sp]', word: 0xf94003e2 },
  { mn: 'ret', ops: '', word: 0xd65f03c0 },
];
export function pipelineResult({ binaryId = 'binary-scpa-test', sliceId = 'slice-arm64', snapshotId = 'snap', base = 0x1000n } = {}) {
  const instructions = rows.map((r, row) => ({ ...makeInstruction({ ...r, row, address: base + BigInt(row * 4) }), size: 4, opStr: r.ops,
    origin: { byteRanges: [{ binaryId, start: BigInt(row * 4), length: 4 }], virtualRanges: [{ sliceId, start: base + BigInt(row * 4), length: 4 }] } }));
  return analyzeSemanticFunction({ binaryId, sliceId, snapshotId, architecture: 'arm64', platform: 'unknown', abiId: 'aapcs64',
    decoderSemanticVersion: 'legacy-model-decoder-v1', instructions, dataEndianness: 'little', instructionEndianness: 'little' }, { canonicalProjectionOnly: true });
}
