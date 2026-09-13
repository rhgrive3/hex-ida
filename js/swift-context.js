/* Fixed Swift metadata layouts, shared by the canonical Swift model builder.
 * Layout authority (pinned): swiftlang/swift, swift-6.0-RELEASE,
 * include/swift/ABI/{Metadata,GenericContext,MetadataValues}.h and
 * include/swift/RemoteInspection/Records.h. These records describe declarations;
 * they do not supply instantiated substitutions or closure object offsets.
 */
const u16 = (b, at) => b[at] | b[at + 1] << 8;
const u32 = (b, at = 0) => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;
const rel = (at, raw) => raw ? at + BigInt(raw | 0) : null;
const bounded = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 256) : 128;
async function bytes(read, at, length, signal) {
  if (signal?.aborted) throw signal.reason;
  if (at < 0n || at + BigInt(length) > (1n << 64n)) return null;
  try {
    const result = await read(at, length);
    if (signal?.aborted) throw signal.reason;
    return result?.length >= length ? result.subarray(0, length) : null;
  } catch (error) { if (signal?.aborted) throw error; return null; }
}
async function encoding(read, at, options) {
  if (options.signal?.aborted) throw options.signal.reason;
  if (at == null) return null;
  if (at < 0n || at >= (1n << 64n)) return { address: at, complete: false, reason: 'relative-reference-out-of-range' };
  const value = await options.readMangledName(read, at, { ...options, maxBytes: 512, compilerMetadata: true });
  if (options.signal?.aborted) throw options.signal.reason;
  return { address: at, ...value };
}

/** Non-pack nominal generic signatures: the 16-byte type header follows the
 * fixed class (44) or value (28) descriptor, then byte parameters and aligned
 * 12-byte requirements. Unsupported flags are never skipped speculatively. */
export async function parseSwiftGenericContext(read, type, options = {}) {
  if (type?.generic !== true) return null;
  const result = { typeAddress: type.address, address: null, parameters: [], requirements: [],
    complete: false, reason: null, substitutions: null, instantiation: 'unknown' };
  const fail = reason => ({ ...result, reason });
  if (!['class', 'struct', 'enum'].includes(type.kind) || (type.flags & 0xff00) !== 0) return fail('generic-context-layout-unsupported');
  const address = BigInt(type.address) + (type.kind === 'class' ? 44n : 28n);
  result.address = address;
  const h = await bytes(read, address, 16, options.signal);
  if (!h) return fail('generic-context-header-unreadable');
  const numParams = u16(h, 8), numRequirements = u16(h, 10), numKeyArguments = u16(h, 12), flags = u16(h, 14);
  Object.assign(result, { numParams, numRequirements, numKeyArguments, flags,
    instantiationCache: rel(address, u32(h)), defaultInstantiationPattern: rel(address + 4n, u32(h, 4)) });
  if (flags !== 0) return fail('generic-pack-or-extended-context-unsupported');
  if (numParams + numRequirements + 1 > bounded(options.budget)) return fail('generic-context-count-budget');
  const requirementOffset = (16 + numParams + 3) & ~3;
  const tailLength = requirementOffset - 16 + numRequirements * 12;
  const tail = tailLength ? await bytes(read, address + 16n, tailLength, options.signal) : new Uint8Array();
  if (!tail) return fail('generic-context-records-unreadable');
  for (let index = 0; index < numParams; index++) {
    const raw = tail[index];
    result.parameters.push({ index, flags: raw, kind: raw & 0x3f, hasKeyArgument: Boolean(raw & 0x80) });
    if ((raw & 0x7f) !== 0) result.reason = 'generic-parameter-kind-unsupported';
  }
  for (let index = 0; index < numRequirements; index++) {
    const offset = requirementOffset - 16 + index * 12, at = address + BigInt(requirementOffset + index * 12);
    const flags = u32(tail, offset), kind = flags & 0x1f;
    const parameter = await encoding(read, rel(at + 4n, u32(tail, offset + 4)), options);
    const rawPayload = u32(tail, offset + 8);
    const row = { index, address: at, flags, kind, hasKeyArgument: Boolean(flags & 0x80), parameter, rawPayload,
      type: null, reference: null, layout: null, satisfied: 'unknown' };
    if (kind === 1 || kind === 2) row.type = await encoding(read, rel(at + 8n, rawPayload), options);
    else if (kind === 0 || kind === 3) row.reference = { fieldAddress: at + 8n, rawOffset: rawPayload | 0,
      target: null, reason: 'tagged-relative-reference-requires-canonical-owner' };
    else if (kind === 31) row.layout = rawPayload;
    else result.reason = 'generic-requirement-kind-unsupported';
    if ((flags & ~0x9f) !== 0) result.reason = 'generic-requirement-flags-unsupported';
    if (parameter?.complete !== true || ((kind === 1 || kind === 2) && row.type?.complete !== true)) result.reason = 'generic-requirement-type-unreadable';
    result.requirements.push(row);
  }
  result.endAddress = address + BigInt(requirementOffset + numRequirements * 12);
  if (numKeyArguments !== result.parameters.filter(row => row.hasKeyArgument).length
    + result.requirements.filter(row => row.hasKeyArgument).length) result.reason = 'generic-key-argument-count-inconsistent';
  result.complete = result.reason == null;
  return result;
}

