#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "hex_abi.hpp"
#include "hex_core/hex_core.hpp"
#include "binary/image_store.hpp"
#include "cfg/cfg_engine.hpp"
#include "cfg/loop_engine.hpp"
#include "semantics/resident_ir.hpp"
#include "decompiler/ir_optimizer.hpp"
#include "targets/arm64_decode.hpp"
#include "targets/x86_64_decode.hpp"

namespace {

// Deterministic xorshift64* PRNG (zero external dependencies, reproducible across runs).
struct Rng {
  uint64_t state;
  explicit Rng(uint64_t seed) : state(seed ? seed : 0x9e3779b97f4a7c15ULL) {}

  uint64_t next_u64() {
    uint64_t x = state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    state = x;
    return x * 0x2545f4914f6cdd1dULL;
  }

  uint32_t next_u32() { return static_cast<uint32_t>(next_u64() >> 32); }
  uint8_t next_u8() { return static_cast<uint8_t>(next_u64() >> 56); }
  uint32_t uniform(uint32_t bound) { return bound ? (next_u32() % bound) : 0u; }
};

static std::vector<uint8_t> read_file_bytes(const char* path) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open fixture binary");
  ifs.seekg(0, std::ios::end);
  const std::streamoff sz = ifs.tellg();
  assert(sz > 0);
  ifs.seekg(0, std::ios::beg);
  std::vector<uint8_t> buf(static_cast<size_t>(sz));
  ifs.read(reinterpret_cast<char*>(buf.data()), sz);
  assert(ifs.gcount() == sz);
  return buf;
}

static void write_u32_le(std::vector<uint8_t>& buf, size_t off, uint32_t v) {
  if (off + 4u > buf.size()) return;
  buf[off + 0u] = static_cast<uint8_t>(v & 0xffu);
  buf[off + 1u] = static_cast<uint8_t>((v >> 8) & 0xffu);
  buf[off + 2u] = static_cast<uint8_t>((v >> 16) & 0xffu);
  buf[off + 3u] = static_cast<uint8_t>((v >> 24) & 0xffu);
}

static void write_u32_be(std::vector<uint8_t>& buf, size_t off, uint32_t v) {
  if (off + 4u > buf.size()) return;
  buf[off + 0u] = static_cast<uint8_t>((v >> 24) & 0xffu);
  buf[off + 1u] = static_cast<uint8_t>((v >> 16) & 0xffu);
  buf[off + 2u] = static_cast<uint8_t>((v >> 8) & 0xffu);
  buf[off + 3u] = static_cast<uint8_t>(v & 0xffu);
}

static void write_u64_le(std::vector<uint8_t>& buf, size_t off, uint64_t v) {
  write_u32_le(buf, off, static_cast<uint32_t>(v & 0xffffffffu));
  write_u32_le(buf, off + 4u, static_cast<uint32_t>(v >> 32));
}

// Minimal valid 64-bit Mach-O ARM64 sample (13th corpus seed).
static std::vector<uint8_t> build_minimal_macho_arm64() {
  std::vector<uint8_t> b(512u, 0u);
  write_u32_le(b, 0u, 0xfeedfacfu);   // MH_MAGIC_64
  write_u32_le(b, 4u, 0x0100000cu);   // CPU_TYPE_ARM64
  write_u32_le(b, 8u, 0u);            // CPU_SUBTYPE_ARM64_ALL
  write_u32_le(b, 12u, 2u);           // MH_EXECUTE
  write_u32_le(b, 16u, 1u);           // ncmds
  write_u32_le(b, 20u, 152u);         // sizeofcmds (72 seg + 80 sect)
  // LC_SEGMENT_64 at offset 32
  write_u32_le(b, 32u, 0x19u);        // LC_SEGMENT_64
  write_u32_le(b, 36u, 152u);         // cmdsize
  std::memcpy(&b[40], "__TEXT", 6u);
  write_u64_le(b, 56u, 0x100000000ULL);
  write_u64_le(b, 64u, 0x1000ULL);
  write_u64_le(b, 72u, 0ULL);
  write_u64_le(b, 80u, 512ULL);
  write_u32_le(b, 88u, 5u);
  write_u32_le(b, 92u, 5u);
  write_u32_le(b, 96u, 1u);           // nsects
  // Section __text at offset 104
  std::memcpy(&b[104], "__text", 6u);
  std::memcpy(&b[120], "__TEXT", 6u);
  write_u64_le(b, 136u, 0x100000100ULL);
  write_u64_le(b, 144u, 8ULL);
  write_u32_le(b, 152u, 256u);        // offset
  // Code at offset 256: add w0, w0, w1; ret
  write_u32_le(b, 256u, 0x0b010000u);
  write_u32_le(b, 260u, 0xd65f03c0u);
  return b;
}

