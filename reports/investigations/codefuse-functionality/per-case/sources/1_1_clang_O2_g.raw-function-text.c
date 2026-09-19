/* raw-function-text: address=2368 name=_start state=PASS completeness=complete */
void start(void)
{
    unknown_call(global_12FD8);
    unknown_call(global_12FD8);
}

/* raw-function-text: address=2420 name=$x state=PASS completeness=complete */
uint64 $x(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x984");
    return sub_8D0(x0_1);
    return x0;
}

/* raw-function-text: address=2448 name=$x state=PARTIAL completeness=partial */
uint64 $x(void)
    loc_9A0:
{
    /* cmp x1, x0 — 次の分岐のための比較 */
    __asm("b.eq #0x9bc");
    x1 = *(uint64 *)0x12FC0;
    __asm("cbz x1, #0x9bc");
    __asm("br x16");
    goto loc_9A0;
    return x0;
}

/* raw-function-text: address=2496 name=register_tm_clones state=PARTIAL completeness=partial */
uint64 register_tm_clones(void)
{
    __asm("cbz x1, #0x9f8");
    x2 = *(uint64 *)0x12FE0;
    __asm("cbz x2, #0x9f8");
    __asm("br x16");
    return x0;
}

/* raw-function-text: address=2560 name=__do_global_dtors_aux state=PARTIAL completeness=partial */
uint32 do_global_dtors_aux(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = 0x13000;
    __asm("cbnz w0, #0xa3c");
    x0_1 = *(uint64 *)0x12FC8;
    __asm("cbz x0, #0xa30");
    x0_2 = sub_8C0("H0");
    x0_3 = $x();
    *(uint8 *)(x19 + 0x50) = 1;
    return x0;
}

/* raw-function-text: address=2640 name=frame_dummy state=PARTIAL completeness=partial */
void frame_dummy(void)
    loc_A54:
{
    return register_tm_clones();
}
    goto loc_A54;

/* raw-function-text: address=2644 name=sequential_ops state=PASS completeness=complete */
void sequential_ops(void)
{
    return;
}

/* raw-function-text: address=2660 name=single_if state=PASS completeness=complete */
void single_if(void)
{
    return;
}

/* raw-function-text: address=2676 name=if_else state=PASS completeness=complete */
void if_else(void)
{
    return;
}

/* raw-function-text: address=2688 name=nested_if_2 state=PASS completeness=complete */
void nested_if_2(void)
{
    return;
}

/* raw-function-text: address=2708 name=nested_if_deep state=PASS completeness=complete */
void nested_if_deep(void)
{
    loc_A94:
        if ((int32_t)a1 < 1) goto loc_AC4;
        goto loc_A9C;
    loc_A9C:
        if ((int32_t)a2 < 1) goto loc_ACC;
        goto loc_AA4;
    loc_AA4:
        if ((int32_t)a3 < 1) goto loc_AD4;
        goto loc_AAC;
    loc_AAC:
        if ((int32_t)a4 < 1) goto loc_ADC;
        goto loc_AB4;
    loc_AB4:
        return;
    loc_AC4:
        return;
    loc_ACC:
        return;
    loc_AD4:
        return;
    loc_ADC:
        return;
}

/* raw-function-text: address=2788 name=if_elseif_chain state=PASS completeness=complete */
void if_elseif_chain(void)
{
    return;
}

/* raw-function-text: address=2812 name=if_elseif_long state=PASS completeness=complete */
void if_elseif_long(void)
{
    return;
}

/* raw-function-text: address=2836 name=switch_small state=PASS completeness=complete */
void switch_small(void)
{
    loc_B14:
        if ((uint32_t)a1 > 3) goto loc_B2C;
        goto loc_B1C;
    loc_B1C:
        return;
    loc_B2C:
        return;
}

/* raw-function-text: address=2868 name=switch_large state=PASS completeness=complete */
void switch_large(void)
{
    return;
}

/* raw-function-text: address=2888 name=switch_default state=PASS completeness=complete */
void switch_default(void)
{
    return;
}

