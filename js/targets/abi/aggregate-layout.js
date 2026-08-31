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
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeEnd(offset, bytes) {
  const end = offset + bytes;
  return Number.isSafeInteger(end) && end > offset ? end : null;
}

const AMBIGUOUS = Symbol('ambiguous-aggregate-layout-field');

function descriptorPresent(parameter, layout, aliases) {
  return [parameter, layout].some((owner) => record(owner)
    && aliases.some((alias) => Object.hasOwn(owner, alias)));
}

function descriptorPresentMany(parameter, layouts, aliases) {
  return [parameter, ...layouts].some((owner) => record(owner)
    && aliases.some((alias) => Object.hasOwn(owner, alias)));
}

function aggregateNestedLayouts(parameter) {
  if (!record(parameter)) return [];
  const owners = [];
  const add = (owner) => {
    if (!record(owner) || owners.includes(owner)) return;
    owners.push(owner);
    // A returnAggregate/layout wrapper may itself carry a nested layout. Keep
    // every spelling in the same comparison set so one alias cannot hide a
    // contradictory physical descriptor.
    if (record(owner.layout)) add(owner.layout);
  };
  if (record(parameter.layout)) add(parameter.layout);
  if (record(parameter.returnAggregate)) add(parameter.returnAggregate);
  return owners;
}

/**
 * Whether an aggregate carries an explicit physical layout descriptor.  This
 * is intentionally separate from `canonicalAggregateLayout`: a null result
 * can mean either "no layout was supplied" (for example a SysV eightbyte
 * class proof) or "a supplied layout is malformed".  Profile classifiers use
 * this bit to reject the latter without rejecting their legacy class proofs.
 */
export function aggregateLayoutDescriptorPresent(parameter) {
  if (!record(parameter)) return false;
  // An explicitly supplied non-record/null layout is malformed evidence, not
  // an omitted optional field.  Keep this distinguishable from a legacy
  // aggregate that proves placement through ABI-specific class metadata.
  if (Object.hasOwn(parameter, 'layout')) return true;
  if (Object.hasOwn(parameter, 'returnAggregate')) {
    // `returnAggregate: true/false` is the legacy result-kind marker, not a
    // physical descriptor. Only a record contributes layout evidence; null
    // and booleans must not manufacture a malformed descriptor, while any
    // other explicit value remains malformed and is rejected below.
    if (!record(parameter.returnAggregate)) {
      return parameter.returnAggregate != null
        && typeof parameter.returnAggregate !== 'boolean';
    }
    return true;
  }
  const nestedLayouts = aggregateNestedLayouts(parameter);
  const hasPhysicalField = (owner) => {
    if (!record(owner)) return false;
    if (['padding', 'paddings', 'paddingBytes'].some((alias) => Object.hasOwn(owner, alias))) return true;
    // Numeric members/elements/count values are legacy logical HFA/HVA
    // metadata. They do not establish a physical layout by themselves; an
    // array/object descriptor does, and must survive canonical validation.
    return ['members', 'fields', 'elements'].some((alias) => {
      if (!Object.hasOwn(owner, alias)) return false;
      const value = owner[alias];
      return Array.isArray(value) || record(value);
    });
  };
  return [parameter, ...nestedLayouts].some(hasPhysicalField);
}

function sameDescriptorValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== typeof right) return false;
  if (typeof left !== 'object') return String(left) === String(right);
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

/*
 * A nested layout is an alternate spelling of the same canonical descriptor,
 * not a second source of truth.  If both spellings are present they must agree
 * before a classifier is allowed to consume either one.
 */
function descriptorValue(parameter, layout, aliases, extraLayouts = []) {
  const find = (owner) => {
    if (!record(owner)) return { present:false, value:undefined };
    const values = aliases.filter((alias) => Object.hasOwn(owner, alias)).map((alias) => owner[alias]);
    if (!values.length) return { present:false, value:undefined };
    const value = values[0];
    return {
      present:true,
      value:values.slice(1).some((candidate) => !sameDescriptorValue(candidate, value))
        ? AMBIGUOUS : value,
    };
  };
  const values = [parameter, layout, ...extraLayouts].map(find);
  if (values.some(({ value }) => value === AMBIGUOUS)) return AMBIGUOUS;
  const present = values.filter(({ present:hasValue }) => hasValue);
  if (present.length > 1 && present.slice(1).some(({ value }) => !sameDescriptorValue(value, present[0].value))) {
    return AMBIGUOUS;
  }
  if (present.length) return present[0].value;
  return undefined;
}

