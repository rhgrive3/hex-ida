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
    test_obf_opt_edge(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_35;
    uint64 load_38;
    load_35 = var_0;
    load_38 = global_11FF0;
    unknown_call(load_38);
    unknown_call(load_38);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FE0;
    __asm("cbz x0, #0xa04");
    return sub_900(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_6;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x12018 != 0x12018) {
        load_6 = global_11FD0;
        if (!(load_6 == 0)) {
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
    if (!(global_12018 != 0)) {
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
void div_zero_handler(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    global_12020 = 1;
    unknown_call(0x12028);
}
void segv_handler(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    global_12160 = 1;
    unknown_call(0x12168);
}
void param_fake_branch(void)
{
    return;
}
void call_fake_branch(void)
{
    return;
}
void param_opaque_predicate(void)
{
    while (phi((phi(x1, a1)) - (((phi(x1, a1)) / x1) * x1), a1 + 1) != 0) {
        continue;
    }
    return;
}
void call_opaque_predicate(void)
{
}
void param_instruction_substitution(void)
{
    return;
}
void call_instruction_substitution(void)
{
    return;
}
void decrypt_string(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(a2);
    memory_unknown = 0;
    while (memory_unknown != 0) {
        memory_unknown = memory_unknown ^ (uint32_t)a4 & 0xFF;
        continue;
    }
    return;
}
void param_string_encryption(void)
{
    uint8 load_48;
    uint64 load_22;
    uint64 load_143;
    uint64 load_40;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x19;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    decrypt_string(/* arguments unknown */);
    unknown_call((sp + 0xFFFFFFFFFFFFFFB0) + 40);
    load_48 = var_FFFFFFFFFFFFFFD8;
    load_22 = global_11FE8;
    load_143 = var_48;
    load_40 = memory_unknown;
    if ((uint64_t)load_143 != (uint64_t)load_40) {
        unknown_call(load_48 + call_270);
    }
    return;
}
void call_string_encryption(void)
{
}
void param_tail_call_optimized(void)
{
    while ((int32_t)phi(a1, x2 - 1) > 0) {
        continue;
    }
    return;
}
void call_tail_call_optimized(void)
{
    return;
}
void param_non_tail_call(void)
{
    while ((int32_t)phi(a1, x1 - 1) > 0) {
        continue;
    }
    return;
}
void call_non_tail_call(void)
{
}
void param_vectorized_loop(void)
{
    while ((int32_t)a4 > (int32_t)phi(x4 + 1, 0)) {
        a3[local_phi_154] = a1[local_phi_154] + a2[local_phi_154];
        continue;
    }
    while ((int32_t)a4 > (int32_t)phi(x1 + 1, 0)) {
        continue;
    }
    return;
}
void call_vectorized_loop(void)
{
    uint64 load_6;
    uint64 load_60;
    uint64 load_172;
    uint64 load_105;
    uint64 load_30;
    local_pFFFFFFFFFFFFFF80 = local_x29;
    local_pFFFFFFFFFFFFFF80 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFD8 = 0;
    local_pFFFFFFFFFFFFFFD8 = 0;
    local_pFFFFFFFFFFFFFF98 = global_1320;
    local_pFFFFFFFFFFFFFF98 = global_1320;
    load_6 = global_1340;
    load_60 = global_1340;
    local_pFFFFFFFFFFFFFFE8 = 0;
    local_pFFFFFFFFFFFFFFE8 = 0;
    local_pFFFFFFFFFFFFFFB8 = load_6;
    local_pFFFFFFFFFFFFFFB8 = load_6;
    param_vectorized_loop(/* arguments unknown */);
    load_172 = global_11FE8;
    load_105 = var_78;
    load_30 = memory_unknown;
    if ((uint64_t)load_105 != (uint64_t)load_30) {
        unknown_call((sp + 0xFFFFFFFFFFFFFF80) + 24);
    }
    return;
}
void param_link_time_optimization(void)
{
    return;
}
void call_link_time_optimization(void)
{
    return;
}
uint32 param_division_by_zero(int64 a1)
{
    uint32 var_1C;

    var_1C = x1;
    x0_1 = sub_8C0(8, 0xAD4);
    x0_2 = sub_890(0x12020 + 8);
    __asm("cbnz w0, #0xdec");
    x1 = var_1C;
    loc_DE4:
    return x0;
    __asm("b #0xde4");
    goto loc_DE4;
}
void call_division_by_zero(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    param_division_by_zero(/* arguments unknown */);
    param_division_by_zero(/* arguments unknown */);
    unknown_call(8);
    return;
}
uint32 param_null_pointer_deref(int64 a1)
{
    uint64 var_18;

    var_18 = a1;
    x0_1 = sub_8C0(11, 0xAF4);
    x0_2 = sub_890(0x12020 + 328);
    __asm("cbnz w0, #0xe74");
    x0_3 = var_18;
    loc_E6C:
    return x0;
    __asm("b #0xe6c");
    goto loc_E6C;
}
void call_null_pointer_deref(void)
{
    uint64 load_70;
    uint64 load_5;
    uint64 load_126;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFF4 = 42;
    param_null_pointer_deref(/* arguments unknown */);
    param_null_pointer_deref(/* arguments unknown */);
    unknown_call(11);
    load_70 = global_11FE8;
    load_5 = var_28;
    load_126 = memory_unknown;
    if ((uint64_t)load_5 != (uint64_t)load_126) {
        unknown_call(call_197 + call_181);
    }
    return;
}
void param_buffer_overflow_stack(void)
{
    return;
}
uint32 param_buffer_overflow_heap(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_8D0(16);
    __asm("cbz x0, #0xf2c");
    x0_2 = sub_930(x0_1);
    loc_F20:
    return x0;
    __asm("b #0xf20");
    goto loc_F20;
}
void call_buffer_overflow(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_buffer_overflow_heap(/* arguments unknown */);
    return;
}
void param_integer_overflow(void)
{
    if (condition_le) {
        if ((int32_t)(uint32_t)((uint32_t)a1 & (uint32_t)a2) < 0) {
        }
    } else {
    }
    return;
}
void call_integer_overflow(void)
{
    return;
}
void param_undefined_behavior(void)
{
    return;
}
void call_undefined_behavior(void)
{
    return;
}
void param_implementation_defined(void)
{
    return;
}
void call_implementation_defined(void)
{
    return;
}
void test_obf_opt_edge(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试混淆、优化与边界情况 ===");
    unknown_call(1);
    call_opaque_predicate(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    param_string_encryption(/* arguments unknown */);
    unknown_call(1);
    call_tail_call_optimized(/* arguments unknown */);
    unknown_call(1);
    call_non_tail_call(/* arguments unknown */);
    unknown_call(1);
    call_vectorized_loop(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    call_division_by_zero(/* arguments unknown */);
    unknown_call(1);
    call_null_pointer_deref(/* arguments unknown */);
    unknown_call(1);
    call_buffer_overflow(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
