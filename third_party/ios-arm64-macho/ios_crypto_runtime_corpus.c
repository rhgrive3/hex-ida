typedef unsigned char uint8_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef unsigned long size_t;

static inline uint32_t rotr32(uint32_t x, uint32_t n) { return (x >> n) | (x << (32u - n)); }
static inline uint32_t rotl32(uint32_t x, uint32_t n) { return (x << n) | (x >> (32u - n)); }

/* 1. SHA-256 compression (FIPS 180-4) */
static const uint32_t K256[64] = {
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

void ios_sha256_transform(uint32_t state[8], const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = ((uint32_t)block[i*4] << 24) | ((uint32_t)block[i*4+1] << 16) |
           ((uint32_t)block[i*4+2] << 8) | (uint32_t)block[i*4+3];
  }
  for (int i = 16; i < 64; ++i) {
    uint32_t s0 = rotr32(w[i-15], 7) ^ rotr32(w[i-15], 18) ^ (w[i-15] >> 3);
    uint32_t s1 = rotr32(w[i-2], 17) ^ rotr32(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  uint32_t a=state[0], b=state[1], c=state[2], d=state[3], e=state[4], f=state[5], g=state[6], h=state[7];
  for (int i = 0; i < 64; ++i) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t t1 = h + S1 + ch + K256[i] + w[i];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + maj;
    h = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d;
  state[4]+=e; state[5]+=f; state[6]+=g; state[7]+=h;
}

/* 2. ChaCha20 block (RFC 8439) */
void ios_chacha20_block(uint32_t out[16], const uint32_t in[16]) {
  uint32_t x[16];
  for (int i = 0; i < 16; ++i) x[i] = in[i];
  for (int i = 0; i < 10; ++i) {
    #define QR(a,b,c,d) do { \
      x[a]+=x[b]; x[d]=rotl32(x[d]^x[a],16); \
      x[c]+=x[d]; x[b]=rotl32(x[b]^x[c],12); \
      x[a]+=x[b]; x[d]=rotl32(x[d]^x[a],8);  \
      x[c]+=x[d]; x[b]=rotl32(x[b]^x[c],7);  \
    } while(0)
    QR(0,4,8,12); QR(1,5,9,13); QR(2,6,10,14); QR(3,7,11,15);
    QR(0,5,10,15); QR(1,6,11,12); QR(2,7,8,13); QR(3,4,9,14);
    #undef QR
  }
  for (int i = 0; i < 16; ++i) out[i] = x[i] + in[i];
}

/* 3. CRC32 (IEEE 802.3 / zlib) */
uint32_t ios_crc32_update(uint32_t crc, const uint8_t *buf, size_t len) {
  crc = ~crc;
  for (size_t i = 0; i < len; ++i) {
    crc ^= buf[i];
    for (int j = 0; j < 8; ++j) {
      crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1u)));
    }
  }
  return ~crc;
}

/* 4. Adler-32 (zlib) */
uint32_t ios_adler32_update(uint32_t adler, const uint8_t *buf, size_t len) {
  uint32_t s1 = adler & 0xFFFFu;
  uint32_t s2 = (adler >> 16) & 0xFFFFu;
  for (size_t i = 0; i < len; ++i) {
    s1 = (s1 + buf[i]) % 65521u;
    s2 = (s2 + s1) % 65521u;
  }
  return (s2 << 16) | s1;
}

/* 5. FNV-1a 64-bit */
uint64_t ios_fnv1a64(const uint8_t *buf, size_t len) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (size_t i = 0; i < len; ++i) {
    h ^= (uint64_t)buf[i];
    h *= 0x100000001b3ULL;
  }
  return h;
}

/* 6. Constant-time memory compare (Darwin timingsafe_bcmp) */
int ios_timingsafe_bcmp(const void *b1, const void *b2, size_t n) {
  const uint8_t *p1 = (const uint8_t *)b1;
  const uint8_t *p2 = (const uint8_t *)b2;
  uint32_t diff = 0;
  for (size_t i = 0; i < n; ++i) diff |= (uint32_t)(p1[i] ^ p2[i]);
  return diff != 0;
}

