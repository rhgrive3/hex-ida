/* raw-function-text: address=2560 name=_start state=PASS completeness=complete */
void start(void)
{
    unknown_call(global_13FF0);
    unknown_call(global_13FF0);
}

/* raw-function-text: address=2612 name=$x state=PASS completeness=complete */
uint64 $x(void)
{
    x0_1 = *(uint64 *)0x13FE0;
    __asm("cbz x0, #0xa44");
    return sub_9B0(x0_1);
    return x0;
}

/* raw-function-text: address=2640 name=$x state=PARTIAL completeness=partial */
uint64 $x(void)
    loc_A60:
{
    /* cmp x1, x0 — 次の分岐のための比較 */
    __asm("b.eq #0xa7c");
    x1 = *(uint64 *)0x13FD0;
    __asm("cbz x1, #0xa7c");
    __asm("br x16");
    goto loc_A60;
    return x0;
}

/* raw-function-text: address=2688 name=register_tm_clones state=PARTIAL completeness=partial */
uint64 register_tm_clones(void)
{
    __asm("cbz x1, #0xab8");
    x2 = *(uint64 *)0x13FF8;
    __asm("cbz x2, #0xab8");
    __asm("br x16");
    return x0;
}

/* raw-function-text: address=2752 name=__do_global_dtors_aux state=PARTIAL completeness=partial */
uint32 do_global_dtors_aux(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = 0x14000;
    __asm("cbnz w0, #0xafc");
    x0_1 = *(uint64 *)0x13FD8;
    __asm("cbz x0, #0xaf0");
    x0_2 = sub_980(*(uint64 *)0x14008);
    x0_3 = $x();
    *(uint8 *)(x19 + 0xB8) = 1;
    return x0;
}

/* raw-function-text: address=2832 name=frame_dummy state=PARTIAL completeness=partial */
void frame_dummy(void)
    loc_B14:
{
    return register_tm_clones();
}
    goto loc_B14;

/* raw-function-text: address=2836 name=recursion_factorial state=PASS completeness=complete */
void recursion_factorial(void)
{
    loc_B14:
        if ((int32_t)a1 <= 1) goto loc_B44;
        goto loc_B1C;
    loc_B1C:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        recursion_factorial(/* arguments unknown */);
        return;
    loc_B44:
        return;
}

/* raw-function-text: address=2892 name=double_value state=PASS completeness=complete */
void double_value(void)
{
    return;
}

/* raw-function-text: address=2900 name=triple_value state=PASS completeness=complete */
void triple_value(void)
{
    return;
}

/* raw-function-text: address=2908 name=op_add state=PASS completeness=complete */
void op_add(void)
{
    return;
}

/* raw-function-text: address=2916 name=op_sub state=PASS completeness=complete */
void op_sub(void)
{
    return;
}

/* raw-function-text: address=2924 name=op_mul state=PASS completeness=complete */
void op_mul(void)
{
    return;
}

/* raw-function-text: address=2932 name=op_div state=PASS completeness=complete */
void op_div(void)
{
    if (!(a2 == 0)) {
    }
    return;
}

/* raw-function-text: address=2952 name=op_mod state=PASS completeness=complete */
void op_mod(void)
{
    if (!(a2 == 0)) {
    }
    return;
}

/* raw-function-text: address=2976 name=op_and state=PASS completeness=complete */
void op_and(void)
{
    return;
}

/* raw-function-text: address=2984 name=op_or state=PASS completeness=complete */
void op_or(void)
{
    return;
}

/* raw-function-text: address=2992 name=op_xor state=PASS completeness=complete */
void op_xor(void)
{
    return;
}

/* raw-function-text: address=3000 name=op_shl state=PASS completeness=complete */
void op_shl(void)
{
    return;
}

/* raw-function-text: address=3008 name=op_shr state=PASS completeness=complete */
void op_shr(void)
{
    return;
}

/* raw-function-text: address=3016 name=state_idle state=PASS completeness=complete */
void state_idle(void)
{
    return;
}

