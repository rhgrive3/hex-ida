const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_K = new Int32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted'); error.name = 'AbortError'; return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason ?? abortError(); }
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('sha256 bytes must be an ArrayBuffer or view');
}

export class IncrementalSha256 {
  constructor() {
    this.state = Uint32Array.from(SHA256_INITIAL);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0n;
    this.finalized = false;
    this.words = new Int32Array(64);
  }

  update(input) {
    if (this.finalized) throw new Error('sha256-already-finalized');
    const bytes = asBytes(input);
    this.bytesHashed += BigInt(bytes.byteLength);
    let offset = 0;
    if (this.bufferLength) {
      const take = Math.min(64 - this.bufferLength, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) { this.#transform(this.buffer, 0); this.bufferLength = 0; }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.#transform(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }
    return this;
  }

  #transform(chunk, base) {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const j = base + (i << 2);
      w[i] = (chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const s = this.state;
    let a = s[0] | 0, b = s[1] | 0, c = s[2] | 0, d = s[3] | 0;
    let e = s[4] | 0, f = s[5] | 0, g = s[6] | 0, h = s[7] | 0;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0;
    s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
    s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0;
    s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
  }

  digest() {
    if (this.finalized) throw new Error('sha256-already-finalized');
    this.finalized = true;
    const bitLength = this.bytesHashed * 8n;
    let n = this.bufferLength;
    this.buffer[n++] = 0x80;
    if (n > 56) {
      this.buffer.fill(0, n, 64);
      this.#transform(this.buffer, 0);
      n = 0;
    }
    this.buffer.fill(0, n, 56);
    for (let i = 0; i < 8; i++) this.buffer[63 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
    this.#transform(this.buffer, 0);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const word = this.state[i];
      out[i*4]=word>>>24; out[i*4+1]=(word>>>16)&0xff; out[i*4+2]=(word>>>8)&0xff; out[i*4+3]=word&0xff;
    }
    return out;
  }

  hexDigest() { return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
}

export async function sha256BlobHex(blob, options = {}) {
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0 || typeof blob.slice !== 'function') throw new TypeError('sha256 source must be a Blob/File-like object with a safe integer size');
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new TypeError('chunkBytes must be a positive safe integer');
  const signal = options.signal ?? null;
  const hash = new IncrementalSha256();
  let reads = 0, bytesRead = 0, largestRead = 0;
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    throwIfAborted(signal);
    const end = Math.min(blob.size, offset + chunkBytes);
    const part = blob.slice(offset, end);
    if (!part || typeof part.arrayBuffer !== 'function') throw new TypeError('sha256 source slices must provide arrayBuffer()');
    const bytes = new Uint8Array(await part.arrayBuffer());
    throwIfAborted(signal);
    if (bytes.byteLength !== end - offset) throw new Error(`sha256 truncated read: expected ${end - offset}, received ${bytes.byteLength}`);
    hash.update(bytes);
    reads++;
    bytesRead += bytes.byteLength;
    largestRead = Math.max(largestRead, bytes.byteLength);
    if (typeof options.onProgress === 'function') options.onProgress({ bytesRead, totalBytes:blob.size, reads });
  }
  throwIfAborted(signal);
  return Object.freeze({ hex:hash.hexDigest(), bytesRead, reads, largestRead, chunkBytes });
}