/* 7. Base64 encode (RFC 4648) */
size_t ios_base64_encode(const uint8_t *in, size_t in_len, char *out) {
  static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t i = 0, o = 0;
  while (i + 3 <= in_len) {
    uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i+1] << 8) | in[i+2];
    out[o++] = tbl[(v >> 18) & 63]; out[o++] = tbl[(v >> 12) & 63];
    out[o++] = tbl[(v >> 6) & 63];  out[o++] = tbl[v & 63];
    i += 3;
  }
  if (i < in_len) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < in_len) v |= (uint32_t)in[i+1] << 8;
    out[o++] = tbl[(v >> 18) & 63]; out[o++] = tbl[(v >> 12) & 63];
    out[o++] = (i + 1 < in_len) ? tbl[(v >> 6) & 63] : '=';
    out[o++] = '=';
  }
  out[o] = '\0';
  return o;
}

/* 8. UTF-8 validator */
int ios_utf8_validate(const uint8_t *s, size_t len) {
  size_t i = 0;
  while (i < len) {
    uint8_t c = s[i];
    if (c < 0x80u) { i++; continue; }
    if ((c & 0xE0u) == 0xC0u) {
      if (i + 1 >= len || (s[i+1] & 0xC0u) != 0x80u || c < 0xC2u) return 0;
      i += 2;
    } else if ((c & 0xF0u) == 0xE0u) {
      if (i + 2 >= len || (s[i+1] & 0xC0u) != 0x80u || (s[i+2] & 0xC0u) != 0x80u) return 0;
      i += 3;
    } else if ((c & 0xF8u) == 0xF0u) {
      if (i + 3 >= len || (s[i+1] & 0xC0u) != 0x80u || (s[i+2] & 0xC0u) != 0x80u || (s[i+3] & 0xC0u) != 0x80u) return 0;
      i += 4;
    } else {
      return 0;
    }
  }
  return 1;
}

/* 9. AES-128 MixColumns helper (GF(2^8) xtime) */
void ios_aes_mix_columns(uint8_t s[16]) {
  for (int c = 0; c < 4; ++c) {
    uint8_t a0 = s[c*4], a1 = s[c*4+1], a2 = s[c*4+2], a3 = s[c*4+3];
    uint8_t t = a0 ^ a1 ^ a2 ^ a3;
    uint8_t u = a0;
    uint8_t x0 = a0 ^ a1; x0 = (uint8_t)((x0 << 1) ^ ((x0 & 0x80u) ? 0x1bu : 0u));
    uint8_t x1 = a1 ^ a2; x1 = (uint8_t)((x1 << 1) ^ ((x1 & 0x80u) ? 0x1bu : 0u));
    uint8_t x2 = a2 ^ a3; x2 = (uint8_t)((x2 << 1) ^ ((x2 & 0x80u) ? 0x1bu : 0u));
    uint8_t x3 = a3 ^ u;  x3 = (uint8_t)((x3 << 1) ^ ((x3 & 0x80u) ? 0x1bu : 0u));
    s[c*4]   = a0 ^ t ^ x0;
    s[c*4+1] = a1 ^ t ^ x1;
    s[c*4+2] = a2 ^ t ^ x2;
    s[c*4+3] = a3 ^ t ^ x3;
  }
}

/* 10. Varint / ULEB128 decode (Protobuf / Mach-O dyld trie) */
size_t ios_uleb128_decode(const uint8_t *buf, size_t len, uint64_t *out) {
  uint64_t result = 0;
  uint32_t shift = 0;
  for (size_t i = 0; i < len && i < 10; ++i) {
    uint8_t b = buf[i];
    result |= (uint64_t)(b & 0x7Fu) << shift;
    if ((b & 0x80u) == 0u) { *out = result; return i + 1; }
    shift += 7;
  }
  return 0;
}

/* 11. MurmurHash3 32-bit */
uint32_t ios_murmur3_32(const uint8_t *key, size_t len, uint32_t seed) {
  uint32_t h = seed;
  size_t nblocks = len / 4;
  for (size_t i = 0; i < nblocks; ++i) {
    uint32_t k = ((uint32_t)key[i*4]) | ((uint32_t)key[i*4+1] << 8) |
                 ((uint32_t)key[i*4+2] << 16) | ((uint32_t)key[i*4+3] << 24);
    k *= 0xcc9e2d51u; k = rotl32(k, 15); k *= 0x1b873593u;
    h ^= k; h = rotl32(h, 13); h = h * 5u + 0xe6546b64u;
  }
  h ^= (uint32_t)len;
  h ^= h >> 16; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16;
  return h;
}