/* raw-function-text: address=3028 name=state_processing state=PASS completeness=complete */
void state_processing(void)
{
    if ((uint32_t)a1 != 2) {
    }
    return;
}

/* raw-function-text: address=3052 name=state_done state=PASS completeness=complete */
void state_done(void)
{
    return;
}

/* raw-function-text: address=3060 name=state_error state=PASS completeness=complete */
void state_error(void)
{
    return;
}

/* raw-function-text: address=3076 name=sequential_ops state=PASS completeness=complete */
void sequential_ops(void)
{
    return;
}

/* raw-function-text: address=3092 name=single_if state=PASS completeness=complete */
void single_if(void)
{
    return;
}

/* raw-function-text: address=3108 name=if_else state=PASS completeness=complete */
void if_else(void)
{
    return;
}

/* raw-function-text: address=3120 name=nested_if_2 state=PASS completeness=complete */
uint32 nested_if_2(int64 a1, int64 a2)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0xc48");
    /* cmp w1, #0 — 次の分岐のための比較 */
    loc_C44:
    return x0;
    __asm("b #0xc44");
}
    goto loc_C44;

/* raw-function-text: address=3152 name=nested_if_deep state=PASS completeness=complete */
uint32 nested_if_deep(int64 a1, int64 a2, int64 a3, int64 a4, int64 a5)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0xc84");
    /* cmp w1, #0 — 次の分岐のための比較 */
    __asm("b.le #0xc80");
    /* cmp w2, #0 — 次の分岐のための比較 */
    __asm("b.le #0xc8c");
    /* cmp w3, #0 — 次の分岐のための比較 */
    __asm("b.le #0xc94");
    /* cmp w4, #0 — 次の分岐のための比較 */
    loc_C80:
    return x0;
    __asm("b #0xc80");
    goto loc_C80;
    __asm("b #0xc80");
    goto loc_C80;
    __asm("b #0xc80");
}
    goto loc_C80;

/* raw-function-text: address=3228 name=if_elseif_chain state=PASS completeness=complete */
uint32 if_elseif_chain(int64 a1)
{
    __asm("cbz w0, #0xcb8");
    /* cmp w0, #1 — 次の分岐のための比較 */
    __asm("b.eq #0xcc0");
    /* cmp w0, #2 — 次の分岐のための比較 */
    loc_CB4:
    return x0;
    __asm("b #0xcb4");
    goto loc_CB4;
    __asm("b #0xcb4");
}
    goto loc_CB4;

/* raw-function-text: address=3272 name=if_elseif_long state=PASS completeness=complete */
uint32 if_elseif_long(int64 a1)
{
    __asm("cbz w0, #0xcf4");
    /* cmp w0, #1 — 次の分岐のための比較 */
    __asm("b.eq #0xcfc");
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.eq #0xd04");
    /* cmp w0, #3 — 次の分岐のための比較 */
    __asm("b.eq #0xd0c");
    /* cmp w0, #4 — 次の分岐のための比較 */
    loc_CF0:
    return x0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
    goto loc_CF0;
    __asm("b #0xcf0");
}
    goto loc_CF0;

/* raw-function-text: address=3348 name=switch_small state=PASS completeness=complete */
uint32 switch_small(int64 a1)
{
    x1 = (uint32)a1;
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.eq #0xd4c");
    __asm("b.gt #0xd3c");
    __asm("cbz w1, #0xd38");
    /* cmp w1, #1 — 次の分岐のための比較 */
    loc_D38:
    return x0;
    /* cmp w0, #3 — 次の分岐のための比較 */
    __asm("b #0xd38");
    goto loc_D38;
    __asm("b #0xd38");
}
    goto loc_D38;

/* raw-function-text: address=3412 name=switch_large state=PASS completeness=complete */
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

/* raw-function-text: address=3556 name=switch_default state=PASS completeness=complete */
void switch_default(void)
{
    if ((uint32_t)a1 != 2) {
        if ((uint32_t)a1 != 3) {
        }
    }
    return;
}

