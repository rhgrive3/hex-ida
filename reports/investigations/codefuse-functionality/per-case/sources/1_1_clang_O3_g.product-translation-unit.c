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

uint32 loop_break(int64 a1)
{
    x8 = (uint32)((uint32)a1 - 10);
    /* cmp w8, #0x28 — 次の分岐のための比較 */
    __asm("b.hi #0xc80");
    __asm("br x10");
    return x0;
    return x0;
    return x0;
    return x0;
    return x0;
}

void sub_C88(void)
{
    return;
}

void sub_C90(void)
{
    return;
}

void sub_C98(void)
{
    return;
}

void loop_continue(void)
{
    loc_CA0:
        if ((int32_t)a1 < 1) goto loc_CBC;
        goto loc_CA8;
    loc_CA8:
        if ((uint32_t)a1 >= 8) goto loc_CC4;
        goto loc_CB0;
    loc_CB0:
        goto loc_D28;
    loc_CBC:
        return;
    loc_CC4:
    loc_CEC:
        if ((uint32_t)phi(a1 & 0xFFFFFFF8, v151) != 8) goto loc_CEC;
        goto loc_D14;
    loc_D14:
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_D44;
        goto loc_D28;
    loc_D28:
    loc_D2C:
        if ((uint32_t)a1 + 1 != (uint32_t)(phi(x9, phi((a1 & 0xFFFFFFF8) | 1, 1))) + 1) goto loc_D2C;
        goto loc_D44;
    loc_D44:
        return;
}

void goto_forward(void)
{
    return;
}

void goto_backward(void)
{
    loc_D60:
        if ((int32_t)a1 < 1) goto loc_D7C;
        goto loc_D68;
    loc_D68:
        if ((uint32_t)a1 >= 8) goto loc_D84;
        goto loc_D70;
    loc_D70:
        goto loc_DE0;
    loc_D7C:
        return;
    loc_D84:
    loc_DA8:
        if ((uint32_t)phi(v58, a1 & 0xFFFFFFF8) != 8) goto loc_DA8;
        goto loc_DC0;
    loc_DC0:
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_DF4;
        goto loc_DE0;
    loc_DE0:
    loc_DE4:
        if ((uint32_t)a1 + 1 != (uint32_t)(phi(x9, phi((a1 & 0xFFFFFFF8) | 1, 1))) + 1) goto loc_DE4;
        goto loc_DF4;
    loc_DF4:
        return;
}

void ternary_op(void)
{
    return;
}

uint64 test_control_flow_l1(void)
    loc_E0C:
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
    goto loc_E0C;

void loop_multi_exit(void)
{
    loc_FD4:
        if ((uint32_t)a1 - 1 > 11) goto loc_1004;
        goto loc_FE0;
    loc_FE0:
        return;
    loc_1004:
        return;
}

void infinite_loop(void)
{
    if ((uint32_t)a1->field_0 != 1) {
        if ((uint32_t)(phi(x0, 0)) + 1 != 0x3E9) {
            goto loc_1014;
        } else {
            a1->field_0 = 1;
        }
    }
    return;
}

void multi_return(void)
{
    loc_1038:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1058;
        goto loc_103C;
    loc_103C:
        return;
    loc_1058:
        return;
}

void conditional_return(void)
{
    return;
}

uint32 duffs_device(void * a1, void * a2, int64 a3)
{
    x8 = 0xFFFFFFFF;
    /* cmp w2, #1 — 次の分岐のための比較 */
    __asm("b.lt #0x10fc");
    x8 = (uint32)((uint32)((uint32)a3 + 7) >> 3);
    __asm("br x11");
    x9 = *(uint32 *)(x1);
    x8 = (uint32)(x8 - 1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(a2);
    __asm("b.le #0x10f8");
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 4);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 8);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 12);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 16);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 20);
    x9 = *(uint32 *)(x1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 24);
    x9 = *(uint32 *)(x1);
    x8 = (uint32)((uint32)x8 - 1);
    *(uint32 *)(x0) = (uint32)*(uint32 *)(x1 + 28);
    __asm("b.gt #0x10b0");
    x8 = (uint32)a3;
    return x0;
}

