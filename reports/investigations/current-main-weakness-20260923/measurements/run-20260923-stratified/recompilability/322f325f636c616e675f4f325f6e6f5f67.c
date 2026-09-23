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
    uint64 load_21;
    uint64 load_12;
    load_21 = var_0;
    load_12 = global_13FD8;
    unknown_call(load_12);
    unknown_call(load_12);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FD0;
    __asm("cbz x0, #0x704");
    return sub_660(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_19;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x14040 != 0x14040) {
        load_19 = global_13FC0;
        if (!(load_19 == 0)) {
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
        load_53 = global_13FE0;
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
    if (!(global_14040 != 0)) {
        if (!(global_13FC8 == 0)) {
            unknown_call(global_14038);
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
    return;
}
void process_short(void)
{
    return;
}
void process_int(void)
{
    return;
}
void process_long(void)
{
    return;
}
void process_ll(void)
{
    return;
}
void process_float(void)
{
    return;
}
void process_double(void)
{
    return;
}
void process_ld(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    multf3(/* arguments unknown */);
}
void process_bool(void)
{
    return;
}
void const_param(void)
{
    return;
}
void volatile_access(void)
{
    return;
}
void test_data_types_l1(void)
{
    uint64 load_267;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("=== 测试基础数据类型 ===");
    unknown_call(0x2C60);
    unknown_call(0x2C60);
    unknown_call("DT-L1-02 (process_short): %d\\n");
    unknown_call("DT-L1-03 (process_int): %d\\n");
    unknown_call("DT-L1-04 (process_long): %ld\\n");
    unknown_call("DT-L1-05 (process_ll): %lld\\n");
    unknown_call("DT-L1-06 (process_float): %.2f\\n");
    unknown_call("DT-L1-07 (process_double): %.2f\\n");
    load_267 = global_2BC0;
    unknown_call("DT-L1-08 (process_ld): %.2Lf\\n");
    unknown_call(0x2D51);
    unknown_call(0x2D51);
    unknown_call(0x2D51);
    unknown_call("DT-L1-10 (const_param): %d\\n");
    local_pFFFFFFFFFFFFFFFC = 10;
}
void array_1d_stack(void)
{
    uint64 load_58;
        if ((int32_t)a2 < 1) goto loc_9C4;
        if ((uint32_t)a2 >= 8) goto loc_9CC;
        goto loc_A0C;
    loc_9C4:
        return;
    loc_9CC:
    loc_9E0:
        load_58 = memory_unknown;
        if ((uint64_t)phi(v185 - 8, a2 & 0xFFFFFFF8) != 8) goto loc_9E0;
        if ((uint64_t)a2 & 0xFFFFFFF8 == (uint64_t)a2) goto loc_A24;
    loc_A0C:
        while ((uint64_t)phi(v76 - 1, a2 - (phi(a2 & 0xFFFFFFF8, 0))) != 1) {
        }
    loc_A24:
        return;
}
void array_string(void)
{
    while (memory_unknown != 0) {
    }
    return;
}
void array_2d_stack(void)
{
    return;
}
void array_3d(void)
{
    uint32 load_25;
    uint32 load_26;
    uint64 load_20;
    uint64 load_121;
    uint64 load_92;
    uint32 load_105;
    uint64 load_294;
    uint64 load_96;
    uint64 load_271;
    uint64 load_179;
    uint64 load_319;
    uint64 load_256;
    uint64 load_335;
    uint64 load_432;
    uint64 load_201;
    uint64 load_134;
    uint64 load_17;
    uint64 load_227;
    uint32 load_350;
    uint64 load_461;
    uint64 load_167;
    uint32 load_452;
    uint64 load_54;
    uint64 load_95;
    uint64 load_13;
    uint64 load_112;
    uint64 load_129;
    uint64 load_56;
    uint64 load_59;
    uint64 load_471;
    uint64 load_210;
    load_20 = a1->field_54;
    load_121 = a1->field_34;
    load_92 = a1->field_14;
    load_294 = a1->field_4;
    load_96 = a1->field_A8;
    load_271 = a1->field_88;
    load_179 = a1->field_B8;
    load_319 = a1->field_98;
    load_256 = a1->field_78;
    load_335 = a1->field_68;
    load_432 = a1->field_FC;
    load_201 = a1->field_DC;
    load_134 = a1->field_170;
    load_17 = a1->field_170;
    load_227 = a1->field_EC;
    load_461 = a1 + 0xEC->field_20;
    load_167 = a1 + 0xEC->field_20;
    load_54 = a1->field_150;
    load_95 = a1->field_150;
    load_13 = a1->field_CC;
    load_112 = a1->field_130;
    load_129 = a1->field_130;
    load_56 = a1 + 0x130->field_A4;
    load_59 = a1 + 0x130->field_84;
    load_471 = a1 + 0x130->field_64;
    load_210 = a1 + 0x130->field_74;
    load_452 = a1->field_64;
    load_25 = a1->field_0;
    load_105 = a1->field_C8;
    load_350 = a1->field_12C;
    load_26 = a1->field_190;
    return;
}
void array_vla(void)
{
    uint64 load_123;
        if ((int32_t)a1 < 1) goto loc_BEC;
        if ((uint32_t)a1 >= 8) goto loc_BF4;
        goto loc_C34;
    loc_BEC:
        return;
    loc_BF4:
    loc_C08:
        load_123 = memory_unknown;
        if ((uint64_t)phi(v139 - 8, a1 & 0xFFFFFFF8) != 8) goto loc_C08;
        if ((uint64_t)a1 & 0xFFFFFFF8 == (uint64_t)a1) goto loc_C4C;
    loc_C34:
        while ((uint64_t)phi(a1 - (phi(0, a1 & 0xFFFFFFF8)), v104 - 1) != 1) {
        }
    loc_C4C:
        return;
}
void array_pointer(void)
{
        if ((int32_t)a2 < 1) goto loc_C70;
        if ((uint32_t)a2 != 1) goto loc_C78;
        goto loc_CB4;
    loc_C70:
        return;
    loc_C78:
        while ((uint64_t)phi(v77 - 2, a2 & 0xFFFFFFFE) != 2) {
        }
        if ((uint64_t)a2 & 0xFFFFFFFE == (uint64_t)a2) goto loc_CD0;
    loc_CB4:
        while ((uint64_t)phi(v126 - 1, a2 - (phi(a2 & 0xFFFFFFFE, 0))) != 1) {
        }
    loc_CD0:
        return;
}
void pointer_array(void)
{
    uint64 load_7;
    if ((int32_t)a2 < 1) {
    } else {
        load_7 = memory_unknown;
        load_7 = memory_unknown;
        if (!(!(load_7 == 0))) {
        }
        }
        if ((uint64_t)phi(((uint32_t)a2 < 10 ? a2 : 10), v47 - 1) != 1) {
        }
    }
    return;
}
void array_complex_index(void)
{
    if (__arm64_condition_unknown(/* NZCV */)) {
        return;
    } else {
        if ((int32_t)a5 < (int32_t)a3) {
            if ((int32_t)a4 < (int32_t)a2) {
                if (__arm64_condition_unknown(/* NZCV */)) {
                }
            }
        }
        return;
    }
}
void array_oob(void)
{
    uint64 load_133;
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_D70;
        if ((uint32_t)a2 >= 7) goto loc_D78;
        goto loc_DB8;
    loc_D70:
        return;
    loc_D78:
    loc_D8C:
        load_133 = memory_unknown;
        if ((uint64_t)phi(v191 - 8, (a2 + 1) & 0xFFFFFFF8) != 8) goto loc_D8C;
        if ((uint64_t)(a2 + 1) & 0xFFFFFFF8 == (uint64_t)a2 + 1) goto loc_DD0;
    loc_DB8:
        while ((uint64_t)phi(v175 - 1, (a2 + 1) - (phi((a2 + 1) & 0xFFFFFFF8, 0))) != 1) {
        }
    loc_DD0:
        return;
}
void test_array_types(void)
{
    uint32 load_32;
    uint32 load_37;
    uint32 load_109;
    uint32 load_210;
    uint32 load_364;
    uint32 load_376;
    uint32 load_453;
    uint64 load_555;
    uint64 load_629;
    uint32 load_775;
    uint32 load_843;
    uint32 load_869;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x28;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call("=== 测试数组类型 ===");
    unknown_call("ARR-L1-01 (array_1d_stack): %d\\n");
    unknown_call("ARR-L1-02 (array_string): %d\\n");
    local_pFFFFFFFFFFFFFE30 = 0;
    local_pFFFFFFFFFFFFFE80 = 0;
    local_pFFFFFFFFFFFFFE58 = 0x100000000;
    load_775 = var_FFFFFFFFFFFFFE5C;
    local_pFFFFFFFFFFFFFE88 = global_2BD0;
    local_pFFFFFFFFFFFFFE38 = var_544;
    local_pFFFFFFFFFFFFFED8 = global_2BF0;
    local_pFFFFFFFFFFFFFF00 = global_2C00;
    load_453 = var_FFFFFFFFFFFFFEE0;
    local_pFFFFFFFFFFFFFE48 = var_544;
    local_pFFFFFFFFFFFFFF38 = global_2C10;
    load_555 = global_2BE0;
    load_109 = var_FFFFFFFFFFFFFE30;
    local_pFFFFFFFFFFFFFE60 = var_544;
    local_pFFFFFFFFFFFFFE60 = var_544;
    local_pFFFFFFFFFFFFFEB0 = load_555;
    local_pFFFFFFFFFFFFFEB0 = load_555;
    local_pFFFFFFFFFFFFFF78 = var_544;
    local_pFFFFFFFFFFFFFF78 = var_544;
    local_pFFFFFFFFFFFFFE98 = var_544;
    local_pFFFFFFFFFFFFFEA8 = 0;
    local_pFFFFFFFFFFFFFF50 = var_544;
    local_pFFFFFFFFFFFFFF50 = var_544;
    load_629 = global_2C40;
    load_376 = var_FFFFFFFFFFFFFE88;
    local_pFFFFFFFFFFFFFEE8 = var_544;
    load_37 = var_FFFFFFFFFFFFFEB4;
    local_pFFFFFFFFFFFFFED0 = 0;
    local_pFFFFFFFFFFFFFFA0 = var_544;
    local_pFFFFFFFFFFFFFFA0 = var_544;
    load_32 = var_FFFFFFFFFFFFFF0C;
    load_869 = var_FFFFFFFFFFFFFF38;
    load_364 = var_FFFFFFFFFFFFFF64;
    load_843 = var_FFFFFFFFFFFFFF90;
    load_210 = var_FFFFFFFFFFFFFFBC;
    local_pFFFFFFFFFFFFFEF8 = 0;
    local_pFFFFFFFFFFFFFF28 = var_544;
    local_pFFFFFFFFFFFFFF10 = var_544;
    local_pFFFFFFFFFFFFFF20 = 0;
    local_pFFFFFFFFFFFFFF48 = 0;
    local_pFFFFFFFFFFFFFF70 = 0;
    local_pFFFFFFFFFFFFFF98 = 0;
    unknown_call("ARR-L1-03 (array_2d_stack): %d\\n");
    local_pFFFFFFFFFFFFFC90 = 1;
    local_pFFFFFFFFFFFFFC30 = var_722;
    local_pFFFFFFFFFFFFFC30 = var_722;
    local_pFFFFFFFFFFFFFC50 = var_722;
    local_pFFFFFFFFFFFFFC50 = var_722;
    local_pFFFFFFFFFFFFFC70 = var_722;
    local_pFFFFFFFFFFFFFC70 = var_722;
    local_pFFFFFFFFFFFFFC94 = var_722;
    local_pFFFFFFFFFFFFFCA4 = var_722;
    local_pFFFFFFFFFFFFFCB4 = var_722;
    local_pFFFFFFFFFFFFFCC4 = var_722;
    local_pFFFFFFFFFFFFFCD4 = var_722;
    local_pFFFFFFFFFFFFFCE4 = var_722;
    local_pFFFFFFFFFFFFFCF8 = var_722;
    local_pFFFFFFFFFFFFFD08 = var_722;
    local_pFFFFFFFFFFFFFD18 = var_722;
    local_pFFFFFFFFFFFFFD28 = var_722;
    local_pFFFFFFFFFFFFFD38 = var_722;
    local_pFFFFFFFFFFFFFD38 = var_722;
    local_pFFFFFFFFFFFFFD58 = 1;
    local_pFFFFFFFFFFFFFD5C = var_722;
    local_pFFFFFFFFFFFFFD6C = var_722;
    local_pFFFFFFFFFFFFFD7C = var_722;
    local_pFFFFFFFFFFFFFD8C = var_722;
    local_pFFFFFFFFFFFFFD9C = var_722;
    local_pFFFFFFFFFFFFFDAC = var_722;
    local_pFFFFFFFFFFFFFCF4 = 1;
    local_pFFFFFFFFFFFFFDBC = 1;
    local_pFFFFFFFFFFFFFDC0 = var_722;
    local_pFFFFFFFFFFFFFDC0 = var_722;
    local_pFFFFFFFFFFFFFDE0 = var_722;
    local_pFFFFFFFFFFFFFDE0 = var_722;
    local_pFFFFFFFFFFFFFE00 = var_722;
    local_pFFFFFFFFFFFFFE00 = var_722;
    local_pFFFFFFFFFFFFFE20 = 1;
    array_3d(/* arguments unknown */);
    unknown_call("ARR-L1-04 (array_3d): %d\\n");
    unknown_call("ARR-L2-01 (array_vla): %d\\n");
    unknown_call("ARR-L2-02 (array_pointer): %d\\n");
    unknown_call("ARR-L2-03 (pointer_array): %d\\n");
    unknown_call("ARR-L2-04 (array_complex_index): %d\\n");
    return;
}
void ptr_single(void)
{
    return;
}
void ptr_double(void)
{
    return;
}
void ptr_triple(void)
{
    return;
}
void ptr_increment(void)
{
    uint64 load_120;
        if ((int32_t)a2 < 1) goto loc_1070;
        if ((uint32_t)a2 - 1 >= 7) goto loc_1078;
        goto loc_10C0;
    loc_1070:
        return;
    loc_1078:
    loc_1094:
        load_120 = memory_unknown;
        if ((uint64_t)phi(v134 - 8, ((a2 - 1) + 1) & 0x1FFFFFFF8) != 8) goto loc_1094;
        if ((uint64_t)(a2 - 1) + 1 == (uint64_t)((a2 - 1) + 1) & 0x1FFFFFFF8) goto loc_10D4;
    loc_10C0:
        while ((uint32_t)phi(a2 - (phi(((a2 - 1) + 1) & 0x1FFFFFFF8, 0)), v87 - 1) != 1) {
        }
    loc_10D4:
        return;
}
void ptr_offset(void)
{
    return;
}
void ptr_diff(void)
{
    return;
}
void ptr_void(void)
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
void ptr_const(void)
{
    return;
}
void ptr_const_ptr(void)
{
    a1->field_0 += 5;
    return;
}
uint32 ptr_func_simple(int64 a1, int64 a2)
{
    __asm("br x2");
}
void ptr_func_complex(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = global_13DC8;
    unknown_call(a2);
    return;
}
void ptr_cast(void)
{
    return;
}
void opaque_handle_create(void)
{
    return;
}
void opaque_handle_op(void)
{
    return;
}
void test_pointer_types(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call("=== 测试指针类型 ===");
    unknown_call("PTR-L2-01 (ptr_single): %d\\n");
    unknown_call("PTR-L2-02 (ptr_double): %d\\n");
    unknown_call("PTR-L2-03 (ptr_triple): %d\\n");
    unknown_call("PTR-L2-04 (ptr_increment): %d\\n");
    unknown_call("PTR-L2-05 (ptr_offset): %d\\n");
    unknown_call("PTR-L2-06 (ptr_diff): %d\\n");
    unknown_call(0x2F4E);
    unknown_call(0x2F4E);
    unknown_call("PTR-L2-08 (ptr_const): %d\\n");
    unknown_call("PTR-L2-09 (ptr_const_ptr): %d\\n");
    unknown_call("PTR-L2-10 (ptr_func_simple): %d\\n");
    unknown_call("PTR-L2-11 (ptr_func_complex): %d\\n");
    unknown_call("PTR-L2-12 (ptr_cast): 0x%x\\n");
}
void struct_simple(void)
{
    return;
}
uint32 struct_array(int64 a1, int64 a2)
{
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.lt #0x12c8");
    x9 = (uint32)a2;
    /* cmp (int32)(a2), 8 — 次の分岐のための比較 */
    __asm("b.hs #0x12d0");
    x10 = 0;
    x8 = 0;
    __asm("b #0x1328");
    return 0;
    x11 = x0;
    v1.2d = 0; /* vector zero */
    x8 = x9 & 0xFFFFFFF8;
    v0.2d = 0; /* vector zero */
    x12 = x11;
    x11 = x11 + 96;
    x8 = x8 - 8;
    ? = *(uint64 *)(x11);
    ? = *(uint64 *)(x11 + 48);
    v1 = v2 + v1 + v3 + v4;
    v0 = v5 + v0 + v6 + v7;
    __asm("b.ne #0x12e4");
    v0 = v0 + v1;
    /* cmp x10, x9 — 次の分岐のための比較 */
    __asm("addv s0, v0.4s");
    x8 = (uint32)v0;
    __asm("b.eq #0x1358");
    x9 = x9 - x10;
    x11 = x0 + x10 * 12 + 4;
    x10 = *(uint32 *)(x11 + -4);   x12 = *(uint32 *)(x11);
    x11 = x11 + 12;
    x9 = x9 - 1;
    x8 = (uint32)((uint32)((uint32)((uint32)*(uint32 *)(x11 + -4) + (uint32)x8) + (uint32)*(uint32 *)(x11)) + (uint32)*(uint32 *)(x11 + 4));
    __asm("b.ne #0x1338");
    return (uint32)x8;
}
void struct_nested(void)
{
    return;
}
void struct_deep(void)
{
    return;
}
void struct_with_ptr(void)
{
    uint64 load_15;
    uint32 load_8;
    load_15 = a1->field_8;
    load_8 = a1->field_0;
    if (!(load_15 == 0)) {
    }
    return;
}
void struct_bitfields(void)
{
    return;
}
void union_type(void)
{
    if ((uint32_t)a2 == 1) {
        __asm("fcvtzs w0, s0");
        return;
    } else {
        if (a2 != 0) {
            return;
        } else {
            return;
        }
    }
}
void union_array(void)
{
    uint64 load_61;
        if ((int32_t)a2 < 1) goto loc_1400;
        if ((uint32_t)a2 >= 8) goto loc_1408;
        goto loc_1448;
    loc_1400:
        return;
    loc_1408:
    loc_141C:
        load_61 = memory_unknown;
        if ((uint64_t)phi(a2 & 0xFFFFFFF8, v174 - 8) != 8) goto loc_141C;
        if ((uint64_t)a2 & 0xFFFFFFF8 == (uint64_t)a2) goto loc_1460;
    loc_1448:
        while ((uint64_t)phi(a2 - (phi(a2 & 0xFFFFFFF8, 0)), v55 - 1) != 1) {
        }
    loc_1460:
        return;
}
void enum_type(void)
{
    return;
}
void enum_switch(void)
{
    if ((uint32_t)a1 > 3) {
        return;
    } else {
        return;
    }
}
uint32 struct_func_ptr(void * a1)
{
    __asm("br x1");
}
void linked_list(void)
{
    if (!(a1 == 0)) {
        while (memory_unknown != 0) {
        }
    }
    return;
}
void doubly_linked_list(void)
{
    if (!(a1 == 0)) {
        while (memory_unknown != 0) {
        }
    }
    return;
}
void binary_tree_sum(void)
{
    uint32 load_117;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    if (a1 == 0) {
    } else {
        load_117 = memory_unknown;
        binary_tree_sum(/* arguments unknown */);
        while (memory_unknown != 0) {
        }
    }
    return;
}
void binary_tree(void)
{
}
void graph_traverse(void)
{
    uint32 load_80;
    load_80 = a1->field_50;
    if ((int32_t)load_80 < 1) {
    } else {
        if (!(a1[phi(0, x10 + 1)] == 0)) {
            while (memory_unknown != 0) {
            }
        }
        if ((uint64_t)x10 + 1 != (uint64_t)load_80) {
            goto loc_1560;
        }
    }
    return;
}
void test_composite_types(void)
{
    uint32 load_305;
    uint64 load_183;
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call("=== 测试复合类型 ===");
    unknown_call("CMP-L2-01 (struct_simple): %d\\n");
    unknown_call("CMP-L2-02 (struct_array): %d\\n");
    unknown_call("CMP-L2-03 (struct_nested): %d\\n");
    unknown_call("CMP-L2-04 (struct_deep): %d\\n");
    unknown_call("CMP-L2-05 (struct_with_ptr): %d\\n");
    unknown_call("CMP-L2-06 (struct_bitfields): %d\\n");
    unknown_call("CMP-L2-07 (union_type): %d\\n");
    unknown_call("CMP-L2-08 (union_array): %d\\n");
    unknown_call("CMP-L2-09 (enum_type): %d\\n");
    unknown_call("CMP-L2-10 (enum_switch): %d\\n");
    unknown_call("CMP-L2-11 (struct_func_ptr): %d\\n");
    local_m50 = 10;
    local_m30 = 30;
    local_m40 = 20;
    local_m48 = var_761 - 0xA0 + 0x80 - 48 + 16;
    local_m38 = var_761 - 0xA0 + 0x80 - 48 + 32;
    local_m28 = 0;
    while (memory_unknown != 0) {
    }
    unknown_call("CMP-L2-12 (linked_list): %d\\n");
    local_m80 = 10;
    local_m68 = 20;
    local_m60 = 0;
    local_m60 = 0;
    local_m78 = var_761 - 0xA0 + 32 + 24;
    local_m78 = var_761 - 0xA0 + 32 + 24;
    load_305 = memory_unknown;
    while (memory_unknown != 0) {
    }
    unknown_call("CMP-L2-13 (doubly_linked_list): %d\\n");
    load_183 = global_3268;
    local_mA0 = load_183;
    local_m90 = global_3278;
    binary_tree_sum(/* arguments unknown */);
    unknown_call("CMP-L2-14 (binary_tree): %d\\n");
    unknown_call("CMP-L2-15 (graph_traverse): %d\\n");
    return;
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_data_types_l1(/* arguments unknown */);
    test_array_types(/* arguments unknown */);
    test_pointer_types(/* arguments unknown */);
    test_composite_types(/* arguments unknown */);
    return;
}
void addtf3(void)
{
    uint64 load_537;
    uint64 load_2733;
    uint64 load_995;
    uint64 load_3226;
    loc_1760:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_5172;
        local_pFFFFFFFFFFFFFFF0 = var_4808;
        load_537 = var_10;
        load_2733 = var_10;
        load_995 = var_20;
        load_3226 = var_20;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if ((uint64_t)load_2733 >> 63 == (uint64_t)load_3226 >> 63) goto loc_1950;
        goto loc_17C0;
    loc_17C0:
        if ((int32_t)(bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)) <= 0) goto loc_191C;
        goto loc_17D0;
    loc_17D0:
        if (bit_extract(load_3226, 48, 15) == 0) goto loc_19B0;
        goto loc_17D4;
    loc_17D4:
    loc_17D8:
        if ((uint64_t)bit_extract(load_2733, 48, 15) == 0x7FFF) goto loc_1C24;
        goto loc_17E4;
    loc_17E4:
        if ((int32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) > 0x74) goto loc_1C14;
        goto loc_17EC;
    loc_17EC:
        if ((int32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) > 63) goto loc_1D98;
        goto loc_17F4;
    loc_17F4:
    loc_1820:
    loc_182C:
        if (bit_extract(phi(((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) - ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_537 << 3) & (~(phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0)))))) | (((load_537 << 3) | (~(phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0)))))) & (~((load_537 << 3) - (phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0))))))), 63, 1)), ((x3 | (load_995 >> 61)) + (~(x7 | (load_537 >> 61)))) + (bit_extract(((load_995 << 3) & (~(load_537 << 3))) | (((load_995 << 3) | (~(load_537 << 3))) & (~((load_995 << 3) - (load_537 << 3)))), 63, 1)), ((x7 | (load_537 >> 61)) + (~(x3 | (load_995 >> 61)))) + (bit_extract(((load_537 << 3) & (~(load_995 << 3))) | (((load_537 << 3) | (~(load_995 << 3))) & (~((load_537 << 3) - (load_995 << 3)))), 63, 1)), ((phi((x3 | (load_995 >> 61)) - ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)), x3 | (load_995 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_995 << 3) & (~(phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63)))))) | (((load_995 << 3) | (~(phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63)))))) & (~((load_995 << 3) - (phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63))))))), 63, 1))), 51, 1) == 0) goto loc_19DC;
        goto loc_1834;
    loc_1834:
        if (phi((phi(((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) - ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_537 << 3) & (~(phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0)))))) | (((load_537 << 3) | (~(phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0)))))) & (~((load_537 << 3) - (phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0))))))), 63, 1)), ((x3 | (load_995 >> 61)) + (~(x7 | (load_537 >> 61)))) + (bit_extract(((load_995 << 3) & (~(load_537 << 3))) | (((load_995 << 3) | (~(load_537 << 3))) & (~((load_995 << 3) - (load_537 << 3)))), 63, 1)), ((x7 | (load_537 >> 61)) + (~(x3 | (load_995 >> 61)))) + (bit_extract(((load_537 << 3) & (~(load_995 << 3))) | (((load_537 << 3) | (~(load_995 << 3))) & (~((load_537 << 3) - (load_995 << 3)))), 63, 1)), ((phi((x3 | (load_995 >> 61)) - ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)), x3 | (load_995 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_995 << 3) & (~(phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63)))))) | (((load_995 << 3) | (~(phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63)))))) & (~((load_995 << 3) - (phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63))))))), 63, 1)))) & 0x7FFFFFFFFFFFF, ((x7 | (load_537 >> 61)) + (~(x3 | (load_995 >> 61)))) + (bit_extract(((load_537 << 3) & (~(load_995 << 3))) | (((load_537 << 3) | (~(load_995 << 3))) & (~((load_537 << 3) - (load_995 << 3)))), 63, 1)), ((x3 | (load_995 >> 61)) + (~(x7 | (load_537 >> 61)))) + (bit_extract(((load_995 << 3) & (~(load_537 << 3))) | (((load_995 << 3) | (~(load_537 << 3))) & (~((load_995 << 3) - (load_537 << 3)))), 63, 1))) == 0) goto loc_1B14;
        goto loc_1838;
    loc_1838:
    loc_1840:
    loc_1854:
        if ((int64_t)sext(phi(v2838 + 52, phi(v1544 - 12, v2838 + 52))) < (int64_t)phi(phi(bit_extract(load_2733, 48, 15), bit_extract(load_3226, 48, 15)), bit_extract(load_2733, 48, 15))) goto loc_19D0;
        goto loc_1860;
    loc_1860:
        if ((int32_t)((phi(v2838 + 52, phi(v1544 - 12, v2838 + 52))) - (phi(phi(bit_extract(load_2733, 48, 15), bit_extract(load_3226, 48, 15)), bit_extract(load_2733, 48, 15)))) + 1 > 63) goto loc_1D60;
        goto loc_1870;
    loc_1870:
    loc_1898:
    loc_189C:
        if (phi((phi((((phi((phi(phi((load_537 << 3) - (phi(((uint64_t)(phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) | (load_995 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) != 64 ? (load_995 << 3) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) : load_995 << 3) != 0 ? 1 : 0)) | ((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) - 64) & 63)), (((phi(x3 | (load_995 >> 61), (x3 | (load_995 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63)) | ((load_995 << 3) >> ((phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) & 63))) | (((uint64_t)(load_995 << 3) << ((64 - (phi(((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))) - 1, (bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63) != 0 ? 1 : 0)))), (load_995 << 3) - (load_537 << 3), (load_537 << 3) - (load_995 << 3), (load_995 << 3) - (phi((((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) | ((load_537 << 3) >> ((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) & 63))) | (((uint64_t)(load_537 << 3) << ((64 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) | (load_537 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))) != 64 ? (load_537 << 3) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)))))) & 63)) : load_537 << 3) != 0 ? 1 : 0)) | ((phi(x7 | (load_537 >> 61), (x7 | (load_537 >> 61)) | 0x8000000000000)) >> (((phi(~((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))), 0 - ((bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15))))) - 64) & 63))))), (load_537 << 3) - (load_995 << 3), (load_995 << 3) - (load_537 << 3))) << (v3295 & v2974), x0)) << v2688) | x2) | x1, x9)) | x13, x6) == 0) goto loc_19F0;
        goto loc_18A0;
    loc_18A0:
    loc_18AC:
        if (x0 == 0) goto loc_21BC;
        goto loc_18B0;
    loc_18B0:
        if ((uint64_t)x1 == (uint64_t)v1493) goto loc_1C08;
        goto loc_18BC;
    loc_18BC:
        if ((uint64_t)x1 == (uint64_t)v1605) goto loc_1BCC;
        goto loc_18C4;
    loc_18C4:
        if (x1 == 0) goto loc_1BEC;
        goto loc_18C8;
    loc_18C8:
        if (v918 == 0) goto loc_18D8;
        goto loc_18D4;
    loc_18D4:
    loc_18D8:
        if (x1 == 0) goto loc_1A88;
        goto loc_18DC;
    loc_18DC:
        if ((uint64_t)x2 == (uint64_t)x1) goto loc_1AA4;
        goto loc_18EC;
    loc_18EC:
    loc_18F8:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        if (v2030 != 0) goto loc_1B00;
        goto loc_1914;
    loc_1914:
        return;
    loc_191C:
        if ((uint32_t)(bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)) == 0) goto loc_1A08;
        goto loc_1920;
    loc_1920:
        if (x8 != 0) goto loc_1CA0;
        goto loc_1924;
    loc_1924:
        if (x2 == 0) goto loc_1E9C;
        goto loc_192C;
    loc_192C:
        if (v1109 != 0) goto loc_1CA8;
        goto loc_1934;
    loc_1934:
        goto loc_182C;
    loc_1950:
        if ((int32_t)v1633 <= (int32_t)v427) goto loc_1B30;
        goto loc_195C;
    loc_195C:
        if (x7 == 0) goto loc_1A50;
        goto loc_1960;
    loc_1960:
        if ((uint64_t)x8 == (uint64_t)x1) goto loc_1C24;
        goto loc_1970;
    loc_1970:
        if ((int32_t)v1936 > (int32_t)v2399) goto loc_1D44;
        goto loc_1978;
    loc_1978:
        if ((int32_t)v457 > (int32_t)v2380) goto loc_1E2C;
        goto loc_1980;
    loc_1980:
        goto loc_1D50;
    loc_19B0:
        if (x1 == 0) goto loc_1D20;
        goto loc_19B8;
    loc_19B8:
        if ((uint32_t)(bit_extract(load_2733, 48, 15)) - (bit_extract(load_3226, 48, 15)) != 1) goto loc_17D8;
        goto loc_19C0;
    loc_19C0:
        goto loc_182C;
    loc_19D0:
    loc_19DC:
        if (x2 != 0) goto loc_18AC;
        goto loc_19EC;
    loc_19EC:
        if (x6 != 0) goto loc_18A0;
        goto loc_19F0;
    loc_19F0:
    loc_19FC:
        goto loc_18F8;
    loc_1A08:
        if (((uint64_t)x6 & (uint64_t)v3179) != 0) goto loc_1CF4;
        goto loc_1A14;
    loc_1A14:
        if (x8 != 0) goto loc_1EC0;
        goto loc_1A20;
    loc_1A20:
        if (x7 == 0) goto loc_1FB4;
        goto loc_1A24;
    loc_1A24:
        if (x6 == 0) goto loc_1FC8;
        goto loc_1A28;
    loc_1A28:
        if (v916 == 0) goto loc_21A0;
        goto loc_1A34;
    loc_1A34:
        goto loc_189C;
    loc_1A50:
        if (x1 == 0) goto loc_1F20;
        goto loc_1A58;
    loc_1A58:
        if ((uint32_t)v3112 == (uint32_t)v1393) goto loc_1EF0;
        goto loc_1A60;
    loc_1A60:
        if ((uint64_t)x8 != (uint64_t)x1) goto loc_1970;
        goto loc_1A6C;
    loc_1A6C:
        if (x0 == 0) goto loc_1DC8;
        goto loc_1A74;
    loc_1A74:
    loc_1A80:
    loc_1A88:
        if ((uint64_t)x2 == (uint64_t)x3) goto loc_1C44;
        goto loc_1AA0;
    loc_1AA0:
        goto loc_19FC;
    loc_1AA4:
    loc_1AA8:
        if (x1 == 0) goto loc_1AE0;
        goto loc_1AAC;
    loc_1AAC:
        if ((uint64_t)x1 == (uint64_t)v162) goto loc_1ADC;
        goto loc_1AB4;
    loc_1AB4:
        if (((uint32_t)v410 & (uint32_t)v1914) != 0) goto loc_1AE0;
        goto loc_1AC4;
    loc_1AC4:
        goto loc_19FC;
    loc_1ADC:
        if (x15 != 0) goto loc_1AC4;
        goto loc_1AE0;
    loc_1AE0:
    loc_1AEC:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
    loc_1B00:
        memory_unknown = local_phi_4363;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_1B14:
        if ((int32_t)v881 <= (int32_t)v2589) goto loc_1840;
        goto loc_1B24;
    loc_1B24:
        goto loc_1854;
    loc_1B30:
        if ((uint32_t)v1633 == (uint32_t)v427) goto loc_1C5C;
        goto loc_1B34;
    loc_1B34:
        if (x8 == 0) goto loc_1E08;
        goto loc_1B38;
    loc_1B38:
    loc_1B40:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2060;
        goto loc_1B4C;
    loc_1B4C:
        if ((int32_t)v1390 > (int32_t)v2963) goto loc_1FFC;
        goto loc_1B54;
    loc_1B54:
        if ((int32_t)v2414 > (int32_t)v716) goto loc_20B4;
        goto loc_1B5C;
    loc_1B5C:
    loc_1B88:
    loc_1B98:
        if (v2340 == 0) goto loc_19DC;
        goto loc_1B9C;
    loc_1B9C:
        if ((uint64_t)x2 == (uint64_t)x0) goto loc_1F40;
        goto loc_1BAC;
    loc_1BAC:
        goto loc_18AC;
    loc_1BCC:
        if (x15 == 0) goto loc_1BDC;
        goto loc_1BD4;
    loc_1BD4:
    loc_1BDC:
        if (v1397 == 0) goto loc_18D8;
        goto loc_1BE4;
    loc_1BE4:
        goto loc_18D8;
    loc_1BEC:
        if ((uint64_t)x1 == (uint64_t)v3515) goto loc_1BDC;
        goto loc_1BFC;
    loc_1BFC:
        goto loc_1BDC;
    loc_1C08:
        if (x15 != 0) goto loc_1BDC;
        goto loc_1C10;
    loc_1C10:
        goto loc_1BD4;
    loc_1C14:
        goto loc_1820;
    loc_1C24:
        if (x9 == 0) goto loc_1DC8;
        goto loc_1C2C;
    loc_1C2C:
    loc_1C44:
        if (x2 == 0) goto loc_22E4;
        goto loc_1C4C;
    loc_1C4C:
        goto loc_18F8;
    loc_1C5C:
        if (((uint64_t)x7 & (uint64_t)v2197) != 0) goto loc_1E58;
        goto loc_1C68;
    loc_1C68:
        if (x8 != 0) goto loc_2038;
        goto loc_1C70;
    loc_1C70:
        if (x7 == 0) goto loc_1FE8;
        goto loc_1C78;
    loc_1C78:
        if (x6 == 0) goto loc_1FC8;
        goto loc_1C7C;
    loc_1C7C:
        if (v2284 == 0) goto loc_1898;
        goto loc_1C8C;
    loc_1C8C:
        goto loc_18AC;
    loc_1CA0:
    loc_1CA8:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_1F8C;
        goto loc_1CB4;
    loc_1CB4:
        if ((int32_t)v389 > (int32_t)v2420) goto loc_1DE0;
        goto loc_1CBC;
    loc_1CBC:
        if ((int32_t)v3294 > (int32_t)v1552) goto loc_200C;
        goto loc_1CC4;
    loc_1CC4:
        goto loc_1DEC;
    loc_1CF4:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1E84;
        goto loc_1D00;
    loc_1D00:
        if (x6 != 0) goto loc_1FE0;
        goto loc_1D08;
    loc_1D08:
        goto loc_19FC;
    loc_1D20:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_19DC;
        goto loc_1D2C;
    loc_1D2C:
        if (x0 != 0) goto loc_1A74;
        goto loc_1D34;
    loc_1D34:
        goto loc_1C44;
    loc_1D44:
    loc_1D50:
        goto loc_1B98;
    loc_1D60:
        goto loc_189C;
    loc_1D98:
        goto loc_1820;
    loc_1DC4:
    loc_1DC8:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        goto loc_1914;
    loc_1DE0:
    loc_1DEC:
        goto loc_182C;
    loc_1E08:
        if (x2 == 0) goto loc_2084;
        goto loc_1E10;
    loc_1E10:
        if (v3049 != 0) goto loc_1B40;
        goto loc_1E18;
    loc_1E18:
        goto loc_1B98;
    loc_1E2C:
        goto loc_1D50;
    loc_1E58:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_20E0;
        goto loc_1E64;
    loc_1E64:
        goto loc_18AC;
    loc_1E84:
        goto loc_1834;
    loc_1E9C:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2114;
        goto loc_1EA8;
    loc_1EA8:
        goto loc_19DC;
    loc_1EC0:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_2138;
        goto loc_1ECC;
    loc_1ECC:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2150;
        goto loc_1ED4;
    loc_1ED4:
        if (x7 == 0) goto loc_1F08;
        goto loc_1ED8;
    loc_1ED8:
        if (x6 != 0) goto loc_2168;
        goto loc_1EE4;
    loc_1EE4:
        goto loc_1C44;
    loc_1EF0:
        goto loc_1B98;
    loc_1F00:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2150;
        goto loc_1F08;
    loc_1F08:
        if (x6 != 0) goto loc_21CC;
        goto loc_1F0C;
    loc_1F0C:
        goto loc_1C4C;
    loc_1F20:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_19DC;
        goto loc_1F2C;
    loc_1F2C:
        if (x0 == 0) goto loc_1D34;
        goto loc_1F34;
    loc_1F34:
        goto loc_1A80;
    loc_1F40:
        if (((uint64_t)x16 & (uint64_t)v27) == 0) goto loc_1FF4;
        goto loc_1F48;
    loc_1F48:
        if (((uint32_t)v2102 & (uint32_t)v1437) != 0) goto loc_22A0;
        goto loc_1F5C;
    loc_1F5C:
        if ((uint64_t)x1 == (uint64_t)v2929) goto loc_2238;
        goto loc_1F64;
    loc_1F64:
        if ((uint64_t)x1 != (uint64_t)v3286) goto loc_1AA8;
        goto loc_1F70;
    loc_1F70:
        if (x15 != 0) goto loc_1BDC;
        goto loc_1F88;
    loc_1F88:
        goto loc_1BD4;
    loc_1F8C:
        if (x1 == 0) goto loc_1DC4;
        goto loc_1F94;
    loc_1F94:
        goto loc_1C44;
    loc_1FB4:
        if (x6 == 0) goto loc_20A0;
        goto loc_1FB8;
    loc_1FB8:
    loc_1FC8:
    loc_1FD0:
        if (v2642 == 0) goto loc_18D8;
        goto loc_1FD8;
    loc_1FD8:
        goto loc_18D8;
    loc_1FE0:
        goto loc_1834;
    loc_1FE8:
        if (x6 != 0) goto loc_22D8;
        goto loc_1FEC;
    loc_1FEC:
        goto loc_19FC;
    loc_1FF4:
        goto loc_1AEC;
    loc_1FFC:
        goto loc_1B88;
    loc_200C:
        goto loc_1DEC;
    loc_2038:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_21E0;
        goto loc_2044;
    loc_2044:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2284;
        goto loc_204C;
    loc_204C:
        if (x7 != 0) goto loc_21F8;
        goto loc_2050;
    loc_2050:
        goto loc_1C44;
    loc_2060:
        if (x1 == 0) goto loc_1DC8;
        goto loc_2068;
    loc_2068:
        goto loc_1C44;
    loc_2084:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2254;
        goto loc_2090;
    loc_2090:
        goto loc_19DC;
    loc_20A0:
        goto loc_19FC;
    loc_20B4:
        goto loc_1B88;
    loc_20E0:
        if (((uint64_t)x16 & (uint64_t)v1746) == 0) goto loc_1FF4;
        goto loc_20E8;
    loc_20E8:
        if (((uint32_t)v3086 & (uint32_t)v1628) != 0) goto loc_22A0;
        goto loc_20FC;
    loc_20FC:
        if ((uint64_t)x1 != (uint64_t)v527) goto loc_1F64;
        goto loc_2104;
    loc_2104:
        if (x6 == 0) goto loc_223C;
        goto loc_2108;
    loc_2108:
        goto loc_1AEC;
    loc_2114:
        if (x0 == 0) goto loc_227C;
        goto loc_211C;
    loc_211C:
        goto loc_1A80;
    loc_2138:
        if (x7 == 0) goto loc_1F00;
        goto loc_213C;
    loc_213C:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_1ED8;
        goto loc_2150;
    loc_2150:
        if (x6 == 0) goto loc_2274;
        goto loc_2154;
    loc_2154:
        if (x7 == 0) goto loc_21CC;
        goto loc_2160;
    loc_2160:
    loc_2168:
        if (v1687 == 0) goto loc_218C;
        goto loc_2174;
    loc_2174:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_218C;
        goto loc_217C;
    loc_217C:
    loc_218C:
        goto loc_1C44;
    loc_21A0:
        if (x6 == 0) goto loc_20A0;
        goto loc_21A8;
    loc_21A8:
        goto loc_18AC;
    loc_21BC:
        if (v770 != 0) goto loc_1FD0;
        goto loc_21C8;
    loc_21C8:
        goto loc_18D8;
    loc_21CC:
        goto loc_1C44;
    loc_21E0:
        if (x7 == 0) goto loc_22AC;
        goto loc_21E4;
    loc_21E4:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_22CC;
        goto loc_21F8;
    loc_21F8:
        if (x1 == 0) goto loc_2290;
        goto loc_2200;
    loc_2200:
        if (v511 == 0) goto loc_2228;
        goto loc_2210;
    loc_2210:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2228;
        goto loc_2218;
    loc_2218:
    loc_2228:
        goto loc_1C44;
    loc_2238:
        if (x6 != 0) goto loc_2108;
        goto loc_223C;
    loc_223C:
        goto loc_18DC;
    loc_2254:
        if (x0 == 0) goto loc_1D34;
        goto loc_225C;
    loc_225C:
        goto loc_1A80;
    loc_2274:
        if (x7 == 0) goto loc_1F0C;
        goto loc_2278;
    loc_2278:
        goto loc_1ED8;
    loc_227C:
        goto loc_1D34;
    loc_2284:
        if (x1 != 0) goto loc_22BC;
        goto loc_228C;
    loc_228C:
        if (x7 == 0) goto loc_1DC8;
        goto loc_2290;
    loc_2290:
        goto loc_1C44;
    loc_22A0:
        goto loc_1AEC;
    loc_22AC:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_2050;
        goto loc_22B4;
    loc_22B4:
        if (x1 == 0) goto loc_1DC8;
        goto loc_22BC;
    loc_22BC:
        if (x7 != 0) goto loc_2200;
        goto loc_22C8;
    loc_22C8:
        goto loc_2050;
    loc_22CC:
        if (x1 != 0) goto loc_22BC;
        goto loc_22D4;
    loc_22D4:
        goto loc_2290;
    loc_22D8:
        goto loc_1FC8;
    loc_22E4:
        goto loc_18F8;
}
void multf3(void)
{
    uint64 load_1416;
    uint64 load_739;
    uint64 load_746;
    uint64 load_1821;
    loc_2300:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_2792;
        local_pFFFFFFFFFFFFFFF0 = var_2786;
        load_1416 = var_30;
        load_739 = var_30;
        load_746 = var_40;
        load_1821 = var_40;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if (bit_extract(load_739, 48, 15) == 0) goto loc_2744;
        goto loc_2334;
    loc_2334:
        if ((uint32_t)bit_extract(load_739, 48, 15) == 0x7FFF) goto loc_278C;
        goto loc_2340;
    loc_2340:
    loc_2364:
        if (bit_extract(load_1821, 48, 15) == 0) goto loc_26E8;
        goto loc_237C;
    loc_237C:
        if ((uint32_t)bit_extract(load_1821, 48, 15) == 0x7FFF) goto loc_23D4;
        goto loc_2388;
    loc_2388:
        if ((int64_t)phi(4, 0, 8, 12) <= 10) goto loc_240C;
        goto loc_23C0;
    loc_23C0:
        if ((uint64_t)phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1) == 11) goto loc_2AF4;
        goto loc_23C8;
    loc_23C8:
        goto loc_24CC;
    loc_23D4:
        if (load_746 | (bit_extract(load_1821, 0, 48)) != 0) goto loc_2460;
        goto loc_23E4;
    loc_23E4:
        if ((int64_t)(phi(4, 0, 8, 12)) | 2 > 10) goto loc_2A60;
        goto loc_2404;
    loc_2404:
    loc_240C:
        if ((int64_t)phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1, (phi(4, 0, 8, 12)) | 2) > 2) goto loc_2488;
        goto loc_2414;
    loc_2414:
        if ((uint64_t)(phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1, (phi(4, 0, 8, 12)) | 2)) - 1 > 1) goto loc_252C;
        goto loc_2420;
    loc_2420:
        if ((uint64_t)phi(0, 1, 2) == 2) goto loc_251C;
        goto loc_2428;
    loc_2428:
        if ((uint64_t)phi(phi(phi(phi(1, 0, 2, 3), phi(3, 2), phi(phi(0, 1, 2), 3)), phi(0, 1)), phi(0, 1, 2)) != 1) goto loc_268C;
        goto loc_2430;
    loc_2430:
    loc_243C:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        if (x0 != 0) goto loc_28F4;
        goto loc_2458;
    loc_2458:
        return;
    loc_2460:
        if ((int64_t)(phi(4, 0, 8, 12)) | 3 > 10) goto loc_2AE8;
        goto loc_2488;
    loc_2488:
        if (((uint64_t)1 << ((phi(phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1, (phi(4, 0, 8, 12)) | 2), (phi(4, 0, 8, 12)) | 3)) & 63) & (uint64_t)0x530) != 0) goto loc_24C4;
        goto loc_249C;
    loc_249C:
        if (((uint64_t)1 << ((phi(phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1, (phi(4, 0, 8, 12)) | 2), (phi(4, 0, 8, 12)) | 3)) & 63) & (uint64_t)0x240) != 0) goto loc_2504;
        goto loc_24A8;
    loc_24A8:
        if (((uint64_t)1 << ((phi(phi(phi(4, 0, 8, 12), (phi(4, 0, 8, 12)) | 1, (phi(4, 0, 8, 12)) | 2), (phi(4, 0, 8, 12)) | 3)) & 63) & (uint64_t)0x88) == 0) goto loc_252C;
        goto loc_24B4;
    loc_24B4:
        goto loc_24CC;
    loc_24C4:
    loc_24CC:
        if ((uint64_t)phi(phi(1, 0, 2, 3), phi(3, 2), phi(phi(0, 1, 2), 3)) == 2) goto loc_251C;
        goto loc_24D8;
    loc_24D8:
    loc_24E8:
        if ((uint64_t)phi(phi(phi(1, 0, 2, 3), phi(3, 2), phi(phi(0, 1, 2), 3)), phi(0, 1)) != 3) goto loc_2428;
        goto loc_24F0;
    loc_24F0:
        goto loc_243C;
    loc_2504:
        goto loc_243C;
    loc_251C:
        goto loc_243C;
    loc_252C:
        local_pFFFFFFFFFFFFFFD0 = local_x21;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        if (bit_extract(((condition_ne ? (((uint64_t)((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF))) + ((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32)) + 0x100000000 : ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32))) + 1 : ((uint64_t)((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF))) + ((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32)) + 0x100000000 : ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32)))) + ((condition_ne ? ((((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF))) + ((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32)) >> 32) + 1 : (((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) >> 32) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) >> 32) * ((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF))) + ((((phi(0, v2118 | 0x8000000000000, bit_extract(load_739, 0, 48), phi((load_1416 >> ((61 - (phi(v1976 + 49, v1387 - 15))) & 63)) | ((bit_extract(load_739, 0, 48)) << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63)), load_1416 << (((v1976 + 49) - 61) & 63)))) & 0xFFFFFFFF) * ((phi(phi(phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0), bit_extract(load_1821, 0, 48)), phi(v447 | 0x8000000000000, phi(load_746 << (((v1009 + 49) - 61) & 63), (load_746 >> ((61 - (phi(v1009 + 49, v282 - 15))) & 63)) | ((bit_extract(load_1821, 0, 48)) << (((phi(v1009 + 49, v282 - 15)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32)) >> 32)), 39, 1) == 0) goto loc_2814;
        goto loc_2674;
    loc_2674:
    loc_268C:
        if ((int64_t)(phi(phi(phi(phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000), phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000)), phi(phi(phi((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))), ((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011, phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x7FFF), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x7FFF), phi((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))), ((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011, phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x7FFF)), phi(phi(phi(phi(phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000), (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000, phi((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000, phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1))), phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1)), phi(((((bit_extract(load_1821, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64))))) + 1, (((phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) - (phi(v1009 + 64, phi(v1009 + 64, v282)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 1, (phi(0, ((bit_extract(load_739, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0xFFFFFFFFFFFFC011 - (phi(phi(v1976 + 64, v1387), v1976 + 64)))) + 0x8000)))) + 0x3FFF <= 0) goto loc_2824;
        goto loc_269C;
    loc_269C:
        if (((uint64_t)phi((((((((uint64_t)(((((phi(phi(phi(load_746 << 3, phi(0, load_746 << (((phi(v1009 + 49, v282 - 15)) + 3) & 63)), 0), load_746), phi(load_746 << 3, phi(0, load_746 << (((phi(v1009 + 49, v282 - 15)) + 3) & 63)), 0))) & 0xFFFFFFFF) * ((phi(load_1416 | (bit_extract(load_739, 0, 48)), load_1416 << 3, load_1416, phi(load_1416 << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63), 0))) & v2019)) & v486) + v790) | v1931 != (uint64_t)v1353 ? 1 : 0)) | v1158) | v2544) & v1951) | v982) | v2326, ((((uint64_t)(((((phi(phi(phi(load_746 << 3, phi(0, load_746 << (((phi(v1009 + 49, v282 - 15)) + 3) & 63)), 0), load_746), phi(load_746 << 3, phi(0, load_746 << (((phi(v1009 + 49, v282 - 15)) + 3) & 63)), 0))) & 0xFFFFFFFF) * ((phi(load_1416 | (bit_extract(load_739, 0, 48)), load_1416 << 3, load_1416, phi(load_1416 << (((phi(v1976 + 49, v1387 - 15)) + 3) & 63), 0))) & v2019)) & v486) + v790) | v1931 != (uint64_t)v1353 ? 1 : 0)) | v1158) | v2544, x7) & (uint64_t)v2553) == 0) goto loc_26C0;
        goto loc_26A4;
    loc_26A4:
        if ((uint64_t)x3 == (uint64_t)v1965) goto loc_2A3C;
        goto loc_26B4;
    loc_26B4:
        if ((uint64_t)x3 == (uint64_t)v908) goto loc_2A08;
        goto loc_26BC;
    loc_26BC:
        if (x3 == 0) goto loc_29F0;
        goto loc_26C0;
    loc_26C0:
        if (v474 == 0) goto loc_26CC;
        goto loc_26C4;
    loc_26C4:
    loc_26CC:
        if ((int64_t)x1 > (int64_t)x3) goto loc_28A8;
        goto loc_26D8;
    loc_26D8:
        goto loc_243C;
    loc_26E8:
        if (x2 == 0) goto loc_27E4;
        goto loc_26F0;
    loc_26F0:
        if (x12 == 0) goto loc_292C;
        goto loc_26F4;
    loc_26F4:
    loc_26FC:
    loc_2718:
        if ((int64_t)x1 > (int64_t)v520) goto loc_23C0;
        goto loc_2740;
    loc_2740:
        goto loc_240C;
    loc_2744:
        if (load_1416 | (bit_extract(load_739, 0, 48)) == 0) goto loc_27CC;
        goto loc_274C;
    loc_274C:
        if (bit_extract(load_739, 0, 48) == 0) goto loc_2908;
        goto loc_2750;
    loc_2750:
    loc_2758:
    loc_2774:
        goto loc_2364;
    loc_278C:
        if (load_1416 | (bit_extract(load_739, 0, 48)) != 0) goto loc_27AC;
        goto loc_2794;
    loc_2794:
        goto loc_2364;
    loc_27AC:
        goto loc_2364;
    loc_27CC:
        goto loc_2364;
    loc_27E4:
        if ((int64_t)x1 > (int64_t)v156) goto loc_23C0;
        goto loc_2810;
    loc_2810:
        goto loc_240C;
    loc_2814:
        goto loc_268C;
    loc_2824:
        if ((int64_t)x1 > (int64_t)v248) goto loc_2954;
        goto loc_2834;
    loc_2834:
        if ((int64_t)x1 <= (int64_t)v1923) goto loc_2988;
        goto loc_283C;
    loc_283C:
        if (((uint64_t)x8 & (uint64_t)v735) == 0) goto loc_29BC;
        goto loc_2870;
    loc_2870:
    loc_2874:
        if ((uint64_t)x6 == (uint64_t)v549) goto loc_2A18;
        goto loc_2884;
    loc_2884:
        if ((uint64_t)x6 == (uint64_t)v2178) goto loc_2AD4;
        goto loc_288C;
    loc_288C:
        if (x6 == 0) goto loc_2AB8;
        goto loc_2890;
    loc_2890:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2A28;
        goto loc_2894;
    loc_2894:
        goto loc_28DC;
    loc_28A8:
        if ((uint64_t)x8 == (uint64_t)v223) goto loc_2A44;
        goto loc_28B4;
    loc_28B4:
        if ((uint64_t)x8 == (uint64_t)v1925) goto loc_29D4;
        goto loc_28BC;
    loc_28BC:
        if (x8 == 0) goto loc_28D4;
        goto loc_28C8;
    loc_28C8:
    loc_28D4:
    loc_28DC:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
    loc_28F4:
        memory_unknown = local_phi_3006;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_2908:
        if ((int64_t)v1976 + 49 <= 60) goto loc_2758;
        goto loc_291C;
    loc_291C:
        goto loc_2774;
    loc_292C:
        if ((int64_t)x2 <= (int64_t)v2474) goto loc_26FC;
        goto loc_2940;
    loc_2940:
        goto loc_2718;
    loc_2954:
        if (x8 == 0) goto loc_2978;
        goto loc_295C;
    loc_295C:
        if ((uint64_t)x6 == (uint64_t)v1709) goto loc_2978;
        goto loc_2970;
    loc_2970:
    loc_2978:
        goto loc_28DC;
    loc_2988:
        if (((uint64_t)x8 & (uint64_t)v1579) != 0) goto loc_2874;
        goto loc_29B8;
    loc_29B8:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2AE0;
        goto loc_29BC;
    loc_29BC:
        if (v818 == 0) goto loc_243C;
        goto loc_29CC;
    loc_29CC:
        goto loc_28DC;
    loc_29D4:
        goto loc_28D4;
    loc_29F0:
        if ((uint64_t)x3 == (uint64_t)v1328) goto loc_26C0;
        goto loc_29FC;
    loc_29FC:
        goto loc_26C0;
    loc_2A08:
        if (x2 == 0) goto loc_26C0;
        goto loc_2A0C;
    loc_2A0C:
        goto loc_26C0;
    loc_2A18:
        if (x2 != 0) goto loc_2A24;
        goto loc_2A1C;
    loc_2A1C:
    loc_2A24:
        if (v1243 == 0) goto loc_2894;
        goto loc_2A28;
    loc_2A28:
        goto loc_28DC;
    loc_2A3C:
        if (x2 != 0) goto loc_26C0;
        goto loc_2A40;
    loc_2A40:
        goto loc_2A0C;
    loc_2A44:
        goto loc_28D4;
    loc_2A60:
    loc_2A64:
        if ((uint64_t)x1 != (uint64_t)v1467) goto loc_2A8C;
        goto loc_2A6C;
    loc_2A6C:
        if (v120 == 0) goto loc_2AA4;
        goto loc_2A70;
    loc_2A70:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2AA4;
        goto loc_2A74;
    loc_2A74:
        goto loc_243C;
    loc_2A8C:
        if ((uint64_t)x1 != (uint64_t)v794) goto loc_23C8;
        goto loc_2A94;
    loc_2A94:
        goto loc_24CC;
    loc_2AA4:
        goto loc_243C;
    loc_2AB8:
        if ((uint64_t)x1 == (uint64_t)v938) goto loc_2A24;
        goto loc_2AC4;
    loc_2AC4:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2A28;
        goto loc_2AD0;
    loc_2AD0:
        goto loc_2894;
    loc_2AD4:
        if (x2 != 0) goto loc_2A1C;
        goto loc_2AD8;
    loc_2AD8:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2A28;
        goto loc_2ADC;
    loc_2ADC:
        goto loc_2894;
    loc_2AE0:
        goto loc_2A28;
    loc_2AE8:
        goto loc_2A64;
    loc_2AF4:
        goto loc_24E8;
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
