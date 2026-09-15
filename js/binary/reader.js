const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function nonNegativeOffset(value, label = 'offset') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer or bigint`);
  return BigInt(value);
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function integerValue(value, label = 'value') {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim() !== '') {
    try { return BigInt(value); }
    catch {}
  }
  throw new TypeError(`${label} must be a bigint, safe integer, or non-empty integer string`);
}

function finiteBound(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function byteOffset(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
  }
  return null;
}

function byteLength(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') return value >= 0n && value <= MAX_SAFE_BIGINT ? Number(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function exposedOffset(value) {
  return value <= MAX_SAFE_BIGINT ? Number(value) : value;
}

export class BinaryReadError extends Error {
  constructor(message, offset = null) {
    let shown = null;
    if (typeof offset === 'bigint' && offset >= 0n) shown = offset;
    else if (Number.isSafeInteger(offset) && offset >= 0) shown = BigInt(offset);
    super(shown == null ? message : `${message} @ 0x${shown.toString(16)}`);
    this.name = 'BinaryReadError';
    this.offset = offset;
  }
}

export class ByteView {
  constructor(input, { littleEndian = true, base = 0 } = {}) {
    if (input instanceof Uint8Array) this.bytes = input;
    else if (input instanceof ArrayBuffer) this.bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input?.__binaryByteBacking === true && (typeof input.size === 'bigint' || Number.isSafeInteger(input.length)) && typeof input.subarray === 'function') this.bytes = input;
    else throw new TypeError('ByteView expects bytes or a binary byte backing');
    this.view = this.bytes instanceof Uint8Array ? new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength) : null;
    this.littleEndian = booleanValue(littleEndian, 'ByteView littleEndian');
    this.base = nonNegativeOffset(base, 'ByteView base');
    this.lengthBigInt = typeof this.bytes.size === 'bigint' ? this.bytes.size : BigInt(this.bytes.length);
  }

  get length() { return this.lengthBigInt > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(this.lengthBigInt); }

  endian(littleEndian) {
    return new ByteView(this.bytes, { littleEndian, base: this.base });
  }

  check(offset, size = 1) {
    const ob = byteOffset(offset);
    const nb = byteOffset(size);
    if (ob == null || nb == null || ob > this.lengthBigInt || nb > this.lengthBigInt - ob) {
      const shownSize = nb == null ? String(size) : nb <= MAX_SAFE_BIGINT ? Number(nb) : nb.toString();
      throw new BinaryReadError(`read outside file (${shownSize} bytes)`, this.base + (ob ?? 0n));
    }
    return exposedOffset(ob);
  }

  data(offset, size) {
    const o = this.check(offset, size);
    const n = byteLength(size);
    if (n == null) throw new BinaryReadError(`read is too large to materialize (${String(size)} bytes)`, this.base + BigInt(o));
    if (this.view) return { view: this.view, offset: o };
    const end = exposedOffset(BigInt(o) + BigInt(n));
    const bytes = this.bytes.subarray(o, end);
    return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  }

  u8(offset) { const x = this.data(offset, 1); return x.view.getUint8(x.offset); }
  i8(offset) { const x = this.data(offset, 1); return x.view.getInt8(x.offset); }
  u16(offset, le = this.littleEndian) { const x = this.data(offset, 2); return x.view.getUint16(x.offset, booleanValue(le, 'littleEndian')); }
  i16(offset, le = this.littleEndian) { const x = this.data(offset, 2); return x.view.getInt16(x.offset, booleanValue(le, 'littleEndian')); }
  u32(offset, le = this.littleEndian) { const x = this.data(offset, 4); return x.view.getUint32(x.offset, booleanValue(le, 'littleEndian')); }
  i32(offset, le = this.littleEndian) { const x = this.data(offset, 4); return x.view.getInt32(x.offset, booleanValue(le, 'littleEndian')); }
  u64(offset, le = this.littleEndian) { const x = this.data(offset, 8); return x.view.getBigUint64(x.offset, booleanValue(le, 'littleEndian')); }
  i64(offset, le = this.littleEndian) { const x = this.data(offset, 8); return x.view.getBigInt64(x.offset, booleanValue(le, 'littleEndian')); }

  slice(offset, size) {
    const o = this.check(offset, size);
    const n = byteLength(size);
    if (n == null) throw new BinaryReadError(`read is too large to materialize (${String(size)} bytes)`, this.base + BigInt(o));
    const end = exposedOffset(BigInt(o) + BigInt(n));
    return this.bytes.subarray(o, end);
  }

  subview(offset, size = null, opts = {}) {
    const start = byteOffset(offset);
    if (start == null) {
      this.check(offset, 0);
      throw new BinaryReadError('invalid subview offset', this.base);
    }
    const requestedSize = size == null ? this.lengthBigInt - start : size;
    const o = this.check(offset, requestedSize);
    const n = byteLength(requestedSize);
    if (n == null) throw new BinaryReadError(`subview is too large to materialize (${String(requestedSize)} bytes)`, this.base + BigInt(o));
    const littleEndian = opts.littleEndian === undefined ? this.littleEndian : opts.littleEndian;
    const end = exposedOffset(BigInt(o) + BigInt(n));
    return new ByteView(this.bytes.subarray(o, end), {
      littleEndian,
      base: this.base + BigInt(o),
    });
  }

  ascii(offset, size, { trimNul = true } = {}) {
    const b = this.slice(offset, size);
    let end = b.length;
    if (trimNul) {
      const z = b.indexOf(0);
      if (z >= 0) end = z;
    }
    let out = '';
    for (let i = 0; i < end; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  cstring(offset, max = 1 << 20) {
    const o = this.check(offset, 0);
    const start = BigInt(o);
    const rawMax = Math.max(0, Math.floor(finiteBound(max, 1 << 20)));
    const boundedMax = Number.isSafeInteger(rawMax) ? rawMax : Number.MAX_SAFE_INTEGER;
    const wantedEnd = start + BigInt(boundedMax);
    const end = wantedEnd < this.lengthBigInt ? wantedEnd : this.lengthBigInt;
    let raw;
    if (this.view) {
      const startNumber = Number(start);
      const endNumber = Number(end);
      const span = this.bytes.subarray(startNumber, endNumber);
      const nul = span.indexOf(0);
      raw = nul < 0 ? span : span.subarray(0, nul);
    } else {
      // A sparse backing must scan in bounded blocks. Calling u8() one byte
      // at a time turns every uncached character into a separate source read.
      const blockSize = Number.isSafeInteger(this.bytes.readAheadSize) && this.bytes.readAheadSize > 0
        ? this.bytes.readAheadSize
        : 64 * 1024;
      const blockSizeBig = BigInt(blockSize);
      let p = start - (start % blockSizeBig);
      raw = this.bytes.subarray(o, o);
      while (p < end) {
        const blockEnd = p + BigInt(Math.min(blockSize, Number(end - p)));
        let span;
        try {
          span = this.bytes.subarray(exposedOffset(p), exposedOffset(blockEnd));
        } catch (error) {
          if (error?.code !== 'BINARY_SOURCE_RANGE_MISSING') throw error;
          const missing = typeof error.offset === 'bigint' ? error.offset : BigInt(error.offset ?? p);
          if (missing > start) {
            const cached = this.bytes.subarray(exposedOffset(p), exposedOffset(missing));
            const cachedNul = cached.indexOf(0, Number(start - p));
            if (cachedNul >= 0) {
              raw = this.bytes.subarray(o, exposedOffset(p + BigInt(cachedNul)));
              break;
            }
          }
          throw error;
        }
        const nul = span.indexOf(0, Number(start - p));
        if (nul >= 0) {
          raw = this.bytes.subarray(o, exposedOffset(p + BigInt(nul)));
          break;
        }
        p = blockEnd;
        raw = this.bytes.subarray(o, exposedOffset(p));
      }
    }
    try { return new TextDecoder('utf-8', { fatal: false }).decode(raw); }
    catch {
      let out = '';
      for (const c of raw) out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\uFFFD';
      return out;
    }
  }

  /**
   * Absolute offset of the first 0 byte in [offset, end), or -1 when the range
   * holds no NUL. Unlike `bytes.subarray(offset, end).indexOf(0)` this never
   * materializes a range wider than one read-ahead block, so on a sparse
   * source a terminated C string costs O(block) bytes rather than O(tail of the
   * table) — the #8651 scalar-termination amplification. It still propagates
   * `BINARY_SOURCE_RANGE_MISSING`, so source-backed fetch/replay semantics are
   * unchanged, and it scans a resident buffer byte-identically to a plain view.
   */
  findZero(offset, end) {
    const o = this.check(offset, 0);
    const start = BigInt(o);
    let endBig = end == null ? this.lengthBigInt : byteOffset(end);
    if (endBig == null || endBig > this.lengthBigInt) endBig = this.lengthBigInt;
    if (endBig <= start) return -1;
    if (this.view) {
      const nul = this.bytes.subarray(Number(start), Number(endBig)).indexOf(0);
      return nul < 0 ? -1 : Number(start) + nul;
    }
    const blockSize = Number.isSafeInteger(this.bytes.readAheadSize) && this.bytes.readAheadSize > 0
      ? this.bytes.readAheadSize
      : 64 * 1024;
    // Forward scan in windows no wider than the source read-ahead size. Each
    // window allocates at most `scanStep` bytes (so a short terminated name
    // costs O(name) rather than O(strtable tail)); `subarray` still surfaces a
    // genuine cache miss as `BINARY_SOURCE_RANGE_MISSING` so the source-backed
    // fetch loop is unchanged.
    const scanStep = Math.min(blockSize, 4096);
    const scanStepBig = BigInt(scanStep);
    for (let p = start; p < endBig; p += scanStepBig) {
      const remaining = endBig - p;
      const winEnd = p + (scanStepBig < remaining ? scanStepBig : remaining);
      const nul = this.bytes.subarray(exposedOffset(p), exposedOffset(winEnd)).indexOf(0);
      if (nul >= 0) return Number(p) + nul;
    }
    return -1;
  }

  /**
   * Decode the known-bounded byte span [start, end) as UTF-8, allocating only
   * that span. Pair with `findZero` so a caller that has already located the
   * terminator never re-scans (or re-materializes) the wider string table
   * (#8651). Resident spans are plain views, matching `cstring`.
   */
  decodeString(start, end) {
    const o = this.check(start, 0);
    const s = BigInt(o);
    let e = end == null ? this.lengthBigInt : byteOffset(end);
    if (e == null || e > this.lengthBigInt) e = this.lengthBigInt;
    if (e < s) e = s;
    const raw = this.bytes.subarray(exposedOffset(s), exposedOffset(e));
    try { return new TextDecoder('utf-8', { fatal: false }).decode(raw); }
    catch {
      let out = '';
      for (const c of raw) out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\uFFFD';
      return out;
    }
  }

  _lebEnd(end) {
    if (end == null) return this.lengthBigInt;
    const n = byteOffset(end);
    if (n == null || n > this.lengthBigInt)
      throw new BinaryReadError('invalid bounded substream end', this.base);
    return n;
  }

  uleb(offset, maxBytes = 10, end = null) {
    const checkedStart = this.check(offset, 0);
    const startBig = BigInt(checkedStart);
    const hardEndBig = this._lebEnd(end);
    if (startBig > hardEndBig) throw new BinaryReadError('ULEB128 starts outside bounded substream', this.base + startBig);
    const byteLimit = finiteBound(maxBytes, 10);

    if (typeof checkedStart === 'number' && hardEndBig <= MAX_SAFE_BIGINT) {
      const start = checkedStart;
      const hardEnd = Number(hardEndBig);
      let p = start;
      let value = 0n;
      let shift = 0n;
      for (let i = 0; i < byteLimit; i++, p++) {
        if (p >= hardEnd) throw new BinaryReadError('ULEB128 crosses bounded substream', this.base + BigInt(p));
        this.check(p, 1);
        const b = this.u8(p);
        value |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value, next: p + 1, bytes: p + 1 - start };
        shift += 7n;
      }
      throw new BinaryReadError('ULEB128 is too long', this.base + BigInt(start));
    }

    let p = startBig;
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < byteLimit; i++, p++) {
      if (p >= hardEndBig) throw new BinaryReadError('ULEB128 crosses bounded substream', this.base + p);
      this.check(p, 1);
      const b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        const next = p + 1n;
        return { value, next: exposedOffset(next), bytes: Number(next - startBig) };
      }
      shift += 7n;
    }
    throw new BinaryReadError('ULEB128 is too long', this.base + startBig);
  }

  sleb(offset, maxBytes = 10, end = null) {
    const checkedStart = this.check(offset, 0);
    const startBig = BigInt(checkedStart);
    const hardEndBig = this._lebEnd(end);
    if (startBig > hardEndBig) throw new BinaryReadError('SLEB128 starts outside bounded substream', this.base + startBig);
    const byteLimit = finiteBound(maxBytes, 10);

    if (typeof checkedStart === 'number' && hardEndBig <= MAX_SAFE_BIGINT) {
      const start = checkedStart;
      const hardEnd = Number(hardEndBig);
      let p = start;
      let value = 0n;
      let shift = 0n;
      let b = 0;
      for (let i = 0; i < byteLimit; i++, p++) {
        if (p >= hardEnd) throw new BinaryReadError('SLEB128 crosses bounded substream', this.base + BigInt(p));
        this.check(p, 1);
        b = this.u8(p);
        value |= BigInt(b & 0x7f) << shift;
        shift += 7n;
        if ((b & 0x80) === 0) {
          if (b & 0x40) value |= (-1n) << shift;
          return { value, next: p + 1, bytes: p + 1 - start };
        }
      }
      throw new BinaryReadError('SLEB128 is too long', this.base + BigInt(start));
    }

    let p = startBig;
    let value = 0n;
    let shift = 0n;
    let b = 0;
    for (let i = 0; i < byteLimit; i++, p++) {
      if (p >= hardEndBig) throw new BinaryReadError('SLEB128 crosses bounded substream', this.base + p);
      this.check(p, 1);
      b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (b & 0x40) value |= (-1n) << shift;
        const next = p + 1n;
        return { value, next: exposedOffset(next), bytes: Number(next - startBig) };
      }
    }
    throw new BinaryReadError('SLEB128 is too long', this.base + startBig);
  }

}

export function align(value, alignment) {
  const v = integerValue(value, 'value');
  const a = integerValue(alignment, 'alignment');
  if (a <= 0n) return v;
  return (v + a - 1n) / a * a;
}

export function inRange(value, start, size) {
  const v = integerValue(value, 'value');
  const s = integerValue(start, 'start');
  const n = integerValue(size, 'size');
  return n > 0n && v >= s && v < s + n;
}

export function hex(value) {
  if (value == null) return null;
  const integer = integerValue(value, 'value');
  return integer < 0n
    ? '-0x' + (-integer).toString(16).toUpperCase()
    : '0x' + integer.toString(16).toUpperCase();
}
