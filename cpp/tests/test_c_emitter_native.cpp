#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../src/decompiler/c_emitter.hpp"

static CEmitInst make_inst(uint8_t op,
                           uint8_t flags,
                           uint16_t width,
                           uint32_t dst,
                           uint32_t src0,
                           uint32_t src1,
                           uint32_t src2,
                           uint64_t imm,
                           uint64_t addr) {
  CEmitInst i{};
  i.op = op;
  i.flags = flags;
  i.width = width;
  i.dst = dst;
  i.src0 = src0;
  i.src1 = src1;
  i.src2 = src2;
  i.imm = imm;
  i.addr = addr;
  return i;
}

static bool contains(const char* haystack, const char* needle) {
  return haystack != nullptr && needle != nullptr && strstr(haystack, needle) != nullptr;
}

static uint32_t find_line_number_containing(const char* text, const char* needle) {
  const char* hit = strstr(text, needle);
  if (!hit) return 0u;
  uint32_t line = 1u;
  for (const char* p = text; p < hit; ++p) {
    if (*p == '\n') ++line;
  }
  return line;
}

static void test_js_parity_add_and_hex(void) {
  // int32 add_fn(uint64 a1, uint64 a2) { return a1 + a2; }
  const CEmitInst insts[] = {
    make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x1000),
    make_inst(HEX_IR_PARAM, 0, 64, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 1, 0x1000),
    make_inst(HEX_IR_BINOP, HEX_IR_BIN_ADD, 64, 2, 0, 1, HEX_IR_NO_VAL, 0, 0x1004),
    make_inst(HEX_IR_RET, 0, 32, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x1008),
  };
  const uint32_t off[] = {0, 4};
  const uint32_t soff[] = {0, 0};

  CEmitFunctionView v{};
  v.func_name = "add_fn";
  v.func_name_len = 6;
  v.entry_va = 0x1000;
  v.num_params = 2;
  v.ret_width = 32;
  v.ret_is_signed = 1;
  v.num_blocks = 1;
  v.entry_block = 0;
  v.block_inst_off = off;
  v.insts = insts;
  v.num_insts = 4;
  v.succ_off = soff;

  assert(hex_decomp_emit_c_ex(&v, 65536, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
  const char* txt = hex_decomp_get_text_ptr();
  assert(txt != nullptr);
  assert(hex_decomp_get_text_len() == strlen(txt));
  assert(contains(txt, "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */"));
  assert(contains(txt, "typedef __INT32_TYPE__ int32;\n"));
  assert(contains(txt, "typedef __UINT64_TYPE__ uint64;\n"));
  assert(contains(txt, "int32 add_fn(uint64 a1, uint64 a2) {\n"));
  assert(contains(txt, "    return a1 + a2;\n"));

  // Verify uppercase hex literal 0xFFFFFFFF.
  const CEmitInst hex_insts[] = {
    make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x2000),
    make_inst(HEX_IR_CONST, 0, 64, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0xFFFFFFFFull, 0x2000),
    make_inst(HEX_IR_BINOP, HEX_IR_BIN_AND, 64, 2, 0, 1, HEX_IR_NO_VAL, 0, 0x2004),
    make_inst(HEX_IR_RET, 0, 64, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x2008),
  };
  v.func_name = "mask32";
  v.func_name_len = 6;
  v.num_params = 1;
  v.ret_width = 64;
  v.ret_is_signed = 0;
  v.insts = hex_insts;
  assert(hex_decomp_emit_c_ex(&v, 65536, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
  txt = hex_decomp_get_text_ptr();
  assert(contains(txt, "    return a1 & 0xFFFFFFFF;\n"));
  assert(!contains(txt, "0xffffffff"));
}

static void test_subopcodes_and_flag_masking(void) {
  // Verify all HEX_IR_BIN_* (0..10) and HEX_IR_UN_* (0..3) with high flag bits set (0x40).
  const char* expected_bin[11] = {
    " + ", " - ", " * ", " / ", " / ", " % ", " & ", " | ", " ^ ", " << ", " >> "
  };
  for (uint8_t sub = 0; sub <= 10; ++sub) {
    const CEmitInst insts[] = {
      make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x3000),
      make_inst(HEX_IR_PARAM, 0, 64, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 1, 0x3000),
      make_inst(HEX_IR_BINOP, static_cast<uint8_t>(sub | HEX_IR_FLAG_SIGNED), 64, 2, 0, 1, HEX_IR_NO_VAL, 0, 0x3004),
      make_inst(HEX_IR_RET, 0, 64, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x3008),
    };
    const uint32_t off[] = {0, 4};
    const uint32_t soff[] = {0, 0};
    CEmitFunctionView v{};
    v.entry_va = 0x3000;
    v.num_params = 2;
    v.ret_width = 64;
    v.num_blocks = 1;
    v.block_inst_off = off;
    v.insts = insts;
    v.num_insts = 4;
    v.succ_off = soff;
    assert(hex_decomp_emit_c(&v, 65536) == HEX_OK);
    const char* txt = hex_decomp_get_text_ptr();
    assert(contains(txt, expected_bin[sub]));
  }

  const char* expected_un[4] = {"-a1", "~a1", "!a1", "(uint64)a1"};
  for (uint8_t sub = 0; sub <= 3; ++sub) {
    const CEmitInst insts[] = {
      make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x3100),
      make_inst(HEX_IR_UNOP, static_cast<uint8_t>(sub | HEX_IR_FLAG_SIGNED), 64, 1, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x3104),
      make_inst(HEX_IR_RET, 0, 64, HEX_IR_NO_VAL, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x3108),
    };
    const uint32_t off[] = {0, 3};
    const uint32_t soff[] = {0, 0};
    CEmitFunctionView v{};
    v.entry_va = 0x3100;
    v.num_params = 1;
    v.ret_width = 64;
    v.num_blocks = 1;
    v.block_inst_off = off;
    v.insts = insts;
    v.num_insts = 3;
    v.succ_off = soff;
    assert(hex_decomp_emit_c(&v, 65536) == HEX_OK);
    const char* txt = hex_decomp_get_text_ptr();
    assert(contains(txt, expected_un[sub]));
  }
}

