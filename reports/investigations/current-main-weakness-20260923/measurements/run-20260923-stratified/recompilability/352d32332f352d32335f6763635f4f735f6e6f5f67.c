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
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_preprocessing_features(/* arguments unknown */);
    test_asm_features(/* arguments unknown */);
    return;
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
    uint64 load_6;
    uint64 load_7;
    load_6 = var_0;
    load_7 = global_11FF0;
    unknown_call(load_7);
    unknown_call(load_7);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FE0;
    __asm("cbz x0, #0x9c4");
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
    while ((int32_t)a2 > (int32_t)phi(x2 + 1, 0)) {
        continue;
    }
    return;
}
void call_asm_clobber(void)
{
    uint64 load_28;
    uint64 load_5;
    uint64 load_110;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFE0 = global_1518;
    local_pFFFFFFFFFFFFFFE0 = global_1518;
    local_pFFFFFFFFFFFFFFF0 = global_1528;
    param_asm_clobber(/* arguments unknown */);
    load_28 = global_11FE8;
    load_5 = var_28;
    load_110 = memory_unknown;
    if ((uint64_t)load_5 != (uint64_t)load_110) {
        unknown_call((sp + 0xFFFFFFFFFFFFFFD0) + 16);
    }
    return;
}
void param_asm_multi_insn(void)
{
}
uint32 call_asm_multi_insn(void)
{
    uint64 var_18, var_28, var_38, var_48;
    uint8 var_2C;

    var_48 = *(uint64 *)(*(uint64 *)0x11FE8);
    x0_1 = "Hello ASM";
    var_28 = 0;   var_30 = 0;
    var_18 = *(uint64 *)(x0_1);
    *(uint16 *)(sp - 56 + 8) = (uint32)*(uint16 *)(x0_1 + 8);
    var_38 = 0;   var_40 = 0;
    x0_2 = param_asm_multi_insn(sp - 40, sp - 56, 9);
    /* cmp (int32)((uint32)var_28), 0x48 — 次の分岐のための比較 */
    __asm("b.ne #0xe30");
    /* cmp (int32)((uint32)var_2C), 0x6F — 次の分岐のための比較 */
    x0_3 = (uint32)((uint32)var_2C == 111 ? 42 : -1);
    loc_E10:
    x1 = *(uint64 *)0x11FE8;
    x3 = var_48 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0xe38");
    x0_4 = sub_870();
    x0_5 = 0xFFFFFFFF;
    __asm("b #0xe10");
    goto loc_E10;
    return x0;
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
}
void call_asm_simd(void)
{
    uint32 load_45;
    uint32 load_62;
    uint32 load_155;
    uint32 load_205;
    uint64 load_193;
    uint64 load_152;
    uint64 load_159;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFC8 = bit_insert(1, 2, 32, 16);
    local_pFFFFFFFFFFFFFFD0 = bit_insert(3, 4, 32, 16);
    local_pFFFFFFFFFFFFFFD8 = bit_insert(5, 6, 32, 16);
    local_pFFFFFFFFFFFFFFE0 = bit_insert(7, 8, 32, 16);
    param_asm_simd(/* arguments unknown */);
    load_155 = var_FFFFFFFFFFFFFFE8;
    load_62 = var_FFFFFFFFFFFFFFE8;
    load_45 = var_FFFFFFFFFFFFFFF0;
    load_205 = var_FFFFFFFFFFFFFFF4;
    load_193 = global_11FE8;
    load_152 = var_48;
    load_159 = memory_unknown;
    if ((uint64_t)load_152 != (uint64_t)load_159) {
        unknown_call(((load_155 + load_62) + load_45) + load_205);
    }
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
    uint32 load_60;
    uint64 load_52;
    uint64 load_111;
    uint64 load_29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFF4 = 10;
    param_asm_atomic(/* arguments unknown */);
    load_60 = var_14;
    load_52 = global_11FE8;
    load_111 = var_18;
    load_29 = memory_unknown;
    if ((uint64_t)load_111 != (uint64_t)load_29) {
        unknown_call(call_136 + load_60);
    }
    return;
}
uint32 param_dynamic_code(int64 a1)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x21 = (uint32)a1;
    x0_1 = sub_8D0(30);
    x0 = sub_8B0(0, x0_1, 7, 34, 0xFFFFFFFF, 0);
    /* cmn x0, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1024");
    x19 = (uint32)(x21 + 5);
    x0 = sub_8C0(x0, x0_1);
    loc_1010:
    return (uint32)x19;
    x19 = x0;
    __asm("b #0x1010");
    goto loc_1010;
}
uint64 param_memory_protection(void)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0_1 = sub_8D0(30);
    x0 = sub_8B0(0, x0_1, 3, 34, 0xFFFFFFFF, 0);
    /* cmn x0, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x10f0");
    *(uint32 *)(x0) = 42;
    x0 = sub_8E0(x0, x0_1, 1);
    __asm("cbz w0, #0x10ac");
    x21 = 0xFFFFFFFE;
    x0 = sub_8C0(x0, x0_1);
    loc_1098:
    return (uint32)x21;
    x21 = *(uint32 *)(x19);
    x1 = x20;
    x0 = sub_8E0(x19, x20, 3);
    __asm("cbz w0, #0x10d8");
    x1 = x20;
    x21 = 0xFFFFFFFD;
    x0 = sub_8C0(x19, x20);
    __asm("b #0x1098");
    goto loc_1098;
    *(uint32 *)(x19) = 100;
    x1 = x20;
    x0 = sub_8C0(x19, x20);
    __asm("b #0x1098");
    goto loc_1098;
    x21 = (uint32)x0;
    __asm("b #0x1098");
    goto loc_1098;
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
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x1218");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x121c");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
