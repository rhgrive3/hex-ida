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
    uint64 load_17;
    uint64 load_13;
    load_17 = var_0;
    load_13 = global_13FD8;
    unknown_call(load_13);
    unknown_call(load_13);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FD0;
    __asm("cbz x0, #0x984");
    return sub_8E0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_22;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x14050 != 0x14050) {
        load_22 = global_13FC0;
        if (!(load_22 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_13FE0 == 0)) {
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
    if (!(global_14050 != 0)) {
        if (!(global_13FC8 == 0)) {
            unknown_call(global_14048);
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
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = (uint32_t)a1 + (uint32_t)a2;
    local_m14 = ((uint32_t)((uint32_t)a1 + (uint32_t)a2) << 1);
    local_m18 = ((uint32_t)((uint32_t)a1 + (uint32_t)a2) << 1) - (uint32_t)a3;
    return;
}
void single_if(void)
{
    local_m4 = a1;
    if ((int32_t)a1 > 0) {
        local_m4 = ((uint32_t)(uint32_t)a1 << 1);
    }
    return;
}
void if_else(void)
{
    local_m8 = a1;
    if ((int32_t)a1 <= 0) {
        local_m4 = 0;
    } else {
        local_m4 = 1;
    }
    return;
}
void nested_if_2(void)
{
    local_m8 = a1;
    local_mC = a2;
    if ((int32_t)a1 <= 0) {
        local_m4 = 0;
    } else {
        if ((int32_t)a2 <= 0) {
            local_m4 = (uint32_t)a1;
        } else {
            local_m4 = (uint32_t)a1 + (uint32_t)a2;
        }
    }
    return;
}
void nested_if_deep(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = a3;
    local_m14 = a4;
    local_m18 = a5;
    if ((int32_t)a1 <= 0) {
        local_m4 = 0;
    } else {
        if ((int32_t)a2 <= 0) {
            local_m4 = 1;
        } else {
            if ((int32_t)a3 <= 0) {
                local_m4 = 2;
            } else {
                if ((int32_t)a4 <= 0) {
                    local_m4 = 3;
                } else {
                    if ((int32_t)a5 <= 0) {
                        local_m4 = 4;
                    } else {
                        local_m4 = 5;
                    }
                }
            }
        }
    }
    return;
}
void if_elseif_chain(void)
{
    local_m8 = a1;
    if (a1 != 0) {
        if ((uint32_t)a1 != 1) {
            if ((uint32_t)a1 != 2) {
                local_m4 = 0xFFFFFFFF;
            } else {
                local_m4 = 30;
            }
        } else {
            local_m4 = 20;
        }
    } else {
        local_m4 = 10;
    }
    return;
}
void if_elseif_long(void)
{
    local_m8 = a1;
    if (a1 != 0) {
        if ((uint32_t)a1 != 1) {
            if ((uint32_t)a1 != 2) {
                if ((uint32_t)a1 != 3) {
                    if ((uint32_t)a1 != 4) {
                        local_m4 = 0xFFFFFFFF;
                    } else {
                        local_m4 = 0x1F4;
                    }
                } else {
                    local_m4 = 0x190;
                }
            } else {
                local_m4 = 0x12C;
            }
        } else {
            local_m4 = 0xC8;
        }
    } else {
        local_m4 = 0x64;
    }
    return;
}
uint32 switch_small(uint32 a1)
{
    uint64 var_8;
    uint32 var_10, var_14, var_18, var_1C;

    var_18 = x8;
    var_14 = 10;
    var_10 = 5;
    var_8 = var_18;
    __asm("b.hi #0xdd0");
    x8 = var_8;
    __asm("br x8");
    var_1C = 15;
    __asm("b #0xddc");
    var_1C = 5;
    __asm("b #0xddc");
    var_1C = 50;
    __asm("b #0xddc");
    var_1C = 2;
    __asm("b #0xddc");
    var_1C = 0xFFFFFFFF;
    __asm("b #0xddc");
    return (uint32)var_1C;
}
uint32 switch_large(uint32 a1)
{
    uint32 var_8, var_C;

    var_8 = x8;
    var_0 = var_8;
    __asm("b.hi #0xe94");
    __asm("br x8");
    var_C = 0;
    __asm("b #0xea0");
    var_C = 10;
    __asm("b #0xea0");
    var_C = 20;
    __asm("b #0xea0");
    var_C = 30;
    __asm("b #0xea0");
    var_C = 40;
    __asm("b #0xea0");
    var_C = 50;
    __asm("b #0xea0");
    var_C = 60;
    __asm("b #0xea0");
    var_C = 70;
    __asm("b #0xea0");
    var_C = 80;
    __asm("b #0xea0");
    var_C = 90;
    __asm("b #0xea0");
    var_C = 0xFFFFFFFF;
    __asm("b #0xea0");
    return (uint32)var_C;
}
void switch_default(void)
{
    local_m8 = a1;
    local_mC = (uint32_t)a1;
    if ((uint32_t)var_4 == 1) {
        local_m4 = 0x64;
    } else {
        if ((uint32_t)a1 == 2) {
            local_m4 = 0xC8;
        } else {
            if ((uint32_t)a1 == 3) {
                local_m4 = 0x12C;
            } else {
                local_m4 = 0;
            }
        }
    }
    return;
}
void switch_fallthrough(void)
{
    local_m4 = a1;
    local_m8 = 0;
    local_mC = (uint32_t)a1;
    if ((uint32_t)var_4 == 1) {
        local_m8 = local_m8 + (uint32_t)a1;
    } else {
        if ((uint32_t)a1 == 2) {
            local_m8 = local_m8 + ((uint32_t)(uint32_t)a1 << 1);
            goto loc_F88;
        } else {
            if ((uint32_t)a1 != 3) {
                local_m8 = 0xFFFFFFFF;
            } else {
                local_m8 = 0 + ((uint32_t)(uint32_t)a1 << 2);
                goto loc_F74;
            }
        }
    }
    return;
}
void loop_for_fixed(void)
{
    local_m4 = a1;
    local_m8 = 0;
    local_mC = 0;
    while ((int32_t)var_4 < (int32_t)var_C) {
        local_m8 = local_m8 + local_mC;
        local_mC = local_mC + 1;
        continue;
    }
    return;
}
void loop_while(void)
{
    int32 var_C;
    local_m4 = a1;
    local_m8 = 0;
    while (!(var_C == 0)) {
        local_m4 = (int32_t)local_m4 / 10;
        local_m8 = local_m8 + 1;
        continue;
    }
    if ((int32_t)var_8 <= 0) {
        local_mC = 1;
    } else {
        local_mC = local_m8;
    }
    return;
}
void loop_dowhile(void)
{
    int32 var_C;
    local_m4 = a1;
    local_m8 = 0;
    local_m4 = (int32_t)local_m4 / 10;
    local_m8++;
    local_m4 = (int32_t)local_m4 / 10;
    local_m8++;
    if (var_C != 0) {
        goto loc_108C;
    }
    return;
}
void loop_nested(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = 0;
    local_m10 = 0;
    while ((int32_t)var_10 < (int32_t)var_1C) {
        local_m14 = 0;
        while ((int32_t)var_C < (int32_t)var_18) {
            local_mC = local_mC + 1;
            local_m14 = local_m14 + 1;
            continue;
        }
        local_m10 = local_m10 + 1;
        continue;
    }
    return;
}
void loop_break(void)
{
    local_m8 = a1;
    local_m20 = global_2B04;
    local_m10 = global_2B14;
    local_m24 = 5;
    local_m28 = 0;
    if ((int32_t)var_8 >= (int32_t)var_C) {
        local_m4 = 0xFFFFFFFF;
    } else {
        if ((uint32_t)((sp - 48) + 16)[sext(var_8)] != (uint32_t)var_28) {
            local_m28++;
            goto loc_117C;
        } else {
            local_m4 = local_m28;
        }
    }
    return;
}
void loop_continue(void)
{
    local_m4 = a1;
    local_m8 = 0;
    local_mC = 1;
    while ((int32_t)var_4 <= (int32_t)var_C) {
        if (var_4 - ((var_4 / 2) * 2) != 0) {
            local_m8 = local_m8 + local_mC;
        } else {
        }
        local_mC = local_mC + 1;
        continue;
    }
    return;
}
void goto_forward(void)
{
    local_m4 = a1;
    if ((int32_t)a1 <= 0) {
        local_m8 = (uint32_t)a1;
    } else {
        local_m8 = (uint32_t)a1 * (uint32_t)a1;
    }
    local_m8 = ((uint32_t)local_m8 << 1);
    return;
}
void goto_backward(void)
{
    local_m8 = a1;
    if ((int32_t)a1 > 0) {
        local_mC = 1;
        local_m10 = 1;
        while ((int32_t)var_0 <= (int32_t)var_8) {
            local_mC = local_mC * local_m10;
            local_m10 = local_m10 + 1;
            continue;
        }
        local_m4 = local_mC;
    } else {
        local_m4 = 1;
    }
    return;
}
void ternary_op(void)
{
    local_m4 = a1;
    local_m8 = a2;
    if ((int32_t)a1 <= (int32_t)a2) {
        local_mC = (uint32_t)a2;
    } else {
        local_mC = (uint32_t)a1;
    }
    return;
}
void test_control_flow_l1(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试基础控制流特征 ===\\n");
    local_m24 = 5;
    local_m44 = 7;
    local_m1C = 3;
    sequential_ops(/* arguments unknown */);
    unknown_call("CF-L1-01 (sequential_ops): %d\\n");
    local_m20 = 10;
    single_if(/* arguments unknown */);
    local_m68 = 0x2BA0;
    unknown_call(0x2BA0);
    local_m54 = 0xFFFFFFFB;
    single_if(/* arguments unknown */);
    unknown_call(var_m68);
    if_else(/* arguments unknown */);
    local_m60 = 0x2BBA;
    unknown_call(0x2BBA);
    local_m34 = 0xFFFFFFFD;
    if_else(/* arguments unknown */);
    unknown_call(var_m60);
    nested_if_2(/* arguments unknown */);
    local_m50 = 0x2BD2;
    unknown_call(0x2BD2);
    nested_if_2(/* arguments unknown */);
    unknown_call(var_m50);
    nested_if_2(/* arguments unknown */);
    unknown_call(var_m50);
    local_m48 = 1;
    nested_if_deep(/* arguments unknown */);
    unknown_call("CF-L1-05 (nested_if_deep): %d\\n");
    if_elseif_chain(/* arguments unknown */);
    unknown_call("CF-L1-06 (if_elseif_chain): %d\\n");
    if_elseif_long(/* arguments unknown */);
    unknown_call("CF-L1-07 (if_elseif_long): %d\\n");
    switch_small(/* arguments unknown */);
    unknown_call("CF-L1-08 (switch_small): %d\\n");
    switch_large(/* arguments unknown */);
    unknown_call("CF-L1-09 (switch_large): %d\\n");
    switch_default(/* arguments unknown */);
    unknown_call("CF-L1-10 (switch_default): %d\\n");
    switch_fallthrough(/* arguments unknown */);
    unknown_call("CF-L1-11 (switch_fallthrough): %d\\n");
    loop_for_fixed(/* arguments unknown */);
    unknown_call("CF-L1-12 (loop_for_fixed): %d\\n");
    loop_while(/* arguments unknown */);
    unknown_call("CF-L1-13 (loop_while): %d\\n");
    loop_dowhile(/* arguments unknown */);
    unknown_call("CF-L1-14 (loop_dowhile): %d\\n");
    loop_nested(/* arguments unknown */);
    unknown_call("CF-L1-15 (loop_nested): %d\\n");
    loop_break(/* arguments unknown */);
    local_m40 = 0x2D3B;
    unknown_call(0x2D3B);
    loop_break(/* arguments unknown */);
    unknown_call(var_m40);
    loop_continue(/* arguments unknown */);
    unknown_call("CF-L1-17 (loop_continue): %d\\n");
    goto_forward(/* arguments unknown */);
    local_m30 = 0x2D74;
    unknown_call(0x2D74);
    goto_forward(/* arguments unknown */);
    unknown_call(var_m30);
    goto_backward(/* arguments unknown */);
    unknown_call("CF-L1-19 (goto_backward): %d\\n");
    ternary_op(/* arguments unknown */);
    local_m18 = 0x2DAF;
    unknown_call(0x2DAF);
    ternary_op(/* arguments unknown */);
    unknown_call(var_m18);
    return;
}
void loop_multi_exit(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call((sp - 80) + 8);
    local_m4C = 0;
    if ((int32_t)var_m4C >= 3) {
        local_m14 = 0xFFFFFFFF;
    } else {
        local_m50 = 0;
        if ((int32_t)var_m50 >= 4) {
            local_m4C++;
            goto loc_169C;
        } else {
            if ((uint32_t)(((sp - 80) + 8) + ((sext(var_m4C)) << 4))[sext(var_m50)] != (uint32_t)var_m18) {
                local_m50++;
                goto loc_16B4;
            } else {
                local_m14 = local_m4C * 10 + local_m50;
            }
        }
    }
    return;
}
void infinite_loop(void)
{
    local_m8 = a1;
    local_mC = 0;
    if ((uint32_t)memory_unknown != 1) {
        local_mC++;
        if ((int32_t)var_4 <= 0x3E8) {
            goto loc_1758;
        } else {
            memory_unknown = 1;
        }
    } else {
    }
    return;
}
void multi_return(void)
{
    local_m8 = a1;
    if ((int32_t)a1 >= 0) {
        local_mC = ((uint32_t)(uint32_t)a1 << 1);
        if ((int32_t)var_4 <= 0x64) {
            if (a1 - ((a1 / 2) * 2) != 0) {
                local_m4 = (uint32_t)a1 + 1;
            } else {
                local_m4 = local_mC;
            }
        } else {
            local_m4 = 0xFFFFFFFE;
        }
    } else {
        local_m4 = 0xFFFFFFFF;
    }
    return;
}
void conditional_return(void)
{
    local_m4 = a1;
    if ((int32_t)a1 <= 0) {
        if ((int32_t)a1 >= 0) {
            local_mC = 0;
        } else {
            local_mC = 0 - (uint32_t)a1;
        }
        local_m8 = local_mC;
    } else {
        local_m8 = ((uint32_t)(uint32_t)a1 << 1);
    }
    return;
}
uint32 duffs_device(uint32 a1, int64 a2, int64 a3)
{
    uint64 var_8, var_18, var_20;
    uint32 var_10, var_14, var_2C;

    var_20 = a1;
    var_18 = a2;
    var_14 = (uint32)a3;
    __asm("b.gt #0x18d8");
    __asm("b #0x18cc");
    var_2C = 0xFFFFFFFF;
    __asm("b #0x1a74");
    var_10 = (uint32)((uint32)((uint32)var_14 + 7) / 8);
    x8_1 = var_14;
    x8_2 = (uint32)(x8_1 - (uint32)((uint32)(x8_1 / 8) * 8));
    var_8 = x8_2;
    __asm("b.hi #0x1a68");
    x8_2 = var_8;
    __asm("br x8");
    __asm("b #0x192c");
    var_18 = x8_3 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1950");
    var_18 = x8_4 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1974");
    var_18 = x8_5 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1998");
    var_18 = x8_6 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x19bc");
    var_18 = x8_7 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x19e0");
    var_18 = x8_8 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1a04");
    var_18 = x8_9 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1a28");
    var_18 = x8_10 + 4;
    var_20 = var_20 + 4;
    *(uint32 *)(var_20) = (uint32)*(uint32 *)(var_18);
    __asm("b #0x1a4c");
    var_10 = (uint32)((uint32)var_10 - 1);
    __asm("b.gt #0x192c");
    __asm("b #0x1a64");
    __asm("b #0x1a68");
    var_2C = (uint32)var_14;
    __asm("b #0x1a74");
    return (uint32)var_2C;
}
void loop_complex_cond(void)
{
    local_m4 = a1;
    local_m8 = 0;
    local_mC = (uint32_t)a1;
    local_m10 = 0;
    local_m14 = 0;
    local_m14 = 0;
    if ((int32_t)var_18 < (int32_t)var_14) {
        local_m14 = 0;
        if ((int32_t)var_10 < 10) {
            local_m14 = (int32_t)local_mC > 0 ? 1 : 0;
        }
    }
    if (!(bit_extract(var_C, 0, 1) == 0)) {
        local_m8 = local_m8 + 2;
        local_mC = local_mC - 1;
        local_m10 = local_m10 + 1;
        goto loc_1A9C;
    }
    return;
}
void loop_modify_var(void)
{
    local_m4 = a1;
    local_m8 = 0;
    local_mC = 0;
    while ((int32_t)var_4 < (int32_t)var_C) {
        local_m8 = local_m8 + local_mC;
        if ((int32_t)var_4 > 5) {
            local_mC = local_mC + 2;
        }
        local_mC = local_mC + 1;
        continue;
    }
    return;
}
void loop_external_state(void)
{
    local_m8 = a1;
    local_mC = 0;
    if (!(memory_unknown != 0)) {
        local_mC++;
        if ((int32_t)var_4 <= 0x64) {
            goto loc_1BBC;
        } else {
        }
    }
    return;
}
void recursion_factorial(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    if ((int32_t)var_8 > 1) {
        local_m1C = local_m18;
        recursion_factorial(/* arguments unknown */);
        local_m14 = local_m1C * (uint32_t)call_213;
    } else {
        local_m14 = 1;
    }
    return;
}
void tail_recursion(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    if ((int32_t)var_8 > 1) {
        tail_recursion(/* arguments unknown */);
        local_m14 = call_179;
    } else {
        local_m14 = local_m1C;
    }
    return;
}
void indirect_recursion_a(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    if ((int32_t)var_p4 > 0) {
        if (var_8 - ((var_8 / 2) * 2) != 0) {
            indirect_recursion_b(/* arguments unknown */);
            local_m14 = call_390;
        } else {
            indirect_recursion_b(/* arguments unknown */);
            local_m14 = call_302;
        }
    } else {
        local_m14 = local_m18;
    }
    return;
}
void indirect_recursion_b(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    if ((int32_t)var_p4 > 0) {
        indirect_recursion_a(/* arguments unknown */);
        local_m14 = call_171;
    } else {
        local_m14 = local_m18;
    }
    return;
}
void call_func_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call(var_4);
    return;
}
void call_func_ptr_array(void)
{
    uint64 load_25;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    load_25 = global_13D30;
    local_m40 = load_25;
    local_m30 = global_13D40;
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if ((int32_t)var_m18 < 3) {
            unknown_call(var_m1C);
            local_m14 = call_163;
        } else {
            goto loc_1E2C;
        }
    }
    return;
}
void double_value(void)
{
    local_m4 = a1;
    return;
}
void triple_value(void)
{
    local_m4 = a1;
    return;
}
void call_virtual_func(void)
{
    local_m8 = a1;
    local_mC = a2;
    return;
}
void process_with_callback(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m28 = a3;
    local_m2C = 0;
    local_m30 = 0;
    while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
        unknown_call(memory_unknown[sext(memory_unknown)]);
        memory_unknown = memory_unknown + (uint32_t)call_129;
        memory_unknown = memory_unknown + 1;
        continue;
    }
    return;
}
void test_control_flow_l2(void)
{
    uint64 load_455;
    uint64 load_691;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试高级控制流特征 ===\\n");
    loop_multi_exit(/* arguments unknown */);
    unknown_call("CF-L2-01 (loop_multi_exit): %d\\n");
    local_m9C = 0;
    local_m14 = 0;
    infinite_loop(/* arguments unknown */);
    unknown_call("CF-L2-02 (infinite_loop): %d\\n");
    local_mB4 = 0xFFFFFFFB;
    multi_return(/* arguments unknown */);
    local_mC0 = 0x2E2D;
    unknown_call(0x2E2D);
    multi_return(/* arguments unknown */);
    unknown_call(var_mC0);
    local_mA4 = 3;
    multi_return(/* arguments unknown */);
    unknown_call(var_mC0);
    local_m8C = 5;
    conditional_return(/* arguments unknown */);
    local_mB0 = 0x2E4A;
    unknown_call(0x2E4A);
    conditional_return(/* arguments unknown */);
    unknown_call(var_mB0);
    local_m40 = global_3120;
    local_m30 = global_3130;
    local_m60 = var_505;
    local_m50 = var_505;
    duffs_device(/* arguments unknown */);
    unknown_call("CF-L2-05 (duffs_device): %d\\n");
    local_mA0 = 10;
    loop_complex_cond(/* arguments unknown */);
    unknown_call("CF-L2-06 (loop_complex_cond): %d\\n");
    loop_modify_var(/* arguments unknown */);
    unknown_call("CF-L2-07 (loop_modify_var): %d\\n");
    local_m64 = 0;
    loop_external_state(/* arguments unknown */);
    unknown_call("CF-L2-08 (loop_external_state): %d\\n");
    recursion_factorial(/* arguments unknown */);
    unknown_call("CF-L2-09 (recursion_factorial): %d\\n");
    tail_recursion(/* arguments unknown */);
    unknown_call("CF-L2-10 (tail_recursion): %d\\n");
    indirect_recursion_a(/* arguments unknown */);
    unknown_call("CF-L2-11 (indirect_recursion): %d\\n");
    local_m88 = 0x1E64;
    call_func_ptr(/* arguments unknown */);
    unknown_call("CF-L2-12 (call_func_ptr): %d\\n");
    call_func_ptr_array(/* arguments unknown */);
    local_m98 = 0x2F74;
    unknown_call(0x2F74);
    call_func_ptr_array(/* arguments unknown */);
    unknown_call(var_m98);
    load_455 = var_m88;
    load_691 = global_2B48;
    local_m80 = load_691;
    local_m70 = global_2B58;
    process_with_callback(/* arguments unknown */);
    unknown_call("CF-L2-15 (process_with_callback): %d\\n");
    return;
}
void non_local_jump(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(0x14058);
    if (call_350 != 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if ((int32_t)var_8 < 0) {
            unknown_call(0x14058);
        }
        if ((int32_t)memory_unknown > 0x64) {
            unknown_call(0x14058);
        }
        memory_unknown = ((uint32_t)memory_unknown << 1);
    }
    return;
}
void cpp_exception(void)
{
    local_m8 = a1;
    if ((int32_t)a1 >= 0) {
        if ((int32_t)a1 <= 0x64) {
            local_m4 = ((uint32_t)(uint32_t)a1 << 1);
        } else {
            local_m4 = 0xFFFFFFFE;
        }
    } else {
        local_m4 = 0xFFFFFFFF;
    }
    return;
}
void large_jump_table(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m20 = a3;
    unknown_call(sp - 0x70);
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if ((int32_t)var_m18 < 10) {
            unknown_call(var_m1C);
            local_m14 = call_225;
        } else {
            goto loc_22BC;
        }
    }
    return;
}
void op_add(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_sub(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_mul(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_div(void)
{
    int32 var_4;
    local_m4 = a1;
    local_m8 = a2;
    if (a2 == 0) {
        var_4 = 0;
    } else {
        var_4 = (int32_t)((uint32_t)a2 == 0 ? 0 : (uint32_t)a1 / (uint32_t)a2);
    }
    return;
}
void op_mod(void)
{
    local_m4 = a1;
    local_m8 = a2;
    if (a2 == 0) {
        local_mC = 0;
    } else {
        local_mC = (uint32_t)a1 - (int32_t)((uint32_t)a2 == 0 ? 0 : (uint32_t)a1 / (uint32_t)a2) * (uint32_t)a2;
    }
    return;
}
void op_and(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_or(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_xor(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_shl(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void op_shr(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void conditional_func_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m18 = a2;
    if (var_m14 != 0) {
        if ((uint32_t)var_m14 != 1) {
            local_m20 = 0x1BFC;
        } else {
            local_m20 = 0x1E7C;
        }
    } else {
        local_m20 = 0x1E64;
    }
    unknown_call(var_8);
    return;
}
uint32 state_machine(uint32 a1, int64 a2)
{
    uint64 var_8;
    uint32 var_14, var_18, var_1C;

    var_18 = x8_2;
    var_14 = x8_1;
    var_8 = var_14;
    __asm("b.hi #0x25d4");
    x8_1 = var_8;
    __asm("br x8");
    x8_2 = var_18;
    __asm("b.ne #0x255c");
    __asm("b #0x2550");
    var_1C = 1;
    __asm("b #0x25e0");
    var_1C = 0;
    __asm("b #0x25e0");
    __asm("b.ne #0x2580");
    __asm("b #0x2574");
    var_1C = 2;
    __asm("b #0x25e0");
    __asm("b.ne #0x259c");
    __asm("b #0x2590");
    var_1C = 3;
    __asm("b #0x25e0");
    var_1C = 1;
    __asm("b #0x25e0");
    var_1C = 2;
    __asm("b #0x25e0");
    __asm("cbnz w8, #0x25c8");
    __asm("b #0x25c0");
    var_1C = 0;
    __asm("b #0x25e0");
    var_1C = 3;
    __asm("b #0x25e0");
    var_1C = 3;
    __asm("b #0x25e0");
    return (uint32)var_1C;
}
void fsm_func_table(void)
{
    uint64 load_22;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m40 = global_13D98;
    load_22 = global_13DA8;
    local_m30 = load_22;
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m14 = 3;
    } else {
        if ((int32_t)var_m1C < 4) {
            unknown_call(var_m18);
            local_m14 = call_166;
        } else {
            goto loc_2634;
        }
    }
    return;
}
void state_idle(void)
{
    local_m4 = a1;
    return;
}
void state_processing(void)
{
    local_m8 = a1;
    if ((uint32_t)a1 != 2) {
        if ((uint32_t)a1 != 99) {
            local_m4 = 1;
        } else {
            local_m4 = 3;
        }
    } else {
        local_m4 = 2;
    }
    return;
}
void state_done(void)
{
    local_m4 = a1;
    return;
}
void state_error(void)
{
    local_m4 = a1;
    return;
}
uint32 computed_goto(uint32 a1, int64 a2)
{
    uint64 var_8, var_40;
    vector128 var_10, var_20;
    uint32 var_3C, var_4C;

    var_40 = a1;
    var_3C = (uint32)a2;
    x8 = 0x13DB8;
    var_10 = *(uint128 *)0x13DB8;
    var_20 = *(uint128 *)0x13DC8;
    __asm("tbnz w8, #0x1f, #0x275c");
    __asm("b #0x274c");
    __asm("b.le #0x2768");
    __asm("b #0x275c");
    var_4C = 0xFFFFFFFF;
    __asm("b #0x27a8");
    var_8 = *(uint64 *)(&var_10 + var_3C * 8);
    __asm("b #0x27b4");
    var_4C = 0;
    __asm("b #0x27a8");
    var_4C = 10;
    __asm("b #0x27a8");
    var_4C = 20;
    __asm("b #0x27a8");
    var_4C = 30;
    __asm("b #0x27a8");
    return (uint32)var_4C;
    __asm("br x8");
}
void obfuscated_cf(void)
{
    local_m4 = a1;
    local_m8 = (uint32_t)a1;
    if ((int32_t)(a1 * a1) + 1 < 0) {
        local_m8 = ((uint32_t)(uint32_t)a1 << 1) + 1;
    }
    local_m8 = ((uint32_t)local_m8 << 1);
    return;
}
void opaque_predicate(void)
{
    local_m8 = a1;
    local_mC = ((uint32_t)a1 * bit_insert(0x5678, 0x1234, 16, 16) & 0xFFFFFFFF) - (uint32_t)((uint32_t)a1 * bit_insert(0x5678, 0x1234, 16, 16) & 0xFFFFFFFF) / 2 * 2;
    if (((a1 * (bit_insert(0x5678, 0x1234, 16, 16))) & 0xFFFFFFFF) - ((((a1 * (bit_insert(0x5678, 0x1234, 16, 16))) & 0xFFFFFFFF) / 2) * 2) != 0) {
        local_m4 = (uint32_t)a1 * 3;
    } else {
        local_m4 = ((uint32_t)(uint32_t)a1 << 1);
    }
    return;
}
void overlapped_code(void)
{
    int32 var_C;
    local_m8 = a1;
    if (bit_extract(a1, 0, 1) == 0) {
        local_m4 = (int32_t)(uint32_t)a1 / 2;
    } else {
        local_m4 = (uint32_t)a1 * 3 + 1;
    }
    return;
}
void test_control_flow_l3(void)
{
    uint32 load_160;
    uint64 load_64;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试极端控制流特征 ===\\n");
    local_m24 = 5;
    non_local_jump(/* arguments unknown */);
    local_m48 = 0x2FE3;
    unknown_call(0x2FE3);
    local_m3C = 0xFFFFFFFB;
    non_local_jump(/* arguments unknown */);
    unknown_call(var_m48);
    cpp_exception(/* arguments unknown */);
    local_m38 = 0x3002;
    unknown_call(0x3002);
    cpp_exception(/* arguments unknown */);
    unknown_call(var_m38);
    load_160 = var_m24;
    local_m30 = 0;
    large_jump_table(/* arguments unknown */);
    unknown_call("CF-L3-03 (large_jump_table): %d\\n");
    conditional_func_ptr(/* arguments unknown */);
    unknown_call("CF-L3-04 (conditional_func_ptr): %d\\n");
    local_m2C = 1;
    state_machine(/* arguments unknown */);
    unknown_call("CF-L3-05 (state_machine): %d\\n");
    local_m28 = 2;
    fsm_func_table(/* arguments unknown */);
    unknown_call("CF-L3-06 (fsm_func_table): %d\\n");
    load_64 = global_3140;
    local_m20 = load_64;
    computed_goto(/* arguments unknown */);
    unknown_call("CF-L3-07 (computed_goto): %d\\n");
    obfuscated_cf(/* arguments unknown */);
    unknown_call("CF-L3-08 (obfuscated_cf): %d\\n");
    opaque_predicate(/* arguments unknown */);
    unknown_call("CF-L3-09 (opaque_predicate): %d\\n");
    overlapped_code(/* arguments unknown */);
    unknown_call("CF-L3-10 (overlapped_code): %d\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
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