static void exercise_image_loader(
    hex::Arena& img_arena,
    hex::Arena& scratch_arena,
    const uint8_t* data,
    size_t len,
    uint32_t& ok_opens) {
  img_arena.reset();
  scratch_arena.reset();

  HexImageHandle handle = 0u;
  const HexStatus st = hex_image_open(data, static_cast<uint32_t>(len), &handle);
  if (st != HEX_OK) {
    assert(handle == 0u);
    return;
  }
  ++ok_opens;

  HexImageInfo info{};
  assert(hex_image_get_info(handle, &info) == HEX_OK);
  uint32_t sec_count = 0u;
  assert(hex_image_section_count(handle, &sec_count) == HEX_OK);
  assert(sec_count == info.section_count);

  const uint32_t probe_limit = sec_count < 64u ? sec_count : 64u;
  for (uint32_t i = 0u; i < probe_limit; ++i) {
    HexSectionInfo sec{};
    assert(hex_image_get_section(handle, i, &sec) == HEX_OK);
    // Ensure NUL termination within fixed buffers
    assert(sec.name[63] == '\0' || std::memchr(sec.name, '\0', 64u) != nullptr);
    assert(sec.segname[31] == '\0' || std::memchr(sec.segname, '\0', 32u) != nullptr);
  }
  // Out-of-bounds section index must fail closed
  HexSectionInfo oob_sec{};
  assert(hex_image_get_section(handle, sec_count, &oob_sec) != HEX_OK);
  assert(hex_image_close(handle) == HEX_OK);
}

