// Opens a compiled C++ fixture through the production binary loader and exposes
// the exact inputs the C++ evidence producers consume (symbol index, address
// reader, declared symbol sizes, containing section ends). Real-binary tests use
// this so the producer is exercised against the real ELF parser rather than a
// hand-rolled stub.

import { openBinary } from '../../../../js/binary/index.js';
import { SymbolIndex } from '../../../../js/symbols.js';
import { buildCxxFixtures } from './build.mjs';

function asBytes(raw) {
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

export function openCxxFixture(name, options = {}) {
  const built = buildCxxFixtures(options);
  if (!built.available) return { available: false, reason: built.reason };
  const artifact = built.artifacts[name];
  if (!artifact) throw new Error(`unknown cxx fixture: ${name}`);

  const bytes = asBytes(artifact.bytes);
  const image = openBinary(bytes);
  const rawSymbols = image.symbols || [];
  const symbols = new SymbolIndex({
    addrs: rawSymbols.map((symbol) => symbol.address),
    names: rawSymbols.map((symbol) => symbol.name),
    kinds: rawSymbols.map(() => 0),
    flags: rawSymbols.map(() => 0),
  });

  const sizeByAddress = new Map();
  for (const symbol of rawSymbols) {
    if (symbol.address == null) continue;
    const key = symbol.address.toString();
    if (!sizeByAddress.has(key)) sizeByAddress.set(key, symbol.size ?? null);
  }

  const read = (address, length) => {
    const offset = image.addressToOffset?.(address);
    if (offset == null) return null;
    const start = Number(offset);
    const size = Number(length);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size <= 0) return null;
    if (start >= bytes.length) return null;
    return bytes.subarray(start, Math.min(start + size, bytes.length));
  };

  return {
    available: true,
    name,
    bytes,
    image,
    symbols,
    read,
    pointerBytes: 8,
    symbolSizeOf: (address) => sizeByAddress.get(address.toString()) ?? null,
    sectionEndOf: (address) => {
      const section = image.sectionAt?.(address);
      if (!section || section.size == null) return null;
      return section.address + section.size;
    },
  };
}