/* raw-function-text: address=3600 name=switch_fallthrough state=PASS completeness=complete */
uint32 switch_fallthrough(int64 a1)
{
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.eq #0xe30");
    /* cmp w0, #3 — 次の分岐のための比較 */
    __asm("b.eq #0xe38");
    /* cmp w0, #1 — 次の分岐のための比較 */
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
}
    goto loc_E40;

/* raw-function-text: address=3664 name=loop_for_fixed state=PASS completeness=complete */
uint32 loop_for_fixed(int64 a1)
{
    x2 = (uint32)a1;
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0xe78");
    x1 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)x1);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w2, w1 — 次の分岐のための比較 */
    __asm("b.ne #0xe64");
    loc_E74:
    return x0;
    __asm("b #0xe74");
}
    goto loc_E74;

/* raw-function-text: address=3712 name=loop_while state=PASS completeness=complete */
uint32 loop_while(int64 a1)
{
    __asm("cbz w0, #0xeb0");
    x2 = 0;
    x3 = 0x66666667;
    x2 = (uint32)((uint32)x2 + 1);
    x0 = (uint32)((uint32)((int32)(uint32)a1 * (int32)(uint32)x3 >> 34) - ((uint32)a1 >> 31));
    __asm("b.ne #0xe90");
    loc_EA4:
    /* cmp w2, #0 — 次の分岐のための比較 */
    return x0;
    x2 = (uint32)x0;
    __asm("b #0xea4");
}
    goto loc_EA4;

/* raw-function-text: address=3768 name=loop_dowhile state=PASS completeness=complete */
void loop_dowhile(void)
{
    while ((uint32_t)((sext(phi(a1, v56))) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34 != (uint32_t)(phi(a1, v56)) >> 31) {
    }
    return;
}

/* raw-function-text: address=3808 name=loop_nested state=PASS completeness=complete */
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

/* raw-function-text: address=3876 name=loop_break state=PASS completeness=complete */
void loop_break(void)
{
    loc_F24:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE0 = global_2488;
        local_pFFFFFFFFFFFFFFE0 = global_2488;
        local_pFFFFFFFFFFFFFFF0 = global_2498;
    loc_F64:
        if ((uint32_t)memory_unknown == (uint32_t)a1) goto loc_F84;
        goto loc_F70;
    loc_F70:
        if ((uint32_t)(phi(0, x0)) + 1 != 5) goto loc_F64;
        goto loc_F80;
    loc_F80:
    loc_F84:
        if ((uint64_t)var_28 != (uint64_t)memory_unknown) goto loc_FA8;
        goto loc_FA0;
    loc_FA0:
        return;
    loc_FA8:
        unknown_call(phi(0xFFFFFFFF, phi(0, x0)));
}

/* raw-function-text: address=4012 name=loop_continue state=PASS completeness=complete */
uint32 loop_continue(int64 a1)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0xfdc");
    x3 = (uint32)((uint32)a1 + 1);
    x1 = 1;
    x0 = 0;
    /* tst x1, #1 — 次の分岐のための比較 */
    x0 = (uint32)(!Z_tst64(x1, 1) ? (uint32)((uint32)x0 + (uint32)x1) : (uint32)x0);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, w3 — 次の分岐のための比較 */
    __asm("b.ne #0xfc0");
    loc_FD8:
    return x0;
    __asm("b #0xfd8");
}
    goto loc_FD8;

/* raw-function-text: address=4068 name=goto_forward state=PASS completeness=complete */
void goto_forward(void)
{
    return;
}

/* raw-function-text: address=4088 name=goto_backward state=PASS completeness=complete */
uint32 goto_backward(int64 a1)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0x1020");
    x2 = (uint32)((uint32)a1 + 1);
    x1 = 1;
    x0 = 1;
    x0 = (uint32)((uint32)x0 * (uint32)x1);
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, w2 — 次の分岐のための比較 */
    __asm("b.ne #0x100c");
    loc_101C:
    return x0;
    __asm("b #0x101c");
}
    goto loc_101C;

/* raw-function-text: address=4136 name=ternary_op state=PASS completeness=complete */
void ternary_op(void)
{
    return;
}