/** __swift5_capture contains sequential descriptors, not relative-pointer
 * section entries. Each descriptor is three u32 counts, n relative typerefs,
 * then m pairs of relative typeref / metadata-source encodings. */
export async function parseSwiftCaptureSection(read, range, options = {}) {
  const descriptors = [], completeness = { present: Boolean(range), complete: true, parsed: 0,
    scannedBytes: 0, reason: null };
  const finish = reason => ({ descriptors, completeness: { ...completeness, parsed: descriptors.length,
    complete: reason == null, reason } });
  if (!range) return finish(null);
  if (range.invalid || typeof range.addr !== 'bigint' || typeof range.size !== 'bigint'
    || range.addr < 0n || range.size < 0n || range.addr + range.size > (1n << 64n)) return finish('capture-section-range-invalid');
  let at = range.addr;
  const end = at + range.size, limit = bounded(options.budget);
  let remaining = limit;
  while (at < end) {
    if (descriptors.length >= limit) return finish('capture-descriptor-count-budget');
    if (end - at < 12n) return finish('capture-descriptor-header-truncated');
    const h = await bytes(read, at, 12, options.signal);
    if (!h) return finish('capture-descriptor-header-unreadable');
    const numCaptureTypes = u32(h), numMetadataSources = u32(h, 4), numBindings = u32(h, 8);
    if (numCaptureTypes > limit || numMetadataSources > limit || numBindings > limit) return finish('capture-record-count-budget');
    if (1 + numCaptureTypes + numMetadataSources > remaining) return finish('capture-total-record-budget');
    remaining -= 1 + numCaptureTypes + numMetadataSources;
    const length = 12 + numCaptureTypes * 4 + numMetadataSources * 8;
    if (at + BigInt(length) > end) return finish('capture-descriptor-records-truncated');
    const b = await bytes(read, at, length, options.signal);
    if (!b) return finish('capture-descriptor-records-unreadable');
    const descriptor = { address: at, byteLength: length, numCaptureTypes, numMetadataSources, numBindings,
      captureTypes: [], metadataSources: [], complete: true, objectLayout: 'unknown', substitutions: null };
    for (let index = 0; index < numCaptureTypes; index++) {
      const offset = 12 + index * 4;
      const type = await encoding(read, rel(at + BigInt(offset), u32(b, offset)), options);
      descriptor.captureTypes.push({ index, address: at + BigInt(offset), type });
      if (type?.complete !== true) descriptor.complete = false;
    }
    for (let index = 0; index < numMetadataSources; index++) {
      const offset = 12 + numCaptureTypes * 4 + index * 8;
      const type = await encoding(read, rel(at + BigInt(offset), u32(b, offset)), options);
      const source = await encoding(read, rel(at + BigInt(offset + 4), u32(b, offset + 4)), options);
      descriptor.metadataSources.push({ index, address: at + BigInt(offset), type, source, interpretation: 'unresolved' });
      if (type?.complete !== true || source?.complete !== true) descriptor.complete = false;
    }
    descriptors.push(descriptor); at += BigInt(length); completeness.scannedBytes += length;
  }
  return finish(descriptors.some(row => !row.complete) ? 'capture-type-or-source-unreadable' : null);
}
