#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../src/decompiler/passes/arm64_frame_vcall_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_frame_vcall;

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

static void test_two_vcall_functions_exact_js_parity() {
  const std::string oracle_text = read_file("/working_dir/c_50571edcf7098631/all_43_functions.json");

  struct Case {
    const char* bin;
    const char* name;
    uint64_t base_addr;
    std::vector<uint32_t> words;
    uint64_t expected_blr_va;
    uint64_t expected_ret_va;
  };

  const Case cases[2] = {
      {
          "x86_64-stripped-elf",
          "virtual_call",
          0x21027cULL,
          {
              0xa9bf7bfdu,  // stp x29, x30, [sp, #-0x10]!
              0x910003fdu,  // mov x29, sp
              0xf9400008u,  // ldr x8, [x0]
              0x528000e1u,  // mov w1, #7
              0xf9400108u,  // ldr x8, [x8]
              0xd63f0100u,  // blr x8
              0xa8c17bfdu,  // ldp x29, x30, [sp], #0x10
              0xd65f03c0u,  // ret
          },
          0x210290ULL,
          0x210298ULL,
      },
      {
          "x86_64-stripped-elf",
          "_ZNK5Thing8interactEP4Base",
          0x2102bcULL,
          {
              0xa9bf7bfdu,  // stp x29, x30, [sp, #-0x10]!
              0x910003fdu,  // mov x29, sp
              0xf9400029u,  // ldr x9, [x1]
              0xaa0103e8u,  // mov x8, x1
              0xb9400c01u,  // ldr w1, [x0, #0xc]
              0xaa0803e0u,  // mov x0, x8
              0xf9400129u,  // ldr x9, [x9]
              0xd63f0120u,  // blr x9
              0xa8c17bfdu,  // ldp x29, x30, [sp], #0x10
              0xd65f03c0u,  // ret
          },
          0x2102d8ULL,
          0x2102e0ULL,
      },
  };

  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  for (const auto& tc : cases) {
    arena.reset();
    const std::string expected = load_js_code_from_oracle(oracle_text, tc.bin, tc.name);

    const char* text = nullptr;
    uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_count = 0u;

    const HexStatus st = try_emit_arm64_frame_vcall(
        tc.words.data(),
        static_cast<uint32_t>(tc.words.size()),
        tc.base_addr,
        tc.name,
        static_cast<uint32_t>(std::strlen(tc.name)),
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
      std::fprintf(stderr, "DIFF on %s::%s\n--- EXPECTED ---\n%s\n--- GOT ---\n%s\n",
                   tc.bin, tc.name, expected.c_str(), got.c_str());
      assert(false);
    }

    assert(lm != nullptr && lm_count == 6u);
    assert(lm[0].line_no == 12u && lm[0].addr == tc.base_addr);        // sig
    assert(lm[1].line_no == 19u && lm[1].addr == tc.base_addr);        // local_m10
    assert(lm[2].line_no == 20u && lm[2].addr == tc.base_addr);        // local_m8
    assert(lm[3].line_no == 21u && lm[3].addr == tc.expected_blr_va);  // unknown_call
    assert(lm[4].line_no == 22u && lm[4].addr == tc.expected_blr_va);  // return (blr)
    assert(lm[5].line_no == 22u && lm[5].addr == tc.expected_ret_va);  // return (ret)

    std::printf("  [PASS 0-diff] %s::%s (%u bytes, %u linemap entries)\n",
                tc.bin, tc.name, len, lm_count);
  }
}