/* raw-function-text: address=2916 name=switch_fallthrough state=PASS completeness=complete */
void switch_fallthrough(void)
{
    loc_B64:
        if ((uint32_t)a1 == 1) goto loc_B88;
        goto loc_B70;
    loc_B70:
        if ((uint32_t)a1 == 2) goto loc_B84;
        goto loc_B78;
    loc_B78:
        if ((uint32_t)a1 != 3) goto loc_B90;
        goto loc_B80;
    loc_B80:
    loc_B84:
    loc_B88:
        return;
    loc_B90:
        return;
}

/* raw-function-text: address=2968 name=loop_for_fixed state=PASS completeness=complete */
void loop_for_fixed(void)
{
    loc_B98:
        if ((int32_t)a1 < 1) goto loc_BB8;
        goto loc_BA0;
    loc_BA0:
        return;
    loc_BB8:
        return;
}

/* raw-function-text: address=3008 name=loop_while state=PASS completeness=complete */
void loop_while(void)
{
    loc_BC0:
        if (a1 == 0) goto loc_BFC;
        goto loc_BC4;
    loc_BC4:
    loc_BD4:
        if ((uint32_t)(phi((((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34) + (((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 63), a1)) + 9 > 18) goto loc_BD4;
        goto loc_BF8;
    loc_BF8:
        return;
    loc_BFC:
        return;
}

/* raw-function-text: address=3076 name=loop_dowhile state=PASS completeness=complete */
void loop_dowhile(void)
{
    while ((uint32_t)(phi((((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34) + (((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 63), a1)) + 9 > 18) {
    }
    return;
}

/* raw-function-text: address=3132 name=loop_nested state=PASS completeness=complete */
void loop_nested(void)
{
    return;
}

/* raw-function-text: address=3156 name=loop_break state=PASS completeness=complete */
uint32 loop_break(int64 a1)
{
    x8 = (uint32)((uint32)a1 - 10);
    /* cmp w8, #0x28 — 次の分岐のための比較 */
    __asm("b.hi #0xc84");
    __asm("br x10");
    return x0;
    return x0;
    return x0;
    return x0;
    return x0;
}

/* raw-function-text: address=3212 name=unknown state=PARTIAL completeness=partial */
void sub_C8C(void)
{
    return;
}

/* raw-function-text: address=3220 name=unknown state=PARTIAL completeness=partial */
void sub_C94(void)
{
    return;
}

/* raw-function-text: address=3228 name=unknown state=PARTIAL completeness=partial */
void sub_C9C(void)
{
    return;
}

/* raw-function-text: address=3236 name=loop_continue state=PASS completeness=complete */
void loop_continue(void)
{
    loc_CA4:
        if ((int32_t)a1 < 1) goto loc_CC0;
        goto loc_CAC;
    loc_CAC:
        if ((uint32_t)a1 >= 8) goto loc_CC8;
        goto loc_CB4;
    loc_CB4:
        goto loc_D2C;
    loc_CC0:
        return;
    loc_CC8:
    loc_CF0:
        if ((uint32_t)phi(a1 & 0xFFFFFFF8, v94) != 8) goto loc_CF0;
        goto loc_D18;
    loc_D18:
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_D48;
        goto loc_D2C;
    loc_D2C:
    loc_D30:
        if ((uint32_t)a1 + 1 != (uint32_t)(phi(phi((a1 & 0xFFFFFFF8) | 1, 1), x9)) + 1) goto loc_D30;
        goto loc_D48;
    loc_D48:
        return;
}

/* raw-function-text: address=3408 name=goto_forward state=PASS completeness=complete */
void goto_forward(void)
{
    return;
}

/* raw-function-text: address=3428 name=goto_backward state=PASS completeness=complete */
void goto_backward(void)
{
    loc_D64:
        if ((int32_t)a1 < 1) goto loc_D80;
        goto loc_D6C;
    loc_D6C:
        if ((uint32_t)a1 >= 8) goto loc_D88;
        goto loc_D74;
    loc_D74:
        goto loc_DE4;
    loc_D80:
        return;
    loc_D88:
    loc_DAC:
        if ((uint32_t)phi(v46, a1 & 0xFFFFFFF8) != 8) goto loc_DAC;
        goto loc_DC4;
    loc_DC4:
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_DF8;
        goto loc_DE4;
    loc_DE4:
    loc_DE8:
        if ((uint32_t)a1 + 1 != (uint32_t)(phi(x9, phi((a1 & 0xFFFFFFF8) | 1, 1))) + 1) goto loc_DE8;
        goto loc_DF8;
    loc_DF8:
        return;
}

/* raw-function-text: address=3584 name=ternary_op state=PASS completeness=complete */
void ternary_op(void)
{
    return;
}

/* raw-function-text: address=3596 name=test_control_flow_l1 state=PASS completeness=complete */
uint64 test_control_flow_l1(void)
    loc_E10:
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_8F0("=== 测试基础控制流特征 ===");
    x0_2 = sub_910("CF-L1-01 (sequential_ops): %d\\n", 21);
    x0_3 = "CF-L1-02 (single_if): %d\\n";
    x0_4 = sub_910(x0_3, 20);
    x0_5 = sub_910(x0_3, 0xFFFFFFFB);
    x0_6 = "CF-L1-03 (if_else): %d\\n";
    x0_7 = sub_910(x0_6, 1);
    x0_8 = sub_910(x0_6, 0);
    x0_9 = "CF-L1-04 (nested_if_2): %d\\n";
    x0_10 = sub_910(x0_9, 15);
    x0_11 = sub_910(x0_9, 10);
    x0_12 = sub_910(x0_9, 0);
    x0_13 = sub_910("CF-L1-05 (nested_if_deep): %d\\n", 5);
    x0_14 = sub_910("CF-L1-06 (if_elseif_chain): %d\\n", 20);
    x0_15 = sub_910("CF-L1-07 (if_elseif_long): %d\\n", 400);
    x0_16 = sub_910("CF-L1-08 (switch_small): %d\\n", 50);
    x0_17 = sub_910("CF-L1-09 (switch_large): %d\\n", 70);
    x0_18 = sub_910("CF-L1-10 (switch_default): %d\\n", 0);
    x0_19 = sub_910("CF-L1-11 (switch_fallthrough): %d\\n", 21);
    x0_20 = sub_910("CF-L1-12 (loop_for_fixed): %d\\n", 45);
    x0_21 = sub_910("CF-L1-13 (loop_while): %d\\n", 5);
    x0_22 = sub_910("CF-L1-14 (loop_dowhile): %d\\n", 4);
    x0_23 = sub_910("CF-L1-15 (loop_nested): %d\\n", 12);
    x0_24 = "CF-L1-16 (loop_break): %d\\n";
    x0_25 = sub_910(x0_24, 2);
    x0_26 = sub_910(x0_24, 0xFFFFFFFF);
    x0_27 = sub_910("CF-L1-17 (loop_continue): %d\\n", 25);
    x0_28 = "CF-L1-18 (goto_forward): %d\\n";
    x0_29 = sub_910(x0_28, 50);
    x0_30 = sub_910(x0_28, 0xFFFFFFFA);
    x0_31 = sub_910("CF-L1-19 (goto_backward): %d\\n", 120);
    x0_32 = "CF-L1-20 (ternary_op): %d\\n";
    x0_33 = sub_910(x0_32, 10);
    return sub_910(x0_32, 8);
}
    goto loc_E10;

/* raw-function-text: address=4056 name=loop_multi_exit state=PASS completeness=complete */
void loop_multi_exit(void)
{
    loc_FD8:
        if ((uint32_t)a1 - 1 > 11) goto loc_1008;
        goto loc_FE4;
    loc_FE4:
        return;
    loc_1008:
        return;
}

/* raw-function-text: address=4112 name=infinite_loop state=PASS completeness=complete */
void infinite_loop(void)
{
    if ((uint32_t)a1->field_0 != 1) {
        if ((uint32_t)(phi(0, x0)) + 1 != 0x3E9) {
            goto loc_1018;
        } else {
            a1->field_0 = 1;
        }
    }
    return;
}

/* raw-function-text: address=4156 name=multi_return state=PASS completeness=complete */
void multi_return(void)
{
    loc_103C:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_105C;
        goto loc_1040;
    loc_1040:
        return;
    loc_105C:
        return;
}

/* raw-function-text: address=4196 name=conditional_return state=PASS completeness=complete */
void conditional_return(void)
{
    return;
}

/* raw-function-text: address=4212 name=duffs_device state=PASS completeness=complete */
uint32 duffs_device(int64 a3)
{
    x8 = 0xFFFFFFFF;
    /* cmp w2, #1 — 次の分岐のための比較 */
    __asm("b.lt #0x10f0");
    __asm("br x11");
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 4);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 8);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 12);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 16);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 20);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 24);
    x9 = *(uint32 *)(x1);
    x8 = (uint32)((uint32)x8 - 1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2 + 28);
    __asm("b.gt #0x10a4");
    x8 = (uint32)a3;
    return x0;
}

/* raw-function-text: address=4344 name=loop_complex_cond state=PASS completeness=complete */
void loop_complex_cond(void)
{
    if ((int32_t)a1 < 1) {
    } else {
        if ((uint32_t)phi(a1, x0 - 1) >= 2) {
            if ((int32_t)(phi(0, x8)) + 2 < (int32_t)x0 - 1) {
                if ((uint32_t)phi(0, x10 + 1) < 9) {
                    goto loc_1108;
                } else {
                }
            }
        }
    }
    return;
}

/* raw-function-text: address=4428 name=loop_modify_var state=PASS completeness=complete */
void loop_modify_var(void)
{
    loc_114C:
        if ((int32_t)a1 < 1) goto loc_1180;
        goto loc_1154;
    loc_1154:
    loc_115C:
        if ((int32_t)(((int32_t)phi(0, x9) > 5 ? (phi(0, x9)) + 2 : phi(0, x9))) + 1 < (int32_t)a1) goto loc_115C;
        goto loc_1178;
    loc_1178:
        return;
    loc_1180:
        return;
}

/* raw-function-text: address=4492 name=loop_external_state state=PASS completeness=complete */
void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(0, x0)) + 1 != 0x65) goto loc_1194;
        goto loc_11A8;
    }
    return;
}

