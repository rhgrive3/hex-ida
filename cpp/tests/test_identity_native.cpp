#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../src/core/identity_engine.hpp"

namespace {

static std::vector<uint8_t> hex_to_bytes(const char* hex) {
  const size_t n = std::strlen(hex);
  assert(n % 2 == 0);
  std::vector<uint8_t> out(n / 2);
  auto nib = [](char c) -> uint8_t {
    if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(10 + (c - 'a'));
    if (c >= 'A' && c <= 'F') return static_cast<uint8_t>(10 + (c - 'A'));
    assert(false && "invalid hex char");
    return 0;
  };
  for (size_t i = 0; i < out.size(); ++i) {
    out[i] = static_cast<uint8_t>((nib(hex[2 * i]) << 4) | nib(hex[2 * i + 1]));
  }
  return out;
}

static bool try_read_file_slice(const char* path, size_t offset, size_t len, std::vector<uint8_t>& out) {
  std::ifstream ifs(path, std::ios::binary);
  if (!ifs.good()) return false;
  ifs.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
  out.resize(len);
  ifs.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(len));
  return static_cast<size_t>(ifs.gcount()) == len;
}

struct CorpusCase {
  const char* id;
  const char* file;
  size_t file_off;
  size_t file_len;
  const char* base_hex;
  int64_t insn_count;
  uint32_t expected_low;
  uint32_t expected_high;
  const char* expected_digest_hex;
  const char* expected_sdb;
  const char* expected_sdb_masked;
};

static const char* kMachoSampleTextHex =
    "0000010bc0035fd6007c001bc0035fd602008052210080523f00006b8c0000544200010b21040011fcffff17e003022a"
    "c0035fd6fd7bbfa9fd03009100000090002015912e000094fd7bc1a8c0035fd6fd7bbea9fd030091e00b00f9082040b9"
    "092440b9297c091b0801094b082000b91f0100718c00005408008052e00b40f9082000b9e80f00b90000009000d01691"
    "1b000094e00f40b9fd7bc2a8c0035fd6fd7bbca9fd0300916000805281008052d4ffff97e00b00b940018052d5ffff97"
    "e10b40b90000010be00f00b9daffff97800c8052e03300b960008052e03700b9e0430091e1008052daffff97e00f40b9"
    "fd7bc4a8c0035fd61f2003d5";