/* raw-function-text: address=4148 name=test_control_flow_l1 state=PASS completeness=complete */
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
    goto_backward(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    return;
}

/* raw-function-text: address=4788 name=loop_multi_exit state=PASS completeness=complete */
uint32 loop_multi_exit(int64 a1)
{
    uint64 var_48;

    var_48 = *(uint64 *)(*(uint64 *)0x13FE8);
    x1 = "\\n" + 24;
    x2 = sp - 56;
    v0 = *(double *)(x1);   v1 = *(double *)(x1 + 16);
    *(double *)(x2) = *(uint128 *)(x1);   *(double *)(x2 + 16) = *(uint128 *)(x1);
    *(vector128 *)(x2 + 0x20) = *(uint128 *)("\\n" + 56);
    x4 = 0;
    x1 = 0;
    /* cmp w3, w0 — 次の分岐のための比較 */
    __asm("b.eq #0x1348");
    x1 = x1 + 1;
    /* cmp x1, #4 — 次の分岐のための比較 */
    __asm("b.ne #0x12f8");
    x4 = (uint32)((uint32)x4 + 1);
    x2 = x2 + 16;
    /* cmp w4, #3 — 次の分岐のための比較 */
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

/* raw-function-text: address=4952 name=infinite_loop state=PASS completeness=complete */
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

/* raw-function-text: address=4996 name=multi_return state=PASS completeness=complete */
uint32 multi_return(int64 a1)
{
    x1 = (uint32)a1;
    __asm("tbnz w0, #0x1f, #0x13a4");
    x0 = (uint32)((uint32)a1 * 2);
    /* cmp w0, #0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x13ac");
    /* tst x1, #1 — 次の分岐のための比較 */
    loc_13A0:
    return x0;
    __asm("b #0x13a0");
    goto loc_13A0;
    __asm("b #0x13a0");
}
    goto loc_13A0;

/* raw-function-text: address=5044 name=conditional_return state=PASS completeness=complete */
uint32 conditional_return(int64 a1)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0x13c4");
    loc_13C0:
    return x0;
    __asm("b #0x13c0");
}
    goto loc_13C0;

/* raw-function-text: address=5068 name=duffs_device state=PASS completeness=complete */
uint32 duffs_device(void * a1, void * a2, int64 a3)
{
    x3 = a1;
    x0 = (uint32)a3;
    /* cmp w2, #0 — 次の分岐のための比較 */
    __asm("b.le #0x14a8");
    x2 = (uint32)((uint32)(N_adds32(x0, 7) ? (uint32)((uint32)a3 + 14) : (uint32)(x0 + 7)) >> 3);
    x4 = (uint32)(0 < 0 x0 ? (uint32)(x0 & 7) : -(uint32)((uint32)-x0 & 7));
    /* cmp w4, #4 — 次の分岐のための比較 */
    __asm("b.eq #0x149c");
    __asm("b.gt #0x1468");
    /* cmp w4, #2 — 次の分岐のための比較 */
    __asm("b.eq #0x1424");
    __asm("b.le #0x1430");
    /* cmp w4, #3 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    loc_141C:
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(a2);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1440");
    /* tst x0, #7 — 次の分岐のための比較 */
    __asm("b.eq #0x145c");
    /* cmp w4, #1 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x2 = (uint32)((uint32)x2 - 1);
    /* cmp w2, #0 — 次の分岐のための比較 */
    __asm("b.le #0x14ac");
    x1 = x1 + 4;
    x3 = x3 + 4;
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1478");
    /* cmp w4, #6 — 次の分岐のための比較 */
    __asm("b.eq #0x1480");
    /* cmp w4, #7 — 次の分岐のための比較 */
    __asm("b.ne #0x148c");
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x1494");
    /* cmp w4, #5 — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    x4 = *(uint32 *)(x1);
    *(uint32 *)(x3) = (uint32)*(uint32 *)(x1);
    __asm("b #0x141c");
    goto loc_141C;
    return x0;
}

/* raw-function-text: address=5296 name=loop_complex_cond state=PASS completeness=complete */
uint32 loop_complex_cond(int64 a1)
{
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("b.le #0x14e8");
    x2 = 0;
    x1 = 0;
    x1 = (uint32)((uint32)x1 + 2);
    x0 = (uint32)((uint32)a1 - 1);
    x2 = (uint32)((uint32)x2 + 1);
    /* cmp w1, w0 — 次の分岐のための比較 */
    /* ccmp w2, #9, #0, lt — 次の分岐のための比較 */
    /* ccmp w0, #0, #4, le — 次の分岐のための比較 */
    __asm("b.gt #0x14c0");
    loc_14DC:
    return x0;
    x2 = 0;
    x1 = 0;
    __asm("b #0x14dc");
}
    goto loc_14DC;

/* raw-function-text: address=5364 name=loop_modify_var state=PASS completeness=complete */
void loop_modify_var(void)
{
    if ((int32_t)a1 > 0) {
        while ((int32_t)a1 > (int32_t)(phi(((int32_t)x2 > 5 ? x1 + 3 : x2), 0)) + 1) {
        }
    } else {
    }
    return;
}

/* raw-function-text: address=5420 name=loop_external_state state=PASS completeness=complete */
void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(x0, 0)) + 1 != 0x65) goto loc_1534;
        goto loc_1548;
    }
    return;
}

