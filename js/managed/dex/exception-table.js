import { createOriginSet } from '../../core/identity/origin.js';
import { createManagedExceptionRegionId } from '../shared/identity.js';
import { checkedRange, fail } from './validation-utils.js';
import { readDexUleb128, readDexSleb128 } from './leb128.js';
import { dexTypeInfo } from './descriptor.js';

// A handler_off is a byte offset from the encoded_catch_handler_list start,
// including the list's leading ULEB count, not an IL/code-unit displacement.
export function decodeDexExceptionTable(bytes, { methodId, insnsStart, insnsSize, triesSize, types, boundaries, limit = bytes.length }) {
  checkedRange(bytes.length, 0, limit, 'dex-invalid-exception-data-limit');
  if (triesSize === 0) return { regions:[], handlerOffsets:new Set() };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const insnsEnd = insnsStart + insnsSize * 2;
  let triesStart = insnsEnd;
  if (insnsSize & 1) {
    checkedRange(limit, triesStart, 2, 'dex-truncated-try-padding');
    if (view.getUint16(triesStart, true) !== 0) fail('dex-code-item-padding-nonzero');
    triesStart += 2;
  }
  checkedRange(limit, triesStart, triesSize * 8, 'dex-truncated-try-items');
  const listStart = triesStart + triesSize * 8;
  const count = readDexUleb128(bytes, listStart, limit, 'dex-malformed-catch-handler-list');
  if (count.value === 0 || count.value > Math.floor((limit - count.nextOffset) / 2)) fail('dex-invalid-catch-handler-count');
  const listHeaderEnd = count.nextOffset;
  const byOffset = new Map();
  let pos = count.nextOffset;
  for (let i = 0; i < count.value; i++) {
    const start = pos;
    const size = readDexSleb128(bytes, pos, limit, 'dex-malformed-catch-handler-list');
    pos = size.nextOffset;
    const typedCount = Math.abs(size.value);
    if (typedCount > Math.floor((limit - pos) / 2)) fail('dex-invalid-catch-handler-count');
    const targets = [], caughtTypes = new Set();
    for (let j = 0; j < typedCount; j++) {
      const type = readDexUleb128(bytes, pos, limit, 'dex-malformed-catch-handler-list');
      const address = readDexUleb128(bytes, type.nextOffset, limit, 'dex-malformed-catch-handler-list');
      pos = address.nextOffset;
      if (type.value >= (types?.length ?? 0) || caughtTypes.has(type.value)) fail('dex-catch-handler-type-index-invalid');
      const descriptor = types[type.value];
      if (dexTypeInfo(descriptor).category !== 'object' || descriptor[0] !== 'L') fail('dex-catch-handler-type-invalid');
      caughtTypes.add(type.value);
      targets.push({ catchTypeIndex:type.value, catchType:descriptor, handlerOffset:address.value * 2 });
    }
    if (size.value <= 0) {
      const address = readDexUleb128(bytes, pos, limit, 'dex-malformed-catch-handler-list'); pos = address.nextOffset;
      targets.push({ catchTypeIndex:null, catchType:null, handlerOffset:address.value * 2 });
    }
    for (const target of targets) {
      if (target.handlerOffset >= insnsSize * 2 || !boundaries.has(target.handlerOffset)) fail('dex-catch-handler-target-invalid');
    }
    byOffset.set(start - listStart, { targets, start, end:pos });
  }
  const regions = [], handlerOffsets = new Set();
  let previousEnd = 0;
  for (let i = 0; i < triesSize; i++) {
    const start = triesStart + i * 8;
    const first = view.getUint32(start, true), count = view.getUint16(start + 4, true);
    const end = first + count, handlerOff = view.getUint16(start + 6, true);
    if (count === 0 || first < previousEnd || end > insnsSize || !boundaries.has(first * 2)
      || (end !== insnsSize && !boundaries.has(end * 2))) fail('dex-try-range-invalid');
    previousEnd = end;
    const handler = byOffset.get(handlerOff);
    if (!handler) fail('dex-try-handler-offset-invalid');
    const origin = createOriginSet({ byteRanges:[{start,end:start+8},{start:listStart,end:listHeaderEnd},{start:handler.start,end:handler.end}] });
    for (const target of handler.targets) {
      handlerOffsets.add(target.handlerOffset);
      regions.push({ id:createManagedExceptionRegionId(methodId,regions.length), startOffset:first*2, endOffset:end*2,
        handlerKind:'catch', ...target, tryIndex:i, handlerOff, origin });
    }
  }
  return { regions, handlerOffsets };
}