void loop_complex_cond(void)
{
    loc_1104:
        if ((int32_t)a1 < 1) goto loc_114C;
        goto loc_110C;
    loc_110C:
    loc_1114:
        if ((uint32_t)phi(x0 - 1, a1) < 2) goto loc_1140;
        goto loc_112C;
    loc_112C:
        if ((int32_t)(phi(x8, 0)) + 2 >= (int32_t)x0 - 1) goto loc_1140;
        goto loc_1134;
    loc_1134:
        if ((uint32_t)phi(x10 + 1, 0) < 9) goto loc_1114;
        goto loc_1140;
    loc_1140:
        return;
    loc_114C:
        return;
}

void loop_modify_var(void)
{
    loc_1160:
        if ((int32_t)a1 < 1) goto loc_1194;
        goto loc_1168;
    loc_1168:
    loc_1170:
        if ((int32_t)(((int32_t)phi(0, x9) > 5 ? (phi(0, x9)) + 2 : phi(0, x9))) + 1 < (int32_t)a1) goto loc_1170;
        goto loc_118C;
    loc_118C:
        return;
    loc_1194:
        return;
}

void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(0, x0)) + 1 != 0x65) goto loc_11A8;
        goto loc_11BC;
    }
    return;
}

void recursion_factorial(void)
{
    loc_11C0:
        if ((int32_t)a1 >= 2) goto loc_11D0;
        goto loc_11C8;
    loc_11C8:
        return;
    loc_11D0:
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v179)) + 1 >= 8) goto loc_11EC;
        goto loc_11E4;
    loc_11E4:
        goto loc_1250;
    loc_11EC:
    loc_1218:
        if ((uint32_t)phi(v113, ((((uint32_t)a1 < 2 ? 0 : v179)) + 1) & 0xFFFFFFF8) != 8) goto loc_1218;
        goto loc_1230;
    loc_1230:
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v179)) + 1 == (uint32_t)((((uint32_t)a1 < 2 ? 0 : v179)) + 1) & 0xFFFFFFF8) goto loc_1264;
        goto loc_1250;
    loc_1250:
        if ((uint32_t)phi(a1 - (((((uint32_t)a1 < 2 ? 0 : v179)) + 1) & 0xFFFFFFF8), a1, x8 - 1) > 2) goto loc_1250;
        goto loc_1264;
    loc_1264:
        return;
}

void tail_recursion(void)
{
    if ((int32_t)a1 >= 2) {
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v42)) + 1 < 8) {
            while ((uint32_t)phi(a1, a1 - (((((uint32_t)a1 < 2 ? 0 : v42)) + 1) & 0xFFFFFFF8), x0 - 1) > 2) {
            }
        } else {
            while ((uint32_t)phi(v32, ((((uint32_t)a1 < 2 ? 0 : v42)) + 1) & 0xFFFFFFF8) != 8) {
            }
            if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : v42)) + 1 != (uint32_t)((((uint32_t)a1 < 2 ? 0 : v42)) + 1) & 0xFFFFFFF8) {
                goto loc_12E8;
            }
        }
    }
    return;
}

uint32 indirect_recursion_a(int64 a1, int64 a2)
{
    /* cmp w1, #1 — 次の分岐のための比較 */
    __asm("b.lt #0x1358");
    x8 = (uint32)((uint32)a2 + 2);
    __asm("b #0x1320");
    loc_1314:
    x8 = (uint32)((uint32)x8 - 2);
    /* cmp w8, #3 — 次の分岐のための比較 */
    __asm("b.lt #0x1358");
    __asm("tbnz w0, #0, #0x1340");
    /* cmp w0, #0 — 次の分岐のための比較 */
    /* cmp w8, #3 — 次の分岐のための比較 */
    x0 = (uint32)((uint32)((uint32)a1 < 0 ? (uint32)a1 + 1 : (uint32)a1) >> 1);
    __asm("b.eq #0x1358");
    x0 = (uint32)(x0 + 1);
    __asm("b #0x1314");
    goto loc_1314;
    x9 = (uint32)((uint32)x0 * 3);
    /* cmp w8, #3 — 次の分岐のための比較 */
    __asm("b.eq #0x1354");
    x0 = (uint32)(x9 + 2);
    __asm("b #0x1314");
    goto loc_1314;
    return x0;
}

uint32 call_func_ptr(int64 a1, int64 a2)
    loc_1360:
{
    __asm("br x2");
}
    goto loc_1360;

