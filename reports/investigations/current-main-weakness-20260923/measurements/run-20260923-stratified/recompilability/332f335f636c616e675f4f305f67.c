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
    uint64 load_37;
    uint64 load_18;
    load_37 = var_0;
    load_18 = global_13FD0;
    unknown_call(load_18);
    unknown_call(load_18);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FC8;
    __asm("cbz x0, #0xac4");
    return sub_9F0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x140F8 != 0x140F8) {
        if (!(global_13FB8 == 0)) {
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
    if (!(global_140F8 != 0)) {
        if (!(global_13FC0 == 0)) {
            unknown_call(global_14098);
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
    local_m4 = a1;
    local_m8 = (uint32_t)a1;
    local_mC = ((uint32_t)(uint32_t)a1 << 1);
    local_m10 = ((uint32_t)(uint32_t)a1 << 1) + 10;
    return;
}
void local_array(void)
{
    local_m4 = a1;
    local_m30 = 0;
    while ((int32_t)var_0 < 10) {
        (var_146 - 48 + 4)[(int64_t)local_m30] = local_m30 * local_m4;
        local_m30 = local_m30 + 1;
        continue;
    }
    return;
}
void local_struct(void)
{
    local_m4 = a1;
    local_mC = (uint32_t)a1;
    local_m8 = ((uint32_t)(uint32_t)a1 << 1);
    return;
}
void address_of_local(void)
{
    local_m8 = a1;
    local_mC = 42;
    a1->field_0 = local_mC;
    return;
}
void address_of_array(void)
{
    local_m8 = a1;
    local_m10 = a1;
    local_m18 = a1;
    return;
}
void large_stack_frame(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFF7EC = 0;
    while ((int32_t)var_C < 0x800) {
        (var_131 + 0xFFFFFFFFFFFFFFF0 - 0x810 + 16)[(int64_t)local_pFFFFFFFFFFFFF7EC] = local_pFFFFFFFFFFFFF7EC;
        local_pFFFFFFFFFFFFF7EC = local_pFFFFFFFFFFFFF7EC + 1;
        continue;
    }
    return;
}
void vla_stack(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFE8 = a1;
    if ((int32_t)var_FFFFFFFFFFFFFFE8 <= 0) {
        local_pFFFFFFFFFFFFFFEC = 0xFFFFFFFF;
    } else {
        if ((int32_t)var_FFFFFFFFFFFFFFE8 <= 0x3E8) {
            local_pFFFFFFFFFFFFFFE0 = var_297 + 0xFFFFFFFFFFFFFFF0 - 48;
            local_pFFFFFFFFFFFFFFC8 = var_297 + 0xFFFFFFFFFFFFFFF0 - 48 - (((uint64_t)local_pFFFFFFFFFFFFFFE8 << 2) + 15 & 0xFFFFFFFFFFFFFFF0);
            local_pFFFFFFFFFFFFFFD8 = local_pFFFFFFFFFFFFFFE8;
            local_pFFFFFFFFFFFFFFD4 = 0;
            while ((int32_t)var_FFFFFFFFFFFFFFD4 < (int32_t)var_FFFFFFFFFFFFFFE8) {
                local_pFFFFFFFFFFFFFFC8[(int64_t)local_pFFFFFFFFFFFFFFD4] = ((uint32_t)local_pFFFFFFFFFFFFFFD4 << 1);
                local_pFFFFFFFFFFFFFFD4 = local_pFFFFFFFFFFFFFFD4 + 1;
                continue;
            }
            local_pFFFFFFFFFFFFFFEC = local_pFFFFFFFFFFFFFFC8[local_x9];
        } else {
            goto loc_D30;
        }
    }
    return;
}
void alloca_usage(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFE8 = a1;
    if ((int32_t)var_FFFFFFFFFFFFFFE8 > 0) {
        local_pFFFFFFFFFFFFFFE0 = var_239 + 0xFFFFFFFFFFFFFFF0 - 32 - (((uint64_t)((uint64_t)(int64_t)local_pFFFFFFFFFFFFFFE8 << 2) >> 0) + 15 & 0xFFFFFFFFFFFFFFF0);
        local_pFFFFFFFFFFFFFFDC = 0;
        while ((int32_t)var_FFFFFFFFFFFFFFDC < (int32_t)var_FFFFFFFFFFFFFFE8) {
            local_pFFFFFFFFFFFFFFE0[(int64_t)local_pFFFFFFFFFFFFFFDC] = local_pFFFFFFFFFFFFFFDC * 3;
            local_pFFFFFFFFFFFFFFDC = local_pFFFFFFFFFFFFFFDC + 1;
            continue;
        }
        local_pFFFFFFFFFFFFFFEC = local_pFFFFFFFFFFFFFFE0[local_x9];
    } else {
        local_pFFFFFFFFFFFFFFEC = 0xFFFFFFFF;
    }
    return;
}
uint32 stack_alias(uint32 a1, int64 a2)
{
    uint32 var_4, var_1C;
    uint64 var_8, var_10;

    var_10 = a1;
    var_8 = a2;
    var_4 = 10;
    x9 = &var_4;
    var_10 = &var_4;
    var_8 = &var_4;
    x9 = var_10;
    x9 = var_8;
    __asm("b.ne #0xf04");
    __asm("b #0xedc");
    __asm("cbz x8, #0xf04");
    __asm("b #0xee8");
    *(uint32 *)(var_10) = 20;
    var_1C = (uint32)*(uint32 *)(var_8);
    __asm("b #0xf10");
    var_1C = 0xFFFFFFFF;
    __asm("b #0xf10");
    return (uint32)var_1C;
}
void test_stack_memory(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试栈内存操作 ===\\n");
    local_m54 = 5;
    local_vars(/* arguments unknown */);
    unknown_call("MEM-L1-01 (local_vars): %d\\n");
    local_m48 = 2;
    local_array(/* arguments unknown */);
    unknown_call("MEM-L1-02 (local_array): %d\\n");
    local_struct(/* arguments unknown */);
    unknown_call("MEM-L1-03 (local_struct): %d\\n");
    address_of_local(/* arguments unknown */);
    unknown_call("MEM-L1-04 (address_of_local): %d\\n");
    local_m50 = var_507 - 96 + 36;
    unknown_call((sp - 96) + 36);
    local_m3C = 1;
    local_m38 = local_m48;
    local_m34 = 3;
    address_of_array(/* arguments unknown */);
    unknown_call("MEM-L1-05 (address_of_array): %d\\n");
    large_stack_frame(/* arguments unknown */);
    unknown_call("MEM-L2-01 (large_stack_frame): %d\\n");
    local_m44 = 10;
    vla_stack(/* arguments unknown */);
    unknown_call("MEM-L2-02 (vla_stack): %d\\n");
    alloca_usage(/* arguments unknown */);
    unknown_call("MEM-L2-03 (alloca_usage): %d\\n");
    local_m40 = 0;
    stack_alias(/* arguments unknown */);
    unknown_call("MEM-L2-04 (stack_alias): %d\\n");
    return;
}
void heap_basic(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call((sext(var_m18)) << 2);
    local_m20 = call_82;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 < (int32_t)var_m18) {
            local_m20[(int64_t)local_m24] = ((uint32_t)local_m24 << 1);
            local_m24++;
            continue;
        }
        local_m28 = local_m20[call_82];
        unknown_call(var_m20);
        local_m14 = local_m28;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void heap_calloc(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(sext(var_m18));
    local_m20 = call_78;
    if (var_m20 != 0) {
        local_m24 = 0;
        local_m28 = 0;
        while ((int32_t)var_m28 < (int32_t)var_m18) {
            local_m24 += local_m20[(int64_t)local_m28];
            local_m28++;
            continue;
        }
        unknown_call(var_m20);
        local_m14 = local_m24;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void heap_realloc(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(20);
    local_m20 = call_74;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 < 5) {
            local_m20[(int64_t)local_m24] = local_m24 + 1;
            local_m24++;
            continue;
        }
        local_m28 = memory_unknown;
        unknown_call(var_m20);
        local_m30 = call_559;
        if (var_m30 != 0) {
            local_m20 = local_m30;
            local_m34 = 5;
            while ((int32_t)var_m34 < 10) {
                local_m20[(int64_t)local_m34] = local_m34 * 10;
                local_m34++;
                continue;
            }
            if ((uint32_t)memory_unknown != (uint32_t)var_m28) {
                local_m3C = 0xFFFFFFFD;
            } else {
                local_m3C = memory_unknown;
            }
            local_m38 = local_m3C;
            unknown_call(var_m20);
            local_m14 = local_m38;
        } else {
            unknown_call(var_m20);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void heap_array(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call((sext(var_m18)) << 2);
    local_m20 = call_82;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 < (int32_t)var_m18) {
            local_m20[(int64_t)local_m24] = local_m24 * 3;
            local_m24++;
            continue;
        }
        local_m28 = local_m20[call_82];
        unknown_call(var_m20);
        local_m14 = local_m28;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void heap_struct(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(8);
    local_m20 = call_58;
    if (var_m20 != 0) {
        memory_unknown = local_m18;
        memory_unknown = ((uint32_t)local_m18 << 1);
        local_m24 = memory_unknown + memory_unknown;
        unknown_call(var_m20);
        local_m14 = local_m24;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void heap_nested(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(16);
    memory_unknown = call_58;
    if (memory_unknown != 0) {
        memory_unknown = 10;
        unknown_call(16);
        memory_unknown = call_300;
        if (memory_unknown != 0) {
            memory_unknown = 20;
            memory_unknown = 0;
            local_m14 = 0;
        } else {
            unknown_call(memory_unknown);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void linked_list_heap(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = 0;
    local_m28 = 0;
    local_m2C = 0;
    if ((int32_t)memory_unknown >= 5) {
        memory_unknown = 0;
        memory_unknown = memory_unknown;
        while (!(memory_unknown == 0)) {
            memory_unknown = memory_unknown + memory_unknown;
            memory_unknown = memory_unknown;
            continue;
        }
        while (!(memory_unknown == 0)) {
            memory_unknown = memory_unknown;
            memory_unknown = memory_unknown;
            unknown_call(memory_unknown);
            continue;
        }
        memory_unknown = memory_unknown;
    } else {
        unknown_call(16);
        memory_unknown = call_670;
        if (memory_unknown != 0) {
            memory_unknown = memory_unknown * 10;
            memory_unknown = 0;
            if (memory_unknown != 0) {
                memory_unknown = memory_unknown;
                memory_unknown = memory_unknown;
            } else {
                memory_unknown = memory_unknown;
                memory_unknown = memory_unknown;
            }
            memory_unknown = memory_unknown + 1;
            goto loc_153C;
        } else {
            while (!(memory_unknown == 0)) {
                memory_unknown = memory_unknown;
                memory_unknown = memory_unknown;
                unknown_call(memory_unknown);
                continue;
            }
            memory_unknown = 0xFFFFFFFF;
        }
    }
    return;
}
void create_tree_node(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    unknown_call(24);
    local_m20 = call_53;
    if (!(var_m20 == 0)) {
        memory_unknown = local_m14;
        memory_unknown = 0;
        memory_unknown = 0;
    }
    return;
}
void tree_heap_traversal(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    create_tree_node(/* arguments unknown */);
    local_m20 = call_69;
    if (var_m20 != 0) {
        create_tree_node(/* arguments unknown */);
        memory_unknown = call_257;
        create_tree_node(/* arguments unknown */);
        memory_unknown = call_283;
        if (memory_unknown == 0) {
            if (!(memory_unknown == 0)) {
                unknown_call(memory_unknown);
            }
            if (!(memory_unknown == 0)) {
                unknown_call(memory_unknown);
            }
            unknown_call(phi(phi(call_484, call_565), call_523));
            memory_unknown = 0xFFFFFFFE;
        } else {
            if (memory_unknown != 0) {
                local_m24 = memory_unknown + memory_unknown + memory_unknown;
                unknown_call(memory_unknown);
                unknown_call(memory_unknown);
                unknown_call(var_m20);
                local_m14 = local_m24;
            } else {
                goto loc_175C;
            }
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void memory_leak(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call((sext(var_m18)) << 2);
    local_m20 = call_76;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 < (int32_t)var_m18) {
            local_m20[(int64_t)local_m24] = local_m24;
            local_m24++;
            continue;
        }
        local_m14 = local_m20[call_76];
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void dangling_pointer(void)
{
    uint32 load_132;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(4);
    local_m20 = call_51;
    if (var_m20 != 0) {
        memory_unknown = 42;
        local_m24 = memory_unknown;
        load_132 = var_m24;
        unknown_call("value before free: %d\\n");
        unknown_call(var_m20);
        local_m28 = memory_unknown;
        local_m14 = local_m28;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void double_free(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    if (var_10 != 0) {
        local_m14 = a1->field_0;
    } else {
        unknown_call(4);
        local_m28 = call_167;
        if (var_m28 != 0) {
            memory_unknown = 10;
            unknown_call(var_m28);
            unknown_call(var_m28);
            local_m14 = 0xFFFFFFFE;
        } else {
            local_m14 = 0xFFFFFFFF;
        }
    }
    return;
}
void heap_overflow(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(40);
    local_m20 = call_63;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 <= 10) {
            local_m20[(int64_t)local_m24] = local_m24 * 0x64;
            local_m24++;
            continue;
        }
        local_m28 = memory_unknown;
        unknown_call(var_m20);
        local_m14 = local_m28;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void test_heap_memory(void)
{
    uint32 load_345;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试堆内存操作 ===\\n");
    local_m2C = 10;
    heap_basic(/* arguments unknown */);
    unknown_call("HEAP-L2-01 (heap_basic): %d\\n");
    local_m28 = 5;
    heap_calloc(/* arguments unknown */);
    unknown_call("HEAP-L2-02 (heap_calloc): %d\\n");
    heap_realloc(/* arguments unknown */);
    unknown_call("HEAP-L2-03 (heap_realloc): %d\\n");
    heap_array(/* arguments unknown */);
    unknown_call("HEAP-L2-04 (heap_array): %d\\n");
    heap_struct(/* arguments unknown */);
    unknown_call("HEAP-L2-05 (heap_struct): %d\\n");
    local_m18 = 0;
    heap_nested(/* arguments unknown */);
    unknown_call("HEAP-L2-06 (heap_nested): %d\\n");
    if (!(var_m18 == 0)) {
        unknown_call(memory_unknown);
        unknown_call(var_m18);
    }
    linked_list_heap(/* arguments unknown */);
    unknown_call("HEAP-L3-01 (linked_list_heap): %d\\n");
    tree_heap_traversal(/* arguments unknown */);
    unknown_call("HEAP-L3-02 (tree_heap_traversal): %d\\n");
    memory_leak(/* arguments unknown */);
    unknown_call("HEAP-L3-03 (memory_leak): %d\\n");
    unknown_call("HEAP-L3-04 (dangling_pointer): ");
    unknown_call("HEAP-L3-04 (dangling_pointer): ");
    memory_unknown = call_840;
    if (!(memory_unknown != 0)) {
        dangling_pointer(/* arguments unknown */);
        memory_unknown = call_899;
        load_345 = memory_unknown;
        unknown_call("%d (子进程)\\n");
        unknown_call(0);
    }
    if ((int32_t)memory_unknown <= 0) {
        unknown_call("fork失败");
    } else {
        unknown_call(memory_unknown);
        if (memory_unknown & 0x7F != 0) {
            if ((int32_t)(sext((memory_unknown & 0x7F) + 1)) >> 1 > 0) {
                unknown_call("✗ 子进程被信号终止 (信号%d) - 野指针导致崩溃\\n");
            }
        } else {
            unknown_call("✓ 子进程正常退出，code=%d\\n");
        }
    }
    return;
}
void global_var_access(void)
{
    global_14100++;
    return;
}
void global_var_read(void)
{
    return;
}
void global_array_access(void)
{
    local_m8 = a1;
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m4 = 0xFFFFFFFF;
    } else {
        if ((int32_t)a1 < 10) {
            local_m4 = 0x140A0[(int64_t)(uint32_t)a1];
        } else {
            goto loc_1CBC;
        }
    }
    return;
}
void static_local(void)
{
    local_m8 = a1;
    if (var_8 == 0) {
        global_14104++;
        local_m4 = global_14104;
    } else {
        global_14104 = 0;
        local_m4 = 0;
    }
    return;
}
void call_static_func(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    static_helper(/* arguments unknown */);
    return;
}
void static_helper(void)
{
    local_m4 = a1;
    return;
}
void access_extern_global(void)
{
    return;
}
void call_extern_func(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    extern_function(/* arguments unknown */);
    return;
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
    local_m4 = a1;
    global_140D8 = local_m4;
    return;
}
void get_file_static(void)
{
    return;
}
void set_global_callback(void)
{
    local_m8 = a1;
    global_14170 = local_m8;
    return;
}
void call_global_callback(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    if (global_14170 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        unknown_call(var_8);
        local_m14 = call_128;
    }
    return;
}
void global_heap_store(void)
{
    local_m10 = a1;
    global_14178 = local_m10;
    if (global_14178 == 0) {
        local_m4 = 0xFFFFFFFF;
    } else {
        local_m4 = memory_unknown;
    }
    return;
}
void static_complex_init(void)
{
    return;
}
void tls_access(void)
{
    uint32 load_56;
    local_m4 = a1;
    load_56 = var_C;
    memory_unknown = load_56;
    return;
}
void init_order_test(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 20;
    init_depends_on(/* arguments unknown */);
    return;
}
void init_depends_on(void)
{
    local_m8 = a1;
    if (!(var_8 == 0)) {
        global_14180 = a1->field_0;
    }
    return;
}
void test_static_global(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试静态与全局内存 ===\\n");
    global_var_access(/* arguments unknown */);
    unknown_call("STM-L1-01 (global_var_access): %d\\n");
    global_var_read(/* arguments unknown */);
    unknown_call("STM-L1-01 (global_var_read): %d\\n");
    local_m18 = 5;
    global_array_access(/* arguments unknown */);
    unknown_call("STM-L1-02 (global_array_access): %d\\n");
    static_local(/* arguments unknown */);
    local_m24 = 0;
    static_local(/* arguments unknown */);
    local_m20 = 0x2AD1;
    unknown_call(0x2AD1);
    static_local(/* arguments unknown */);
    unknown_call(var_m20);
    call_static_func(/* arguments unknown */);
    unknown_call("STM-L1-04 (call_static_func): %d\\n");
    access_extern_global(/* arguments unknown */);
    unknown_call("STM-L2-01 (access_extern_global): %d\\n");
    call_extern_func(/* arguments unknown */);
    unknown_call("STM-L2-02 (call_extern_func): %d\\n");
    read_const_data(/* arguments unknown */);
    unknown_call("STM-L2-03 (read_const_data): %d\\n");
    access_bss_var(/* arguments unknown */);
    unknown_call("STM-L2-04 (access_bss_var): %d\\n");
    access_bss_buffer(/* arguments unknown */);
    unknown_call("STM-L2-04 (access_bss_buffer): %d\\n");
    global_struct_access(/* arguments unknown */);
    unknown_call("STM-L2-05 (global_struct_access): %d\\n");
    set_file_static(/* arguments unknown */);
    get_file_static(/* arguments unknown */);
    unknown_call("STM-L2-06 (file_static): %d\\n");
    set_global_callback(/* arguments unknown */);
    call_global_callback(/* arguments unknown */);
    unknown_call("STM-L2-07 (global_func_ptr): %d\\n");
    local_m14 = 0x64;
    global_heap_store(/* arguments unknown */);
    unknown_call("STM-L2-08 (global_heap_store): %d\\n");
    static_complex_init(/* arguments unknown */);
    unknown_call("STM-L2-09 (static_complex_init): %d\\n");
    tls_access(/* arguments unknown */);
    unknown_call("STM-L3-01 (tls_access): %d\\n");
    init_order_test(/* arguments unknown */);
    unknown_call("STM-L3-02 (init_order_test): %d\\n");
    return;
}
void double_value(void)
{
    local_m4 = a1;
    return;
}
void memop_memset(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    local_m2C = a3;
    if (var_10 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if (var_8 != 0) {
            unknown_call(var_10);
            local_m14 = memory_unknown;
        } else {
            goto loc_219C;
        }
    }
    return;
}
void memop_memcpy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    local_m30 = a3;
    if (var_10 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if (var_8 == 0) {
            goto loc_2214;
        } else {
            if (var_0 != 0) {
                unknown_call(var_10);
                local_m14 = local_m20[(uint64_t)local_m30 / 4 - 1];
            } else {
                goto loc_2214;
            }
        }
    }
    return;
}
void memop_memmove(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    if (var_10 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if ((uint64_t)var_8 >= 2) {
            unknown_call(var_10 + 1);
            local_m14 = memory_unknown;
        } else {
            goto loc_2290;
        }
    }
    return;
}
void memop_memcmp(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    local_m30 = a3;
    if (var_m20 == 0) {
        local_m14 = 0;
    } else {
        if (var_18 == 0) {
            goto loc_2310;
        } else {
            if (var_p10 != 0) {
                unknown_call(var_m20);
                local_m34 = call_306;
                if ((int32_t)var_m34 <= 0) {
                    local_m38 = (int32_t)local_m34 >= 0 ? 0 : 0xFFFFFFFF;
                } else {
                    local_m38 = 1;
                }
                local_m14 = local_m38;
            } else {
                goto loc_2310;
            }
        }
    }
    return;
}
void memop_bzero(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    if (var_10 != 0) {
        unknown_call(var_10);
        local_m14 = memory_unknown;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void memop_bcopy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    local_m30 = a3;
    if (var_10 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if (var_8 == 0) {
            goto loc_2414;
        } else {
            if (var_0 != 0) {
                unknown_call(var_10);
                local_m14 = memory_unknown;
            } else {
                goto loc_2414;
            }
        }
    }
    return;
}
void memop_unaligned_access(void)
{
    local_m10 = a1;
    if (var_10 != 0) {
        local_m14 = a1->field_1;
        local_m4 = local_m14;
    } else {
        local_m4 = 0xFFFFFFFF;
    }
    return;
}
void memop_memory_barrier(void)
{
    local_m10 = a1;
    if (var_10 != 0) {
        local_m14 = a1->field_0;
        __asm("dmb ish");
        local_m4 = local_m14 + a1->field_0;
    } else {
        local_m4 = 0xFFFFFFFF;
    }
    return;
}
void test_memory_op_functions(void)
{
    uint64 load_1;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x28;
    unknown_call("=== 测试内存操作函数 ===\\n");
    load_1 = global_2D58;
    local_m1C8 = var_647 - 0x1D0 + 0x90;
    local_m140 = load_1;
    local_m130 = global_2D68;
    local_m1C0 = var_647 - 0x1D0 + 0x78;
    local_m158 = 0;
    local_m150 = 0;
    local_m148 = 0;
    local_m1B8 = 10;
    memop_memset(/* arguments unknown */);
    unknown_call("MEMOP-L2-01: %d\\n");
    memop_memcpy(/* arguments unknown */);
    unknown_call("MEMOP-L2-02: %d\\n");
    local_m168 = global_2A38;
    local_m161 = global_2A3F;
    memop_memmove(/* arguments unknown */);
    unknown_call("MEMOP-L2-03: %c\\n");
    local_m178 = global_2D6C;
    local_m170 = global_2D74;
    local_m188 = global_2D78;
    local_m180 = global_2D80;
    memop_memcmp(/* arguments unknown */);
    unknown_call("MEMOP-L2-04: %d\\n");
    memop_bzero(/* arguments unknown */);
    unknown_call("MEMOP-L2-05: %d\\n");
    local_m198 = global_2D84;
    local_m19C = 0;
    memop_bcopy(/* arguments unknown */);
    unknown_call("MEMOP-L2-06: %d\\n");
    local_m1A8 = global_2D88;
    memop_unaligned_access(/* arguments unknown */);
    unknown_call("MEMOP-L3-01: 0x%x\\n");
    local_m1AC = 5;
    memop_memory_barrier(/* arguments unknown */);
    unknown_call("MEMOP-L3-02: %d\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    test_stack_memory(/* arguments unknown */);
    test_heap_memory(/* arguments unknown */);
    test_static_global(/* arguments unknown */);
    test_memory_op_functions(/* arguments unknown */);
    return;
}
void extern_function(void)
{
    local_m4 = a1;
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