function memberList(parameter) {
  const nestedLayouts = aggregateNestedLayouts(parameter);
  let selected;
  let selectedPresent = false;
  for (const owner of [parameter, ...nestedLayouts]) {
    if (!record(owner)) continue;
    for (const alias of ['members', 'fields', 'elements']) {
      if (!Object.hasOwn(owner, alias)) continue;
      const value = owner[alias];
      if (!selectedPresent) {
        selected = value;
        selectedPresent = true;
        continue;
      }
      if (sameDescriptorValue(selected, value)) continue;
      // Legacy classifier metadata sometimes carries only a numeric member
      // count beside a nested physical member array.  The count is accepted
      // solely as a consistency check; it never supplies physical fields.
      if (Array.isArray(value) && Number.isSafeInteger(selected)
        && selected >= 0 && selected === value.length) {
        selected = value;
        continue;
      }
      if (Array.isArray(selected) && Number.isSafeInteger(value)
        && value >= 0 && value === selected.length) continue;
      return AMBIGUOUS;
    }
  }
  return Array.isArray(selected) && selected.length > 0 ? selected : null;
}

function memberBits(member) {
  const layout = record(member?.layout) ? member.layout : null;
  const raw = descriptorValue(member, layout, ['bits', 'sizeBits', 'widthBits']);
  return raw === AMBIGUOUS ? null : positiveInteger(raw);
}

function memberBytes(member, bits) {
  const layout = record(member?.layout) ? member.layout : null;
  const declared = descriptorValue(member, layout, ['bytes', 'sizeBytes', 'length']);
  if (declared === AMBIGUOUS) return null;
  if (declared == null && descriptorPresent(member, layout, ['bytes', 'sizeBytes', 'length'])) return null;
  if (declared != null) return positiveInteger(declared);
  return bits == null ? null : Math.ceil(bits / 8);
}

function memberOffset(member) {
  const layout = record(member?.layout) ? member.layout : null;
  const raw = descriptorValue(member, layout, ['byteOffset', 'offsetBytes', 'offset']);
  return raw === AMBIGUOUS ? null : nonNegativeInteger(raw);
}

function paddingList(parameter) {
  const nestedLayouts = aggregateNestedLayouts(parameter);
  const layout = nestedLayouts[0] ?? null;
  const padding = descriptorValue(parameter, layout, ['padding', 'paddings', 'paddingBytes'], nestedLayouts.slice(1));
  if (padding === AMBIGUOUS) return AMBIGUOUS;
  if (Array.isArray(padding)) return padding;
  if (padding === undefined
    && !descriptorPresentMany(parameter, nestedLayouts, ['padding', 'paddings', 'paddingBytes'])) return [];
  if (padding == null) return null;
  // A scalar/object/string padding descriptor has no proven physical list.
  // Preserve the malformed state instead of normalizing it to []: when members
  // already cover the object, [] would incorrectly establish exact evidence.
  return null;
}

function paddingSpan(entry) {
  if (!record(entry)) return null;
  if (Object.hasOwn(entry, 'layout') && !record(entry.layout)) return null;
  const layout = record(entry.layout) ? entry.layout : null;
  const rawBytes = descriptorValue(entry, layout, ['bytes', 'sizeBytes', 'length']);
  if (rawBytes === AMBIGUOUS) return null;
  const bytes = positiveInteger(rawBytes);
  if (bytes == null) return null;
  const rawOffset = descriptorValue(entry, layout, ['byteOffset', 'offsetBytes', 'offset']);
  if (rawOffset === AMBIGUOUS) return null;
  const offset = rawOffset == null ? null : nonNegativeInteger(rawOffset);
  const end = offset == null ? null : safeEnd(offset, bytes);
  return { offset, bytes, end };
}