/* raw-function-text: address=5452 name=tail_recursion state=PASS completeness=complete */
void tail_recursion(void)
{
    loc_154C:
        if ((int32_t)a1 <= 1) goto loc_1570;
        goto loc_1554;
    loc_1554:
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        tail_recursion(/* arguments unknown */);
        return;
    loc_1570:
        return;
}

/* raw-function-text: address=5496 name=indirect_recursion_a state=PASS completeness=complete */
void indirect_recursion_a(void)
{
    loc_1578:
        if ((int32_t)a2 <= 0) goto loc_15D4;
        goto loc_1580;
    loc_1580:
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        if (bit_extract(a1, 0, 1) == 0) goto loc_15AC;
        goto loc_158C;
    loc_158C:
        if ((int32_t)a2 <= 1) goto loc_15CC;
        goto loc_1598;
    loc_1598:
        indirect_recursion_a(/* arguments unknown */);
    loc_15A4:
        return;
    loc_15AC:
        if ((int32_t)a2 <= 1) goto loc_15A4;
        goto loc_15BC;
    loc_15BC:
        indirect_recursion_a(/* arguments unknown */);
        goto loc_15A4;
    loc_15CC:
        goto loc_15A4;
    loc_15D4:
        return;
}

/* raw-function-text: address=5592 name=call_func_ptr state=PASS completeness=complete */
void call_func_ptr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a2);
    return;
}

