#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>

#include "decompiler/passes/arm64_frame_helpers.hpp"

namespace {

using namespace hex::decompiler::passes::frame_util;

void test_stp_ldp_fp_lr() {
  uint32_t bytes = 0u;

  // Valid 16-byte aligned frames: #-16, #-32, #-48, #-512
  assert(decode_stp_fp_lr_pre(0xA9BF7BFDu, &bytes) && bytes == 16u);   // stp x29, x30, [sp, #-16]!
  assert(decode_stp_fp_lr_pre(0xA9BE7BFDu, &bytes) && bytes == 32u);   // stp x29, x30, [sp, #-32]!
  assert(decode_stp_fp_lr_pre(0xA9BD7BFDu, &bytes) && bytes == 48u);   // stp x29, x30, [sp, #-48]!
  assert(decode_stp_fp_lr_pre(0xA9A07BFDu, &bytes) && bytes == 512u);  // stp x29, x30, [sp, #-512]!
  assert(decode_stp_fp_lr_pre(0xA9BF7BFDu, nullptr));                  // null out_frame_bytes OK

  assert(decode_ldp_fp_lr_post(0xA8C17BFDu, &bytes) && bytes == 16u);   // ldp x29, x30, [sp], #16
  assert(decode_ldp_fp_lr_post(0xA8C27BFDu, &bytes) && bytes == 32u);   // ldp x29, x30, [sp], #32
  assert(decode_ldp_fp_lr_post(0xA8C37BFDu, &bytes) && bytes == 48u);   // ldp x29, x30, [sp], #48
  assert(decode_ldp_fp_lr_post(0xA8DF7BFDu, &bytes) && bytes == 496u);  // ldp x29, x30, [sp], #496 (imm7=62)
  assert(decode_ldp_fp_lr_post(0xA8C17BFDu, nullptr));

  // Reject unaligned 8-byte / 24-byte frames (imm7 = -1 => 8B, imm7 = -3 => 24B, imm7 = +1 => 8B, +3 => 24B)
  assert(!decode_stp_fp_lr_pre(0xA9BF7BFDu | (1u << 15u), &bytes));  // imm7 = -1 (-8B)
  const uint32_t stp_m24 = 0xA9800000u | ((0x7Du & 0x7Fu) << 15u) | (30u << 10u) | (31u << 5u) | 29u;
  assert(!decode_stp_fp_lr_pre(stp_m24, &bytes));
  const uint32_t ldp_p8 = 0xA8C00000u | (1u << 15u) | (30u << 10u) | (31u << 5u) | 29u;
  const uint32_t ldp_p24 = 0xA8C00000u | (3u << 15u) | (30u << 10u) | (31u << 5u) | 29u;
  assert(!decode_ldp_fp_lr_post(ldp_p8, &bytes));
  assert(!decode_ldp_fp_lr_post(ldp_p24, &bytes));

  // Reject wrong sign, zero offset, non-x29/x30, non-sp base, non-pre/post mode
  const uint32_t stp_pos = 0xA9800000u | (2u << 15u) | (30u << 10u) | (31u << 5u) | 29u;
  const uint32_t stp_zero = 0xA9800000u | (30u << 10u) | (31u << 5u) | 29u;
  const uint32_t stp_x0_x1 = 0xA9BF07E0u;
  const uint32_t ldp_neg = 0xA8FF7BFDu;
  const uint32_t stp_signed_off = 0xA9007BFDu;  // non-pre-indexed
  assert(!decode_stp_fp_lr_pre(stp_pos, &bytes));
  assert(!decode_stp_fp_lr_pre(stp_zero, &bytes));
  assert(!decode_stp_fp_lr_pre(stp_x0_x1, &bytes));
  assert(!decode_ldp_fp_lr_post(ldp_neg, &bytes));
  assert(!decode_stp_fp_lr_pre(stp_signed_off, &bytes));

  std::printf("  [PASS] decode_stp_fp_lr_pre / decode_ldp_fp_lr_post\n");
}

void test_bl_adrp_blr() {
  uint64_t target = 0ULL;
  uint8_t reg = 0u;

  // BL forward & backward
  assert(decode_bl_target(0x94000004u, 0x104Cu, &target) && target == 0x105Cu);
  assert(decode_bl_target(0x9400002Eu, 0x100000484ULL, &target) && target == 0x10000053CULL);
  assert(decode_bl_target(0x97FFFFFFu, 0x2000ULL, &target) && target == 0x1FFCULL);  // -4
  // Reject unconditional B (0x14000004) and NOP
  assert(!decode_bl_target(0x14000004u, 0x1000ULL, &target));
  assert(!decode_bl_target(0xD503201Fu, 0x1000ULL, &target));

  // ADRP positive, zero, negative page delta
  assert(decode_adrp_target(0x90000000u, 0x10000047CULL, &reg, &target) &&
         reg == 0u && target == 0x100000000ULL);
  assert(decode_adrp_target(0xB0000001u, 0x10000047CULL, &reg, &target) &&
         reg == 1u && target == 0x100001000ULL);  // immlo=1 => +1 page
  assert(decode_adrp_target(0xF0FFFFE2u, 0x10000547CULL, &reg, &target) &&
         reg == 2u && target == 0x100004000ULL);  // imm=-1 => -1 page
  // Reject ADR (bit 31 == 0) and ADRP xzr (rd == 31)
  assert(!decode_adrp_target(0x10000000u, 0x1000ULL, &reg, &target));
  assert(!decode_adrp_target(0x9000001Fu, 0x1000ULL, &reg, &target));

  // BLR canonical registers
  assert(decode_blr_reg(0xD63F0100u, &reg) && reg == 8u);   // blr x8
  assert(decode_blr_reg(0xD63F0120u, &reg) && reg == 9u);   // blr x9
  assert(decode_blr_reg(0xD63F0160u, &reg) && reg == 11u);  // blr x11
  // Strictly reject PAC BLRAA / BLRAB / BLRAAZ / BLRABZ, BR, RET, BLR XZR
  assert(!decode_blr_reg(0xD73F0800u, &reg));  // blraa x0, x0
  assert(!decode_blr_reg(0xD73F0C00u, &reg));  // blrab x0, x0
  assert(!decode_blr_reg(0xD63F081Fu, &reg));  // blraaz x0
  assert(!decode_blr_reg(0xD63F0C1Fu, &reg));  // blrabz x0
  assert(!decode_blr_reg(0xD61F0100u, &reg));  // br x8
  assert(!decode_blr_reg(0xD65F03C0u, &reg));  // ret
  assert(!decode_blr_reg(0xD63F03E0u, &reg));  // blr xzr

  std::printf("  [PASS] decode_bl_target / decode_adrp_target / decode_blr_reg (PAC rejected)\n");
}

void test_symbol_validation_and_stack_slot_formatting() {
  // Valid C symbol names
  assert(is_valid_c_symbol_name("direct_call", 11u));
  assert(is_valid_c_symbol_name("_greet", 6u));
  assert(is_valid_c_symbol_name("_ZNK5Thing8interactEP4Base", 26u));
  assert(is_valid_c_symbol_name("sub_1000", 8u));
  assert(is_valid_c_symbol_name("_", 1u));

  // Invalid names: ObjC selectors, newlines, spaces, NULs, leading digits, empty/null
  assert(!is_valid_c_symbol_name(nullptr, 0u));
  assert(!is_valid_c_symbol_name(nullptr, 4u));
  assert(!is_valid_c_symbol_name("", 0u));
  assert(!is_valid_c_symbol_name("-[Foo bar:]", 11u));
  assert(!is_valid_c_symbol_name("+[Cls init]", 11u));
  assert(!is_valid_c_symbol_name("foo\nbar", 7u));
  assert(!is_valid_c_symbol_name("foo\rbar", 7u));
  assert(!is_valid_c_symbol_name("foo bar", 7u));
  assert(!is_valid_c_symbol_name("foo;bar", 7u));
  assert(!is_valid_c_symbol_name("1abc", 4u));
  const char with_nul[5] = {'a', 'b', '\0', 'c', 'd'};
  assert(!is_valid_c_symbol_name(with_nul, 5u));

  // Stack slot formatting (JS oracle parity: local_0, local_m<HEX>, local_p<HEX>, var_<HEX>, var_m<HEX>)
  char buf[64];
  assert(format_signed_stack_slot(0, buf, sizeof(buf)) == 7u && std::strcmp(buf, "local_0") == 0);
  assert(format_signed_stack_slot(-16, buf, sizeof(buf)) == 9u && std::strcmp(buf, "local_m10") == 0);
  assert(format_signed_stack_slot(-8, buf, sizeof(buf)) == 8u && std::strcmp(buf, "local_m8") == 0);
  assert(format_signed_stack_slot(-24, buf, sizeof(buf)) == 9u && std::strcmp(buf, "local_m18") == 0);
  assert(format_signed_stack_slot(-160, buf, sizeof(buf)) == 9u && std::strcmp(buf, "local_mA0") == 0);
  assert(format_signed_stack_slot(16, buf, sizeof(buf)) == 9u && std::strcmp(buf, "local_p10") == 0);
  assert(format_signed_stack_slot(0x1AB, buf, sizeof(buf)) == 10u && std::strcmp(buf, "local_p1AB") == 0);
  // INT64_MIN UB-free check
  assert(format_signed_stack_slot(std::numeric_limits<int64_t>::min(), buf, sizeof(buf)) == 23u &&
         std::strcmp(buf, "local_m8000000000000000") == 0);

  // var_ formatting
  assert(format_var_stack_slot(0, buf, sizeof(buf)) == 5u && std::strcmp(buf, "var_0") == 0);
  assert(format_var_stack_slot(0x10, buf, sizeof(buf)) == 6u && std::strcmp(buf, "var_10") == 0);
  assert(format_var_stack_slot(-0x2A, buf, sizeof(buf)) == 7u && std::strcmp(buf, "var_m2A") == 0);

  // Insufficient buffer capacity fails safely
  char tiny[4];
  assert(format_signed_stack_slot(-16, tiny, sizeof(tiny)) == 0u && tiny[0] == '\0');
  assert(format_signed_stack_slot(0, tiny, sizeof(tiny)) == 0u && tiny[0] == '\0');
  assert(format_signed_stack_slot(-16, nullptr, 16u) == 0u);
  assert(format_signed_stack_slot(-16, buf, 0u) == 0u);

  std::printf("  [PASS] is_valid_c_symbol_name / format_signed_stack_slot / format_var_stack_slot\n");
}

void test_arena_rollback_guard() {
  alignas(16) uint8_t storage[512];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  void* base_alloc = arena.alloc_bytes(32u, 8u);
  assert(base_alloc != nullptr);
  const size_t base_used = arena.used();

  // 1. Automatic rollback on scope exit
  {
    ArenaRollbackGuard guard(arena);
    assert(guard.active() && guard.mark() == base_used);
    assert(arena.alloc_bytes(64u, 8u) != nullptr);
    assert(arena.used() > base_used);
  }
  assert(arena.used() == base_used);

  // 2. Explicit commit preserves allocation
  size_t committed_used = 0u;
  {
    ArenaRollbackGuard guard(arena);
    assert(arena.alloc_bytes(48u, 8u) != nullptr);
    committed_used = arena.used();
    guard.commit();
    assert(!guard.active());
  }
  assert(arena.used() == committed_used && committed_used > base_used);

  // 3. Explicit rollback before scope exit is idempotent
  {
    ArenaRollbackGuard guard(arena);
    assert(arena.alloc_bytes(64u, 8u) != nullptr);
    guard.rollback();
    assert(!guard.active() && arena.used() == committed_used);
    guard.rollback();  // idempotent
  }
  assert(arena.used() == committed_used);

  std::printf("  [PASS] ArenaRollbackGuard RAII rollback / commit / idempotence\n");
}

}  // namespace

int main() {
  std::printf("Running test_arm64_frame_helpers_native...\n");
  test_stp_ldp_fp_lr();
  test_bl_adrp_blr();
  test_symbol_validation_and_stack_slot_formatting();
  test_arena_rollback_guard();
  std::printf("test_arm64_frame_helpers_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