static void run_binary_loader_fuzz(Rng& rng) {
  static constexpr const char* kFixturePaths[12] = {
      "tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf",
      "tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf",
      "tests/scpa/fixtures/threaded-integer.elf",
      "tests/scpa/fixtures/threaded-call-memory.elf",
      "tests/scpa/fixtures/dispatch-table.elf",
      "tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf",
      "tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o",
      "tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf",
      "tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe",
      "tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o",
      "tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf",
      "tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe",
  };

  std::vector<std::vector<uint8_t>> seeds;
  seeds.reserve(13u);
  for (const char* p : kFixturePaths) {
    seeds.push_back(read_file_bytes(p));
  }
  seeds.push_back(build_minimal_macho_arm64());
  assert(seeds.size() == 13u);

  std::vector<uint8_t> img_mem(4u * 1024u * 1024u);
  std::vector<uint8_t> scratch_mem(1u * 1024u * 1024u);
  hex::Arena img_arena;
  hex::Arena scratch_arena;
  img_arena.init_fixed(img_mem.data(), img_mem.size());
  scratch_arena.init_fixed(scratch_mem.data(), scratch_mem.size());
  hex::binary::bind_global_arenas(&img_arena, &scratch_arena);

  uint32_t total_cases = 0u;
  uint32_t ok_opens = 0u;

  // 1. Original + head/mid/tail truncations (50 per seed = 650 cases)
  for (const auto& seed : seeds) {
    exercise_image_loader(img_arena, scratch_arena, seed.data(), seed.size(), ok_opens);
    ++total_cases;
    for (uint32_t t = 0u; t < 49u; ++t) {
      std::vector<uint8_t> mut;
      const uint32_t mode = t % 3u;
      if (mode == 0u) {
        // Tail truncation
        const size_t new_len = rng.uniform(static_cast<uint32_t>(seed.size()));
        mut.assign(seed.begin(), seed.begin() + static_cast<std::ptrdiff_t>(new_len));
      } else if (mode == 1u) {
        // Head truncation
        const size_t skip = rng.uniform(static_cast<uint32_t>(seed.size()));
        mut.assign(seed.begin() + static_cast<std::ptrdiff_t>(skip), seed.end());
      } else {
        // Mid slice removal
        const size_t cut_pos = rng.uniform(static_cast<uint32_t>(seed.size()));
        const size_t cut_len = 1u + rng.uniform(static_cast<uint32_t>(seed.size() - cut_pos));
        mut.insert(mut.end(), seed.begin(), seed.begin() + static_cast<std::ptrdiff_t>(cut_pos));
        mut.insert(mut.end(), seed.begin() + static_cast<std::ptrdiff_t>(cut_pos + cut_len), seed.end());
      }
      exercise_image_loader(img_arena, scratch_arena, mut.data(), mut.size(), ok_opens);
      ++total_cases;
    }
  }

  // 2. Bit flips & header field corruption (80 per seed = 1,040 cases)
  for (const auto& seed : seeds) {
    for (uint32_t m = 0u; m < 80u; ++m) {
      std::vector<uint8_t> mut = seed;
      const uint32_t flips = 1u + rng.uniform(8u);
      for (uint32_t f = 0u; f < flips; ++f) {
        const size_t idx = (m < 40u && mut.size() > 128u)
                               ? rng.uniform(128u)
                               : rng.uniform(static_cast<uint32_t>(mut.size()));
        mut[idx] ^= static_cast<uint8_t>(1u << rng.uniform(8u));
      }
      exercise_image_loader(img_arena, scratch_arena, mut.data(), mut.size(), ok_opens);
      ++total_cases;
    }
  }

  // 3. Targeted ELF SHT_NOBITS / PT_LOAD / e_shoff / e_shnum / e_phnum mutants (300 cases)
  const auto& elf_seed = seeds[0];
  for (uint32_t i = 0u; i < 300u; ++i) {
    std::vector<uint8_t> mut = elf_seed;
    const uint32_t kind = i % 5u;
    if (kind == 0u) {
      write_u64_le(mut, 40u, rng.next_u64());  // e_shoff
    } else if (kind == 1u) {
      write_u64_le(mut, 32u, rng.next_u64());  // e_phoff
    } else if (kind == 2u) {
      write_u32_le(mut, 56u, rng.next_u32());  // e_phnum / e_shentsize
      write_u32_le(mut, 60u, rng.next_u32());  // e_shnum / e_shstrndx
    } else if (kind == 3u) {
      // Corrupt section header table entries (SHT_NOBITS = 8, sh_offset, sh_size)
      if (mut.size() > 256u) {
        const size_t off = mut.size() - 256u + rng.uniform(240u);
        write_u32_le(mut, off, (i & 1u) ? 8u : rng.next_u32());
      }
    } else {
      // Corrupt program header PT_LOAD bounds
      if (mut.size() > 120u) {
        write_u64_le(mut, 64u + rng.uniform(48u), rng.next_u64());
      }
    }
    exercise_image_loader(img_arena, scratch_arena, mut.data(), mut.size(), ok_opens);
    ++total_cases;
  }

  // 4. Targeted Mach-O Fat abnormal slices (300 cases)
  for (uint32_t i = 0u; i < 300u; ++i) {
    const size_t sz = 8u + rng.uniform(512u);
    std::vector<uint8_t> fat(sz, 0u);
    write_u32_be(fat, 0u, (i & 1u) ? 0xcafebabeu : 0xcafebabfu);
    const uint32_t nfat = (i % 4u == 0u) ? 0xffffffffu : rng.uniform(16u);
    write_u32_be(fat, 4u, nfat);
    for (size_t off = 8u; off + 4u <= sz; off += 4u) {
      write_u32_be(fat, off, rng.next_u32());
    }
    exercise_image_loader(img_arena, scratch_arena, fat.data(), fat.size(), ok_opens);
    ++total_cases;
  }

  // 5. Targeted PE abnormal headers (200 cases)
  const auto& pe_seed = seeds[8];
  for (uint32_t i = 0u; i < 200u; ++i) {
    std::vector<uint8_t> mut = pe_seed;
    if (i % 3u == 0u) {
      write_u32_le(mut, 0x3cu, rng.next_u32());  // e_lfanew
    } else if (i % 3u == 1u) {
      write_u32_le(mut, 0x84u, rng.next_u32());  // COFF NumberOfSections
    } else {
      const size_t off = rng.uniform(static_cast<uint32_t>(mut.size() - 4u));
      write_u32_le(mut, off, rng.next_u32());
    }
    exercise_image_loader(img_arena, scratch_arena, mut.data(), mut.size(), ok_opens);
    ++total_cases;
  }

  // 6. Pure random byte buffers (350 cases, lengths 0..4096)
  for (uint32_t i = 0u; i < 350u; ++i) {
    const size_t sz = (i == 0u) ? 0u : rng.uniform(4096u);
    std::vector<uint8_t> rnd(sz);
    for (size_t j = 0u; j < sz; ++j) rnd[j] = rng.next_u8();
    exercise_image_loader(img_arena, scratch_arena, rnd.data(), rnd.size(), ok_opens);
    ++total_cases;
  }

  assert(total_cases >= 2785u);
  std::printf("  [PASS] binary loader fuzz: %u cases (%u opened cleanly, 0 crash/UB/leak)\n",
              total_cases, ok_opens);
}

