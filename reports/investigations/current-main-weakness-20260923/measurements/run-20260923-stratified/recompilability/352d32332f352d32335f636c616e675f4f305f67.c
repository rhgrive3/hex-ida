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
    global_13075 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_40;
    uint64 load_33;
    load_40 = var_0;
    load_33 = global_12FD8;
    unknown_call(load_33);
    unknown_call(load_33);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x904");
    return sub_800(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13078 != 0x13078) {
        if (!(global_12FC0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_12FE0 == 0)) {
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
    if (!(global_13074 != 0)) {
        if (!(global_12FC8 == 0)) {
            unknown_call(global_13068);
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
    local_m8 = a1;
    if ((int32_t)a1 <= 0x400) {
        local_m4 = 0x200;
    } else {
        local_m4 = 64;
    }
    return;
}
void call_macro_constants(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_macro_constants(/* arguments unknown */);
    return;
}
void param_macro_functions(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = (uint32_t)a1 * (uint32_t)a1;
    if ((int32_t)a1 <= (int32_t)a2) {
        local_m10 = (uint32_t)a2;
    } else {
        local_m10 = (uint32_t)a1;
    }
    return;
}
void call_macro_functions(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_macro_functions(/* arguments unknown */);
    return;
}
void param_conditional_compile(void)
{
    local_m4 = a1;
    local_m8 = (uint32_t)a1;
    local_m8 = (uint32_t)a1 * 3 + 2;
    return;
}
void call_conditional_compile(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_conditional_compile(/* arguments unknown */);
    return;
}
void param_multi_branch_compile(void)
{
    local_m4 = a1;
    return;
}
void call_multi_branch_compile(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_multi_branch_compile(/* arguments unknown */);
    return;
}
void param_macro_recursion(void)
{
    local_m4 = a1;
    return;
}
void call_macro_recursion(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_macro_recursion(/* arguments unknown */);
    return;
}
void param_stringize(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m20 = 0x1688;
    local_m28 = 0x1694;
    local_m30 = 0x169A;
    unknown_call(var_m20);
    local_m40 = call_115;
    unknown_call(var_18);
    local_m38 = local_m40 + call_137;
    unknown_call(var_p10);
    return;
}
void call_stringize(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_stringize(/* arguments unknown */);
    return;
}
void my_func(void)
{
    local_m4 = a1;
    return;
}
void param_token_paste(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    my_func(/* arguments unknown */);
    local_m18 = call_54;
    local_m1C = local_m14 + 5;
    local_m18 += local_m1C;
    return;
}
void call_token_paste(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_token_paste(/* arguments unknown */);
    return;
}
void param_variadic_macro(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m18 = a2;
    local_m1C = a3;
    unknown_call("LOG: Values: %d, %d, %d\\n");
    local_m20 = 5;
    return;
}
void call_variadic_macro(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_variadic_macro(/* arguments unknown */);
    return;
}
void param_macro_override(void)
{
    local_m4 = a1;
    local_m8 = (uint32_t)a1 + 1;
    local_mC = ((uint32_t)(uint32_t)a1 << 1);
    return;
}
void call_macro_override(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_macro_override(/* arguments unknown */);
    return;
}
void param_include_guard(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    header_func(/* arguments unknown */);
    return;
}
void header_func(void)
{
    local_m4 = a1;
    return;
}
void call_include_guard(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_include_guard(/* arguments unknown */);
    return;
}
void param_builtin_macros(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m20 = 0x16B7;
    local_m24 = 0x117;
    local_m30 = 0x16C2;
    local_m38 = 0x16D7;
    local_m40 = 0x16E3;
    unknown_call("file=%s, func=%s, line=%d, date=%s, time=%s\\n");
    local_m44 = 0;
    local_m48 = 1;
    local_m4C = 2;
    return;
}
void call_builtin_macros(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_builtin_macros(/* arguments unknown */);
    return;
}
void test_preprocessing_features(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试预处理与条件编译 ===\\n");
    call_macro_constants(/* arguments unknown */);
    unknown_call("PP-L2-01: %d (期望: 64)\\n");
    call_macro_functions(/* arguments unknown */);
    unknown_call("PP-L2-02: %d (期望: 30)\\n");
    call_conditional_compile(/* arguments unknown */);
    unknown_call("PP-L2-03: %d (期望: 32)\\n");
    call_multi_branch_compile(/* arguments unknown */);
    unknown_call("PP-L2-04: %d (期望: 0xDF22)\\n");
    call_macro_recursion(/* arguments unknown */);
    unknown_call("PP-L3-01: %d (期望: 116)\\n");
    call_stringize(/* arguments unknown */);
    unknown_call("PP-L3-02: %d (期望: 11+5+行号长度)\\n");
    call_token_paste(/* arguments unknown */);
    unknown_call("PP-L3-03: %d (期望: 60)\\n");
    call_variadic_macro(/* arguments unknown */);
    unknown_call("PP-L3-04: %d (期望: 60)\\n");
    call_macro_override(/* arguments unknown */);
    unknown_call("PP-L3-05: %d (期望: 16)\\n");
    call_include_guard(/* arguments unknown */);
    unknown_call("PP-L3-06: %d (期望: 500)\\n");
    call_builtin_macros(/* arguments unknown */);
    unknown_call("PP-L3-07: %d (期望: 100+行号+0+1+2)\\n");
    return;
}
void param_asm_basic(void)
{
    local_m4 = a1;
    local_m8 = (uint32_t)a1 + 10;
    return;
}
void call_asm_basic(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_asm_basic(/* arguments unknown */);
    return;
}
void param_asm_clobber(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 += local_m8[(int64_t)local_m14];
        local_m14++;
        continue;
    }
    return;
}
void call_asm_clobber(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = global_196C;
    local_m20 = global_197C;
    param_asm_clobber(/* arguments unknown */);
    return;
}
void param_asm_multi_insn(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    unknown_call(var_m18);
    return;
}
void call_asm_multi_insn(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = global_188D;
    local_m18 = global_1895;
    local_m40 = var_59;
    local_m30 = var_59;
    param_asm_multi_insn(/* arguments unknown */);
    local_m44 = 0;
    if ((uint32_t)var_p10 == 72) {
        local_m44 = (uint8_t)local_m3C == 0x6F ? 1 : 0;
    }
    return;
}
void param_asm_simd(void)
{
    local_m8 = a1;
    local_m10 = a2;
    local_m18 = a3;
    local_m1C = 0;
    while ((int32_t)var_4 < 4) {
        local_m18[(int64_t)local_m1C] = local_m8[(int64_t)local_m1C] + local_m10[(int64_t)local_m1C];
        local_m1C = local_m1C + 1;
        continue;
    }
    return;
}
void param_simd_intrinsics(void)
{
    local_m8 = a1;
    local_m10 = a2;
    local_m18 = a3;
    local_m1C = 0;
    while ((int32_t)var_4 < 4) {
        local_m18[(int64_t)local_m1C] = local_m8[(int64_t)local_m1C] + local_m10[(int64_t)local_m1C];
        local_m1C = local_m1C + 1;
        continue;
    }
    return;
}
void call_asm_simd(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = global_1980;
    local_m30 = global_1990;
    param_asm_simd(/* arguments unknown */);
    return;
}
void param_asm_atomic(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m24 = local_m1C;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    local_m28 = call_86;
    local_m20 = local_m28;
    return;
}
void param_atomic_c11(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m20 = local_m1C;
    aarch64_ldadd4_acq_rel(/* arguments unknown */);
    local_m24 = call_86;
    return;
}
void call_asm_atomic(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 10;
    param_asm_atomic(/* arguments unknown */);
    local_m18 = call_66;
    return;
}
void param_dynamic_code(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(30);
    local_m20 = call_67;
    unknown_call(0);
    local_m28 = call_112;
    if ((uint64_t)((uint64_t)var_m28 + (uint64_t)1) != 0) {
        local_m2C = local_m18 + 5;
        unknown_call(var_m28);
        local_m14 = local_m2C;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void param_memory_protection(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(30);
    local_m20 = call_60;
    unknown_call(0);
    local_m28 = call_103;
    if ((uint64_t)((uint64_t)var_m28 + (uint64_t)1) != 0) {
        local_m30 = local_m28;
        memory_unknown = 42;
        unknown_call(var_m28);
        if (call_450 == 0) {
            local_m34 = memory_unknown;
            unknown_call(var_m28);
            if (call_571 == 0) {
                memory_unknown = 0x64;
                unknown_call(var_m28);
                local_m14 = local_m34;
            } else {
                unknown_call(var_m28);
                local_m14 = 0xFFFFFFFD;
            }
        } else {
            unknown_call(var_m28);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void param_clobber_importance(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void call_asm_privileged(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_dynamic_code(/* arguments unknown */);
    local_m18 = call_55;
    param_memory_protection(/* arguments unknown */);
    local_m1C = call_70;
    param_clobber_importance(/* arguments unknown */);
    local_m20 = call_95;
    if ((uint32_t)var_m18 != 15) {
        local_m14 = local_m18;
    } else {
        if ((uint32_t)var_m1C != 42) {
            goto loc_152C;
        } else {
            if ((uint32_t)var_m20 != 20) {
                goto loc_152C;
            } else {
                local_m14 = 77;
            }
        }
    }
    return;
}
void param_memory_clobber_demo(void)
{
    local_m4 = 50;
    local_m8 = local_m4 + global_13070;
    return;
}
void test_asm_features(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试内联汇编与底层特性 ===\\n");
    call_asm_basic(/* arguments unknown */);
    unknown_call("ASM-L4-01: %d (期望: 15)\\n");
    call_asm_clobber(/* arguments unknown */);
    unknown_call("ASM-L4-02: %d (期望: 15)\\n");
    call_asm_multi_insn(/* arguments unknown */);
    unknown_call("ASM-L4-03: %d (期望: 42)\\n");
    call_asm_simd(/* arguments unknown */);
    unknown_call("ASM-L4-04: %d (期望: 36)\\n");
    call_asm_atomic(/* arguments unknown */);
    unknown_call("ASM-L4-05: %d (期望: 30)\\n");
    call_asm_privileged(/* arguments unknown */);
    unknown_call("ASM-L4-06: %d (期望: 77)\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    test_preprocessing_features(/* arguments unknown */);
    test_asm_features(/* arguments unknown */);
    return;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x1658");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x165c");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