/* raw-function-text: address=4524 name=recursion_factorial state=PASS completeness=complete */
void recursion_factorial(void)
{
    loc_11AC:
        if ((int32_t)a1 >= 2) goto loc_11BC;
        goto loc_11B4;
    loc_11B4:
        return;
    loc_11BC:
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v253)) + 1 >= 8) goto loc_11D8;
        goto loc_11D0;
    loc_11D0:
        goto loc_123C;
    loc_11D8:
    loc_1204:
        if ((uint32_t)phi(((((uint32_t)a1 < 2 ? 0 : v253)) + 1) & 0xFFFFFFF8, v256) != 8) goto loc_1204;
        goto loc_121C;
    loc_121C:
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v253)) + 1 == (uint32_t)((((uint32_t)a1 < 2 ? 0 : v253)) + 1) & 0xFFFFFFF8) goto loc_1250;
        goto loc_123C;
    loc_123C:
        if ((uint32_t)phi(x8 - 1, a1 - (((((uint32_t)a1 < 2 ? 0 : v253)) + 1) & 0xFFFFFFF8), a1) > 2) goto loc_123C;
        goto loc_1250;
    loc_1250:
        return;
}

/* raw-function-text: address=4692 name=tail_recursion state=PASS completeness=complete */
void tail_recursion(void)
{
    if ((int32_t)a1 >= 2) {
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v17)) + 1 < 8) {
            while ((uint32_t)phi(a1, x0 - 1, a1 - (((((uint32_t)a1 < 2 ? 0 : v17)) + 1) & 0xFFFFFFF8)) > 2) {
            }
        } else {
            while ((uint32_t)phi(((((uint32_t)a1 < 2 ? 0 : v17)) + 1) & 0xFFFFFFF8, v178) != 8) {
            }
            if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v17)) + 1 != (uint32_t)((((uint32_t)a1 < 2 ? 0 : v17)) + 1) & 0xFFFFFFF8) {
                goto loc_12D4;
            }
        }
    }
    return;
}

