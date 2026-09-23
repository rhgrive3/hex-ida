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
    test_control_flow_l1(/* arguments unknown */);
    test_control_flow_l2(/* arguments unknown */);
    test_control_flow_l3(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_26;
    uint64 load_9;
    load_26 = var_0;
    load_9 = global_12FF0;
    unknown_call(load_9);
    unknown_call(load_9);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FE0;
    __asm("cbz x0, #0xa84");
    return sub_9B0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x130B8 != 0x130B8) {
        if (!(global_12FD0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_21;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_21 = global_12FF8;
        if (!(load_21 == 0)) {
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
    if (!(global_130B8 != 0)) {
        if (!(global_12FD8 == 0)) {
            unknown_call(global_13008);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void recursion_factorial(void)
{
    while ((int32_t)phi(x1 - 1, a1) > 1) {
        continue;
    }
    return;
}
void double_value(void)
{
    return;
}
void triple_value(void)
{
    return;
}
void op_add(void)
{
    return;
}
void op_sub(void)
{
    return;
}
void op_mul(void)
{
    return;
}
void op_div(void)
{
    if (!(a2 == 0)) {
    }
    return;
}
void op_mod(void)
{
    if (!(a2 == 0)) {
    }
    return;
}
void op_and(void)
{
    return;
}
void op_or(void)
{
    return;
}
void op_xor(void)
{
    return;
}
void op_shl(void)
{
    return;
}
void op_shr(void)
{
    return;
}
void state_idle(void)
{
    return;
}
void state_processing(void)
{
    if ((uint32_t)a1 != 2) {
    }
    return;
}
void state_done(void)
{
    return;
}
void state_error(void)
{
    return;
}
void sequential_ops(void)
{
    return;
}
void single_if(void)
{
    if ((int32_t)a1 > 0) {
    }
    return;
}
void if_else(void)
{
    return;
}
uint32 nested_if_2(int64 a1, int64 a2)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc70");
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc6c");
    loc_C6C:
    return x0;
    __asm("b #0xc6c");
    goto loc_C6C;
}
uint32 nested_if_deep(int64 a1, int64 a2, int64 a3, int64 a4, int64 a5)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xca8");
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xcb0");
    /* cmp (int32)(a3), 0 — 次の分岐のための比較 */
    __asm("b.le #0xcb8");
    /* cmp (int32)(a4), 0 — 次の分岐のための比較 */
    __asm("b.le #0xcc0");
    /* cmp (int32)(a5), 0 — 次の分岐のための比較 */
    loc_CA4:
    return x0;
    __asm("b #0xca4");
    goto loc_CA4;
    __asm("b #0xca4");
    goto loc_CA4;
    __asm("b #0xca4");
    goto loc_CA4;
    __asm("b #0xca4");
    goto loc_CA4;
}
uint32 if_elseif_chain(int64 a1)
{
    __asm("cbz w0, #0xce4");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    __asm("b.eq #0xcec");
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    loc_CE0:
    return x0;
    __asm("b #0xce0");
    goto loc_CE0;
    __asm("b #0xce0");
    goto loc_CE0;
}
void if_elseif_long(void)
{
    return;
}
uint32 switch_small(uint8 a1)
{
    /* cmp (int32)(a1), 3 — 次の分岐のための比較 */
    __asm("b.hi #0xd20");
    loc_D1C:
    return x0;
    __asm("b #0xd1c");
    goto loc_D1C;
}
void switch_large(void)
{
    return;
}
void switch_default(void)
{
    return;
}
uint32 switch_fallthrough(int64 a1)
{
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0xd74");
    /* cmp (int32)(a1), 3 — 次の分岐のための比較 */
    __asm("b.eq #0xd84");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    __asm("b.eq #0xd8c");
    loc_D70:
    return x0;
    x1 = 0;
    loc_D78:
    x1 = (uint32)((uint32)x1 + (uint32)x0 * 2);
    loc_D7C:
    __asm("b #0xd70");
    goto loc_D70;
    x1 = 12;
    __asm("b #0xd78");
    goto loc_D78;
    x1 = 0;
    __asm("b #0xd7c");
    goto loc_D7C;
}
void loop_for_fixed(void)
{
    while ((int32_t)phi(x1 + 1, 0) < (int32_t)a1) {
        continue;
    }
    return;
}
void loop_while(void)
{
    while (phi(x0 / 10, a1) != 0) {
        continue;
    }
    return;
}
void loop_dowhile(void)
{
    while ((phi(x1, a1)) / 10 != 0) {
    }
    return;
}
void loop_nested(void)
{
    while ((int32_t)phi(0, x3 + 1) < (int32_t)a1) {
        continue;
    }
    return;
}
void loop_break(void)
{
    uint32 load_13;
    uint64 load_137;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    load_137 = global_224C;
    local_pFFFFFFFFFFFFFFE0 = global_2244;
    local_pFFFFFFFFFFFFFFE0 = global_2244;
    local_pFFFFFFFFFFFFFFF0 = global_2254;
    load_13 = ((sp + 0xFFFFFFFFFFFFFFD0) + 16)[phi(0, x1 + 1)];
    load_13 = ((sp + 0xFFFFFFFFFFFFFFD0) + 16)[phi(0, x1 + 1)];
    if ((uint32_t)load_13 != (uint32_t)a1) {
        if ((uint64_t)x1 + 1 != 5) {
            goto loc_E68;
        } else {
        }
    }
    if ((uint64_t)var_28 != (uint64_t)memory_unknown) {
        unknown_call(phi(phi(0, x1 + 1), 0xFFFFFFFF));
    }
    return;
}
void loop_continue(void)
{
    while ((int32_t)phi(x1 + 1, 1) <= (int32_t)a1) {
        if (!(bit_extract(phi(x1 + 1, 1), 0, 1) == 0)) {
        }
        continue;
    }
    return;
}
void goto_forward(void)
{
    if ((int32_t)a1 > 0) {
    }
    return;
}
void goto_backward(void)
{
    if ((int32_t)a1 > 0) {
        while ((int32_t)a1 >= (int32_t)(phi(x1, 1)) + 1) {
        }
    }
    return;
}
void ternary_op(void)
{
    return;
}
void test_control_flow_l1(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("=== 测试基础控制流特征 ===");
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    loop_for_fixed(/* arguments unknown */);
    unknown_call(1);
    loop_while(/* arguments unknown */);
    unknown_call(1);
    loop_dowhile(/* arguments unknown */);
    unknown_call(1);
    loop_nested(/* arguments unknown */);
    unknown_call(1);
    loop_break(/* arguments unknown */);
    unknown_call(1);
    loop_break(/* arguments unknown */);
    unknown_call(1);
    loop_continue(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
}
uint32 loop_multi_exit(int64 a1)
{
    uint64 var_48;

    var_48 = *(uint64 *)(*(uint64 *)0x12FE8);
    x1 = sp - 56;
    x2_1 = 0x2240 + 24;
    v0 = *(vector128 *)(x2_1);   v1 = *(vector128 *)(x2_1 + 0x10);
    *(vector128 *)(x1) = *(uint128 *)(x2_1);   *(vector128 *)(x1 + 0x10) = *(uint128 *)(0x2240 + 40);
    x2 = 0;
    *(vector128 *)(x1 + 0x20) = *(uint128 *)(0x2240 + 56);
    x3 = 0;
    x5 = *(uint32 *)(x1 + x3 * 4);
    /* cmp (int32)(x5), (int32)(a1) — 次の分岐のための比較 */
    __asm("b.ne #0x120c");
    x0_1 = (uint32)((uint32)x3 + (uint32)x2 * 10);
    loc_11EC:
    x1 = *(uint64 *)0x12FE8;
    x3 = var_48 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x1230");
    x0_2 = sub_9A0();
    x3 = x3 + 1;
    /* cmp x3, 4 — 次の分岐のための比較 */
    __asm("b.ne #0x11d8");
    x2 = (uint32)((uint32)x2 + 1);
    x1 = x1 + 16;
    /* cmp (int32)(x2), 3 — 次の分岐のための比較 */
    __asm("b.ne #0x11d4");
    x0_3 = 0xFFFFFFFF;
    __asm("b #0x11ec");
    goto loc_11EC;
    return x0;
}
void infinite_loop(void)
{
    if ((uint32_t)a1->field_0 != 1) {
        if ((uint32_t)(phi(x0, 0)) + 1 != 0x3E9) {
            goto loc_1240;
        } else {
            a1->field_0 = 1;
        }
    }
    return;
}
uint32 multi_return(int64 a1)
{
    x1 = (uint32)a1;
    __asm("tbnz w0, #0x1f, #0x1284");
    /* cmp (int32)((uint32)((uint32)a1 * 2)), 0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x128c");
    __asm("tbz w1, #0, #0x1280");
    loc_1280:
    return x0;
    __asm("b #0x1280");
    goto loc_1280;
    __asm("b #0x1280");
    goto loc_1280;
}
void conditional_return(void)
{
    return;
}
void duffs_device(void)
{
    loc_12C4:
    loc_12A8:
        __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
        if ((int32_t)a3 <= 0) goto loc_133C;
        goto loc_12B8;
    loc_12B8:
        if ((uint32_t)(a3 & 7) - 1 > 6) goto loc_12E8;
        goto loc_12D0;
    loc_12D0:
        __asm("br x5");
    loc_12E8:
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown;
        if ((uint32_t)phi((a3 + 7) >> 3, v55 - 1) == 1) goto loc_1340;
        goto loc_1330;
    loc_1330:
        goto loc_12E8;
    loc_133C:
    loc_1340:
        return;
}
void loop_complex_cond(void)
{
    while (condition_le) {
        continue;
    }
    return;
}
void loop_modify_var(void)
{
    while ((int32_t)phi((phi(x1, x1 + 2)) + 1, 0) < (int32_t)a1) {
        if ((int32_t)phi((phi(x1, x1 + 2)) + 1, 0) > 5) {
        }
        continue;
    }
    return;
}
void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(x0, 0)) + 1 == 0x65) {
            break;
        }
    }
    return;
}
void tail_recursion(void)
{
    while ((int32_t)phi(a1, x2 - 1) > 1) {
        continue;
    }
    return;
}
uint32 indirect_recursion_a(int64 a1, int64 a2)
{
    x2 = 2;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0x1418");
    __asm("tbnz w0, #0, #0x1408");
    x0 = (uint32)((uint32)a1 / (uint32)x2);
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1418");
    x0 = (uint32)(x0 + 1);
    loc_1400:
    x1 = (uint32)((uint32)a2 - 2);
    __asm("b #0x13e4");
    x0 = (uint32)((uint32)x0 * 3);
    /* cmp (int32)(x1), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x141c");
    return x0;
    x0 = (uint32)((uint32)x0 + 2);
    __asm("b #0x1400");
    goto loc_1400;
}
uint32 call_func_ptr(int64 a1, int64 a2)
{
    __asm("br x16");
}
void call_func_ptr_array(void)
{
    uint64 load_1;
    loc_1448:
    loc_1430:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE0 = global_13010;
        local_pFFFFFFFFFFFFFFE0 = global_13010;
        local_pFFFFFFFFFFFFFFF0 = global_13020;
        load_1 = global_12FE8;
        __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
        if ((uint32_t)a1 > 2) goto loc_14A8;
        goto loc_1480;
    loc_1480:
        if ((uint64_t)var_28 == (uint64_t)memory_unknown) goto loc_1498;
        goto loc_1494;
    loc_1494:
        unknown_call(phi(var_28 - memory_unknown, a2));
    loc_1498:
        __asm("br x16");
    loc_14A8:
        if ((uint64_t)var_28 != (uint64_t)memory_unknown) goto loc_1494;
        goto loc_14BC;
    loc_14BC:
        return;
}
void call_virtual_func(void)
{
    return;
}
void process_with_callback(void)
{
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x23;
    local_pFFFFFFFFFFFFFFD0 = local_x19;
    local_pFFFFFFFFFFFFFFD0 = local_x19;
    while ((int32_t)phi(call_164, a2) > (int32_t)phi(call_191, 0)) {
        unknown_call((phi(call_207, a1))[phi(call_191, 0)]);
        continue;
    }
    return;
}
void test_control_flow_l2(void)
{
    uint64 load_378;
    uint64 load_149;
    uint64 load_240;
    uint64 load_231;
    uint64 load_548;
    uint64 load_316;
    uint64 load_492;
    local_pFFFFFFFFFFFFFF60 = local_x29;
    local_pFFFFFFFFFFFFFF60 = local_x29;
    local_pFFFFFFFFFFFFFF70 = local_x19;
    local_pFFFFFFFFFFFFFF70 = local_x19;
    local_pFFFFFFFFFFFFFF80 = local_x21;
    load_378 = memory_unknown;
    local_pFFFFFFFFFFFFFFF8 = load_378;
    unknown_call("=== 测试高级控制流特征 ===");
    loop_multi_exit(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF98 = 0;
    infinite_loop(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_149 = global_2288;
    load_240 = global_2298;
    local_pFFFFFFFFFFFFFFD8 = 0;
    local_pFFFFFFFFFFFFFFD8 = 0;
    local_pFFFFFFFFFFFFFFE8 = 0;
    local_pFFFFFFFFFFFFFFE8 = 0;
    local_pFFFFFFFFFFFFFFB8 = load_149;
    local_pFFFFFFFFFFFFFFB8 = load_149;
    duffs_device(/* arguments unknown */);
    unknown_call(1);
    loop_complex_cond(/* arguments unknown */);
    unknown_call(1);
    loop_modify_var(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF9C = 0;
    loop_external_state(/* arguments unknown */);
    unknown_call(1);
    recursion_factorial(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    indirect_recursion_a(/* arguments unknown */);
    unknown_call(1);
    call_func_ptr(/* arguments unknown */);
    unknown_call(1);
    call_func_ptr_array(/* arguments unknown */);
    unknown_call(1);
    call_func_ptr_array(/* arguments unknown */);
    unknown_call(1);
    load_231 = global_22A8;
    local_pFFFFFFFFFFFFFFA0 = global_22A8;
    local_pFFFFFFFFFFFFFFA0 = global_22A8;
    local_pFFFFFFFFFFFFFFB0 = global_22B8;
    process_with_callback(/* arguments unknown */);
    unknown_call(1);
    load_548 = global_12FE8;
    load_316 = var_98;
    load_492 = memory_unknown;
    if ((uint64_t)load_316 != (uint64_t)load_492) {
        unknown_call(load_548);
    }
    return;
}
uint32 non_local_jump(int64 a1)
{
    uint32 var_1C;

    var_1C = x0_2;
    x0_1 = sub_960(0x130C0);
    __asm("cbnz w0, #0x17fc");
    x0_2 = var_1C;
    __asm("tbz w0, #0x1f, #0x17e0");
    x1_1 = 1;
    loc_17D4:
    x0_3 = sub_9E0(0x130C0);
    /* cmp (int32)((uint32)var_1C), 0x64 — 次の分岐のための比較 */
    __asm("b.le #0x1800");
    x1_2 = 2;
    __asm("b #0x17d4");
    goto loc_17D4;
    return x0;
}
uint32 cpp_exception(int64 a1)
{
    __asm("tbnz w0, #0x1f, #0x1820");
    /* cmp (int32)(a1), 0x65 — 次の分岐のための比較 */
    loc_181C:
    return x0;
    __asm("b #0x181c");
    goto loc_181C;
}
void large_jump_table(void)
{
    uint64 load_104;
    uint64 load_213;
    uint64 load_28;
    loc_1840:
    loc_1828:
        local_pFFFFFFFFFFFFFF90 = local_x29;
        local_pFFFFFFFFFFFFFF90 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFA8 = global_13028;
        local_pFFFFFFFFFFFFFFA8 = global_13028;
        load_104 = global_13048;
        local_pFFFFFFFFFFFFFFC8 = global_13048;
        local_pFFFFFFFFFFFFFFC8 = global_13048;
        load_213 = global_13068;
        load_28 = global_12FE8;
        local_pFFFFFFFFFFFFFFE8 = load_213;
        __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
        if ((uint32_t)a1 > 9) goto loc_18B0;
        goto loc_1888;
    loc_1888:
        if ((uint64_t)var_68 == (uint64_t)memory_unknown) goto loc_18A0;
        goto loc_189C;
    loc_189C:
        unknown_call(phi(var_68 - memory_unknown, a2));
    loc_18A0:
        __asm("br x16");
    loc_18B0:
        if ((uint64_t)var_68 != (uint64_t)memory_unknown) goto loc_189C;
        goto loc_18C4;
    loc_18C4:
        return;
}
void conditional_func_ptr(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (a1 == 0) {
    } else {
    }
    __asm("br x16");
}
uint32 state_machine(int64 a1, int64 a2, int64 a3)
{
    x0 = (uint32)a2;
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    __asm("b.hi #0x1930");
    __asm("br x1");
    return x0;
    /* cmp (int32)(x2), 1 — 次の分岐のための比較 */
    __asm("b #0x1934");
    /* cmp (int32)(x2), 2 — 次の分岐のための比較 */
    __asm("b.eq #0x1968");
    /* cmp (int32)(x2), 0x63 — 次の分岐のための比較 */
    __asm("b #0x1934");
    /* cmp (int32)(x2), 0 — 次の分岐のための比較 */
    __asm("b #0x1934");
    __asm("b #0x1934");
}
uint32 fsm_func_table(int64 a2)
{
    uint64 var_38;

    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    x3_1 = *(uint64 *)(*(uint64 *)0x12FE8);
    var_38 = x3_1;
    x3 = sp - 40;
    ? = *(uint64 *)(0x13010 + 104);
    x2 = *(uint64 *)0x12FE8;
    *(uint64 *)(x3) = ?;
    __asm("b.hi #0x19dc");
    x3_1 = *(uint64 *)(*(uint64 *)0x12FE8);
    x5 = x3_1 - *(uint64 *)(x2);
    x4 = 0;
    __asm("b.eq #0x19cc");
    x0_1 = sub_9A0();
    __asm("br x16");
    x0_2 = var_38 - *(uint64 *)(x2);
    x1 = 0;
    __asm("b.ne #0x19c8");
    return 3;
}
uint32 computed_goto(int64 a2)
{
    uint64 var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x12FE8);
    x2_1 = sp - 40;
    ? = *(uint64 *)(0x13010 + 136);
    *(uint64 *)(x2_1) = ?;
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    __asm("b.hi #0x1a7c");
    __asm("br x0");
    x0_1 = 0;
    x1 = *(uint64 *)0x12FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2_2 = 0;
    __asm("b.eq #0x1a84");
    x0_2 = sub_9A0();
    x0_3 = 10;
    __asm("b #0x1a44");
    x0_4 = 20;
    __asm("b #0x1a44");
    x0_5 = 30;
    __asm("b #0x1a44");
    x0_6 = 0xFFFFFFFF;
    __asm("b #0x1a44");
    return x0;
}
void obfuscated_cf(void)
{
    return;
}
void opaque_predicate(void)
{
    return;
}
uint32 overlapped_code(int64 a1)
{
    __asm("tbz w0, #0, #0x1aac");
    loc_1AA8:
    return x0;
    __asm("b #0x1aa8");
    goto loc_1AA8;
}
void test_control_flow_l3(void)
{
    uint64 load_244;
    uint64 load_86;
    uint64 load_342;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x19;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试极端控制流特征 ===");
    non_local_jump(/* arguments unknown */);
    unknown_call(1);
    non_local_jump(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    large_jump_table(/* arguments unknown */);
    unknown_call(1);
    conditional_func_ptr(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    fsm_func_table(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFFE8 = 0x100000000;
    local_pFFFFFFFFFFFFFFF0 = bit_insert(2, 3, 32, 16);
    computed_goto(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_244 = global_12FE8;
    load_86 = var_38;
    load_342 = memory_unknown;
    if ((uint64_t)load_86 != (uint64_t)load_342) {
        unknown_call(load_244);
    }
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