static void test_while_header_with_executable_stmts(void) {
  // bb0 (loop header): v2 = sub_0x9000(a1); cond = (v2 != 0); condbr cond -> bb1 (body), bb2 (exit)
  // bb1 (body): store *(uint64*)(a1) = v2; branch -> bb0
  // bb2 (exit): return v2
  const CEmitInst insts[] = {
    // bb0: [0..4)
    make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x4000),
    make_inst(HEX_IR_CALL, 0, 64, 2, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0x9000, 0x4004),
    make_inst(HEX_IR_CONST, 0, 64, 3, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x4008),
    make_inst(HEX_IR_CMP, HEX_IR_CMP_NE, 64, 4, 2, 3, HEX_IR_NO_VAL, 0, 0x4008),
    make_inst(HEX_IR_CONDBR, 0, 64, HEX_IR_NO_VAL, 4, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x400C),
    // bb1: [5..7)
    make_inst(HEX_IR_STORE, 0, 64, HEX_IR_NO_VAL, 0, 2, HEX_IR_NO_VAL, 0, 0x4010),
    make_inst(HEX_IR_BRANCH, 0, 64, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x4014),
    // bb2: [7..8)
    make_inst(HEX_IR_RET, 0, 64, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x4020),
  };
  const uint32_t off[] = {0, 5, 7, 8};
  const uint32_t soff[] = {0, 2, 3, 3};
  const uint32_t sdst[] = {1, 2, 0};
  const uint32_t loop_hdr[] = {0};
  const int32_t loop_par[] = {-1};
  const int32_t node_loop[] = {0, 0, -1};

  CEmitFunctionView v{};
  v.func_name = "hdr_stmt_loop";
  v.func_name_len = 13;
  v.entry_va = 0x4000;
  v.num_params = 1;
  v.ret_width = 64;
  v.num_blocks = 3;
  v.entry_block = 0;
  v.block_inst_off = off;
  v.insts = insts;
  v.num_insts = 8;
  v.succ_off = soff;
  v.succ_dst = sdst;
  v.num_loops = 1;
  v.loop_header = loop_hdr;
  v.loop_parent = loop_par;
  v.node_innermost_loop = node_loop;

  assert(hex_decomp_emit_c_ex(&v, 65536, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
  const char* txt = hex_decomp_get_text_ptr();
  // Must expand to while (1) { <header>; if (...) break; <body>; }
  assert(contains(txt, "while (1) {\n"));
  assert(contains(txt, "sub_0x9000(a1);\n"));
  assert(contains(txt, "if (v2 == 0) break;\n"));
  assert(contains(txt, "*(uint64*)(a1) = v2;\n"));

  // Verify the `break;` line map entry records origin block 0 (addr 0x400C), NOT exit block 2 (0x4020)!
  const uint32_t break_line = find_line_number_containing(txt, "break;");
  assert(break_line > 0u);
  const HexLineMapEntry* lm = hex_decomp_get_linemap_ptr();
  const uint32_t lm_cnt = hex_decomp_get_linemap_count();
  bool found_break_lm = false;
  for (uint32_t i = 0; i < lm_cnt; ++i) {
    if (lm[i].line_no == break_line) {
      assert(lm[i].block_id == 0u);
      assert(lm[i].addr == 0x400Cu);
      found_break_lm = true;
    }
  }
  assert(found_break_lm);
}

static void test_transition_linemap_origin_block(void) {
  // Pure while header bb0 -> body bb1 (early break to bb3 on cond, else bb2 continue to bb0) -> exit bb3.
  const CEmitInst insts[] = {
    // bb0 (header): pure cond (a1 < 10) -> bb1, bb3
    make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5000),
    make_inst(HEX_IR_CONST, 0, 64, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 10, 0x5000),
    make_inst(HEX_IR_CMP, HEX_IR_CMP_ULT, 64, 2, 0, 1, HEX_IR_NO_VAL, 0, 0x5004),
    make_inst(HEX_IR_CONDBR, 0, 64, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5008),
    // bb1 (body): if (a1 == 5) break (to bb3); else bb2
    make_inst(HEX_IR_CONST, 0, 64, 3, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 5, 0x5010),
    make_inst(HEX_IR_CMP, HEX_IR_CMP_EQ, 64, 4, 0, 3, HEX_IR_NO_VAL, 0, 0x5010),
    make_inst(HEX_IR_CONDBR, 0, 64, HEX_IR_NO_VAL, 4, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5014),
    // bb2 (latch): call sub_0x8000(a1); branch bb0
    make_inst(HEX_IR_CALL, 0, 64, HEX_IR_NO_VAL, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0x8000, 0x5020),
    make_inst(HEX_IR_BRANCH, 0, 64, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5024),
    // bb3 (exit): return 0
    make_inst(HEX_IR_CONST, 0, 64, 5, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5030),
    make_inst(HEX_IR_RET, 0, 64, HEX_IR_NO_VAL, 5, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x5034),
  };
  const uint32_t off[] = {0, 4, 7, 9, 11};
  const uint32_t soff[] = {0, 2, 4, 5, 5};
  const uint32_t sdst[] = {1, 3, 3, 2, 0};
  const uint32_t loop_hdr[] = {0};
  const int32_t loop_par[] = {-1};
  const int32_t node_loop[] = {0, 0, 0, -1};

  CEmitFunctionView v{};
  v.func_name = "early_break_fn";
  v.func_name_len = 14;
  v.entry_va = 0x5000;
  v.num_params = 1;
  v.ret_width = 64;
  v.num_blocks = 4;
  v.entry_block = 0;
  v.block_inst_off = off;
  v.insts = insts;
  v.num_insts = 11;
  v.succ_off = soff;
  v.succ_dst = sdst;
  v.num_loops = 1;
  v.loop_header = loop_hdr;
  v.loop_parent = loop_par;
  v.node_innermost_loop = node_loop;

  assert(hex_decomp_emit_c(&v, 65536) == HEX_OK);
  const char* txt = hex_decomp_get_text_ptr();
  assert(contains(txt, "while (a1 < 10) {\n"));
  assert(contains(txt, "break;\n"));

  const uint32_t brk_line = find_line_number_containing(txt, "break;");
  assert(brk_line > 0u);
  const HexLineMapEntry* lm = hex_decomp_get_linemap_ptr();
  const uint32_t lm_cnt = hex_decomp_get_linemap_count();
  bool checked = false;
  for (uint32_t i = 0; i < lm_cnt; ++i) {
    if (lm[i].line_no == brk_line) {
      // Origin is bb1 (0x5014), NOT target bb3 (0x5030)!
      assert(lm[i].block_id == 1u);
      assert(lm[i].addr == 0x5014u);
      checked = true;
    }
  }
  assert(checked);
}

