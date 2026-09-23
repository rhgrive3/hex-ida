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
    uint64 load_38;
    uint64 load_12;
    load_38 = var_0;
    load_12 = global_13FE8;
    unknown_call(load_12);
    unknown_call(load_12);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FD8;
    __asm("cbz x0, #0xb44");
    return sub_AA0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_10;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x14028 != 0x14028) {
        load_10 = global_13FC8;
        if (!(load_10 == 0)) {
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
    if (!(global_14028 != 0)) {
        if (!(global_13FD0 == 0)) {
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
void local_vars(void)
{
    return;
}
void local_array(void)
{
    uint32 load_26;
    uint64 load_34;
    uint64 load_77;
    uint64 load_44;
    loc_C28:
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    loc_C50:
        memory_unknown = local_phi_160;
        if ((uint64_t)(phi((sp + 0xFFFFFFFFFFFFFFC0) + 16, x2)) + 4 != (uint64_t)(sp + 0xFFFFFFFFFFFFFFC0) + 56) goto loc_C50;
        goto loc_C60;
    loc_C60:
        load_26 = var_24;
        load_34 = global_13FE0;
        load_77 = var_38;
        load_44 = memory_unknown;
        if ((uint64_t)load_77 != (uint64_t)load_44) goto loc_C88;
        goto loc_C80;
    loc_C80:
        return;
    loc_C88:
        unknown_call(load_26);
}
void local_struct(void)
{
    return;
}
void address_of_local(void)
{
    a1->field_0 = 42;
    return;
}
void address_of_array(void)
{
    return;
}
void large_stack_frame(void)
{
    uint8 load_130;
    uint64 load_104;
    uint64 load_3;
    uint64 load_74;
    loc_CB0:
        local_m820 = local_x29;
        local_m820 = local_x29;
        local_m8 = memory_unknown;
    loc_CD8:
        memory_unknown = (uint32_t)local_phi_208;
        if ((uint32_t)x0 + 1 != 0x800) goto loc_CD8;
        goto loc_CE8;
    loc_CE8:
        load_130 = var_418;
        load_104 = global_13FE0;
        load_3 = var_818;
        load_74 = memory_unknown;
        if ((uint64_t)load_3 != (uint64_t)load_74) goto loc_D14;
        goto loc_D08;
    loc_D08:
        return;
    loc_D14:
        unknown_call(load_130);
}
uint32 vla_stack(int64 a1)
{
    uint64 var_18, var_400;

    var_18 = *(uint64 *)(*(uint64 *)0x13FE0);
    /* cmp (int32)((uint32)((uint32)a1 - 1)), 0x3E7 — 次の分岐のための比較 */
    __asm("b.hi #0xdd4");
    __asm("sbfiz x1, x0, #2, #0x20");
    x1_1 = x1 + 15;
    x2 = x1_1 & 0xFFFFFFFFFFFFFFF0;
    x1 = sp - (x1_1 & 0xFFFFFFFFFFFF0000);
    /* cmp sp, x1 — 次の分岐のための比較 */
    __asm("b.eq #0xd6c");
    var_400 = 0;
    __asm("b #0xd58");
    var_0 = 0;
    /* cmp x2 & 0xFFFF, 0x400 — 次の分岐のための比較 */
    __asm("b.lo #0xd84");
    var_400 = 0;
    x3 = sp + 16;
    x1 = 0;
    *(uint32 *)(x3 + x1 * 4) = (uint32)((uint32)x1 * 2);
    x1 = x1 + 1;
    /* cmp (int32)(a1), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0xd8c");
    x0_1 = *(uint32 *)(x3 + (int32)((uint32)((uint32)((uint32)a1 + ((uint32)a1 >> 31)) >> 1)) * 4);
    loc_DAC:
    x1 = *(uint64 *)0x13FE0;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0xddc");
    return x0;
    x0_2 = 0xFFFFFFFF;
    __asm("b #0xdac");
    goto loc_DAC;
    x0_3 = sub_A90();
}
uint32 alloca_usage(int64 a1)
{
    uint64 var_18, var_400;

    var_18 = *(uint64 *)(*(uint64 *)0x13FE0);
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xe9c");
    __asm("sbfiz x1, x0, #2, #0x20");
    x1_1 = x1 + 15;
    x2 = x1_1 & 0xFFFFFFFFFFFFFFF0;
    x1 = sp - (x1_1 & 0xFFFFFFFFFFFF0000);
    /* cmp sp, x1 — 次の分岐のための比較 */
    __asm("b.eq #0xe30");
    var_400 = 0;
    __asm("b #0xe1c");
    var_0 = 0;
    /* cmp x2 & 0xFFFF, 0x400 — 次の分岐のための比較 */
    __asm("b.lo #0xe48");
    var_400 = 0;
    x2 = sp + 16;
    x3 = (uint32)((uint32)a1 * 3);
    x1 = 0;
    *(uint32 *)(x2) = (uint32)x1;
    x1 = (uint32)((uint32)x1 + 3);
    /* cmp (int32)(x1), (int32)(x3) — 次の分岐のための比較 */
    __asm("b.ne #0xe58");
    x0_1 = *(uint32 *)(x4 + (int32)((uint32)((uint32)((uint32)a1 + ((uint32)a1 >> 31)) >> 1)) * 4);
    loc_E74:
    x1 = *(uint64 *)0x13FE0;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0xea4");
    return x0;
    x0_2 = 0xFFFFFFFF;
    __asm("b #0xe74");
    goto loc_E74;
    x0_3 = sub_A90();
}
void stack_alias(void)
{
    return;
}
void test_stack_memory(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x1E38);
    unknown_call(1);
    local_array(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    large_stack_frame(/* arguments unknown */);
    unknown_call(1);
    vla_stack(/* arguments unknown */);
    unknown_call(1);
    alloca_usage(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    return;
}
uint32 heap_basic(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0xff8");
    /* cmp (int32)(x19), 0 — 次の分岐のための比較 */
    __asm("b.le #0xfd8");
    x1 = 0;
    x2 = (uint32)((uint32)x1 * 2);
    *(uint32 *)(x0 + x1 * 4) = x2;
    x1 = x1 + 1;
    /* cmp (int32)(x19), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0xfc4");
    x19 = *(uint32 *)(x0 + (int32)((uint32)((uint32)((uint32)x19 + ((uint32)x19 >> 31)) >> 1)) * 4);
    x0 = sub_AE0();
    loc_FE8:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0xfe8");
    goto loc_FE8;
}
uint32 heap_calloc(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x20 = (uint32)a1;
    x0 = sub_A70((int32)(uint32)a1, 4);
    __asm("cbz x0, #0x1060");
    /* cmp (int32)(x20), 0 — 次の分岐のための比較 */
    __asm("b.le #0x1058");
    x1 = 0;
    x19 = 0;
    x2 = *(uint32 *)(x0 + x1 * 4);
    x19 = (uint32)((uint32)x19 + x2);
    x1 = x1 + 1;
    /* cmp (int32)(x20), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x1030");
    loc_1044:
    x0 = sub_AE0();
    loc_1048:
    return (uint32)x19;
    x19 = 0;
    __asm("b #0x1044");
    goto loc_1044;
    x19 = 0xFFFFFFFF;
    __asm("b #0x1048");
    goto loc_1048;
}
uint64 heap_realloc(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_A40(20);
    __asm("cbz x0, #0x1120");
    *(uint32 *)(x0) = 1;
    *(uint32 *)(x0 + 4) = 2;
    *(uint32 *)(x0 + 8) = 3;
    *(uint32 *)(x0 + 0xC) = 4;
    *(uint32 *)(x0 + 0x10) = 5;
    x0 = sub_A80(x0, 40);
    __asm("cbz x0, #0x1108");
    *(uint32 *)(x0 + 0x14) = 50;
    *(uint32 *)(x0 + 0x18) = 60;
    *(uint32 *)(x0 + 0x1C) = 70;
    *(uint32 *)(x0 + 0x20) = 80;
    *(uint32 *)(x0 + 0x24) = 90;
    x1 = *(uint32 *)(x0 + 8);
    x19 = 0xFFFFFFFD;
    /* cmp (int32)(x1), 3 — 次の分岐のための比較 */
    __asm("b.eq #0x1118");
    loc_10F4:
    x0 = sub_AE0();
    loc_10F8:
    return (uint32)x19;
    x0 = sub_AE0(x19);
    x19 = 0xFFFFFFFE;
    __asm("b #0x10f8");
    goto loc_10F8;
    x19 = *(uint32 *)(x0 + 0x14);
    __asm("b #0x10f4");
    goto loc_10F4;
    x19 = 0xFFFFFFFF;
    __asm("b #0x10f8");
    goto loc_10F8;
}
uint32 heap_array(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0x1188");
    /* cmp (int32)(x19), 0 — 次の分岐のための比較 */
    __asm("b.le #0x1168");
    x3 = (uint32)(x19 * 3);
    x1 = 0;
    *(uint32 *)(x2) = (uint32)x1;
    x1 = (uint32)((uint32)x1 + 3);
    /* cmp (int32)(x1), (int32)(x3) — 次の分岐のための比較 */
    __asm("b.ne #0x1158");
    x19 = *(uint32 *)(x0 + (int32)((uint32)((uint32)((uint32)x19 + ((uint32)x19 >> 31)) >> 1)) * 4);
    x0 = sub_AE0();
    loc_1178:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x1178");
    goto loc_1178;
}
uint32 heap_struct(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    x0_1 = sub_A40(8);
    __asm("cbz x0, #0x11c4");
    x19 = (uint32)(x19 * 3);
    x0_2 = sub_AE0(x0_1);
    loc_11B4:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x11b4");
    goto loc_11B4;
}
uint32 heap_nested(void * a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_A40(16);
    *(uint64 *)(a1) = x0_1;
    __asm("cbz x0, #0x1234");
    *(uint32 *)(x0_1) = 10;
    x0_2 = sub_A40(16);
    *(uint64 *)(x0_1 + 8) = x0_2;
    __asm("cbz x0, #0x1224");
    *(uint32 *)(x0_2) = 20;
    *(uint64 *)(x0_2 + 8) = 0;
    loc_1218:
    return x0;
    x0_3 = sub_AE0(x19);
    __asm("b #0x1218");
    goto loc_1218;
    __asm("b #0x1218");
    goto loc_1218;
}
void linked_list_heap(void)
{
    uint64 load_189;
    uint64 load_148;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(phi(16, call_381));
    unknown_call(phi(16, call_381));
    if (call_244 == 0) {
        if (phi(0, phi(call_244, call_333)) == 0) {
        } else {
            load_148 = memory_unknown;
            unknown_call(phi(call_333, call_396));
            while (load_148 != 0) {
            }
        }
    } else {
        memory_unknown = local_phi_422;
        memory_unknown = 0;
        if (phi(0, phi(call_244, call_333)) == 0) {
        } else {
            memory_unknown = call_367;
        }
        if ((uint32_t)x20 + 10 == 50) {
            if (phi(call_244, call_333) == 0) {
            } else {
                while (memory_unknown != 0) {
                }
                load_189 = memory_unknown;
                unknown_call(phi(memory_unknown, call_429));
                while (load_189 != 0) {
                }
            }
        } else {
            goto loc_128C;
        }
    }
    return;
}
void create_tree_node(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(24);
    if (!(call_89 == 0)) {
        memory_unknown = (uint32_t)a1;
        memory_unknown = 0;
        memory_unknown = 0;
    }
    return;
}
uint64 tree_heap_traversal(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = create_tree_node(10);
    __asm("cbz x0, #0x13d8");
    x0_1 = create_tree_node(20);
    *(uint64 *)(x0 + 8) = x0_1;
    x0_2 = create_tree_node(30);
    *(uint64 *)(x0 + 0x10) = x0_2;
    x0 = *(uint64 *)(x0 + 8);
    /* cmp x0_2, 0 — 次の分岐のための比較 */
    /* ccmp x0, 0, 4, ne — 次の分岐のための比較 */
    __asm("b.eq #0x13b4");
    x20 = (uint32)((uint32)((uint32)*(uint32 *)(x0) + (uint32)*(uint32 *)(x0)) + (uint32)*(uint32 *)(x0_2));
    x0_3 = sub_AE0(x0, (uint32)*(uint32 *)(x0_2), (uint32)*(uint32 *)(x0));
    x0_4 = sub_AE0(*(uint64 *)(x0 + 16));
    x0 = sub_AE0(x0);
    loc_13A4:
    return (uint32)x20;
    __asm("cbz x0, #0x13bc");
    x0 = sub_AE0();
    x0 = *(uint64 *)(x19 + 16);
    __asm("cbz x0, #0x13c8");
    x0 = sub_AE0(x0);
    x0 = sub_AE0(x19);
    x20 = 0xFFFFFFFE;
    __asm("b #0x13a4");
    goto loc_13A4;
    x20 = 0xFFFFFFFF;
    __asm("b #0x13a4");
    goto loc_13A4;
}
uint32 memory_leak(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0x1430");
    /* cmp (int32)(x19), 0 — 次の分岐のための比較 */
    __asm("b.le #0x1418");
    x1 = 0;
    *(uint32 *)(x0 + x1 * 4) = (uint32)x1;
    x1 = x1 + 1;
    /* cmp (int32)(x19), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x1408");
    loc_1424:
    return x0;
    __asm("b #0x1424");
    goto loc_1424;
}
uint32 dangling_pointer(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_A40(4);
    __asm("cbz x0, #0x1480");
    x0_2 = sub_A50(1, 0x1F90, 42);
    x0_3 = sub_AE0(x0_1);
    loc_1478:
    return x0;
    __asm("b #0x1478");
    goto loc_1478;
}
uint32 double_free(void * a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    __asm("cbz x0, #0x1494");
    return (uint32)*(uint32 *)(a1);
    x0_1 = sub_A40(4);
    __asm("cbz x0, #0x14cc");
    x0_2 = sub_AE0(x0_1);
    x0_3 = sub_AE0(x0_1);
    loc_14C0:
    return x0;
    __asm("b #0x14c0");
    goto loc_14C0;
}
uint32 heap_overflow(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_A40(40);
    __asm("cbz x0, #0x151c");
    x1 = 0;
    *(uint32 *)(x2) = (uint32)x1;
    x1 = (uint32)((uint32)x1 + 100);
    /* cmp (int32)(x1), 0x44C — 次の分岐のための比較 */
    __asm("b.ne #0x14f4");
    x19 = *(uint32 *)(x0);
    x0 = sub_AE0();
    loc_150C:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x150c");
    goto loc_150C;
}
void test_heap_memory(void)
{
    uint64 load_441;
    loc_1524:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x1FA8);
        heap_basic(/* arguments unknown */);
        unknown_call(1);
        heap_calloc(/* arguments unknown */);
        unknown_call(1);
        heap_realloc(/* arguments unknown */);
        unknown_call(1);
        heap_array(/* arguments unknown */);
        unknown_call(1);
        heap_struct(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFFF0 = 0;
        heap_nested(/* arguments unknown */);
        unknown_call(1);
        load_441 = var_FFFFFFFFFFFFFFF0;
        if (load_441 == 0) goto loc_160C;
        goto loc_15FC;
    loc_15FC:
        unknown_call(memory_unknown);
        unknown_call(var_FFFFFFFFFFFFFFF0);
    loc_160C:
        linked_list_heap(/* arguments unknown */);
        unknown_call(1);
        tree_heap_traversal(/* arguments unknown */);
        unknown_call(1);
        memory_leak(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        unknown_call(1);
        if (call_1000 == 0) goto loc_16B8;
        goto loc_1670;
    loc_1670:
        if ((int32_t)call_1000 <= 0) goto loc_16F0;
        goto loc_1678;
    loc_1678:
        unknown_call(call_1000);
        if (((uint32_t)memory_unknown & (uint32_t)0x7F) == 0) goto loc_16D8;
        goto loc_1690;
    loc_1690:
        if ((int32_t)__arm64_sbfx((memory_unknown & 0x7F) + 1, 1, 7) <= 0) goto loc_16FC;
        goto loc_16A4;
    loc_16A4:
        unknown_call(1);
        goto loc_16FC;
    loc_16B8:
        dangling_pointer(/* arguments unknown */);
        unknown_call(1);
        unknown_call(0);
    loc_16D8:
        unknown_call(1);
        goto loc_16FC;
    loc_16F0:
        unknown_call(0x2198);
    loc_16FC:
        if ((uint64_t)memory_unknown != (uint64_t)memory_unknown) goto loc_1720;
        goto loc_1718;
    loc_1718:
        return;
    loc_1720:
        unknown_call(global_13FE0);
}
void global_var_access(void)
{
    global_14030++;
    return;
}
void global_var_read(void)
{
    return;
}
uint32 global_array_access(uint32 a1)
{
    /* cmp (int32)(a1), 9 — 次の分岐のための比較 */
    __asm("b.hi #0x1760");
    loc_175C:
    return x0;
    __asm("b #0x175c");
    goto loc_175C;
}
uint32 static_local(int64 a1)
{
    __asm("cbnz w0, #0x1784");
    x0 = (uint32)((uint32)*(uint32 *)0x14034 + 1);
    loc_1778:
    *(uint32 *)(0x14000 + 0x34) = (uint32)x0;
    return x0;
    x0 = 0;
    __asm("b #0x1778");
    goto loc_1778;
}
void call_static_func(void)
{
    return;
}
void access_extern_global(void)
{
    return;
}
void call_extern_func(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    extern_function(/* arguments unknown */);
    return;
}
void read_const_data(void)
{
    return;
}
void access_bss_var(void)
{
    return;
}
void access_bss_buffer(void)
{
    return;
}
void global_struct_access(void)
{
    return;
}
void set_file_static(void)
{
    global_14010 = a1;
    return;
}
void get_file_static(void)
{
    return;
}
void set_global_callback(void)
{
    global_14038 = a1;
    return;
}
void call_global_callback(void)
{
    uint64 load_14;
    load_14 = global_14038;
    if (load_14 == 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        unknown_call(a1);
        return;
    }
}
uint32 global_heap_store(void * a1)
{
    __asm("cbz x0, #0x1848");
    loc_1844:
    return x0;
    __asm("b #0x1844");
    goto loc_1844;
}
void static_complex_init(void)
{
    return;
}
void tls_access(void)
{
    return;
}
void init_order_test(void)
{
    global_14040 = 20;
    return;
}
void test_static_global(void)
{
    uint32 load_210;
    uint32 load_318;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call("-1ubuntu1~22.04) 11.4.0");
    global_var_access(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    global_14034 = 1;
    unknown_call(1);
    load_210 = global_14034;
    global_14034 = load_210 + 1;
    unknown_call(1);
    unknown_call(1);
    load_318 = memory_unknown;
    unknown_call(1);
    call_extern_func(/* arguments unknown */);
    unknown_call(1);
    read_const_data(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    global_struct_access(/* arguments unknown */);
    unknown_call(1);
    global_14010 = 50;
    unknown_call(1);
    global_14038 = 0xC14;
    call_global_callback(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    static_complex_init(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    init_order_test(/* arguments unknown */);
    unknown_call(1);
    return;
}
uint32 memop_memset(void * a1, int64 a2, int64 a3)
{
    // … ほかに 2 個の置き場（退避用など）があります

    /* cmp a1, 0 — 次の分岐のための比較 */
    /* ccmp a2, 0, 4, ne — 次の分岐のための比較 */
    __asm("b.eq #0x1aa0");
    x0_2 = sub_A60(a1, (uint32)a3, a2);
    loc_1A94:
    return x0;
    __asm("b #0x1a94");
    goto loc_1A94;
}
void memop_memcpy(void)
{
    if (condition_eq) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a1);
        return;
    }
}
void memop_memmove(void)
{
    if (condition_ls) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a1 + 1);
        return;
    }
}
void memop_memcmp(void)
{
    if (condition_ne) {
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x29;
        unknown_call(a1);
        return;
    } else {
        return;
    }
}
void memop_bzero(void)
{
    if (a1 == 0) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a1);
        return;
    }
}
void memop_bcopy(void)
{
    if (condition_eq) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a2);
        return;
    }
}
uint32 memop_unaligned_access(void * a1)
{
    __asm("cbz x0, #0x1bf4");
    loc_1BF0:
    return x0;
    __asm("b #0x1bf0");
    goto loc_1BF0;
}
uint32 memop_memory_barrier(void * a1)
{
    __asm("cbz x0, #0x1c14");
    loc_1C10:
    return x0;
    __asm("b #0x1c10");
    goto loc_1C10;
}
void test_memory_op_functions(void)
{
    uint64 load_194;
    uint64 load_289;
    uint64 load_499;
    uint64 load_456;
    loc_1C1C:
        local_pFFFFFFFFFFFFFE50 = local_x29;
        local_pFFFFFFFFFFFFFE50 = local_x29;
        local_pFFFFFFFFFFFFFE60 = local_x19;
        local_pFFFFFFFFFFFFFE60 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(0x2458);
        load_194 = global_2578;
        local_pFFFFFFFFFFFFFE98 = global_2578;
        local_pFFFFFFFFFFFFFE98 = global_2578;
        local_pFFFFFFFFFFFFFEA8 = global_2588;
        local_pFFFFFFFFFFFFFEB0 = 0;
        local_pFFFFFFFFFFFFFEB0 = 0;
        local_pFFFFFFFFFFFFFEC0 = 0;
        memop_memset(/* arguments unknown */);
        unknown_call(1);
        memop_memcpy(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFEE8 = global_2540;
        local_pFFFFFFFFFFFFFEEF = global_2547;
        memop_memmove(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFE78 = 1;
        local_pFFFFFFFFFFFFFE7C = 2;
        local_pFFFFFFFFFFFFFE80 = 3;
        local_pFFFFFFFFFFFFFE88 = 1;
        local_pFFFFFFFFFFFFFE8C = 2;
        local_pFFFFFFFFFFFFFE90 = 4;
        memop_memcmp(/* arguments unknown */);
        unknown_call(1);
        memop_bzero(/* arguments unknown */);
        unknown_call(1);
        local_pFFFFFFFFFFFFFEC8 = bit_insert(0x201, 0x403, 16, 16);
        local_pFFFFFFFFFFFFFED0 = 0;
        memop_bcopy(/* arguments unknown */);
        unknown_call(1);
        unknown_call(1);
        local_pFFFFFFFFFFFFFE74 = 5;
        memop_memory_barrier(/* arguments unknown */);
        unknown_call(1);
        load_289 = global_13FE0;
        load_499 = var_1A8;
        load_456 = memory_unknown;
        if ((uint64_t)load_499 != (uint64_t)load_456) goto loc_1DEC;
        goto loc_1DE0;
    loc_1DE0:
        return;
    loc_1DEC:
        unknown_call(load_289);
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    test_stack_memory(/* arguments unknown */);
    test_heap_memory(/* arguments unknown */);
    test_static_global(/* arguments unknown */);
    test_memory_op_functions(/* arguments unknown */);
    return;
}
void extern_function(void)
{
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
