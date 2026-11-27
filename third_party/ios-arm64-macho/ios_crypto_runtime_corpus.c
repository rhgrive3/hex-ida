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