uint32 call_func_ptr_array(int64 a1, int64 a2)
    loc_1374:
{
    /* cmp w0, #2 — 次の分岐のための比較 */
    __asm("b.ls #0x1378");
    return x0;
    __asm("br x2");
}
    goto loc_1374;

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
    loc_13A4:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x22;
        local_pFFFFFFFFFFFFFFE0 = local_x22;
        local_pFFFFFFFFFFFFFFF0 = local_x20;
        local_pFFFFFFFFFFFFFFF0 = local_x20;
        if ((int32_t)a2 < 1) goto loc_13F4;
        goto loc_13BC;
    loc_13BC:
    loc_13CC:
        unknown_call(phi(call_223, a1));
        if ((uint64_t)phi(v95 - 1, a2) != 1) goto loc_13CC;
        goto loc_13E0;
    loc_13E0:
        return;
    loc_13F4:
        return;
}

uint64 test_control_flow_l2(void)
    loc_1438:
{
    uint32 var_18, var_1C;

    x0_1 = sub_8F0("=== 测试高级控制流特征 ===");
    x0_2 = sub_910("CF-L2-01 (loop_multi_exit): %d\\n", 12);
    x1 = 0;
    var_1C = 0;
    /* cmp w8, #1 — 次の分岐のための比較 */
    __asm("b.eq #0x1460");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x3e9 — 次の分岐のための比較 */
    __asm("b.ne #0x1440");
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
    __asm("b.hs #0x14f8");
    x21 = (uint32)((uint32)x21 + 1);
    x8 = (uint32)((uint32)x8 - 1);
    /* cmp w21, #9 — 次の分岐のための比較 */
    __asm("b.lo #0x14d4");
    x1_1 = (uint32)((uint32)x19 + 2);
    x0_12 = sub_910("CF-L2-06 (loop_complex_cond): %d\\n", x1_1);
    x0_13 = sub_910("CF-L2-07 (loop_modify_var): %d\\n", 30);
    x1 = 0;
    var_18 = 0;
    __asm("cbnz w8, #0x1534");
    x1 = (uint32)((uint32)x1 + 1);
    /* cmp w1, #0x65 — 次の分岐のための比較 */
    __asm("b.ne #0x1520");
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
    goto loc_1438;

void non_local_jump(void)
{
    loc_15BC:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(0x13058);
        if (call_190 == 0) goto loc_15EC;
        goto loc_15DC;
    loc_15DC:
        return;
    loc_15EC:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1608;
        goto loc_15F0;
    loc_15F0:
        if ((uint32_t)a1 >= 0x65) goto loc_1618;
        goto loc_15F8;
    loc_15F8:
        return;
    loc_1608:
        unknown_call(0x13058);
    loc_1618:
        unknown_call(0x13058);
}

void cpp_exception(void)
{
    return;
}

uint32 large_jump_table(int64 a1, int64 a2, int64 a3)
    loc_1650:
{
    /* cmp w0, #9 — 次の分岐のための比較 */
    __asm("b.ls #0x1654");
    return x0;
    __asm("br x3");
}
    goto loc_1650;

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
    loc_1684:
        if (a2 == 0) goto loc_1690;
        goto loc_1688;
    loc_1688:
        return;
    loc_1690:
        return;
}

void op_mod(void)
{
    loc_1698:
        if (a2 == 0) goto loc_16A8;
        goto loc_169C;
    loc_169C:
        return;
    loc_16A8:
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
    loc_16DC:
{
    /* cmp w0, #1 — 次の分岐のための比較 */
    /* cmp w0, #0 — 次の分岐のための比較 */
    __asm("br x2");
}
    goto loc_16DC;

uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.hi #0x1738");
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

uint32 fsm_func_table(uint64 a2)
    loc_1778:
{
    /* cmp w1, #3 — 次の分岐のための比較 */
    __asm("b.ls #0x177c");
    return x0;
    __asm("br x1");
}
    goto loc_1778;

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
    __asm("b.ls #0x17d8");
    return x0;
    __asm("br x8");
    return x0;
    return x0;
    return x0;
    return x0;
}

void sub_17F0(void)
{
    return;
}

void sub_17F8(void)
{
    return;
}

void sub_1800(void)
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
    loc_1838:
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
    goto loc_1838;

void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_control_flow_l1(/* arguments unknown */);
    test_control_flow_l2(/* arguments unknown */);
    test_control_flow_l3(/* arguments unknown */);
    return;
}
