/*
 * Canonical aggregate layout evidence shared by ABI profiles.
 *
 * A declared bit width is a type-width hint, not a physical layout proof. An
 * aggregate can be padded, reordered, or otherwise placed differently by the
 * selected ABI. Exact classification therefore requires an explicit ordered
 * member layout (or an equivalent layout descriptor) with byte spans that
 * cover the complete object. This module validates only that evidence; it
 * does not select registers or implement any ABI's placement rules.
 */

function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function firstDefined(...values) { return values.find((value) => value != null); }

function memberList(parameter) {
  const layout = record(parameter?.layout) ? parameter.layout : null;
  const members = firstDefined(parameter?.members, parameter?.fields, parameter?.elements,
    layout?.members, layout?.fields, layout?.elements);
  return Array.isArray(members) && members.length > 0 ? members : null;
}

function memberBits(member) {
  return positiveInteger(firstDefined(member?.bits, member?.sizeBits, member?.widthBits));
}

function memberBytes(member, bits) {
  const declared = firstDefined(member?.bytes, member?.sizeBytes, member?.layout?.bytes);
  if (declared != null) return positiveInteger(declared);
  return bits == null ? null : Math.ceil(bits / 8);
}

function memberOffset(member) {
  return nonNegativeInteger(firstDefined(member?.byteOffset, member?.offsetBytes,
    member?.offset, member?.layout?.byteOffset, member?.layout?.offset));
}

function paddingList(parameter) {
  const layout = record(parameter?.layout) ? parameter.layout : null;
  const padding = firstDefined(parameter?.padding, parameter?.paddings,
    parameter?.paddingBytes, layout?.padding, layout?.paddings, layout?.paddingBytes);
  if (Array.isArray(padding)) return padding;
  if (padding == null) return [];
  // A scalar padding byte count is only useful for trailing padding. Keep it
  // explicit so a caller cannot accidentally turn an interior hole exact.
  const bytes = positiveInteger(padding);
  return bytes == null ? [] : [{ byteOffset:null, bytes }];
}

function paddingSpan(entry) {
  if (!record(entry)) return null;
  const bytes = positiveInteger(firstDefined(entry.bytes, entry.sizeBytes, entry.length));
  if (bytes == null) return null;
  const rawOffset = firstDefined(entry.byteOffset, entry.offsetBytes, entry.offset);
  const offset = rawOffset == null ? null : nonNegativeInteger(rawOffset);
  return { offset, bytes, end:offset == null ? null : offset + bytes };
}

function explicitTotalBytes(parameter, bits) {
  const layout = record(parameter?.layout) ? parameter.layout : null;
  const declared = firstDefined(parameter?.bytes, parameter?.sizeBytes,
    layout?.bytes, layout?.sizeBytes);
  if (declared != null) return positiveInteger(declared);
  return bits == null ? null : Math.ceil(bits / 8);
}

/**
 * Return normalized aggregate layout evidence, or null when no complete
 * physical member layout is proven.
 */
export function canonicalAggregateLayout(parameter) {
  if (!record(parameter)) return null;
  const members = memberList(parameter);
  if (!members) return null;
  const layout = record(parameter.layout) ? parameter.layout : null;
  const bits = positiveInteger(firstDefined(parameter.bits, parameter.sizeBits,
    layout?.bits, layout?.sizeBits));
  if (bits == null) return null;
  const totalBytes = explicitTotalBytes(parameter, bits);
  if (totalBytes == null || Math.ceil(bits / 8) > totalBytes) return null;

  const normalizedMembers = [];
  const spans = [];
  let memberBitsTotal = 0;
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (!record(member)) return null;
    const bitsForMember = memberBits(member);
    const bytes = memberBytes(member, bitsForMember);
    const byteOffset = memberOffset(member);
    if (bitsForMember == null || bytes == null || byteOffset == null
      || Math.ceil(bitsForMember / 8) > bytes) return null;
    const end = byteOffset + bytes;
    if (end > totalBytes) return null;
    if (spans.some(([start, finish]) => byteOffset < finish && start < end)) return null;
    // The member list is canonical order. Do not silently sort it and thereby
    // launder an adapter that emitted the wrong order.
    if (index > 0 && byteOffset < normalizedMembers[index - 1].byteOffset) return null;
    const alignment = firstDefined(member.alignment, member.align, member.alignmentBytes);
    const alignmentNumber = alignment == null ? null : positiveInteger(alignment);
    if (alignment != null && (alignmentNumber == null || byteOffset % alignmentNumber !== 0)) return null;
    normalizedMembers.push({ ...member, bits:bitsForMember, bytes, byteOffset });
    spans.push([byteOffset, end]);
    memberBitsTotal += bitsForMember;
  }

  const paddings = paddingList(parameter).map(paddingSpan);
  if (paddings.some((padding) => !padding)) return null;
  const covered = [...spans.map(([offset, end]) => ({ offset, end, kind:'member' })),
    ...paddings.filter((padding) => padding.offset != null)
      .map(({ offset, end }) => ({ offset, end, kind:'padding' }))]
    .sort((left, right) => left.offset - right.offset || left.end - right.end);
  let cursor = 0;
  for (const span of covered) {
    if (span.offset !== cursor || span.end <= span.offset) return null;
    cursor = span.end;
  }
  const trailingPadding = paddings.find((padding) => padding.offset == null);
  if (trailingPadding) {
    if (cursor + trailingPadding.bytes !== totalBytes) return null;
    cursor = totalBytes;
  }
  if (cursor !== totalBytes) return null;
  if (memberBitsTotal > bits) return null;

  return Object.freeze({
    bits,
    bytes:totalBytes,
    members:Object.freeze(normalizedMembers),
    padding:Object.freeze(paddings),
  });
}

export function aggregateLayoutIsProven(parameter) {
  return canonicalAggregateLayout(parameter) != null;
}
