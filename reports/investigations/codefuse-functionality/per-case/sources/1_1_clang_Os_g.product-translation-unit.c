#include <stdint.h>

typedef int64_t int64;
typedef uint32_t uint32;
typedef uint64_t uint64;
typedef uint8_t uint8;

/* hex-tu: pseudo-intrinsic __arm64_condition_unknown: semantic-lowering-required; no declaration fabricated. */
/* hex-tu: pseudo-intrinsic bit_insert: semantic-lowering-required; no declaration fabricated. */
/* hex-tu: pseudo-intrinsic phi: semantic-lowering-required; no declaration fabricated. */
/* hex-tu: pseudo-intrinsic sext: semantic-lowering-required; no declaration fabricated. */
/* hex-tu: unresolved-call-sentinel unknown_call: callee-resolution-required; no declaration fabricated. */
/* hex-tu: unresolved-global global_12FD8: global-type-evidence-unavailable; no declaration fabricated. */

void start(void)
{
    unknown_call(global_12FD8);
    unknown_call(global_12FD8);
}

uint64 $x(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x984");
    return sub_8D0(x0_1);
    return x0;
}

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

uint64 register_tm_clones(void)
{
    __asm("cbz x1, #0x9f8");
    x2 = *(uint64 *)0x12FE0;
    __asm("cbz x2, #0x9f8");
    __asm("br x16");
    return x0;
}

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

void frame_dummy(void)
    loc_A54:
{
    return register_tm_clones();
}
    goto loc_A54;

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

void nested_if_2(void)
{
    return;
}

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

void if_elseif_chain(void)
{
    return;
}

void if_elseif_long(void)
{
    return;
}

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

void switch_large(void)
{
    return;
}

void switch_default(void)
{
    return;
}

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

void loop_dowhile(void)
{
    while ((uint32_t)(phi((((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34) + (((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 63), a1)) + 9 > 18) {
    }
    return;
}

void loop_nested(void)
{
    return;
}

void loop_break(void)
{
    if ((uint32_t)0x196C[phi(x0 + 1, 0)] != (uint32_t)a1) {
        if ((uint64_t)x0 + 1 != 5) {
            goto loc_C64;
        } else {
        }
    }
    return;
}

void loop_continue(void)
{
    loc_C84:
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        if ((int32_t)a1 < 1) goto loc_CFC;
        goto loc_C8C;
    loc_C8C:
    loc_CB0:
        if ((uint32_t)(a1 + 3) & 0xFFFFFFFC != (uint32_t)(phi(x8, 0)) + 4) goto loc_CB0;
        goto loc_CD4;
    loc_CD4:
        __asm("bit v0.16b, v5.16b, v1.16b");
        __asm("bit v0.16b, v5.16b, v1.16b");
        __asm("bit v0.16b, v5.16b, v1.16b");
        __asm("bit v0.16b, v5.16b, v1.16b");
        return;
    loc_CFC:
        return;
}

void goto_forward(void)
{
    return;
}

void goto_backward(void)
{
    loc_D18:
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        if ((int32_t)a1 < 1) goto loc_D8C;
        goto loc_D20;
    loc_D20:
    loc_D40:
        if ((uint32_t)(a1 + 3) & 0xFFFFFFFC != (uint32_t)(phi(x8, 0)) + 4) goto loc_D40;
        goto loc_D58;
    loc_D58:
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        return;
    loc_D8C:
        return;
}

void ternary_op(void)
{
    return;
}

uint64 test_control_flow_l1(void)
    loc_DA4:
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
    goto loc_DA4;

void loop_multi_exit(void)
{
    loc_F6C:
    loc_F7C:
    loc_F80:
        if ((uint32_t)(phi(x10 + 16, 0x1980))[phi(x11 + 1, 0)] == (uint32_t)a1) goto loc_FB4;
        goto loc_F8C;
    loc_F8C:
        if ((uint64_t)x11 + 1 != 4) goto loc_F80;
        goto loc_F98;
    loc_F98:
        if ((uint64_t)(phi(x9, 0)) + 1 != 3) goto loc_F7C;
        goto loc_FAC;
    loc_FAC:
        return;
    loc_FB4:
        return;
}

void infinite_loop(void)
{
    if ((uint32_t)a1->field_0 != 1) {
        if ((uint32_t)(phi(0, x0)) + 1 != 0x3E9) {
            goto loc_FC4;
        } else {
            a1->field_0 = 1;
        }
    }
    return;
}

void multi_return(void)
{
    loc_FE8:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1008;
        goto loc_FEC;
    loc_FEC:
        return;
    loc_1008:
        return;
}

void conditional_return(void)
{
    return;
}

uint32 duffs_device(int64 a3)
{
    x8 = 0xFFFFFFFF;
    /* cmp w2, #1 — 次の分岐のための比較 */
    __asm("b.lt #0x109c");
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
    __asm("b.gt #0x1050");
    x8 = (uint32)a3;
    return x0;
}

void loop_complex_cond(void)
{
    if ((int32_t)a1 < 1) {
    } else {
        if ((uint32_t)phi(x0 - 1, a1) >= 2) {
            if ((int32_t)(phi(x8, 0)) + 2 < (int32_t)x0 - 1) {
                if ((uint32_t)phi(x10 + 1, 0) < 9) {
                    goto loc_10B4;
                } else {
                }
            }
        }
    }
    return;
}

void loop_modify_var(void)
{
    if ((int32_t)a1 < 1) {
    } else {
        while ((int32_t)(((int32_t)phi(x9, 0) > 5 ? (phi(x9, 0)) + 2 : phi(x9, 0))) + 1 < (int32_t)a1) {
        }
    }
    return;
}

void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(x0, 0)) + 1 != 0x65) goto loc_113C;
        goto loc_1150;
    }
    return;
}