/* raw-function-text: address=4848 name=indirect_recursion_a state=PASS completeness=complete */
uint32 indirect_recursion_a(int64 a1, int64 a2)
{
    /* cmp w1, #1 — 次の分岐のための比較 */
    __asm("b.lt #0x1344");
    x8 = (uint32)((uint32)a2 + 2);
    __asm("b #0x130c");
    loc_1300:
    x8 = (uint32)((uint32)x8 - 2);
    /* cmp w8, #3 — 次の分岐のための比較 */
    __asm("b.lt #0x1344");
    __asm("tbnz w0, #0, #0x132c");
    /* cmp w0, #0 — 次の分岐のための比較 */
    /* cmp w8, #3 — 次の分岐のための比較 */
    x0 = (uint32)((uint32)((uint32)a1 < 0 ? (uint32)a1 + 1 : (uint32)a1) >> 1);
    __asm("b.eq #0x1344");
    x0 = (uint32)(x0 + 1);
    __asm("b #0x1300");
    goto loc_1300;
    x9 = (uint32)((uint32)x0 * 3);
    /* cmp w8, #3 — 次の分岐のための比較 */
    __asm("b.eq #0x1340");
    x0 = (uint32)(x9 + 2);
    __asm("b #0x1300");
    goto loc_1300;
    return x0;
}