static void test_golden_identity_outputs() {
  const CorpusCase cases[7] = {
      {"macho-sample-arm64", nullptr, 1088, 252, "100000440", 63,
       3585297279u, 2224909344u, "257e81e5a520269ac73df1902ece3a65",
       "71f56db4d4c6e15ee4b03345dca0a221", "c2c25120a16c5a1f6220bd329ce2ea58"},
      {"arm64-semantic-holdout", "tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf", 4096, 108, "1000", 27,
       2812290836u, 2352876964u, "835e0e6a54a868f5db459f12845f5be4",
       "e2c57455ddda57a0dd3c5b84ea33fcd5", "3c7b7e38c8242c3814a4e6a6096237cf"},
      {"arm64-fpsimd-holdout", "tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf", 4096, 68, "1000", 17,
       3711121755u, 3660246965u, "07164c16952f5bf095ae739443335303",
       "1ede0410760331bfccfe9bd9c14ac328", "ed7613650ed0fb6825c9f9f8d9dfa57b"},
      {"arm64-threaded-int", "tests/scpa/fixtures/threaded-integer.elf", 4096, 24, "1000", 6,
       2321862702u, 1938435157u, "573991d4f6ba5d6e3205e9c07f37f157",
       "f64f3e95861bfcedff8151640a5309e2", "20df82ba6434b0e7893c1b3dd6626dc6"},
      {"arm64-threaded-mem", "tests/scpa/fixtures/threaded-call-memory.elf", 4096, 64, "1000", 16,
       976119833u, 3754175414u, "dbd098063ce24a6b4fbf560d81743954",
       "60b1b7c25286586ff43170cff645d64e", "276f0bd895e887ebe496e54fbe733a7c"},
      {"arm64-dispatch-table", "tests/scpa/fixtures/dispatch-table.elf", 4096, 144, "1000", 36,
       2977900043u, 3444706280u, "2eeeefb271a5dfec17367c03eef858e1",
       "e56febf1944e6f7616abfc023cf92fd3", "f3f3c82807f7b9535e2179eface6576a"},
      {"arm64-gnu-b-key-cfi", "tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf", 176, 20, "4000b0", 5,
       20408619u, 13988229u, "a9efb6a411c6a893067bc46ab2b96060",
       "6559ed81431326624830731dda64edfb", "425f1bc6dc777734f912e0fccd428c23"},
  };

  std::vector<uint8_t> arena_buf(1024 * 1024);
  hex::Arena arena;
  arena.init_external(arena_buf.data(), arena_buf.size());

  const char* kExpectedCanonical = "{\"a\":[1,0,null,true,\"hex\"],\"b\":2,\"c\":{\"y\":8,\"z\":9}}";

  for (const auto& s : cases) {
    std::vector<uint8_t> raw;
    if (s.file) {
      assert(try_read_file_slice(s.file, s.file_off, s.file_len, raw));
    } else {
      raw = hex_to_bytes(kMachoSampleTextHex);
    }
    assert(raw.size() == s.file_len);

    const uint64_t h = hex_identity_fnv64_bytes(raw.data(), static_cast<uint32_t>(raw.size()), HEX_FNV64_OFFSET_BASIS);
    assert(static_cast<uint32_t>(h & 0xffffffffULL) == s.expected_low);
    assert(static_cast<uint32_t>(h >> 32) == s.expected_high);

    const uint32_t split = static_cast<uint32_t>(raw.size() / 3);
    const uint64_t h1 = hex_identity_fnv64_bytes(raw.data(), split, HEX_FNV64_OFFSET_BASIS);
    const uint64_t h2 = hex_identity_fnv64_bytes(raw.data() + split, static_cast<uint32_t>(raw.size()) - split, h1);
    assert(h2 == h);

    arena.reset();
    using hex::identity::JsonMember;
    using hex::identity::JsonValue;
    const JsonValue v_binary = JsonValue::make_string(s.id);
    const JsonValue v_len = JsonValue::make_int64(static_cast<int64_t>(raw.size()));
    const JsonValue v_base = JsonValue::make_string(s.base_hex);
    const JsonValue v_insns = JsonValue::make_int64(s.insn_count);
    const JsonMember members[4] = {
        {"binary", &v_binary},
        {"len", &v_len},
        {"base", &v_base},
        {"insnCount", &v_insns},
    };
    const JsonValue obj = JsonValue::make_object(members, 4);

    char digest_hex[33] = {};
    assert(hex::identity::stable_digest(arena, obj, digest_hex) == HEX_OK);
    assert(std::string(digest_hex, 32) == s.expected_digest_hex);

    hex::StringView canonical_json;
    assert(hex::identity::stable_stringify(arena, obj, &canonical_json) == HEX_OK);
    char utf8_hex[33] = {};
    assert(hex_identity_digest_utf8(
               reinterpret_cast<const uint8_t*>(canonical_json.data()),
               static_cast<uint32_t>(canonical_json.size()),
               utf8_hex) == HEX_OK);
    assert(std::string(utf8_hex, 32) == s.expected_digest_hex);

    hex_identity_reset();
    const char* raw_json = "{\"b\":2,\"a\":[1,-0,null,true,\"hex\"],\"c\":{\"z\":9,\"y\":8}}";
    uint8_t* c_out_ptr = nullptr;
    uint32_t c_out_len = 0u;
    assert(hex_identity_stable_stringify(
               reinterpret_cast<const uint8_t*>(raw_json),
               static_cast<uint32_t>(std::strlen(raw_json)),
               &c_out_ptr,
               &c_out_len) == HEX_OK);
    assert(std::string(reinterpret_cast<const char*>(c_out_ptr), c_out_len) == kExpectedCanonical);

    char sdb_hex[33] = {};
    assert(hex_identity_digest_bytes(
               raw.data(), static_cast<uint32_t>(raw.size()),
               0u, static_cast<uint32_t>(raw.size()), -1, -1, sdb_hex) == HEX_OK);
    assert(std::string(sdb_hex, 32) == s.expected_sdb);

    char sdb_masked_hex[33] = {};
    assert(hex_identity_digest_bytes(
               raw.data(), static_cast<uint32_t>(raw.size()),
               4u, static_cast<uint32_t>(raw.size()) - 4u, 8, 12, sdb_masked_hex) == HEX_OK);
    assert(std::string(sdb_masked_hex, 32) == s.expected_sdb_masked);
  }
}