/* 12. SipHash-2-4 round helper (Swift Dictionary/Set hashing) */
void ios_sipround(uint64_t v[4]) {
  uint64_t v0=v[0], v1=v[1], v2=v[2], v3=v[3];
  v0 += v1; v1 = (v1 << 13) | (v1 >> 51); v1 ^= v0; v0 = (v0 << 32) | (v0 >> 32);
  v2 += v3; v3 = (v3 << 16) | (v3 >> 48); v3 ^= v2;
  v0 += v3; v3 = (v3 << 21) | (v3 >> 43); v3 ^= v0;
  v2 += v1; v1 = (v1 << 17) | (v1 >> 47); v1 ^= v2; v2 = (v2 << 32) | (v2 >> 32);
  v[0]=v0; v[1]=v1; v[2]=v2; v[3]=v3;
}

/* 13. AES S-Box SubBytes + ShiftRows (FIPS 197) */
static const uint8_t AES_SBOX[256] = {
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
};

void ios_aes128_sub_shift(uint8_t s[16]) {
  for (int i = 0; i < 16; ++i) s[i] = AES_SBOX[s[i]];
  uint8_t t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
}

/* 14. AES-128 Key Expansion */
void ios_aes128_key_expand(const uint8_t key[16], uint8_t rk[176]) {
  static const uint8_t rcon[10] = {0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36};
  for (int i = 0; i < 16; ++i) rk[i] = key[i];
  for (int r = 0; r < 10; ++r) {
    uint8_t *prev = rk + r * 16;
    uint8_t *cur = prev + 16;
    cur[0] = prev[0] ^ AES_SBOX[prev[13]] ^ rcon[r];
    cur[1] = prev[1] ^ AES_SBOX[prev[14]];
    cur[2] = prev[2] ^ AES_SBOX[prev[15]];
    cur[3] = prev[3] ^ AES_SBOX[prev[12]];
    for (int i = 4; i < 16; ++i) cur[i] = prev[i] ^ cur[i - 4];
  }
}

/* 15. RC4 KSA + PRGA */
void ios_rc4_crypt(const uint8_t *key, size_t klen, uint8_t *data, size_t dlen) {
  uint8_t S[256];
  for (int i = 0; i < 256; ++i) S[i] = (uint8_t)i;
  uint8_t j = 0;
  for (int i = 0; i < 256; ++i) {
    j = (uint8_t)(j + S[i] + key[i % klen]);
    uint8_t t = S[i]; S[i] = S[j]; S[j] = t;
  }
  uint8_t a = 0, b = 0;
  for (size_t k = 0; k < dlen; ++k) {
    a = (uint8_t)(a + 1);
    b = (uint8_t)(b + S[a]);
    uint8_t t = S[a]; S[a] = S[b]; S[b] = t;
    data[k] ^= S[(uint8_t)(S[a] + S[b])];
  }
}

/* 16. XXTEA block encrypt (common in iOS games / Cocos2d / Unity) */
void ios_xxtea_encrypt(uint32_t *v, int n, const uint32_t key[4]) {
  if (n < 2) return;
  uint32_t rounds = (uint32_t)(6 + 52 / n);
  uint32_t sum = 0, z = v[n - 1], y;
  while (rounds--) {
    sum += 0x9e3779b9u;
    uint32_t e = (sum >> 2) & 3u;
    for (int p = 0; p < n - 1; ++p) {
      y = v[p + 1];
      z = v[p] += (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p & 3) ^ e] ^ z));
    }
    y = v[0];
    z = v[n - 1] += (((z >> 5) ^ (y << 2)) + ((y >> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[((n - 1) & 3) ^ e] ^ z));
  }
}

/* 17. TEA decrypt */
void ios_tea_decrypt(uint32_t v[2], const uint32_t k[4]) {
  uint32_t v0 = v[0], v1 = v[1], sum = 0xC6EF3720u, delta = 0x9E3779B9u;
  for (int i = 0; i < 32; ++i) {
    v1 -= ((v0 << 4) + k[2]) ^ (v0 + sum) ^ ((v0 >> 5) + k[3]);
    v0 -= ((v1 << 4) + k[0]) ^ (v1 + sum) ^ ((v1 >> 5) + k[1]);
    sum -= delta;
  }
  v[0] = v0; v[1] = v1;
}

