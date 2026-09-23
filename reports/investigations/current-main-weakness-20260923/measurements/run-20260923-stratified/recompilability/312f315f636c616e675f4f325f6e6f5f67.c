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
    uint64 load_20;
    uint64 load_30;
    load_20 = var_0;
    load_30 = global_12FD8;
    unknown_call(load_30);
    unknown_call(load_30);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x984");
    return sub_8D0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_37;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13050 != 0x13050) {
        load_37 = global_12FC0;
        if (!(load_37 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_58;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_58 = global_12FE0;
        if (!(load_58 == 0)) {
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
    if (!(global_13050 != 0)) {
        if (!(global_12FC8 == 0)) {
            unknown_call(global_13048);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
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
void nested_if_2(void)
{
    return;
}
void nested_if_deep(void)
{
    if ((int32_t)a1 < 1) {
        return;
    } else {
        if ((int32_t)a2 < 1) {
            return;
        } else {
            if ((int32_t)a3 < 1) {
                return;
            } else {
                if ((int32_t)a4 < 1) {
                    return;
                } else {
                    return;
                }
            }
        }
    }
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
    if ((uint32_t)a1 > 3) {
        return;
    } else {
        return;
    }
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
    if ((uint32_t)a1 != 1) {
        if ((uint32_t)a1 != 2) {
            if ((uint32_t)a1 != 3) {
                return;
            }
        }
    }
    return;
}
void loop_for_fixed(void)
{
    if ((int32_t)a1 < 1) {
        return;
    } else {
        return;
    }
}
void loop_while(void)
{
    if (a1 == 0) {
        return;
    }
    while ((uint32_t)(phi((((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 34) + (((sext(x8)) * (sext(bit_insert(0x6667, 0x6666, 16, 16)))) >> 63), a1)) + 9 > 18) {
    }
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
    /* cmp (int32)(x8), 0x28 — 次の分岐のための比較 */
    __asm("b.hi #0xc84");
    __asm("br x10");
    return 1;
    return 0xFFFFFFFF;
    return 2;
    return 3;
    return 4;
}
void loop_continue(void)
{
        if ((int32_t)a1 < 1) goto loc_CC0;
        if ((uint32_t)a1 >= 8) goto loc_CC8;
        goto loc_D2C;
    loc_CC0:
        return;
    loc_CC8:
        while ((uint32_t)phi(a1 & 0xFFFFFFF8, v248 - 8) != 8) {
        }
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_D48;
    loc_D2C:
        while ((uint32_t)a1 + 1 != (uint32_t)(phi(phi((a1 & 0xFFFFFFF8) | 1, 1), x9)) + 1) {
        }
    loc_D48:
        return;
}
void goto_forward(void)
{
    return;
}
void goto_backward(void)
{
        if ((int32_t)a1 < 1) goto loc_D80;
        if ((uint32_t)a1 >= 8) goto loc_D88;
        goto loc_DE4;
    loc_D80:
        return;
    loc_D88:
        while ((uint32_t)phi(v32 - 8, a1 & 0xFFFFFFF8) != 8) {
        }
        if ((uint32_t)a1 & 0xFFFFFFF8 == (uint32_t)a1) goto loc_DF8;
    loc_DE4:
        while ((uint32_t)a1 + 1 != (uint32_t)(phi(x9, phi((a1 & 0xFFFFFFF8) | 1, 1))) + 1) {
        }
    loc_DF8:
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
    unknown_call("CF-L1-01 (sequential_ops): %d\\n");
    unknown_call(0x1A2F);
    unknown_call(0x1A2F);
    unknown_call(0x1A49);
    unknown_call(0x1A49);
    unknown_call(0x1A61);
    unknown_call(0x1A61);
    unknown_call(0x1A61);
    unknown_call("CF-L1-05 (nested_if_deep): %d\\n");
    unknown_call("CF-L1-06 (if_elseif_chain): %d\\n");
    unknown_call("CF-L1-07 (if_elseif_long): %d\\n");
    unknown_call("CF-L1-08 (switch_small): %d\\n");
    unknown_call("CF-L1-09 (switch_large): %d\\n");
    unknown_call("CF-L1-10 (switch_default): %d\\n");
    unknown_call("CF-L1-11 (switch_fallthrough): %d\\n");
    unknown_call("CF-L1-12 (loop_for_fixed): %d\\n");
    unknown_call("CF-L1-13 (loop_while): %d\\n");
    unknown_call("CF-L1-14 (loop_dowhile): %d\\n");
    unknown_call("CF-L1-15 (loop_nested): %d\\n");
    unknown_call(0x1BCA);
    unknown_call(0x1BCA);
    unknown_call("CF-L1-17 (loop_continue): %d\\n");
    unknown_call(0x1C03);
    unknown_call(0x1C03);
    unknown_call("CF-L1-19 (goto_backward): %d\\n");
    unknown_call(0x1C3E);
}
void loop_multi_exit(void)
{
    if ((uint32_t)a1 - 1 > 11) {
        return;
    } else {
        return;
    }
}
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
void multi_return(void)
{
    if (__arm64_condition_unknown(/* NZCV */)) {
        return;
    } else {
        return;
    }
}
void conditional_return(void)
{
    return;
}
uint32 duffs_device(int64 a3)
{
    x8 = 0xFFFFFFFF;
    /* cmp (int32)(a3), 1 — 次の分岐のための比較 */
    __asm("b.lt #0x10f0");
    __asm("br x11");
    x9 = *(uint32 *)(a2);
    *(uint32 *)(a1) = (uint32)*(uint32 *)(a2);
    x9 = *(uint32 *)(a2 + 4);
    *(uint32 *)(a1 + 4) = (uint32)*(uint32 *)(a2 + 4);
    x9 = *(uint32 *)(a2 + 8);
    *(uint32 *)(a1 + 8) = (uint32)*(uint32 *)(a2 + 8);
    x9 = *(uint32 *)(a2 + 12);
    *(uint32 *)(a1 + 12) = (uint32)*(uint32 *)(a2 + 12);
    x9 = *(uint32 *)(a2 + 16);
    *(uint32 *)(a1 + 16) = (uint32)*(uint32 *)(a2 + 16);
    x9 = *(uint32 *)(a2 + 20);
    *(uint32 *)(a1 + 20) = (uint32)*(uint32 *)(a2 + 20);
    x9 = *(uint32 *)(a2 + 24);
    *(uint32 *)(a1 + 24) = (uint32)*(uint32 *)(a2 + 24);
    x9 = *(uint32 *)(a2 + 28);
    x8 = (uint32)((uint32)x8 - 1);
    *(uint32 *)(a1 + 28) = (uint32)*(uint32 *)(a2 + 28);
    __asm("b.gt #0x10a4");
    x8 = (uint32)a3;
    return (uint32)x8;
}
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
void loop_modify_var(void)
{
    if ((int32_t)a1 < 1) {
        return;
    }
    while ((int32_t)(((int32_t)phi(0, x9) > 5 ? (phi(0, x9)) + 2 : phi(0, x9))) + 1 < (int32_t)a1) {
    }
    return;
}
void loop_external_state(void)
{
    while (!(a1->field_0 != 0)) {
        if ((uint32_t)(phi(0, x0)) + 1 == 0x65) {
            break;
        }
    }
    return;
}
void recursion_factorial(void)
{
    uint64 load_246;
        if ((int32_t)a1 >= 2) goto loc_11BC;
        return;
    loc_11BC:
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1 >= 8) goto loc_11D8;
        goto loc_123C;
    loc_11D8:
        load_246 = global_19F0;
        while ((uint32_t)phi(((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8, v208 - 8) != 8) {
        }
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1 == (uint32_t)((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8) goto loc_1250;
    loc_123C:
        while ((uint32_t)phi(x8 - 1, a1 - (((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8), a1) > 2) {
        }
    loc_1250:
        return;
}
void tail_recursion(void)
{
    uint64 load_73;
    if ((int32_t)a1 >= 2) {
        if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1 < 8) {
            while ((uint32_t)phi(a1, x0 - 1, a1 - (((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8)) > 2) {
            }
        } else {
            load_73 = global_19F0;
            while ((uint32_t)phi(((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8, v214 - 8) != 8) {
            }
            if ((uint32_t)(((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1 != (uint32_t)((((uint32_t)a1 < 2 ? 0 : a1 - 2)) + 1) & 0xFFFFFFF8) {
                goto loc_12D4;
            }
        }
    }
    return;
}
uint32 indirect_recursion_a(int64 a1, int64 a2)
{
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.lt #0x1344");
    x8 = (uint32)((uint32)a2 + 2);
    __asm("b #0x130c");
    loc_1300:
    x8 = (uint32)((uint32)x8 - 2);
    /* cmp (int32)(x8), 3 — 次の分岐のための比較 */
    __asm("b.lt #0x1344");
    __asm("tbnz w0, #0, #0x132c");
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    /* cmp (int32)(x8), 3 — 次の分岐のための比較 */
    x0 = (uint32)((uint32)((uint32)a1 < 0 ? (uint32)a1 + 1 : (uint32)a1) >> 1);
    __asm("b.eq #0x1344");
    x0 = (uint32)(x0 + 1);
    __asm("b #0x1300");
    goto loc_1300;
    x9 = (uint32)((uint32)x0 * 3);
    /* cmp (int32)(x8), 3 — 次の分岐のための比較 */
    __asm("b.eq #0x1340");
    x0 = (uint32)(x9 + 2);
    __asm("b #0x1300");
    goto loc_1300;
    return x0;
}
uint32 call_func_ptr(int64 a1, int64 a2)
{
    __asm("br x2");
}
void call_func_ptr_array(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if ((uint32_t)a1 <= 2) {
        __asm("br x2");
    } else {
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
        unknown_call(memory_unknown);
        while ((uint64_t)phi(v62 - 1, a2) != 1) {
        }
    }
    return;
}
void test_control_flow_l2(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call("=== 测试高级控制流特征 ===");
    unknown_call("CF-L2-01 (loop_multi_exit): %d\\n");
    local_pFFFFFFFFFFFFFFEC = 0;
    if ((uint32_t)var_FFFFFFFFFFFFFFEC != 1) {
        if ((uint32_t)(phi(x1, 0)) + 1 != 0x3E9) {
            goto loc_141C;
        } else {
            local_pFFFFFFFFFFFFFFEC = 1;
        }
    }
    unknown_call("CF-L2-02 (infinite_loop): %d\\n");
    unknown_call(0x1C97);
    unknown_call(0x1C97);
    unknown_call(0x1C97);
    unknown_call(0x1CB4);
    unknown_call(0x1CB4);
    unknown_call("CF-L2-05 (duffs_device): %d\\n");
    while ((uint32_t)(phi(x19 + 2, call_1101)) - 8 < (uint32_t)(phi(x8 - 1, 11)) - 2) {
        if ((uint32_t)(phi(x21, call_615)) + 1 >= 9) {
            break;
        }
    }
    unknown_call("CF-L2-06 (loop_complex_cond): %d\\n");
    unknown_call("CF-L2-07 (loop_modify_var): %d\\n");
    local_pFFFFFFFFFFFFFFE8 = 0;
    while (!(var_FFFFFFFFFFFFFFE8 != 0)) {
        if ((uint32_t)(phi(0, x1)) + 1 == 0x65) {
            break;
        }
    }
    unknown_call("CF-L2-08 (loop_external_state): %d\\n");
    unknown_call("CF-L2-09 (recursion_factorial): %d\\n");
    unknown_call("CF-L2-10 (tail_recursion): %d\\n");
    unknown_call("CF-L2-11 (indirect_recursion): %d\\n");
    unknown_call("CF-L2-12 (call_func_ptr): %d\\n");
    unknown_call(0x1DDE);
    unknown_call(0x1DDE);
}
void non_local_jump(void)
{
    loc_1598:
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(0x13058);
        if (call_167 == 0) goto loc_15C0;
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
void cpp_exception(void)
{
    return;
}
void large_jump_table(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if ((uint32_t)a1 <= 9) {
        __asm("br x3");
    } else {
        return;
    }
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
    if (a2 == 0) {
        return;
    } else {
        return;
    }
}
void op_mod(void)
{
    if (a2 == 0) {
        return;
    } else {
        return;
    }
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
{
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("br x2");
}
uint32 state_machine(int64 a1, int64 a2)
{
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    __asm("b.hi #0x170c");
    __asm("br x10");
    /* cmp (int32)(a1), 1 — 次の分岐のための比較 */
    return (uint32)((uint32)a1 == 1 ? 1 : 0);
    x0_1 = 3;
    return x0_1;
    /* cmp (int32)(x0_1), 0x63 — 次の分岐のための比較 */
    /* cmp (int32)(x0_1), 2 — 次の分岐のための比較 */
    x0_2 = 1;
    return x0_2;
    /* cmp (int32)(x0_2), 0 — 次の分岐のための比較 */
    return 3;
}
void fsm_func_table(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if ((uint32_t)a2 <= 3) {
        __asm("br x1");
    } else {
        return;
    }
}
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
    /* cmp (int32)(a2), 3 — 次の分岐のための比較 */
    __asm("b.ls #0x17ac");
    return 0xFFFFFFFF;
    __asm("br x8");
    return 0;
    return 20;
    return 30;
    return 10;
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
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("=== 测试极端控制流特征 ===");
    non_local_jump(/* arguments unknown */);
    unknown_call(0x1E28);
    non_local_jump(/* arguments unknown */);
    unknown_call(0x1E28);
    unknown_call(0x1E47);
    unknown_call(0x1E47);
    unknown_call("CF-L3-03 (large_jump_table): %d\\n");
    unknown_call("CF-L3-04 (conditional_func_ptr): %d\\n");
    unknown_call("CF-L3-05 (state_machine): %d\\n");
    unknown_call("CF-L3-06 (fsm_func_table): %d\\n");
    computed_goto(/* arguments unknown */);
    unknown_call("CF-L3-07 (computed_goto): %d\\n");
    unknown_call("CF-L3-08 (obfuscated_cf): %d\\n");
    unknown_call("CF-L3-09 (opaque_predicate): %d\\n");
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
