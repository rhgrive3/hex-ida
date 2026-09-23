void init(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    call_weak_fn(/* arguments unknown */);
    return;
}
void $x(void)
{
    uint64 var_10;

    var_10 = x16;   var_8 = x30;
    __asm("br x17");
}
void init_have_lse_atomics(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(16);
    global_12075 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_29;
    uint64 load_32;
    load_29 = var_0;
    load_32 = global_11FD8;
    unknown_call(load_32);
    unknown_call(load_32);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FD0;
    __asm("cbz x0, #0x904");
    return sub_7F0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_45;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x12078 != 0x12078) {
        load_45 = global_11FC0;
        if (!(load_45 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_11FE0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void do_global_dtors_aux(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    if (!(global_12074 != 0)) {
        if (!(global_11FC8 == 0)) {
            unknown_call(global_12068);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void param_macro_constants(void)
{
    return;
}
void call_macro_constants(void)
{
    return;
}
void param_macro_functions(void)
{
    return;
}
void call_macro_functions(void)
{
    return;
}
void param_conditional_compile(void)
{
    return;
}
void call_conditional_compile(void)
{
    return;
}
void param_multi_branch_compile(void)
{
    return;
}
void call_multi_branch_compile(void)
{
    return;
}
void param_macro_recursion(void)
{
    return;
}
void call_macro_recursion(void)
{
    return;
}
void param_stringize(void)
{
    return;
}
void call_stringize(void)
{
    return;
}
void my_func(void)
{
    return;
}
void param_token_paste(void)
{
    return;
}
void call_token_paste(void)
{
    return;
}
void param_variadic_macro(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("LOG: Values: %d, %d, %d\\n");
    return;
}
void call_variadic_macro(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("LOG: Values: %d, %d, %d\\n");
    return;
}
void param_macro_override(void)
{
    return;
}
void call_macro_override(void)
{
    return;
}
void param_include_guard(void)
{
    return;
}
void call_include_guard(void)
{
    return;
}
void param_builtin_macros(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("file=%s, func=%s, line=%d, date=%s, time=%s\\n");
    return;
}
void call_builtin_macros(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("file=%s, func=%s, line=%d, date=%s, time=%s\\n");
    return;
}
void test_preprocessing_features(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试预处理与条件编译 ===");
    unknown_call("PP-L2-01: %d (期望: 64)\\n");
    unknown_call("PP-L2-02: %d (期望: 30)\\n");
    unknown_call("PP-L2-03: %d (期望: 32)\\n");
    unknown_call("PP-L2-04: %d (期望: 0xDF22)\\n");
    unknown_call("PP-L3-01: %d (期望: 116)\\n");
    unknown_call("PP-L3-02: %d (期望: 11+5+行号长度)\\n");
    unknown_call("PP-L3-03: %d (期望: 60)\\n");
    unknown_call("LOG: Values: %d, %d, %d\\n");
    unknown_call("PP-L3-04: %d (期望: 60)\\n");
    unknown_call("PP-L3-05: %d (期望: 16)\\n");
    unknown_call("PP-L3-06: %d (期望: 500)\\n");
    unknown_call("file=%s, func=%s, line=%d, date=%s, time=%s\\n");
}
void param_asm_basic(void)
{
    return;
}
void call_asm_basic(void)
{
    return;
}
void param_asm_clobber(void)
{
    uint64 load_34;
        if ((int32_t)a2 < 1) goto loc_CD4;
        if ((uint32_t)a2 >= 8) goto loc_CDC;
        goto loc_D1C;
    loc_CD4:
        return;
    loc_CDC:
    loc_CF0:
        load_34 = memory_unknown;
        if ((uint64_t)phi(v187 - 8, a2 & 0xFFFFFFF8) != 8) goto loc_CF0;
        if ((uint64_t)a2 & 0xFFFFFFF8 == (uint64_t)a2) goto loc_D34;
    loc_D1C:
        while ((uint64_t)phi(v74 - 1, a2 - (phi(a2 & 0xFFFFFFF8, 0))) != 1) {
        }
    loc_D34:
        return;
}
void call_asm_clobber(void)
{
    return;
}
void param_asm_multi_insn(void)
{
}
void call_asm_multi_insn(void)
{
    return;
}
void param_asm_simd(void)
{
    a3->field_0 = a2->field_0 + a1->field_0;
    a3->field_4 = a2->field_4 + a1->field_4;
    a3->field_8 = a2->field_8 + a1->field_8;
    a3->field_C = a2->field_C + a1->field_C;
    return;
}
void param_simd_intrinsics(void)
{
    a3->field_0 = a2->field_0 + a1->field_0;
    a3->field_4 = a2->field_4 + a1->field_4;
    a3->field_8 = a2->field_8 + a1->field_8;
    a3->field_C = a2->field_C + a1->field_C;
    return;
}
void call_asm_simd(void)
{
    return;
}
void param_asm_atomic(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    return;
}
void param_atomic_c11(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    return;
}
void call_asm_atomic(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 10;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    return;
}
void param_dynamic_code(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(30);
    unknown_call(0);
    if ((uint64_t)((uint64_t)call_139 + (uint64_t)1) != 0) {
        unknown_call(call_139);
    }
    return;
}
void param_memory_protection(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(30);
    unknown_call(0);
    if ((uint64_t)((uint64_t)call_401 + (uint64_t)1) != 0) {
        memory_unknown = 42;
        unknown_call(call_401);
        if (call_218 == 0) {
            unknown_call(call_401);
            if (call_274 == 0) {
                memory_unknown = 0x64;
            } else {
            }
        } else {
        }
        unknown_call(phi(call_336, call_172));
    }
    return;
}
void param_clobber_importance(void)
{
    return;
}
void call_asm_privileged(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(30);
    unknown_call(0);
    if ((uint64_t)((uint64_t)call_216 + (uint64_t)1) != 0) {
        unknown_call(call_216);
    }
    param_memory_protection(/* arguments unknown */);
    return;
}
void param_memory_clobber_demo(void)
{
    return;
}
void test_asm_features(void)
{
    uint32 load_35;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call("=== 测试内联汇编与底层特性 ===");
    unknown_call("ASM-L4-01: %d (期望: 15)\\n");
    unknown_call("ASM-L4-02: %d (期望: 15)\\n");
    unknown_call("ASM-L4-03: %d (期望: 42)\\n");
    unknown_call("ASM-L4-04: %d (期望: 36)\\n");
    local_pFFFFFFFFFFFFFFEC = 10;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    load_35 = var_FFFFFFFFFFFFFFEC;
    unknown_call("ASM-L4-05: %d (期望: 30)\\n");
    unknown_call(30);
    unknown_call(0);
    if ((uint64_t)((uint64_t)call_402 + (uint64_t)1) != 0) {
        unknown_call(call_402);
    }
    param_memory_protection(/* arguments unknown */);
    unknown_call("ASM-L4-06: %d (期望: 77)\\n");
    return;
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_preprocessing_features(/* arguments unknown */);
    test_asm_features(/* arguments unknown */);
    return;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x1168");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x116c");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