/* raw-function-text: address=4936 name=call_func_ptr state=PASS completeness=complete */
uint32 call_func_ptr(int64 a1, int64 a2)
    loc_134C:
{
    __asm("br x2");
}
    goto loc_134C;

/* raw-function-text: address=4948 name=call_func_ptr_array state=PASS completeness=complete */
uint32 call_func_ptr_array(int64 a1, int64 a2)
    loc_1360:
{
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.ls #0x1364");
    return x0;
    __asm("br x2");
}
    goto loc_1360;

/* raw-function-text: address=4984 name=double_value state=PASS completeness=complete */
void double_value(void)
{
    return;
}

/* raw-function-text: address=4992 name=triple_value state=PASS completeness=complete */
void triple_value(void)
{
    return;
}

/* raw-function-text: address=5000 name=call_virtual_func state=PASS completeness=complete */
void call_virtual_func(void)
{
    return;
}

/* raw-function-text: address=5008 name=process_with_callback state=PASS completeness=complete */
void process_with_callback(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    if ((int32_t)a2 < 1) {
    } else {
        unknown_call(phi(call_250, a1));
        while ((uint64_t)phi(v62 - 1, a2) != 1) {
        }
    }
    return;
}

/* raw-function-text: address=5096 name=test_control_flow_l2 state=PASS completeness=complete */
uint64 test_control_flow_l2(void)
    loc_1414:
{
    uint32 var_18, var_1C;

    x0_1 = sub_8F0("=== 测试高级控制流特征 ===");
    x0_2 = sub_910("CF-L2-01 (loop_multi_exit): %d\\n", 12);
    x1 = 0;
    var_1C = 0;
    /* cmp w8, #1 — 次の分岐のための比較 */
    __asm("b.eq #0x143c");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x3e9 — 次の分岐のための比較 */
    __asm("b.ne #0x141c");
    var_1C = 1;
    x0_3 = sub_910("CF-L2-02 (infinite_loop): %d\\n");
    x21 = 0xFFFFFFFF;
    x0_4 = "CF-L2-03 (multi_return): %d\\n";
    x0_5 = sub_910(x0_4, 0xFFFFFFFF);
    x0_6 = sub_910(x0_4, 0xFFFFFFFE);
    x0_7 = sub_910(x0_4, 4);
    x19 = 10;
    x0_8 = "CF-L2-04 (conditional_return): %d\\n";
    x0_9 = sub_910(x0_8, 10);
    x0_10 = sub_910(x0_8, 5);
    x0_11 = sub_910("CF-L2-05 (duffs_device): %d\\n", 8);
    x8 = 11;
    /* cmp w9, w10 — 次の分岐のための比較 */
    __asm("b.hs #0x14d4");
    x21 = (uint32)((uint32)x21 + 1);
    x8 = (uint32)((uint32)x8 - 1);
    /* cmp w21, #9 — 次の分岐のための比較 */
    __asm("b.lo #0x14b0");
    x1_1 = (uint32)((uint32)x19 + 2);
    x0_12 = sub_910("CF-L2-06 (loop_complex_cond): %d\\n", x1_1);
    x0_13 = sub_910("CF-L2-07 (loop_modify_var): %d\\n", 30);
    x1 = 0;
    var_18 = 0;
    __asm("cbnz w8, #0x1510");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x65 — 次の分岐のための比較 */
    __asm("b.ne #0x14fc");
    x0_14 = sub_910("CF-L2-08 (loop_external_state): %d\\n");
    x0_15 = sub_910("CF-L2-09 (recursion_factorial): %d\\n", 120);
    x0_16 = sub_910("CF-L2-10 (tail_recursion): %d\\n", 120);
    x0_17 = sub_910("CF-L2-11 (indirect_recursion): %d\\n", 3);
    x0_18 = sub_910("CF-L2-12 (call_func_ptr): %d\\n", 10);
    x0_19 = "CF-L2-13 (call_func_ptr_array): %d\\n";
    x0_20 = sub_910(x0_19, 10);
    x0_21 = sub_910(x0_19, 120);
    return sub_910("CF-L2-15 (process_with_callback): %d\\n", 30);
}
    goto loc_1414;

