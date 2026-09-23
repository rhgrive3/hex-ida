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
    uint64 load_10;
    uint64 load_15;
    load_10 = var_0;
    load_15 = global_13FF0;
    unknown_call(load_15);
    unknown_call(load_15);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FE0;
    __asm("cbz x0, #0xa44");
    return sub_9B0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_31;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x140B8 != 0x140B8) {
        load_31 = global_13FD0;
        if (!(load_31 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_56;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_56 = global_13FF8;
        if (!(load_56 == 0)) {
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
    if (!(global_140B8 != 0)) {
        if (!(global_13FD8 == 0)) {
            unknown_call(global_14008);
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
    if ((int32_t)a1 <= 1) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        recursion_factorial(/* arguments unknown */);
        return;
    }
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
    return;
}
void if_else(void)
{
    return;
}
uint32 nested_if_2(int64 a1, int64 a2)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc48");
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    loc_C44:
    return x0;
    __asm("b #0xc44");
    goto loc_C44;
}
uint32 nested_if_deep(int64 a1, int64 a2, int64 a3, int64 a4, int64 a5)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc84");
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc80");
    /* cmp (int32)(a3), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc8c");
    /* cmp (int32)(a4), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc94");
    /* cmp (int32)(a5), 0 — 次の分岐のための比較 */
    loc_C80:
    return x0;
    __asm("b #0xc80");
    goto loc_C80;
    __asm("b #0xc80");
    goto loc_C80;
    __asm("b #0xc80");
    goto loc_C80;
}
uint32 if_elseif_chain(int64 a1)
{
    __asm("cbz w0, #0xcb8");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    __asm("b.eq #0xcc0");
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    loc_CB4:
    return x0;
    __asm("b #0xcb4");
    goto loc_CB4;
    __asm("b #0xcb4");
    goto loc_CB4;
}
uint32 if_elseif_long(int64 a1)
{
    __asm("cbz w0, #0xcf4");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    __asm("b.eq #0xcfc");
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0xd04");
    /* cmp (int32)(a1), 3 — 次の分岐のための比較 */
    __asm("b.eq #0xd0c");
    /* cmp (int32)(a1), 4 — 次の分岐のための比較 */
    loc_CF0:
    return x0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
    goto loc_CF0;
}
uint32 switch_small(int64 a1)
{
    x1 = (uint32)a1;
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0xd4c");
    __asm("b.gt #0xd3c");
    __asm("cbz w1, #0xd38");
    /* cmp (int32)(x1), 1 — 次の分岐のための比較 */
    loc_D38:
    return x0;
    /* cmp (int32)(x0), 3 — 次の分岐のための比較 */
    __asm("b #0xd38");
    goto loc_D38;
    __asm("b #0xd38");
    goto loc_D38;
}
void switch_large(void)
{
    if ((uint32_t)a1 == 5) {
    } else {
        if ((int32_t)a1 > 5) {
            if ((uint32_t)a1 != 8) {
                if ((int32_t)a1 <= 8) {
                    if ((uint32_t)a1 != 6) {
                    }
                } else {
                }
            }
        } else {
            if ((uint32_t)a1 == 2) {
            } else {
                if ((int32_t)a1 <= 2) {
                    if (!(a1 == 0)) {
                    }
                } else {
                }
            }
        }
    }
    return;
}
void switch_default(void)
{
    if ((uint32_t)a1 != 2) {
        if ((uint32_t)a1 != 3) {
        }
    }
    return;
}
uint32 switch_fallthrough(int64 a1)
{
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0xe30");
    /* cmp (int32)(a1), 3 — 次の分岐のための比較 */
    __asm("b.eq #0xe38");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    __asm("b.eq #0xe48");
    __asm("b #0xe44");
    x1 = 0;
    __asm("b #0xe3c");
    x1 = 12;
    x1 = (uint32)((uint32)x1 + (uint32)x0 * 2);
    loc_E40:
    return x0;
    x1 = 0;
    __asm("b #0xe40");
    goto loc_E40;
}
uint32 loop_for_fixed(int64 a1)
{
    x2 = (uint32)a1;
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xe78");
    x1 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)x1);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp (int32)(x2), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.ne #0xe64");
    loc_E74:
    return x0;
    __asm("b #0xe74");
    goto loc_E74;
}
uint32 loop_while(int64 a1)
{
    __asm("cbz w0, #0xeb0");
    x2 = 0;
    x3 = 0x66666667;
    x2 = (uint32)((uint32)x2 + 1);
    x0 = (uint32)((uint32)((int32)(uint32)a1 * (int32)(uint32)x3 >> 34) - ((uint32)a1 >> 31));
    __asm("b.ne #0xe90");
    loc_EA4:
    /* cmp (int32)(x2), 0 — 次の分岐のための比較 */
    return (uint32)((uint32)x2 > 0 ? (uint32)x2 : 1);
    x2 = (uint32)x0;
    __asm("b #0xea4");
    goto loc_EA4;
}
void loop_dowhile(void)
{
    while ((uint32_t)((sext(phi(a1, v47 - (x2 >> 31)))) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34 != (uint32_t)x2 >> 31) {
    }
    return;
}
void loop_nested(void)
{
    if ((int32_t)a1 > 0) {
        if ((int32_t)a2 > 0) {
            while ((uint32_t)a2 != (uint32_t)(phi(x2, 0)) + 1) {
            }
        } else {
        }
        if ((uint32_t)a1 != (uint32_t)(phi(x3, 0)) + 1) {
            goto loc_F14;
        }
    }
    return;
}
void loop_break(void)
{
    uint64 load_100;
    uint64 load_157;
    uint64 load_126;
    uint64 load_73;
    uint64 load_197;
    loc_F24:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        load_100 = global_2488;
        load_157 = global_2490;
        local_pFFFFFFFFFFFFFFE0 = load_100;
        local_pFFFFFFFFFFFFFFE0 = load_100;
        local_pFFFFFFFFFFFFFFF0 = global_2498;
    loc_F64:
        if ((uint32_t)memory_unknown == (uint32_t)a1) goto loc_F84;
        goto loc_F70;
    loc_F70:
        if ((uint32_t)(phi(0, x0)) + 1 != 5) goto loc_F64;
        goto loc_F80;
    loc_F80:
    loc_F84:
        load_126 = global_13FE8;
        load_73 = var_28;
        load_197 = memory_unknown;
        if ((uint64_t)load_73 != (uint64_t)load_197) goto loc_FA8;
        goto loc_FA0;
    loc_FA0:
        return;
    loc_FA8:
        unknown_call(phi(0xFFFFFFFF, phi(0, x0)));
}
uint32 loop_continue(int64 a1)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xfdc");
    x3 = (uint32)((uint32)a1 + 1);
    x1 = 1;
    x0 = 0;
    /* tst x1, 1 — 次の分岐のための比較 */
    x0 = (uint32)(!Z_tst64(x1, 1) ? (uint32)((uint32)x0 + (uint32)x1) : (uint32)x0);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp (int32)(x1), (int32)(x3) — 次の分岐のための比較 */
    __asm("b.ne #0xfc0");
    loc_FD8:
    return x0;
    __asm("b #0xfd8");
    goto loc_FD8;
}
void goto_forward(void)
{
    return;
}
uint32 goto_backward(int64 a1)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0x1020");
    x2 = (uint32)((uint32)a1 + 1);
    x1 = 1;
    x0 = 1;
    x0 = (uint32)((uint32)x0 * (uint32)x1);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp (int32)(x1), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.ne #0x100c");
    loc_101C:
    return x0;
    __asm("b #0x101c");
    goto loc_101C;
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
    unknown_call(0x1E40);
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
    goto_backward(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    return;
}
uint32 loop_multi_exit(int64 a1)
{
    uint64 var_48;

    var_48 = *(uint64 *)(*(uint64 *)0x13FE8);
    x1 = 0x2488 + 24;
    x2 = sp - 56;
    v0 = *(vector128 *)(x1);   v1 = *(vector128 *)(x1 + 0x10);
    *(vector128 *)(x2) = *(uint128 *)(x1);   *(vector128 *)(x2 + 0x10) = *(uint128 *)(0x2488 + 40);
    *(vector128 *)(x2 + 0x20) = *(uint128 *)(0x2488 + 56);
    x4 = 0;
    x1 = 0;
    /* cmp (int32)((uint32)*(uint32 *)(x2 + x1 * 4)), (int32)(a1) — 次の分岐のための比較 */
    __asm("b.eq #0x1348");
    x1 = x1 + 1;
    /* cmp x1, 4 — 次の分岐のための比較 */
    __asm("b.ne #0x12f8");
    x4 = (uint32)((uint32)x4 + 1);
    x2 = x2 + 16;
    /* cmp (int32)(x4), 3 — 次の分岐のための比較 */
    __asm("b.ne #0x12f4");
    x0_1 = 0xFFFFFFFF;
    loc_1324:
    x1 = *(uint64 *)0x13FE8;
    x3 = var_48 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x1354");
    return x0;
    x4 = (uint32)((uint32)x4 * 5);
    x0_2 = (uint32)((uint32)x1 + x4 * 2);
    __asm("b #0x1324");
    goto loc_1324;
    x0_3 = sub_9A0();
}
void infinite_loop(void)
{
    if ((uint32_t)a1->field_0 != 1) {
        if ((uint32_t)(phi(0, x0)) + 1 != 0x3E9) {
            goto loc_1360;
        } else {
            a1->field_0 = 1;
        }
    }
    return;
}
uint32 multi_return(int64 a1)
{
    x1 = (uint32)a1;
    __asm("tbnz w0, #0x1f, #0x13a4");
    x0 = (uint32)((uint32)a1 * 2);
    /* cmp (int32)(x0), 0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x13ac");
    /* tst x1, 1 — 次の分岐のための比較 */
    loc_13A0:
    return x0;
    __asm("b #0x13a0");
    goto loc_13A0;
    __asm("b #0x13a0");
    goto loc_13A0;
}
uint32 conditional_return(int64 a1)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0x13c4");
    loc_13C0:
    return x0;
    __asm("b #0x13c0");
    goto loc_13C0;
}
uint32 duffs_device(void * a1, void * a2, int64 a3)
{
    x3 = a1;
    x0 = (uint32)a3;
    /* cmp (int32)(a3), 0 — 次の分岐のための比較 */
    __asm("b.le #0x14a8");
    x2 = (uint32)((uint32)(N_adds32(x0, 7) ? (uint32)((uint32)a3 + 14) : (uint32)(x0 + 7)) >> 3);
    x4 = (uint32)(0 < 0 x0 ? (uint32)(x0 & 7) : -(uint32)((uint32)-x0 & 7));
    /* cmp (int32)(x4), 4 — 次の分岐のための比較 */
    __asm("b.eq #0x149c");
    __asm("b.gt #0x1468");
    /* cmp (int32)(x4), 2 — 次の分岐のための比較 */
    __asm("b.eq #0x1424");
    __asm("b.le #0x1430");
    /* cmp (int32)(x4), 3 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    loc_141C:
    x4 = *(uint32 *)(a2);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(a2);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1440");
    /* tst x0, 7 — 次の分岐のための比較 */
    __asm("b.eq #0x145c");
    /* cmp (int32)(x4), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x2 = (uint32)((uint32)x2 - 1);
    /* cmp (int32)(x2), 0 — 次の分岐のための比較 */
    __asm("b.le #0x14ac");
    x1 = x1 + 4;
    x3 = x3 + 4;
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1478");
    /* cmp (int32)(x4), 6 — 次の分岐のための比較 */
    __asm("b.eq #0x1480");
    /* cmp (int32)(x4), 7 — 次の分岐のための比較 */
    __asm("b.ne #0x148c");
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1494");
    /* cmp (int32)(x4), 5 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x141c");
    goto loc_141C;
    return x0;
}
uint32 loop_complex_cond(int64 a1)
{
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0x14e8");
    x2 = 0;
    x1 = 0;
    x1 = (uint32)((uint32)x1 + 2);
    x0 = (uint32)((uint32)a1 - 1);
    x2 = (uint32)((uint32)x2 + 1);
    /* cmp (int32)(x1), (int32)(x0) — 次の分岐のための比較 */
    /* ccmp (int32)(x2), 9, 0, lt — 次の分岐のための比較 */
    /* ccmp (int32)(x0), 0, 4, le — 次の分岐のための比較 */
    __asm("b.gt #0x14c0");
    loc_14DC:
    return (uint32)((uint32)((uint32)x1 + (uint32)x0) + (uint32)x2);
    x2 = 0;
    x1 = 0;
    __asm("b #0x14dc");
    goto loc_14DC;
}
void loop_modify_var(void)
{
    if ((int32_t)a1 > 0) {
        while ((int32_t)a1 > (int32_t)(phi(((int32_t)x2 > 5 ? x1 + 3 : x2), 0)) + 1) {
        }
    } else {
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
    if ((int32_t)a1 <= 1) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        tail_recursion(/* arguments unknown */);
        return;
    }
}
void indirect_recursion_a(void)
{
    if ((int32_t)a2 <= 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        if (bit_extract(a1, 0, 1) == 0) {
            if ((int32_t)a2 > 1) {
                indirect_recursion_a(/* arguments unknown */);
            }
        } else {
            if ((int32_t)a2 <= 1) {
            } else {
                indirect_recursion_a(/* arguments unknown */);
            }
        }
        return;
    }
}
void call_func_ptr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a2);
    return;
}
uint32 call_func_ptr_array(int64 a1, uint64 a2)
{
    uint64 var_10, var_20, var_28;

    x3_1 = (uint32)a1;
    x0_1 = (uint32)a2;
    var_28 = *(uint64 *)(*(uint64 *)0x13FE8);
    x2_1 = 0x14010;
    x4 = *(uint64 *)0x14010;   x5 = *(uint64 *)0x14018;
    var_10 = x4;   var_18 = x5;
    var_20 = *(uint64 *)0x14020;
    /* cmp (int32)(x3_1), 2 — 次の分岐のための比較 */
    __asm("b.hi #0x1668");
    x0_2 = (**(uint64 *)(sp - 32 + (int32)x3_1 * 8))(x0_1, *(uint64 *)(sp - 32 + (int32)x3_1 * 8), x2_1, x3_1, x4, x5);
    loc_1644:
    x1 = *(uint64 *)0x13FE8;
    x3_2 = var_28 - *(uint64 *)(x1);
    x2_2 = 0;
    __asm("b.ne #0x1670");
    return x0;
    x0_3 = 0xFFFFFFFF;
    __asm("b #0x1644");
    goto loc_1644;
    x0_4 = sub_9A0();
}
void call_virtual_func(void)
{
    return;
}
uint32 process_with_callback(void * a1, int64 a2, int64 a3)
{
    // … ほかに 3 個の置き場（退避用など）があります

    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0x16d4");
    x19 = a1;
    x1 = (uint32)((uint32)a2 - 1);
    x21 = a1 + 4 + x1 * 4;
    x20 = 0;
    x0 = *(uint32 *)(x19);
    x20 = (uint32)((uint32)x20 + (uint32)(*a3)((uint32)*(uint32 *)(x19)));
    /* cmp x19, x21 — 次の分岐のための比較 */
    __asm("b.ne #0x16ac");
    loc_16C4:
    return (uint32)x20;
    x20 = 0;
    __asm("b #0x16c4");
    goto loc_16C4;
}
void test_control_flow_l2(void)
{
    uint64 load_515;
    uint64 load_48;
    uint64 load_344;
    uint64 load_20;
    uint64 load_383;
    uint64 load_361;
    loc_16DC:
        local_pFFFFFFFFFFFFFF60 = local_x29;
        local_pFFFFFFFFFFFFFF60 = local_x29;
        local_pFFFFFFFFFFFFFF70 = local_x19;
        local_pFFFFFFFFFFFFFF70 = local_x19;
        local_pFFFFFFFFFFFFFF80 = local_x21;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x20E8);
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
        load_515 = global_24E0;
        load_48 = global_24D0;
        local_pFFFFFFFFFFFFFFB8 = load_48;
        local_pFFFFFFFFFFFFFFB8 = load_48;
        local_pFFFFFFFFFFFFFFD8 = 0;
        local_pFFFFFFFFFFFFFFD8 = 0;
        local_pFFFFFFFFFFFFFFE8 = 0;
        local_pFFFFFFFFFFFFFFE8 = 0;
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
        tail_recursion(/* arguments unknown */);
        unknown_call(1);
        indirect_recursion_a(/* arguments unknown */);
        unknown_call(1);
        call_func_ptr(/* arguments unknown */);
        unknown_call(1);
        call_func_ptr_array(/* arguments unknown */);
        unknown_call(1);
        call_func_ptr_array(/* arguments unknown */);
        unknown_call(1);
        load_344 = global_24F0;
        local_pFFFFFFFFFFFFFFA0 = global_24F0;
        local_pFFFFFFFFFFFFFFA0 = global_24F0;
        local_pFFFFFFFFFFFFFFB0 = global_2500;
        process_with_callback(/* arguments unknown */);
        unknown_call(1);
        load_20 = global_13FE8;
        load_383 = var_98;
        load_361 = memory_unknown;
        if ((uint64_t)load_383 != (uint64_t)load_361) goto loc_1964;
        goto loc_1954;
    loc_1954:
        return;
    loc_1964:
        unknown_call(load_20);
}
uint32 non_local_jump(int64 a1)
{
    uint32 var_1C;

    var_1C = x0_2;
    x0_1 = sub_960(0x140C0);
    __asm("cbnz w0, #0x19c4");
    x0_2 = var_1C;
    __asm("tbnz w0, #0x1f, #0x19a4");
    x0_2 = var_1C;
    /* cmp (int32)(x0_2), 0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x19b4");
    loc_199C:
    return x0;
    x0_3 = sub_9E0(0x140C0, 1);
    x0_4 = sub_9E0(0x140C0, 2);
    __asm("b #0x199c");
    goto loc_199C;
}
uint32 cpp_exception(int64 a1)
{
    __asm("tbnz w0, #0x1f, #0x19e0");
    /* cmp (int32)(a1), 0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x19e8");
    loc_19DC:
    return x0;
    __asm("b #0x19dc");
    goto loc_19DC;
    __asm("b #0x19dc");
    goto loc_19DC;
}
uint32 large_jump_table(int64 a1, int64 a2, uint64 a3)
{
    uint64 var_68;

    x5 = (uint32)a1;
    x0_1 = (uint32)a2;
    x1_1 = (uint32)a3;
    var_68 = *(uint64 *)(*(uint64 *)0x13FE8);
    x3_1 = 0x14010 + 24;
    x4 = sp - 88;
    v0 = *(vector128 *)(x3_1);   v1 = *(vector128 *)(x3_1 + 0x10);
    *(vector128 *)(x4) = *(uint128 *)(x3_1);   *(vector128 *)(x4 + 0x10) = *(uint128 *)(0x14010 + 40);
    v0 = *(vector128 *)(x3_1 + 0x20);   v1 = *(vector128 *)(x3_1 + 0x30);
    *(vector128 *)(x4 + 0x20) = *(uint128 *)(0x14010 + 56);   *(vector128 *)(x4 + 0x30) = *(uint128 *)(0x14010 + 72);
    *(vector128 *)(x4 + 0x40) = *(uint128 *)(0x14010 + 88);
    /* cmp (int32)(x5), 9 — 次の分岐のための比較 */
    __asm("b.hi #0x1a74");
    x0_2 = (**(uint64 *)(x4 + (int32)x5 * 8))(x0_1, x1_1, *(uint64 *)(x4 + (int32)x5 * 8), x3_1, x4, x5);
    loc_1A50:
    x1_2 = *(uint64 *)0x13FE8;
    x3_2 = var_68 - *(uint64 *)(x1_2);
    x2 = 0;
    __asm("b.ne #0x1a7c");
    return x0;
    x0_3 = 0xFFFFFFFF;
    __asm("b #0x1a50");
    goto loc_1A50;
    x0_4 = sub_9A0();
}
uint32 conditional_func_ptr(int64 a1, int64 a2)
{
    // … ほかに 1 個の置き場（退避用など）があります

    x3 = (uint32)a1;
    x0_1 = (uint32)a2;
    __asm("cbz w3, #0x1ab8");
    x1 = 0xB14;
    /* cmp (int32)(x3), 1 — 次の分岐のための比較 */
    x2 = x3 == 1 ? 0xB54 : x1;
    loc_1AAC:
    x0_2 = (*x2)();
    return x0_2;
    x2 = 0xB4C;
    __asm("b #0x1aac");
    goto loc_1AAC;
}
uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp (int32)(a2), 2 — 次の分岐のための比較 */
    __asm("b.eq #0x1b20");
    __asm("b.gt #0x1afc");
    __asm("cbz w1, #0x1b14");
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x1af4");
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0x1b10");
    /* cmp (int32)(a1), 0x63 — 次の分岐のための比較 */
    __asm("b #0x1b10");
    __asm("b #0x1b10");
    /* cmp (int32)(x0), 0 — 次の分岐のための比較 */
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    loc_1B10:
    return x0;
    /* cmp (int32)(x0), 1 — 次の分岐のための比較 */
    __asm("b #0x1b10");
    goto loc_1B10;
    __asm("b #0x1b10");
    goto loc_1B10;
}
uint32 fsm_func_table(uint64 a1, uint64 a2)
{
    uint64 var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x13FE8);
    x2_1 = 0x14010 + 104;
    ? = *(uint64 *)(x2_1);
    *(uint64 *)(sp - 40) = ?;
    x0_1 = 3;
    /* cmp (int32)(a2), (int32)(x0_1) — 次の分岐のための比較 */
    __asm("b.hi #0x1b7c");
    x0_2 = (uint32)a1;
    x0_3 = (**(uint64 *)(sp - 40 + (int32)a2 * 8))(x0_2, *(uint64 *)(sp - 40 + (int32)a2 * 8), x2_1, x0_2);
    x1 = *(uint64 *)0x13FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2_2 = 0;
    __asm("b.ne #0x1ba0");
    return x0;
    x0_4 = sub_9A0();
}
uint32 computed_goto(int64 a2)
{
    uint64 var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x13FE8);
    ? = *(uint64 *)(0x14010 + 136);
    x0_1 = sp - 40;
    *(uint64 *)(x0_1) = ?;
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    __asm("b.hi #0x1c28");
    __asm("br x0");
    x0_2 = 0;
    x1 = *(uint64 *)0x13FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x1c30");
    return x0;
    x0_3 = 10;
    __asm("b #0x1bec");
    x0_4 = 20;
    __asm("b #0x1bec");
    x0_5 = 30;
    __asm("b #0x1bec");
    x0_6 = 0xFFFFFFFF;
    __asm("b #0x1bec");
    x0_7 = sub_9A0();
}
void obfuscated_cf(void)
{
    return;
}
void opaque_predicate(void)
{
    return;
}
void overlapped_code(void)
{
    return;
}
void test_control_flow_l3(void)
{
    uint64 load_337;
    uint64 load_231;
    uint64 load_47;
    loc_1C5C:
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x2308);
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
        local_pFFFFFFFFFFFFFFE8 = 0;
        local_pFFFFFFFFFFFFFFEC = 1;
        local_pFFFFFFFFFFFFFFF0 = 2;
        local_pFFFFFFFFFFFFFFF4 = 3;
        computed_goto(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        load_337 = global_13FE8;
        load_231 = var_38;
        load_47 = memory_unknown;
        if ((uint64_t)load_231 != (uint64_t)load_47) goto loc_1DFC;
        goto loc_1DF0;
    loc_1DF0:
        return;
    loc_1DFC:
        unknown_call(load_337);
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
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
