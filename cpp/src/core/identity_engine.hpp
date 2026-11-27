#ifndef HEX_IDENTITY_ENGINE_HPP
#define HEX_IDENTITY_ENGINE_HPP

#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// Canonical FNV-1a-64 constants matching js/core/identity/fnv64.js and index.js.
static const uint32_t HEX_FNV64_OFFSET_LOW = 0x84222325u;
static const uint32_t HEX_FNV64_OFFSET_HIGH = 0xcbf29ce4u;
static const uint64_t HEX_FNV64_OFFSET_BASIS = 0xcbf29ce484222325ULL;
static const uint64_t HEX_FNV64_OFFSET_SWAPPED = 0x84222325cbf29ce4ULL;
static const uint64_t HEX_FNV64_PRIME = 0x00000100000001b3ULL;

typedef struct HexOriginMergeResult {
  uint8_t* data;      // Concatenated deduplicated origin bytes (Arena-allocated)
  uint32_t* offsets;  // [count + 1] byte offsets into data (Arena-allocated)
  uint32_t count;     // Number of deduplicated origins
  uint32_t byte_len;  // Total byte length of data
} HexOriginMergeResult;

// Resets the active Arena. If an external Arena pointer is bound via bind_global_arena_ptr(),
// resets only that Arena without reverting to &__heap_base.
void HEX_WASM_EXPORT("hex_identity_reset") hex_identity_reset(void);

// Allocates `bytes` from the active Arena (8-byte aligned). Returns nullptr on OOM/0.
void* HEX_WASM_EXPORT("hex_identity_alloc") hex_identity_alloc(uint32_t bytes);

// Computes FNV-1a-64 over raw bytes starting from `seed` (pass HEX_FNV64_OFFSET_BASIS for default).
// Returns 64-bit hash where low 32 bits = (uint32_t)h and high 32 bits = (uint32_t)(h >> 32).
uint64_t HEX_WASM_EXPORT("hex_identity_fnv64_bytes") hex_identity_fnv64_bytes(
    const uint8_t* data,
    uint32_t len,
    uint64_t seed);

// Computes dual FNV-1a-64 (matching js/core/identity/index.js `stableDigest` on canonical text)
// over a UTF-8 string by decoding to UTF-16 code units (exact JS `charCodeAt` semantics).
// Writes 32 lowercase hex ASCII bytes into `out_hex32` (caller must provide >= 32 bytes).
HexStatus HEX_WASM_EXPORT("hex_identity_digest_utf8") hex_identity_digest_utf8(
    const uint8_t* utf8,
    uint32_t len,
    char* out_hex32);

// Byte-native equivalent of `stableDigestBytes(bytes, start, end, maskStart, maskEnd)`.
// Writes 32 lowercase hex ASCII bytes into `out_hex32`.
HexStatus HEX_WASM_EXPORT("hex_identity_digest_bytes") hex_identity_digest_bytes(
    const uint8_t* data,
    uint32_t len,
    uint32_t start,
    uint32_t end,
    int32_t mask_start,
    int32_t mask_end,
    char* out_hex32);

// Canonicalizes a UTF-8 JSON document (key sorting with array-index-first JS semantics,
// -0 -> 0, exact ECMA-262 shortest decimal number formatting, compact output) into
// Arena-allocated UTF-8 bytes returned via `*out_ptr` and `*out_len`.
HexStatus HEX_WASM_EXPORT("hex_identity_stable_stringify") hex_identity_stable_stringify(
    const uint8_t* json_utf8,
    uint32_t len,
    uint8_t** out_ptr,
    uint32_t* out_len);

// Merges two flat-encoded origin string lists (`offsets[i]..offsets[i+1]`),
// deduplicating while preserving first-insertion order (A then B).
// Output buffers are allocated from the active Arena.
HexStatus HEX_WASM_EXPORT("hex_identity_merge_origins") hex_identity_merge_origins(
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    HexOriginMergeResult* out);

// Same as `hex_identity_merge_origins` but sorts the deduplicated keys in canonical
// JS UTF-16 code-unit lexicographical order (matching origin.js `mergeCanonicalLists`).
HexStatus HEX_WASM_EXPORT("hex_identity_merge_origins_sorted") hex_identity_merge_origins_sorted(
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    HexOriginMergeResult* out);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
namespace hex {
namespace identity {

enum class JsonKind : uint8_t {
  Null = 0,
  Undefined = 1,
  Bool = 2,
  Number = 3,
  Int64 = 4,
  String = 5,
  Array = 6,
  Object = 7,
};

struct JsonValue;

struct JsonMember {
  StringView key;
  const JsonValue* value;
};

struct JsonValue {
  JsonKind kind;
  bool bool_val;
  double num_val;
  int64_t int_val;
  StringView str_val;
  const JsonValue* arr_items;
  size_t arr_len;
  const JsonMember* obj_members;
  size_t obj_len;

  static JsonValue make_null() {
    JsonValue v{};
    v.kind = JsonKind::Null;
    return v;
  }
  static JsonValue make_undefined() {
    JsonValue v{};
    v.kind = JsonKind::Undefined;
    return v;
  }
  static JsonValue make_bool(bool b) {
    JsonValue v{};
    v.kind = JsonKind::Bool;
    v.bool_val = b;
    return v;
  }
  static JsonValue make_number(double d) {
    JsonValue v{};
    v.kind = JsonKind::Number;
    v.num_val = d;
    return v;
  }
  static JsonValue make_int64(int64_t i) {
    JsonValue v{};
    v.kind = JsonKind::Int64;
    v.int_val = i;
    return v;
  }
  static JsonValue make_string(StringView s) {
    JsonValue v{};
    v.kind = JsonKind::String;
    v.str_val = s;
    return v;
  }
  static JsonValue make_array(const JsonValue* items, size_t len) {
    JsonValue v{};
    v.kind = JsonKind::Array;
    v.arr_items = items;
    v.arr_len = len;
    return v;
  }
  static JsonValue make_object(const JsonMember* members, size_t len) {
    JsonValue v{};
    v.kind = JsonKind::Object;
    v.obj_members = members;
    v.obj_len = len;
    return v;
  }
};

// Formats a 64-bit FNV hash as 16 lowercase hex chars (high 32 bits then low 32 bits).
void fnv64_to_hex(uint64_t hash, char* out16);

// Arena-backed canonical JSON stringify matching `stableStringify` in js/core/identity/index.js.
HexStatus stable_stringify(Arena& arena, const JsonValue& value, StringView* out);

// Arena-backed canonical digest matching `stableDigest` in js/core/identity/index.js.
HexStatus stable_digest(Arena& arena, const JsonValue& value, char* out_hex32);

// Arena-backed OriginSet merge (dedup + insertion order, optionally canonical UTF-16 sorted).
HexStatus merge_origins_arena(
    Arena& arena,
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    bool sort_canonical,
    HexOriginMergeResult* out);

// Shares an externally-managed Arena pointer (e.g. unified runtime scratch arena).
// While bound, `hex_identity_reset()` resets only the bound arena and never reverts to &__heap_base.
void bind_global_arena_ptr(Arena* arena);

// Binds an external fixed buffer (via Arena::init_fixed) for bounded scratch / OOM testing.
void bind_global_arena(uint8_t* buffer, size_t capacity);

}  // namespace identity
}  // namespace hex
#endif

#endif  // HEX_IDENTITY_ENGINE_HPP