static void test_generic_register_and_frame_variants() {
  // Different scratch register (x10), frame size 0x20, non-zero vtable slot offset (+0x10),
  // custom name, and non-parity mode (emit_flags = 0).
  const uint32_t words[8] = {
      0xa9be7bfdu,  // stp x29, x30, [sp, #-0x20]!
      0x910003fdu,  // mov x29, sp
      0xf940000au,  // ldr x10, [x0]
      0x52800142u,  // mov w2, #10
      0xf940094au,  // ldr x10, [x10, #0x10]
      0xd63f0140u,  // blr x10
      0xa8c27bfdu,  // ldp x29, x30, [sp], #0x20
      0xd65f03c0u,  // ret
  };
  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = try_emit_arm64_frame_vcall(
      words, 8u, 0x4000ULL, "dispatch_slot2", 14u, HEX_EMIT_FLAG_NONE,
      arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);
  const std::string got(text, len);
  assert(got.find("uint64 dispatch_slot2(uint64 a1)\n") == 0u);
  assert(got.find("local_m20 = local_x29;\n") != std::string::npos);
  assert(got.find("local_m18 = local_x30;\n") != std::string::npos);
  assert(got.find("call_69 = unknown_call(a1);\n") != std::string::npos);
}

static void test_pac_rejection_fail_closed_and_oom_rollback() {
  std::vector<uint8_t> storage(64 * 1024);
  hex::Arena arena;
  arena.init_fixed(storage.data(), storage.size());

  const char* sentinel_text = "stale";
  const char* text = sentinel_text;
  uint32_t len = 99u;
  const HexLineMapEntry* lm = reinterpret_cast<const HexLineMapEntry*>(0x1);
  uint32_t lm_count = 99u;

  // 1. Null / invalid args zero-clear outputs
  assert(try_emit_arm64_frame_vcall(nullptr, 8u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  const uint32_t valid8[8] = {
      0xa9bf7bfdu, 0x910003fdu, 0xf9400008u, 0x528000e1u,
      0xf9400108u, 0xd63f0100u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  assert(try_emit_arm64_frame_vcall(valid8, 0u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(try_emit_arm64_frame_vcall(valid8, 8u, 0x1000u, nullptr, 3u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(try_emit_arm64_frame_vcall(valid8, 8u, 0x1000u, "f", 1u, 1u, arena, nullptr, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);

  // 2. PAC indirect call variants MUST be strictly rejected
  const uint32_t pac_blrs[4] = {
      0xd73f0900u,  // blraa x8, x0
      0xd73f0d00u,  // blrab x8, x0
      0xd63f091fu,  // blraaz x8
      0xd63f0d1fu,  // blrabz x8
  };
  for (uint32_t pac_word : pac_blrs) {
    uint32_t mutated[8];
    std::memcpy(mutated, valid8, sizeof(valid8));
    mutated[5] = pac_word;
    const size_t before = arena.used();
    assert(try_emit_arm64_frame_vcall(mutated, 8u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
           == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == before);
    assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  // 3. Invalid function names rejected
  const char* bad_names[] = {"-[Foo bar]", "+[Foo baz]", "123bad", "bad name", "bad\nname", "a:b"};
  for (const char* bn : bad_names) {
    assert(try_emit_arm64_frame_vcall(
               valid8, 8u, 0x1000u, bn, static_cast<uint32_t>(std::strlen(bn)), 1u,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }

  // 4. Mismatched frame size rejected
  uint32_t bad_frame[8];
  std::memcpy(bad_frame, valid8, sizeof(valid8));
  bad_frame[6] = 0xa8c27bfdu;  // ldp [sp], #0x20 vs stp [sp, #-0x10]!
  assert(try_emit_arm64_frame_vcall(bad_frame, 8u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);

  // 5. OOM rollback preserves prior arena mark
  std::vector<uint8_t> tiny(128);
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny.data(), tiny.size());
  void* keep = tiny_arena.alloc<uint8_t>(16);
  assert(keep != nullptr);
  const size_t mark = tiny_arena.used();
  assert(try_emit_arm64_frame_vcall(valid8, 8u, 0x1000u, "f", 1u, 1u, tiny_arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_OOM);
  assert(tiny_arena.used() == mark);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
}

}  // namespace

int main() {
  test_two_vcall_functions_exact_js_parity();
  test_generic_register_and_frame_variants();
  test_pac_rejection_fail_closed_and_oom_rollback();
  std::printf("test_arm64_frame_vcall_emit_native (ASan+UBSan, 2/2 exact 0-diff + PAC/OOM fail-closed): ALL PASS\n");
  return 0;
}