static void run_decoders_and_ir_pipeline_fuzz(Rng& rng) {
  static constexpr uint32_t kNumFunctions = 5000u;

  std::vector<uint8_t> cfg_buf(2u * 1024u * 1024u);
  std::vector<uint8_t> ir_buf(4u * 1024u * 1024u);
  std::vector<uint8_t> ir_scratch_buf(2u * 1024u * 1024u);
  hex::Arena cfg_arena;
  hex::Arena ir_arena;
  hex::Arena ir_scratch;
  cfg_arena.init_fixed(cfg_buf.data(), cfg_buf.size());
  ir_arena.init_fixed(ir_buf.data(), ir_buf.size());
  ir_scratch.init_fixed(ir_scratch_buf.data(), ir_scratch_buf.size());

  std::vector<uint32_t> arm_words;
  std::vector<HexArm64Decoded> arm_out(32u);
  std::vector<uint8_t> arm_kinds(32u);

  std::vector<uint8_t> x86_bytes;
  std::vector<HexX86Decoded> x86_out(64u);

  uint64_t total_arm_insns = 0u;
  uint64_t total_x86_insns = 0u;
  uint64_t total_ir_opt_ok = 0u;

  for (uint32_t fn_idx = 0u; fn_idx < kNumFunctions; ++fn_idx) {
    // (A) Random ARM64 instruction stream
    const uint32_t arm_n = 1u + rng.uniform(32u);
    arm_words.resize(arm_n);
    for (uint32_t i = 0u; i < arm_n; ++i) arm_words[i] = rng.next_u32();
    const uint64_t arm_pc = (fn_idx % 10u == 0u)
                                ? (UINT64_MAX - static_cast<uint64_t>(rng.uniform(32u)))
                                : (static_cast<uint64_t>(rng.next_u32()) << 2);
    assert(hex_arm64_decode_batch(arm_words.data(), arm_n, arm_pc, arm_out.data()) == HEX_OK);
    assert(hex_arm64_classify_batch(arm_words.data(), arm_n, arm_kinds.data()) == HEX_OK);
    for (uint32_t i = 0u; i < arm_n; ++i) {
      assert(arm_out[i].kind == arm_kinds[i]);
      const int32_t sup = hex_arm64_is_decompiler_supported(arm_words[i]);
      assert(sup == 0 || sup == 1);
      assert(arm_out[i].cap == static_cast<uint8_t>(sup ? HEX_ARM64_CAP_DECOMP : HEX_ARM64_CAP_FALLBACK));
    }
    total_arm_insns += arm_n;

    // (B) Random x86_64 byte stream (biased towards prefixes/0F/ModRM on half the cases)
    const uint32_t x86_len = rng.uniform(65u);
    x86_bytes.resize(x86_len);
    for (uint32_t i = 0u; i < x86_len; ++i) {
      if ((fn_idx & 1u) && rng.uniform(4u) == 0u) {
        static constexpr uint8_t kHotBytes[] = {
            0x48, 0x49, 0x4c, 0x66, 0xf0, 0xf3, 0x0f, 0x89, 0x8b, 0x8d,
            0x83, 0xe8, 0xe9, 0xeb, 0x74, 0x8e, 0xc3, 0x55, 0x5d, 0x90,
        };
        x86_bytes[i] = kHotBytes[rng.uniform(sizeof(kHotBytes))];
      } else {
        x86_bytes[i] = rng.next_u8();
      }
    }
    uint32_t x86_cnt = 0u;
    const HexStatus xst = hex_x86_64_decode_batch(
        x86_bytes.data(), x86_len, 0x401000ULL, x86_out.data(), 64u, &x86_cnt);
    assert(xst == HEX_OK || xst == HEX_ERR_RESOURCE_LIMIT);
    const uint32_t xsup = hex_x86_64_is_decompiler_supported(x86_bytes.data(), x86_len);
    assert(xsup == 0u || xsup == 1u);
    total_x86_insns += x86_cnt;

    // (C) Random CFG + Loop + Resident IR + SSA + IR Optimizer
    const uint32_t n = 1u + rng.uniform(20u);
    std::vector<uint32_t> succ_off(n + 1u, 0u);
    std::vector<int32_t> succ_dst;
    for (uint32_t b = 0u; b < n; ++b) {
      const uint32_t deg = rng.uniform(4u);  // 0..3 outgoing edges
      for (uint32_t e = 0u; e < deg; ++e) {
        succ_dst.push_back(static_cast<int32_t>(rng.uniform(n)));
      }
      succ_off[b + 1u] = static_cast<uint32_t>(succ_dst.size());
    }

    cfg_arena.reset();
    HexCfgResult cfg_res{};
    assert(hex_cfg_analyze_arena(cfg_arena, n, succ_off.data(),
                                 succ_dst.empty() ? nullptr : succ_dst.data(),
                                 0, nullptr, &cfg_res) == HEX_OK);

    cfg_arena.reset();
    HexLoopResult loop_res{};
    assert(hex_loop_analyze_arena(cfg_arena, n, succ_off.data(),
                                  succ_dst.empty() ? nullptr : succ_dst.data(),
                                  0, nullptr, nullptr, &loop_res) == HEX_OK);

    ir_arena.reset();
    ir_scratch.reset();
    auto& store = hex::ir::default_store();
    store.init(&ir_arena, &ir_scratch);
    HexIrHandle h = 0u;
    assert(store.create(0u, &h) == HEX_OK);
    for (uint32_t b = 0u; b < n; ++b) {
      uint32_t bid = 0u;
      assert(store.add_block(h, &bid) == HEX_OK);
      assert(bid == b);
    }
    for (uint32_t b = 0u; b < n; ++b) {
      for (uint32_t e = succ_off[b]; e < succ_off[b + 1u]; ++e) {
        assert(store.add_edge(h, b, static_cast<uint32_t>(succ_dst[e])) == HEX_OK);
      }
    }
    for (uint32_t b = 0u; b < n; ++b) {
      const uint32_t ninst = 1u + rng.uniform(6u);
      for (uint32_t k = 0u; k < ninst; ++k) {
        const uint16_t op = static_cast<uint16_t>(rng.uniform(12u));
        const uint16_t flags = static_cast<uint16_t>(rng.uniform(11u) | ((rng.next_u8() & 1u) ? HEX_IR_FLAG_WIDTH32 : 0u));
        const uint32_t dst = (op == HEX_IR_OP_STORE || op == HEX_IR_OP_BR || op == HEX_IR_OP_CBR || op == HEX_IR_OP_RET || op == HEX_IR_OP_NOP)
                                 ? HEX_IR_NONE
                                 : rng.uniform(8u);
        const uint32_t a0 = (op == HEX_IR_OP_CONST || op == HEX_IR_OP_NOP || op == HEX_IR_OP_BR) ? HEX_IR_NONE : rng.uniform(8u);
        const uint32_t a1 = (op == HEX_IR_OP_BIN || op == HEX_IR_OP_CMP || op == HEX_IR_OP_STORE) ? rng.uniform(8u) : HEX_IR_NONE;
        uint32_t iid = 0u;
        assert(store.add_inst(h, b, op, flags, dst, a0, a1, HEX_IR_NONE, rng.next_u64(), &iid) == HEX_OK);
      }
    }
    assert(store.run_cfg_and_ssa(h) == HEX_OK);
    HexIrStats stats{};
    assert(store.get_stats(h, &stats) == HEX_OK);
    assert(stats.cfg_ready == 1u && stats.ssa_ready == 1u);

    uint32_t changed = 0u;
    const HexStatus ost = hex_decomp_optimize_ir(h, 8u, &changed);
    assert(ost == HEX_OK || ost == HEX_ERR_RESOURCE_LIMIT);
    if (ost == HEX_OK) ++total_ir_opt_ok;
    assert(store.release(h) == HEX_OK);
  }

  std::printf("  [PASS] 5,000 random functions fuzz: arm64=%llu insns, x86_64=%llu insns, ir_opt_converged=%llu/5000 (0 crash/UB/OOB/leak)\n",
              static_cast<unsigned long long>(total_arm_insns),
              static_cast<unsigned long long>(total_x86_insns),
              static_cast<unsigned long long>(total_ir_opt_ok));
}

}  // namespace

int main() {
  Rng rng(0x20261125cafe1234ULL);
  std::printf("Running test_fuzz_robustness_native (ASan+UBSan)...\n");
  run_binary_loader_fuzz(rng);
  run_decoders_and_ir_pipeline_fuzz(rng);
  std::printf("test_fuzz_robustness_native: ALL PASS\n");
  return 0;
}