void recursion_factorial(void)
{
    loc_1154:
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
        if ((int32_t)a1 >= 2) goto loc_1164;
        goto loc_115C;
    loc_115C:
        return;
    loc_1164:
    loc_1190:
        if ((uint32_t)((((uint32_t)a1 < 2 ? 0 : v8)) + 4) & 0xFFFFFFFC != (uint32_t)(phi(x8, 0)) + 4) goto loc_1190;
        goto loc_11A8;
    loc_11A8:
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        return;
}

void tail_recursion(void)
{
    __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
    __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:bit");
    if ((int32_t)a1 >= 2) {
        while ((uint32_t)((((uint32_t)a1 < 2 ? 0 : v90)) + 4) & 0xFFFFFFFC != (uint32_t)(phi(x8, 0)) + 4) {
        }
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
        __asm("bit v0.16b, v2.16b, v1.16b");
    }
    return;
}

void indirect_recursion_a(void)
{
    loc_1264:
        if ((int32_t)a2 < 1) goto loc_12AC;
        goto loc_126C;
    loc_126C:
    loc_1270:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1290;
        goto loc_1274;
    loc_1274:
        if ((uint32_t)phi(a2 + 2, x8 - 2) == 3) goto loc_12AC;
        goto loc_1288;
    loc_1288:
        goto loc_12A0;
    loc_1290:
        if ((uint32_t)phi(a2 + 2, x8 - 2) == 3) goto loc_12B0;
        goto loc_129C;
    loc_129C:
    loc_12A0:
        if ((int32_t)x8 - 2 >= 3) goto loc_1270;
        goto loc_12AC;
    loc_12AC:
        return;
    loc_12B0:
        return;
}

uint32 call_func_ptr(int64 a1, int64 a2)
    loc_12BC:
{
    __asm("br x2");
}
    goto loc_12BC;

uint32 call_func_ptr_array(int64 a1, int64 a2)
    loc_12D0:
{
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.ls #0x12d4");
    return x0;
    __asm("br x2");
}
    goto loc_12D0;

void double_value(void)
{
    return;
}

void triple_value(void)
{
    return;
}

void call_virtual_func(void)
{
    return;
}

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
        unknown_call(phi(a1, call_146));
        while ((uint64_t)phi(a2, v104 - 1) != 1) {
        }
    }
    return;
}