static void test_if_else_diamond_and_nested_loops(void) {
  // Diamond: bb0 (if a1 == 0) -> bb1 / bb2 -> bb3 (return)
  const CEmitInst insts[] = {
    make_inst(HEX_IR_PARAM, 0, 64, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6000),
    make_inst(HEX_IR_CONST, 0, 64, 1, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6000),
    make_inst(HEX_IR_CMP, HEX_IR_CMP_EQ, 64, 2, 0, 1, HEX_IR_NO_VAL, 0, 0x6004),
    make_inst(HEX_IR_CONDBR, 0, 64, HEX_IR_NO_VAL, 2, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6008),
    // bb1
    make_inst(HEX_IR_CALL, 0, 64, HEX_IR_NO_VAL, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0x1111, 0x6010),
    make_inst(HEX_IR_BRANCH, 0, 64, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6014),
    // bb2
    make_inst(HEX_IR_CALL, 0, 64, HEX_IR_NO_VAL, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0x2222, 0x6020),
    make_inst(HEX_IR_BRANCH, 0, 64, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6024),
    // bb3
    make_inst(HEX_IR_RET, 0, 0, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, HEX_IR_NO_VAL, 0, 0x6030),
  };
  const uint32_t off[] = {0, 4, 6, 8, 9};
  const uint32_t soff[] = {0, 2, 3, 4, 4};
  const uint32_t sdst[] = {1, 2, 3, 3};
  const int32_t ipdom[] = {3, 3, 3, -1};

  CEmitFunctionView v{};
  v.func_name = "diamond_fn";
  v.func_name_len = 10;
  v.entry_va = 0x6000;
  v.num_params = 1;
  v.ret_width = 0;
  v.num_blocks = 4;
  v.entry_block = 0;
  v.block_inst_off = off;
  v.insts = insts;
  v.num_insts = 9;
  v.succ_off = soff;
  v.succ_dst = sdst;
  v.ipdom = ipdom;

  assert(hex_decomp_emit_c(&v, 65536) == HEX_OK);
  const char* txt = hex_decomp_get_text_ptr();
  assert(contains(txt, "if (a1 == 0) {\n"));
  assert(contains(txt, "} else {\n"));
  assert(contains(txt, "sub_0x1111(a1);\n"));
  assert(contains(txt, "sub_0x2222(a1);\n"));
  assert(contains(txt, "return;\n"));
}

