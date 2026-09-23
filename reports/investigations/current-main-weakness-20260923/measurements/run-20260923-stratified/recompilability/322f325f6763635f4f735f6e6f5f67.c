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
    test_data_types_l1(/* arguments unknown */);
    test_array_types(/* arguments unknown */);
    test_pointer_types(/* arguments unknown */);
    test_composite_types(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_18;
    uint64 load_38;
    load_18 = var_0;
    load_38 = global_13FF0;
    unknown_call(load_38);
    unknown_call(load_38);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FE0;
    __asm("cbz x0, #0x804");
    return sub_730(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x14010 != 0x14010) {
        if (!(global_13FD0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_65;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_65 = global_13FF8;
        if (!(load_65 == 0)) {
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
    if (!(global_14010 != 0)) {
        if (!(global_13FD8 == 0)) {
            unknown_call(global_14008);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void double_value(void)
{
    return;
}
void process_int(void)
{
    return;
}
void complex_callback(void)
{
    a1->field_0 += 10;
    return;
}
void process_char(void)
{
    if ((uint32_t)((a1 & 0xFF) - 65) & 0xFF <= 25) {
    }
    return;
}
void process_short(void)
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
uint64 process_double(void)
{
    return 0x3000;
}
void process_ld(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    multf3(/* arguments unknown */);
    addtf3(/* arguments unknown */);
    return;
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
    uint64 load_19;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    unknown_call("=== 测试基础数据类型 ===");
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_19 = global_3150;
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFFFC = 10;
}
void array_1d_stack(void)
{
    while ((int32_t)a2 > (int32_t)phi(x2 + 1, 0)) {
        continue;
    }
    return;
}
void array_string(void)
{
    for (int64 i = 0; (a1 - 1)[(phi(0, x1)) + 1] != 0; i++) {
    }
    return;
}
void array_2d_stack(void)
{
    while ((uint64_t)(phi(x1, a1)) + 44 != (uint64_t)a1 + 0x1B8) {
    }
    return;
}
void array_3d(void)
{
    for (int64 i = phi(x1 + 20, a1); (uint64_t)x1 + 20 != (uint64_t)(phi(x1 + 20, a1)) + 0x64; i += 20) {
    }
    if ((uint64_t)a1 + 0x1F4 != (uint64_t)x1 + 20) {
        goto loc_B7C;
    }
    return;
}
void array_vla(void)
{
    while ((int32_t)a1 > (int32_t)phi(0, x2 + 1)) {
        continue;
    }
    return;
}
void array_pointer(void)
{
    while ((int32_t)a2 > (int32_t)phi(0, x2 + 1)) {
        continue;
    }
    return;
}
void pointer_array(void)
{
    while ((int32_t)((int32_t)a2 <= 10 ? a2 : 10) > (int32_t)phi(0, x2 + 1)) {
        if (!(a1[phi(0, x2 + 1)] == 0)) {
        }
        continue;
    }
    return;
}
uint32 array_complex_index(void * a1, int64 a2, int64 a3, int64 a4, int64 a5)
{
    /* cmp (int32)((uint32)((uint32)a4 | (uint32)a5)), 0 — 次の分岐のための比較 */
    /* ccmp (int32)(a4), (int32)(a2), 0, ge — 次の分岐のための比較 */
    __asm("b.ge #0xc78");
    /* cmp (int32)(a5), (int32)(a3) — 次の分岐のための比較 */
    __asm("b.ge #0xc78");
    loc_C74:
    return x0;
    __asm("b #0xc74");
    goto loc_C74;
}
void array_oob(void)
{
    while ((int32_t)a2 >= (int32_t)phi(x2 + 1, 0)) {
        continue;
    }
    return;
}
void test_array_types(void)
{
    uint64 load_41;
    local_m570 = local_x29;
    local_m570 = local_x29;
    local_m560 = local_x19;
    local_m560 = local_x19;
    local_m550 = local_x21;
    local_m8 = memory_unknown;
    unknown_call("=== 测试数组类型 ===");
    load_41 = global_3168;
    local_m518 = global_3160;
    local_m518 = global_3160;
    local_m508 = global_3170;
    array_1d_stack(/* arguments unknown */);
    unknown_call(1);
    local_mC = global_2DA4;
    local_m10 = global_2DA0;
    array_string(/* arguments unknown */);
    unknown_call(1);
    local_phi_1071[local_phi_1035] = (uint32_t)local_phi_1548 == (uint32_t)local_phi_1035 ? (uint32_t)local_phi_1035 : 0;
    while ((uint64_t)x1 + 1 != 10) {
    }
    if ((uint32_t)x2 + 1 != 10) {
        goto loc_D54;
    }
    array_2d_stack(/* arguments unknown */);
    unknown_call(1);
    memory_unknown = 1;
    memory_unknown = 1;
    memory_unknown = 1;
    memory_unknown = 1;
    memory_unknown = 1;
    for (int64 i = phi((sp - 0x570) + 0x368, x3 + 0x64); (uint32_t)phi(5, v684 - 1) != 1; i += 20) {
    }
    if ((uint32_t)phi(5, v575 - 1) != 1) {
        goto loc_DA8;
    }
    array_3d(/* arguments unknown */);
    unknown_call(1);
    local_m528 = bit_insert(10, 20, 32, 16);
    local_m520 = 30;
    array_vla(/* arguments unknown */);
    unknown_call(1);
    local_m460 = 0;
    local_m438 = 10;
    local_m410 = 20;
    local_m3E8 = 30;
    local_m3C0 = 40;
    array_pointer(/* arguments unknown */);
    unknown_call(1);
    local_m4B8 = 0;
    local_m534 = 10;
    local_m534 = 10;
    local_m52C = 30;
    local_m4E8 = var_111;
    local_m4E8 = var_111;
    local_m4C8 = var_111;
    local_m500 = var_1066 - 0x570 + 60;
    local_m4F8 = var_1066 - 0x570 + 64;
    local_m4F0 = var_1066 - 0x570 + 68;
    pointer_array(/* arguments unknown */);
    unknown_call(1);
    (var_1066 - 0x570 + 0xC0)[local_phi_1102] = local_phi_1102;
    while ((uint64_t)x0 + 1 != 20) {
    }
    unknown_call(1);
    if ((uint64_t)var_568 != (uint64_t)memory_unknown) {
        unknown_call(global_13FE8);
    }
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
    while ((int32_t)a2 > (int32_t)phi(x2 + 1, 0)) {
        continue;
    }
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
uint32 ptr_void(void * a1, int64 a2)
{
    __asm("cbnz w1, #0xf8c");
    loc_F88:
    return x0;
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0xf9c");
    __asm("b #0xf88");
    goto loc_F88;
    __asm("b #0xf88");
    goto loc_F88;
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
    __asm("br x16");
}
void ptr_func_complex(void)
{
    uint64 load_105;
    uint64 load_43;
    uint64 load_113;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFE8 = 0x2DA6;
    local_pFFFFFFFFFFFFFFE8 = 0x2DA6;
    unknown_call(a2);
    load_105 = global_13FE8;
    load_43 = var_28;
    load_113 = memory_unknown;
    if ((uint64_t)load_43 != (uint64_t)load_113) {
        unknown_call(a2);
    }
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
    uint64 load_19;
    uint64 load_472;
    uint64 load_46;
    uint64 load_505;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFA0 = local_x29;
    local_pFFFFFFFFFFFFFFB0 = local_x19;
    local_pFFFFFFFFFFFFFFB0 = local_x19;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试指针类型 ===");
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFFC8 = 5;
    local_pFFFFFFFFFFFFFFD0 = var_633 + 0xFFFFFFFFFFFFFFA0 + 40;
    local_pFFFFFFFFFFFFFFD8 = var_633 + 0xFFFFFFFFFFFFFFA0 + 48;
    ptr_triple(/* arguments unknown */);
    unknown_call(1);
    load_19 = global_3168;
    local_pFFFFFFFFFFFFFFE0 = global_3160;
    local_pFFFFFFFFFFFFFFE0 = global_3160;
    local_pFFFFFFFFFFFFFFF0 = global_3170;
    ptr_increment(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    ptr_func_simple(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFFCC = 5;
    ptr_func_complex(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_472 = global_13FE8;
    load_46 = var_58;
    load_505 = memory_unknown;
    if ((uint64_t)load_46 != (uint64_t)load_505) {
        unknown_call(load_472);
    }
    return;
}
void struct_simple(void)
{
    return;
}
void struct_array(void)
{
    for (int64 i = a1; (int32_t)phi(0, x4 + 1) < (int32_t)a2; i += 12) {
        continue;
    }
    return;
}
void struct_nested(void)
{
    return;
}
void struct_deep(void)
{
    return;
}
uint32 struct_with_ptr(void * a1)
{
    x1 = *(uint64 *)(a1 + 8);
    x2 = *(uint32 *)(a1);
    __asm("cbz x1, #0x12a8");
    x0 = *(uint32 *)(x1);
    loc_12A0:
    return (uint32)((uint32)x2 + (uint32)x0);
    x0 = 0;
    __asm("b #0x12a0");
    goto loc_12A0;
}
void struct_bitfields(void)
{
    return;
}
uint8 union_type(void * a1, int64 a2)
{
    __asm("cbnz w1, #0x12e0");
    loc_12DC:
    return x0;
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x12f4");
    x0 = (int64)*(uint32 *)(x0);
    __asm("b #0x12dc");
    goto loc_12DC;
    __asm("b #0x12dc");
    goto loc_12DC;
}
void union_array(void)
{
    while ((int32_t)a2 > (int32_t)phi(x2 + 1, 0)) {
        continue;
    }
    return;
}
void enum_type(void)
{
    return;
}
uint32 enum_switch(int64 a1)
{
    /* cmp (int32)(a1), 3 — 次の分岐のための比較 */
    __asm("b.hi #0x134c");
    loc_1348:
    return x0;
    __asm("b #0x1348");
    goto loc_1348;
}
uint32 struct_func_ptr(void * a1)
{
    __asm("br x16");
}
void linked_list(void)
{
    while (phi(a1, memory_unknown) != 0) {
        continue;
    }
    return;
}
void doubly_linked_list(void)
{
    while (phi(a1, memory_unknown) != 0) {
        continue;
    }
    return;
}
void binary_tree_sum(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    while (!(phi(memory_unknown, a1) == 0)) {
        binary_tree_sum(/* arguments unknown */);
        continue;
    }
    return;
}
void binary_tree(void)
{
}
void graph_traverse(void)
{
    uint32 load_23;
    load_23 = a1->field_50;
    while ((int32_t)load_23 > (int32_t)phi(0, x1 + 1)) {
        while (phi(a1[phi(0, x1 + 1)], memory_unknown) != 0) {
            continue;
        }
        continue;
    }
    return;
}
void test_composite_types(void)
{
    uint64 load_579;
    uint64 load_450;
    uint64 load_495;
    uint64 load_838;
    local_pFFFFFFFFFFFFFE80 = local_x29;
    local_pFFFFFFFFFFFFFE80 = local_x29;
    local_pFFFFFFFFFFFFFE90 = local_x19;
    local_pFFFFFFFFFFFFFE90 = local_x19;
    local_pFFFFFFFFFFFFFEA0 = local_x21;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试复合类型 ===");
    unknown_call(1);
    load_579 = global_3178;
    local_pFFFFFFFFFFFFFF28 = global_3178;
    local_pFFFFFFFFFFFFFF28 = global_3178;
    local_pFFFFFFFFFFFFFF38 = global_3188;
    struct_array(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFEC0 = 20;
    local_pFFFFFFFFFFFFFEC8 = 0;
    local_pFFFFFFFFFFFFFED0 = 10;
    local_pFFFFFFFFFFFFFED8 = var_1095 + 0xFFFFFFFFFFFFFE80 + 64;
    struct_with_ptr(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFEB8 = local_pFFFFFFFFFFFFFEB8 & 0xFFFFFFFFFFFF0000 & 0xFFF00000FFFFFFFF | 0x191D;
    struct_bitfields(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF18 = global_3190;
    local_pFFFFFFFFFFFFFF20 = global_3198;
    union_array(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFEE0 = 10;
    local_pFFFFFFFFFFFFFEE8 = 0x8DC;
    struct_func_ptr(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF48 = var_1095 + 0xFFFFFFFFFFFFFE80 + 0xD0;
    local_pFFFFFFFFFFFFFF58 = var_1095 + 0xFFFFFFFFFFFFFE80 + 0xE0;
    local_pFFFFFFFFFFFFFF40 = 10;
    local_pFFFFFFFFFFFFFF50 = 20;
    local_pFFFFFFFFFFFFFF60 = 30;
    local_pFFFFFFFFFFFFFF68 = 0;
    linked_list(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF70 = 10;
    local_pFFFFFFFFFFFFFF78 = var_1095 + 0xFFFFFFFFFFFFFE80 + 0x108;
    local_pFFFFFFFFFFFFFF78 = var_1095 + 0xFFFFFFFFFFFFFE80 + 0x108;
    local_pFFFFFFFFFFFFFF88 = 20;
    local_pFFFFFFFFFFFFFF90 = 0;
    local_pFFFFFFFFFFFFFF90 = 0;
    doubly_linked_list(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFF00 = 0x64;
    local_pFFFFFFFFFFFFFF08 = 0;
    local_pFFFFFFFFFFFFFF08 = 0;
    binary_tree_sum(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFEF8 = 0;
    local_pFFFFFFFFFFFFFEF0 = 1;
    local_pFFFFFFFFFFFFFFA8 = var_1;
    local_pFFFFFFFFFFFFFFA8 = var_1;
    local_pFFFFFFFFFFFFFFC8 = var_1;
    local_pFFFFFFFFFFFFFFC8 = var_1;
    local_pFFFFFFFFFFFFFFE8 = var_1;
    local_pFFFFFFFFFFFFFFA0 = var_1095 + 0xFFFFFFFFFFFFFE80 + 0x70;
    local_pFFFFFFFFFFFFFFF0 = 2;
    graph_traverse(/* arguments unknown */);
    unknown_call(call_1492);
    load_450 = global_13FE8;
    load_495 = var_178;
    load_838 = memory_unknown;
    if ((uint64_t)load_495 != (uint64_t)load_838) {
        unknown_call(load_450);
    }
    return;
}
void addtf3(void)
{
    uint64 load_1150;
    uint64 load_665;
    uint64 load_2886;
    uint64 load_215;
    loc_16F0:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_4934;
        local_pFFFFFFFFFFFFFFF0 = var_5301;
        load_1150 = var_10;
        load_665 = var_10;
        load_2886 = var_20;
        load_215 = var_20;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if ((uint64_t)load_665 >> 63 == (uint64_t)load_215 >> 63) goto loc_18E0;
        goto loc_1750;
    loc_1750:
        if ((int32_t)(bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)) <= 0) goto loc_18AC;
        goto loc_1760;
    loc_1760:
        if (bit_extract(load_215, 48, 15) == 0) goto loc_1940;
        goto loc_1764;
    loc_1764:
    loc_1768:
        if ((uint64_t)bit_extract(load_665, 48, 15) == 0x7FFF) goto loc_1BB4;
        goto loc_1774;
    loc_1774:
        if ((int32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) > 0x74) goto loc_1BA4;
        goto loc_177C;
    loc_177C:
        if ((int32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) > 63) goto loc_1D28;
        goto loc_1784;
    loc_1784:
    loc_17B0:
    loc_17BC:
        if (bit_extract(phi(((x7 | (load_1150 >> 61)) + (~(v1657 | (load_2886 >> 61)))) + (bit_extract(((load_1150 << 3) & (~(load_2886 << 3))) | (((load_1150 << 3) | (~(load_2886 << 3))) & (~((load_1150 << 3) - (load_2886 << 3)))), 63, 1)), ((phi((x7 | (load_1150 >> 61)) - ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63)), x7 | (load_1150 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_1150 << 3) & (~(phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63)))))) | (((load_1150 << 3) | (~(phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63)))))) & (~((load_1150 << 3) - (phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63))))))), 63, 1)), ((phi((v1657 | (load_2886 >> 61)) - ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)), v1657 | (load_2886 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_2886 << 3) & (~(phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0))))) | (((load_2886 << 3) | (~(phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0))))) & (~((load_2886 << 3) - (phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0)))))), 63, 1)), ((v1657 | (load_2886 >> 61)) + (~(x7 | (load_1150 >> 61)))) + (bit_extract(((load_2886 << 3) & (~(load_1150 << 3))) | (((load_2886 << 3) | (~(load_1150 << 3))) & (~((load_2886 << 3) - (load_1150 << 3)))), 63, 1))), 51, 1) == 0) goto loc_196C;
        goto loc_17C4;
    loc_17C4:
        if (phi(((x7 | (load_1150 >> 61)) + (~(v1657 | (load_2886 >> 61)))) + (bit_extract(((load_1150 << 3) & (~(load_2886 << 3))) | (((load_1150 << 3) | (~(load_2886 << 3))) & (~((load_1150 << 3) - (load_2886 << 3)))), 63, 1)), ((v1657 | (load_2886 >> 61)) + (~(x7 | (load_1150 >> 61)))) + (bit_extract(((load_2886 << 3) & (~(load_1150 << 3))) | (((load_2886 << 3) | (~(load_1150 << 3))) & (~((load_2886 << 3) - (load_1150 << 3)))), 63, 1)), (phi(((x7 | (load_1150 >> 61)) + (~(v1657 | (load_2886 >> 61)))) + (bit_extract(((load_1150 << 3) & (~(load_2886 << 3))) | (((load_1150 << 3) | (~(load_2886 << 3))) & (~((load_1150 << 3) - (load_2886 << 3)))), 63, 1)), ((phi((x7 | (load_1150 >> 61)) - ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63)), x7 | (load_1150 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_1150 << 3) & (~(phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63)))))) | (((load_1150 << 3) | (~(phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63)))))) & (~((load_1150 << 3) - (phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63))))))), 63, 1)), ((phi((v1657 | (load_2886 >> 61)) - ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)), v1657 | (load_2886 >> 61))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_2886 << 3) & (~(phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0))))) | (((load_2886 << 3) | (~(phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0))))) & (~((load_2886 << 3) - (phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0)))))), 63, 1)), ((v1657 | (load_2886 >> 61)) + (~(x7 | (load_1150 >> 61)))) + (bit_extract(((load_2886 << 3) & (~(load_1150 << 3))) | (((load_2886 << 3) | (~(load_1150 << 3))) & (~((load_2886 << 3) - (load_1150 << 3)))), 63, 1)))) & 0x7FFFFFFFFFFFF) == 0) goto loc_1AA4;
        goto loc_17C8;
    loc_17C8:
    loc_17D0:
    loc_17E4:
        if ((int64_t)sext(phi(phi(v3352 - 12, v2564 + 52), v2564 + 52)) < (int64_t)phi(bit_extract(load_665, 48, 15), phi(bit_extract(load_665, 48, 15), bit_extract(load_215, 48, 15)))) goto loc_1960;
        goto loc_17F0;
    loc_17F0:
        if ((int32_t)((phi(phi(v3352 - 12, v2564 + 52), v2564 + 52)) - (phi(bit_extract(load_665, 48, 15), phi(bit_extract(load_665, 48, 15), bit_extract(load_215, 48, 15))))) + 1 > 63) goto loc_1CF0;
        goto loc_1800;
    loc_1800:
    loc_1828:
    loc_182C:
        if (phi((phi((((phi(((phi((load_1150 << 3) - (load_2886 << 3), (load_2886 << 3) - (load_1150 << 3), phi((load_1150 << 3) - (load_2886 << 3), (load_1150 << 3) - (phi((((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) | ((load_2886 << 3) >> ((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) & 63))) | (((uint64_t)(load_2886 << 3) << ((64 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63) != 0 ? 1 : 0)), ((uint64_t)(phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) | (load_2886 << 3) != 0 ? 1 : 0), (((uint64_t)((uint32_t)phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) != 64 ? (load_2886 << 3) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63)) : load_2886 << 3) != 0 ? 1 : 0)) | ((phi(v1657 | (load_2886 >> 61), (v1657 | (load_2886 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))) - 1, (bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) - 64) & 63)))), (load_2886 << 3) - (phi((((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) | ((load_1150 << 3) >> ((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) & 63))) | (((uint64_t)(load_1150 << 3) << ((64 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63) != 0 ? 1 : 0)), (((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))) != 64 ? (load_1150 << 3) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)))))) & 63)) : load_1150 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) >> (((phi(0 - ((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))), ~((bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_1150 >> 61)) | 0x8000000000000, x7 | (load_1150 >> 61))) | (load_1150 << 3) != 0 ? 1 : 0))), x11))) >> v641) | x3, x0)) << v3442) | x2) | x1, x9)) | x13, x6) == 0) goto loc_1980;
        goto loc_1830;
    loc_1830:
    loc_183C:
        if (x0 == 0) goto loc_214C;
        goto loc_1840;
    loc_1840:
        if ((uint64_t)x1 == (uint64_t)v3422) goto loc_1B98;
        goto loc_184C;
    loc_184C:
        if ((uint64_t)x1 == (uint64_t)v2039) goto loc_1B5C;
        goto loc_1854;
    loc_1854:
        if (x1 == 0) goto loc_1B7C;
        goto loc_1858;
    loc_1858:
        if (v2024 == 0) goto loc_1868;
        goto loc_1864;
    loc_1864:
    loc_1868:
        if (x1 == 0) goto loc_1A18;
        goto loc_186C;
    loc_186C:
        if ((uint64_t)x2 == (uint64_t)x1) goto loc_1A34;
        goto loc_187C;
    loc_187C:
    loc_1888:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        if (v2110 != 0) goto loc_1A90;
        goto loc_18A4;
    loc_18A4:
        return;
    loc_18AC:
        if ((uint32_t)(bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)) == 0) goto loc_1998;
        goto loc_18B0;
    loc_18B0:
        if (x8 != 0) goto loc_1C30;
        goto loc_18B4;
    loc_18B4:
        if (x2 == 0) goto loc_1E2C;
        goto loc_18BC;
    loc_18BC:
        if (v3537 != 0) goto loc_1C38;
        goto loc_18C4;
    loc_18C4:
        goto loc_17BC;
    loc_18E0:
        if ((int32_t)v2312 <= (int32_t)v974) goto loc_1AC0;
        goto loc_18EC;
    loc_18EC:
        if (x7 == 0) goto loc_19E0;
        goto loc_18F0;
    loc_18F0:
        if ((uint64_t)x8 == (uint64_t)x1) goto loc_1BB4;
        goto loc_1900;
    loc_1900:
        if ((int32_t)v2328 > (int32_t)v123) goto loc_1CD4;
        goto loc_1908;
    loc_1908:
        if ((int32_t)v1165 > (int32_t)v1114) goto loc_1DBC;
        goto loc_1910;
    loc_1910:
        goto loc_1CE0;
    loc_1940:
        if (x1 == 0) goto loc_1CB0;
        goto loc_1948;
    loc_1948:
        if ((uint32_t)(bit_extract(load_665, 48, 15)) - (bit_extract(load_215, 48, 15)) != 1) goto loc_1768;
        goto loc_1950;
    loc_1950:
        goto loc_17BC;
    loc_1960:
    loc_196C:
        if (x2 != 0) goto loc_183C;
        goto loc_197C;
    loc_197C:
        if (x6 != 0) goto loc_1830;
        goto loc_1980;
    loc_1980:
    loc_198C:
        goto loc_1888;
    loc_1998:
        if (((uint64_t)x6 & (uint64_t)v2458) != 0) goto loc_1C84;
        goto loc_19A4;
    loc_19A4:
        if (x8 != 0) goto loc_1E50;
        goto loc_19B0;
    loc_19B0:
        if (x7 == 0) goto loc_1F44;
        goto loc_19B4;
    loc_19B4:
        if (x6 == 0) goto loc_1F58;
        goto loc_19B8;
    loc_19B8:
        if (v1871 == 0) goto loc_2130;
        goto loc_19C4;
    loc_19C4:
        goto loc_182C;
    loc_19E0:
        if (x1 == 0) goto loc_1EB0;
        goto loc_19E8;
    loc_19E8:
        if ((uint32_t)v1232 == (uint32_t)v99) goto loc_1E80;
        goto loc_19F0;
    loc_19F0:
        if ((uint64_t)x8 != (uint64_t)x1) goto loc_1900;
        goto loc_19FC;
    loc_19FC:
        if (x0 == 0) goto loc_1D58;
        goto loc_1A04;
    loc_1A04:
    loc_1A10:
    loc_1A18:
        if ((uint64_t)x2 == (uint64_t)x3) goto loc_1BD4;
        goto loc_1A30;
    loc_1A30:
        goto loc_198C;
    loc_1A34:
    loc_1A38:
        if (x1 == 0) goto loc_1A70;
        goto loc_1A3C;
    loc_1A3C:
        if ((uint64_t)x1 == (uint64_t)v3213) goto loc_1A6C;
        goto loc_1A44;
    loc_1A44:
        if (((uint32_t)v2964 & (uint32_t)v134) != 0) goto loc_1A70;
        goto loc_1A54;
    loc_1A54:
        goto loc_198C;
    loc_1A6C:
        if (x15 != 0) goto loc_1A54;
        goto loc_1A70;
    loc_1A70:
    loc_1A7C:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
    loc_1A90:
        memory_unknown = local_phi_5992;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_1AA4:
        if ((int32_t)v583 <= (int32_t)v1566) goto loc_17D0;
        goto loc_1AB4;
    loc_1AB4:
        goto loc_17E4;
    loc_1AC0:
        if ((uint32_t)v2312 == (uint32_t)v974) goto loc_1BEC;
        goto loc_1AC4;
    loc_1AC4:
        if (x8 == 0) goto loc_1D98;
        goto loc_1AC8;
    loc_1AC8:
    loc_1AD0:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_1FF0;
        goto loc_1ADC;
    loc_1ADC:
        if ((int32_t)v3518 > (int32_t)v358) goto loc_1F8C;
        goto loc_1AE4;
    loc_1AE4:
        if ((int32_t)v2862 > (int32_t)v2636) goto loc_2044;
        goto loc_1AEC;
    loc_1AEC:
    loc_1B18:
    loc_1B28:
        if (v3458 == 0) goto loc_196C;
        goto loc_1B2C;
    loc_1B2C:
        if ((uint64_t)x2 == (uint64_t)x0) goto loc_1ED0;
        goto loc_1B3C;
    loc_1B3C:
        goto loc_183C;
    loc_1B5C:
        if (x15 == 0) goto loc_1B6C;
        goto loc_1B64;
    loc_1B64:
    loc_1B6C:
        if (v461 == 0) goto loc_1868;
        goto loc_1B74;
    loc_1B74:
        goto loc_1868;
    loc_1B7C:
        if ((uint64_t)x1 == (uint64_t)v1160) goto loc_1B6C;
        goto loc_1B8C;
    loc_1B8C:
        goto loc_1B6C;
    loc_1B98:
        if (x15 != 0) goto loc_1B6C;
        goto loc_1BA0;
    loc_1BA0:
        goto loc_1B64;
    loc_1BA4:
        goto loc_17B0;
    loc_1BB4:
        if (x9 == 0) goto loc_1D58;
        goto loc_1BBC;
    loc_1BBC:
    loc_1BD4:
        if (x2 == 0) goto loc_2274;
        goto loc_1BDC;
    loc_1BDC:
        goto loc_1888;
    loc_1BEC:
        if (((uint64_t)x7 & (uint64_t)v3374) != 0) goto loc_1DE8;
        goto loc_1BF8;
    loc_1BF8:
        if (x8 != 0) goto loc_1FC8;
        goto loc_1C00;
    loc_1C00:
        if (x7 == 0) goto loc_1F78;
        goto loc_1C08;
    loc_1C08:
        if (x6 == 0) goto loc_1F58;
        goto loc_1C0C;
    loc_1C0C:
        if (v1929 == 0) goto loc_1828;
        goto loc_1C1C;
    loc_1C1C:
        goto loc_183C;
    loc_1C30:
    loc_1C38:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_1F1C;
        goto loc_1C44;
    loc_1C44:
        if ((int32_t)v0 > (int32_t)v1028) goto loc_1D70;
        goto loc_1C4C;
    loc_1C4C:
        if ((int32_t)v2970 > (int32_t)v3268) goto loc_1F9C;
        goto loc_1C54;
    loc_1C54:
        goto loc_1D7C;
    loc_1C84:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1E14;
        goto loc_1C90;
    loc_1C90:
        if (x6 != 0) goto loc_1F70;
        goto loc_1C98;
    loc_1C98:
        goto loc_198C;
    loc_1CB0:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_196C;
        goto loc_1CBC;
    loc_1CBC:
        if (x0 != 0) goto loc_1A04;
        goto loc_1CC4;
    loc_1CC4:
        goto loc_1BD4;
    loc_1CD4:
    loc_1CE0:
        goto loc_1B28;
    loc_1CF0:
        goto loc_182C;
    loc_1D28:
        goto loc_17B0;
    loc_1D54:
    loc_1D58:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        goto loc_18A4;
    loc_1D70:
    loc_1D7C:
        goto loc_17BC;
    loc_1D98:
        if (x2 == 0) goto loc_2014;
        goto loc_1DA0;
    loc_1DA0:
        if (v1920 != 0) goto loc_1AD0;
        goto loc_1DA8;
    loc_1DA8:
        goto loc_1B28;
    loc_1DBC:
        goto loc_1CE0;
    loc_1DE8:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2070;
        goto loc_1DF4;
    loc_1DF4:
        goto loc_183C;
    loc_1E14:
        goto loc_17C4;
    loc_1E2C:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_20A4;
        goto loc_1E38;
    loc_1E38:
        goto loc_196C;
    loc_1E50:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_20C8;
        goto loc_1E5C;
    loc_1E5C:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_20E0;
        goto loc_1E64;
    loc_1E64:
        if (x7 == 0) goto loc_1E98;
        goto loc_1E68;
    loc_1E68:
        if (x6 != 0) goto loc_20F8;
        goto loc_1E74;
    loc_1E74:
        goto loc_1BD4;
    loc_1E80:
        goto loc_1B28;
    loc_1E90:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_20E0;
        goto loc_1E98;
    loc_1E98:
        if (x6 != 0) goto loc_215C;
        goto loc_1E9C;
    loc_1E9C:
        goto loc_1BDC;
    loc_1EB0:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_196C;
        goto loc_1EBC;
    loc_1EBC:
        if (x0 == 0) goto loc_1CC4;
        goto loc_1EC4;
    loc_1EC4:
        goto loc_1A10;
    loc_1ED0:
        if (((uint64_t)x16 & (uint64_t)v1864) == 0) goto loc_1F84;
        goto loc_1ED8;
    loc_1ED8:
        if (((uint32_t)v918 & (uint32_t)v2282) != 0) goto loc_2230;
        goto loc_1EEC;
    loc_1EEC:
        if ((uint64_t)x1 == (uint64_t)v614) goto loc_21C8;
        goto loc_1EF4;
    loc_1EF4:
        if ((uint64_t)x1 != (uint64_t)v2811) goto loc_1A38;
        goto loc_1F00;
    loc_1F00:
        if (x15 != 0) goto loc_1B6C;
        goto loc_1F18;
    loc_1F18:
        goto loc_1B64;
    loc_1F1C:
        if (x1 == 0) goto loc_1D54;
        goto loc_1F24;
    loc_1F24:
        goto loc_1BD4;
    loc_1F44:
        if (x6 == 0) goto loc_2030;
        goto loc_1F48;
    loc_1F48:
    loc_1F58:
    loc_1F60:
        if (v1488 == 0) goto loc_1868;
        goto loc_1F68;
    loc_1F68:
        goto loc_1868;
    loc_1F70:
        goto loc_17C4;
    loc_1F78:
        if (x6 != 0) goto loc_2268;
        goto loc_1F7C;
    loc_1F7C:
        goto loc_198C;
    loc_1F84:
        goto loc_1A7C;
    loc_1F8C:
        goto loc_1B18;
    loc_1F9C:
        goto loc_1D7C;
    loc_1FC8:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_2170;
        goto loc_1FD4;
    loc_1FD4:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2214;
        goto loc_1FDC;
    loc_1FDC:
        if (x7 != 0) goto loc_2188;
        goto loc_1FE0;
    loc_1FE0:
        goto loc_1BD4;
    loc_1FF0:
        if (x1 == 0) goto loc_1D58;
        goto loc_1FF8;
    loc_1FF8:
        goto loc_1BD4;
    loc_2014:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_21E4;
        goto loc_2020;
    loc_2020:
        goto loc_196C;
    loc_2030:
        goto loc_198C;
    loc_2044:
        goto loc_1B18;
    loc_2070:
        if (((uint64_t)x16 & (uint64_t)v2056) == 0) goto loc_1F84;
        goto loc_2078;
    loc_2078:
        if (((uint32_t)v3229 & (uint32_t)v1101) != 0) goto loc_2230;
        goto loc_208C;
    loc_208C:
        if ((uint64_t)x1 != (uint64_t)v3128) goto loc_1EF4;
        goto loc_2094;
    loc_2094:
        if (x6 == 0) goto loc_21CC;
        goto loc_2098;
    loc_2098:
        goto loc_1A7C;
    loc_20A4:
        if (x0 == 0) goto loc_220C;
        goto loc_20AC;
    loc_20AC:
        goto loc_1A10;
    loc_20C8:
        if (x7 == 0) goto loc_1E90;
        goto loc_20CC;
    loc_20CC:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_1E68;
        goto loc_20E0;
    loc_20E0:
        if (x6 == 0) goto loc_2204;
        goto loc_20E4;
    loc_20E4:
        if (x7 == 0) goto loc_215C;
        goto loc_20F0;
    loc_20F0:
    loc_20F8:
        if (v2437 == 0) goto loc_211C;
        goto loc_2104;
    loc_2104:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_211C;
        goto loc_210C;
    loc_210C:
    loc_211C:
        goto loc_1BD4;
    loc_2130:
        if (x6 == 0) goto loc_2030;
        goto loc_2138;
    loc_2138:
        goto loc_183C;
    loc_214C:
        if (v2601 != 0) goto loc_1F60;
        goto loc_2158;
    loc_2158:
        goto loc_1868;
    loc_215C:
        goto loc_1BD4;
    loc_2170:
        if (x7 == 0) goto loc_223C;
        goto loc_2174;
    loc_2174:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_225C;
        goto loc_2188;
    loc_2188:
        if (x1 == 0) goto loc_2220;
        goto loc_2190;
    loc_2190:
        if (v1391 == 0) goto loc_21B8;
        goto loc_21A0;
    loc_21A0:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_21B8;
        goto loc_21A8;
    loc_21A8:
    loc_21B8:
        goto loc_1BD4;
    loc_21C8:
        if (x6 != 0) goto loc_2098;
        goto loc_21CC;
    loc_21CC:
        goto loc_186C;
    loc_21E4:
        if (x0 == 0) goto loc_1CC4;
        goto loc_21EC;
    loc_21EC:
        goto loc_1A10;
    loc_2204:
        if (x7 == 0) goto loc_1E9C;
        goto loc_2208;
    loc_2208:
        goto loc_1E68;
    loc_220C:
        goto loc_1CC4;
    loc_2214:
        if (x1 != 0) goto loc_224C;
        goto loc_221C;
    loc_221C:
        if (x7 == 0) goto loc_1D58;
        goto loc_2220;
    loc_2220:
        goto loc_1BD4;
    loc_2230:
        goto loc_1A7C;
    loc_223C:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_1FE0;
        goto loc_2244;
    loc_2244:
        if (x1 == 0) goto loc_1D58;
        goto loc_224C;
    loc_224C:
        if (x7 != 0) goto loc_2190;
        goto loc_2258;
    loc_2258:
        goto loc_1FE0;
    loc_225C:
        if (x1 != 0) goto loc_224C;
        goto loc_2264;
    loc_2264:
        goto loc_2220;
    loc_2268:
        goto loc_1F58;
    loc_2274:
        goto loc_1888;
}
void multf3(void)
{
    uint64 load_1523;
    uint64 load_2499;
    uint64 load_972;
    uint64 load_1154;
    loc_2290:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_2815;
        local_pFFFFFFFFFFFFFFF0 = var_2710;
        load_1523 = var_30;
        load_2499 = var_30;
        load_972 = var_40;
        load_1154 = var_40;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if (bit_extract(load_2499, 48, 15) == 0) goto loc_26D4;
        goto loc_22C4;
    loc_22C4:
        if ((uint32_t)bit_extract(load_2499, 48, 15) == 0x7FFF) goto loc_271C;
        goto loc_22D0;
    loc_22D0:
    loc_22F4:
        if (bit_extract(load_1154, 48, 15) == 0) goto loc_2678;
        goto loc_230C;
    loc_230C:
        if ((uint32_t)bit_extract(load_1154, 48, 15) == 0x7FFF) goto loc_2364;
        goto loc_2318;
    loc_2318:
        if ((int64_t)phi(0, 4, 12, 8) <= 10) goto loc_239C;
        goto loc_2350;
    loc_2350:
        if ((uint64_t)phi((phi(0, 4, 12, 8)) | 1, phi(0, 4, 12, 8)) == 11) goto loc_2A84;
        goto loc_2358;
    loc_2358:
        goto loc_245C;
    loc_2364:
        if (load_972 | (bit_extract(load_1154, 0, 48)) != 0) goto loc_23F0;
        goto loc_2374;
    loc_2374:
        if ((int64_t)(phi(0, 4, 12, 8)) | 2 > 10) goto loc_29F0;
        goto loc_2394;
    loc_2394:
    loc_239C:
        if ((int64_t)phi(phi(0, 4, 12, 8), (phi(0, 4, 12, 8)) | 1, (phi(0, 4, 12, 8)) | 2) > 2) goto loc_2418;
        goto loc_23A4;
    loc_23A4:
        if ((uint64_t)(phi(phi(0, 4, 12, 8), (phi(0, 4, 12, 8)) | 1, (phi(0, 4, 12, 8)) | 2)) - 1 > 1) goto loc_24BC;
        goto loc_23B0;
    loc_23B0:
        if ((uint64_t)phi(0, 1, 2) == 2) goto loc_24AC;
        goto loc_23B8;
    loc_23B8:
        if ((uint64_t)phi(phi(phi(phi(3, 2), phi(0, 1, 3, 2), phi(phi(0, 1, 2), 3)), phi(1, 0)), phi(0, 1, 2)) != 1) goto loc_261C;
        goto loc_23C0;
    loc_23C0:
    loc_23CC:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        if (x0 != 0) goto loc_2884;
        goto loc_23E8;
    loc_23E8:
        return;
    loc_23F0:
        if ((int64_t)(phi(0, 4, 12, 8)) | 3 > 10) goto loc_2A78;
        goto loc_2418;
    loc_2418:
        if (((uint64_t)1 << ((phi(phi(phi(0, 4, 12, 8), (phi(0, 4, 12, 8)) | 1, (phi(0, 4, 12, 8)) | 2), (phi(0, 4, 12, 8)) | 3)) & 63) & (uint64_t)0x530) != 0) goto loc_2454;
        goto loc_242C;
    loc_242C:
        if (((uint64_t)1 << ((phi(phi(phi(0, 4, 12, 8), (phi(0, 4, 12, 8)) | 1, (phi(0, 4, 12, 8)) | 2), (phi(0, 4, 12, 8)) | 3)) & 63) & (uint64_t)0x240) != 0) goto loc_2494;
        goto loc_2438;
    loc_2438:
        if (((uint64_t)1 << ((phi(phi(phi(0, 4, 12, 8), (phi(0, 4, 12, 8)) | 1, (phi(0, 4, 12, 8)) | 2), (phi(0, 4, 12, 8)) | 3)) & 63) & (uint64_t)0x88) == 0) goto loc_24BC;
        goto loc_2444;
    loc_2444:
        goto loc_245C;
    loc_2454:
    loc_245C:
        if ((uint64_t)phi(phi(3, 2), phi(0, 1, 3, 2), phi(phi(0, 1, 2), 3)) == 2) goto loc_24AC;
        goto loc_2468;
    loc_2468:
    loc_2478:
        if ((uint64_t)phi(phi(phi(3, 2), phi(0, 1, 3, 2), phi(phi(0, 1, 2), 3)), phi(1, 0)) != 3) goto loc_23B8;
        goto loc_2480;
    loc_2480:
        goto loc_23CC;
    loc_2494:
        goto loc_23CC;
    loc_24AC:
        goto loc_23CC;
    loc_24BC:
        local_pFFFFFFFFFFFFFFD0 = local_x21;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        if (bit_extract(((condition_ne ? (((uint64_t)((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32)) + 0x100000000 : ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32))) + 1 : ((uint64_t)((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32)) + 0x100000000 : ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32)))) + ((condition_ne ? ((((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) >> 32)) >> 32) + 1 : (((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) >> 32) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) >> 32) * ((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF))) + ((((phi(v1282 | 0x8000000000000, phi(load_1523 << (((v916 + 49) - 61) & 63), (load_1523 >> ((61 - (phi(v916 + 49, v795 - 15))) & 63)) | ((bit_extract(load_2499, 0, 48)) << (((phi(v916 + 49, v795 - 15)) + 3) & 63))), 0, bit_extract(load_2499, 0, 48))) & 0xFFFFFFFF) * ((phi(phi(phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0), bit_extract(load_1154, 0, 48)), phi(phi((load_972 >> ((61 - (phi(v763 + 49, v1565 - 15))) & 63)) | ((bit_extract(load_1154, 0, 48)) << (((phi(v763 + 49, v1565 - 15)) + 3) & 63)), load_972 << (((v763 + 49) - 61) & 63)), v2180 | 0x8000000000000, 0))) & 0xFFFFFFFF)) >> 32)) >> 32)), 39, 1) == 0) goto loc_27A4;
        goto loc_2604;
    loc_2604:
    loc_261C:
        if ((int64_t)(phi(phi(phi(phi(((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011, (((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)), phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x7FFF), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x7FFF), phi(((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011, (((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)), phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x7FFF)), phi(phi(phi((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000, phi(phi((((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000), phi(phi((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000)), phi((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1)), phi((((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000)), phi(phi(phi((((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000), (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000), phi((((phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) - (phi(phi(v763 + 64, v1565), v763 + 64))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1154, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF))) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 1, (phi(((bit_extract(load_2499, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0xFFFFFFFFFFFFC011 - (phi(v916 + 64, phi(v916 + 64, v795))), 0, 0x7FFF)) + 0x8000)))) + 0x3FFF <= 0) goto loc_27B4;
        goto loc_262C;
    loc_262C:
        if (((uint64_t)phi(((((uint64_t)(((((phi(phi(phi(phi(load_972 << (((phi(v763 + 49, v1565 - 15)) + 3) & 63), 0), load_972 << 3, 0), load_972), phi(phi(load_972 << (((phi(v763 + 49, v1565 - 15)) + 3) & 63), 0), load_972 << 3, 0))) & 0xFFFFFFFF) * ((phi(load_1523 << 3, phi(0, load_1523 << (((phi(v916 + 49, v795 - 15)) + 3) & 63)), load_1523 | (bit_extract(load_2499, 0, 48)), load_1523)) & 0xFFFFFFFF)) & 0xFFFFFFFF) + (((x19 + v1249) + v870) << v1661)) | v2199 != (uint64_t)v984 ? 1 : 0)) | v624) | v1141, x7) & (uint64_t)v384) == 0) goto loc_2650;
        goto loc_2634;
    loc_2634:
        if ((uint64_t)x3 == (uint64_t)v174) goto loc_29CC;
        goto loc_2644;
    loc_2644:
        if ((uint64_t)x3 == (uint64_t)v1016) goto loc_2998;
        goto loc_264C;
    loc_264C:
        if (x3 == 0) goto loc_2980;
        goto loc_2650;
    loc_2650:
        if (v2411 == 0) goto loc_265C;
        goto loc_2654;
    loc_2654:
    loc_265C:
        if ((int64_t)x1 > (int64_t)x3) goto loc_2838;
        goto loc_2668;
    loc_2668:
        goto loc_23CC;
    loc_2678:
        if (x2 == 0) goto loc_2774;
        goto loc_2680;
    loc_2680:
        if (x12 == 0) goto loc_28BC;
        goto loc_2684;
    loc_2684:
    loc_268C:
    loc_26A8:
        if ((int64_t)x1 > (int64_t)v1134) goto loc_2350;
        goto loc_26D0;
    loc_26D0:
        goto loc_239C;
    loc_26D4:
        if (load_1523 | (bit_extract(load_2499, 0, 48)) == 0) goto loc_275C;
        goto loc_26DC;
    loc_26DC:
        if (bit_extract(load_2499, 0, 48) == 0) goto loc_2898;
        goto loc_26E0;
    loc_26E0:
    loc_26E8:
    loc_2704:
        goto loc_22F4;
    loc_271C:
        if (load_1523 | (bit_extract(load_2499, 0, 48)) != 0) goto loc_273C;
        goto loc_2724;
    loc_2724:
        goto loc_22F4;
    loc_273C:
        goto loc_22F4;
    loc_275C:
        goto loc_22F4;
    loc_2774:
        if ((int64_t)x1 > (int64_t)v747) goto loc_2350;
        goto loc_27A0;
    loc_27A0:
        goto loc_239C;
    loc_27A4:
        goto loc_261C;
    loc_27B4:
        if ((int64_t)x1 > (int64_t)v2629) goto loc_28E4;
        goto loc_27C4;
    loc_27C4:
        if ((int64_t)x1 <= (int64_t)v2508) goto loc_2918;
        goto loc_27CC;
    loc_27CC:
        if (((uint64_t)x8 & (uint64_t)v498) == 0) goto loc_294C;
        goto loc_2800;
    loc_2800:
    loc_2804:
        if ((uint64_t)x6 == (uint64_t)v971) goto loc_29A8;
        goto loc_2814;
    loc_2814:
        if ((uint64_t)x6 == (uint64_t)v641) goto loc_2A64;
        goto loc_281C;
    loc_281C:
        if (x6 == 0) goto loc_2A48;
        goto loc_2820;
    loc_2820:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_29B8;
        goto loc_2824;
    loc_2824:
        goto loc_286C;
    loc_2838:
        if ((uint64_t)x8 == (uint64_t)v1405) goto loc_29D4;
        goto loc_2844;
    loc_2844:
        if ((uint64_t)x8 == (uint64_t)v1554) goto loc_2964;
        goto loc_284C;
    loc_284C:
        if (x8 == 0) goto loc_2864;
        goto loc_2858;
    loc_2858:
    loc_2864:
    loc_286C:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
    loc_2884:
        memory_unknown = local_phi_4077;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_2898:
        if ((int64_t)v916 + 49 <= 60) goto loc_26E8;
        goto loc_28AC;
    loc_28AC:
        goto loc_2704;
    loc_28BC:
        if ((int64_t)x2 <= (int64_t)v1915) goto loc_268C;
        goto loc_28D0;
    loc_28D0:
        goto loc_26A8;
    loc_28E4:
        if (x8 == 0) goto loc_2908;
        goto loc_28EC;
    loc_28EC:
        if ((uint64_t)x6 == (uint64_t)v1132) goto loc_2908;
        goto loc_2900;
    loc_2900:
    loc_2908:
        goto loc_286C;
    loc_2918:
        if (((uint64_t)x8 & (uint64_t)v97) != 0) goto loc_2804;
        goto loc_2948;
    loc_2948:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2A70;
        goto loc_294C;
    loc_294C:
        if (v2414 == 0) goto loc_23CC;
        goto loc_295C;
    loc_295C:
        goto loc_286C;
    loc_2964:
        goto loc_2864;
    loc_2980:
        if ((uint64_t)x3 == (uint64_t)v1436) goto loc_2650;
        goto loc_298C;
    loc_298C:
        goto loc_2650;
    loc_2998:
        if (x2 == 0) goto loc_2650;
        goto loc_299C;
    loc_299C:
        goto loc_2650;
    loc_29A8:
        if (x2 != 0) goto loc_29B4;
        goto loc_29AC;
    loc_29AC:
    loc_29B4:
        if (v2286 == 0) goto loc_2824;
        goto loc_29B8;
    loc_29B8:
        goto loc_286C;
    loc_29CC:
        if (x2 != 0) goto loc_2650;
        goto loc_29D0;
    loc_29D0:
        goto loc_299C;
    loc_29D4:
        goto loc_2864;
    loc_29F0:
    loc_29F4:
        if ((uint64_t)x1 != (uint64_t)v528) goto loc_2A1C;
        goto loc_29FC;
    loc_29FC:
        if (v1261 == 0) goto loc_2A34;
        goto loc_2A00;
    loc_2A00:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2A34;
        goto loc_2A04;
    loc_2A04:
        goto loc_23CC;
    loc_2A1C:
        if ((uint64_t)x1 != (uint64_t)v165) goto loc_2358;
        goto loc_2A24;
    loc_2A24:
        goto loc_245C;
    loc_2A34:
        goto loc_23CC;
    loc_2A48:
        if ((uint64_t)x1 == (uint64_t)v371) goto loc_29B4;
        goto loc_2A54;
    loc_2A54:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_29B8;
        goto loc_2A60;
    loc_2A60:
        goto loc_2824;
    loc_2A64:
        if (x2 != 0) goto loc_29AC;
        goto loc_2A68;
    loc_2A68:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_29B8;
        goto loc_2A6C;
    loc_2A6C:
        goto loc_2824;
    loc_2A70:
        goto loc_29B8;
    loc_2A78:
        goto loc_29F4;
    loc_2A84:
        goto loc_2478;
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
