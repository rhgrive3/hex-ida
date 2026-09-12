import { makeInstruction } from '../../js/blocks.js';
import { analyzeSemanticFunction } from '../../js/analysis/semantic-function.js';
import { fixture } from './helpers.mjs';
const caller = [['mov', 'x0, #1', 0xd2800020], ['bl', '#0x2000', 0x940003ff], ['ret', '', 0xd65f03c0]];
const callee = [['str', 'x0, [sp]', 0xf90003e0], ['ret', '', 0xd65f03c0]];
export const scope = () => fixture(d => { d.profile.abiRevision = '2'; });
export function captured(base = 0x1000n, rows = caller, inputOptions = {}) {
  let owner;
  const instructions = rows.map(([mn, ops, word], row) => ({ ...makeInstruction({ mn, ops, word, row, address: base + BigInt(row * 4) }),
    size: 4, opStr: ops, origin: { byteRanges: [{ binaryId: 'binary-scpa-test', start: base - 0x1000n + BigInt(row * 4), length: 4 }],
      virtualRanges: [{ sliceId: 'slice-arm64', start: base + BigInt(row * 4), length: 4 }] } }));
  const result = analyzeSemanticFunction({ binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', snapshotId: 'snap',
    architecture: 'arm64', platform: 'linux', abiId: 'aapcs64', decoderSemanticVersion: 'legacy-model-decoder-v1',
    instructions, dataEndianness: 'little', instructionEndianness: 'little', ...inputOptions },
  { canonicalProjectionOnly: true, captureCanonicalOwner: value => { owner = value; } });
  return { owner, result, base, rows };
}
export const request = f => ({ kind: 'flow-inputs', ...f, worldId: f.world.id, snapshotId: 'snap' });
export { caller, callee };
