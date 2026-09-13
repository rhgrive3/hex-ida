import { buildSwiftMetadataModel, buildSwiftRuntimeIndex } from '../../js/swift.js';
import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from '../../js/objc.js';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { captured } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';

/** Owned assembled little-endian records; no external executable or runtime.
 * Swift layouts: swift-6.0-RELEASE Metadata.h / GenericContext.h /
 * RemoteInspection/Records.h. Witness header uses upstream #8086 / #5341.
 */
export async function appleFixture() {
  const memory = new Uint8Array(65536), view = new DataView(memory.buffer);
  const p32 = (at, value) => view.setUint32(at, value >>> 0, true);
  const p16 = (at, value) => view.setUint16(at, value, true);
  const p64 = (at, value) => view.setBigUint64(at, BigInt(value), true);
  const relative = (at, to) => p32(at, to - at);
  const string = (at, value) => memory.set(new TextEncoder().encode(value + '\0'), at);
  const read = async (at, size) => {
    const offset = Number(at);
    return offset < 0 || offset >= memory.length ? null : memory.subarray(offset, Math.min(memory.length, offset + size));
  };
  relative(0x200, 0x1000); relative(0x204, 0x1200); relative(0x208, 0x1300);
  relative(0x210, 0x2000); relative(0x218, 0x3000);
  p32(0x1000, 17); relative(0x1008, 0x5000); string(0x5000, 'Value');
  p32(0x1200, 0x80000010); relative(0x1208, 0x5020); string(0x5020, 'Owner');
  p32(0x1230, 1); p32(0x1234, 0x10); relative(0x1238, 0x6000);
  p32(0x1300, 0x91); relative(0x1308, 0x5040); string(0x5040, 'Box');
  p16(0x1324, 1); p16(0x1326, 1); p16(0x1328, 1); memory[0x132c] = 0x80;
  p32(0x1330, 1); relative(0x1334, 0x5060); relative(0x1338, 0x5070);
  string(0x5060, 'x'); string(0x5070, 'Si');
  p32(0x2000, 3); relative(0x2008, 0x5080); string(0x5080, 'P');
  p32(0x2010, 1); p32(0x2018, 1);
  relative(0x3000, 0x2000); relative(0x3004, 0x1000); relative(0x3008, 0x4000);
  p64(0x4000, 0x3000); p64(0x4008, 0x6000);
  p32(0x5500, 1); p32(0x5504, 1); p32(0x5508, 1);
  relative(0x550c, 0x5070); relative(0x5510, 0x5060); relative(0x5514, 0x5090); string(0x5090, 'B0');
  // ObjC class_ro and the absolute method list used by the actual App parser.
  p64(0x220, 0x8000); p64(0x8020, 0x8100); p32(0x8108, 32);
  p64(0x8118, 0x8300); p64(0x8120, 0x8200); string(0x8300, 'Widget');
  p32(0x8200, 24); p32(0x8204, 1); p64(0x8208, 0x8320); p64(0x8210, 0x8340); p64(0x8218, 0x6000);
  string(0x8320, 'save:'); string(0x8340, 'v16@0:8');
  p32(0x6000, 0xd65f03c0);
  const sections = [{ section: '__swift5_types', vmAddr: 0x200n, size: 12n },
    { section: '__swift5_protos', vmAddr: 0x210n, size: 4n }, { section: '__swift5_proto', vmAddr: 0x218n, size: 4n },
    { section: '__swift5_capture', vmAddr: 0x5500n, size: 24n }];
  const swiftModel = await buildSwiftMetadataModel(read, sections, { budget: 128, resolvePointer: async raw => raw });
  const objcModel = await buildObjcRuntimeModel(read, { vmAddr: 0x220n, size: 8n },
    { architecture: 'arm64', executableRanges: [{ vmAddr: 0x6000n, size: 4n }] });
  return { memory, read, sections, p16, p32, swiftModel, swiftIndex: buildSwiftRuntimeIndex(swiftModel),
    objcModel, objcIndex: buildObjcRuntimeIndex(objcModel) };
}
export function contextFor(fixture, scope) {
  return { objcIndex: fixture.objcIndex, swiftIndex: fixture.swiftIndex,
    sourceIdentity: { binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', sourceId: 'owned-apple-fixture', generation: scope.world.generation },
    isCurrent: () => true };
}
export async function appleProjection(t, scope, target = 0x6000n, rows = null) {
  const base = 0x9000n, word = (0x94000000 | Number((target - base) / 4n) & 0x3ffffff) >>> 0;
  const input = captured(base, rows ?? [['bl', '#0x' + target.toString(16), word], ['ret', '', 0xd65f03c0]]);
  const projection = await buildCanonicalQueryProjection(input.result.pipeline, { ...scope, snapshotId: 'snap', work: workFor(t),
    producerArtifactId: 'owned-apple-call', sourceLocation: { start: base, end: base + BigInt(input.rows.length * 4), snapshotId: 'snap' } });
  t.after(() => projection.release());
  let callSiteId;
  for (let index = 0; index < projection.size; index++) {
    const record = projection.recordAt(index), source = projection.source(record.id);
    if (record.owner === 'semantic-ir' && source?.call) callSiteId = source.id;
  }
  const callee = captured(0x6000n, [['ret', '', 0xd65f03c0]]);
  const calleeProjection = await buildCanonicalQueryProjection(callee.result.pipeline, { ...scope, snapshotId: 'snap', work: workFor(t),
    producerArtifactId: 'owned-apple-imp', sourceLocation: { start: 0x6000n, end: 0x6004n, snapshotId: 'snap' } });
  t.after(() => calleeProjection.release());
  const resolveFunctionIdentity = async request => BigInt(request.address) === 0x6000n
    ? { ...request, worldId: scope.world.id, snapshotId: 'snap', entityId: calleeProjection.functionId } : null;
  return { projection, callSiteId, calleeProjection, resolveFunctionIdentity, input };
}
