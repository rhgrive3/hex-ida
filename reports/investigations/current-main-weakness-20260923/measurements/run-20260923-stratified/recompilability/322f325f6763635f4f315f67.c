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
    uint64 load_20;
    uint64 load_6;
    load_20 = var_0;
    load_6 = global_13FF0;
    unknown_call(load_6);
    unknown_call(load_6);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FE0;
    __asm("cbz x0, #0x7c4");
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
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_13FF8 == 0)) {
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
    uint64 load_244;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    unknown_call(0x2C58);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    load_244 = global_3340;
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    local_pFFFFFFFFFFFFFFFC = 10;
    unknown_call(1);
    return;
}
uint32 array_1d_stack(void * a1, int64 a2)
{
    x4 = a1;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xb08");
    x2 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x4 + x2 * 4));
    x2 = x2 + 1;
    /* cmp (int32)(a2), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.gt #0xaf0");
    loc_B04:
    return x0;
    __asm("b #0xb04");
    goto loc_B04;
}
uint32 array_string(void * a1)
{
    __asm("cbz w1, #0xb34");
    x1 = 1;
    x3 = a1 - 1;
    x1 = x1 + 1;
    __asm("cbnz w2, #0xb20");
    loc_B30:
    return x0;
    __asm("b #0xb30");
    goto loc_B30;
}
void array_2d_stack(void)
{
    while ((uint64_t)(phi(a1, x1)) + 44 != (uint64_t)a1 + 0x1B8) {
    }
    return;
}
void array_3d(void)
{
    while ((uint64_t)(phi(x1, (phi(x3 + 0x64, a1 + 0x64)) - 0x64)) + 20 != (uint64_t)phi(x3 + 0x64, a1 + 0x64)) {
    }
    if ((uint64_t)x3 + 0x64 != (uint64_t)a1 + 0x258) {
        goto loc_B68;
    }
    return;
}
uint32 array_vla(int64 a1, void * a2)
{
    x4 = (uint32)a1;
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xbdc");
    x2 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(a2 + x2 * 4));
    x2 = x2 + 1;
    /* cmp (int32)(x4), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.gt #0xbc4");
    loc_BD8:
    return x0;
    __asm("b #0xbd8");
    goto loc_BD8;
}
uint32 array_pointer(void * a1, int64 a2)
{
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xc18");
    x2 = a1;
    x1 = a1 + 40 + (uint32)((uint32)a2 - 1) * 40;
    x0 = 0;
    x3 = *(uint32 *)(x2);
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x2));
    /* cmp x2, x1 — 次の分岐のための比較 */
    __asm("b.ne #0xc04");
    loc_C14:
    return x0;
    __asm("b #0xc14");
    goto loc_C14;
}
void pointer_array(void)
{
    uint64 load_81;
    if ((int32_t)a2 <= 0) {
    } else {
        load_81 = a1[phi(0, x1 + 1)];
        load_81 = a1[phi(0, x1 + 1)];
        if (load_81 != 0) {
        } else {
        }
        } else {
        }
        if ((int32_t)((int32_t)a2 <= 10 ? a2 : 10) > (int32_t)x1 + 1) {
        }
    }
    return;
}
uint32 array_complex_index(void * a1, int64 a2, int64 a3, int64 a4, int64 a5)
{
    /* cmp (int32)((uint32)((uint32)a4 | (uint32)a5)), 0 — 次の分岐のための比較 */
    /* ccmp (int32)(a4), (int32)(a2), 0, ge — 次の分岐のための比較 */
    __asm("b.ge #0xc90");
    /* cmp (int32)(a5), (int32)(a3) — 次の分岐のための比較 */
    __asm("b.ge #0xc98");
    loc_C8C:
    return x0;
    __asm("b #0xc8c");
    goto loc_C8C;
    __asm("b #0xc8c");
    goto loc_C8C;
}
uint32 array_oob(void * a1, uint32 a2)
{
    __asm("tbnz w1, #0x1f, #0xcc8");
    x2 = a1;
    x3 = a1 + 4 + (uint32)a2 * 4;
    x0 = 0;
    x1 = *(uint32 *)(x2);
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x2));
    /* cmp x2, x3 — 次の分岐のための比較 */
    __asm("b.ne #0xcb4");
    loc_CC4:
    return x0;
    __asm("b #0xcc4");
    goto loc_CC4;
}
uint64 test_array_types(void)
{
    uint32 var_3C, var_40, var_44, var_48, var_4C, var_50, var_104, var_110;
    uint32 var_138, var_160, var_188, var_1B0, var_560;
    uint64 var_58, var_70, var_78, var_80, var_568;

    var_568 = *(uint64 *)(*(uint64 *)0x13FE8);
    x0_1 = sub_750(" 11.4.0-1ubuntu1~22.04) 11.4.0", 0);
    x1_1 = 0x3350;
    x2_1 = *(uint64 *)0x3350;   x3_1 = *(uint64 *)0x3358;
    var_58 = x2_1;   var_60 = x3_1;
    *(uint32 *)(&var_58 + 0x10) = (uint32)"(Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0";
    x0_2 = array_1d_stack(&var_58, 5, x2_1, x3_1);
    x0_3 = sub_710(1, 0x2E08, (uint32)x0_2);
    x1_2 = 0x2F10;
    var_560 = *(uint32 *)(x1_2);
    x1_3 = *(uint16 *)0x2F14;
    *(uint16 *)(&var_560 + 4) = x1_3;
    x0_4 = array_string(&var_560, x1_3, x2_2);
    x0 = sub_710(1, 0x2E28, (uint32)x0_4);
    x3 = &var_1D8;
    x2 = 0;
    x4 = 0;
    __asm("b #0xd90");
    loc_D80:
    x2 = (uint32)((uint32)x2 + 1);
    x3 = x3 + 40;
    /* cmp (int32)(x2), 0xA — 次の分岐のための比較 */
    __asm("b.eq #0xdb0");
    x0 = 0;
    /* cmp (int32)(x2), (int32)(x0) — 次の分岐のための比較 */
    x1 = (uint32)((uint32)x2 == (uint32)x0 ? (uint32)x0 : (uint32)x4);
    *(uint32 *)(x3 + x0 * 4) = x1;
    x0 = x0 + 1;
    /* cmp x0, 0xA — 次の分岐のための比較 */
    __asm("b.ne #0xd94");
    __asm("b #0xd80");
    goto loc_D80;
    x0_5 = array_2d_stack(&var_1D8);
    x0 = sub_710(1, 0x2E48, (uint32)x0_5);
    x3 = &var_368;
    x4 = &var_55C;
    x1 = 1;
    x0 = x3;
    x2 = 0;
    *(uint32 *)(x0) = (uint32)x1;
    *(uint32 *)(x0 + 4) = (uint32)x1;
    *(uint32 *)(x0 + 8) = (uint32)x1;
    *(uint32 *)(x0 + 0xC) = (uint32)x1;
    *(uint32 *)(x0 + 0x10) = (uint32)x1;
    x2 = (uint32)((uint32)x2 + 1);
    x0 = x0 + 20;
    /* cmp (int32)(x2), 5 — 次の分岐のための比較 */
    __asm("b.ne #0xde0");
    x3 = x3 + 100;
    /* cmp x3, x4 — 次の分岐のための比較 */
    __asm("b.ne #0xdd8");
    x0_6 = array_3d(&var_368);
    x0_7 = sub_710(1, 0x2E68, (uint32)x0_6);
    var_48 = 10;
    var_4C = 20;
    var_50 = 30;
    x0_8 = array_vla(3, &var_48);
    x0_9 = sub_710(1, 0x2E88, (uint32)x0_8);
    var_110 = 0;
    var_138 = 10;
    var_160 = 20;
    var_188 = 30;
    var_1B0 = 40;
    x0_10 = array_pointer(&var_110, 5);
    x0_11 = sub_710(1, 0x2EA8, (uint32)x0_10);
    var_3C = 10;
    var_40 = 20;
    var_44 = 30;
    v0.4s = 0; /* vector zero */
    *(vector128 *)(&var_88) = v0;   *(vector128 *)(&var_88 + 0x10) = v0;
    *(vector128 *)(&var_88 + 0x20) = v0;
    *(uint64 *)(&var_88 + 0x30) = 0;
    var_70 = &var_3C;
    var_78 = &var_40;
    var_80 = &var_44;
    x0_12 = pointer_array(&var_70, 3);
    x0_13 = sub_710(1, 0x2EC8, (uint32)x0_12);
    x1 = &var_C0;
    x0 = 0;
    *(uint32 *)(x1) = (uint32)x0;
    x0 = (uint32)((uint32)x0 + 1);
    /* cmp (int32)(x0), 0x14 — 次の分岐のための比較 */
    __asm("b.ne #0xefc");
    x0_14 = sub_710(1, 0x2EE8, (uint32)var_104);
    x0 = *(uint64 *)0x13FE8;
    x2 = var_568 - *(uint64 *)(x0);
    x1 = 0;
    __asm("b.ne #0xf50");
    return x0;
    x0 = sub_720();
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
uint32 ptr_increment(void * a1, uint32 a2)
{
    x2 = a1;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0xfac");
    x3 = a1 + (uint32)a2 * 4;
    x0 = 0;
    x1 = *(uint32 *)(x2);
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x2));
    /* cmp x2, x3 — 次の分岐のための比較 */
    __asm("b.ne #0xf98");
    loc_FA8:
    return x0;
    __asm("b #0xfa8");
    goto loc_FA8;
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
    __asm("cbz w1, #0xfdc");
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.ne #0xfe4");
    loc_FD8:
    return x0;
    __asm("b #0xfd8");
    goto loc_FD8;
    __asm("b #0xfd8");
    goto loc_FD8;
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
void ptr_func_simple(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a2);
    return;
}
void ptr_func_complex(void)
{
    uint64 load_65;
    uint64 load_67;
    uint64 load_48;
    loc_1028:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE8 = 0x2F18;
        local_pFFFFFFFFFFFFFFF0 = 0;
        unknown_call(a2);
        load_65 = global_13FE8;
        load_67 = var_28;
        load_48 = memory_unknown;
        if ((uint64_t)load_67 != (uint64_t)load_48) goto loc_1088;
        goto loc_1080;
    loc_1080:
        return;
    loc_1088:
        unknown_call(a2);
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
    uint64 load_224;
    uint64 load_22;
    uint64 load_90;
    uint64 load_340;
    loc_10A4:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x19;
        local_pFFFFFFFFFFFFFFB0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x2F20);
        unknown_call(1);
        unknown_call(1);
        local_pFFFFFFFFFFFFFFC8 = 5;
        local_pFFFFFFFFFFFFFFD0 = var_655 + 0xFFFFFFFFFFFFFFA0 + 40;
        local_pFFFFFFFFFFFFFFD8 = var_655 + 0xFFFFFFFFFFFFFFA0 + 48;
        ptr_triple(/* arguments unknown */);
        unknown_call(1);
        load_224 = global_3358;
        local_pFFFFFFFFFFFFFFE0 = global_3350;
        local_pFFFFFFFFFFFFFFE0 = global_3350;
        local_pFFFFFFFFFFFFFFF0 = global_3360;
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
        load_22 = global_13FE8;
        load_90 = var_58;
        load_340 = memory_unknown;
        if ((uint64_t)load_90 != (uint64_t)load_340) goto loc_127C;
        goto loc_1270;
    loc_1270:
        return;
    loc_127C:
        unknown_call(load_22);
}
void struct_simple(void)
{
    return;
}
uint32 struct_array(void * a1, int64 a2)
{
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0x12e0");
    x2 = a1;
    x3 = a1 + 12 + (uint32)((uint32)a2 - 1) * 12;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)((uint32)((uint32)*(uint32 *)(x2) + (uint32)*(uint32 *)(x2 + 4)) + (uint32)*(uint32 *)(x2 + 8)));
    x2 = x2 + 12;
    /* cmp x2, x3 — 次の分岐のための比較 */
    __asm("b.ne #0x12b8");
    loc_12DC:
    return x0;
    __asm("b #0x12dc");
    goto loc_12DC;
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
    uint32 load_3;
    uint64 load_27;
    load_3 = a1->field_0;
    load_27 = a1->field_8;
    if (!(load_27 == 0)) {
    }
    return;
}
void struct_bitfields(void)
{
    return;
}
double union_type(void * a1, int64 a2)
{
    __asm("cbz w1, #0x135c");
    /* cmp (int32)(a2), 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1364");
    loc_1358:
    return x0;
    __asm("b #0x1358");
    goto loc_1358;
    x0 = (int64)*(uint32 *)(x0);
    __asm("b #0x1358");
    goto loc_1358;
}
uint32 union_array(void * a1, int64 a2)
{
    x4 = a1;
    /* cmp (int32)(a2), 0 — 次の分岐のための比較 */
    __asm("b.le #0x139c");
    x2 = 0;
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x4 + x2 * 4));
    x2 = x2 + 1;
    /* cmp (int32)(a2), (int32)(x2) — 次の分岐のための比較 */
    __asm("b.gt #0x1384");
    loc_1398:
    return x0;
    __asm("b #0x1398");
    goto loc_1398;
}
void enum_type(void)
{
    return;
}
uint32 enum_switch(int64 a1)
{
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.eq #0x13e0");
    /* cmp (int32)(a1), 2 — 次の分岐のための比較 */
    __asm("b.hi #0x13d0");
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    loc_13CC:
    return x0;
    /* cmp (int32)(x0), 3 — 次の分岐のための比較 */
    __asm("b #0x13cc");
    goto loc_13CC;
    __asm("b #0x13cc");
    goto loc_13CC;
}
void struct_func_ptr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1->field_0);
    return;
}
uint32 linked_list(void * a1)
{
    x1 = a1;
    __asm("cbz x0, #0x1424");
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x1));
    x1 = *(uint64 *)(x1 + 8);
    __asm("cbnz x1, #0x1410");
    loc_1420:
    return x0;
    __asm("b #0x1420");
    goto loc_1420;
}
uint32 doubly_linked_list(void * a1)
{
    x1 = a1;
    __asm("cbz x0, #0x144c");
    x0 = 0;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x1));
    x1 = *(uint64 *)(x1 + 8);
    __asm("cbnz x1, #0x1438");
    loc_1448:
    return x0;
    __asm("b #0x1448");
    goto loc_1448;
}
void binary_tree_sum(void)
{
    uint32 load_69;
    if (a1 == 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        binary_tree_sum(/* arguments unknown */);
        load_69 = memory_unknown;
        binary_tree_sum(/* arguments unknown */);
        return;
    }
}
void binary_tree(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    binary_tree_sum(/* arguments unknown */);
    return;
}
uint32 graph_traverse(void * a1)
{
    x4 = a1;
    x5 = *(uint32 *)(a1 + 0x50);
    /* cmp (int32)(x5), 0 — 次の分岐のための比較 */
    __asm("b.le #0x14ec");
    x3 = 0;
    x0 = 0;
    x1 = *(uint64 *)(x4 + x3 * 8);
    __asm("cbz x1, #0x14dc");
    x0 = (uint32)((uint32)x0 + (uint32)*(uint32 *)(x1));
    x1 = *(uint64 *)(x1 + 8);
    __asm("cbnz x1, #0x14cc");
    x3 = x3 + 1;
    /* cmp (int32)(x5), (int32)(x3) — 次の分岐のための比較 */
    __asm("b.gt #0x14c4");
    loc_14E8:
    return x0;
    __asm("b #0x14e8");
    goto loc_14E8;
}
void test_composite_types(void)
{
    uint64 load_930;
    uint64 load_554;
    uint64 load_1051;
    uint64 load_964;
    uint64 load_645;
    loc_14F4:
        local_pFFFFFFFFFFFFFE50 = local_x29;
        local_pFFFFFFFFFFFFFE50 = local_x29;
        local_pFFFFFFFFFFFFFE60 = local_x19;
        local_pFFFFFFFFFFFFFE60 = local_x19;
        local_pFFFFFFFFFFFFFE70 = local_x21;
        local_pFFFFFFFFFFFFFE70 = local_x21;
        local_pFFFFFFFFFFFFFE80 = local_x23;
        local_pFFFFFFFFFFFFFE80 = local_x23;
        local_pFFFFFFFFFFFFFE90 = local_x25;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x30F8);
        local_pFFFFFFFFFFFFFEB0 = 1;
        local_pFFFFFFFFFFFFFEB4 = 2;
        local_pFFFFFFFFFFFFFEB8 = 3;
        struct_simple(/* arguments unknown */);
        unknown_call(1);
        load_930 = global_3368;
        local_pFFFFFFFFFFFFFF28 = global_3368;
        local_pFFFFFFFFFFFFFF28 = global_3368;
        local_pFFFFFFFFFFFFFF38 = global_3378;
        struct_array(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        local_pFFFFFFFFFFFFFEC0 = 20;
        local_pFFFFFFFFFFFFFEC8 = 0;
        local_pFFFFFFFFFFFFFED0 = 10;
        local_pFFFFFFFFFFFFFED8 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0x70;
        struct_with_ptr(/* arguments unknown */);
        unknown_call(1);
        load_554 = var_FFFFFFFFFFFFFEA8;
        local_pFFFFFFFFFFFFFEA8 = load_554 | 1;
        local_pFFFFFFFFFFFFFEA8 = var_198;
        local_pFFFFFFFFFFFFFEA8 = local_pFFFFFFFFFFFFFEA8 & 0xFFF00000FFFFFFFF;
        struct_bitfields(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        local_pFFFFFFFFFFFFFF18 = global_3380;
        local_pFFFFFFFFFFFFFF20 = global_3388;
        union_array(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        local_pFFFFFFFFFFFFFEE0 = 10;
        local_pFFFFFFFFFFFFFEE8 = 0x89C;
        struct_func_ptr(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFF40 = 10;
        local_pFFFFFFFFFFFFFF48 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0x100;
        local_pFFFFFFFFFFFFFF50 = 20;
        local_pFFFFFFFFFFFFFF58 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0x110;
        local_pFFFFFFFFFFFFFF60 = 30;
        local_pFFFFFFFFFFFFFF68 = 0;
        linked_list(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFF70 = 10;
        local_pFFFFFFFFFFFFFF78 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0x138;
        local_pFFFFFFFFFFFFFF80 = 0;
        local_pFFFFFFFFFFFFFF88 = 20;
        local_pFFFFFFFFFFFFFF90 = 0;
        local_pFFFFFFFFFFFFFF98 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0x120;
        doubly_linked_list(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFF00 = 0x64;
        local_pFFFFFFFFFFFFFF08 = 0;
        local_pFFFFFFFFFFFFFF10 = 0;
        binary_tree_sum(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFEF0 = 1;
        local_pFFFFFFFFFFFFFEF8 = 0;
        local_pFFFFFFFFFFFFFFA8 = var_152;
        local_pFFFFFFFFFFFFFFA8 = var_152;
        local_pFFFFFFFFFFFFFFC8 = var_152;
        local_pFFFFFFFFFFFFFFC8 = var_152;
        local_pFFFFFFFFFFFFFFE8 = var_152;
        local_pFFFFFFFFFFFFFFA0 = var_1221 + 0xFFFFFFFFFFFFFE50 + 0xA0;
        local_pFFFFFFFFFFFFFFF0 = 2;
        graph_traverse(/* arguments unknown */);
        unknown_call(1);
        load_1051 = global_13FE8;
        load_964 = var_1A8;
        load_645 = memory_unknown;
        if ((uint64_t)load_964 != (uint64_t)load_645) goto loc_17F4;
        goto loc_17DC;
    loc_17DC:
        return;
    loc_17F4:
        unknown_call(load_1051);
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
    uint64 load_428;
    uint64 load_1362;
    uint64 load_2313;
    uint64 load_109;
    loc_1820:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_5158;
        local_pFFFFFFFFFFFFFFF0 = var_3422;
        load_428 = var_10;
        load_1362 = var_10;
        load_2313 = var_20;
        load_109 = var_20;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if ((uint64_t)load_1362 >> 63 == (uint64_t)load_109 >> 63) goto loc_1A10;
        goto loc_1880;
    loc_1880:
        if ((int32_t)(bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)) <= 0) goto loc_19DC;
        goto loc_1890;
    loc_1890:
        if (bit_extract(load_109, 48, 15) == 0) goto loc_1A70;
        goto loc_1894;
    loc_1894:
    loc_1898:
        if ((uint64_t)bit_extract(load_1362, 48, 15) == 0x7FFF) goto loc_1CE4;
        goto loc_18A4;
    loc_18A4:
        if ((int32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) > 0x74) goto loc_1CD4;
        goto loc_18AC;
    loc_18AC:
        if ((int32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) > 63) goto loc_1E58;
        goto loc_18B4;
    loc_18B4:
    loc_18E0:
    loc_18EC:
        if (bit_extract(phi(((x7 | (load_428 >> 61)) + (~(v2743 | (load_2313 >> 61)))) + (bit_extract(((load_428 << 3) & (~(load_2313 << 3))) | (((load_428 << 3) | (~(load_2313 << 3))) & (~((load_428 << 3) - (load_2313 << 3)))), 63, 1)), ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) - ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_2313 << 3) & (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) | (((load_2313 << 3) | (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) & (~((load_2313 << 3) - (phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0))))))), 63, 1)), ((v2743 | (load_2313 >> 61)) + (~(x7 | (load_428 >> 61)))) + (bit_extract(((load_2313 << 3) & (~(load_428 << 3))) | (((load_2313 << 3) | (~(load_428 << 3))) & (~((load_2313 << 3) - (load_428 << 3)))), 63, 1)), ((phi(x7 | (load_428 >> 61), (x7 | (load_428 >> 61)) - ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_428 << 3) & (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) | (((load_428 << 3) | (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) & (~((load_428 << 3) - (phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0))))))), 63, 1))), 51, 1) == 0) goto loc_1A9C;
        goto loc_18F4;
    loc_18F4:
        if (phi((phi(((x7 | (load_428 >> 61)) + (~(v2743 | (load_2313 >> 61)))) + (bit_extract(((load_428 << 3) & (~(load_2313 << 3))) | (((load_428 << 3) | (~(load_2313 << 3))) & (~((load_428 << 3) - (load_2313 << 3)))), 63, 1)), ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) - ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_2313 << 3) & (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) | (((load_2313 << 3) | (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) & (~((load_2313 << 3) - (phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0))))))), 63, 1)), ((v2743 | (load_2313 >> 61)) + (~(x7 | (load_428 >> 61)))) + (bit_extract(((load_2313 << 3) & (~(load_428 << 3))) | (((load_2313 << 3) | (~(load_428 << 3))) & (~((load_2313 << 3) - (load_428 << 3)))), 63, 1)), ((phi(x7 | (load_428 >> 61), (x7 | (load_428 >> 61)) - ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_428 << 3) & (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) | (((load_428 << 3) | (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) & (~((load_428 << 3) - (phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0))))))), 63, 1)))) & 0x7FFFFFFFFFFFF, ((v2743 | (load_2313 >> 61)) + (~(x7 | (load_428 >> 61)))) + (bit_extract(((load_2313 << 3) & (~(load_428 << 3))) | (((load_2313 << 3) | (~(load_428 << 3))) & (~((load_2313 << 3) - (load_428 << 3)))), 63, 1)), ((x7 | (load_428 >> 61)) + (~(v2743 | (load_2313 >> 61)))) + (bit_extract(((load_428 << 3) & (~(load_2313 << 3))) | (((load_428 << 3) | (~(load_2313 << 3))) & (~((load_428 << 3) - (load_2313 << 3)))), 63, 1))) == 0) goto loc_1BD4;
        goto loc_18F8;
    loc_18F8:
    loc_1900:
    loc_1914:
        if ((int64_t)sext(phi(phi(v218 + 52, v2699 - 12), v218 + 52)) < (int64_t)phi(phi(bit_extract(load_1362, 48, 15), bit_extract(load_109, 48, 15)), bit_extract(load_1362, 48, 15))) goto loc_1A90;
        goto loc_1920;
    loc_1920:
        if ((int32_t)((phi(phi(v218 + 52, v2699 - 12), v218 + 52)) - (phi(phi(bit_extract(load_1362, 48, 15), bit_extract(load_109, 48, 15)), bit_extract(load_1362, 48, 15)))) + 1 > 63) goto loc_1E20;
        goto loc_1930;
    loc_1930:
    loc_1958:
    loc_195C:
        if (phi((((uint64_t)((uint32_t)v2014 != (uint32_t)v981 ? (phi((phi(phi((load_428 << 3) - (load_2313 << 3), (load_2313 << 3) - (phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))), (load_2313 << 3) - (load_428 << 3), (load_428 << 3) - (phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0))))), (load_2313 << 3) - (load_428 << 3), (load_428 << 3) - (load_2313 << 3))) << v932, phi((phi(((x7 | (load_428 >> 61)) + (~(v2743 | (load_2313 >> 61)))) + (bit_extract(((load_428 << 3) & (~(load_2313 << 3))) | (((load_428 << 3) | (~(load_2313 << 3))) & (~((load_428 << 3) - (load_2313 << 3)))), 63, 1)), ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) - ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_2313 << 3) & (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) | (((load_2313 << 3) | (~(phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0)))))) & (~((load_2313 << 3) - (phi((((uint64_t)((uint32_t)phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) != 64 ? (load_428 << 3) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((0x80 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) : load_428 << 3) != 0 ? 1 : 0)) | ((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) >> (((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) - 64) & 63)), ((uint64_t)(phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) | (load_428 << 3) != 0 ? 1 : 0), (((phi((x7 | (load_428 >> 61)) | 0x8000000000000, x7 | (load_428 >> 61))) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63)) | ((load_428 << 3) >> ((phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63))) | (((uint64_t)(load_428 << 3) << ((64 - (phi(0 - ((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))), ~((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))))) & 63) != 0 ? 1 : 0))))))), 63, 1)), ((v2743 | (load_2313 >> 61)) + (~(x7 | (load_428 >> 61)))) + (bit_extract(((load_2313 << 3) & (~(load_428 << 3))) | (((load_2313 << 3) | (~(load_428 << 3))) & (~((load_2313 << 3) - (load_428 << 3)))), 63, 1)), ((phi(x7 | (load_428 >> 61), (x7 | (load_428 >> 61)) - ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63)))) + 0xFFFFFFFFFFFFFFFF) + (bit_extract(((load_428 << 3) & (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) | (((load_428 << 3) | (~(phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0)))))) & (~((load_428 << 3) - (phi((((uint64_t)((uint32_t)phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) != 64 ? (load_2313 << 3) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((0x80 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) : load_2313 << 3) != 0 ? 1 : 0)) | ((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) >> (((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) - 64) & 63)), ((uint64_t)(phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) | (load_2313 << 3) != 0 ? 1 : 0), (((phi(v2743 | (load_2313 >> 61), (v2743 | (load_2313 >> 61)) | 0x8000000000000)) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63)) | ((load_2313 << 3) >> ((phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)))) & 63))) | (((uint64_t)(load_2313 << 3) << ((64 - (phi(((bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))) - 1, (bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15))))) & 63) != 0 ? 1 : 0))))))), 63, 1)))) & 0x7FFFFFFFFFFFF, ((v2743 | (load_2313 >> 61)) + (~(x7 | (load_428 >> 61)))) + (bit_extract(((load_2313 << 3) & (~(load_428 << 3))) | (((load_2313 << 3) | (~(load_428 << 3))) & (~((load_2313 << 3) - (load_428 << 3)))), 63, 1)), ((x7 | (load_428 >> 61)) + (~(v2743 | (load_2313 >> 61)))) + (bit_extract(((load_428 << 3) & (~(load_2313 << 3))) | (((load_428 << 3) | (~(load_2313 << 3))) & (~((load_428 << 3) - (load_2313 << 3)))), 63, 1))))) | v3279 : v1403) != (uint64_t)v3370 ? 1 : 0)) | x0, x6) == 0) goto loc_1AB0;
        goto loc_1960;
    loc_1960:
    loc_196C:
        if (x0 == 0) goto loc_227C;
        goto loc_1970;
    loc_1970:
        if ((uint64_t)x1 == (uint64_t)v1452) goto loc_1CC8;
        goto loc_197C;
    loc_197C:
        if ((uint64_t)x1 == (uint64_t)v499) goto loc_1C8C;
        goto loc_1984;
    loc_1984:
        if (x1 == 0) goto loc_1CAC;
        goto loc_1988;
    loc_1988:
        if (v2826 == 0) goto loc_1998;
        goto loc_1994;
    loc_1994:
    loc_1998:
        if (x1 == 0) goto loc_1B48;
        goto loc_199C;
    loc_199C:
        if ((uint64_t)x2 == (uint64_t)x1) goto loc_1B64;
        goto loc_19AC;
    loc_19AC:
    loc_19B8:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        if (v3312 != 0) goto loc_1BC0;
        goto loc_19D4;
    loc_19D4:
        return;
    loc_19DC:
        if ((uint32_t)(bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)) == 0) goto loc_1AC8;
        goto loc_19E0;
    loc_19E0:
        if (x8 != 0) goto loc_1D60;
        goto loc_19E4;
    loc_19E4:
        if (x2 == 0) goto loc_1F5C;
        goto loc_19EC;
    loc_19EC:
        if (v2938 != 0) goto loc_1D68;
        goto loc_19F4;
    loc_19F4:
        goto loc_18EC;
    loc_1A10:
        if ((int32_t)v1065 <= (int32_t)v1572) goto loc_1BF0;
        goto loc_1A1C;
    loc_1A1C:
        if (x7 == 0) goto loc_1B10;
        goto loc_1A20;
    loc_1A20:
        if ((uint64_t)x8 == (uint64_t)x1) goto loc_1CE4;
        goto loc_1A30;
    loc_1A30:
        if ((int32_t)v2774 > (int32_t)v3381) goto loc_1E04;
        goto loc_1A38;
    loc_1A38:
        if ((int32_t)v182 > (int32_t)v1393) goto loc_1EEC;
        goto loc_1A40;
    loc_1A40:
        goto loc_1E10;
    loc_1A70:
        if (x1 == 0) goto loc_1DE0;
        goto loc_1A78;
    loc_1A78:
        if ((uint32_t)(bit_extract(load_1362, 48, 15)) - (bit_extract(load_109, 48, 15)) != 1) goto loc_1898;
        goto loc_1A80;
    loc_1A80:
        goto loc_18EC;
    loc_1A90:
    loc_1A9C:
        if (x2 != 0) goto loc_196C;
        goto loc_1AAC;
    loc_1AAC:
        if (x6 != 0) goto loc_1960;
        goto loc_1AB0;
    loc_1AB0:
    loc_1ABC:
        goto loc_19B8;
    loc_1AC8:
        if (((uint64_t)x6 & (uint64_t)v562) != 0) goto loc_1DB4;
        goto loc_1AD4;
    loc_1AD4:
        if (x8 != 0) goto loc_1F80;
        goto loc_1AE0;
    loc_1AE0:
        if (x7 == 0) goto loc_2074;
        goto loc_1AE4;
    loc_1AE4:
        if (x6 == 0) goto loc_2088;
        goto loc_1AE8;
    loc_1AE8:
        if (v606 == 0) goto loc_2260;
        goto loc_1AF4;
    loc_1AF4:
        goto loc_195C;
    loc_1B10:
        if (x1 == 0) goto loc_1FE0;
        goto loc_1B18;
    loc_1B18:
        if ((uint32_t)v2741 == (uint32_t)v2869) goto loc_1FB0;
        goto loc_1B20;
    loc_1B20:
        if ((uint64_t)x8 != (uint64_t)x1) goto loc_1A30;
        goto loc_1B2C;
    loc_1B2C:
        if (x0 == 0) goto loc_1E88;
        goto loc_1B34;
    loc_1B34:
    loc_1B40:
    loc_1B48:
        if ((uint64_t)x2 == (uint64_t)x3) goto loc_1D04;
        goto loc_1B60;
    loc_1B60:
        goto loc_1ABC;
    loc_1B64:
    loc_1B68:
        if (x1 == 0) goto loc_1BA0;
        goto loc_1B6C;
    loc_1B6C:
        if ((uint64_t)x1 == (uint64_t)v3071) goto loc_1B9C;
        goto loc_1B74;
    loc_1B74:
        if (((uint32_t)v2670 & (uint32_t)v87) != 0) goto loc_1BA0;
        goto loc_1B84;
    loc_1B84:
        goto loc_1ABC;
    loc_1B9C:
        if (x15 != 0) goto loc_1B84;
        goto loc_1BA0;
    loc_1BA0:
    loc_1BAC:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
    loc_1BC0:
        memory_unknown = local_phi_6095;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_1BD4:
        if ((int32_t)v359 <= (int32_t)v887) goto loc_1900;
        goto loc_1BE4;
    loc_1BE4:
        goto loc_1914;
    loc_1BF0:
        if ((uint32_t)v1065 == (uint32_t)v1572) goto loc_1D1C;
        goto loc_1BF4;
    loc_1BF4:
        if (x8 == 0) goto loc_1EC8;
        goto loc_1BF8;
    loc_1BF8:
    loc_1C00:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2120;
        goto loc_1C0C;
    loc_1C0C:
        if ((int32_t)v155 > (int32_t)v179) goto loc_20BC;
        goto loc_1C14;
    loc_1C14:
        if ((int32_t)v1653 > (int32_t)v93) goto loc_2174;
        goto loc_1C1C;
    loc_1C1C:
    loc_1C48:
    loc_1C58:
        if (v1521 == 0) goto loc_1A9C;
        goto loc_1C5C;
    loc_1C5C:
        if ((uint64_t)x2 == (uint64_t)x0) goto loc_2000;
        goto loc_1C6C;
    loc_1C6C:
        goto loc_196C;
    loc_1C8C:
        if (x15 == 0) goto loc_1C9C;
        goto loc_1C94;
    loc_1C94:
    loc_1C9C:
        if (v1960 == 0) goto loc_1998;
        goto loc_1CA4;
    loc_1CA4:
        goto loc_1998;
    loc_1CAC:
        if ((uint64_t)x1 == (uint64_t)v2332) goto loc_1C9C;
        goto loc_1CBC;
    loc_1CBC:
        goto loc_1C9C;
    loc_1CC8:
        if (x15 != 0) goto loc_1C9C;
        goto loc_1CD0;
    loc_1CD0:
        goto loc_1C94;
    loc_1CD4:
        goto loc_18E0;
    loc_1CE4:
        if (x9 == 0) goto loc_1E88;
        goto loc_1CEC;
    loc_1CEC:
    loc_1D04:
        if (x2 == 0) goto loc_23A4;
        goto loc_1D0C;
    loc_1D0C:
        goto loc_19B8;
    loc_1D1C:
        if (((uint64_t)x7 & (uint64_t)v3000) != 0) goto loc_1F18;
        goto loc_1D28;
    loc_1D28:
        if (x8 != 0) goto loc_20F8;
        goto loc_1D30;
    loc_1D30:
        if (x7 == 0) goto loc_20A8;
        goto loc_1D38;
    loc_1D38:
        if (x6 == 0) goto loc_2088;
        goto loc_1D3C;
    loc_1D3C:
        if (v394 == 0) goto loc_1958;
        goto loc_1D4C;
    loc_1D4C:
        goto loc_196C;
    loc_1D60:
    loc_1D68:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_204C;
        goto loc_1D74;
    loc_1D74:
        if ((int32_t)v706 > (int32_t)v223) goto loc_1EA0;
        goto loc_1D7C;
    loc_1D7C:
        if ((int32_t)v1821 > (int32_t)v2018) goto loc_20CC;
        goto loc_1D84;
    loc_1D84:
        goto loc_1EAC;
    loc_1DB4:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_1F44;
        goto loc_1DC0;
    loc_1DC0:
        if (x6 != 0) goto loc_20A0;
        goto loc_1DC8;
    loc_1DC8:
        goto loc_1ABC;
    loc_1DE0:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_1A9C;
        goto loc_1DEC;
    loc_1DEC:
        if (x0 != 0) goto loc_1B34;
        goto loc_1DF4;
    loc_1DF4:
        goto loc_1D04;
    loc_1E04:
    loc_1E10:
        goto loc_1C58;
    loc_1E20:
        goto loc_195C;
    loc_1E58:
        goto loc_18E0;
    loc_1E84:
    loc_1E88:
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        __asm("fmov v0.d[1], x5");
        goto loc_19D4;
    loc_1EA0:
    loc_1EAC:
        goto loc_18EC;
    loc_1EC8:
        if (x2 == 0) goto loc_2144;
        goto loc_1ED0;
    loc_1ED0:
        if (v2132 != 0) goto loc_1C00;
        goto loc_1ED8;
    loc_1ED8:
        goto loc_1C58;
    loc_1EEC:
        goto loc_1E10;
    loc_1F18:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_21A0;
        goto loc_1F24;
    loc_1F24:
        goto loc_196C;
    loc_1F44:
        goto loc_18F4;
    loc_1F5C:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_21D4;
        goto loc_1F68;
    loc_1F68:
        goto loc_1A9C;
    loc_1F80:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_21F8;
        goto loc_1F8C;
    loc_1F8C:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2210;
        goto loc_1F94;
    loc_1F94:
        if (x7 == 0) goto loc_1FC8;
        goto loc_1F98;
    loc_1F98:
        if (x6 != 0) goto loc_2228;
        goto loc_1FA4;
    loc_1FA4:
        goto loc_1D04;
    loc_1FB0:
        goto loc_1C58;
    loc_1FC0:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_2210;
        goto loc_1FC8;
    loc_1FC8:
        if (x6 != 0) goto loc_228C;
        goto loc_1FCC;
    loc_1FCC:
        goto loc_1D0C;
    loc_1FE0:
        if ((uint64_t)x8 != (uint64_t)x0) goto loc_1A9C;
        goto loc_1FEC;
    loc_1FEC:
        if (x0 == 0) goto loc_1DF4;
        goto loc_1FF4;
    loc_1FF4:
        goto loc_1B40;
    loc_2000:
        if (((uint64_t)x16 & (uint64_t)v1177) == 0) goto loc_20B4;
        goto loc_2008;
    loc_2008:
        if (((uint32_t)v1028 & (uint32_t)v835) != 0) goto loc_2360;
        goto loc_201C;
    loc_201C:
        if ((uint64_t)x1 == (uint64_t)v2380) goto loc_22F8;
        goto loc_2024;
    loc_2024:
        if ((uint64_t)x1 != (uint64_t)v2004) goto loc_1B68;
        goto loc_2030;
    loc_2030:
        if (x15 != 0) goto loc_1C9C;
        goto loc_2048;
    loc_2048:
        goto loc_1C94;
    loc_204C:
        if (x1 == 0) goto loc_1E84;
        goto loc_2054;
    loc_2054:
        goto loc_1D04;
    loc_2074:
        if (x6 == 0) goto loc_2160;
        goto loc_2078;
    loc_2078:
    loc_2088:
    loc_2090:
        if (v3520 == 0) goto loc_1998;
        goto loc_2098;
    loc_2098:
        goto loc_1998;
    loc_20A0:
        goto loc_18F4;
    loc_20A8:
        if (x6 != 0) goto loc_2398;
        goto loc_20AC;
    loc_20AC:
        goto loc_1ABC;
    loc_20B4:
        goto loc_1BAC;
    loc_20BC:
        goto loc_1C48;
    loc_20CC:
        goto loc_1EAC;
    loc_20F8:
        if ((uint64_t)x2 == (uint64_t)x8) goto loc_22A0;
        goto loc_2104;
    loc_2104:
        if ((uint64_t)x1 == (uint64_t)x8) goto loc_2344;
        goto loc_210C;
    loc_210C:
        if (x7 != 0) goto loc_22B8;
        goto loc_2110;
    loc_2110:
        goto loc_1D04;
    loc_2120:
        if (x1 == 0) goto loc_1E88;
        goto loc_2128;
    loc_2128:
        goto loc_1D04;
    loc_2144:
        if ((uint64_t)x7 == (uint64_t)x0) goto loc_2314;
        goto loc_2150;
    loc_2150:
        goto loc_1A9C;
    loc_2160:
        goto loc_1ABC;
    loc_2174:
        goto loc_1C48;
    loc_21A0:
        if (((uint64_t)x16 & (uint64_t)v2467) == 0) goto loc_20B4;
        goto loc_21A8;
    loc_21A8:
        if (((uint32_t)v1234 & (uint32_t)v3502) != 0) goto loc_2360;
        goto loc_21BC;
    loc_21BC:
        if ((uint64_t)x1 != (uint64_t)v1093) goto loc_2024;
        goto loc_21C4;
    loc_21C4:
        if (x6 == 0) goto loc_22FC;
        goto loc_21C8;
    loc_21C8:
        goto loc_1BAC;
    loc_21D4:
        if (x0 == 0) goto loc_233C;
        goto loc_21DC;
    loc_21DC:
        goto loc_1B40;
    loc_21F8:
        if (x7 == 0) goto loc_1FC0;
        goto loc_21FC;
    loc_21FC:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_1F98;
        goto loc_2210;
    loc_2210:
        if (x6 == 0) goto loc_2334;
        goto loc_2214;
    loc_2214:
        if (x7 == 0) goto loc_228C;
        goto loc_2220;
    loc_2220:
    loc_2228:
        if (v1505 == 0) goto loc_224C;
        goto loc_2234;
    loc_2234:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_224C;
        goto loc_223C;
    loc_223C:
    loc_224C:
        goto loc_1D04;
    loc_2260:
        if (x6 == 0) goto loc_2160;
        goto loc_2268;
    loc_2268:
        goto loc_196C;
    loc_227C:
        if (v1442 != 0) goto loc_2090;
        goto loc_2288;
    loc_2288:
        goto loc_1998;
    loc_228C:
        goto loc_1D04;
    loc_22A0:
        if (x7 == 0) goto loc_236C;
        goto loc_22A4;
    loc_22A4:
        if ((uint64_t)x1 == (uint64_t)x2) goto loc_238C;
        goto loc_22B8;
    loc_22B8:
        if (x1 == 0) goto loc_2350;
        goto loc_22C0;
    loc_22C0:
        if (v303 == 0) goto loc_22E8;
        goto loc_22D0;
    loc_22D0:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_22E8;
        goto loc_22D8;
    loc_22D8:
    loc_22E8:
        goto loc_1D04;
    loc_22F8:
        if (x6 != 0) goto loc_21C8;
        goto loc_22FC;
    loc_22FC:
        goto loc_199C;
    loc_2314:
        if (x0 == 0) goto loc_1DF4;
        goto loc_231C;
    loc_231C:
        goto loc_1B40;
    loc_2334:
        if (x7 == 0) goto loc_1FCC;
        goto loc_2338;
    loc_2338:
        goto loc_1F98;
    loc_233C:
        goto loc_1DF4;
    loc_2344:
        if (x1 != 0) goto loc_237C;
        goto loc_234C;
    loc_234C:
        if (x7 == 0) goto loc_1E88;
        goto loc_2350;
    loc_2350:
        goto loc_1D04;
    loc_2360:
        goto loc_1BAC;
    loc_236C:
        if ((uint64_t)x1 != (uint64_t)x2) goto loc_2110;
        goto loc_2374;
    loc_2374:
        if (x1 == 0) goto loc_1E88;
        goto loc_237C;
    loc_237C:
        if (x7 != 0) goto loc_22C0;
        goto loc_2388;
    loc_2388:
        goto loc_2110;
    loc_238C:
        if (x1 != 0) goto loc_237C;
        goto loc_2394;
    loc_2394:
        goto loc_2350;
    loc_2398:
        goto loc_2088;
    loc_23A4:
        goto loc_19B8;
}
void multf3(void)
{
    uint64 load_854;
    uint64 load_2608;
    uint64 load_163;
    uint64 load_1777;
    loc_23C0:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = var_3339;
        local_pFFFFFFFFFFFFFFF0 = var_3499;
        load_854 = var_30;
        load_2608 = var_30;
        load_163 = var_40;
        load_1777 = var_40;
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        __asm("semantic-v2 function unknown: arm64-simd-instruction-unsupported:fmov");
        if (bit_extract(load_2608, 48, 15) == 0) goto loc_2804;
        goto loc_23F4;
    loc_23F4:
        if ((uint32_t)bit_extract(load_2608, 48, 15) == 0x7FFF) goto loc_284C;
        goto loc_2400;
    loc_2400:
    loc_2424:
        if (bit_extract(load_1777, 48, 15) == 0) goto loc_27A8;
        goto loc_243C;
    loc_243C:
        if ((uint32_t)bit_extract(load_1777, 48, 15) == 0x7FFF) goto loc_2494;
        goto loc_2448;
    loc_2448:
        if ((int64_t)phi(0, 12, 4, 8) <= 10) goto loc_24CC;
        goto loc_2480;
    loc_2480:
        if ((uint64_t)phi((phi(0, 12, 4, 8)) | 1, phi(0, 12, 4, 8)) == 11) goto loc_2BB4;
        goto loc_2488;
    loc_2488:
        goto loc_258C;
    loc_2494:
        if (load_163 | (bit_extract(load_1777, 0, 48)) != 0) goto loc_2520;
        goto loc_24A4;
    loc_24A4:
        if ((int64_t)(phi(0, 12, 4, 8)) | 2 > 10) goto loc_2B20;
        goto loc_24C4;
    loc_24C4:
    loc_24CC:
        if ((int64_t)phi(phi(0, 12, 4, 8), (phi(0, 12, 4, 8)) | 2, (phi(0, 12, 4, 8)) | 1) > 2) goto loc_2548;
        goto loc_24D4;
    loc_24D4:
        if ((uint64_t)(phi(phi(0, 12, 4, 8), (phi(0, 12, 4, 8)) | 2, (phi(0, 12, 4, 8)) | 1)) - 1 > 1) goto loc_25EC;
        goto loc_24E0;
    loc_24E0:
        if ((uint64_t)phi(0, 2, 1) == 2) goto loc_25DC;
        goto loc_24E8;
    loc_24E8:
        if ((uint64_t)phi(phi(0, 2, 1), phi(phi(phi(0, 3, 1, 2), phi(2, 3), phi(phi(0, 2, 1), 3)), phi(1, 0))) != 1) goto loc_274C;
        goto loc_24F0;
    loc_24F0:
    loc_24FC:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        if (x0 != 0) goto loc_29B4;
        goto loc_2518;
    loc_2518:
        return;
    loc_2520:
        if ((int64_t)(phi(0, 12, 4, 8)) | 3 > 10) goto loc_2BA8;
        goto loc_2548;
    loc_2548:
        if (((uint64_t)1 << ((phi(phi(phi(0, 12, 4, 8), (phi(0, 12, 4, 8)) | 2, (phi(0, 12, 4, 8)) | 1), (phi(0, 12, 4, 8)) | 3)) & 63) & (uint64_t)0x530) != 0) goto loc_2584;
        goto loc_255C;
    loc_255C:
        if (((uint64_t)1 << ((phi(phi(phi(0, 12, 4, 8), (phi(0, 12, 4, 8)) | 2, (phi(0, 12, 4, 8)) | 1), (phi(0, 12, 4, 8)) | 3)) & 63) & (uint64_t)0x240) != 0) goto loc_25C4;
        goto loc_2568;
    loc_2568:
        if (((uint64_t)1 << ((phi(phi(phi(0, 12, 4, 8), (phi(0, 12, 4, 8)) | 2, (phi(0, 12, 4, 8)) | 1), (phi(0, 12, 4, 8)) | 3)) & 63) & (uint64_t)0x88) == 0) goto loc_25EC;
        goto loc_2574;
    loc_2574:
        goto loc_258C;
    loc_2584:
    loc_258C:
        if ((uint64_t)phi(phi(0, 3, 1, 2), phi(2, 3), phi(phi(0, 2, 1), 3)) == 2) goto loc_25DC;
        goto loc_2598;
    loc_2598:
    loc_25A8:
        if ((uint64_t)phi(phi(phi(0, 3, 1, 2), phi(2, 3), phi(phi(0, 2, 1), 3)), phi(1, 0)) != 3) goto loc_24E8;
        goto loc_25B0;
    loc_25B0:
        goto loc_24FC;
    loc_25C4:
        goto loc_24FC;
    loc_25DC:
        goto loc_24FC;
    loc_25EC:
        local_pFFFFFFFFFFFFFFD0 = local_x21;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        if (bit_extract(((condition_ne ? (((uint64_t)((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF))) + ((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32)) + 0x100000000 : ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32))) + 1 : ((uint64_t)((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF) > (uint64_t)((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF))) + ((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32) ? (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32)) + 0x100000000 : ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32)))) + ((condition_ne ? ((((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF))) + ((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32)) >> 32) + 1 : (((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) >> 32) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) + (((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) >> 32) * ((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF))) + ((((phi(phi((load_854 >> ((61 - (phi(v1869 + 49, v1992 - 15))) & 63)) | ((bit_extract(load_2608, 0, 48)) << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63)), load_854 << (((v1869 + 49) - 61) & 63)), v751 | 0x8000000000000, bit_extract(load_2608, 0, 48), 0)) & 0xFFFFFFFF) * ((phi(phi(phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0), bit_extract(load_1777, 0, 48)), phi(v2325 | 0x8000000000000, phi(load_163 << (((v1765 + 49) - 61) & 63), (load_163 >> ((61 - (phi(v1011 - 15, v1765 + 49))) & 63)) | ((bit_extract(load_1777, 0, 48)) << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63))), 0))) & 0xFFFFFFFF)) >> 32)) >> 32)), 39, 1) == 0) goto loc_28D4;
        goto loc_2734;
    loc_2734:
    loc_274C:
        if ((int64_t)(phi(phi(phi(((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1), phi(phi(phi((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000, phi((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1)), phi(phi(((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1), (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000), (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000), phi((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, ((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1))), phi(phi(phi((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)), ((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x7FFF, phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)), (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x7FFF), phi((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)), ((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x7FFF, phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))), phi(phi(phi(((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1), (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000), phi(((((bit_extract(load_1777, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001) + (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0))) + 1, (((phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) - (phi(v1765 + 64, phi(v1011, v1765 + 64)))) + 0xFFFFFFFFFFFFC011) + 1, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 0x8000, (phi(0xFFFFFFFFFFFFC011 - (phi(phi(v1869 + 64, v1992), v1869 + 64)), ((bit_extract(load_2608, 48, 15)) & 0xFFFF) + 0xFFFFFFFFFFFFC001, 0x7FFF, 0)) + 1)))) + 0x3FFF <= 0) goto loc_28E4;
        goto loc_275C;
    loc_275C:
        if (((uint64_t)phi(phi(phi(load_163 << 3, phi(0, load_163 << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63)), 0), phi(phi(phi(phi(load_854 << (((phi(v1869 + 49, v1992 - 15)) + 3) & 63), 0), load_854 << 3, load_854, load_854 | (bit_extract(load_2608, 0, 48))), phi(0, load_163), phi(phi(load_163 << 3, phi(0, load_163 << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63)), 0), load_163)), phi(0, phi(0, load_163 << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63)), load_163 << 3))), ((((uint64_t)(((((phi(phi(phi(load_163 << 3, phi(0, load_163 << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63)), 0), load_163), phi(load_163 << 3, phi(0, load_163 << (((phi(v1011 - 15, v1765 + 49)) + 3) & 63)), 0))) & 0xFFFFFFFF) * v1878) & v523) + v485) | v2038 != (uint64_t)v45 ? 1 : 0)) | v1130) | v1434, x7) & (uint64_t)v2555) == 0) goto loc_2780;
        goto loc_2764;
    loc_2764:
        if ((uint64_t)x3 == (uint64_t)v566) goto loc_2AFC;
        goto loc_2774;
    loc_2774:
        if ((uint64_t)x3 == (uint64_t)v1612) goto loc_2AC8;
        goto loc_277C;
    loc_277C:
        if (x3 == 0) goto loc_2AB0;
        goto loc_2780;
    loc_2780:
        if (v384 == 0) goto loc_278C;
        goto loc_2784;
    loc_2784:
    loc_278C:
        if ((int64_t)x1 > (int64_t)x3) goto loc_2968;
        goto loc_2798;
    loc_2798:
        goto loc_24FC;
    loc_27A8:
        if (x2 == 0) goto loc_28A4;
        goto loc_27B0;
    loc_27B0:
        if (x12 == 0) goto loc_29EC;
        goto loc_27B4;
    loc_27B4:
    loc_27BC:
    loc_27D8:
        if ((int64_t)x1 > (int64_t)v2479) goto loc_2480;
        goto loc_2800;
    loc_2800:
        goto loc_24CC;
    loc_2804:
        if (load_854 | (bit_extract(load_2608, 0, 48)) == 0) goto loc_288C;
        goto loc_280C;
    loc_280C:
        if (bit_extract(load_2608, 0, 48) == 0) goto loc_29C8;
        goto loc_2810;
    loc_2810:
    loc_2818:
    loc_2834:
        goto loc_2424;
    loc_284C:
        if (load_854 | (bit_extract(load_2608, 0, 48)) != 0) goto loc_286C;
        goto loc_2854;
    loc_2854:
        goto loc_2424;
    loc_286C:
        goto loc_2424;
    loc_288C:
        goto loc_2424;
    loc_28A4:
        if ((int64_t)x1 > (int64_t)v2218) goto loc_2480;
        goto loc_28D0;
    loc_28D0:
        goto loc_24CC;
    loc_28D4:
        goto loc_274C;
    loc_28E4:
        if ((int64_t)x1 > (int64_t)v2620) goto loc_2A14;
        goto loc_28F4;
    loc_28F4:
        if ((int64_t)x1 <= (int64_t)v1615) goto loc_2A48;
        goto loc_28FC;
    loc_28FC:
        if (((uint64_t)x8 & (uint64_t)v1371) == 0) goto loc_2A7C;
        goto loc_2930;
    loc_2930:
    loc_2934:
        if ((uint64_t)x6 == (uint64_t)v1544) goto loc_2AD8;
        goto loc_2944;
    loc_2944:
        if ((uint64_t)x6 == (uint64_t)v2235) goto loc_2B94;
        goto loc_294C;
    loc_294C:
        if (x6 == 0) goto loc_2B78;
        goto loc_2950;
    loc_2950:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2AE8;
        goto loc_2954;
    loc_2954:
        goto loc_299C;
    loc_2968:
        if ((uint64_t)x8 == (uint64_t)v868) goto loc_2B04;
        goto loc_2974;
    loc_2974:
        if ((uint64_t)x8 == (uint64_t)v629) goto loc_2A94;
        goto loc_297C;
    loc_297C:
        if (x8 == 0) goto loc_2994;
        goto loc_2988;
    loc_2988:
    loc_2994:
    loc_299C:
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
        __asm("fmov v0.d[1], x3");
    loc_29B4:
        memory_unknown = local_phi_3724;
        sfp_handle_exceptions(/* arguments unknown */);
        return;
    loc_29C8:
        if ((int64_t)v1869 + 49 <= 60) goto loc_2818;
        goto loc_29DC;
    loc_29DC:
        goto loc_2834;
    loc_29EC:
        if ((int64_t)x2 <= (int64_t)v510) goto loc_27BC;
        goto loc_2A00;
    loc_2A00:
        goto loc_27D8;
    loc_2A14:
        if (x8 == 0) goto loc_2A38;
        goto loc_2A1C;
    loc_2A1C:
        if ((uint64_t)x6 == (uint64_t)v1330) goto loc_2A38;
        goto loc_2A30;
    loc_2A30:
    loc_2A38:
        goto loc_299C;
    loc_2A48:
        if (((uint64_t)x8 & (uint64_t)v808) != 0) goto loc_2934;
        goto loc_2A78;
    loc_2A78:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2BA0;
        goto loc_2A7C;
    loc_2A7C:
        if (v160 == 0) goto loc_24FC;
        goto loc_2A8C;
    loc_2A8C:
        goto loc_299C;
    loc_2A94:
        goto loc_2994;
    loc_2AB0:
        if ((uint64_t)x3 == (uint64_t)v1193) goto loc_2780;
        goto loc_2ABC;
    loc_2ABC:
        goto loc_2780;
    loc_2AC8:
        if (x2 == 0) goto loc_2780;
        goto loc_2ACC;
    loc_2ACC:
        goto loc_2780;
    loc_2AD8:
        if (x2 != 0) goto loc_2AE4;
        goto loc_2ADC;
    loc_2ADC:
    loc_2AE4:
        if (v2170 == 0) goto loc_2954;
        goto loc_2AE8;
    loc_2AE8:
        goto loc_299C;
    loc_2AFC:
        if (x2 != 0) goto loc_2780;
        goto loc_2B00;
    loc_2B00:
        goto loc_2ACC;
    loc_2B04:
        goto loc_2994;
    loc_2B20:
    loc_2B24:
        if ((uint64_t)x1 != (uint64_t)v170) goto loc_2B4C;
        goto loc_2B2C;
    loc_2B2C:
        if (v917 == 0) goto loc_2B64;
        goto loc_2B30;
    loc_2B30:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2B64;
        goto loc_2B34;
    loc_2B34:
        goto loc_24FC;
    loc_2B4C:
        if ((uint64_t)x1 != (uint64_t)v1455) goto loc_2488;
        goto loc_2B54;
    loc_2B54:
        goto loc_258C;
    loc_2B64:
        goto loc_24FC;
    loc_2B78:
        if ((uint64_t)x1 == (uint64_t)v765) goto loc_2AE4;
        goto loc_2B84;
    loc_2B84:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2AE8;
        goto loc_2B90;
    loc_2B90:
        goto loc_2954;
    loc_2B94:
        if (x2 != 0) goto loc_2ADC;
        goto loc_2B98;
    loc_2B98:
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_2AE8;
        goto loc_2B9C;
    loc_2B9C:
        goto loc_2954;
    loc_2BA0:
        goto loc_2AE8;
    loc_2BA8:
        goto loc_2B24;
    loc_2BB4:
        goto loc_25A8;
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
