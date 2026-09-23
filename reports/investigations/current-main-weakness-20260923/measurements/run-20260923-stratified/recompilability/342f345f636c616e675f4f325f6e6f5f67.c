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
    uint64 load_39;
    uint64 load_7;
    load_39 = var_0;
    load_7 = global_12FD8;
    unknown_call(load_7);
    unknown_call(load_7);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x744");
    return sub_690(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13058 != 0x13058) {
        if (!(global_12FC0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_12FE0 == 0)) {
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
    if (!(global_13058 != 0)) {
        if (!(global_12FC8 == 0)) {
            unknown_call(global_13040);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void cdecl_func(void)
{
    return;
}
void call_cdecl(void)
{
    return;
}
void stdcall_func(void)
{
    return;
}
void call_stdcall(void)
{
    return;
}
void fastcall_func(void)
{
    return;
}
void call_fastcall(void)
{
    return;
}
void call_thiscall(void)
{
    return;
}
void arm_aapcs_func(void)
{
    return;
}
void call_arm_aapcs(void)
{
    return;
}
void mips_func(void)
{
    return;
}
void call_mips(void)
{
    return;
}
void amd64_sysv_func(void)
{
    return;
}
void call_amd64_sysv(void)
{
    return;
}
void ms_x64_func(void)
{
    return;
}
void call_ms_x64(void)
{
    return;
}
void vectorcall_func(void)
{
    return;
}
void call_vectorcall(void)
{
    return;
}
void mixed_conventions_test(void)
{
    return;
}
void varargs_func(void)
{
    local_m10 = var_333 - 0xE0 + 0x80;
    local_m10 = var_333 - 0xE0 + 0x80;
    local_m48 = a4;
    local_m48 = a4;
    local_m58 = a2;
    local_m58 = a2;
    local_m38 = a6;
    local_m38 = a6;
    local_mE0 = var_316;
    local_mE0 = var_316;
    local_mC0 = var_385;
    local_mC0 = var_385;
    local_mA0 = var_382;
    local_mA0 = var_382;
    local_m80 = var_378;
    local_m80 = var_378;
    local_m18 = var_333 - 0xE0 + 0x88 + 56;
    local_m28 = a8;
    local_m28 = a8;
    if ((int32_t)a1 >= 1) {
        if (bit_extract(phi(phi(x11 + 8, phi(x11 + 8, x11)), var_D0), 31, 1) == 0) {
            local_m20 += 8;
        } else {
            local_m8 = (uint32_t)local_phi_379 + 8;
            if (__arm64_nzcv_add_hi_32((uint32_t)phi(phi(x11 + 8, phi(x11 + 8, x11)), var_D0), (uint32_t)8)) {
                goto loc_944;
            } else {
            }
        }
        if ((uint32_t)phi(v154 - 1, a1) != 1) {
            goto loc_964;
        }
    }
    return;
}
void func_no_args(void)
{
    return;
}
void func_many_args(void)
{
    return;
}
double func_mixed_args(int64 a1, int64 a2, double a3)
{
    double var_30;

    var_30 = v8;
    v8 = v0;
    x20 = (uint32)a1;
    __asm("cbz x1, #0x9e0");
    x0_1 = a2;
    x0 = sub_660(a2, a2, a3);
    __asm("b #0x9e4");
    x0 = 0;
    v1 = (double)a3;
    v0 = (double)(int32)((uint32)((uint32)x0 + x20));
    x0 = (int64)v0 + v0 + v1;
    v8 = *(uint64 *)(sp);
    return x0;
}
void func_struct_byval(void)
{
    return;
}
void func_struct_byptr(void)
{
    if (a1 == 0) {
        return;
    } else {
        return;
    }
}
void test_calling_conventions(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试基础调用约定 ===");
    unknown_call("CALL-L1-01: %d\\n");
    unknown_call("CALL-L1-02: %d\\n");
    unknown_call("CALL-L1-03: %d\\n");
    unknown_call("CALL-L1-04: %d\\n");
    unknown_call("CALL-L1-05: %d\\n");
    unknown_call("CALL-L1-06: %d\\n");
    unknown_call("CALL-L1-07: %d\\n");
    unknown_call("CALL-L1-08: %d\\n");
    unknown_call("CALL-L1-09: %d\\n");
    unknown_call("CALL-L1-10: %d\\n");
    varargs_func(/* arguments unknown */);
    unknown_call("CALL-L2-06：varargs_func(5, 1-5) = %d\\n");
    unknown_call("CALL-L2-07：func_no_args() = %d\\n");
    unknown_call("CALL-L2-08：func_many_args(1-8) = %d\\n");
    unknown_call("CALL-L2-09：func_mixed_args(...) = %d\\n");
    unknown_call("CALL-L2-10：func_struct_byval(large) = %d\\n");
}
void param_by_value_int(void)
{
    return;
}
void call_by_value_int(void)
{
    return;
}
void param_by_value_ptr(void)
{
    a1->field_0 = ((uint32_t)a1->field_0 << 1);
    return;
}
void call_by_value_ptr(void)
{
    return;
}
void param_array_decay(void)
{
    return;
}
void call_array_decay(void)
{
    return;
}
void param_string(void)
{
    return;
}
void call_string_param(void)
{
    return;
}
void param_ptr_array(void)
{
    loc_C30:
        if ((int32_t)a2 < 1) goto loc_C50;
        goto loc_C38;
    loc_C38:
        if ((uint32_t)a2 != 1) goto loc_C58;
        goto loc_C44;
    loc_C44:
        goto loc_C98;
    loc_C50:
        return;
    loc_C58:
    loc_C6C:
        if ((uint64_t)phi(v125 - 2, a2 & 0xFFFFFFFE) != 2) goto loc_C6C;
        goto loc_C8C;
    loc_C8C:
        if ((uint64_t)a2 & 0xFFFFFFFE == (uint64_t)a2) goto loc_CB4;
        goto loc_C98;
    loc_C98:
    loc_CA0:
        if ((uint64_t)phi(a2 - (phi(0, a2 & 0xFFFFFFFE)), v27 - 1) != 1) goto loc_CA0;
        goto loc_CB4;
    loc_CB4:
        return;
}
void call_ptr_array(void)
{
    return;
}
void param_varargs(void)
{
    local_m10 = var_303 - 0xE0 + 0x80;
    local_m10 = var_303 - 0xE0 + 0x80;
    local_m48 = a4;
    local_m48 = a4;
    local_m58 = a2;
    local_m58 = a2;
    local_m38 = a6;
    local_m38 = a6;
    local_mE0 = var_297;
    local_mE0 = var_297;
    local_mC0 = var_357;
    local_mC0 = var_357;
    local_mA0 = var_329;
    local_mA0 = var_329;
    local_m80 = var_356;
    local_m80 = var_356;
    local_m18 = var_303 - 0xE0 + 0x88 + 56;
    local_m28 = a8;
    local_m28 = a8;
    if ((int32_t)a1 >= 1) {
        if (bit_extract(phi(var_D0, phi(phi(x11, x11 + 8), x11 + 8)), 31, 1) == 0) {
            local_m20 += 8;
        } else {
            local_m8 = (uint32_t)local_phi_355 + 8;
            if (__arm64_nzcv_add_hi_32((uint32_t)phi(var_D0, phi(phi(x11, x11 + 8), x11 + 8)), (uint32_t)8)) {
                goto loc_D28;
            } else {
            }
        }
        if ((uint32_t)phi(a1, v224 - 1) != 1) {
            goto loc_D48;
        }
    }
    return;
}
void call_varargs_param(void)
{
}
void param_func_ptr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a2);
    return;
}
void call_func_ptr_param(void)
{
    return;
}
void param_double_ptr(void)
{
    if (!(a1 == 0)) {
        if (!(a1->field_0 == 0)) {
            memory_unknown = a2;
            a1->field_0 = 0;
            return;
        }
    }
    return;
}
void call_double_ptr(void)
{
    return;
}
void param_complex_cast(void)
{
    if ((uint32_t)a2 == 1) {
        return;
    } else {
        if (a2 != 0) {
            return;
        } else {
            return;
        }
    }
}
void call_complex_cast(void)
{
    return;
}
void param_struct_byval(void)
{
    return;
}
void call_struct_byval(void)
{
    return;
}
void param_order_dep(void)
{
    return;
}
void call_order_dep(void)
{
    return;
}
void test_parameter_passing(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试参数传递模式 ===");
    unknown_call("PARAM-L1-01: %d\\n");
    unknown_call("PARAM-L1-02: %d\\n");
    unknown_call("PARAM-L2-01: %d\\n");
    unknown_call("PARAM-L2-02: %d\\n");
    unknown_call("PARAM-L2-03: %d\\n");
    param_varargs(/* arguments unknown */);
    unknown_call("PARAM-L2-04: %d\\n");
    unknown_call("PARAM-L3-01: %d\\n");
    unknown_call("PARAM-L3-02: %d\\n");
    unknown_call("PARAM-L3-03: %d\\n");
    unknown_call("PARAM-L3-04: %d\\n");
}
void ret_basic_type(void)
{
    return;
}
void call_ret_basic(void)
{
    return;
}
void ret_pointer(void)
{
    return;
}
void call_ret_pointer(void)
{
    return;
}
void ret_small_struct(void)
{
    return;
}
void call_ret_small_struct(void)
{
    return;
}
void ret_large_struct(void)
{
    uint64 load_94;
    uint64 load_32;
    uint64 load_110;
    local_x8->field_0 = a1;
    load_94 = global_1160;
    load_32 = global_1170;
    load_110 = global_1180;
    local_x8->field_3C = (uint32_t)a1 + 15;
    local_x8->field_4 = var_66;
    local_x8->field_14 = var_89;
    local_x8->field_24 = var_11;
    local_x8->field_34 = var_98;
    return;
}
void call_ret_large_struct(void)
{
    return;
}
void func_a(void)
{
    return;
}
void func_b(void)
{
    return;
}
void ret_func_ptr(void)
{
    return;
}
void call_ret_func_ptr(void)
{
    return;
}
void ret_opaque_handle(void)
{
    return;
}
void call_ret_opaque(void)
{
    return;
}
void ret_complex_expr(void)
{
    return;
}
void call_ret_complex_expr(void)
{
    return;
}
void ret_multi_branch(void)
{
    return;
}
void call_ret_multi_branch(void)
{
    return;
}
void ret_void(void)
{
    a2->field_0 = (uint32_t)a1 + ((uint32_t)(uint32_t)a1 << 1);
    return;
}
void call_ret_void(void)
{
    return;
}
void test_return_values(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试返回值处理 ===");
    unknown_call("RET-L1-01: %d (期望: 42)\\n");
    unknown_call("RET-L1-02: %d (期望: 20)\\n");
    unknown_call("RET-L1-03: %d (期望: 7)\\n");
    unknown_call("RET-L1-04: %d (期望: 215)\\n");
    unknown_call("RET-L2-01: %d (期望: 10)\\n");
    unknown_call("RET-L2-02: %d (期望: 100)\\n");
    unknown_call("RET-L3-01: %d (期望: 40)\\n");
    unknown_call("RET-L3-02: %d (期望: 60)\\n");
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_calling_conventions(/* arguments unknown */);
    test_parameter_passing(/* arguments unknown */);
    test_return_values(/* arguments unknown */);
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
