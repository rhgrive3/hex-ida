#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../src/decompiler/passes/arm64_memory_emit.hpp"

namespace {

static std::string read_file(const char* path) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open all_43_functions.json");
  return std::string((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
}

struct OracleCase {
  const char* bin;
  const char* name;
  uint64_t base_addr;
  std::vector<uint32_t> words;
  std::string expected_js_code;
};

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

static void test_five_memory_functions_and_ltmp0_exact_parity() {
  const std::string oracle_text = read_file("/working_dir/c_50571edcf7098631/all_43_functions.json");

  const OracleCase cases[] = {
      {
          "arm64-threaded-int",
          "entry",
          0x1000ULL,
          {3531865609u, 2432713001u, 4177527785u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "arm64-threaded-int", "entry"),
      },
      {
          "arm64-threaded-mem",
          "copy_word",
          0x1034ULL,
          {4181721097u, 4177526825u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "arm64-threaded-mem", "copy_word"),
      },
      {
          "arm64-semantic-holdout",
          "memory_forward",
          0x1024ULL,
          {3506455551u, 4177527776u, 4181722081u, 2432698400u, 2432713727u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "arm64-semantic-holdout", "memory_forward"),
      },
      {
          "x86_64-stripped-elf",
          "read_fields",
          0x210270ULL,
          {692134920u, 185073952u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "x86_64-stripped-elf", "read_fields"),
      },
      {
          "x86_64-stripped-elf",
          "_ZNK5Thing6updateEi",
          0x2102a8ULL,
          {692134920u, 184615176u, 185139456u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "x86_64-stripped-elf", "_ZNK5Thing6updateEi"),
      },
      {
          "arm64_32-objc",
          "ltmp0",
          0x0ULL,
          {3506455551u, 2852127720u, 3103789032u, 2852193256u, 3103788008u, 1384121664u, 2432713727u, 3596551104u},
          load_js_code_from_oracle(oracle_text, "arm64_32-objc", "ltmp0"),
      },
  };

  std::vector<uint8_t> arena_buf(256 * 1024);
  hex::Arena arena;
  arena.init_fixed(arena_buf.data(), arena_buf.size());

  for (const auto& tc : cases) {
    arena.reset();
    const char* out_text = nullptr;
    uint32_t out_len = 0u;
    const HexLineMapEntry* out_lm = nullptr;
    uint32_t out_lm_count = 0u;

    const HexStatus st = hex::decompiler::passes::try_emit_arm64_memory(
        tc.words.data(),
        static_cast<uint32_t>(tc.words.size()),
        tc.base_addr,
        tc.name,
        static_cast<uint32_t>(std::strlen(tc.name)),
        HEX_EMIT_FLAG_JS_PARITY,
        arena,
        &out_text,
        &out_len,
        &out_lm,
        &out_lm_count);
    if (st != HEX_OK) {
      std::fprintf(stderr, "FAIL %s::%s status=%d\n", tc.bin, tc.name, static_cast<int>(st));
      assert(false);
    }
    const std::string got(out_text, out_len);
    if (got != tc.expected_js_code) {
      std::fprintf(stderr, "DIFF on %s::%s\n--- EXPECTED ---\n%s\n--- GOT ---\n%s\n",
                   tc.bin, tc.name, tc.expected_js_code.c_str(), got.c_str());
      assert(false);
    }
    assert(out_lm != nullptr && out_lm_count >= 2u);
    assert(out_lm[0].addr == tc.base_addr);
    std::printf("  [PASS 0-diff] %s::%s (%u bytes, %u linemap entries)\n",
                tc.bin, tc.name, out_len, out_lm_count);
  }
}

static void test_fail_closed_and_error_guards() {
  std::vector<uint8_t> arena_buf(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(arena_buf.data(), arena_buf.size());

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  // 1. Invalid args
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             nullptr, 1, 0, "f", 1, 1, arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_INVALID_ARG);

  // 2. Pure arithmetic without memory ops -> HEX_ERR_UNSUPPORTED (defer to arithmetic path)
  const uint32_t pure_add[2] = {0x0b010000u, 0xd65f03c0u};
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             pure_add, 2, 0x1000, "add", 3, 1, arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // 3. ObjC method selector -> HEX_ERR_UNSUPPORTED
  const uint32_t copy_w[3] = {4181721097u, 4177526825u, 3596551104u};
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             copy_w, 3, 0x20, "-[Foo count]", 12, 1, arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // 4. Branch / ADRP instruction -> HEX_ERR_UNSUPPORTED
  const uint32_t with_adrp[3] = {2415919113u, 4177526825u, 3596551104u};
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             with_adrp, 3, 0x1000, "f", 1, 1, arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // 5. Unbalanced SP -> HEX_ERR_UNSUPPORTED
  const uint32_t unbalanced[3] = {3506455551u, 4177527776u, 3596551104u};
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             unbalanced, 3, 0x1000, "f", 1, 1, arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // 6. Tiny arena -> HEX_ERR_OOM
  std::vector<uint8_t> tiny(32);
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny.data(), tiny.size());
  assert(hex::decompiler::passes::try_emit_arm64_memory(
             copy_w, 3, 0x1034, "copy_word", 9, 1, tiny_arena, &text, &len, &lm, &lm_cnt) == HEX_ERR_OOM);
}

}  // namespace

int main() {
  test_five_memory_functions_and_ltmp0_exact_parity();
  test_fail_closed_and_error_guards();
  std::printf("test_arm64_memory_emit_native (ASan+UBSan, 6/6 exact 0-diff + fail-closed): ALL PASS\n");
  return 0;
}