static void test_js_number_parity() {
  struct NumCase {
    double value;
    const char* expected;
  };
  const double qnan = hex::js::bits_to_f64(0x7ff8000000000000ULL);
  const double pinf = hex::js::bits_to_f64(0x7ff0000000000000ULL);
  const double ninf = hex::js::bits_to_f64(0xfff0000000000000ULL);
  const NumCase cases[] = {
      {0.0, "0"},
      {-0.0, "0"},
      {1.0, "1"},
      {-1.0, "-1"},
      {42.0, "42"},
      {-42.0, "-42"},
      {1.15, "1.15"},
      {0.1, "0.1"},
      {0.2, "0.2"},
      {0.3, "0.3"},
      {0.1 + 0.2, "0.30000000000000004"},
      {1e-6, "0.000001"},
      {1e-7, "1e-7"},
      {-1e-7, "-1e-7"},
      {1e20, "100000000000000000000"},
      {1e21, "1e+21"},
      {-1e21, "-1e+21"},
      {9007199254740991.0, "9007199254740991"},
      {-9007199254740991.0, "-9007199254740991"},
      {9007199254740992.0, "9007199254740992"},
      {0.1234567890123456, "0.1234567890123456"},
      {1.2345678901234567e-10, "1.2345678901234568e-10"},
      {1.2345678901234567e25, "1.2345678901234566e+25"},
      {5e-324, "5e-324"},
      {2.2250738585072014e-308, "2.2250738585072014e-308"},
      {1.7976931348623157e308, "1.7976931348623157e+308"},
      {1e-5, "0.00001"},
      {9.999999999999999e-7, "0.000001"},
      {1e19, "10000000000000000000"},
      {9.999999999999999e20, "999999999999999900000"},
      {3.141592653589793, "3.141592653589793"},
      {2.718281828459045, "2.718281828459045"},
      {0.5, "0.5"},
      {0.25, "0.25"},
      {1.5, "1.5"},
      {qnan, "null"},
      {pinf, "null"},
      {ninf, "null"},
  };

  std::vector<uint8_t> arena_buf(256 * 1024);
  hex::Arena arena;
  arena.init_external(arena_buf.data(), arena_buf.size());

  for (const auto& tc : cases) {
    arena.reset();
    const hex::identity::JsonValue v = hex::identity::JsonValue::make_number(tc.value);
    hex::StringView out;
    assert(hex::identity::stable_stringify(arena, v, &out) == HEX_OK);
    const std::string got(out.data(), out.size());
    if (got != tc.expected) {
      std::fprintf(stderr, "MISMATCH: expected '%s', got '%s'\n", tc.expected, got.c_str());
      assert(false);
    }
  }
}

static void test_null_guards_and_depth_limit() {
  std::vector<uint8_t> arena_buf(256 * 1024);
  hex::Arena arena;
  arena.init_external(arena_buf.data(), arena_buf.size());

  hex::StringView out;
  assert(hex::identity::stable_stringify(arena, hex::identity::JsonValue::make_array(nullptr, 3), &out) == HEX_ERR_INVALID_ARG);
  assert(hex::identity::stable_stringify(arena, hex::identity::JsonValue::make_object(nullptr, 2), &out) == HEX_ERR_INVALID_ARG);
  assert(hex::identity::stable_stringify(arena, hex::identity::JsonValue::make_string(hex::StringView(nullptr, 4)), &out) == HEX_ERR_INVALID_ARG);

  std::vector<hex::identity::JsonValue> chain(130);
  chain[129] = hex::identity::JsonValue::make_int64(7);
  for (int i = 128; i >= 0; --i) {
    chain[static_cast<size_t>(i)] = hex::identity::JsonValue::make_array(&chain[static_cast<size_t>(i + 1)], 1);
  }
  arena.reset();
  assert(hex::identity::stable_stringify(arena, chain[1], &out) == HEX_OK);
  arena.reset();
  assert(hex::identity::stable_stringify(arena, chain[0], &out) == HEX_ERR_RESOURCE_LIMIT);

  uint8_t* p = nullptr;
  uint32_t l = 0;
  assert(hex_identity_stable_stringify(nullptr, 5, &p, &l) == HEX_ERR_INVALID_ARG);
  assert(hex_identity_stable_stringify(reinterpret_cast<const uint8_t*>("{}"), 2, nullptr, &l) == HEX_ERR_INVALID_ARG);
}