/* 18. LZ4 block decompress */
size_t ios_lz4_decompress(const uint8_t *src, size_t src_len, uint8_t *dst, size_t dst_cap) {
  size_t ip = 0, op = 0;
  while (ip < src_len) {
    uint8_t tok = src[ip++];
    size_t lit_len = tok >> 4;
    if (lit_len == 15) {
      while (ip < src_len) { uint8_t s = src[ip++]; lit_len += s; if (s != 255) break; }
    }
    if (ip + lit_len > src_len || op + lit_len > dst_cap) return 0;
    for (size_t i = 0; i < lit_len; ++i) dst[op++] = src[ip++];
    if (ip >= src_len) break;
    if (ip + 2 > src_len) return 0;
    size_t offset = (size_t)src[ip] | ((size_t)src[ip + 1] << 8);
    ip += 2;
    if (offset == 0 || offset > op) return 0;
    size_t match_len = (tok & 0x0Fu) + 4;
    if ((tok & 0x0Fu) == 15) {
      while (ip < src_len) { uint8_t s = src[ip++]; match_len += s; if (s != 255) break; }
    }
    if (op + match_len > dst_cap) return 0;
    for (size_t i = 0; i < match_len; ++i) dst[op + i] = dst[op - offset + i];
    op += match_len;
  }
  return op;
}

/* 19. Hex encode */
size_t ios_hex_encode(const uint8_t *in, size_t len, char *out) {
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < len; ++i) {
    out[i * 2] = hex[(in[i] >> 4) & 0xFu];
    out[i * 2 + 1] = hex[in[i] & 0xFu];
  }
  out[len * 2] = '\0';
  return len * 2;
}

/* 20. Hex decode */
size_t ios_hex_decode(const char *in, size_t len, uint8_t *out) {
  size_t o = 0;
  for (size_t i = 0; i + 1 < len; i += 2) {
    uint8_t hi = (uint8_t)in[i], lo = (uint8_t)in[i + 1];
    hi = (hi >= '0' && hi <= '9') ? (hi - '0') : ((hi | 32) - 'a' + 10);
    lo = (lo >= '0' && lo <= '9') ? (lo - '0') : ((lo | 32) - 'a' + 10);
    out[o++] = (uint8_t)((hi << 4) | (lo & 0xFu));
  }
  return o;
}

/* 21. URL percent decode */
size_t ios_url_percent_decode(const char *in, size_t len, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < len; ++i) {
    if (in[i] == '%' && i + 2 < len) {
      uint8_t hi = (uint8_t)in[i + 1], lo = (uint8_t)in[i + 2];
      hi = (hi >= '0' && hi <= '9') ? (hi - '0') : ((hi | 32) - 'a' + 10);
      lo = (lo >= '0' && lo <= '9') ? (lo - '0') : ((lo | 32) - 'a' + 10);
      out[o++] = (char)((hi << 4) | (lo & 0xFu));
      i += 2;
    } else {
      out[o++] = (in[i] == '+') ? ' ' : in[i];
    }
  }
  out[o] = '\0';
  return o;
}

/* 22. Constant-time secure memzero (memset_s) */
void ios_explicit_bzero(volatile uint8_t *ptr, size_t len) {
  for (size_t i = 0; i < len; ++i) ptr[i] = 0u;
}

/* 23. Poly1305 130-bit clamp helper (RFC 8439) */
void ios_poly1305_clamp(uint8_t r[16]) {
  r[3] &= 15u; r[7] &= 15u; r[11] &= 15u; r[15] &= 15u;
  r[4] &= 252u; r[8] &= 252u; r[12] &= 252u;
}

/* 24. PKCS#7 padding validation (constant-time) */
size_t ios_pkcs7_unpad(const uint8_t *buf, size_t len, size_t block_size) {
  if (len == 0 || (len % block_size) != 0) return 0;
  uint8_t pad = buf[len - 1];
  if (pad == 0 || pad > block_size) return 0;
  uint32_t bad = 0;
  for (size_t i = 0; i < pad; ++i) bad |= (uint32_t)(buf[len - 1 - i] ^ pad);
  return bad == 0 ? (len - pad) : 0;
}