/* raw-function-text: address=5620 name=call_func_ptr_array state=PASS completeness=complete */
uint32 call_func_ptr_array(int64 a1, uint64 a2)
{
    uint64 var_10, var_20, var_28;

    x3_1 = (uint32)a1;
    x0_1 = (uint32)a2;
    var_28 = *(uint64 *)(*(uint64 *)0x13FE8);
    x2_1 = 0x14010;
    x4 = *(uint64 *)0x14010;   x5 = *(uint64 *)0x14010;
    var_10 = x4;   var_10_2 = x5;
    var_20 = *(uint64 *)0x14020;
    /* cmp w3, #2 — 次の分岐のための比較 */
    __asm("b.hi #0x1668");
    x0_2 = (*x1)(x0_1, *(uint64 *)(sp - 32 + (int32)x3_1 * 8), x2_1, x3_1, x4, x5);
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

/* raw-function-text: address=5748 name=call_virtual_func state=PASS completeness=complete */
void call_virtual_func(void)
{
    return;
}

/* raw-function-text: address=5756 name=process_with_callback state=PASS completeness=complete */
uint32 process_with_callback(void * a1, int64 a2, int64 a3)
{
    // … ほかに 3 個の置き場（退避用など）があります

    /* cmp w1, #0 — 次の分岐のための比較 */
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
    return x0;
    x20 = 0;
    __asm("b #0x16c4");
}
    goto loc_16C4;

/* raw-function-text: address=5852 name=test_control_flow_l2 state=PASS completeness=complete */
void test_control_flow_l2(void)
{
    loc_16DC:
        local_pFFFFFFFFFFFFFF60 = local_x29;
        local_pFFFFFFFFFFFFFF60 = local_x29;
        local_pFFFFFFFFFFFFFF70 = local_x19;
        local_pFFFFFFFFFFFFFF70 = local_x19;
        local_pFFFFFFFFFFFFFF80 = local_x21;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
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
        local_pFFFFFFFFFFFFFFB8 = global_24D0;
        local_pFFFFFFFFFFFFFFB8 = global_24D0;
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
        local_pFFFFFFFFFFFFFFA0 = global_24F0;
        local_pFFFFFFFFFFFFFFA0 = global_24F0;
        local_pFFFFFFFFFFFFFFB0 = global_2500;
        process_with_callback(/* arguments unknown */);
        unknown_call(1);
        if ((uint64_t)var_98 != (uint64_t)memory_unknown) goto loc_1964;
        goto loc_1954;
    loc_1954:
        return;
    loc_1964:
        unknown_call(global_13FE8);
}

/* raw-function-text: address=6504 name=non_local_jump state=PASS completeness=complete */
uint32 non_local_jump(int64 a1)
{
    uint32 var_1C;

    var_1C = x0_2;
    x0_1 = sub_960(0x140C0);
    __asm("cbnz w0, #0x19c4");
    x0_2 = var_1C;
    __asm("tbnz w0, #0x1f, #0x19a4");
    x0_2 = var_1C;
    /* cmp w1, #0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x19b4");
    loc_199C:
    return x0;
    x0_3 = sub_9E0(0x140C0, 1);
    x0_4 = sub_9E0(0x140C0, 2);
    __asm("b #0x199c");
}
    goto loc_199C;

/* raw-function-text: address=6604 name=cpp_exception state=PASS completeness=complete */
uint32 cpp_exception(int64 a1)
{
    __asm("tbnz w0, #0x1f, #0x19e0");
    /* cmp w0, #0x64 — 次の分岐のための比較 */
    __asm("b.gt #0x19e8");
    loc_19DC:
    return x0;
    __asm("b #0x19dc");
    goto loc_19DC;
    __asm("b #0x19dc");
}
    goto loc_19DC;

/* raw-function-text: address=6640 name=large_jump_table state=PASS completeness=complete */
uint32 large_jump_table(int64 a1, int64 a2, uint64 a3)
{
    uint64 var_68;

    x5 = (uint32)a1;
    x0_1 = (uint32)a2;
    x1_1 = (uint32)a3;
    var_68 = *(uint64 *)(*(uint64 *)0x13FE8);
    x3_1 = 0x14010 + 24;
    x4 = sp - 88;
    v0 = *(double *)(x3);   v1 = *(double *)(x3 + 16);
    *(double *)(x4) = *(uint128 *)(x3_1);   *(double *)(x4 + 16) = *(uint128 *)(x3_1);
    v0 = *(double *)(x3 + 0x20);   v1 = *(double *)(x3 + 0x20 + 16);
    *(double *)(x4 + 0x20) = *(uint128 *)(0x14010 + 56);   *(double *)(x4 + 0x20 + 16) = *(uint128 *)(0x14010 + 72);
    *(vector128 *)(x4 + 0x40) = *(uint128 *)(0x14010 + 88);
    /* cmp w5, #9 — 次の分岐のための比較 */
    __asm("b.hi #0x1a74");
    x0_2 = (*x2)(x0_1, x1_1, *(uint64 *)(x4 + (int32)x5 * 8), x3_1, x4, x5);
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

/* raw-function-text: address=6784 name=conditional_func_ptr state=PASS completeness=complete */
uint32 conditional_func_ptr(int64 a1, int64 a2)
{
    // … ほかに 1 個の置き場（退避用など）があります

    x3 = (uint32)a1;
    x0_1 = (uint32)a2;
    __asm("cbz w3, #0x1ab8");
    x1 = 0xB14;
    /* cmp w3, #1 — 次の分岐のための比較 */
    x2 = x3 == 1 ? 0xB54 : x1;
    loc_1AAC:
    x0_2 = (*x2)();
    return x0;
    x2 = 0xB4C;
    __asm("b #0x1aac");
}
    goto loc_1AAC;

/* raw-function-text: address=6852 name=state_machine state=PASS completeness=complete */
uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp w1, #2 — 次の分岐のための比較 */
    __asm("b.eq #0x1b20");
    __asm("b.gt #0x1afc");
    __asm("cbz w1, #0x1b14");
    /* cmp w1, #1 — 次の分岐のための比較 */
    __asm("b.ne #0x1af4");
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.eq #0x1b10");
    /* cmp w0, #0x63 — 次の分岐のための比較 */
    __asm("b #0x1b10");
    __asm("b #0x1b10");
    /* cmp w0, #0 — 次の分岐のための比較 */
    /* cmp w1, #3 — 次の分岐のための比較 */
    loc_1B10:
    return x0;
    /* cmp w0, #1 — 次の分岐のための比較 */
    __asm("b #0x1b10");
    goto loc_1B10;
    __asm("b #0x1b10");
}
    goto loc_1B10;

/* raw-function-text: address=6952 name=fsm_func_table state=PASS completeness=complete */
uint32 fsm_func_table(uint64 a1, uint64 a2)
{
    uint64 var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x13FE8);
    x2_1 = 0x14010 + 104;
    ? = *(uint64 *)(x2);
    *(uint64 *)(x0) = ?;
    x0_1 = 3;
    /* cmp w1, w0 — 次の分岐のための比較 */
    __asm("b.hi #0x1b7c");
    x0_2 = (uint32)a1;
    x0_3 = (*x1)(x0_2, *(uint64 *)(sp - 40 + (int32)a2 * 8), x2_1, x0_2);
    x1 = *(uint64 *)0x13FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2_2 = 0;
    __asm("b.ne #0x1ba0");
    return x0;
    x0_4 = sub_9A0();
}

/* raw-function-text: address=7076 name=computed_goto state=PASS completeness=complete */
uint32 computed_goto(int64 a2)
{
    uint64 var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x13FE8);
    ? = *(uint64 *)(x0);
    x0_1 = sp - 40;
    *(uint64 *)(x0) = ?;
    /* cmp w1, #3 — 次の分岐のための比較 */
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

/* raw-function-text: address=7184 name=unknown state=PARTIAL completeness=partial */
uint32 sub_1C10(void)
{
    return sub_1BEC(10);
    return sub_1BEC(20);
    return sub_1BEC(30);
    return sub_1BEC(0xFFFFFFFF);
    x0_5 = sub_9A0(x0_4);
}

/* raw-function-text: address=7220 name=obfuscated_cf state=PASS completeness=complete */
void obfuscated_cf(void)
{
    return;
}

/* raw-function-text: address=7228 name=opaque_predicate state=PASS completeness=complete */
void opaque_predicate(void)
{
    return;
}

/* raw-function-text: address=7236 name=overlapped_code state=PASS completeness=complete */
void overlapped_code(void)
{
    return;
}

/* raw-function-text: address=7260 name=test_control_flow_l3 state=PASS completeness=complete */
void test_control_flow_l3(void)
{
    loc_1C5C:
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
        local_pFFFFFFFFFFFFFFE8 = 0;
        local_pFFFFFFFFFFFFFFEC = 1;
        local_pFFFFFFFFFFFFFFF0 = 2;
        local_pFFFFFFFFFFFFFFF4 = 3;
        computed_goto(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        if ((uint64_t)var_38 != (uint64_t)memory_unknown) goto loc_1DFC;
        goto loc_1DF0;
    loc_1DF0:
        return;
    loc_1DFC:
        unknown_call(global_13FE8);
}

/* raw-function-text: address=7680 name=main state=PASS completeness=complete */
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_control_flow_l1(/* arguments unknown */);
    test_control_flow_l2(/* arguments unknown */);
    test_control_flow_l3(/* arguments unknown */);
    return;
}
