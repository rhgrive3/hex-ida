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
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_calling_conventions(/* arguments unknown */);
    test_parameter_passing(/* arguments unknown */);
    test_return_values(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_5;
    uint64 load_40;
    load_5 = var_0;
    load_40 = global_12FF0;
    unknown_call(load_40);
    unknown_call(load_40);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FE0;
    __asm("cbz x0, #0x884");
    return sub_7C0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13038 != 0x13038) {
        if (!(global_12FD0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_1;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_1 = global_12FF8;
        if (!(load_1 == 0)) {
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
    if (!(global_13038 != 0)) {
        if (!(global_12FD8 == 0)) {
            unknown_call(global_13008);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void func_a(void)
{
    return;
}
void func_b(void)
{
    return;
}
void callback_func(void)
{
    return;
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
uint32 varargs_func(int64 a1, uint64 a2, uint64 a3, int64 a4, int64 a5, int64 a6, int64 a7, int64 a8)
{
    uint64 var_18, var_28, var_30, var_38, var_48, var_58, var_68, var_78;

    x8 = (uint32)a1;
    var_48 = a2;   var_50 = a3;
    var_58 = a4;   var_60 = a5;
    x3 = sp + -128 + 0x80;
    x4 = 0;
    var_68 = a6;   var_70 = a7;
    x6 = sp;
    var_78 = a8;
    var_38 = *(uint64 *)(*(uint64 *)0x12FE8);
    x0 = sp + -128 + 0x80;
    var_18 = sp;   var_20 = sp;
    x1 = 0xFFFFFFC8;
    var_28 = sp - 64;
    x0 = 0;
    var_30 = 0xFFFFFFC8;   var_34 = 0;
    /* cmp (int32)(x4), (int32)(x8) — 次の分岐のための比較 */
    __asm("b.lt #0xab8");
    x1 = *(uint64 *)0x12FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0xb04");
    x0 = sub_7B0();
    __asm("tbnz w1, #0x1f, #0xae0");
    x5 = (uint32)x1;
    x2 = x3 + 11 & 0xFFFFFFFFFFFFFFF8;
    loc_AC8:
    x4 = (uint32)((uint32)x4 + 1);
    x3 = x2;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x3));
    x1 = (uint32)x5;
    __asm("b #0xa90");
    x5 = (uint32)((uint32)x1 + 8);
    /* cmp (int32)(x5), 0 — 次の分岐のための比較 */
    __asm("b.le #0xaf8");
    x2 = x3 + 11 & 0xFFFFFFFFFFFFFFF8;
    __asm("b #0xac8");
    goto loc_AC8;
    x2 = x3;
    x3 = x6 + (int32)(uint32)x1;
    __asm("b #0xac8");
    goto loc_AC8;
    return x0;
}
void func_no_args(void)
{
    return;
}
void func_many_args(void)
{
    return;
}
uint32 func_mixed_args(int64 a1, int64 a2, double a3)
{
    double var_20;

    x19 = (uint32)a1;
    var_20 = v8;   var_28 = v9;
    v9 = v0;
    v8 = a3;
    __asm("cbz x1, #0xb84");
    x0_1 = a2;
    x0 = sub_770(a2, a2, a3);
    loc_B5C:
    v1 = (double)v8;
    v8 = var_20;   v9 = var_28;
    x0 = (int64)v1 + v9 + v1;
    return x0;
    x0 = 0;
    __asm("b #0xb5c");
    goto loc_B5C;
}
void func_struct_byval(void)
{
    while ((uint64_t)(phi(0, x1)) + 1 != 16) {
    }
    return;
}
uint32 func_struct_byptr(void * a1)
{
    __asm("cbz x0, #0xbc0");
    x1 = *(uint32 *)(a1);   x0 = *(uint32 *)(a1 + 4);
    loc_BBC:
    return x0;
    __asm("b #0xbbc");
    goto loc_BBC;
}
void test_calling_conventions(void)
{
    uint64 load_412;
    uint64 load_548;
    uint64 load_21;
    uint64 load_93;
    local_pFFFFFFFFFFFFFEE0 = local_x29;
    local_pFFFFFFFFFFFFFEE0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试基础调用约定 ===");
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    varargs_func(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_412 = global_1818;
    func_mixed_args(/* arguments unknown */);
    unknown_call(1);
    (var_600 + 0xFFFFFFFFFFFFFEE0 + 24)[local_phi_849] = local_x0 + 1;
    while ((uint64_t)x0 + 1 != 16) {
    }
    local_pFFFFFFFFFFFFFF78 = local_pFFFFFFFFFFFFFEF8;
    local_pFFFFFFFFFFFFFF78 = local_pFFFFFFFFFFFFFEF8;
    local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF18;
    local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF18;
    local_pFFFFFFFFFFFFFFB8 = local_pFFFFFFFFFFFFFF38;
    local_pFFFFFFFFFFFFFFB8 = local_pFFFFFFFFFFFFFF38;
    load_548 = var_FFFFFFFFFFFFFF58;
    load_21 = var_FFFFFFFFFFFFFF58;
    local_pFFFFFFFFFFFFFFD8 = load_548;
    local_pFFFFFFFFFFFFFFD8 = load_548;
    load_93 = ((sp + 0xFFFFFFFFFFFFFEE0) + 0x98)[phi(0, x1 + 1)];
    while ((uint64_t)x1 + 1 != 16) {
    }
    unknown_call(1);
    if ((uint64_t)var_118 != (uint64_t)memory_unknown) {
        unknown_call(global_12FE8);
    }
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
    while ((int32_t)a2 > (int32_t)phi(0, x2 + 1)) {
        continue;
    }
    return;
}
void call_ptr_array(void)
{
    uint64 load_89;
    uint64 load_10;
    uint64 load_91;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFE0 = global_13010;
    local_pFFFFFFFFFFFFFFE0 = global_13010;
    local_pFFFFFFFFFFFFFFF0 = global_13020;
    param_ptr_array(/* arguments unknown */);
    load_89 = global_12FE8;
    load_10 = var_28;
    load_91 = memory_unknown;
    if ((uint64_t)load_10 != (uint64_t)load_91) {
        unknown_call((sp + 0xFFFFFFFFFFFFFFD0) + 16);
    }
    return;
}
uint32 param_varargs(int64 a1, uint64 a2, uint64 a3, int64 a4, int64 a5, int64 a6, int64 a7, int64 a8)
{
    uint64 var_18, var_28, var_30, var_38, var_48, var_58, var_68, var_78;

    x8 = (uint32)a1;
    var_48 = a2;   var_50 = a3;
    var_58 = a4;   var_60 = a5;
    x3 = sp + -128 + 0x80;
    x4 = 0;
    var_68 = a6;   var_70 = a7;
    x6 = sp;
    var_78 = a8;
    var_38 = *(uint64 *)(*(uint64 *)0x12FE8);
    x0 = sp + -128 + 0x80;
    var_18 = sp;   var_20 = sp;
    x1 = 0xFFFFFFC8;
    var_28 = sp - 64;
    x0 = 0;
    var_30 = 0xFFFFFFC8;   var_34 = 0;
    /* cmp (int32)(x4), (int32)(x8) — 次の分岐のための比較 */
    __asm("b.lt #0xf4c");
    x1 = *(uint64 *)0x12FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0xf98");
    x0 = sub_7B0();
    __asm("tbnz w1, #0x1f, #0xf74");
    x5 = (uint32)x1;
    x2 = x3 + 11 & 0xFFFFFFFFFFFFFFF8;
    loc_F5C:
    x4 = (uint32)((uint32)x4 + 1);
    x3 = x2;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x3));
    x1 = (uint32)x5;
    __asm("b #0xf24");
    x5 = (uint32)((uint32)x1 + 8);
    /* cmp (int32)(x5), 0 — 次の分岐のための比較 */
    __asm("b.le #0xf8c");
    x2 = x3 + 11 & 0xFFFFFFFFFFFFFFF8;
    __asm("b #0xf5c");
    goto loc_F5C;
    x2 = x3;
    x3 = x6 + (int32)(uint32)x1;
    __asm("b #0xf5c");
    goto loc_F5C;
    return x0;
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
}
uint32 param_double_ptr(void * a1, int64 a2)
{
    __asm("cbz x0, #0x1004");
    x2 = *(uint64 *)(a1);
    __asm("cbz x2, #0x1004");
    *(uint32 *)(x2) = (uint32)a2;
    *(uint64 *)(a1) = 0;
    loc_1000:
    return x0;
    __asm("b #0x1000");
    goto loc_1000;
}
void call_double_ptr(void)
{
    return;
}
uint32 param_complex_cast(void * a1, uint64 a2)
{
    __asm("cbnz w1, #0x1020");
    loc_101C:
    return x0;
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x1034");
    x1 = *(uint32 *)(x0);   x0 = *(uint32 *)(x0 + 4);
    __asm("b #0x101c");
    goto loc_101C;
    __asm("b #0x101c");
    goto loc_101C;
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
    uint32 load_59;
    uint32 load_78;
    uint64 load_35;
    uint64 load_29;
    uint64 load_80;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    (var_201 + 0xFFFFFFFFFFFFFFA0 + 24)[local_phi_204] = local_phi_204;
    for (int64 i = 0; (uint64_t)(phi(x0, 0)) + 1 != 16; i++) {
    }
    load_59 = var_54;
    load_78 = var_18;
    load_35 = global_12FE8;
    load_29 = var_58;
    load_80 = memory_unknown;
    if ((uint64_t)load_29 != (uint64_t)load_80) {
        unknown_call(load_78 + load_59);
    }
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
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_ptr_array(/* arguments unknown */);
    unknown_call(1);
    call_varargs_param(/* arguments unknown */);
    unknown_call(1);
    call_func_ptr_param(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_struct_byval(/* arguments unknown */);
    unknown_call(1);
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
    uint64 load_4;
    uint64 load_85;
    uint64 load_154;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    (var_220 + 0xFFFFFFFFFFFFFFA0 + 24)[local_phi_226] = (uint32_t)a1 + (uint32_t)local_phi_226;
    for (int64 i = 0; (uint64_t)(phi(x2, 0)) + 1 != 16; i++) {
    }
    load_4 = var_10;
    load_85 = global_12FE8;
    local_x8->field_0 = local_pFFFFFFFFFFFFFFB8;
    local_x8->field_0 = local_pFFFFFFFFFFFFFFB8;
    load_154 = var_20;
    local_x8->field_20 = local_pFFFFFFFFFFFFFFD8;
    local_x8->field_20 = local_pFFFFFFFFFFFFFFD8;
    if ((uint64_t)var_58 != (uint64_t)memory_unknown) {
        unknown_call(load_85);
    }
    return;
}
void call_ret_large_struct(void)
{
    uint32 load_61;
    uint32 load_106;
    uint64 load_88;
    uint64 load_111;
    uint64 load_71;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    ret_large_struct(/* arguments unknown */);
    load_61 = var_FFFFFFFFFFFFFFF4;
    load_106 = var_FFFFFFFFFFFFFFB8;
    load_88 = global_12FE8;
    load_111 = var_58;
    load_71 = memory_unknown;
    if ((uint64_t)load_111 != (uint64_t)load_71) {
        unknown_call(load_106 + load_61);
    }
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
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_ret_large_struct(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
