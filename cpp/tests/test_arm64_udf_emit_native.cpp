#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../src/decompiler/passes/arm64_udf_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_udf_tail;

namespace {

static std::string read_file(const char* path) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open all_43_functions.json");
  return std::string((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
}

static std::string extract_json_string_field(const std::string& obj, const char* key) {
  const std::string pat = std::string("\"") + key + "\": \"";
  const size_t pos = obj.find(pat);
  assert(pos != std::string::npos);
  size_t i = pos + pat.size();
  std::string out;
  while (i < obj.size()) {
    char c = obj[i++];
    if (c == '\\') {
      assert(i < obj.size());
      char e = obj[i++];
      if (e == 'n') out.push_back('\n');
      else if (e == 't') out.push_back('\t');
      else if (e == 'r') out.push_back('\r');
      else if (e == '"' || e == '\\' || e == '/') out.push_back(e);
      else out.push_back(e);
    } else if (c == '"') {
      break;
    } else {
      out.push_back(c);
    }
  }
  return out;
}

static std::string load_js_code_from_oracle(const std::string& json_text, const char* bin, const char* name) {
  const std::string bin_pat = std::string("\"bin\": \"") + bin + "\"";
  const std::string name_pat = std::string("\"name\": \"") + name + "\"";
  size_t pos = 0;
  while (true) {
    const size_t open = json_text.find('{', pos);
    if (open == std::string::npos) break;
    bool in_str = false;
    int depth = 0;
    size_t close = std::string::npos;
    for (size_t k = open; k < json_text.size(); ++k) {
      char c = json_text[k];
      if (in_str) {
        if (c == '\\') { ++k; }
        else if (c == '"') { in_str = false; }
      } else {
        if (c == '"') { in_str = true; }
        else if (c == '{') { ++depth; }
        else if (c == '}') {
          --depth;
          if (depth == 0) { close = k; break; }
        }
      }
    }
    assert(close != std::string::npos);
    const std::string chunk = json_text.substr(open, close - open + 1);
    if (chunk.find(bin_pat) != std::string::npos && chunk.find(name_pat) != std::string::npos) {
      return extract_json_string_field(chunk, "jsCode");
    }
    pos = close + 1;
  }
  assert(false && "target function not found in all_43_functions.json");
  return "";
}

static void test_copy_word_exact_js_parity() {
  const std::string oracle_text = read_file("/working_dir/c_50571edcf7098631/all_43_functions.json");
  const std::string expected = load_js_code_from_oracle(oracle_text, "arm64-dispatch-table", "copy_word");

  std::vector<uint32_t> words(22u, 0x00000000u);
  words[0] = 0xd1000400u;  // sub x0, x0, #1
  words[1] = 0xd65f03c0u;  // ret

  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = try_emit_arm64_udf_tail(
      words.data(),
      static_cast<uint32_t>(words.size()),
      0x1038ULL,
      "copy_word",
      9u,
      HEX_EMIT_FLAG_JS_PARITY,
      arena,
      &text,
      &len,
      &lm,
      &lm_count);
  assert(st == HEX_OK);
  assert(text != nullptr && text[len] == '\0');
  const std::string got(text, len);
  if (got != expected) {
    std::fprintf(stderr, "DIFF on arm64-dispatch-table::copy_word\n--- EXPECTED ---\n%s\n--- GOT ---\n%s\n",
                 expected.c_str(), got.c_str());
    assert(false);
  }

  // Linemap: 1 (sig) + 2 (return: sub + ret) + 20 (udf traps) = 23
  assert(lm != nullptr && lm_count == 22u);
  assert(lm[0].line_no == 4u && lm[0].addr == 0x1038ULL);
  assert(lm[1].line_no == 6u && lm[1].addr == 0x103cULL);
    assert(lm[2].line_no == 7u && lm[2].addr == 0x1040ULL);
  assert(lm[21].line_no == 26u && lm[21].addr == 0x108cULL);
  std::printf("  [PASS 0-diff] arm64-dispatch-table::copy_word (%u bytes, %u linemap entries)\n",
              len, lm_count);
}

static void test_generic_add_and_udf_count_variants() {
  // Generic ADD with shifted imm (#0x1000), 3 trailing non-zero UDFs, custom name, emit_flags=0
  const uint32_t words[5] = {
      0x91400400u,  // add x0, x0, #0x1000 (sh=1, imm12=1)
      0xd65f03c0u,  // ret
      0x00000001u,  // udf #1
      0x0000beefu,  // udf #0xbeef
      0x0000ffffu,  // udf #0xffff
  };
  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = try_emit_arm64_udf_tail(
      words, 5u, 0x2000ULL, "_bump_page", 10u, HEX_EMIT_FLAG_NONE,
      arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);
  const std::string got(text, len);
  assert(got.find("uint64 bump_page(int64 a1)\n{\n    return a1 + 0x1000;\n") == 0u);
  assert(lm_count == 5u);  // 1 sig + 2 ret + 3 udf
}

static void test_fail_closed_and_oom_rollback() {
  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  const char* text = "stale";
  uint32_t len = 42u;
  const HexLineMapEntry* lm = reinterpret_cast<const HexLineMapEntry*>(0x1);
  uint32_t lm_count = 42u;

  // 1. Invalid args zero-clear outputs
  assert(try_emit_arm64_udf_tail(nullptr, 3u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  const uint32_t valid3[3] = {0xd1000400u, 0xd65f03c0u, 0x00000000u};
  assert(try_emit_arm64_udf_tail(valid3, 0u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(try_emit_arm64_udf_tail(valid3, 3u, 0x1000u, nullptr, 2u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(try_emit_arm64_udf_tail(valid3, 3u, 0x1000u, "f", 1u, 1u, arena, nullptr, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);

  // 2. word_count < 3 or > 64 -> HEX_ERR_UNSUPPORTED
  assert(try_emit_arm64_udf_tail(valid3, 2u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);
  std::vector<uint32_t> too_many(65u, 0x00000000u);
  too_many[0] = 0xd1000400u;
  too_many[1] = 0xd65f03c0u;
  assert(try_emit_arm64_udf_tail(too_many.data(), 65u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);

  // 3. Invalid sh[1]==1, 32-bit sub, non-x0 reg, non-udf tail, PAC retaa
  const uint32_t bad_sh[3] = {0xd1800400u, 0xd65f03c0u, 0x00000000u};
  const uint32_t bad_32[3] = {0x51000400u, 0xd65f03c0u, 0x00000000u};
  const uint32_t bad_reg[3] = {0xd1000420u, 0xd65f03c0u, 0x00000000u};
  const uint32_t bad_tail[3] = {0xd1000400u, 0xd65f03c0u, 0xd503201fu};  // nop
  const uint32_t bad_ret[3] = {0xd1000400u, 0xd65f0bffu, 0x00000000u};   // retaa
  for (const uint32_t* seq : {bad_sh, bad_32, bad_reg, bad_tail, bad_ret}) {
    assert(try_emit_arm64_udf_tail(seq, 3u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
           == HEX_ERR_UNSUPPORTED);
  }

  // 4. Invalid func_name rejected
  for (const char* bn : {"-[Foo bar]", "9bad", "a b", "a\nb"}) {
    assert(try_emit_arm64_udf_tail(
               valid3, 3u, 0x1000u, bn, static_cast<uint32_t>(std::strlen(bn)), 1u,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }

  // 5. OOM rollback preserves prior arena mark
  std::vector<uint8_t> tiny(128);
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny.data(), tiny.size());
  void* keep = tiny_arena.alloc<uint8_t>(16);
  assert(keep != nullptr);
  const size_t mark = tiny_arena.used();
  assert(try_emit_arm64_udf_tail(valid3, 3u, 0x1000u, "f", 1u, 1u, tiny_arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_OOM);
  assert(tiny_arena.used() == mark);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
}

}  // namespace

int main() {
  test_copy_word_exact_js_parity();
  test_generic_add_and_udf_count_variants();
  test_fail_closed_and_oom_rollback();
  std::printf("test_arm64_udf_emit_native (ASan+UBSan, exact 0-diff + fail-closed): ALL PASS\n");
  return 0;
}