static void test_defensive_guards(void) {
  // 1. Empty block_inst_off (no underflow on end - 1 when start == end == 0).
  const uint32_t empty_off[] = {0, 0};
  const uint32_t empty_soff[] = {0, 0};
  CEmitFunctionView v{};
  v.func_name = "empty_fn";
  v.func_name_len = 8;
  v.entry_va = 0x7000;
  v.num_blocks = 1;
  v.entry_block = 0;
  v.block_inst_off = empty_off;
  v.insts = nullptr;
  v.num_insts = 0;
  v.succ_off = empty_soff;
  assert(hex_decomp_emit_c(&v, 4096) == HEX_OK);
  assert(contains(hex_decomp_get_text_ptr(), "void empty_fn(void) {\n}\n"));

  // 2. UINT32_MAX max_bytes clamp (no overflow in ensure_text).
  assert(hex_decomp_emit_c(&v, UINT32_MAX) == HEX_OK);

  // 3. Tight max_bytes returns HEX_ERR_RESOURCE_LIMIT cleanly.
  assert(hex_decomp_emit_c(&v, 8) == HEX_ERR_RESOURCE_LIMIT);

  // 4. Non-monotonic block_inst_off rejected.
  const uint32_t bad_off[] = {2, 1};
  v.block_inst_off = bad_off;
  v.num_insts = 2;
  assert(hex_decomp_emit_c(&v, 4096) == HEX_ERR_INVALID_ARG);

  // 5. External bound arena works and resets cleanly.
  static uint8_t ext_buf[128 * 1024];
  hex::Arena ext_arena;
  ext_arena.init_fixed(ext_buf, sizeof(ext_buf));
  hex::decompiler::bind_arena(&ext_arena);
  v.block_inst_off = empty_off;
  v.num_insts = 0;
  assert(hex_decomp_emit_c(&v, 4096) == HEX_OK);
  assert(ext_arena.used() > 0u);
  hex_decomp_reset();
  assert(ext_arena.used() == 0u);
  hex::decompiler::bind_arena(nullptr);
}

int main(void) {
  test_js_parity_add_and_hex();
  test_subopcodes_and_flag_masking();
  test_while_header_with_executable_stmts();
  test_transition_linemap_origin_block();
  test_if_else_diamond_and_nested_loops();
  test_defensive_guards();
  printf("test_c_emitter_native: ALL 6 TEST SUITES PASS\n");
  return 0;
}