/* raw-function-text: address=5528 name=non_local_jump state=PASS completeness=complete */
void non_local_jump(void)
{
    loc_1598:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(0x13058);
        if (call_177 == 0) goto loc_15C0;
        goto loc_15B8;
    loc_15B8:
        goto loc_15D0;
    loc_15C0:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_15DC;
        goto loc_15C4;
    loc_15C4:
        if ((uint32_t)a1 >= 0x65) goto loc_15EC;
        goto loc_15CC;
    loc_15CC:
    loc_15D0:
        return;
    loc_15DC:
        unknown_call(0x13058);
    loc_15EC:
        unknown_call(0x13058);
}

/* raw-function-text: address=5628 name=cpp_exception state=PASS completeness=complete */
void cpp_exception(void)
{
    return;
}

/* raw-function-text: address=5656 name=large_jump_table state=PASS completeness=complete */
uint32 large_jump_table(int64 a1, int64 a2, int64 a3)
    loc_1624:
{
    /* cmp w0, #9 — 次の分岐のための比較 */
    __asm("b.ls #0x1628");
    return x0;
    __asm("br x3");
}
    goto loc_1624;

/* raw-function-text: address=5696 name=op_add state=PASS completeness=complete */
void op_add(void)
{
    return;
}

/* raw-function-text: address=5704 name=op_sub state=PASS completeness=complete */
void op_sub(void)
{
    return;
}

/* raw-function-text: address=5712 name=op_mul state=PASS completeness=complete */
void op_mul(void)
{
    return;
}

/* raw-function-text: address=5720 name=op_div state=PASS completeness=complete */
void op_div(void)
{
    loc_1658:
        if (a2 == 0) goto loc_1664;
        goto loc_165C;
    loc_165C:
        return;
    loc_1664:
        return;
}

/* raw-function-text: address=5740 name=op_mod state=PASS completeness=complete */
void op_mod(void)
{
    loc_166C:
        if (a2 == 0) goto loc_167C;
        goto loc_1670;
    loc_1670:
        return;
    loc_167C:
        return;
}

/* raw-function-text: address=5764 name=op_and state=PASS completeness=complete */
void op_and(void)
{
    return;
}

/* raw-function-text: address=5772 name=op_or state=PASS completeness=complete */
void op_or(void)
{
    return;
}

/* raw-function-text: address=5780 name=op_xor state=PASS completeness=complete */
void op_xor(void)
{
    return;
}

/* raw-function-text: address=5788 name=op_shl state=PASS completeness=complete */
void op_shl(void)
{
    return;
}

/* raw-function-text: address=5796 name=op_shr state=PASS completeness=complete */
void op_shr(void)
{
    return;
}

/* raw-function-text: address=5804 name=conditional_func_ptr state=PASS completeness=complete */
uint32 conditional_func_ptr(int64 a1, int64 a2)
    loc_16B0:
{
    /* cmp w0, #1 — 次の分岐のための比較 */
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("br x2");
}
    goto loc_16B0;

