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
    uint64 load_12;
    uint64 load_22;
    load_12 = var_0;
    load_22 = global_12FD0;
    unknown_call(load_22);
    unknown_call(load_22);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FC8;
    __asm("cbz x0, #0xa84");
    return sub_9B0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x130B0 != 0x130B0) {
        if (!(global_12FB8 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_51;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_51 = global_12FE0;
        if (!(load_51 == 0)) {
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
    if (!(global_130B0 != 0)) {
        if (!(global_12FC0 == 0)) {
            unknown_call(global_13098);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void local_vars(void)
{
    return;
}
void local_array(void)
{
    return;
}
void local_struct(void)
{
    return;
}
void address_of_local(void)
{
    a1->field_0 = 42;
    return;
}
void address_of_array(void)
{
    return;
}
void large_stack_frame(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    memory_unknown = local_phi_171;
    memory_unknown = local_phi_171;
    while ((uint64_t)(phi(x8, 0)) + 32 != 0x800) {
    }
    return;
}
void vla_stack(void)
{
    loc_BDC:
        if (__arm64_nzcv_add_hs_32((uint32_t)a1 - 0x3E9, (uint32_t)0x3E8)) goto loc_BF0;
        goto loc_BE8;
    loc_BE8:
        return;
    loc_BF0:
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        if ((uint32_t)a1 >= 8) goto loc_C28;
        goto loc_C20;
    loc_C20:
        goto loc_C64;
    loc_C28:
    loc_C40:
        memory_unknown = var_251;
        memory_unknown = var_251;
        if ((uint64_t)phi(a1 & 0xFFFFFFF8, v139 - 8) != 8) goto loc_C40;
        goto loc_C5C;
    loc_C5C:
        if ((uint64_t)a1 & 0xFFFFFFF8 == (uint64_t)a1) goto loc_C80;
        goto loc_C64;
    loc_C64:
    loc_C70:
        memory_unknown = local_phi_370;
        if ((uint64_t)phi(a1 - (phi(a1 & 0xFFFFFFF8, 0)), v21 - 1) != 1) goto loc_C70;
        goto loc_C80;
    loc_C80:
        return;
}
void alloca_usage(void)
{
    loc_CA0:
        if ((int32_t)a1 < 1) goto loc_CDC;
        goto loc_CA8;
    loc_CA8:
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        if ((uint32_t)a1 >= 8) goto loc_CE4;
        goto loc_CD4;
    loc_CD4:
        goto loc_D28;
    loc_CDC:
        return;
    loc_CE4:
    loc_D04:
        memory_unknown = var_213;
        memory_unknown = var_213;
        if ((uint64_t)phi(v222 - 8, a1 & 0xFFFFFFF8) != 8) goto loc_D04;
        goto loc_D20;
    loc_D20:
        if ((uint64_t)a1 & 0xFFFFFFF8 == (uint64_t)a1) goto loc_D44;
        goto loc_D28;
    loc_D28:
    loc_D34:
        memory_unknown = local_phi_427;
        if ((uint64_t)phi(v227 - 1, a1 - (phi(a1 & 0xFFFFFFF8, 0))) != 1) goto loc_D34;
        goto loc_D44;
    loc_D44:
        return;
}
void stack_alias(void)
{
    return;
}
void test_stack_memory(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x28;
    unknown_call("=== 测试栈内存操作 ===");
    unknown_call("MEM-L1-01 (local_vars): %d\\n");
    unknown_call("MEM-L1-02 (local_array): %d\\n");
    unknown_call("MEM-L1-03 (local_struct): %d\\n");
    unknown_call("MEM-L1-04 (address_of_local): %d\\n");
    unknown_call("MEM-L1-05 (address_of_array): %d\\n");
    memory_unknown = local_phi_413;
    memory_unknown = local_phi_413;
    while ((uint64_t)(phi(x8, 0)) + 32 != 0x800) {
    }
    unknown_call("MEM-L2-01 (large_stack_frame): %d\\n");
    unknown_call("MEM-L2-02 (vla_stack): %d\\n");
    unknown_call("MEM-L2-03 (alloca_usage): %d\\n");
}
void heap_basic(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(x0);
    if (call_366 == 0) {
    } else {
        if ((int32_t)a1 >= 1) {
            if ((uint32_t)a1 >= 8) {
                memory_unknown = var_32;
                memory_unknown = var_32;
                while ((uint64_t)phi(a1 & 0xFFFFFFF8, v251 - 8) != 8) {
                }
                if ((uint64_t)a1 & 0xFFFFFFF8 != (uint64_t)a1) {
                    memory_unknown = local_phi_368;
                    while ((uint64_t)phi(v245 - 1, a1 - (phi(0, a1 & 0xFFFFFFF8))) != 1) {
                    }
                }
            } else {
                goto loc_ED0;
            }
        }
        unknown_call(call_366);
    }
    return;
}
void heap_calloc(void)
{
    uint64 load_111;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(sext(a1));
    if (call_442 == 0) {
    } else {
        if ((int32_t)a1 < 1) {
        } else {
            if ((uint32_t)a1 != 1) {
                if ((uint64_t)a1 - 1 >= 8) {
                    load_111 = memory_unknown;
                    while ((uint64_t)phi((a1 - 1) & 0xFFFFFFFFFFFFFFF8, v261 - 8) != 8) {
                    }
                    if ((uint64_t)a1 - 1 != (uint64_t)(a1 - 1) & 0xFFFFFFFFFFFFFFF8) {
                        while ((uint64_t)phi(v142 - 1, a1 - (phi(1, ((a1 - 1) & 0xFFFFFFFFFFFFFFF8) | 1))) != 1) {
                        }
                    }
                } else {
                    goto loc_FB0;
                }
            } else {
                goto loc_F40;
            }
        }
        unknown_call(call_442);
    }
    return;
}
void heap_realloc(void)
{
    uint64 load_18;
    uint32 load_147;
    uint64 load_124;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(20);
    if (call_221 == 0) {
    } else {
        load_124 = global_1C50;
        memory_unknown = load_124;
        memory_unknown = 5;
        unknown_call(call_221);
        if (call_321 == 0) {
        } else {
            load_147 = memory_unknown;
            load_18 = global_1C60;
            memory_unknown = 90;
            memory_unknown = load_18;
        }
        unknown_call(phi(call_321, call_211));
    }
    return;
}
void heap_array(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(x0);
    if (call_314 == 0) {
    } else {
        if ((int32_t)a1 >= 1) {
            if ((uint32_t)a1 >= 8) {
                memory_unknown = var_146;
                memory_unknown = var_146;
                while ((uint64_t)phi(v185 - 8, a1 & 0xFFFFFFF8) != 8) {
                }
                if ((uint64_t)a1 & 0xFFFFFFF8 != (uint64_t)a1) {
                    memory_unknown = local_phi_394;
                    while ((uint64_t)phi(a1 - (phi(a1 & 0xFFFFFFF8, 0)), v2 - 1) != 1) {
                    }
                }
            } else {
                goto loc_10F0;
            }
        }
        unknown_call(call_314);
    }
    return;
}
void heap_struct(void)
{
    return;
}
void heap_nested(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(16);
    memory_unknown = call_59;
    if (call_147 == 0) {
    } else {
        memory_unknown = 10;
        unknown_call(16);
        memory_unknown = call_185;
        if (call_161 == 0) {
            unknown_call(call_147);
        } else {
            memory_unknown = 0;
            memory_unknown = 20;
        }
    }
    return;
}
void linked_list_heap(void)
{
    uint64 load_143;
    uint64 load_181;
    uint64 load_142;
    uint64 load_52;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(16);
    if (call_592 == 0) {
    } else {
        memory_unknown = 0;
        unknown_call(16);
        if (call_514 == 0) {
            unknown_call(call_592);
            goto loc_12CC;
        } else {
            memory_unknown = 0;
            memory_unknown = call_492;
            memory_unknown = 10;
            unknown_call(16);
            if (call_397 == 0) {
                load_52 = memory_unknown;
                unknown_call(phi(call_335, load_52));
                while (load_52 != 0) {
                }
                goto loc_12CC;
            } else {
                memory_unknown = 0;
                memory_unknown = call_393;
                memory_unknown = 20;
                unknown_call(16);
                if (call_609 == 0) {
                    load_142 = memory_unknown;
                    unknown_call(phi(call_443, load_142));
                    while (load_142 != 0) {
                    }
                    goto loc_12CC;
                } else {
                    memory_unknown = 0;
                    memory_unknown = call_232;
                    memory_unknown = 30;
                    unknown_call(16);
                    if (call_417 == 0) {
                        load_143 = memory_unknown;
                        unknown_call(phi(call_446, load_143));
                        while (load_143 != 0) {
                        }
                        goto loc_12CC;
                    } else {
                        memory_unknown = 0;
                        memory_unknown = call_182;
                        memory_unknown = 40;
                        while (memory_unknown != 0) {
                        }
                        load_181 = memory_unknown;
                        unknown_call(phi(call_446, load_181));
                        while (load_181 != 0) {
                        }
                    }
                }
            }
        }
    }
    return;
}
void create_tree_node(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(24);
    if (!(call_90 == 0)) {
        memory_unknown = (uint32_t)a1;
        memory_unknown = 0;
        memory_unknown = 0;
    }
    return;
}
void tree_heap_traversal(void)
{
    return;
}
void memory_leak(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(x0);
    if (call_337 == 0) {
    } else {
        if ((int32_t)a1 >= 1) {
            if ((uint32_t)a1 >= 8) {
                memory_unknown = local_phi_272;
                memory_unknown = local_phi_272;
                while ((uint64_t)phi(a1 & 0xFFFFFFF8, v223 - 8) != 8) {
                }
                if ((uint64_t)a1 & 0xFFFFFFF8 != (uint64_t)a1) {
                    call_93[local_phi_273] = local_phi_273;
                    while ((uint64_t)a1 != (uint64_t)x9 + 1) {
                    }
                }
            } else {
                goto loc_1398;
            }
        }
    }
    return;
}
void dangling_pointer(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(4);
    if (call_103 == 0) {
    } else {
        unknown_call("value before free: %d\\n");
        unknown_call(call_103);
    }
    return;
}
void double_free(void)
{
    if (a1 == 0) {
        return;
    } else {
        return;
    }
}
void heap_overflow(void)
{
    return;
}
uint32 test_heap_memory(void)
{
    uint32 var_C;

    x0_1 = sub_9D0("=== 测试堆内存操作 ===");
    x0_2 = sub_A00("HEAP-L2-01 (heap_basic): %d\\n", 10);
    x0_3 = sub_A00("HEAP-L2-02 (heap_calloc): %d\\n", 0);
    x0_4 = sub_970(20);
    __asm("cbz x0, #0x14c8");
    *(vector128 *)(x0_4) = *(uint128 *)0x1C50;
    *(uint32 *)(x0_4 + 0x10) = 5;
    x0_5 = sub_9A0(x0_4, 40);
    __asm("cbz x0, #0x14d0");
    /* cmp (int32)((uint32)*(uint32 *)(x0_5 + 8)), 3 — 次の分岐のための比較 */
    *(uint32 *)(x0_5 + 0x24) = 90;
    x20 = (uint32)((uint32)*(uint32 *)(x0_5 + 8) == 3 ? 50 : 0xFFFFFFFD);
    *(vector128 *)(x0_5 + 0x14) = *(uint128 *)0x1C60;
    __asm("b #0x14d4");
    x20 = 0xFFFFFFFF;
    __asm("b #0x14dc");
    x20 = 0xFFFFFFFE;
    x0_6 = sub_9F0(x19);
    x0_7 = sub_A00("HEAP-L2-03 (heap_realloc): %d\\n", (uint32)x20);
    x0_8 = sub_A00("HEAP-L2-04 (heap_array): %d\\n", 15);
    x0_9 = sub_A00("HEAP-L2-05 (heap_struct): %d\\n", 15);
    x0_10 = sub_970(16);
    __asm("cbz x0, #0x1548");
    *(uint32 *)(x0_10) = 10;
    x0_11 = sub_970(16);
    *(uint64 *)(x0_10 + 8) = x0_11;
    __asm("cbz x0, #0x155c");
    x1_1 = 0;
    *(uint64 *)(x0_11 + 8) = 0;
    *(uint32 *)(x0_11) = 20;
    __asm("b #0x1568");
    x0_12 = sub_A00("HEAP-L2-06 (heap_nested): %d\\n", 0xFFFFFFFF);
    __asm("b #0x1584");
    x0_14 = sub_9F0(x19);
    x1_2 = 0xFFFFFFFE;
    x0_15 = sub_A00("HEAP-L2-06 (heap_nested): %d\\n");
    x0_16 = sub_9F0(*(uint64 *)(x19 + 8));
    x0_17 = sub_9F0(x19);
    x0_18 = linked_list_heap();
    x0_19 = sub_A00("HEAP-L3-01 (linked_list_heap): %d\\n", (uint32)x0_18);
    x0_20 = sub_A00("HEAP-L3-02 (tree_heap_traversal): %d\\n", 60);
    x0_21 = sub_A00("HEAP-L3-03 (memory_leak): %d\\n", 2);
    x0_22 = sub_A00("HEAP-L3-04 (dangling_pointer): ");
    x0_23 = sub_960(x0_22);
    __asm("cbz w0, #0x1644");
    /* cmp (int32)(x0_23), 1 — 次の分岐のための比較 */
    __asm("b.lt #0x162c");
    x0_24 = sub_A10(x0_23, &var_C, 0);
    x1_3 = (uint32)(var_C & 127);
    __asm("b.eq #0x160c");
    /* cmp (int32)((uint32)((x1_3 << 24) + 0x1000000)), (int32)(0x2000000) — 次の分岐のための比較 */
    __asm("b.lt #0x161c");
    x0_25 = "✗ 子进程被信号终止 (信号%d) - 野指针导致崩溃\\n";
    __asm("b #0x1618");
    x1_4 = (uint32)((uint32)x8 >> 8 & 255);
    x0_26 = "✓ 子进程正常退出，code=%d\\n";
    x0_27 = sub_A00();
    return x0;
    return sub_940("fork失败");
    x0_29 = dangling_pointer();
    x0_30 = sub_A00("%d (子进程)\\n", (uint32)x0_29);
    x0_31 = sub_920(0);
}
void global_var_access(void)
{
    global_130B8++;
    return;
}
void global_var_read(void)
{
    return;
}
void global_array_access(void)
{
    if ((uint32_t)a1 <= 9) {
        return;
    } else {
        return;
    }
}
void static_local(void)
{
    global_130BC = (uint32_t)a1 != 0 ? 0 : global_130BC + 1;
    return;
}
void call_static_func(void)
{
    return;
}
void access_extern_global(void)
{
    return;
}
void call_extern_func(void)
{
}
void read_const_data(void)
{
    return;
}
void access_bss_var(void)
{
    return;
}
void access_bss_buffer(void)
{
    return;
}
void global_struct_access(void)
{
    return;
}
void set_file_static(void)
{
    global_130A8 = a1;
    return;
}
void get_file_static(void)
{
    return;
}
void set_global_callback(void)
{
    global_130C0 = a1;
    return;
}
void call_global_callback(void)
{
    uint64 load_13;
    load_13 = global_130C0;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (load_13 == 0) {
        return;
    } else {
        __asm("br x1");
    }
}
void global_heap_store(void)
{
    global_130C8 = a1;
    if (a1 == 0) {
        return;
    } else {
        return;
    }
}
void static_complex_init(void)
{
    return;
}
void tls_access(void)
{
    return;
}
void init_order_test(void)
{
    return;
}
void test_static_global(void)
{
    uint32 load_71;
    uint32 load_257;
    uint32 load_268;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call("=== 测试静态与全局内存 ===");
    load_257 = global_130B8;
    global_130B8 = load_257 + 1;
    unknown_call("STM-L1-01 (global_var_access): %d\\n");
    unknown_call("STM-L1-01 (global_var_read): %d\\n");
    unknown_call("STM-L1-02 (global_array_access): %d\\n");
    global_130BC = 1;
    unknown_call(0x1FBF);
    load_268 = global_130BC;
    global_130BC = load_268 + 1;
    unknown_call(0x1FBF);
    unknown_call("STM-L1-04 (call_static_func): %d\\n");
    load_71 = memory_unknown;
    unknown_call("STM-L2-01 (access_extern_global): %d\\n");
    extern_function(/* arguments unknown */);
    unknown_call("STM-L2-02 (call_extern_func): %d\\n");
    unknown_call("STM-L2-03 (read_const_data): %d\\n");
    unknown_call("STM-L2-04 (access_bss_var): %d\\n");
    unknown_call("STM-L2-04 (access_bss_buffer): %d\\n");
    unknown_call("STM-L2-05 (global_struct_access): %d\\n");
    global_130A8 = 50;
    unknown_call("STM-L2-06 (file_static): %d\\n");
    global_130C0 = 0x1944;
    unknown_call("STM-L2-07 (global_func_ptr): %d\\n");
    local_m24 = 0x64;
    global_130C8 = var_531 - 48 + 16 - 4;
    unknown_call("STM-L2-08 (global_heap_store): %d\\n");
    unknown_call("STM-L2-09 (static_complex_init): %d\\n");
    unknown_call("STM-L3-01 (tls_access): %d\\n");
    unknown_call("STM-L3-02 (init_order_test): %d\\n");
    return;
}
void double_value(void)
{
    return;
}
void memop_memset(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    if (!(a1 == 0)) {
        if (!(a2 == 0)) {
            unknown_call(a1);
        }
    }
    return;
}
void memop_memcpy(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    if (!(a1 == 0)) {
        if (!(a2 == 0)) {
            if (!(a3 == 0)) {
                unknown_call(a1);
            }
        }
    }
    return;
}
void memop_memmove(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    if (!(a1 == 0)) {
        if ((uint64_t)a2 >= 2) {
            unknown_call(a1 + 1);
        }
    }
    return;
}
void memop_memcmp(void)
{
    if (!(a1 == 0)) {
        if (!(a2 == 0)) {
            if (!(a3 == 0)) {
                local_pFFFFFFFFFFFFFFF0 = local_x29;
                local_pFFFFFFFFFFFFFFF0 = local_x29;
                unknown_call(a1);
            }
        }
    }
    return;
}
void memop_bzero(void)
{
    if (a1 == 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a1);
        return;
    }
}
void memop_bcopy(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    if (!(a1 == 0)) {
        if (!(a2 == 0)) {
            if (!(a3 == 0)) {
                unknown_call(a2);
            }
        }
    }
    return;
}
void memop_unaligned_access(void)
{
    if (a1 == 0) {
        return;
    } else {
        return;
    }
}
void memop_memory_barrier(void)
{
    uint32 load_30;
    if (a1 == 0) {
        return;
    } else {
        load_30 = a1->field_0;
        __asm("dmb ish");
        return;
    }
}
uint64 test_memory_op_functions(void)
{
    uint32 var_C;
    uint64 var_10, var_11;
    uint16 var_18;
    uint8 var_19;

    x0_1 = sub_9D0("=== 测试内存操作函数 ===");
    x0_2 = sub_A00("MEMOP-L2-01: %d\\n", 65);
    x0_3 = sub_A00("MEMOP-L2-02: %d\\n", 50);
    x8 = *(uint64 *)("HelloWorld");
    var_18 = 0x646C;
    var_19 = 108;
    var_10 = x8;
    var_11 = x8;
    x0_4 = sub_A00("MEMOP-L2-03: %c\\n", (uint32)((uint32)x8 & 255));
    x0_5 = sub_A00("MEMOP-L2-04: %d\\n", 0xFFFFFFFF);
    x0_6 = sub_A00("MEMOP-L2-05: %d\\n", 0);
    x0_7 = sub_A00("MEMOP-L2-06: %d\\n", 1);
    x0_8 = sub_A00("MEMOP-L3-01: 0x%x\\n", 0x4030201);
    var_C = 5;
    return sub_A00("MEMOP-L3-02: %d\\n", 10);
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_stack_memory(/* arguments unknown */);
    test_heap_memory(/* arguments unknown */);
    test_static_global(/* arguments unknown */);
    test_memory_op_functions(/* arguments unknown */);
    return;
}
void extern_function(void)
{
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