uint64 test_control_flow_l2(void)
    loc_13A0:
{
    uint32 var_58, var_5C;
    vector128 var_20;

    x0_1 = sub_8F0("=== 测试高级控制流特征 ===");
    x10 = 0x1980;
    x11 = 0;
    /* cmp w12, #7 — 次の分岐のための比較 */
    __asm("b.eq #0x13c0");
    x11 = x11 + 1;
    /* cmp x11, #4 — 次の分岐のための比較 */
    __asm("b.ne #0x138c");
    x9 = x9 + 1;
    x8 = x8 - 10;
    x10 = x10 + 16;
    /* cmp x9, #3 — 次の分岐のための比較 */
    __asm("b.ne #0x1388");
    x1 = 0xFFFFFFFF;
    __asm("b #0x13c4");
    x1 = (uint32)((uint32)x11 - (uint32)x8);
    x0_2 = sub_910("CF-L2-01 (loop_multi_exit): %d\\n");
    x1 = 0;
    var_5C = x11;
    /* cmp w8, #1 — 次の分岐のための比較 */
    __asm("b.eq #0x13f8");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x3e9 — 次の分岐のための比較 */
    __asm("b.ne #0x13d8");
    var_5C = 1;
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
    v0 = *(double *)0x1F74;   v1 = *(double *)0x1F74;
    var_20 = *(uint128 *)(0x1F74);   var_20_2 = *(uint128 *)(0x1F74);
    x0_11 = duffs_device(&var_0, &var_20, 8);
    x0_12 = sub_910("CF-L2-05 (duffs_device): %d\\n", (uint32)x0_11);
    x8 = 11;
    /* cmp w9, w10 — 次の分岐のための比較 */
    __asm("b.hs #0x14b0");
    x21 = (uint32)((uint32)x21 + 1);
    x8 = (uint32)((uint32)x8 - 1);
    /* cmp w21, #9 — 次の分岐のための比較 */
    __asm("b.lo #0x148c");
    x1_1 = (uint32)((uint32)x19 + 2);
    x0_13 = sub_910("CF-L2-06 (loop_complex_cond): %d\\n", x1_1);
    x0_14 = sub_910("CF-L2-07 (loop_modify_var): %d\\n", 30);
    x1 = 0;
    var_58 = x11;
    __asm("cbnz w8, #0x14ec");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x65 — 次の分岐のための比較 */
    __asm("b.ne #0x14d8");
    x0_15 = sub_910("CF-L2-08 (loop_external_state): %d\\n");
    x0_16 = sub_910("CF-L2-09 (recursion_factorial): %d\\n", 120);
    x0_17 = sub_910("CF-L2-10 (tail_recursion): %d\\n", 120);
    x0_18 = sub_910("CF-L2-11 (indirect_recursion): %d\\n", 3);
    x0_19 = sub_910("CF-L2-12 (call_func_ptr): %d\\n", 10);
    x0_20 = "CF-L2-13 (call_func_ptr_array): %d\\n";
    x0_21 = sub_910(x0_20, 10);
    x0_22 = sub_910(x0_20, 120);
    return sub_910("CF-L2-15 (process_with_callback): %d\\n", 30);
}
    goto loc_13A0;

void non_local_jump(void)
{
    loc_1578:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(0x13058);
        if (call_141 == 0) goto loc_15A0;
        goto loc_1598;
    loc_1598:
        goto loc_15B0;
    loc_15A0:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_15BC;
        goto loc_15A4;
    loc_15A4:
        if ((uint32_t)a1 >= 0x65) goto loc_15C8;
        goto loc_15AC;
    loc_15AC:
    loc_15B0:
        return;
    loc_15BC:
        goto loc_15D0;
    loc_15C8:
    loc_15D0:
        unknown_call(0x13000);
}

void cpp_exception(void)
{
    return;
}

uint32 large_jump_table(int64 a1, int64 a2, int64 a3)
    loc_1600:
{
    /* cmp w0, #9 — 次の分岐のための比較 */
    __asm("b.ls #0x1604");
    return x0;
    __asm("br x3");
}
    goto loc_1600;

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
    loc_1634:
        if (a2 == 0) goto loc_1640;
        goto loc_1638;
    loc_1638:
        return;
    loc_1640:
        return;
}

void op_mod(void)
{
    loc_1648:
        if (a2 == 0) goto loc_1658;
        goto loc_164C;
    loc_164C:
        return;
    loc_1658:
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

uint32 conditional_func_ptr(int64 a1, int64 a2)
    loc_168C:
{
    /* cmp w0, #1 — 次の分岐のための比較 */
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("br x2");
}
    goto loc_168C;

uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.hi #0x16e8");
    __asm("br x10");
    /* cmp w0, #1 — 次の分岐のための比較 */
    x1 = (uint32)((uint32)a1 == 1 ? 1 : 0);
    __asm("b #0x1714");
    x1 = 3;
    __asm("b #0x1714");
    /* cmp w0, #0x63 — 次の分岐のための比較 */
    /* cmp w0, #2 — 次の分岐のための比較 */
    x1 = (uint32)((uint32)a1 == 2 ? (uint32)a1 : (uint32)((uint32)a1 == 99 ? 3 : 1));
    __asm("b #0x1714");
    /* cmp w0, #0 — 次の分岐のための比較 */
    x1 = (uint32)((uint32)a1 == 0 ? 0 : 3);
    return x0;
}

uint32 fsm_func_table(uint64 a2)
    loc_1728:
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.ls #0x172c");
    return x0;
    __asm("br x1");
}
    goto loc_1728;

void state_idle(void)
{
    return;
}

void state_processing(void)
{
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

uint32 computed_goto(int64 a2)
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.ls #0x1788");
    return x0;
    __asm("br x8");
    return x0;
    return x0;
    return x0;
    return x0;
}

void sub_17A0(void)
{
    return;
}

void sub_17A8(void)
{
    return;
}

void sub_17B0(void)
{
    return;
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

uint64 test_control_flow_l3(void)
    loc_17E8:
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
    goto loc_17E8;

void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_control_flow_l1(/* arguments unknown */);
    test_control_flow_l2(/* arguments unknown */);
    test_control_flow_l3(/* arguments unknown */);
    return;
}