/* raw-function-text: address=5852 name=state_machine state=PASS completeness=complete */
uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.hi #0x170c");
    __asm("br x10");
    /* cmp w0, #1 — 次の分岐のための比較 */
    return x0;
    x0_1 = 3;
    return x0;
    /* cmp w0, #0x63 — 次の分岐のための比較 */
    /* cmp w0, #2 — 次の分岐のための比較 */
    x0_2 = 1;
    return x0;
    /* cmp w0, #0 — 次の分岐のための比較 */
    return x0;
}

/* raw-function-text: address=5952 name=fsm_func_table state=PASS completeness=complete */
uint32 fsm_func_table(uint64 a2)
    loc_174C:
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.ls #0x1750");
    return x0;
    __asm("br x1");
}
    goto loc_174C;

/* raw-function-text: address=5984 name=state_idle state=PASS completeness=complete */
void state_idle(void)
{
    return;
}

/* raw-function-text: address=5996 name=state_processing state=PASS completeness=complete */
void state_processing(void)
{
    return;
}

/* raw-function-text: address=6020 name=state_done state=PASS completeness=complete */
void state_done(void)
{
    return;
}

/* raw-function-text: address=6028 name=state_error state=PASS completeness=complete */
void state_error(void)
{
    return;
}

/* raw-function-text: address=6044 name=computed_goto state=PASS completeness=complete */
uint32 computed_goto(int64 a2)
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.ls #0x17ac");
    return x0;
    __asm("br x8");
    return x0;
    return x0;
    return x0;
    return x0;
}

/* raw-function-text: address=6084 name=unknown state=PARTIAL completeness=partial */
void sub_17C4(void)
{
    return;
}

/* raw-function-text: address=6092 name=unknown state=PARTIAL completeness=partial */
void sub_17CC(void)
{
    return;
}

/* raw-function-text: address=6100 name=unknown state=PARTIAL completeness=partial */
void sub_17D4(void)
{
    return;
}

/* raw-function-text: address=6108 name=obfuscated_cf state=PASS completeness=complete */
void obfuscated_cf(void)
{
    return;
}

/* raw-function-text: address=6116 name=opaque_predicate state=PASS completeness=complete */
void opaque_predicate(void)
{
    return;
}

/* raw-function-text: address=6124 name=overlapped_code state=PASS completeness=complete */
void overlapped_code(void)
{
    return;
}

/* raw-function-text: address=6152 name=test_control_flow_l3 state=PASS completeness=complete */
uint64 test_control_flow_l3(void)
    loc_180C:
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_8F0("=== 测试极端控制流特征 ===");
    x0_2 = non_local_jump(5);
    x0_3 = "CF-L3-01 (non_local_jump): %d\\n";
    x0_4 = sub_910(x0_3, (uint32)x0_2);
    x0_5 = non_local_jump(0xFFFFFFFB);
    x0_6 = sub_910(x0_3, (uint32)x0_5);
    x0_7 = "CF-L3-02 (cpp_exception): %d\\n";
    x0_8 = sub_910(x0_7, 10);
    x0_9 = sub_910(x0_7, 0xFFFFFFFF);
    x0_10 = sub_910("CF-L3-03 (large_jump_table): %d\\n", 15);
    x0_11 = sub_910("CF-L3-04 (conditional_func_ptr): %d\\n", 10);
    x0_12 = sub_910("CF-L3-05 (state_machine): %d\\n", 1);
    x0_13 = sub_910("CF-L3-06 (fsm_func_table): %d\\n", 2);
    x0_14 = computed_goto(x0_13, 2);
    x0_15 = sub_910("CF-L3-07 (computed_goto): %d\\n", (uint32)x0_14);
    x0_16 = sub_910("CF-L3-08 (obfuscated_cf): %d\\n", 10);
    x0_17 = sub_910("CF-L3-09 (opaque_predicate): %d\\n", 10);
    return sub_910("CF-L3-10 (overlapped_code): %d\\n", 16);
}
    goto loc_180C;

/* raw-function-text: address=6400 name=main state=PASS completeness=complete */
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_control_flow_l1(/* arguments unknown */);
    test_control_flow_l2(/* arguments unknown */);
    test_control_flow_l3(/* arguments unknown */);
    return;
}
