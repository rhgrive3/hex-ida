import { fail } from './validation-utils.js';

const CHECKSUM_OFFSET = 8;
const SIGNATURE_OFFSET = 12;
const SIGNATURE_SIZE = 20;
const PAYLOAD_OFFSET = SIGNATURE_OFFSET + SIGNATURE_SIZE;
const ADLER_MODULUS = 65521;

function adler32(bytes, offset) {
  let a = 1, b = 0;
  for (let i = offset; i < bytes.length; i++) {
    a = (a + bytes[i]) % ADLER_MODULUS;
    b = (b + a) % ADLER_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}

function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sha1(bytes, offset) {
  const messageLength = bytes.length - offset;
  const paddedLength = (((messageLength + 9 + 63) >> 6) << 6) >>> 0;
  const message = new Uint8Array(paddedLength);
  message.set(bytes.subarray(offset, bytes.length), 0);
  message[messageLength] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(messageLength / 0x20000000), false);
  view.setUint32(paddedLength - 4, (messageLength * 8) >>> 0, false);

  const digest = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const words = new Uint32Array(80);
  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++) {
      words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }
    let a = digest[0], b = digest[1], c = digest[2], d = digest[3], e = digest[4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = rotateLeft(b, 30); b = a; a = temp;
    }
    digest[0] = (digest[0] + a) >>> 0;
    digest[1] = (digest[1] + b) >>> 0;
    digest[2] = (digest[2] + c) >>> 0;
    digest[3] = (digest[3] + d) >>> 0;
    digest[4] = (digest[4] + e) >>> 0;
  }
  const signature = new Uint8Array(SIGNATURE_SIZE);
  const signatureView = new DataView(signature.buffer);
  for (let i = 0; i < digest.length; i++) signatureView.setUint32(i * 4, digest[i], false);
  return signature;
}

export function validateDexIntegrity(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(CHECKSUM_OFFSET, true) !== adler32(bytes, SIGNATURE_OFFSET)) fail('dex-checksum-mismatch');
  const signature = sha1(bytes, PAYLOAD_OFFSET);
  for (let i = 0; i < SIGNATURE_SIZE; i++) {
    if (bytes[SIGNATURE_OFFSET + i] !== signature[i]) fail('dex-signature-mismatch');
  }
}
