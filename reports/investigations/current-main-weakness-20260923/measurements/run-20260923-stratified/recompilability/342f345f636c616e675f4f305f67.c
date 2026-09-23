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
    uint64 load_7;
    uint64 load_18;
    load_7 = var_0;
    load_18 = global_12FD8;
    unknown_call(load_18);
    unknown_call(load_18);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FD0;
    __asm("cbz x0, #0x7c4");
    return sub_740(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13060 != 0x13060) {
        if (!(global_12FC0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_34;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_34 = global_12FE0;
        if (!(load_34 == 0)) {
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
    if (!(global_13060 != 0)) {
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
void cdecl_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void call_cdecl(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    cdecl_func(/* arguments unknown */);
    return;
}
void stdcall_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void call_stdcall(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    stdcall_func(/* arguments unknown */);
    return;
}
void fastcall_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    return;
}
void call_fastcall(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    fastcall_func(/* arguments unknown */);
    return;
}
void call_thiscall(void)
{
    return;
}
void arm_aapcs_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    local_m14 = a5;
    return;
}
void call_arm_aapcs(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    arm_aapcs_func(/* arguments unknown */);
    return;
}
void mips_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    return;
}
void call_mips(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    mips_func(/* arguments unknown */);
    return;
}
void amd64_sysv_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    local_m14 = a5;
    local_m18 = a6;
    return;
}
void call_amd64_sysv(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    amd64_sysv_func(/* arguments unknown */);
    return;
}
void ms_x64_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    local_m14 = a5;
    return;
}
void call_ms_x64(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    ms_x64_func(/* arguments unknown */);
    return;
}
void vectorcall_func(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    return;
}
void call_vectorcall(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    vectorcall_func(/* arguments unknown */);
    return;
}
void mixed_conventions_test(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 0;
    cdecl_func(/* arguments unknown */);
    local_m14 += (uint32_t)call_55;
    stdcall_func(/* arguments unknown */);
    local_m14 += (uint32_t)call_99;
    fastcall_func(/* arguments unknown */);
    local_m14 += (uint32_t)call_148;
    return;
}
uint32 varargs_func(uint32 a1, int64 a2, int64 a3, int64 a4, int64 a5, int64 a6, int64 a7, int64 a8)
{
    uint64 var_8, var_10, var_A8, var_B0, var_B8, var_C0, var_C8, var_D0;
    uint64 var_D8, var_E8, var_F0, var_F8;
    uint32 var_1C, var_E0, var_E4, var_100, var_104, var_10C;
    vector128 var_20, var_30, var_40, var_50, var_60, var_70, var_80, var_90;

    var_90 = v7;
    var_80 = v6;
    var_70 = v5;
    var_60 = v4;
    var_50 = v3;
    var_40 = v2;
    var_30 = v1;
    var_20 = v0;
    var_D8 = a8;
    var_D0 = a7;
    var_C8 = a6;
    var_C0 = a5;
    var_B8 = a4;
    var_B0 = a3;
    var_A8 = a2;
    var_10C = (uint32)a1;
    var_E4 = 0;
    var_104 = 0xFFFFFF80;
    var_100 = 0xFFFFFFC8;
    var_F8 = &var_A0;
    var_F0 = &var_E0;
    x9 = &var_0 + 0x120;
    var_E8 = sp;
    var_E0 = 0;
    __asm("b #0xc60");
    __asm("b.ge #0xd00");
    __asm("b #0xc74");
    var_10 = &var_100;
    var_1C = (uint32)var_100;
    __asm("tbz w8, #0x1f, #0xcc4");
    __asm("b #0xc94");
    *(uint32 *)(var_10) = (uint32)((uint32)var_1C + 8);
    __asm("b.gt #0xcc4");
    __asm("b #0xcb0");
    var_8 = var_F0 + (int32)(uint32)var_1C;
    __asm("b #0xcd8");
    var_E8 = x8 + 8;
    var_8 = var_E8;
    __asm("b #0xcd8");
    var_E4 = (uint32)((uint32)var_E4 + (uint32)*(uint32 *)(var_8));
    __asm("b #0xcf0");
    var_E0 = (uint32)((uint32)var_E0 + 1);
    __asm("b #0xc60");
    return (uint32)var_E4;
}
void func_no_args(void)
{
    return;
}
void func_many_args(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    local_m10 = a4;
    local_m14 = a5;
    local_m18 = a6;
    local_m1C = a7;
    local_m20 = a8;
    return;
}
double func_mixed_args(uint64 a1, int64 a2, int64 a3)
{
    uint64 var_20;
    uint32 var_2C, var_C;
    double var_10, var_18;

    var_2C = (uint32)a1;
    var_20 = a2;
    var_18 = v0;
    var_10 = a3;
    __asm("cbz var_20, #0xdb8");
    __asm("b #0xda8");
    x0 = sub_700(var_20);
    var_0 = x0;
    __asm("b #0xdc4");
    var_0 = 0;
    __asm("b #0xdc4");
    var_C = (uint32)*(uint64 *)(sp);
    v0 = (double)(int32)((uint32)((uint32)var_2C + (uint32)*(uint64 *)(sp)));
    v1 = (double)var_10;
    x0 = (int64)v0 + var_18 + v1;
    return x0;
}
void func_struct_byval(void)
{
    local_m18 = a1;
    local_m8 = 0;
    local_mC = 0;
    while ((int32_t)var_14 < 16) {
        local_m8 += local_m18[(int64_t)local_mC];
        local_mC++;
        continue;
    }
    return;
}
void func_struct_byptr(void)
{
    local_m10 = a1;
    if (var_0 != 0) {
        local_m4 = a1->field_0 * a1->field_4;
    } else {
        local_m4 = 0xFFFFFFFF;
    }
    return;
}
void test_calling_conventions(void)
{
    uint32 load_74;
    uint32 load_273;
    uint32 load_308;
    uint32 load_318;
    uint32 load_411;
    uint64 load_684;
    uint64 load_154;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x28;
    local_m160 = var_1233 - 0x180 + 0x160 - 24;
    unknown_call("=== 测试基础调用约定 ===\\n");
    call_cdecl(/* arguments unknown */);
    unknown_call("CALL-L1-01: %d\\n");
    call_stdcall(/* arguments unknown */);
    unknown_call("CALL-L1-02: %d\\n");
    call_fastcall(/* arguments unknown */);
    unknown_call("CALL-L1-03: %d\\n");
    call_thiscall(/* arguments unknown */);
    unknown_call("CALL-L1-04: %d\\n");
    call_arm_aapcs(/* arguments unknown */);
    unknown_call("CALL-L1-05: %d\\n");
    call_mips(/* arguments unknown */);
    unknown_call("CALL-L1-06: %d\\n");
    call_amd64_sysv(/* arguments unknown */);
    unknown_call("CALL-L1-07: %d\\n");
    call_ms_x64(/* arguments unknown */);
    unknown_call("CALL-L1-08: %d\\n");
    call_vectorcall(/* arguments unknown */);
    unknown_call("CALL-L1-09: %d\\n");
    mixed_conventions_test(/* arguments unknown */);
    unknown_call("CALL-L1-10: %d\\n");
    local_m168 = 5;
    local_m164 = 1;
    local_m174 = 2;
    local_m170 = 3;
    local_m16C = 4;
    varargs_func(/* arguments unknown */);
    local_m24 = call_477;
    load_273 = var_m24;
    unknown_call("CALL-L2-06：varargs_func(5, 1-5) = %d\\n");
    func_no_args(/* arguments unknown */);
    local_m28 = call_518;
    unknown_call("CALL-L2-07：func_no_args() = %d\\n");
    load_411 = var_m170;
    load_318 = var_m16C;
    load_74 = var_m168;
    func_many_args(/* arguments unknown */);
    local_m2C = call_619;
    unknown_call("CALL-L2-08：func_many_args(1-8) = %d\\n");
    load_154 = var_20;
    memory_unknown = 0x1EF3;
    load_684 = global_1DA8;
    func_mixed_args(/* arguments unknown */);
    local_m3C = call_716;
    unknown_call("CALL-L2-09：func_mixed_args(...) = %d\\n");
    local_mC4 = 0;
    while ((int32_t)var_mC4 < 16) {
        (var_1233 - 0x180 + 0x160 - 0xA0)[(int64_t)local_mC4] = (int64_t)(local_mC4 + 1);
        local_mC4++;
        continue;
    }
    local_m180 = var_1233 - 0x180 + 56;
    unknown_call((sp - 0x180) + 56);
    func_struct_byval(/* arguments unknown */);
    local_mC8 = call_918;
    load_308 = var_mC8;
    unknown_call("CALL-L2-10：func_struct_byval(large) = %d\\n");
    local_m150 = global_1DB0;
    func_struct_byptr(/* arguments unknown */);
    local_m154 = call_996;
    unknown_call("CALL-L2-11：func_struct_byptr({5,10}) = %d\\n");
    return;
}
void param_by_value_int(void)
{
    local_m4 = a1;
    local_m4 = ((uint32_t)(uint32_t)a1 << 1);
    return;
}
void call_by_value_int(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 5;
    param_by_value_int(/* arguments unknown */);
    local_m18 = call_59;
    return;
}
void param_by_value_ptr(void)
{
    local_m8 = a1;
    a1->field_0 = ((uint32_t)a1->field_0 << 1);
    local_m8 = 0;
    return;
}
void call_by_value_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 5;
    local_m20 = var_106 - 48 + 32 - 4;
    param_by_value_ptr(/* arguments unknown */);
    local_m24 = call_77;
    return;
}
void param_array_decay(void)
{
    local_m8 = a1;
    local_mC = a2;
    return;
}
void call_array_decay(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m40 = var_78 - 64 + 8;
    unknown_call((sp - 64) + 8);
    param_array_decay(/* arguments unknown */);
    return;
}
void param_string(void)
{
    local_m8 = a1;
    return;
}
void call_string_param(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_string(/* arguments unknown */);
    return;
}
void param_ptr_array(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 = local_m10 + memory_unknown;
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void call_ptr_array(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = global_12DC0;
    local_m20 = global_12DD0;
    param_ptr_array(/* arguments unknown */);
    return;
}
uint32 param_varargs(uint32 a1, int64 a2, int64 a3, int64 a4, int64 a5, int64 a6, int64 a7, int64 a8)
{
    uint64 var_8, var_10, var_A8, var_B0, var_B8, var_C0, var_C8, var_D0;
    uint64 var_D8, var_E8, var_F0, var_F8;
    uint32 var_1C, var_E0, var_E4, var_100, var_104, var_10C;
    vector128 var_20, var_30, var_40, var_50, var_60, var_70, var_80, var_90;

    var_90 = v7;
    var_80 = v6;
    var_70 = v5;
    var_60 = v4;
    var_50 = v3;
    var_40 = v2;
    var_30 = v1;
    var_20 = v0;
    var_D8 = a8;
    var_D0 = a7;
    var_C8 = a6;
    var_C0 = a5;
    var_B8 = a4;
    var_B0 = a3;
    var_A8 = a2;
    var_10C = (uint32)a1;
    var_104 = 0xFFFFFF80;
    var_100 = 0xFFFFFFC8;
    var_F8 = &var_A0;
    var_F0 = &var_E0;
    x8 = &var_0 + 0x120;
    var_E8 = sp;
    var_E4 = 0;
    var_E0 = 0;
    __asm("b #0x13a4");
    __asm("b.ge #0x1444");
    __asm("b #0x13b8");
    var_10 = &var_100;
    var_1C = (uint32)var_100;
    __asm("tbz w8, #0x1f, #0x1408");
    __asm("b #0x13d8");
    *(uint32 *)(var_10) = (uint32)((uint32)var_1C + 8);
    __asm("b.gt #0x1408");
    __asm("b #0x13f4");
    var_8 = var_F0 + (int32)(uint32)var_1C;
    __asm("b #0x141c");
    var_E8 = x8_2 + 8;
    var_8 = var_E8;
    __asm("b #0x141c");
    var_E4 = (uint32)((uint32)var_E4 + (uint32)*(uint32 *)(var_8));
    __asm("b #0x1434");
    var_E0 = (uint32)((uint32)var_E0 + 1);
    __asm("b #0x13a4");
    return (uint32)var_E4;
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
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call(var_4);
    return;
}
void call_func_ptr_param(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_func_ptr(/* arguments unknown */);
    return;
}
void callback_func(void)
{
    local_m4 = a1;
    return;
}
void param_double_ptr(void)
{
    local_m10 = a1;
    local_m14 = a2;
    if (var_10 == 0) {
        local_m4 = 0xFFFFFFFF;
    } else {
        if (var_10->field_0 != 0) {
            memory_unknown = local_m14;
            memory_unknown = 0;
            local_m4 = 1;
        } else {
            goto loc_150C;
        }
    }
    return;
}
void call_double_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 10;
    local_m20 = var_135 - 48 + 32 - 4;
    param_double_ptr(/* arguments unknown */);
    local_m24 = call_83;
    return;
}
void param_complex_cast(void)
{
    local_m10 = a1;
    local_m14 = a2;
    if (a2 != 0) {
        if ((uint32_t)a2 != 1) {
            local_m4 = 0xFFFFFFFF;
        } else {
            local_m38 = a1;
            local_m4 = memory_unknown + memory_unknown;
        }
    } else {
        local_m20 = a1;
        local_m28 = local_m20;
        local_m30 = local_m28;
        local_m4 = memory_unknown;
    }
    return;
}
void call_complex_cast(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m28 = var_135 - 48 + 32 - 4;
    local_m14 = bit_insert(0x5678, 0x1234, 16, 16);
    local_m20 = global_1DB8;
    param_complex_cast(/* arguments unknown */);
    param_complex_cast(/* arguments unknown */);
    return;
}
void param_struct_byval(void)
{
    return;
}
void call_struct_byval(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m54 = 0;
    while ((int32_t)var_m54 < 16) {
        (var_226 - 0xA0 + 0x90 - 64)[(int64_t)local_m54] = local_m54;
        local_m54++;
        continue;
    }
    local_mA0 = var_226 - 0xA0 + 12;
    unknown_call((sp - 0xA0) + 12);
    param_struct_byval(/* arguments unknown */);
    return;
}
void param_order_dep(void)
{
    local_m4 = a1;
    local_m8 = a2;
    return;
}
void call_order_dep(void)
{
    uint32 load_52;
    uint32 load_69;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 0;
    load_52 = var_m14;
    local_m14 = load_52 + 1;
    load_69 = var_m14;
    local_m14 = load_69 + 1;
    param_order_dep(/* arguments unknown */);
    return;
}
void test_parameter_passing(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试参数传递模式 ===\\n");
    call_by_value_int(/* arguments unknown */);
    unknown_call("PARAM-L1-01: %d\\n");
    call_by_value_ptr(/* arguments unknown */);
    unknown_call("PARAM-L1-02: %d\\n");
    call_array_decay(/* arguments unknown */);
    unknown_call("PARAM-L2-01: %d\\n");
    call_string_param(/* arguments unknown */);
    unknown_call("PARAM-L2-02: %d\\n");
    call_ptr_array(/* arguments unknown */);
    unknown_call("PARAM-L2-03: %d\\n");
    call_varargs_param(/* arguments unknown */);
    unknown_call("PARAM-L2-04: %d\\n");
    call_func_ptr_param(/* arguments unknown */);
    unknown_call("PARAM-L3-01: %d\\n");
    call_double_ptr(/* arguments unknown */);
    unknown_call("PARAM-L3-02: %d\\n");
    call_complex_cast(/* arguments unknown */);
    unknown_call("PARAM-L3-03: %d\\n");
    call_struct_byval(/* arguments unknown */);
    unknown_call("PARAM-L3-04: %d\\n");
    call_order_dep(/* arguments unknown */);
    unknown_call("PARAM-L3-05: %d\\n");
    return;
}
void ret_basic_type(void)
{
    local_m4 = a1;
    return;
}
void call_ret_basic(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 21;
    ret_basic_type(/* arguments unknown */);
    local_m18 = call_59;
    return;
}
void ret_pointer(void)
{
    local_m8 = a1;
    return;
}
void call_ret_pointer(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = global_2184;
    local_m18 = global_218C;
    ret_pointer(/* arguments unknown */);
    local_m28 = call_92;
    return;
}
void ret_small_struct(void)
{
    local_mC = a1;
    local_m10 = a2;
    local_m8 = (uint32_t)a1;
    local_m4 = (uint32_t)a2;
    return;
}
void call_ret_small_struct(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    ret_small_struct(/* arguments unknown */);
    local_m18 = call_48;
    return;
}
void ret_large_struct(void)
{
    local_m10 = local_x8;
    local_m4 = a1;
    local_m8 = 0;
    while ((int32_t)var_8 < 16) {
        local_m10[(int64_t)local_m8] = local_m4 + local_m8;
        local_m8++;
        continue;
    }
    return;
}
void call_ret_large_struct(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    ret_large_struct(/* arguments unknown */);
    return;
}
void func_a(void)
{
    local_m4 = a1;
    return;
}
void func_b(void)
{
    local_m4 = a1;
    return;
}
void ret_func_ptr(void)
{
    local_m4 = a1;
    return;
}
void call_ret_func_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    ret_func_ptr(/* arguments unknown */);
    local_m18 = call_43;
    unknown_call(5);
    return;
}
void ret_opaque_handle(void)
{
    local_m4 = a1;
    return;
}
void call_ret_opaque(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    ret_opaque_handle(/* arguments unknown */);
    local_m18 = call_43;
    return;
}
void ret_complex_expr(void)
{
    local_m4 = a1;
    local_m8 = a2;
    local_mC = a3;
    if ((int32_t)a1 <= (int32_t)a2) {
        local_m10 = (uint32_t)a3 + 10;
    } else {
        local_m10 = ((uint32_t)(uint32_t)a3 << 1);
    }
    return;
}
void call_ret_complex_expr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m24 = 5;
    local_m1C = 3;
    local_m20 = 10;
    ret_complex_expr(/* arguments unknown */);
    local_m14 = (uint32_t)call_79;
    ret_complex_expr(/* arguments unknown */);
    local_m18 = call_125;
    return;
}
void ret_multi_branch(void)
{
    local_m8 = a1;
    local_mC = (uint32_t)a1;
    if (a1 == 0) {
        local_m4 = 10;
    } else {
        if ((uint32_t)a1 == 1) {
            local_m4 = 20;
        } else {
            if ((uint32_t)a1 == 2) {
                local_m4 = 30;
            } else {
                local_m4 = 0xFFFFFFFF;
            }
        }
    }
    return;
}
void call_ret_multi_branch(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = 0;
    ret_multi_branch(/* arguments unknown */);
    local_m14 += (uint32_t)call_50;
    ret_multi_branch(/* arguments unknown */);
    local_m14 += (uint32_t)call_89;
    ret_multi_branch(/* arguments unknown */);
    local_m14 += (uint32_t)call_128;
    return;
}
void ret_void(void)
{
    local_m4 = a1;
    local_m10 = a2;
    a2->field_0 = local_m4 * 3;
    return;
}
void call_ret_void(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    ret_void(/* arguments unknown */);
    return;
}
void test_return_values(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试返回值处理 ===\\n");
    call_ret_basic(/* arguments unknown */);
    unknown_call("RET-L1-01: %d (期望: 42)\\n");
    call_ret_pointer(/* arguments unknown */);
    unknown_call("RET-L1-02: %d (期望: 20)\\n");
    call_ret_small_struct(/* arguments unknown */);
    unknown_call("RET-L1-03: %d (期望: 7)\\n");
    call_ret_large_struct(/* arguments unknown */);
    unknown_call("RET-L1-04: %d (期望: 215)\\n");
    call_ret_func_ptr(/* arguments unknown */);
    unknown_call("RET-L2-01: %d (期望: 10)\\n");
    call_ret_opaque(/* arguments unknown */);
    unknown_call("RET-L2-02: %d (期望: 100)\\n");
    call_ret_complex_expr(/* arguments unknown */);
    unknown_call("RET-L3-01: %d (期望: 40)\\n");
    call_ret_multi_branch(/* arguments unknown */);
    unknown_call("RET-L3-02: %d (期望: 60)\\n");
    call_ret_void(/* arguments unknown */);
    unknown_call("RET-L3-03: %d (期望: 21)\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
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
