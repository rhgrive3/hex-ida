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
void start(void)
{
    uint64 load_36;
    uint64 load_8;
    load_36 = var_0;
    load_8 = global_11FF0;
    unknown_call(load_8);
    unknown_call(load_8);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FE0;
    __asm("cbz x0, #0x9c4");
    return sub_900(x0_1);
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
uint32 param_opaque_predicate(int64 a1)
{
    x5 = (uint32)((uint32)a1 * 2);
    x1 = (uint32)((uint32)a1 + 1);
    /* cmp (int32)((uint32)((uint32)(x5 + (uint32)a1 * (uint32)a1) + 1)), (int32)((uint32)(x1 * x1)) — 次の分岐のための比較 */
    x6 = (uint32)((uint32)((uint32)(x5 + (uint32)a1 * (uint32)a1) + 1) == (uint32)(x1 * x1) ? 1 : 0);
    __asm("cbz w1, #0xb2c");
    x2 = (uint32)a1;
    x1 = (uint32)((uint32)x2 - (uint32)((uint32)x2 / (uint32)x1) * (uint32)x1);
    x2 = (uint32)x1;
    __asm("cbnz w1, #0xb04");
    /* cmp (int32)(x6), 0 — 次の分岐のための比較 */
    /* ccmp (int32)(x2), 1, 0, ne — 次の分岐のための比較 */
    __asm("b.ne #0xb2c");
    loc_B28:
    return x0;
    __asm("b #0xb28");
    goto loc_B28;
}
void call_opaque_predicate(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_opaque_predicate(/* arguments unknown */);
    return;
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
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(a2);
    memory_unknown = 0;
    if (!(memory_unknown == 0)) {
        memory_unknown = (uint32_t)a4 & 0xFF ^ (uint32_t)local_phi_200;
        while (memory_unknown != 0) {
        }
    }
    return;
}
void param_string_encryption(void)
{
    uint8 load_107;
    uint64 load_99;
    uint64 load_42;
    uint64 load_143;
    loc_BDC:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        decrypt_string(/* arguments unknown */);
        unknown_call((sp + 0xFFFFFFFFFFFFFFB0) + 40);
        load_107 = var_FFFFFFFFFFFFFFD8;
        load_99 = global_11FE8;
        load_42 = var_48;
        load_143 = memory_unknown;
        if ((uint64_t)load_42 != (uint64_t)load_143) goto loc_C50;
        goto loc_C44;
    loc_C44:
        return;
    loc_C50:
        unknown_call(load_107 + call_244);
}
void call_string_encryption(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_string_encryption(/* arguments unknown */);
    return;
}
void param_tail_call_optimized(void)
{
    if ((int32_t)a1 <= 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        param_tail_call_optimized(/* arguments unknown */);
        return;
    }
}
void call_tail_call_optimized(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_tail_call_optimized(/* arguments unknown */);
    return;
}
void param_non_tail_call(void)
{
    if ((int32_t)a1 <= 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        param_non_tail_call(/* arguments unknown */);
        return;
    }
}
void call_non_tail_call(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_non_tail_call(/* arguments unknown */);
    return;
}
uint32 param_vectorized_loop(void * a1, void * a2, void * a3, int64 a4)
{
    /* cmp (int32)(a4), 0 — 次の分岐のための比較 */
    __asm("b.le #0xd48");
    x4 = 0;
    *(uint32 *)(a3 + x4 * 4) = (uint32)((uint32)*(uint32 *)(a1 + x4 * 4) + (uint32)*(uint32 *)(a2 + x4 * 4));
    x4 = x4 + 1;
    /* cmp (int32)(a4), (int32)(x4) — 次の分岐のための比較 */
    __asm("b.gt #0xd0c");
    x1 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(a3 + x1 * 4));
    x1 = x1 + 1;
    /* cmp (int32)(a4), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0xd30");
    loc_D44:
    return x0;
    __asm("b #0xd44");
    goto loc_D44;
}
void call_vectorized_loop(void)
{
    uint64 load_46;
    uint64 load_92;
    uint64 load_59;
    uint64 load_154;
    uint64 load_161;
    loc_D50:
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFF98 = global_13B0;
        local_pFFFFFFFFFFFFFF98 = global_13B0;
        load_46 = global_13D0;
        load_92 = global_13D0;
        local_pFFFFFFFFFFFFFFB8 = load_46;
        local_pFFFFFFFFFFFFFFB8 = load_46;
        local_pFFFFFFFFFFFFFFD8 = 0;
        local_pFFFFFFFFFFFFFFD8 = 0;
        local_pFFFFFFFFFFFFFFE8 = 0;
        local_pFFFFFFFFFFFFFFE8 = 0;
        param_vectorized_loop(/* arguments unknown */);
        load_59 = global_11FE8;
        load_154 = var_78;
        load_161 = memory_unknown;
        if ((uint64_t)load_154 != (uint64_t)load_161) goto loc_DC4;
        goto loc_DBC;
    loc_DBC:
        return;
    loc_DC4:
        unknown_call((sp + 0xFFFFFFFFFFFFFF80) + 24);
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
    x0_1 = sub_8C0(8, 0xA94);
    x0_2 = sub_890(0x12020 + 8);
    __asm("cbnz w0, #0xe20");
    x1 = var_1C;
    loc_E18:
    return x0;
    __asm("b #0xe18");
    goto loc_E18;
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
    x0_1 = sub_8C0(11, "\\n");
    x0_2 = sub_890(0x12020 + 328);
    __asm("cbnz w0, #0xea8");
    x0_3 = var_18;
    loc_EA0:
    return x0;
    __asm("b #0xea0");
    goto loc_EA0;
}
void call_null_pointer_deref(void)
{
    uint64 load_61;
    uint64 load_112;
    uint64 load_115;
    loc_EB0:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x19;
        local_pFFFFFFFFFFFFFFE0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFF4 = 42;
        param_null_pointer_deref(/* arguments unknown */);
        param_null_pointer_deref(/* arguments unknown */);
        unknown_call(11);
        load_61 = global_11FE8;
        load_112 = var_28;
        load_115 = memory_unknown;
        if ((uint64_t)load_112 != (uint64_t)load_115) goto loc_F28;
        goto loc_F1C;
    loc_F1C:
        return;
    loc_F28:
        unknown_call(call_201 + call_182);
}
void param_buffer_overflow_stack(void)
{
    return;
}
uint32 param_buffer_overflow_heap(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    x0_1 = sub_8D0(16);
    __asm("cbz x0, #0xf6c");
    x1 = 33;
    x1 = (uint32)((uint32)x1 - 1);
    __asm("b.ne #0xf50");
    x0_2 = sub_930();
    loc_F5C:
    return (uint32)x19;
    x19 = 0xFFFFFFFE;
    __asm("b #0xf5c");
    goto loc_F5C;
}
void call_buffer_overflow(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_buffer_overflow_heap(/* arguments unknown */);
    return;
}
uint32 param_integer_overflow(int64 a1, int64 a2)
{
    x2 = (uint32)a1;
    x0 = (uint32)((uint32)a1 + (uint32)a2);
    /* cmp (int32)(x2), 0 — 次の分岐のための比較 */
    /* ccmp (int32)(a2), 0, 4, gt — 次の分岐のための比較 */
    /* ccmp (int32)(x0), 0, 0, gt — 次の分岐のための比較 */
    __asm("b.lt #0xfbc");
    /* tst (int32)(x2), (int32)(a2) — 次の分岐のための比較 */
    /* ccmp (int32)(x0), 0, 4, mi — 次の分岐のための比較 */
    loc_FB8:
    return x0;
    __asm("b #0xfb8");
    goto loc_FB8;
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
    unknown_call(0x1180);
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
    unknown_call(1);
    return;
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_obf_opt_edge(/* arguments unknown */);
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
