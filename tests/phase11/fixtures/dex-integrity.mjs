// Independent DEX integrity oracle for test fixtures.
// Implements AOSP dex-format constraints G2/G3 from the published specification
// so fixtures never borrow the production implementation they are meant to check.

function adler32(bytes, start) {
  let a = 1, b = 0;
  for (let i = start; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function rotate(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sha1(bytes, start) {
  const length = bytes.length - start;
  const total = (((length + 9 + 63) >> 6) << 6) >>> 0;
  const message = new Uint8Array(total);
  message.set(bytes.subarray(start), 0);
  message[length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(total - 4, (length * 8) >>> 0, false);

  const digest = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Uint32Array(80);
  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = digest;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotate(a, 5) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = temp;
    }
    digest[0] = (digest[0] + a) >>> 0;
    digest[1] = (digest[1] + b) >>> 0;
    digest[2] = (digest[2] + c) >>> 0;
    digest[3] = (digest[3] + d) >>> 0;
    digest[4] = (digest[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  digest.forEach((word, i) => outView.setUint32(i * 4, word, false));
  return out;
}

export function dexAdler32(bytes, start = 12) {
  return adler32(bytes, start);
}

export function dexSha1(bytes, start = 32) {
  return sha1(bytes, start);
}

// Stamp checksum (Adler-32 over bytes 12..EOF) and signature (SHA-1 over bytes
// 32..EOF) so a structurally valid fixture is also an integrity-valid DEX.
export function applyDexIntegrity(bytes) {
  bytes.set(sha1(bytes, 32), 12);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, adler32(bytes, 12), true);
  return bytes;
}
