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
    uint64 load_24;
    uint64 load_10;
    load_24 = var_0;
    load_10 = global_12FF0;
    unknown_call(load_10);
    unknown_call(load_10);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FE0;
    __asm("cbz x0, #0x844");
    return sub_7C0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_43;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13038 != 0x13038) {
        load_43 = global_12FD0;
        if (!(load_43 == 0)) {
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
        load_51 = global_12FF8;
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
void callback_func(void)
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
    uint32 load_116;
    loc_9F8:
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFFC8 = a2;
        local_pFFFFFFFFFFFFFFD0 = a3;
        local_pFFFFFFFFFFFFFFD8 = a4;
        local_pFFFFFFFFFFFFFFE0 = a5;
        local_pFFFFFFFFFFFFFFE8 = a6;
        local_pFFFFFFFFFFFFFFF0 = a7;
        local_pFFFFFFFFFFFFFFF8 = a8;
        local_pFFFFFFFFFFFFFFB8 = memory_unknown;
        local_pFFFFFFFFFFFFFF98 = var_402 + 0xFFFFFFFFFFFFFF80 + 0x80;
        local_pFFFFFFFFFFFFFFA0 = var_402 + 0xFFFFFFFFFFFFFF80 + 0x80;
        local_pFFFFFFFFFFFFFFA8 = var_402 + 0xFFFFFFFFFFFFFF80 + 64;
        local_pFFFFFFFFFFFFFFB0 = 0xFFFFFFC8;
        local_pFFFFFFFFFFFFFFB4 = 0;
        if ((int32_t)a1 <= 0) goto loc_ABC;
        goto loc_A5C;
    loc_A5C:
        goto loc_A98;
    loc_A68:
        local_pFFFFFFFFFFFFFFB0 = load_116 + 8;
        if ((int32_t)var_30 <= 0) goto loc_AB4;
        goto loc_A78;
    loc_A78:
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF98 + 11 & 0xFFFFFFFFFFFFFFF8;
    loc_A84:
        if ((uint32_t)a1 == (uint32_t)(phi(0, x1)) + 1) goto loc_AC0;
        goto loc_A98;
    loc_A98:
        load_116 = var_30;
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_A68;
        goto loc_AA4;
    loc_AA4:
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF98 + 11 & 0xFFFFFFFFFFFFFFF8;
        goto loc_A84;
    loc_AB4:
        goto loc_A84;
    loc_ABC:
    loc_AC0:
        if ((uint64_t)var_38 != (uint64_t)memory_unknown) goto loc_AE4;
        goto loc_ADC;
    loc_ADC:
        return;
    loc_AE4:
        unknown_call(phi(0, (phi(0, x0)) + memory_unknown));
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
    double var_20;

    var_20 = v8;   var_28 = v9;
    x19 = (uint32)a1;
    v9 = v0;
    v8 = a3;
    x0 = 0;
    __asm("cbz x1, #0xb3c");
    x0_1 = a2;
    x0 = sub_770(a2, a2, a3);
    v0 = (double)(int32)((uint32)((uint32)x0 + x19));
    x0 = (int64)v0 + v0 + v8;
    v8 = var_20;   v9 = var_28;
    return x0;
}
void func_struct_byval(void)
{
    while ((uint64_t)(phi(a1, x1)) + 8 != (uint64_t)a1 + 0x80) {
    }
    return;
}
uint32 func_struct_byptr(void * a1)
{
    __asm("cbz x0, #0xb98");
    loc_B94:
    return x0;
    __asm("b #0xb94");
    goto loc_B94;
}
void test_calling_conventions(void)
{
    uint64 load_401;
    uint64 load_109;
    uint64 load_476;
    uint64 load_101;
    uint64 load_437;
    uint64 load_77;
    loc_BA0:
        local_pFFFFFFFFFFFFFEE0 = local_x29;
        local_pFFFFFFFFFFFFFEE0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x1570);
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
        load_401 = global_19C8;
        func_mixed_args(/* arguments unknown */);
        unknown_call(1);
    loc_D20:
        memory_unknown = local_phi_847;
        if ((uint64_t)x0 + 1 != 17) goto loc_D20;
        goto loc_D34;
    loc_D34:
        local_pFFFFFFFFFFFFFF78 = local_pFFFFFFFFFFFFFEF8;
        local_pFFFFFFFFFFFFFF78 = local_pFFFFFFFFFFFFFEF8;
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF18;
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF18;
        local_pFFFFFFFFFFFFFFB8 = local_pFFFFFFFFFFFFFF38;
        local_pFFFFFFFFFFFFFFB8 = local_pFFFFFFFFFFFFFF38;
        load_109 = var_FFFFFFFFFFFFFF58;
        load_476 = var_FFFFFFFFFFFFFF58;
        local_pFFFFFFFFFFFFFFD8 = load_109;
        local_pFFFFFFFFFFFFFFD8 = load_109;
    loc_D64:
        if ((uint64_t)(sp + 0xFFFFFFFFFFFFFEE0) + 0x118 != (uint64_t)(phi((sp + 0xFFFFFFFFFFFFFEE0) + 0x98, x0)) + 8) goto loc_D64;
        goto loc_D74;
    loc_D74:
        unknown_call(1);
        unknown_call(1);
        load_101 = global_12FE8;
        load_437 = var_118;
        load_77 = memory_unknown;
        if ((uint64_t)load_437 != (uint64_t)load_77) goto loc_DBC;
        goto loc_DB4;
    loc_DB4:
        return;
    loc_DBC:
        unknown_call(load_101);
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
uint32 param_ptr_array(void * a1, int64 a2)
{
    x4 = a1;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xe44");
    x2 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint8 *)(*(uint64 *)(x4 + x2 * 8)));
    x2 = x2 + 1;
    /* cmp (int32)(a2), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.gt #0xe28");
    loc_E40:
    return x0;
    __asm("b #0xe40");
    goto loc_E40;
}
void call_ptr_array(void)
{
    uint64 load_35;
    uint64 load_30;
    uint64 load_59;
    loc_E4C:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE0 = global_13010;
        local_pFFFFFFFFFFFFFFE0 = global_13010;
        local_pFFFFFFFFFFFFFFF0 = global_13020;
        param_ptr_array(/* arguments unknown */);
        load_35 = global_12FE8;
        load_30 = var_28;
        load_59 = memory_unknown;
        if ((uint64_t)load_30 != (uint64_t)load_59) goto loc_EB0;
        goto loc_EA8;
    loc_EA8:
        return;
    loc_EB0:
        unknown_call((sp + 0xFFFFFFFFFFFFFFD0) + 16);
}
void param_varargs(void)
{
    uint64 load_198;
    uint64 load_290;
    uint64 load_209;
    uint64 load_322;
    loc_EB4:
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFF80 = local_x29;
        local_pFFFFFFFFFFFFFFC8 = a2;
        local_pFFFFFFFFFFFFFFD0 = a3;
        local_pFFFFFFFFFFFFFFD8 = a4;
        local_pFFFFFFFFFFFFFFE0 = a5;
        local_pFFFFFFFFFFFFFFE8 = a6;
        local_pFFFFFFFFFFFFFFF0 = a7;
        local_pFFFFFFFFFFFFFFF8 = a8;
        local_pFFFFFFFFFFFFFFB8 = memory_unknown;
        local_pFFFFFFFFFFFFFF98 = var_354 + 0xFFFFFFFFFFFFFF80 + 0x80;
        local_pFFFFFFFFFFFFFFA0 = var_354 + 0xFFFFFFFFFFFFFF80 + 0x80;
        local_pFFFFFFFFFFFFFFA8 = var_354 + 0xFFFFFFFFFFFFFF80 + 64;
        local_pFFFFFFFFFFFFFFB0 = 0xFFFFFFC8;
        local_pFFFFFFFFFFFFFFB4 = 0;
        if ((int32_t)a1 <= 0) goto loc_F78;
        goto loc_F18;
    loc_F18:
        load_198 = var_20;
        goto loc_F54;
    loc_F24:
        local_pFFFFFFFFFFFFFFB0 += 8;
        if ((int32_t)var_30 <= 0) goto loc_F70;
        goto loc_F34;
    loc_F34:
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF98 + 11 & 0xFFFFFFFFFFFFFFF8;
    loc_F40:
        if ((uint32_t)a1 == (uint32_t)(phi(0, x1)) + 1) goto loc_F7C;
        goto loc_F54;
    loc_F54:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_F24;
        goto loc_F60;
    loc_F60:
        local_pFFFFFFFFFFFFFF98 = local_pFFFFFFFFFFFFFF98 + 11 & 0xFFFFFFFFFFFFFFF8;
        goto loc_F40;
    loc_F70:
        goto loc_F40;
    loc_F78:
    loc_F7C:
        load_290 = global_12FE8;
        load_209 = var_38;
        load_322 = memory_unknown;
        if ((uint64_t)load_209 != (uint64_t)load_322) goto loc_FA0;
        goto loc_F98;
    loc_F98:
        return;
    loc_FA0:
        unknown_call(phi((phi(0, x0)) + memory_unknown, 0));
}
void call_varargs_param(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_varargs(/* arguments unknown */);
    return;
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
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_func_ptr(/* arguments unknown */);
    return;
}
uint32 param_double_ptr(void * a1, int64 a2)
{
    __asm("cbz x0, #0x1028");
    x2 = *(uint64 *)(a1);
    __asm("cbz x2, #0x1030");
    *(uint32 *)(x2) = (uint32)a2;
    *(uint64 *)(a1) = 0;
    loc_1024:
    return x0;
    __asm("b #0x1024");
    goto loc_1024;
    __asm("b #0x1024");
    goto loc_1024;
}
void call_double_ptr(void)
{
    uint32 load_123;
    uint64 load_59;
    uint64 load_115;
    uint64 load_41;
    uint64 load_92;
    loc_1038:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFEC = 10;
        local_pFFFFFFFFFFFFFFF0 = var_159 + 0xFFFFFFFFFFFFFFD0 + 28;
        param_double_ptr(/* arguments unknown */);
        load_59 = var_20;
        load_123 = var_1C;
        load_115 = global_12FE8;
        load_41 = var_28;
        load_92 = memory_unknown;
        if ((uint64_t)load_41 != (uint64_t)load_92) goto loc_10A4;
        goto loc_109C;
    loc_109C:
        return;
    loc_10A4:
        unknown_call(((uint64_t)load_59 == 0 ? load_123 + 1 : load_123));
}
uint32 param_complex_cast(void * a1, uint32 a2)
{
    __asm("cbz w1, #0x10c4");
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x10cc");
    loc_10C0:
    return x0;
    __asm("b #0x10c0");
    goto loc_10C0;
    __asm("b #0x10c0");
    goto loc_10C0;
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
    loc_10F0:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    loc_1114:
        memory_unknown = local_phi_240;
        if ((uint32_t)(phi(x0, 0)) + 1 != 16) goto loc_1114;
        goto loc_1124;
    loc_1124:
        if ((uint64_t)var_58 != (uint64_t)memory_unknown) goto loc_1154;
        goto loc_114C;
    loc_114C:
        return;
    loc_1154:
        unknown_call(var_54 + var_18);
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
    unknown_call(0x1740);
    unknown_call(1);
    call_by_value_ptr(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    call_ptr_array(/* arguments unknown */);
    unknown_call(1);
    call_varargs_param(/* arguments unknown */);
    unknown_call(1);
    call_func_ptr_param(/* arguments unknown */);
    unknown_call(1);
    call_double_ptr(/* arguments unknown */);
    unknown_call(1);
    call_complex_cast(/* arguments unknown */);
    unknown_call(1);
    call_struct_byval(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    return;
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
    uint64 load_82;
    uint64 load_187;
    uint64 load_115;
    uint64 load_92;
    uint64 load_107;
    uint64 load_94;
    loc_12B0:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    loc_12D8:
        memory_unknown = (uint32_t)a1 - 1 + (uint32_t)local_phi_309;
        if ((uint64_t)x1 + 1 != 17) goto loc_12D8;
        goto loc_12F0;
    loc_12F0:
        load_82 = var_10;
        local_x8->field_0 = local_pFFFFFFFFFFFFFFB8;
        local_x8->field_0 = local_pFFFFFFFFFFFFFFB8;
        load_187 = var_20;
        load_115 = var_20;
        local_x8->field_20 = load_187;
        local_x8->field_20 = load_187;
        load_92 = global_12FE8;
        load_107 = var_58;
        load_94 = memory_unknown;
        if ((uint64_t)load_107 != (uint64_t)load_94) goto loc_1328;
        goto loc_1320;
    loc_1320:
        return;
    loc_1328:
        unknown_call(load_92);
}
void call_ret_large_struct(void)
{
    uint32 load_18;
    uint32 load_44;
    uint64 load_72;
    uint64 load_107;
    uint64 load_110;
    loc_132C:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        ret_large_struct(/* arguments unknown */);
        load_44 = var_FFFFFFFFFFFFFFB8;
        load_18 = var_FFFFFFFFFFFFFFF4;
        load_72 = global_12FE8;
        load_107 = var_58;
        load_110 = memory_unknown;
        if ((uint64_t)load_107 != (uint64_t)load_110) goto loc_1384;
        goto loc_137C;
    loc_137C:
        return;
    loc_1384:
        unknown_call(load_44 + load_18);
}
void ret_func_ptr(void)
{
    return;
}
void call_ret_func_ptr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    func_b(/* arguments unknown */);
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
    if ((uint32_t)a1 != 1) {
        if ((uint32_t)a1 != 2) {
        }
    }
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
    unknown_call(0x1870);
    unknown_call(1);
    call_ret_pointer(/* arguments unknown */);
    unknown_call(1);
    call_ret_small_struct(/* arguments unknown */);
    unknown_call(1);
    call_ret_large_struct(/* arguments unknown */);
    unknown_call(1);
    call_ret_func_ptr(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    return;
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