function explicitTotalBytes(parameter, bits) {
  const nestedLayouts = aggregateNestedLayouts(parameter);
  const layout = nestedLayouts[0] ?? null;
  const declared = descriptorValue(parameter, layout, ['bytes', 'sizeBytes'], nestedLayouts.slice(1));
  if (declared === AMBIGUOUS) return null;
  if (declared == null && descriptorPresentMany(parameter, nestedLayouts, ['bytes', 'sizeBytes'])) return null;
  if (declared != null) return positiveInteger(declared);
  return bits == null ? null : Math.ceil(bits / 8);
}

/**
 * Return normalized aggregate layout evidence, or null when no complete
 * physical member layout is proven.
 */
export function canonicalAggregateLayout(parameter) {
  if (!record(parameter)) return null;
  if (Object.hasOwn(parameter, 'layout') && !record(parameter.layout)) return null;
  if (Object.hasOwn(parameter, 'returnAggregate')
    && parameter.returnAggregate != null
    && typeof parameter.returnAggregate !== 'boolean'
    && !record(parameter.returnAggregate)) return null;
  const members = memberList(parameter);
  if (members === AMBIGUOUS || !members) return null;
  const nestedLayouts = aggregateNestedLayouts(parameter);
  const layout = nestedLayouts[0] ?? null;
  const rawBits = descriptorValue(parameter, layout, ['bits', 'sizeBits', 'returnBits'], nestedLayouts.slice(1));
  if (rawBits === AMBIGUOUS) return null;
  const bits = positiveInteger(rawBits);
  if (bits == null) return null;
  const totalBytes = explicitTotalBytes(parameter, bits);
  if (totalBytes == null || Math.ceil(bits / 8) > totalBytes) return null;

  const normalizedMembers = [];
  const spans = [];
  let memberBitsTotal = 0;
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (!record(member)) return null;
    if (Object.hasOwn(member, 'layout') && !record(member.layout)) return null;
    const bitsForMember = memberBits(member);
    const bytes = memberBytes(member, bitsForMember);
    const byteOffset = memberOffset(member);
    if (bitsForMember == null || bytes == null || byteOffset == null
      || Math.ceil(bitsForMember / 8) > bytes) return null;
    const end = safeEnd(byteOffset, bytes);
    if (end == null || end > totalBytes) return null;
    if (spans.some(([start, finish]) => byteOffset < finish && start < end)) return null;
    // The member list is canonical order. Do not silently sort it and thereby
    // launder an adapter that emitted the wrong order.
    if (index > 0 && byteOffset < normalizedMembers[index - 1].byteOffset) return null;
    const memberLayout = record(member.layout) ? member.layout : null;
    const alignment = descriptorValue(member, memberLayout, ['alignment', 'align', 'alignmentBytes']);
    if (alignment === AMBIGUOUS) return null;
    if (alignment == null && descriptorPresent(member, memberLayout, ['alignment', 'align', 'alignmentBytes'])) return null;
    const alignmentNumber = alignment == null ? null : positiveInteger(alignment);
    if (alignment != null && (alignmentNumber == null || byteOffset % alignmentNumber !== 0)) return null;
    normalizedMembers.push({ ...member, bits:bitsForMember, bytes, byteOffset });
    spans.push([byteOffset, end]);
    memberBitsTotal += bitsForMember;
    if (!Number.isSafeInteger(memberBitsTotal)) return null;
  }

  const rawPaddings = paddingList(parameter);
  if (rawPaddings === AMBIGUOUS || !Array.isArray(rawPaddings)) return null;
  const paddings = rawPaddings.map(paddingSpan);
  // Every padding span must carry an exact physical offset. Accepting one
  // unlocated trailing span (or ignoring duplicate unknown spans) makes two
  // contradictory layouts serialize to the same "exact" aggregate.
  if (paddings.some((padding) => !padding || padding.offset == null || padding.end == null)) return null;
  const covered = [...spans.map(([offset, end]) => ({ offset, end, kind:'member' })),
    ...paddings.map(({ offset, end }) => ({ offset, end, kind:'padding' }))]
    .sort((left, right) => left.offset - right.offset || left.end - right.end);
  let cursor = 0;
  for (const span of covered) {
    if (span.offset !== cursor || span.end <= span.offset) return null;
    cursor = span.end;
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
