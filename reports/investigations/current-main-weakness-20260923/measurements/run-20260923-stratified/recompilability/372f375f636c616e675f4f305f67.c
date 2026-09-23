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
    uint64 load_31;
    uint64 load_29;
    load_31 = var_0;
    load_29 = global_11FD8;
    unknown_call(load_29);
    unknown_call(load_29);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FD0;
    __asm("cbz x0, #0x884");
    return sub_7E0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_19;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x12078 != 0x12078) {
        load_19 = global_11FC0;
        if (!(load_19 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_11FE0 == 0)) {
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
    if (!(global_12078 != 0)) {
        if (!(global_11FC8 == 0)) {
            unknown_call(global_12068);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void param_fake_branch(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m18 = local_m14;
    if ((int32_t)var_m14 * var_m14 < 0) {
        local_m18 = bit_insert(0xBEEF, 0xDEAD, 16, 16) + ((uint32_t)local_m18 << 1);
    }
    local_m20 = 0x15EC;
    unknown_call(var_0);
    if ((uint64_t)call_235 < 0) {
        local_m18 += 0x3E8;
    }
    return;
}
void call_fake_branch(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fake_branch(/* arguments unknown */);
    return;
}
void param_opaque_predicate(void)
{
    local_m8 = a1;
    local_mC = ((uint32_t)((uint32_t)a1 * (uint32_t)a1 + 2 * (uint32_t)a1 + 1) == (uint32_t)(((uint32_t)a1 + 1) * ((uint32_t)a1 + 1)) ? 1 : 0) & 1;
    local_m10 = (uint32_t)a1;
    local_m14 = (uint32_t)a1 + 1;
    while (!(var_C == 0)) {
        local_m18 = local_m14;
        local_m14 = local_m10 - (int32_t)(local_m14 == 0 ? 0 : local_m10 / local_m14) * local_m14;
        local_m10 = local_m18;
        continue;
    }
    local_m1C = ((uint32_t)local_m10 == 1 ? 1 : 0) & 1;
    local_m20 = ((uint32_t)(local_m8 ^ 0xAAAAAAAA ^ 0xAAAAAAAA) == (uint32_t)local_m8 ? 1 : 0) & 1;
    if (var_14 == 0) {
        local_m4 = local_m8 * 3 + 20;
    } else {
        if (var_4 == 0) {
            goto loc_AFC;
        } else {
            if (var_0 == 0) {
                goto loc_AFC;
            } else {
                local_m4 = ((uint32_t)local_m8 << 1) + 10;
            }
        }
    }
    return;
}
void call_opaque_predicate(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_opaque_predicate(/* arguments unknown */);
    return;
}
void param_instruction_substitution(void)
{
    uint32 var_10;
    local_m4 = a1;
    local_m8 = (uint32_t)a1;
    local_m8 = ((uint32_t)(uint32_t)a1 << 3) - ((uint32_t)(uint32_t)a1 << 1);
    local_mC = (uint32_t)a1;
    var_10 = (uint32_t)a1 >> 1;
    local_m14 = (uint32_t)a1 & 15;
    local_m18 = ((uint32_t)(uint32_t)a1 << 4) - (uint32_t)a1;
    return;
}
void call_instruction_substitution(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_instruction_substitution(/* arguments unknown */);
    return;
}
void decrypt_string(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    local_m29 = (uint32_t)a4;
    unknown_call(var_m20);
    memory_unknown = 0;
    local_m38 = local_m20;
    while (!(memory_unknown == 0)) {
        memory_unknown = memory_unknown ^ local_m29;
        local_m38++;
        continue;
    }
    return;
}
void param_string_encryption(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m38 = var_142 - 64 + 16;
    decrypt_string(/* arguments unknown */);
    unknown_call(var_8);
    return;
}
void call_string_encryption(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_string_encryption(/* arguments unknown */);
    return;
}
void param_tail_call_optimized(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    if ((int32_t)var_8 > 0) {
        param_tail_call_optimized(/* arguments unknown */);
        local_m14 = call_182;
    } else {
        local_m14 = local_m1C;
    }
    return;
}
void call_tail_call_optimized(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_tail_call_optimized(/* arguments unknown */);
    return;
}
void param_non_tail_call(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    if ((int32_t)var_8 > 0) {
        local_m1C = local_m18;
        param_non_tail_call(/* arguments unknown */);
        local_m14 = local_m1C + (uint32_t)call_159;
    } else {
        local_m14 = 0;
    }
    return;
}
void call_non_tail_call(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_non_tail_call(/* arguments unknown */);
    return;
}
void param_vectorized_loop(void)
{
    local_m8 = a1;
    local_m10 = a2;
    local_m18 = a3;
    local_m1C = a4;
    local_m20 = 0;
    while ((int32_t)var_10 < (int32_t)var_14) {
        local_m18[(int64_t)local_m20] = local_m8[(int64_t)local_m20] + local_m10[(int64_t)local_m20];
        local_m20 = local_m20 + 1;
        continue;
    }
    local_m24 = 0;
    local_m28 = 0;
    while ((int32_t)var_8 < (int32_t)var_14) {
        local_m24 = local_m24 + local_m18[(int64_t)local_m28];
        local_m28 = local_m28 + 1;
        continue;
    }
    return;
}
void call_vectorized_loop(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = global_17F0;
    local_m20 = global_1800;
    local_m50 = global_1810;
    local_m40 = global_1820;
    local_m70 = var_37;
    local_m60 = var_37;
    param_vectorized_loop(/* arguments unknown */);
    return;
}
void param_link_time_optimization(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    lto_target_func(/* arguments unknown */);
    return;
}
void lto_target_func(void)
{
    local_m4 = a1;
    return;
}
void call_link_time_optimization(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_link_time_optimization(/* arguments unknown */);
    return;
}
void div_zero_handler(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    global_12080 = 1;
    unknown_call(0x12088);
}
void param_division_by_zero(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(8);
    unknown_call(0x12088);
    if (call_171 != 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        local_m1C = (int32_t)(local_m18 == 0 ? 0 : 10 / local_m18);
        local_m14 = local_m1C;
    }
    return;
}
void call_division_by_zero(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_division_by_zero(/* arguments unknown */);
    local_m14 = call_43;
    param_division_by_zero(/* arguments unknown */);
    local_m18 = call_62;
    unknown_call(8);
    return;
}
void segv_handler(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    global_121C0 = 1;
    unknown_call(0x121C8);
}
void param_null_pointer_deref(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(11);
    unknown_call(0x121C8);
    if (call_199 != 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        local_m24 = memory_unknown;
        local_m14 = local_m24;
    }
    return;
}
void call_null_pointer_deref(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 42;
    param_null_pointer_deref(/* arguments unknown */);
    local_m18 = call_61;
    local_m28 = 0;
    param_null_pointer_deref(/* arguments unknown */);
    local_m1C = call_87;
    unknown_call(11);
    return;
}
void param_buffer_overflow_stack(void)
{
    local_m4 = a1;
    local_m10 = bit_insert(0x5678, 0x1234, 16, 16);
    local_m14 = 0;
    while ((int32_t)var_C <= 16) {
        memory_unknown = 65;
        local_m14 = local_m14 + 1;
        continue;
    }
    if ((uint32_t)var_10 != (uint32_t)bit_insert(0x5678, 0x1234, 16, 16)) {
        local_m18 = 0xFFFFFFFF;
    } else {
        local_m18 = local_m4;
    }
    return;
}
void param_buffer_overflow_heap(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(16);
    local_m20 = call_69;
    if (var_m20 != 0) {
        local_m24 = 0;
        while ((int32_t)var_m24 <= 32) {
            memory_unknown = 66;
            local_m24++;
            continue;
        }
        unknown_call(var_m20);
        local_m14 = local_m18;
    } else {
        local_m14 = 0xFFFFFFFE;
    }
    return;
}
void call_buffer_overflow(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_buffer_overflow_stack(/* arguments unknown */);
    local_m14 = call_43;
    param_buffer_overflow_heap(/* arguments unknown */);
    local_m18 = call_62;
    return;
}
void param_integer_overflow(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = (uint32_t)a1 + (uint32_t)a2;
    local_m14 = (uint32_t)a1;
    local_m18 = (uint32_t)a2;
    local_m1C = (uint32_t)a1 + (uint32_t)a2;
    if ((int32_t)a1 <= 0) {
        if ((int32_t)a1 >= 0) {
            local_m4 = (uint32_t)a1 + (uint32_t)a2;
        } else {
            if ((int32_t)a2 >= 0) {
                goto loc_1304;
            } else {
                if ((int32_t)a1 + a2 <= 0) {
                    goto loc_1304;
                } else {
                    local_m4 = 0xFFFFFFFE;
                }
            }
        }
    } else {
        if ((int32_t)a2 <= 0) {
            goto loc_12C8;
        } else {
            if ((int32_t)a1 + a2 >= 0) {
                goto loc_12C8;
            } else {
                local_m4 = 0xFFFFFFFF;
            }
        }
    }
    return;
}
void call_integer_overflow(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_integer_overflow(/* arguments unknown */);
    local_m14 = call_57;
    param_integer_overflow(/* arguments unknown */);
    local_m18 = call_81;
    return;
}
void param_undefined_behavior(void)
{
    local_m4 = a1;
    local_m8 = 0x64;
    return;
}
void call_undefined_behavior(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_undefined_behavior(/* arguments unknown */);
    local_m14 = call_43;
    return;
}
void param_implementation_defined(void)
{
    local_m4 = 0;
    local_m5 = 0xFF;
    local_m4 = 0 + (0xFF >= 0 ? 2 : 1);
    local_mC = 0xFFFFFFF8;
    local_m4 = 0 + (0xFF >= 0 ? 2 : 1) + 0xFFFFFFFC;
    local_m10 = local_m10 & 0xFFFFFFF8 | 7;
    local_m10 = local_m10 & 0xFFFFFF07 | 0xF8;
    local_m10 = local_m10 | bit_insert(0x5600, 0x1234, 16, 16);
    local_m4 = 0 + (0xFF >= 0 ? 2 : 1) + 0xFFFFFFFC + (local_m10 & 7) + bit_extract(local_m10, 3, 5);
    local_m4 = (int64_t)(0 + (0xFF >= 0 ? 2 : 1) + 0xFFFFFFFC + (local_m10 & 7) + bit_extract(local_m10, 3, 5)) + 12;
    return;
}
void call_implementation_defined(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_implementation_defined(/* arguments unknown */);
    return;
}
void test_obf_opt_edge(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试混淆、优化与边界情况 ===\\n");
    call_fake_branch(/* arguments unknown */);
    unknown_call("OBF-L4-02: %d (期望: 10)\\n");
    call_opaque_predicate(/* arguments unknown */);
    unknown_call("OBF-L4-03: %d (期望: 20)\\n");
    call_instruction_substitution(/* arguments unknown */);
    unknown_call("OBF-L4-04: %d (期望: 225)\\n");
    call_string_encryption(/* arguments unknown */);
    unknown_call("OBF-L4-05: %d (期望: 68)\\n");
    call_tail_call_optimized(/* arguments unknown */);
    unknown_call("OPT-L4-01 尾递归: %d (期望: 500500)\\n");
    call_non_tail_call(/* arguments unknown */);
    unknown_call("OPT-L4-01 非尾: %d (期望: 5050)\\n");
    call_vectorized_loop(/* arguments unknown */);
    unknown_call("OPT-L4-02 向量化: %d (期望: 72)\\n");
    call_link_time_optimization(/* arguments unknown */);
    unknown_call("OPT-L5-01 LTO: %d (期望: 20)\\n");
    call_division_by_zero(/* arguments unknown */);
    unknown_call("EDGE-L3-01: %d (期望: 1)\\n");
    call_null_pointer_deref(/* arguments unknown */);
    unknown_call("EDGE-L3-02: %d (期望: 41)\\n");
    call_buffer_overflow(/* arguments unknown */);
    unknown_call("EDGE-L3-03: %d (期望: 19)\\n");
    call_integer_overflow(/* arguments unknown */);
    unknown_call("EDGE-L3-04: %d (期望: 溢出检测2000000000)\\n");
    call_undefined_behavior(/* arguments unknown */);
    unknown_call("EDGE-L4-01: %d (期望: 10)\\n");
    call_implementation_defined(/* arguments unknown */);
    unknown_call("EDGE-L4-02: %d (期望: 平台相关)\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    test_obf_opt_edge(/* arguments unknown */);
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
