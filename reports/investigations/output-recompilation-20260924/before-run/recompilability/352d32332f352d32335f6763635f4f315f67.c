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
    global_12015 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_22;
    uint64 load_20;
    load_22 = var_0;
    load_20 = global_11FF0;
    unknown_call(load_20);
    unknown_call(load_20);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FE0;
    __asm("cbz x0, #0x984");
    return sub_880(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x12018 != 0x12018) {
        if (!(global_11FD0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_11FF8 == 0)) {
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
    if (!(global_12014 != 0)) {
        if (!(global_11FD8 == 0)) {
            unknown_call(global_12008);
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
    unknown_call(1);
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
    unknown_call(1);
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
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_variadic_macro(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_builtin_macros(/* arguments unknown */);
    unknown_call(1);
    return;
}
void param_asm_basic(void)
{
    return;
}
void call_asm_basic(void)
{
    return;
}
uint32 param_asm_clobber(void * a1, int64 a2)
{
    x4 = a1;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xd24");
    x2 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x4 + x2 * 4));
    x2 = x2 + 1;
    /* cmp (int32)(a2), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.gt #0xd0c");
    loc_D20:
    return x0;
    __asm("b #0xd20");
    goto loc_D20;
}
void call_asm_clobber(void)
{
    uint64 load_54;
    uint64 load_33;
    uint64 load_122;
    loc_D2C:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE0 = global_15E0;
        local_pFFFFFFFFFFFFFFE0 = global_15E0;
        local_pFFFFFFFFFFFFFFF0 = global_15F0;
        param_asm_clobber(/* arguments unknown */);
        load_54 = global_11FE8;
        load_33 = var_28;
        load_122 = memory_unknown;
        if ((uint64_t)load_33 != (uint64_t)load_122) goto loc_D90;
        goto loc_D88;
    loc_D88:
        return;
    loc_D90:
        unknown_call((sp + 0xFFFFFFFFFFFFFFD0) + 16);
}
void param_asm_multi_insn(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(/* target unknown */);
    return;
}
uint32 call_asm_multi_insn(void)
{
    uint64 var_18, var_28, var_38, var_48;
    uint8 var_2C;

    var_48 = *(uint64 *)(*(uint64 *)0x11FE8);
    x0_1 = 0x14C8;
    var_18 = *(uint64 *)0x14C8;
    *(uint16 *)(sp - 56 + 8) = (uint32)*(uint16 *)0x14D0;
    var_28 = 0;   var_30 = 0;
    var_38 = 0;   var_40 = 0;
    x0_2 = param_asm_multi_insn(sp - 40, sp - 56, 9);
    /* cmp (int32)((uint32)var_28), 0x48 — 次の分岐のための比較 */
    __asm("b.ne #0xe34");
    /* cmp (int32)((uint32)var_2C), 0x6F — 次の分岐のための比較 */
    x0_3 = (uint32)((uint32)var_2C == 111 ? 42 : -1);
    loc_E10:
    x1 = *(uint64 *)0x11FE8;
    x3 = var_48 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0xe3c");
    return x0;
    x0_4 = 0xFFFFFFFF;
    __asm("b #0xe10");
    goto loc_E10;
    x0_5 = sub_870();
}
void param_asm_simd(void)
{
    memory_unknown = memory_unknown + memory_unknown;
    while ((uint64_t)x3 + 4 != 16) {
    }
    return;
}
void param_simd_intrinsics(void)
{
    memory_unknown = memory_unknown + memory_unknown;
    while ((uint64_t)x3 + 4 != 16) {
    }
    return;
}
void call_asm_simd(void)
{
    uint32 load_29;
    uint32 load_137;
    uint32 load_157;
    uint32 load_207;
    uint64 load_229;
    uint64 load_213;
    uint64 load_128;
    loc_E90:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFC8 = 1;
        local_pFFFFFFFFFFFFFFCC = 2;
        local_pFFFFFFFFFFFFFFD0 = 3;
        local_pFFFFFFFFFFFFFFD4 = 4;
        local_pFFFFFFFFFFFFFFD8 = 5;
        local_pFFFFFFFFFFFFFFDC = 6;
        local_pFFFFFFFFFFFFFFE0 = 7;
        local_pFFFFFFFFFFFFFFE4 = 8;
        param_asm_simd(/* arguments unknown */);
        load_29 = var_FFFFFFFFFFFFFFE8;
        load_137 = var_FFFFFFFFFFFFFFEC;
        load_207 = var_FFFFFFFFFFFFFFF0;
        load_157 = var_FFFFFFFFFFFFFFF4;
        load_229 = global_11FE8;
        load_213 = var_48;
        load_128 = memory_unknown;
        if ((uint64_t)load_213 != (uint64_t)load_128) goto loc_F3C;
        goto loc_F34;
    loc_F34:
        return;
    loc_F3C:
        unknown_call(((load_29 + load_137) + load_207) + load_157);
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
    uint32 load_74;
    uint64 load_85;
    uint64 load_43;
    uint64 load_65;
    loc_F98:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFF4 = 10;
        param_asm_atomic(/* arguments unknown */);
        load_74 = var_14;
        load_85 = global_11FE8;
        load_43 = var_18;
        load_65 = memory_unknown;
        if ((uint64_t)load_43 != (uint64_t)load_65) goto loc_FF4;
        goto loc_FEC;
    loc_FEC:
        return;
    loc_FF4:
        unknown_call(call_147 + load_74);
}
uint32 param_dynamic_code(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    x0_1 = sub_8D0(30);
    x0_2 = sub_8B0(0, x0_1, 7, 34, 0xFFFFFFFF, 0);
    /* cmn x0_2, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1054");
    x19 = (uint32)(x19 + 5);
    x0_3 = sub_8C0(x0_2, x0_1);
    loc_1044:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x1044");
    goto loc_1044;
}
uint64 param_memory_protection(void)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0_1 = sub_8D0(30);
    x0_2 = sub_8B0(0, x0_1, 3, 34, 0xFFFFFFFF, 0);
    /* cmn x0_2, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1124");
    *(uint32 *)(x0_2) = 42;
    x0_3 = sub_8E0(x0_2, x0_1, 1);
    __asm("cbnz w0, #0x10fc");
    x21 = *(uint32 *)(x0_2);
    x0_4 = sub_8E0(x0_2, x0_1, 3);
    __asm("cbnz w0, #0x1110");
    *(uint32 *)(x0_2) = 100;
    x0_5 = sub_8C0(x0_2, x0_1);
    loc_10E8:
    return (uint32)x21;
    x1 = x20;
    x0_6 = sub_8C0(x19, x20);
    x21 = 0xFFFFFFFE;
    __asm("b #0x10e8");
    goto loc_10E8;
    x1 = x20;
    x0_7 = sub_8C0(x19, x20);
    x21 = 0xFFFFFFFD;
    __asm("b #0x10e8");
    goto loc_10E8;
    x21 = 0xFFFFFFFF;
    __asm("b #0x10e8");
    goto loc_10E8;
}
void param_clobber_importance(void)
{
    return;
}
void call_asm_privileged(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    param_dynamic_code(/* arguments unknown */);
    param_memory_protection(/* arguments unknown */);
    return;
}
void param_memory_clobber_demo(void)
{
    return;
}
void test_asm_features(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(1);
    unknown_call(1);
    call_asm_clobber(/* arguments unknown */);
    unknown_call(1);
    call_asm_multi_insn(/* arguments unknown */);
    unknown_call(1);
    call_asm_simd(/* arguments unknown */);
    unknown_call(1);
    call_asm_atomic(/* arguments unknown */);
    unknown_call(1);
    call_asm_privileged(/* arguments unknown */);
    unknown_call(1);
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
    __asm("cbz w16, #0x1268");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x126c");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
