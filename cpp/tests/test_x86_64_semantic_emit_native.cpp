#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "targets/x86_64_semantic_emit.hpp"

namespace {

static std::string read_file(const char* path) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open x86_64_3_oracles.json");
  return std::string((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
}

static std::vector<uint8_t> hex_to_bytes(const std::string& hex) {
  assert((hex.size() % 2u) == 0u);
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2u);
  auto nibble = [](char c) -> uint8_t {
    if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(10 + (c - 'a'));
    if (c >= 'A' && c <= 'F') return static_cast<uint8_t>(10 + (c - 'A'));
    assert(false && "invalid hex char");
    return 0u;
  };
  for (size_t i = 0; i < hex.size(); i += 2u) {
    out.push_back(static_cast<uint8_t>((nibble(hex[i]) << 4u) | nibble(hex[i + 1u])));
  }
  return out;
}

static std::string extract_json_string(const std::string& chunk, const char* key) {
  const std::string pat = std::string("\"") + key + "\": \"";
  const size_t pos = chunk.find(pat);
  assert(pos != std::string::npos);
  size_t i = pos + pat.size();
  std::string out;
  while (i < chunk.size()) {
    const char c = chunk[i++];
    if (c == '\\') {
      assert(i < chunk.size());
      const char e = chunk[i++];
      if (e == 'n') out.push_back('\n');
      else if (e == 't') out.push_back('\t');
      else if (e == 'r') out.push_back('\r');
      else out.push_back(e);
    } else if (c == '"') {
      break;
    } else {
      out.push_back(c);
    }
  }
  return out;
}

static std::string find_record_chunk(const std::string& json_text, const char* id) {
  const std::string id_pat = std::string("\"id\": \"") + id + "\"";
  size_t pos = 0;
  while (true) {
    const size_t open = json_text.find('{', pos);
    if (open == std::string::npos) break;
    bool in_str = false;
    int depth = 0;
    size_t close = std::string::npos;
    for (size_t k = open; k < json_text.size(); ++k) {
      const char c = json_text[k];
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
    const std::string chunk = json_text.substr(open, close - open + 1u);
    if (chunk.find(id_pat) != std::string::npos) {
      return chunk;
    }
    pos = close + 1u;
  }
  assert(false && "record id not found in x86_64_3_oracles.json");
  return "";
}

static void test_three_real_oracles_zero_diff() {
  const std::string json_text = read_file("/working_dir/c_50571edcf7098631/x86_64_3_oracles.json");

  struct CaseSpec {
    const char* id;
    uint64_t base_addr;
    uint32_t abi_id;
  };
  const CaseSpec cases[3] = {
      {"x86_64-sysv-elf", 0x401000ULL, 0u},
      {"x86_64-pe-exe", 0x140001000ULL, 1u},
      {"x86_64-macho-o", 0x0ULL, 0u},
  };

  for (const auto& tc : cases) {
    const std::string chunk = find_record_chunk(json_text, tc.id);
    const std::string raw_hex = extract_json_string(chunk, "rawHex");
    const std::string expected = extract_json_string(chunk, "pseudocode");
    const std::vector<uint8_t> bytes = hex_to_bytes(raw_hex);

    const HexStatus st = hex_engine_decompile_x86_64_semantic(
        bytes.data(), static_cast<uint32_t>(bytes.size()), tc.base_addr, tc.abi_id, HEX_EMIT_FLAG_JS_PARITY);
    if (st != HEX_OK) {
      std::fprintf(stderr, "FAIL %s: status=%d\n", tc.id, static_cast<int>(st));
      assert(false);
    }

    const char* ptr = hex_x86_64_semantic_get_text_ptr();
    const uint32_t len = hex_x86_64_semantic_get_text_len();
    const HexLineMapEntry* lm = hex_x86_64_semantic_get_linemap_ptr();
    const uint32_t lm_count = hex_x86_64_semantic_get_linemap_count();

    assert(ptr != nullptr && len > 0u);
    assert(lm != nullptr && lm_count >= 10u);
    assert(lm[0].line_no == 1u && lm[0].addr == tc.base_addr);

    const std::string got(ptr, len);
    if (got != expected) {
      std::fprintf(stderr, "DIFF on %s (got=%zu want=%zu)\n--- WANT ---\n%s\n--- GOT ---\n%s\n",
                   tc.id, got.size(), expected.size(), expected.c_str(), got.c_str());
      assert(false);
    }
    std::printf("  [PASS 0-diff] %s (%u bytes, %u linemap entries)\n", tc.id, len, lm_count);
  }
}

static void test_generalized_immediates_and_fail_closed() {
  // Generalized SysV with cmp_imm = 42 (0x2a) and sub_imm = 3 (0x03)
  std::vector<uint8_t> gen_sysv = hex_to_bytes(
      "554889e54088f048897df88845f7488b45f88b008945f00fb645f70345f08945f0"
      "837df02a0f8e0e0000008b4df0488b45f88908e90c0000008b4df083e903488b45"
      "f88908488b45f88b005dc3");
  assert(hex_engine_decompile_x86_64_semantic(
             gen_sysv.data(), static_cast<uint32_t>(gen_sysv.size()), 0x402000ULL, 0u, 1u) == HEX_OK);
  const std::string gen_out(hex_x86_64_semantic_get_text_ptr(), hex_x86_64_semantic_get_text_len());
  assert(gen_out.find("int32 sub_402000(uint64 a1, uint64 a2)") != std::string::npos);
  assert(gen_out.find("<= 42)") != std::string::npos);
  assert(gen_out.find("32) - 3,") != std::string::npos);

  // Invalid args: null bytes, zero len, invalid abi_id
  assert(hex_engine_decompile_x86_64_semantic(nullptr, 10u, 0x1000ULL, 0u, 1u) == HEX_ERR_INVALID_ARG);
  assert(hex_x86_64_semantic_get_text_ptr() == nullptr && hex_x86_64_semantic_get_text_len() == 0u);
  assert(hex_x86_64_semantic_get_linemap_ptr() == nullptr && hex_x86_64_semantic_get_linemap_count() == 0u);

  assert(hex_engine_decompile_x86_64_semantic(gen_sysv.data(), 0u, 0x1000ULL, 0u, 1u) == HEX_ERR_INVALID_ARG);
  assert(hex_engine_decompile_x86_64_semantic(gen_sysv.data(), static_cast<uint32_t>(gen_sysv.size()), 0x1000ULL, 2u, 1u) == HEX_ERR_INVALID_ARG);

  // Truncated input (incomplete rel32 call: e8 01 00)
  const uint8_t trunc[3] = {0xE8u, 0x01u, 0x00u};
  assert(hex_engine_decompile_x86_64_semantic(trunc, 3u, 0x1000ULL, 0u, 1u) == HEX_ERR_UNSUPPORTED);
  assert(hex_x86_64_semantic_get_text_ptr() == nullptr && hex_x86_64_semantic_get_linemap_count() == 0u);

  // Truncated SysV buffer (drop last byte c3)
  assert(hex_engine_decompile_x86_64_semantic(
             gen_sysv.data(), static_cast<uint32_t>(gen_sysv.size() - 1u), 0x401000ULL, 0u, 1u) == HEX_ERR_UNSUPPORTED);

  // Wrong ABI id (SysV bytes passed with Microsoft x64 abi_id=1)
  assert(hex_engine_decompile_x86_64_semantic(
             gen_sysv.data(), static_cast<uint32_t>(gen_sysv.size()), 0x401000ULL, 1u, 1u) == HEX_ERR_UNSUPPORTED);

  // Mutated JCC opcode (jle 0f 8e -> jg 0f 8f) must fail closed
  std::vector<uint8_t> bad_jcc = gen_sysv;
  bad_jcc[38] = 0x8Fu;
  assert(hex_engine_decompile_x86_64_semantic(
             bad_jcc.data(), static_cast<uint32_t>(bad_jcc.size()), 0x401000ULL, 0u, 1u) == HEX_ERR_UNSUPPORTED);
}

}  // namespace

int main() {
  test_three_real_oracles_zero_diff();
  test_generalized_immediates_and_fail_closed();
  std::printf("test_x86_64_semantic_emit_native (ASan+UBSan, 3/3 0-diff + fail-closed): ALL PASS\n");
  return 0;
}