static void pack_strings(const std::vector<std::string>& items,
                         std::vector<uint8_t>& data,
                         std::vector<uint32_t>& offsets) {
  data.clear();
  offsets.clear();
  uint32_t cur = 0;
  for (const auto& s : items) {
    offsets.push_back(cur);
    data.insert(data.end(), s.begin(), s.end());
    cur += static_cast<uint32_t>(s.size());
  }
  offsets.push_back(cur);
}

static void test_merge_origins_and_bind_arena_ptr() {
  // Verify bind_global_arena_ptr shares external Arena and hex_identity_reset() does NOT revert it.
  std::vector<uint8_t> shared_buf(64 * 1024);
  hex::Arena shared_arena;
  shared_arena.init_fixed(shared_buf.data(), shared_buf.size());
  hex::identity::bind_global_arena_ptr(&shared_arena);

  void* p1 = hex_identity_alloc(128);
  assert(p1 != nullptr);
  assert(shared_arena.used() >= 128);
  assert(reinterpret_cast<uint8_t*>(p1) >= shared_buf.data() &&
         reinterpret_cast<uint8_t*>(p1) < shared_buf.data() + shared_buf.size());

  hex_identity_reset();
  assert(shared_arena.used() == 0);

  void* p2 = hex_identity_alloc(64);
  assert(p2 == p1);  // Still allocating from shared_arena, did not revert to default arena!
  assert(shared_arena.used() >= 64);

  std::vector<uint8_t> da, db;
  std::vector<uint32_t> oa, ob;
  pack_strings({"ins_b", "ins_a", "ins_b", "ins_c"}, da, oa);
  pack_strings({"ins_a", "ins_d", "ins_c", "ins_e", "ins_d"}, db, ob);

  HexOriginMergeResult res{};
  assert(hex_identity_merge_origins(da.data(), oa.data(), 4u, db.data(), ob.data(), 5u, &res) == HEX_OK);
  const std::vector<std::string> expected_ins = {"ins_b", "ins_a", "ins_c", "ins_d", "ins_e"};
  assert(res.count == expected_ins.size());
  for (size_t i = 0; i < expected_ins.size(); ++i) {
    assert(std::string(reinterpret_cast<const char*>(res.data + res.offsets[i]),
                       res.offsets[i + 1] - res.offsets[i]) == expected_ins[i]);
  }

  HexOriginMergeResult sorted{};
  assert(hex_identity_merge_origins_sorted(da.data(), oa.data(), 4u, db.data(), ob.data(), 5u, &sorted) == HEX_OK);
  const std::vector<std::string> expected_sorted = {"ins_a", "ins_b", "ins_c", "ins_d", "ins_e"};
  assert(sorted.count == expected_sorted.size());
  for (size_t i = 0; i < expected_sorted.size(); ++i) {
    assert(std::string(reinterpret_cast<const char*>(sorted.data + sorted.offsets[i]),
                       sorted.offsets[i + 1] - sorted.offsets[i]) == expected_sorted[i]);
  }

  // Unbind and test fixed OOM arena
  hex::identity::bind_global_arena_ptr(nullptr);
  std::vector<uint8_t> tiny(16);
  hex::identity::bind_global_arena(tiny.data(), tiny.size());
  assert(hex_identity_alloc(128) == nullptr);
  HexOriginMergeResult oom_res{};
  assert(hex_identity_merge_origins(da.data(), oa.data(), 4u, nullptr, nullptr, 0u, &oom_res) == HEX_ERR_OOM);
  hex_identity_reset();
  assert(hex_identity_alloc(128) == nullptr);  // Still fixed tiny arena after reset!
}

}  // namespace

int main() {
  test_golden_identity_outputs();
  test_js_number_parity();
  test_null_guards_and_depth_limit();
  test_merge_origins_and_bind_arena_ptr();
  std::printf("test_identity_native (ASan+UBSan, 7/7 golden + 38 JS floats + bind_global_arena_ptr): ALL PASS\n");
  return 0;
}
