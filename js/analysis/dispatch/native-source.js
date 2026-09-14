/** Bounded views of the existing platform reader and exact loader symbol index.
 * File bytes and loader declarations are evidence, never runtime pointer truth.
 */
import { SYM_STUB, SYM_POINTER } from '../../symbols.js';
import { createEntityId, deepFreeze } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { recordFields, exactInteger, exactString, unsignedAddress, contractFail } from '../../core/identity/structured.js';
import { assertCanonicalQueryProjection } from '../query/semantic/projection.js';
import { awaitCancellableProducer } from '../../cache/artifact-orchestration.js';

export const NATIVE_DISPATCH_SOURCE_VERSION = '1.0.0';
export function createNativeDispatchMemoryReader({ backend, symbols, regions, binaryId, sliceId, snapshotId, isCurrent } = {}) {
  if (typeof backend?.readAt !== 'function' || typeof isCurrent !== 'function') contractFail('native-dispatch-source-host');
  exactString(binaryId, 'native-dispatch-source-binary'); exactString(sliceId, 'native-dispatch-source-slice');
  exactString(snapshotId, 'native-dispatch-source-snapshot');
  if (!Array.isArray(regions) || regions.length > 16384) contractFail('native-dispatch-source-region-budget');
  const regionFields = ['id', 'vmAddr', 'size', 'declaredSize', 'fileOffset', 'exec', 'write', 'zerofill'];
  const capturedRegions = regions.map(region => Object.freeze(Object.fromEntries(regionFields.map(key => [key, region[key]]))));
  const current = work => {
    if (isCurrent() !== true || regions.length !== capturedRegions.length) contractFail('native-dispatch-source-stale');
    for (let i = 0; i < capturedRegions.length; i++) {
      work.charge('workUnits');
      if (regionFields.some(key => !Object.is(regions[i]?.[key], capturedRegions[i][key]))) contractFail('native-dispatch-source-mapping-changed');
    }
  };
  return async (request, { world, assumptions, projection, work } = {}) => {
    assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
    assertCanonicalQueryProjection(projection);
    recordFields(request, ['address', 'length'], 'native-dispatch-source-fields');
    const address = unsignedAddress(request.address), length = exactInteger(request.length, 'native-dispatch-source-length', { min: 1, max: 4096 });
    const input = projection?.inputIdentity;
    if (!worldContains(world, binaryId, sliceId) || input?.binaryId !== binaryId || input.snapshotId !== snapshotId
      || input.worldId !== world.id || input.assumptionsId !== assumptions.id || input.sourceLocation?.sliceId !== sliceId) {
      contractFail('native-dispatch-source-scope');
    }
    current(work); work.checkpoint();
    const start = BigInt(address), end = start + BigInt(length);
    if (end > (1n << 64n)) contractFail('native-dispatch-source-address-wrap');
    const mappings = [];
    for (const region of capturedRegions) {
      work.charge('workUnits');
      if (region.id === 'raw' || region.vmAddr == null || region.size == null) continue;
      const fileSize = BigInt(region.size), declaredSize = BigInt(region.declaredSize ?? fileSize);
      const lo = BigInt(region.vmAddr), hi = lo + (fileSize > declaredSize ? fileSize : declaredSize);
      // A second mapping overlapping even one requested byte makes the source
      // ambiguous. A containing mapping must not hide a partial overlap.
      if (start < hi && lo < end) mappings.push(region);
    }
    const common = { schema: 'native-dispatch-source/v1', version: NATIVE_DISPATCH_SOURCE_VERSION,
      worldId: world.id, assumptionsId: assumptions.id, snapshotId, binaryId, sliceId, address, length,
      generation: world.generation, runtimeContentsProven: false, exact: false };
    if (mappings.length !== 1) return { ...common, status: 'unsupported', reason: mappings.length ? 'dispatch-source-mapping-ambiguous' : 'dispatch-source-not-mapped' };
    const region = mappings[0], mappedStart = BigInt(region.vmAddr), mappedEnd = mappedStart + BigInt(region.size);
    if (region.zerofill || start < mappedStart || end > mappedEnd || region.fileOffset == null) {
      return { ...common, status: 'unsupported', reason: 'dispatch-source-file-mapping-unbound' };
    }
    const expectedFileOffset = BigInt(unsignedAddress(region.fileOffset)) + start - mappedStart;
    if (expectedFileOffset + BigInt(length) > (1n << 64n)) contractFail('native-dispatch-source-file-offset-wrap');
    work.charge('bytesRead', length); work.charge('residentBytes', length * 2 + 1024);
    const result = await work.await(signal => awaitCancellableProducer(backend.readAt(start, length, false), signal));
    current(work); work.checkpoint();
    if (result?.found !== true || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== length || result.fileOffset == null) {
      return { ...common, status: 'partial', reason: 'dispatch-source-short-or-unbound-read' };
    }
    const fileOffset = unsignedAddress(result.fileOffset);
    if (BigInt(fileOffset) !== expectedFileOffset) contractFail('native-dispatch-source-file-offset-mismatch');
    const symbol = typeof symbols?.exact === 'function' ? symbols.exact(start) : null;
    const importDeclaration = symbol && [SYM_STUB, SYM_POINTER].includes(symbol.kind) && typeof symbol.name === 'string' && symbol.name.length > 0 && symbol.name.length <= 4096
      ? { name: symbol.name, kind: symbol.kind === SYM_STUB ? 'stub' : 'pointer', address,
        owner: 'platform-loader-symbol-index', resolver: 'unknown', weak: 'unknown', interposition: 'possible' } : null;
    const body = { ...common, status: 'completed', fileOffset, bytes: [...result.bytes], importDeclaration,
      mapping: { id: String(region.id), executable: region.exec === true,
        writable: typeof region.write === 'boolean' ? region.write : null },
      authority: 'current-file-bytes-and-loader-declarations; not-runtime-content-or-function-boundary-proof' };
    current(work);
    return deepFreeze({ ...body, id: createEntityId({ binaryId, kind: body.schema, identity: body }) });
  };
}
