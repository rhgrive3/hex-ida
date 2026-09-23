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
    uint64 load_34;
    uint64 load_8;
    load_34 = var_0;
    load_8 = global_11FD8;
    unknown_call(load_8);
    unknown_call(load_8);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FD0;
    __asm("cbz x0, #0x844");
    return sub_7A0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_35;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x12070 != 0x12070) {
        load_35 = global_11FC0;
        if (!(load_35 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_8;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_8 = global_11FE0;
        if (!(load_8 == 0)) {
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
    if (!(global_12070 != 0)) {
        if (!(global_11FC8 == 0)) {
            unknown_call(global_12060);
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
    return;
}
void call_fake_branch(void)
{
    return;
}
void param_opaque_predicate(void)
{
    if (__arm64_nzcv_add_lo_32((uint32_t)a1, (uint32_t)1)) {
        while ((phi(a1, phi(a1 + 1, x12))) - (((phi(a1, phi(a1 + 1, x12))) / (phi(a1 + 1, x12))) * (phi(a1 + 1, x12))) != 0) {
        }
    } else {
    }
    return;
}
void call_opaque_predicate(void)
{
    while ((phi(phi(x8, 6), 5)) - (((phi(phi(x8, 6), 5)) / (phi(x8, 6))) * (phi(x8, 6))) != 0) {
    }
    return;
}
void param_instruction_substitution(void)
{
    return;
}
void call_instruction_substitution(void)
{
    return;
}
void decrypt_string(void)
{
    uint8 load_124;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(a2);
    memory_unknown = 0;
    if (!(memory_unknown == 0)) {
        load_124 = memory_unknown;
        memory_unknown = (uint32_t)local_phi_209 ^ (uint32_t)a4 & 0xFF;
        while (load_124 != 0) {
        }
    }
    return;
}
void param_string_encryption(void)
{
    uint8 load_1;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    unknown_call(sp - 64);
    local_m21 = 0;
    if (var_m40 == 0) {
    } else {
        load_1 = memory_unknown;
        memory_unknown = (uint32_t)local_phi_254 ^ 90;
        while (load_1 != 0) {
        }
    }
    unknown_call(sp - 64);
    return;
}
void call_string_encryption(void)
{
    uint8 load_88;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    unknown_call(sp - 64);
    local_m21 = 0;
    if (var_m40 == 0) {
    } else {
        load_88 = memory_unknown;
        memory_unknown = (uint32_t)local_phi_253 ^ 90;
        while (load_88 != 0) {
        }
    }
    unknown_call(sp - 64);
    return;
}
void param_tail_call_optimized(void)
{
    if ((int32_t)a1 >= 1) {
    }
    return;
}
void call_tail_call_optimized(void)
{
    return;
}
void param_non_tail_call(void)
{
    if ((int32_t)a1 < 1) {
        return;
    } else {
        return;
    }
}
void call_non_tail_call(void)
{
    return;
}
void param_vectorized_loop(void)
{
    uint64 load_173;
    uint64 load_312;
    uint64 load_555;
        if ((int32_t)a4 < 1) goto loc_C6C;
        if ((uint32_t)a4 >= 8) goto loc_B9C;
        goto loc_C24;
    loc_B9C:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_C24;
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_C24;
    loc_BF4:
        load_312 = memory_unknown;
        load_555 = memory_unknown;
        memory_unknown = var_323;
        memory_unknown = var_323;
        if ((uint64_t)phi(a4 & 0xFFFFFFF8, v37 - 8) != 8) goto loc_BF4;
        if ((uint64_t)a4 & 0xFFFFFFF8 == (uint64_t)a4) goto loc_C50;
    loc_C24:
    loc_C38:
        memory_unknown = memory_unknown + memory_unknown;
        if ((uint64_t)phi(a4 - (phi(a4 & 0xFFFFFFF8, 0)), v275 - 1) != 1) goto loc_C38;
    loc_C50:
        if ((int32_t)a4 < 1) goto loc_C6C;
        if ((uint32_t)a4 >= 8) goto loc_C74;
        goto loc_CB4;
    loc_C6C:
        return;
    loc_C74:
    loc_C88:
        load_173 = memory_unknown;
        if ((uint64_t)phi(v32 - 8, a4 & 0xFFFFFFF8) != 8) goto loc_C88;
        if ((uint64_t)a4 & 0xFFFFFFF8 == (uint64_t)a4) goto loc_CCC;
    loc_CB4:
        while ((uint64_t)phi(v392 - 1, a4 - (phi(a4 & 0xFFFFFFF8, 0))) != 1) {
        }
    loc_CCC:
        return;
}
void call_vectorized_loop(void)
{
    return;
}
void param_link_time_optimization(void)
{
    return;
}
void call_link_time_optimization(void)
{
    return;
}
void div_zero_handler(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    global_12078 = 1;
    unknown_call(0x12080);
}
void param_division_by_zero(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(8);
    unknown_call(0x12080);
    if (call_105 == 0) {
    } else {
    }
    return;
}
void call_division_by_zero(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    param_division_by_zero(/* arguments unknown */);
    param_division_by_zero(/* arguments unknown */);
    unknown_call(8);
    return;
}
void segv_handler(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    global_121B8 = 1;
    unknown_call(0x121C0);
}
void param_null_pointer_deref(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(11);
    unknown_call(0x121C0);
    if (call_121 == 0) {
    } else {
    }
    return;
}
void call_null_pointer_deref(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x20;
    local_m10 = local_x20;
    local_m24 = 42;
    param_null_pointer_deref(/* arguments unknown */);
    param_null_pointer_deref(/* arguments unknown */);
    unknown_call(11);
    return;
}
void param_buffer_overflow_stack(void)
{
    return;
}
void param_buffer_overflow_heap(void)
{
    return;
}
void call_buffer_overflow(void)
{
    return;
}
void param_integer_overflow(void)
{
    if ((int32_t)a1 >= 1) {
        if ((int32_t)a2 >= 1) {
            if (!(bit_extract(a2 + a1, 31, 1) == 0)) {
                return;
            }
        }
    }
    return;
}
void call_integer_overflow(void)
{
    return;
}
void param_undefined_behavior(void)
{
    return;
}
void call_undefined_behavior(void)
{
    return;
}
void param_implementation_defined(void)
{
    return;
}
void call_implementation_defined(void)
{
    return;
}
void test_obf_opt_edge(void)
{
    uint8 load_36;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call("=== 测试混淆、优化与边界情况 ===");
    unknown_call("OBF-L4-02: %d (期望: 10)\\n");
    while ((phi(phi(x8, 6), 5)) - (((phi(phi(x8, 6), 5)) / (phi(x8, 6))) * (phi(x8, 6))) != 0) {
    }
    unknown_call("OBF-L4-03: %d (期望: 20)\\n");
    unknown_call("OBF-L4-04: %d (期望: 225)\\n");
    unknown_call(sp - 64);
    local_m21 = 0;
    if (var_m40 == 0) {
    } else {
        load_36 = memory_unknown;
        memory_unknown = (uint32_t)local_phi_1171 ^ 90;
        while (load_36 != 0) {
        }
    }
    unknown_call(sp - 64);
    unknown_call("OBF-L4-05: %d (期望: 68)\\n");
    unknown_call("OPT-L4-01 尾递归: %d (期望: 500500)\\n");
    unknown_call("OPT-L4-01 非尾: %d (期望: 5050)\\n");
    unknown_call("OPT-L4-02 向量化: %d (期望: 72)\\n");
    unknown_call("OPT-L5-01 LTO: %d (期望: 20)\\n");
    param_division_by_zero(/* arguments unknown */);
    param_division_by_zero(/* arguments unknown */);
    unknown_call(8);
    unknown_call("EDGE-L3-01: %d (期望: 1)\\n");
    local_m40 = 42;
    param_null_pointer_deref(/* arguments unknown */);
    param_null_pointer_deref(/* arguments unknown */);
    unknown_call(11);
    unknown_call("EDGE-L3-02: %d (期望: 41)\\n");
    unknown_call("EDGE-L3-03: %d (期望: 19)\\n");
    unknown_call("EDGE-L3-04: %d (期望: 溢出检测2000000000)\\n");
    unknown_call("EDGE-L4-01: %d (期望: 10)\\n");
    unknown_call("EDGE-L4-02: %d (期望: 平台相关)\\n");
    return;
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_obf_opt_edge(/* arguments unknown */);
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
