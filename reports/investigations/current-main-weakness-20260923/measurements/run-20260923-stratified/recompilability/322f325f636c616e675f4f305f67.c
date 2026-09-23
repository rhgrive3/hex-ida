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
    uint64 load_18;
    uint64 load_26;
    load_18 = var_0;
    load_26 = global_14FD8;
    unknown_call(load_26);
    unknown_call(load_26);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x14FD0;
    __asm("cbz x0, #0x784");
    return sub_6E0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x15048 != 0x15048) {
        if (!(global_14FC0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_53;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_53 = global_14FE0;
        if (!(load_53 == 0)) {
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
    if (!(global_15048 != 0)) {
        if (!(global_14FC8 == 0)) {
            unknown_call(global_15040);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void process_char(void)
{
    local_m2 = (uint32_t)a1;
    if ((int32_t)a1 < 65) {
        local_m1 = (uint8_t)(uint32_t)a1;
    } else {
        if ((int32_t)a1 > 90) {
            goto loc_88C;
        } else {
            local_m1 = (uint8_t)(uint32_t)a1 + 32;
        }
    }
    return;
}
void process_short(void)
{
    local_m2 = (uint32_t)a1;
    local_m4 = (uint32_t)a2;
    return;
}
void process_int(void)
{
    local_m4 = a1;
    return;
}
void process_long(void)
{
    local_m8 = a1;
    return;
}
void process_ll(void)
{
    local_m8 = a1;
    return;
}
void process_float(void)
{
    float var_C;

    var_C = v0;
    v0 = var_C;
    return;
}
void process_double(void)
{
    double var_8;

    var_8 = v0;
    v0 = var_8;
    return;
}
void process_ld(void)
{
    uint64 load_64;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = var_82;
    load_64 = var_0;
    multf3(/* arguments unknown */);
}
void process_bool(void)
{
    local_m4 = a1;
    local_m8 = 0;
    if ((int32_t)a1 > 0) {
        local_m8 = (uint32_t)((uint32_t)a1 - (int32_t)(uint32_t)a1 / 2 * 2) == 0 ? 1 : 0;
    }
    return;
}
void const_param(void)
{
    local_m8 = a1;
    return;
}
void volatile_access(void)
{
    local_m8 = a1;
    local_mC = a1->field_0;
    local_m10 = a1->field_0;
    return;
}
uint64 test_data_types_l1(void)
{
    uint32 var_24, var_28, var_2C;
    uint64 var_8, var_10, var_18;

    x0_1 = sub_700("=== 测试基础数据类型 ===\\n");
    x0_2 = process_char(65);
    x0_3 = "DT-L1-01 (process_char): %c\\n";
    var_8 = x0_3;
    x0_4 = sub_700(x0_3, (uint32)((uint32)x0_2 & 255));
    x0_5 = process_char(98);
    x0_6 = sub_700(x0_3, (uint32)((uint32)x0_5 & 255));
    x0_7 = process_short(100, 200);
    x0_8 = sub_700("DT-L1-02 (process_short): %d\\n", (uint32)(int16)(uint32)x0_7);
    var_24 = 5;
    x0_9 = process_int(5);
    x0_10 = sub_700("DT-L1-03 (process_int): %d\\n", (uint32)x0_9);
    x0_11 = 100;
    var_10 = x0_11;
    x0_12 = process_long(x0_11);
    x0_13 = sub_700("DT-L1-04 (process_long): %ld\\n", x0_12);
    x0_14 = process_ll(x0_11);
    x0_15 = sub_700("DT-L1-05 (process_ll): %lld\\n", x0_14);
    x0_16 = process_float(x0_15);
    v0 = (double)v0;
    x0_17 = sub_700("DT-L1-06 (process_float): %.2f\\n");
    x0_18 = process_double(x0_17);
    x0_19 = sub_700("DT-L1-07 (process_double): %.2f\\n");
    x0_20 = process_ld(x0_19);
    x0_21 = sub_700("DT-L1-08 (process_ld): %.2Lf\\n");
    x0_22 = process_bool(4);
    x0_23 = "DT-L1-09 (process_bool): %d\\n";
    var_18 = x0_23;
    x0_24 = sub_700(x0_23, (uint32)((uint32)x0_22 & 1));
    x0_25 = process_bool(3);
    x0_26 = sub_700(x0_23, (uint32)((uint32)x0_25 & 1));
    x0_27 = process_bool(0xFFFFFFFE);
    x0_28 = sub_700(x0_23, (uint32)((uint32)x0_27 & 1));
    var_2C = 5;
    x0_29 = const_param(&var_2C);
    x0_30 = sub_700("DT-L1-10 (const_param): %d\\n", (uint32)x0_29);
    var_28 = 10;
    x0_31 = volatile_access(&var_28);
    x0_32 = sub_700("DT-L1-11 (volatile_access): %d\\n", (uint32)x0_31);
    return x0_32;
}
void array_1d_stack(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 = local_m10 + local_m8[(int64_t)local_m14];
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void array_string(void)
{
    local_m8 = a1;
    local_mC = 0;
    while (!(var_8[sext(var_4)] == 0)) {
        local_mC++;
        continue;
    }
    return;
}
void array_2d_stack(void)
{
    local_m8 = a1;
    local_mC = 0;
    local_m10 = 0;
    while ((int32_t)var_0 < 10) {
        local_mC = local_mC + (local_m8 + (int64_t)local_m10 * 40)[(int64_t)local_m10];
        local_m10 = local_m10 + 1;
        continue;
    }
    return;
}
void array_3d(void)
{
    local_m8 = a1;
    local_mC = 0;
    local_m10 = 0;
    while ((int32_t)var_10 < 5) {
        local_m14 = 0;
        while ((int32_t)var_C < 5) {
            local_m18 = 0;
            while ((int32_t)var_8 < 5) {
                local_mC = local_mC + (local_m8 + (int64_t)local_m10 * 0x64 + (int64_t)local_m14 * 20)[(int64_t)local_m18];
                local_m18 = local_m18 + 1;
                continue;
            }
            local_m14 = local_m14 + 1;
            continue;
        }
        local_m10 = local_m10 + 1;
        continue;
    }
    return;
}
void array_vla(void)
{
    local_m4 = a1;
    local_m10 = a2;
    local_m14 = 0;
    local_m18 = 0;
    while ((int32_t)var_8 < (int32_t)var_1C) {
        local_m14 = local_m14 + local_m10[(int64_t)local_m18];
        local_m18 = local_m18 + 1;
        continue;
    }
    return;
}
void array_pointer(void)
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
void pointer_array(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    if ((int32_t)a2 >= 10) {
        local_m1C = 10;
    } else {
        local_m1C = (uint32_t)a2;
    }
    local_m14 = local_m1C;
    local_m18 = 0;
    while ((int32_t)var_8 < (int32_t)var_C) {
        if (!(var_18[sext(var_8)] == 0)) {
            local_m10 = local_m10 + memory_unknown;
        }
        local_m18 = local_m18 + 1;
        continue;
    }
    return;
}
void array_complex_index(void)
{
    local_m10 = a1;
    local_m14 = a2;
    local_m18 = a3;
    local_m1C = a4;
    local_m20 = a5;
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m4 = 0xFFFFFFFF;
    } else {
        if ((int32_t)a4 >= (int32_t)a2) {
            goto loc_F80;
        } else {
            if (__arm64_condition_unknown(/* NZCV */)) {
                goto loc_F80;
            } else {
                if ((int32_t)a5 < (int32_t)a3) {
                    local_m4 = a1[local_x9];
                } else {
                    goto loc_F80;
                }
            }
        }
    }
    return;
}
void array_oob(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C <= (int32_t)var_14) {
        local_m10 = local_m10 + local_m8[(int64_t)local_m14];
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void test_array_types(void)
{
    uint64 load_565;
    uint64 load_53;
    uint64 load_521;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x28;
    local_pFFFFFFFFFFFFFA88 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0x1A0;
    unknown_call("=== 测试数组类型 ===\\n");
    load_565 = global_3670;
    memory_unknown = load_565;
    local_pFFFFFFFFFFFFFFD0 = global_3680;
    array_1d_stack(/* arguments unknown */);
    unknown_call("ARR-L1-01 (array_1d_stack): %d\\n");
    local_pFFFFFFFFFFFFFFB8 = global_3900;
    local_pFFFFFFFFFFFFFFBC = global_3904;
    array_string(/* arguments unknown */);
    unknown_call("ARR-L1-02 (array_string): %d\\n");
    local_pFFFFFFFFFFFFFE24 = 0;
    while ((int32_t)var_FFFFFFFFFFFFFE24 < 10) {
        local_pFFFFFFFFFFFFFE20 = 0;
        while ((int32_t)var_FFFFFFFFFFFFFE20 < 10) {
            if ((uint32_t)var_FFFFFFFFFFFFFE24 != (uint32_t)var_FFFFFFFFFFFFFE20) {
                local_pFFFFFFFFFFFFFA84 = 0;
            } else {
                local_pFFFFFFFFFFFFFA84 = local_pFFFFFFFFFFFFFE24;
            }
            (var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0x3B8 + (int64_t)local_pFFFFFFFFFFFFFE24 * 40)[(int64_t)local_pFFFFFFFFFFFFFE20] = local_pFFFFFFFFFFFFFA84;
            local_pFFFFFFFFFFFFFE20++;
            continue;
        }
        local_pFFFFFFFFFFFFFE24++;
        continue;
    }
    array_2d_stack(/* arguments unknown */);
    unknown_call("ARR-L1-03 (array_2d_stack): %d\\n");
    local_pFFFFFFFFFFFFFC28 = 0;
    while ((int32_t)var_FFFFFFFFFFFFFC28 < 5) {
        local_pFFFFFFFFFFFFFC24 = 0;
        while ((int32_t)var_FFFFFFFFFFFFFC24 < 5) {
            local_pFFFFFFFFFFFFFC20 = 0;
            while ((int32_t)var_FFFFFFFFFFFFFC20 < 5) {
                (var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0x1BC + (int64_t)local_pFFFFFFFFFFFFFC28 * 0x64 + (int64_t)local_pFFFFFFFFFFFFFC24 * 20)[(int64_t)local_pFFFFFFFFFFFFFC20] = 1;
                local_pFFFFFFFFFFFFFC20++;
                continue;
            }
            local_pFFFFFFFFFFFFFC24++;
            continue;
        }
        local_pFFFFFFFFFFFFFC28++;
        continue;
    }
    array_3d(/* arguments unknown */);
    unknown_call("ARR-L1-04 (array_3d): %d\\n");
    memory_unknown = global_3684;
    local_pFFFFFFFFFFFFFC18 = global_368C;
    array_vla(/* arguments unknown */);
    unknown_call("ARR-L2-01 (array_vla): %d\\n");
    local_pFFFFFFFFFFFFFB44 = 0;
    while ((int32_t)var_FFFFFFFFFFFFFB44 < 5) {
        memory_unknown = local_pFFFFFFFFFFFFFB44 * 10;
        local_pFFFFFFFFFFFFFB44++;
        continue;
    }
    array_pointer(/* arguments unknown */);
    unknown_call("ARR-L2-02 (array_pointer): %d\\n");
    local_pFFFFFFFFFFFFFB40 = 10;
    local_pFFFFFFFFFFFFFB3C = 20;
    local_pFFFFFFFFFFFFFB38 = 30;
    local_pFFFFFFFFFFFFFAE8 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0xD0;
    local_pFFFFFFFFFFFFFAF0 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0xCC;
    local_pFFFFFFFFFFFFFAF8 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0xC8;
    local_pFFFFFFFFFFFFFB00 = 0;
    local_pFFFFFFFFFFFFFA70 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0x78 + 80;
    local_pFFFFFFFFFFFFFA78 = var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 0x78 + 32;
    load_53 = var_FFFFFFFFFFFFFA78;
    load_521 = var_FFFFFFFFFFFFFA70;
    memory_unknown = 0;
    local_pFFFFFFFFFFFFFA78 = load_53 + 8;
    while ((uint64_t)load_53 + 8 != (uint64_t)load_521) {
    }
    pointer_array(/* arguments unknown */);
    unknown_call("ARR-L2-03 (pointer_array): %d\\n");
    local_pFFFFFFFFFFFFFA94 = 0;
    while ((int32_t)var_FFFFFFFFFFFFFA94 < 20) {
        (var_1626 + 0xFFFFFFFFFFFFFFE0 - 0x570 + 40)[(int64_t)local_pFFFFFFFFFFFFFA94] = local_pFFFFFFFFFFFFFA94;
        local_pFFFFFFFFFFFFFA94++;
        continue;
    }
    array_complex_index(/* arguments unknown */);
    unknown_call("ARR-L2-04 (array_complex_index): %d\\n");
    return;
}
void ptr_single(void)
{
    local_m8 = a1;
    return;
}
void ptr_double(void)
{
    local_m8 = a1;
    return;
}
void ptr_triple(void)
{
    local_m8 = a1;
    return;
}
void ptr_increment(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 = local_m10 + memory_unknown;
        local_m8 = local_m8 + 4;
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void ptr_offset(void)
{
    local_m8 = a1;
    local_mC = a2;
    return;
}
void ptr_diff(void)
{
    local_m8 = a1;
    local_m10 = a2;
    return;
}
void ptr_void(void)
{
    local_m10 = a1;
    local_m14 = a2;
    if (var_C != 0) {
        if ((uint32_t)var_C != 1) {
            local_m4 = 0xFFFFFFFF;
        } else {
            local_m4 = a1->field_0;
        }
    } else {
        local_m4 = a1->field_0;
    }
    return;
}
void ptr_const(void)
{
    local_m8 = a1;
    return;
}
void ptr_const_ptr(void)
{
    local_m8 = a1;
    a1->field_0 += 5;
    return;
}
void ptr_func_simple(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call(var_4);
    return;
}
void ptr_func_complex(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = global_14DB8;
    unknown_call(var_10);
    return;
}
void ptr_cast(void)
{
    local_m8 = a1;
    local_m10 = a1;
    local_m18 = a1;
    local_m20 = a1;
    return;
}
void opaque_handle_create(void)
{
    local_m4 = a1;
    return;
}
void opaque_handle_op(void)
{
    local_m8 = a1;
    return;
}
void test_pointer_types(void)
{
    uint64 load_446;
    uint64 load_105;
    uint64 load_127;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("=== 测试指针类型 ===\\n");
    local_mC8 = 5;
    local_m14 = 5;
    ptr_single(/* arguments unknown */);
    unknown_call("PTR-L2-01 (ptr_single): %d\\n");
    local_mC4 = 10;
    local_m18 = 10;
    local_m20 = var_909 - 0xE0 + 0xD0 - 8;
    local_m28 = var_909 - 0xE0 + 0xD0 - 16;
    ptr_double(/* arguments unknown */);
    unknown_call("PTR-L2-02 (ptr_double): %d\\n");
    local_m2C = local_mC8;
    local_m38 = var_909 - 0xE0 + 0xD0 - 28;
    local_m40 = var_909 - 0xE0 + 0xD0 - 40;
    local_m48 = var_909 - 0xE0 + 0xD0 - 48;
    ptr_triple(/* arguments unknown */);
    unknown_call("PTR-L2-03 (ptr_triple): %d\\n");
    load_446 = global_3690;
    local_m60 = load_446;
    local_m50 = global_36A0;
    ptr_increment(/* arguments unknown */);
    unknown_call("PTR-L2-04 (ptr_increment): %d\\n");
    load_105 = global_36A4;
    local_m80 = load_105;
    local_m70 = global_36B4;
    ptr_offset(/* arguments unknown */);
    unknown_call("PTR-L2-05 (ptr_offset): %d\\n");
    load_127 = global_36B8;
    local_mA0 = load_127;
    local_m90 = global_36C8;
    ptr_diff(/* arguments unknown */);
    unknown_call("PTR-L2-06 (ptr_diff): %d\\n");
    local_mA4 = 42;
    local_mD8 = var_909 - 0xE0 + 59;
    local_mA5 = 65;
    ptr_void(/* arguments unknown */);
    local_mD0 = 0x3AA6;
    unknown_call(0x3AA6);
    ptr_void(/* arguments unknown */);
    unknown_call(var_mD0);
    local_mAC = local_mC4;
    ptr_const(/* arguments unknown */);
    unknown_call("PTR-L2-08 (ptr_const): %d\\n");
    local_mB0 = local_mC4;
    ptr_const_ptr(/* arguments unknown */);
    unknown_call("PTR-L2-09 (ptr_const_ptr): %d\\n");
    ptr_func_simple(/* arguments unknown */);
    unknown_call("PTR-L2-10 (ptr_func_simple): %d\\n");
    local_mB4 = local_mC8;
    ptr_func_complex(/* arguments unknown */);
    unknown_call("PTR-L2-11 (ptr_func_complex): %d\\n");
    local_mB8 = bit_insert(0x5678, 0x1234, 16, 16);
    ptr_cast(/* arguments unknown */);
    unknown_call("PTR-L2-12 (ptr_cast): 0x%x\\n");
    opaque_handle_create(/* arguments unknown */);
    local_mC0 = call_1046;
    opaque_handle_op(/* arguments unknown */);
    unknown_call("PTR-L2-13 (opaque_handle_op): %d\\n");
    return;
}
void double_value(void)
{
    local_m4 = a1;
    return;
}
void complex_callback(void)
{
    local_m8 = a1;
    local_m10 = a2;
    a1->field_0 += 10;
    return;
}
void struct_simple(void)
{
    local_m8 = a1;
    return;
}
void struct_array(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 = local_m10 + memory_unknown + memory_unknown + memory_unknown;
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void struct_nested(void)
{
    local_m8 = a1;
    return;
}
void struct_deep(void)
{
    local_m8 = a1;
    return;
}
void struct_with_ptr(void)
{
    local_m8 = a1;
    local_mC = a1->field_0;
    if (var_8->field_8 == 0) {
        local_m10 = 0;
    } else {
        local_m10 = memory_unknown;
    }
    return;
}
void struct_bitfields(void)
{
    local_m8 = a1;
    return;
}
void union_type(void)
{
    local_m10 = a1;
    local_m14 = a2;
    if (var_C != 0) {
        if ((uint32_t)var_C != 1) {
            local_m4 = a1->field_0;
        } else {
            __asm("fcvtzs w8, s0");
            local_m4 = var_130;
        }
    } else {
        local_m4 = a1->field_0;
    }
    return;
}
void union_array(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = 0;
    local_m14 = 0;
    while ((int32_t)var_C < (int32_t)var_14) {
        local_m10 = local_m10 + local_m8[(int64_t)local_m14];
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void enum_type(void)
{
    local_m4 = a1;
    return;
}
uint32 enum_switch(uint32 a1)
{
    uint32 var_8, var_C;

    var_8 = x8;
    var_0 = var_8;
    __asm("b.hi #0x1c38");
    __asm("br x8");
    var_C = 0;
    __asm("b #0x1c44");
    var_C = 100;
    __asm("b #0x1c44");
    var_C = 50;
    __asm("b #0x1c44");
    var_C = 0xFFFFFFFF;
    __asm("b #0x1c44");
    var_C = 0xFFFFFF9D;
    __asm("b #0x1c44");
    return (uint32)var_C;
}
void struct_func_ptr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(var_8->field_0);
    return;
}
void linked_list(void)
{
    local_m8 = a1;
    local_mC = 0;
    local_m18 = a1;
    while (!(var_8 == 0)) {
        local_mC += memory_unknown;
        local_m18 = memory_unknown;
        continue;
    }
    return;
}
void doubly_linked_list(void)
{
    local_m8 = a1;
    local_mC = 0;
    local_m18 = a1;
    while (!(var_8 == 0)) {
        local_mC += memory_unknown;
        local_m18 = memory_unknown;
        continue;
    }
    return;
}
void binary_tree_sum(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    if (var_10 != 0) {
        local_m28 = a1->field_0;
        binary_tree_sum(/* arguments unknown */);
        local_m24 = local_m28 + (uint32_t)call_155;
        binary_tree_sum(/* arguments unknown */);
        local_m14 = local_m24 + (uint32_t)call_206;
    } else {
        local_m14 = 0;
    }
    return;
}
void binary_tree(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    binary_tree_sum(/* arguments unknown */);
    return;
}
void graph_traverse(void)
{
    local_m8 = a1;
    local_mC = 0;
    local_m10 = 0;
    while ((int32_t)var_10 < (int32_t)memory_unknown) {
        local_m18 = local_m8[(int64_t)local_m10];
        while (!(var_8 == 0)) {
            local_mC = local_mC + memory_unknown;
            local_m18 = memory_unknown;
            continue;
        }
        local_m10 = local_m10 + 1;
        continue;
    }
    return;
}
void test_composite_types(void)
{
    uint64 load_887;
    uint64 load_816;
    uint64 load_1;
    uint32 load_1088;
    uint64 load_808;
    uint64 load_408;
    uint64 load_100;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x28;
    local_pFFFFFFFFFFFFFDF8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0xD0;
    unknown_call("=== 测试复合类型 ===\\n");
    local_pFFFFFFFFFFFFFFD0 = global_36CC;
    local_pFFFFFFFFFFFFFFD8 = global_36D4;
    struct_simple(/* arguments unknown */);
    unknown_call("CMP-L2-01 (struct_simple): %d\\n");
    load_887 = global_36D8;
    memory_unknown = load_887;
    local_pFFFFFFFFFFFFFFC0 = global_36E8;
    local_pFFFFFFFFFFFFFE1C = 2;
    struct_array(/* arguments unknown */);
    unknown_call("CMP-L2-02 (struct_array): %d\\n");
    load_816 = global_36F0;
    memory_unknown = load_816;
    local_pFFFFFFFFFFFFFFA0 = global_3700;
    struct_nested(/* arguments unknown */);
    unknown_call("CMP-L2-03 (struct_nested): %d\\n");
    local_pFFFFFFFFFFFFFDF0 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x80;
    unknown_call((sp + 0xFFFFFFFFFFFFFFE0) - 0x80);
    struct_deep(/* arguments unknown */);
    unknown_call("CMP-L2-04 (struct_deep): %d\\n");
    load_1 = global_3640;
    memory_unknown = load_1;
    local_pFFFFFFFFFFFFFE04 = 10;
    local_pFFFFFFFFFFFFFF40 = 10;
    local_pFFFFFFFFFFFFFF48 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x90;
    struct_with_ptr(/* arguments unknown */);
    unknown_call("CMP-L2-05 (struct_with_ptr): %d\\n");
    local_pFFFFFFFFFFFFFF38 = global_3610;
    struct_bitfields(/* arguments unknown */);
    unknown_call("CMP-L2-06 (struct_bitfields): %d\\n");
    local_pFFFFFFFFFFFFFF34 = global_3D64;
    local_pFFFFFFFFFFFFFE0C = 0;
    union_type(/* arguments unknown */);
    unknown_call("CMP-L2-07 (union_type): %d\\n");
    local_pFFFFFFFFFFFFFF28 = global_3734;
    local_pFFFFFFFFFFFFFF30 = global_373C;
    union_array(/* arguments unknown */);
    unknown_call("CMP-L2-08 (union_array): %d\\n");
    enum_type(/* arguments unknown */);
    unknown_call("CMP-L2-09 (enum_type): %d\\n");
    enum_switch(/* arguments unknown */);
    unknown_call("CMP-L2-10 (enum_switch): %d\\n");
    load_808 = global_14DC8;
    memory_unknown = load_808;
    struct_func_ptr(/* arguments unknown */);
    unknown_call("CMP-L2-11 (struct_func_ptr): %d\\n");
    local_pFFFFFFFFFFFFFEE0 = local_pFFFFFFFFFFFFFE04;
    local_pFFFFFFFFFFFFFEE8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0xF0 + 16;
    local_pFFFFFFFFFFFFFE08 = 20;
    local_pFFFFFFFFFFFFFEF0 = 20;
    local_pFFFFFFFFFFFFFEF8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0xF0 + 32;
    local_pFFFFFFFFFFFFFF00 = 30;
    local_pFFFFFFFFFFFFFF08 = 0;
    linked_list(/* arguments unknown */);
    unknown_call("CMP-L2-12 (linked_list): %d\\n");
    local_pFFFFFFFFFFFFFEB0 = local_pFFFFFFFFFFFFFE04;
    local_pFFFFFFFFFFFFFEB8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0xC0 + 24;
    local_pFFFFFFFFFFFFFEC0 = 0;
    local_pFFFFFFFFFFFFFEC8 = local_pFFFFFFFFFFFFFE08;
    local_pFFFFFFFFFFFFFED0 = 0;
    local_pFFFFFFFFFFFFFED8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0xC0;
    local_pFFFFFFFFFFFFFEB8 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0xC0 + 24;
    doubly_linked_list(/* arguments unknown */);
    unknown_call("CMP-L2-13 (doubly_linked_list): %d\\n");
    load_408 = global_3740;
    local_pFFFFFFFFFFFFFE90 = load_408;
    local_pFFFFFFFFFFFFFEA0 = global_3750;
    binary_tree(/* arguments unknown */);
    unknown_call("CMP-L2-14 (binary_tree): %d\\n");
    load_1088 = var_FFFFFFFFFFFFFE0C;
    load_100 = global_3650;
    local_pFFFFFFFFFFFFFE20 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 0x90;
    local_pFFFFFFFFFFFFFE80 = load_100;
    local_pFFFFFFFFFFFFFE10 = var_1306 + 0xFFFFFFFFFFFFFFE0 - 0x1F0 + 56;
    unknown_call(((sp + 0xFFFFFFFFFFFFFFE0) - 0x1F0) + 56);
    local_pFFFFFFFFFFFFFE28 = local_pFFFFFFFFFFFFFE20;
    local_pFFFFFFFFFFFFFE78 = local_pFFFFFFFFFFFFFE1C;
    local_pFFFFFFFFFFFFFE28 = local_pFFFFFFFFFFFFFE20;
    graph_traverse(/* arguments unknown */);
    unknown_call("CMP-L2-15 (graph_traverse): %d\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    test_data_types_l1(/* arguments unknown */);
    test_array_types(/* arguments unknown */);
    test_pointer_types(/* arguments unknown */);
    test_composite_types(/* arguments unknown */);
    return;
}
void addtf3(void)
{
    uint64 load_549;
    uint64 load_1253;
    uint64 load_1195;
    uint64 load_1721;
    loc_21D0:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_5211;
        local_pFFFFFFFFFFFFFFF0 = var_5172;
        load_549 = var_10;
        load_1253 = var_10;
        load_1195 = var_20;
        load_1721 = var_20;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if ((uint64_t)load_1253 >> 63 == (uint64_t)load_1721 >> 63) goto loc_23C0;
        goto loc_2230;
    loc_2230:
        if ((int32_t)(bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)) <= 0) goto loc_238C;
        goto loc_2240;
    loc_2240:
        if (bit_extract(load_1721, 48, 15) == 0) goto loc_2420;
        goto loc_2244;
    loc_2244:
    loc_2248:
        if ((uint64_t)bit_extract(load_1253, 48, 15) == 0x7FFF) goto loc_2694;
        goto loc_2254;
    loc_2254:
        if ((int32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) > 0x74) goto loc_2684;
        goto loc_225C;
    loc_225C:
        if ((int32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) > 63) goto loc_2808;
        goto loc_2264;
    loc_2264:
    loc_2290:
    loc_229C:
        if (bit_extract(phi(((v3275 | (load_549 >> 61)) + (~(v154 | (load_1195 >> 61)))) + (bit_extract(((load_549 << 3) & (~(load_1195 << 3))) | (((load_549 << 3) | (~(load_1195 << 3))) & (~((load_549 << 3) - (load_1195 << 3)))), 63, 1)), ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) - ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_549 << 3) & (~(phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0))))) | (((load_549 << 3) | (~(phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0))))) & (~((load_549 << 3) - (phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0)))))), 63, 1)), ((v154 | (load_1195 >> 61)) + (~(v3275 | (load_549 >> 61)))) + (bit_extract(((load_1195 << 3) & (~(load_549 << 3))) | (((load_1195 << 3) | (~(load_549 << 3))) & (~((load_1195 << 3) - (load_549 << 3)))), 63, 1)), ((phi(v154 | (load_1195 >> 61), (v154 | (load_1195 >> 61)) - ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_1195 << 3) & (~(phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63)))))) | (((load_1195 << 3) | (~(phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63)))))) & (~((load_1195 << 3) - (phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63))))))), 63, 1))), 51, 1) == 0) goto loc_244C;
        goto loc_22A4;
    loc_22A4:
        if (phi((phi(((v3275 | (load_549 >> 61)) + (~(v154 | (load_1195 >> 61)))) + (bit_extract(((load_549 << 3) & (~(load_1195 << 3))) | (((load_549 << 3) | (~(load_1195 << 3))) & (~((load_549 << 3) - (load_1195 << 3)))), 63, 1)), ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) - ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_549 << 3) & (~(phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0))))) | (((load_549 << 3) | (~(phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0))))) & (~((load_549 << 3) - (phi((((uint64_t)((uint32_t)phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1) != 64 ? (load_1195 << 3) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((0x80 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) : load_1195 << 3) != 0 ? 1 : 0)) | ((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) >> (((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) - 64) & 63)), (((phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63)) | ((load_1195 << 3) >> ((phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1)) & 63))) | (((uint64_t)(load_1195 << 3) << ((64 - (phi((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)), ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))) - 1))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi((v154 | (load_1195 >> 61)) | 0x8000000000000, v154 | (load_1195 >> 61))) | (load_1195 << 3) != 0 ? 1 : 0)))))), 63, 1)), ((v154 | (load_1195 >> 61)) + (~(v3275 | (load_549 >> 61)))) + (bit_extract(((load_1195 << 3) & (~(load_549 << 3))) | (((load_1195 << 3) | (~(load_549 << 3))) & (~((load_1195 << 3) - (load_549 << 3)))), 63, 1)), ((phi(v154 | (load_1195 >> 61), (v154 | (load_1195 >> 61)) - ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_1195 << 3) & (~(phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63)))))) | (((load_1195 << 3) | (~(phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63)))))) & (~((load_1195 << 3) - (phi(((uint64_t)(phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) | (load_549 << 3) != 0 ? 1 : 0), (((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) | ((load_549 << 3) >> ((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) & 63))) | (((uint64_t)(load_549 << 3) << ((64 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))) != 64 ? (load_549 << 3) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)))))) & 63)) : load_549 << 3) != 0 ? 1 : 0)) | ((phi(v3275 | (load_549 >> 61), (v3275 | (load_549 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))), 0 - ((bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15))))) - 64) & 63))))))), 63, 1)))) & 0x7FFFFFFFFFFFF, ((v3275 | (load_549 >> 61)) + (~(v154 | (load_1195 >> 61)))) + (bit_extract(((load_549 << 3) & (~(load_1195 << 3))) | (((load_549 << 3) | (~(load_1195 << 3))) & (~((load_549 << 3) - (load_1195 << 3)))), 63, 1)), ((v154 | (load_1195 >> 61)) + (~(v3275 | (load_549 >> 61)))) + (bit_extract(((load_1195 << 3) & (~(load_549 << 3))) | (((load_1195 << 3) | (~(load_549 << 3))) & (~((load_1195 << 3) - (load_549 << 3)))), 63, 1))) == 0) goto loc_2584;
        goto loc_22A8;
    loc_22A8:
    loc_22B0:
    loc_22C4:
        if ((int64_t)sext(phi(v3393 + 52, phi(v3393 + 52, v2490 - 12))) < (int64_t)phi(phi(bit_extract(load_1253, 48, 15), bit_extract(load_1721, 48, 15)), bit_extract(load_1253, 48, 15))) goto loc_2440;
        goto loc_22D0;
    loc_22D0:
        if ((int32_t)((phi(v3393 + 52, phi(v3393 + 52, v2490 - 12))) - (phi(phi(bit_extract(load_1253, 48, 15), bit_extract(load_1721, 48, 15)), bit_extract(load_1253, 48, 15)))) + 1 > 63) goto loc_27D0;
        goto loc_22E0;
    loc_22E0:
    loc_2308:
    loc_230C:
        if (phi(((load_1195 << 3) - (load_549 << 3)) | (((v154 | (load_1195 >> 61)) + (~(v3275 | (load_549 >> 61)))) + (bit_extract(((load_1195 << 3) & (~(load_549 << 3))) | (((load_1195 << 3) | (~(load_549 << 3))) & (~((load_1195 << 3) - (load_549 << 3)))), 63, 1))), (((uint64_t)((uint32_t)v2612 != (uint32_t)v3405 ? x2 : v262) != (uint64_t)v2820 ? 1 : 0)) | x0, x6) == 0) goto loc_2460;
        goto loc_2310;
    loc_2310:
    loc_231C:
        if (x0 == 0) goto loc_2C2C;
        goto loc_2320;
    loc_2320:
        if ((uint64_t)x1 == (uint64_t)v1017) goto loc_2678;
        goto loc_232C;
    loc_232C:
        if ((uint64_t)x1 == (uint64_t)v2584) goto loc_263C;
        goto loc_2334;
    loc_2334:
        if (x1 == 0) goto loc_265C;
        goto loc_2338;
    loc_2338:
        if (v3047 == 0) goto loc_2348;
        goto loc_2344;
    loc_2344:
    loc_2348:
        if (x1 == 0) goto loc_24F8;
        goto loc_234C;
    loc_234C:
        if ((uint64_t)x2 == (uint64_t)x1) goto loc_2514;
        goto loc_235C;
    loc_235C:
    loc_2368:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        if (v1809 != 0) goto loc_2570;
        goto loc_2384;
    loc_2384:
        return;
    loc_238C:
        if ((uint32_t)(bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)) == 0) goto loc_2478;
        goto loc_2390;
    loc_2390:
        if (x8 != 0) goto loc_2710;
        goto loc_2394;
    loc_2394:
        if (x2 == 0) goto loc_290C;
        goto loc_239C;
    loc_239C:
        if (v871 != 0) goto loc_2718;
        goto loc_23A4;
    loc_23A4:
        goto loc_229C;
    loc_23C0:
        if ((int32_t)v751 <= (int32_t)v41) goto loc_25A0;
        goto loc_23CC;
    loc_23CC:
        if (x7 == 0) goto loc_24C0;
        goto loc_23D0;
    loc_23D0:
        if ((uint64_t)x8 == (uint64_t)x1) goto loc_2694;
        goto loc_23E0;
    loc_23E0:
        if ((int32_t)v3523 > (int32_t)v1445) goto loc_27B4;
        goto loc_23E8;
    loc_23E8:
        if ((int32_t)v2650 > (int32_t)v719) goto loc_289C;
        goto loc_23F0;
    loc_23F0:
        goto loc_27C0;
    loc_2420:
        if (x1 == 0) goto loc_2790;
        goto loc_2428;
    loc_2428:
        if ((uint32_t)(bit_extract(load_1253, 48, 15)) - (bit_extract(load_1721, 48, 15)) != 1) goto loc_2248;
        goto loc_2430;
    loc_2430:
        goto loc_229C;
    loc_2440:
    loc_244C:
        if (x2 != 0) goto loc_231C;
        goto loc_245C;
    loc_245C:
        if (x6 != 0) goto loc_2310;
        goto loc_2460;
    loc_2460:
    loc_246C:
        goto loc_2368;
    loc_2478:
        if (((uint64_t)x6 & (uint64_t)v1690) != 0) goto loc_2764;
        goto loc_2484;
    loc_2484:
        if (x8 != 0) goto loc_2930;
        goto loc_2490;
    loc_2490:
        if (x7 == 0) goto loc_2A24;
        goto loc_2494;
    loc_2494:
        if (x6 == 0) goto loc_2A38;
        goto loc_2498;
    loc_2498:
        if (v1947 == 0) goto loc_2C10;
        goto loc_24A4;
    loc_24A4:
        goto loc_230C;
    loc_24C0:
        if (x1 == 0) goto loc_2990;
        goto loc_24C8;
    loc_24C8:
        if ((uint32_t)v2668 == (uint32_t)v2829) goto loc_2960;
        goto loc_24D0;
    loc_24D0:
        if ((uint64_t)x8 != (uint64_t)x1) goto loc_23E0;
        goto loc_24DC;
    loc_24DC:
        if (x0 == 0) goto loc_2838;
        goto loc_24E4;
    loc_24E4:
    loc_24F0:
    loc_24F8:
        if ((uint64_t)x2 == (uint64_t)x3) goto loc_26B4;
        goto loc_2510;
    loc_2510:
        goto loc_246C;
    loc_2514:
    loc_2518:
        if (x1 == 0) goto loc_2550;
        goto loc_251C;
    loc_251C:
        if ((uint64_t)x1 == (uint64_t)v649) goto loc_254C;
        goto loc_2524;
    loc_2524:
        if (((uint32_t)v1840 & (uint32_t)v384) != 0) goto loc_2550;
        goto loc_2534;
    loc_2534:
        goto loc_246C;
    loc_254C:
        if (x15 != 0) goto loc_2534;
        goto loc_2550;
    loc_2550:
    loc_255C:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
    loc_2570:
        memory_unknown = local_phi_5704;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_2584:
        if ((int32_t)v3264 <= (int32_t)v3246) goto loc_22B0;
        goto loc_2594;
    loc_2594:
        goto loc_22C4;
    loc_25A0:
        if ((uint32_t)v751 == (uint32_t)v41) goto loc_26CC;
        goto loc_25A4;
    loc_25A4:
        if (x8 == 0) goto loc_2878;
        goto loc_25A8;
    loc_25A8:
    loc_25B0:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2AD0;
        goto loc_25BC;
    loc_25BC:
        if ((int32_t)v1493 > (int32_t)v2821) goto loc_2A6C;
        goto loc_25C4;
    loc_25C4:
        if ((int32_t)v2038 > (int32_t)v2206) goto loc_2B24;
        goto loc_25CC;
    loc_25CC:
    loc_25F8:
    loc_2608:
        if (v2405 == 0) goto loc_244C;
        goto loc_260C;
    loc_260C:
        if ((uint64_t)x2 == (uint64_t)x0) goto loc_29B0;
        goto loc_261C;
    loc_261C:
        goto loc_231C;
    loc_263C:
        if (x15 == 0) goto loc_264C;
        goto loc_2644;
    loc_2644:
    loc_264C:
        if (v2698 == 0) goto loc_2348;
        goto loc_2654;
    loc_2654:
        goto loc_2348;
    loc_265C:
        if ((uint64_t)x1 == (uint64_t)v462) goto loc_264C;
        goto loc_266C;
    loc_266C:
        goto loc_264C;
    loc_2678:
        if (x15 != 0) goto loc_264C;
        goto loc_2680;
    loc_2680:
        goto loc_2644;
    loc_2684:
        goto loc_2290;
    loc_2694:
        if (x9 == 0) goto loc_2838;
        goto loc_269C;
    loc_269C:
    loc_26B4:
        if (x2 == 0) goto loc_2D54;
        goto loc_26BC;
    loc_26BC:
        goto loc_2368;
    loc_26CC:
        if (((uint64_t)x7 & (uint64_t)v647) != 0) goto loc_28C8;
        goto loc_26D8;
    loc_26D8:
        if (x8 != 0) goto loc_2AA8;
        goto loc_26E0;
    loc_26E0:
        if (x7 == 0) goto loc_2A58;
        goto loc_26E8;
    loc_26E8:
        if (x6 == 0) goto loc_2A38;
        goto loc_26EC;
    loc_26EC:
        if (v2001 == 0) goto loc_2308;
        goto loc_26FC;
    loc_26FC:
        goto loc_231C;
    loc_2710:
    loc_2718:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_29FC;
        goto loc_2724;
    loc_2724:
        if ((int32_t)v2708 > (int32_t)v1231) goto loc_2850;
        goto loc_272C;
    loc_272C:
        if ((int32_t)v1436 > (int32_t)v1114) goto loc_2A7C;
        goto loc_2734;
    loc_2734:
        goto loc_285C;
    loc_2764:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_28F4;
        goto loc_2770;
    loc_2770:
        if (x6 != 0) goto loc_2A50;
        goto loc_2778;
    loc_2778:
        goto loc_246C;
    loc_2790:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_244C;
        goto loc_279C;
    loc_279C:
        if (x0 != 0) goto loc_24E4;
        goto loc_27A4;
    loc_27A4:
        goto loc_26B4;
    loc_27B4:
    loc_27C0:
        goto loc_2608;
    loc_27D0:
        goto loc_230C;
    loc_2808:
        goto loc_2290;
    loc_2834:
    loc_2838:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        goto loc_2384;
    loc_2850:
    loc_285C:
        goto loc_229C;
    loc_2878:
        if (x2 == 0) goto loc_2AF4;
        goto loc_2880;
    loc_2880:
        if (v497 != 0) goto loc_25B0;
        goto loc_2888;
    loc_2888:
        goto loc_2608;
    loc_289C:
        goto loc_27C0;
    loc_28C8:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2B50;
        goto loc_28D4;
    loc_28D4:
        goto loc_231C;
    loc_28F4:
        goto loc_22A4;
    loc_290C:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2B84;
        goto loc_2918;
    loc_2918:
        goto loc_244C;
    loc_2930:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_2BA8;
        goto loc_293C;
    loc_293C:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2BC0;
        goto loc_2944;
    loc_2944:
        if (x7 == 0) goto loc_2978;
        goto loc_2948;
    loc_2948:
        if (x6 != 0) goto loc_2BD8;
        goto loc_2954;
    loc_2954:
        goto loc_26B4;
    loc_2960:
        goto loc_2608;
    loc_2970:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2BC0;
        goto loc_2978;
    loc_2978:
        if (x6 != 0) goto loc_2C3C;
        goto loc_297C;
    loc_297C:
        goto loc_26BC;
    loc_2990:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_244C;
        goto loc_299C;
    loc_299C:
        if (x0 == 0) goto loc_27A4;
        goto loc_29A4;
    loc_29A4:
        goto loc_24F0;
    loc_29B0:
        if (((uint64_t)x16 & (uint64_t)v1310) == 0) goto loc_2A64;
        goto loc_29B8;
    loc_29B8:
        if (((uint32_t)v1059 & (uint32_t)v1818) != 0) goto loc_2D10;
        goto loc_29CC;
    loc_29CC:
        if ((uint64_t)x1 == (uint64_t)v1299) goto loc_2CA8;
        goto loc_29D4;
    loc_29D4:
        if ((uint64_t)x1 != (uint64_t)v710) goto loc_2518;
        goto loc_29E0;
    loc_29E0:
        if (x15 != 0) goto loc_264C;
        goto loc_29F8;
    loc_29F8:
        goto loc_2644;
    loc_29FC:
        if (x1 == 0) goto loc_2834;
        goto loc_2A04;
    loc_2A04:
        goto loc_26B4;
    loc_2A24:
        if (x6 == 0) goto loc_2B10;
        goto loc_2A28;
    loc_2A28:
    loc_2A38:
    loc_2A40:
        if (v1125 == 0) goto loc_2348;
        goto loc_2A48;
    loc_2A48:
        goto loc_2348;
    loc_2A50:
        goto loc_22A4;
    loc_2A58:
        if (x6 != 0) goto loc_2D48;
        goto loc_2A5C;
    loc_2A5C:
        goto loc_246C;
    loc_2A64:
        goto loc_255C;
    loc_2A6C:
        goto loc_25F8;
    loc_2A7C:
        goto loc_285C;
    loc_2AA8:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_2C50;
        goto loc_2AB4;
    loc_2AB4:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2CF4;
        goto loc_2ABC;
    loc_2ABC:
        if (x7 != 0) goto loc_2C68;
        goto loc_2AC0;
    loc_2AC0:
        goto loc_26B4;
    loc_2AD0:
        if (x1 == 0) goto loc_2838;
        goto loc_2AD8;
    loc_2AD8:
        goto loc_26B4;
    loc_2AF4:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2CC4;
        goto loc_2B00;
    loc_2B00:
        goto loc_244C;
    loc_2B10:
        goto loc_246C;
    loc_2B24:
        goto loc_25F8;
    loc_2B50:
        if (((uint64_t)x16 & (uint64_t)v3223) == 0) goto loc_2A64;
        goto loc_2B58;
    loc_2B58:
        if (((uint32_t)v867 & (uint32_t)v2631) != 0) goto loc_2D10;
        goto loc_2B6C;
    loc_2B6C:
        if ((uint64_t)x1 != (uint64_t)v495) goto loc_29D4;
        goto loc_2B74;
    loc_2B74:
        if (x6 == 0) goto loc_2CAC;
        goto loc_2B78;
    loc_2B78:
        goto loc_255C;
    loc_2B84:
        if (x0 == 0) goto loc_2CEC;
        goto loc_2B8C;
    loc_2B8C:
        goto loc_24F0;
    loc_2BA8:
        if (x7 == 0) goto loc_2970;
        goto loc_2BAC;
    loc_2BAC:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_2948;
        goto loc_2BC0;
    loc_2BC0:
        if (x6 == 0) goto loc_2CE4;
        goto loc_2BC4;
    loc_2BC4:
        if (x7 == 0) goto loc_2C3C;
        goto loc_2BD0;
    loc_2BD0:
    loc_2BD8:
        if (v3197 == 0) goto loc_2BFC;
        goto loc_2BE4;
    loc_2BE4:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2BFC;
        goto loc_2BEC;
    loc_2BEC:
    loc_2BFC:
        goto loc_26B4;
    loc_2C10:
        if (x6 == 0) goto loc_2B10;
        goto loc_2C18;
    loc_2C18:
        goto loc_231C;
    loc_2C2C:
        if (v2385 != 0) goto loc_2A40;
        goto loc_2C38;
    loc_2C38:
        goto loc_2348;
    loc_2C3C:
        goto loc_26B4;
    loc_2C50:
        if (x7 == 0) goto loc_2D1C;
        goto loc_2C54;
    loc_2C54:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2D3C;
        goto loc_2C68;
    loc_2C68:
        if (x1 == 0) goto loc_2D00;
        goto loc_2C70;
    loc_2C70:
        if (v746 == 0) goto loc_2C98;
        goto loc_2C80;
    loc_2C80:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2C98;
        goto loc_2C88;
    loc_2C88:
    loc_2C98:
        goto loc_26B4;
    loc_2CA8:
        if (x6 != 0) goto loc_2B78;
        goto loc_2CAC;
    loc_2CAC:
        goto loc_234C;
    loc_2CC4:
        if (x0 == 0) goto loc_27A4;
        goto loc_2CCC;
    loc_2CCC:
        goto loc_24F0;
    loc_2CE4:
        if (x7 == 0) goto loc_297C;
        goto loc_2CE8;
    loc_2CE8:
        goto loc_2948;
    loc_2CEC:
        goto loc_27A4;
    loc_2CF4:
        if (x1 != 0) goto loc_2D2C;
        goto loc_2CFC;
    loc_2CFC:
        if (x7 == 0) goto loc_2838;
        goto loc_2D00;
    loc_2D00:
        goto loc_26B4;
    loc_2D10:
        goto loc_255C;
    loc_2D1C:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_2AC0;
        goto loc_2D24;
    loc_2D24:
        if (x1 == 0) goto loc_2838;
        goto loc_2D2C;
    loc_2D2C:
        if (x7 != 0) goto loc_2C70;
        goto loc_2D38;
    loc_2D38:
        goto loc_2AC0;
    loc_2D3C:
        if (x1 != 0) goto loc_2D2C;
        goto loc_2D44;
    loc_2D44:
        goto loc_2D00;
    loc_2D48:
        goto loc_2A38;
    loc_2D54:
        goto loc_2368;
}
void multf3(void)
{
    uint64 load_644;
    uint64 load_1137;
    uint64 load_1587;
    uint64 load_2331;
    loc_2D70:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_2851;
        local_pFFFFFFFFFFFFFFF0 = var_3110;
        load_644 = var_30;
        load_1137 = var_30;
        load_1587 = var_40;
        load_2331 = var_40;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if (bit_extract(load_1137, 48, 15) == 0) goto loc_31B4;
        goto loc_2DA4;
    loc_2DA4:
        if ((uint32_t)bit_extract(load_1137, 48, 15) == 0x7FFF) goto loc_31FC;
        goto loc_2DB0;
    loc_2DB0:
    loc_2DD4:
        if (bit_extract(load_2331, 48, 15) == 0) goto loc_3158;
        goto loc_2DEC;
    loc_2DEC:
        if ((uint32_t)bit_extract(load_2331, 48, 15) == 0x7FFF) goto loc_2E44;
        goto loc_2DF8;
    loc_2DF8:
        if ((int64_t)phi(0, 8, 4, 12) <= 10) goto loc_2E7C;
        goto loc_2E30;
    loc_2E30:
        if ((uint64_t)phi((phi(0, 8, 4, 12)) | 1, phi(0, 8, 4, 12)) == 11) goto loc_3564;
        goto loc_2E38;
    loc_2E38:
        goto loc_2F3C;
    loc_2E44:
        if (load_1587 | (bit_extract(load_2331, 0, 48)) != 0) goto loc_2ED0;
        goto loc_2E54;
    loc_2E54:
        if ((int64_t)(phi(0, 8, 4, 12)) | 2 > 10) goto loc_34D0;
        goto loc_2E74;
    loc_2E74:
    loc_2E7C:
        if ((int64_t)phi((phi(0, 8, 4, 12)) | 2, phi(0, 8, 4, 12), (phi(0, 8, 4, 12)) | 1) > 2) goto loc_2EF8;
        goto loc_2E84;
    loc_2E84:
        if ((uint64_t)(phi((phi(0, 8, 4, 12)) | 2, phi(0, 8, 4, 12), (phi(0, 8, 4, 12)) | 1)) - 1 > 1) goto loc_2F9C;
        goto loc_2E90;
    loc_2E90:
        if ((uint64_t)phi(2, 0, 1) == 2) goto loc_2F8C;
        goto loc_2E98;
    loc_2E98:
        if ((uint64_t)phi(phi(phi(1, 0), phi(phi(0, 2, 1, 3), phi(3, phi(2, 0, 1)), phi(3, 2))), phi(2, 0, 1)) != 1) goto loc_30FC;
        goto loc_2EA0;
    loc_2EA0:
    loc_2EAC:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        if (x0 != 0) goto loc_3364;
        goto loc_2EC8;
    loc_2EC8:
        return;
    loc_2ED0:
        if ((int64_t)(phi(0, 8, 4, 12)) | 3 > 10) goto loc_3558;
        goto loc_2EF8;
    loc_2EF8:
        if (((uint64_t)1 << ((phi((phi(0, 8, 4, 12)) | 3, phi((phi(0, 8, 4, 12)) | 2, phi(0, 8, 4, 12), (phi(0, 8, 4, 12)) | 1))) & 63) & (uint64_t)0x530) != 0) goto loc_2F34;
        goto loc_2F0C;
    loc_2F0C:
        if (((uint64_t)1 << ((phi((phi(0, 8, 4, 12)) | 3, phi((phi(0, 8, 4, 12)) | 2, phi(0, 8, 4, 12), (phi(0, 8, 4, 12)) | 1))) & 63) & (uint64_t)0x240) != 0) goto loc_2F74;
        goto loc_2F18;
    loc_2F18:
        if (((uint64_t)1 << ((phi((phi(0, 8, 4, 12)) | 3, phi((phi(0, 8, 4, 12)) | 2, phi(0, 8, 4, 12), (phi(0, 8, 4, 12)) | 1))) & 63) & (uint64_t)0x88) == 0) goto loc_2F9C;
        goto loc_2F24;
    loc_2F24:
        goto loc_2F3C;
    loc_2F34:
    loc_2F3C:
        if ((uint64_t)phi(phi(0, 2, 1, 3), phi(3, phi(2, 0, 1)), phi(3, 2)) == 2) goto loc_2F8C;
        goto loc_2F48;
    loc_2F48:
    loc_2F58:
        if ((uint64_t)phi(phi(1, 0), phi(phi(0, 2, 1, 3), phi(3, phi(2, 0, 1)), phi(3, 2))) != 3) goto loc_2E98;
        goto loc_2F60;
    loc_2F60:
        goto loc_2EAC;
    loc_2F74:
        goto loc_2EAC;
    loc_2F8C:
        goto loc_2EAC;
    loc_2F9C:
        local_pFFFFFFFFFFFFFFD0 = local_x21;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        if (bit_extract(((condition_ne ? (((uint64_t)((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF) > (uint64_t)((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) + (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32)) + 0x100000000 : ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32))) + 1 : ((uint64_t)((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF) > (uint64_t)((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) + (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32)) + 0x100000000 : ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32)))) + ((condition_ne ? ((((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) + (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) >> 32)) >> 32) + 1 : (((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) >> 32) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) + (((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) >> 32) * ((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v719 | 0x8000000000000, 0, phi(load_644 << (((v1499 + 49) - 61) & 63), (load_644 >> ((61 - (phi(v1499 + 49, v1393 - 15))) & 63)) | ((bit_extract(load_1137, 0, 48)) << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63))), bit_extract(load_1137, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(bit_extract(load_2331, 0, 48), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))), phi(0, v1793 | 0x8000000000000, phi(load_1587 << (((v1644 + 49) - 61) & 63), (load_1587 >> ((61 - (phi(v1644 + 49, v1825 - 15))) & 63)) | ((bit_extract(load_2331, 0, 48)) << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))))) & 0xFFFFFFFF)) >> 32)) >> 32)), 39, 1) == 0) goto loc_3284;
        goto loc_30E4;
    loc_30E4:
    loc_30FC:
        if ((int64_t)(phi(phi(phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x7FFF, phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x7FFF, (((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))), phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))), ((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011)), phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x7FFF, (((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))), phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))), ((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011)), phi(phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1, (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1)), phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1, (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1)), phi(phi(phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1), phi(phi(phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1), (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000), phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1, (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1)), (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000)), phi((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 0x8000, ((((bit_extract(load_2331, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393)))))) + 1, (phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) + 1, (((phi(((bit_extract(load_1137, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0, 0xFFFFFFFFFFFFC011 - (phi(v1499 + 64, phi(v1499 + 64, v1393))))) - (phi(v1644 + 64, phi(v1644 + 64, v1825)))) + 0xFFFFFFFFFFFFC011) + 1)))) + 0x3FFF <= 0) goto loc_3294;
        goto loc_310C;
    loc_310C:
        if (((uint64_t)phi(((((uint64_t)(((((phi(phi(load_1587, phi(0, load_1587 << 3, phi(0, load_1587 << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63)))), phi(0, load_1587 << 3, phi(0, load_1587 << (((phi(v1644 + 49, v1825 - 15)) + 3) & 63))))) & 0xFFFFFFFF) * ((phi(load_644 << 3, load_644 | (bit_extract(load_1137, 0, 48)), phi(0, load_644 << (((phi(v1499 + 49, v1393 - 15)) + 3) & 63)), load_644)) & 0xFFFFFFFF)) & 0xFFFFFFFF) + (((x19 + v1255) + v469) << v2397)) | v1902 != (uint64_t)v1078 ? 1 : 0)) | v1308) | v1084, x7) & (uint64_t)v239) == 0) goto loc_3130;
        goto loc_3114;
    loc_3114:
        if ((uint64_t)x3 == (uint64_t)v195) goto loc_34AC;
        goto loc_3124;
    loc_3124:
        if ((uint64_t)x3 == (uint64_t)v1783) goto loc_3478;
        goto loc_312C;
    loc_312C:
        if (x3 == 0) goto loc_3460;
        goto loc_3130;
    loc_3130:
        if (v1452 == 0) goto loc_313C;
        goto loc_3134;
    loc_3134:
    loc_313C:
        if ((int64_t)x1 > (int64_t)x3) goto loc_3318;
        goto loc_3148;
    loc_3148:
        goto loc_2EAC;
    loc_3158:
        if (x2 == 0) goto loc_3254;
        goto loc_3160;
    loc_3160:
        if (x12 == 0) goto loc_339C;
        goto loc_3164;
    loc_3164:
    loc_316C:
    loc_3188:
        if ((int64_t)x1 > (int64_t)v2598) goto loc_2E30;
        goto loc_31B0;
    loc_31B0:
        goto loc_2E7C;
    loc_31B4:
        if (load_644 | (bit_extract(load_1137, 0, 48)) == 0) goto loc_323C;
        goto loc_31BC;
    loc_31BC:
        if (bit_extract(load_1137, 0, 48) == 0) goto loc_3378;
        goto loc_31C0;
    loc_31C0:
    loc_31C8:
    loc_31E4:
        goto loc_2DD4;
    loc_31FC:
        if (load_644 | (bit_extract(load_1137, 0, 48)) != 0) goto loc_321C;
        goto loc_3204;
    loc_3204:
        goto loc_2DD4;
    loc_321C:
        goto loc_2DD4;
    loc_323C:
        goto loc_2DD4;
    loc_3254:
        if ((int64_t)x1 > (int64_t)v29) goto loc_2E30;
        goto loc_3280;
    loc_3280:
        goto loc_2E7C;
    loc_3284:
        goto loc_30FC;
    loc_3294:
        if ((int64_t)x1 > (int64_t)v2001) goto loc_33C4;
        goto loc_32A4;
    loc_32A4:
        if ((int64_t)x1 <= (int64_t)v73) goto loc_33F8;
        goto loc_32AC;
    loc_32AC:
        if (((uint64_t)x8 & (uint64_t)v319) == 0) goto loc_342C;
        goto loc_32E0;
    loc_32E0:
    loc_32E4:
        if ((uint64_t)x6 == (uint64_t)v1642) goto loc_3488;
        goto loc_32F4;
    loc_32F4:
        if ((uint64_t)x6 == (uint64_t)v2167) goto loc_3544;
        goto loc_32FC;
    loc_32FC:
        if (x6 == 0) goto loc_3528;
        goto loc_3300;
    loc_3300:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_3498;
        goto loc_3304;
    loc_3304:
        goto loc_334C;
    loc_3318:
        if ((uint64_t)x8 == (uint64_t)v1431) goto loc_34B4;
        goto loc_3324;
    loc_3324:
        if ((uint64_t)x8 == (uint64_t)v1977) goto loc_3444;
        goto loc_332C;
    loc_332C:
        if (x8 == 0) goto loc_3344;
        goto loc_3338;
    loc_3338:
    loc_3344:
    loc_334C:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
    loc_3364:
        memory_unknown = local_phi_2735;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_3378:
        if ((int64_t)v1499 + 49 <= 60) goto loc_31C8;
        goto loc_338C;
    loc_338C:
        goto loc_31E4;
    loc_339C:
        if ((int64_t)x2 <= (int64_t)v1924) goto loc_316C;
        goto loc_33B0;
    loc_33B0:
        goto loc_3188;
    loc_33C4:
        if (x8 == 0) goto loc_33E8;
        goto loc_33CC;
    loc_33CC:
        if ((uint64_t)x6 == (uint64_t)v2586) goto loc_33E8;
        goto loc_33E0;
    loc_33E0:
    loc_33E8:
        goto loc_334C;
    loc_33F8:
        if (((uint64_t)x8 & (uint64_t)v168) != 0) goto loc_32E4;
        goto loc_3428;
    loc_3428:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_3550;
        goto loc_342C;
    loc_342C:
        if (v420 == 0) goto loc_2EAC;
        goto loc_343C;
    loc_343C:
        goto loc_334C;
    loc_3444:
        goto loc_3344;
    loc_3460:
        if ((uint64_t)x3 == (uint64_t)v794) goto loc_3130;
        goto loc_346C;
    loc_346C:
        goto loc_3130;
    loc_3478:
        if (x2 == 0) goto loc_3130;
        goto loc_347C;
    loc_347C:
        goto loc_3130;
    loc_3488:
        if (x2 != 0) goto loc_3494;
        goto loc_348C;
    loc_348C:
    loc_3494:
        if (v621 == 0) goto loc_3304;
        goto loc_3498;
    loc_3498:
        goto loc_334C;
    loc_34AC:
        if (x2 != 0) goto loc_3130;
        goto loc_34B0;
    loc_34B0:
        goto loc_347C;
    loc_34B4:
        goto loc_3344;
    loc_34D0:
    loc_34D4:
        if ((uint64_t)x1 != (uint64_t)v2158) goto loc_34FC;
        goto loc_34DC;
    loc_34DC:
        if (v2639 == 0) goto loc_3514;
        goto loc_34E0;
    loc_34E0:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_3514;
        goto loc_34E4;
    loc_34E4:
        goto loc_2EAC;
    loc_34FC:
        if ((uint64_t)x1 != (uint64_t)v1010) goto loc_2E38;
        goto loc_3504;
    loc_3504:
        goto loc_2F3C;
    loc_3514:
        goto loc_2EAC;
    loc_3528:
        if ((uint64_t)x1 == (uint64_t)v1689) goto loc_3494;
        goto loc_3534;
    loc_3534:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_3498;
        goto loc_3540;
    loc_3540:
        goto loc_3304;
    loc_3544:
        if (x2 != 0) goto loc_348C;
        goto loc_3548;
    loc_3548:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_3498;
        goto loc_354C;
    loc_354C:
        goto loc_3304;
    loc_3550:
        goto loc_3498;
    loc_3558:
        goto loc_34D4;
    loc_3564:
        goto loc_2F58;
}
void sfp_handle_exceptions(void)
{
    if (!(bit_extract(a1, 0, 1) == 0)) {
        __asm("fdiv s0, s1, s1");
    }
    if (!(bit_extract(a1, 1, 1) == 0)) {
        __asm("fdiv s0, s1, s2");
    }
    if (!(bit_extract(a1, 2, 1) == 0)) {
        __asm("fadd s0, s1, s2");
    }
    if (!(bit_extract(a1, 3, 1) == 0)) {
        __asm("fmul s0, s1, s1");
    }
    if (!(bit_extract(a1, 4, 1) == 0)) {
        __asm("fsub s0, s1, s2");
    }
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
