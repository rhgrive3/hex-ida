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
    test_stack_memory(/* arguments unknown */);
    test_heap_memory(/* arguments unknown */);
    test_static_global(/* arguments unknown */);
    test_memory_op_functions(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_18;
    uint64 load_28;
    load_18 = var_0;
    load_28 = global_12FE8;
    unknown_call(load_28);
    unknown_call(load_28);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x12FD8;
    __asm("cbz x0, #0xb84");
    return sub_AA0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_26;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x13028 != 0x13028) {
        load_26 = global_12FC8;
        if (!(load_26 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_12FF8 == 0)) {
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
    if (!(global_13028 != 0)) {
        if (!(global_12FD0 == 0)) {
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
    uint32 load_112;
    uint64 load_3;
    uint64 load_100;
    uint64 load_58;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    (var_160 + 0xFFFFFFFFFFFFFFC0 + 16)[local_phi_232] = local_phi_160;
    while ((uint64_t)x1 + 1 != 10) {
    }
    load_112 = var_24;
    load_3 = global_12FE0;
    load_100 = var_38;
    load_58 = memory_unknown;
    if ((uint64_t)load_100 != (uint64_t)load_58) {
        unknown_call(load_112);
    }
    return;
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
    uint8 load_3;
    uint64 load_109;
    uint64 load_60;
    uint64 load_16;
    local_m820 = local_x29;
    local_m820 = local_x29;
    local_m8 = memory_unknown;
    local_phi_158[var_200 - 0x820 + 24] = (uint32_t)local_phi_158;
    while ((uint64_t)x0 + 1 != 0x800) {
    }
    load_3 = var_418;
    load_109 = global_12FE0;
    load_60 = var_818;
    load_16 = memory_unknown;
    if ((uint64_t)load_60 != (uint64_t)load_16) {
        unknown_call(load_3);
    }
    return;
}
uint32 vla_stack(int64 a1)
{
    uint64 var_18, var_400;

    var_18 = *(uint64 *)(*(uint64 *)0x12FE0);
    /* cmp (int32)((uint32)((uint32)a1 - 1)), 0x3E7 — 次の分岐のための比較 */
    __asm("b.hi #0xe08");
    __asm("sbfiz x1, x0, #2, #0x20");
    x1_1 = x1 + 15;
    x2 = x1_1 & 0xFFFFFFFFFFFFFFF0;
    x1 = sp - (x1_1 & 0xFFFFFFFFFFFF0000);
    /* cmp sp, x1 — 次の分岐のための比較 */
    __asm("b.eq #0xdac");
    var_400 = 0;
    __asm("b #0xd98");
    var_0 = 0;
    /* cmp x2 & 0xFFFF, 0x400 — 次の分岐のための比較 */
    __asm("b.lo #0xdc4");
    var_400 = 0;
    x2 = sp + 16;
    x1 = 0;
    *(uint32 *)(x2 + x1 * 4) = (uint32)((uint32)x1 * 2);
    x1 = x1 + 1;
    /* cmp (int32)(a1), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0xdcc");
    x0_1 = *(uint32 *)(x2 + (int32)((uint32)((uint32)a1 >> 1)) * 4);
    loc_DE8:
    x1 = *(uint64 *)0x12FE0;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0xe10");
    x0_2 = sub_A90();
    x0_3 = 0xFFFFFFFF;
    __asm("b #0xde8");
    goto loc_DE8;
    return x0;
}
uint32 alloca_usage(int64 a1)
{
    uint64 var_18, var_400;

    var_18 = *(uint64 *)(*(uint64 *)0x12FE0);
    /* cmp (int32)(a1), 0 — 次の分岐のための比較 */
    __asm("b.le #0xec8");
    __asm("sbfiz x1, x0, #2, #0x20");
    x1_1 = x1 + 15;
    x2 = x1_1 & 0xFFFFFFFFFFFFFFF0;
    x1 = sp - (x1_1 & 0xFFFFFFFFFFFF0000);
    /* cmp sp, x1 — 次の分岐のための比較 */
    __asm("b.eq #0xe6c");
    var_400 = 0;
    __asm("b #0xe58");
    var_0 = 0;
    /* cmp x2 & 0xFFFF, 0x400 — 次の分岐のための比較 */
    __asm("b.lo #0xe84");
    var_400 = 0;
    x2 = sp + 16;
    x1 = 0;
    *(uint32 *)(x2 + x1 * 4) = (uint32)((uint32)x1 * 3);
    x1 = x1 + 1;
    /* cmp (int32)(a1), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0xe8c");
    x0_1 = *(uint32 *)(x2 + (int32)((uint32)((uint32)a1 >> 1)) * 4);
    loc_EA8:
    x1 = *(uint64 *)0x12FE0;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0xed0");
    x0_2 = sub_A90();
    x0_3 = 0xFFFFFFFF;
    __asm("b #0xea8");
    goto loc_EA8;
    return x0;
}
void stack_alias(void)
{
    return;
}
void test_stack_memory(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试栈内存操作 ===");
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
}
uint32 heap_basic(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0x1024");
    x1 = 0;
    /* cmp (int32)(x19), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x1014");
    x19 = *(uint32 *)(x0 + (int32)((uint32)((uint32)x19 / 2)) * 4);
    x0 = sub_AE0();
    loc_1004:
    return (uint32)x19;
    x2 = (uint32)((uint32)x1 * 2);
    *(uint32 *)(x0 + x1 * 4) = x2;
    x1 = x1 + 1;
    __asm("b #0xfec");
    x19 = 0xFFFFFFFF;
    __asm("b #0x1004");
    goto loc_1004;
}
uint32 heap_calloc(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x20 = (int32)(uint32)a1;
    x0 = sub_A70(x20, 4);
    __asm("cbz x0, #0x1080");
    x1 = 0;
    x19 = 0;
    /* cmp (int32)(x20), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x1070");
    x0 = sub_AE0();
    loc_1060:
    return (uint32)x19;
    x2 = *(uint32 *)(x0 + x1 * 4);
    x1 = x1 + 1;
    x19 = (uint32)((uint32)x19 + x2);
    __asm("b #0x1054");
    x19 = 0xFFFFFFFF;
    __asm("b #0x1060");
    goto loc_1060;
}
uint64 heap_realloc(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_A40(20);
    __asm("cbz x0, #0x1108");
    *(uint64 *)(x0_1) = 0x200000001;
    *(uint64 *)(x0_1 + 8) = 0x400000003;
    *(uint32 *)(x0_1 + 0x10) = 5;
    x0_2 = sub_A80(x0_1, 40);
    __asm("cbz x0, #0x10f8");
    /* cmp (int32)((uint32)*(uint32 *)(x0_2 + 8)), 3 — 次の分岐のための比較 */
    x19 = (uint32)((uint32)*(uint32 *)(x0_2 + 8) == 3 ? 50 : 0xFFFFFFFD);
    x0_3 = sub_AE0(x0_2, 0xFFFFFFFD);
    loc_10E8:
    return (uint32)x19;
    x19 = 0xFFFFFFFE;
    x0_4 = sub_AE0(x19);
    __asm("b #0x10e8");
    goto loc_10E8;
    x19 = 0xFFFFFFFF;
    __asm("b #0x10e8");
    goto loc_10E8;
}
uint32 heap_array(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0x1168");
    x1 = 0;
    /* cmp (int32)(x19), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x1158");
    x19 = *(uint32 *)(x0 + (int32)((uint32)((uint32)x19 / 2)) * 4);
    x0 = sub_AE0();
    loc_1148:
    return (uint32)x19;
    x2 = (uint32)((uint32)x1 * 3);
    *(uint32 *)(x0 + x1 * 4) = x2;
    x1 = x1 + 1;
    __asm("b #0x1130");
    x19 = 0xFFFFFFFF;
    __asm("b #0x1148");
    goto loc_1148;
}
uint32 heap_struct(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    x0_1 = sub_A40(8);
    __asm("cbz x0, #0x11a4");
    x19 = (uint32)(x19 * 3);
    x0_2 = sub_AE0(x0_1);
    loc_1194:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x1194");
    goto loc_1194;
}
uint32 heap_nested(void * a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_A40(16);
    *(uint64 *)(a1) = x0;
    __asm("cbz x0, #0x1214");
    *(uint32 *)(x0) = 10;
    x0 = sub_A40(16);
    *(uint64 *)(x0 + 8) = x0;
    __asm("cbnz x0, #0x1200");
    x0_1 = sub_AE0(x0);
    loc_11F4:
    return x0;
    *(uint32 *)(x0) = 20;
    *(uint64 *)(x0 + 8) = 0;
    __asm("b #0x11f4");
    goto loc_11F4;
    __asm("b #0x11f4");
    goto loc_11F4;
}
uint64 linked_list_heap(void)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0 = 0;
    x20 = 0;
    x19 = 0;
    x21 = x0;
    x0 = sub_A40(16);
    __asm("cbnz x0, #0x1278");
    __asm("cbnz x19, #0x1264");
    x20 = 0xFFFFFFFF;
    loc_1250:
    return (uint32)x20;
    x19 = *(uint64 *)(x19 + 8);
    x0 = sub_AE0(x19);
    x19 = *(uint64 *)(x19 + 8);
    __asm("b #0x1248");
    *(uint32 *)(x0) = (uint32)x20;
    *(uint64 *)(x0 + 8) = 0;
    __asm("cbz x19, #0x12c0");
    *(uint64 *)(x21 + 8) = x0;
    loc_1288:
    x20 = (uint32)((uint32)x20 + 10);
    /* cmp (int32)(x20), 0x32 — 次の分岐のための比較 */
    __asm("b.ne #0x1238");
    x0 = x19;
    x20 = 0;
    x1 = *(uint32 *)(x0);
    x0 = *(uint64 *)(x0 + 8);
    x20 = (uint32)((uint32)x20 + x1);
    __asm("cbnz x0, #0x129c");
    x19 = *(uint64 *)(x19 + 8);
    x0 = sub_AE0(x19);
    __asm("cbnz x19, #0x12ac");
    __asm("b #0x1250");
    goto loc_1250;
    x19 = x0;
    __asm("b #0x1288");
    goto loc_1288;
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
    __asm("cbz x0, #0x1394");
    x0_1 = create_tree_node(20);
    *(uint64 *)(x0 + 8) = x0_1;
    x0_2 = create_tree_node(30);
    x0 = *(uint64 *)(x0 + 8);
    *(uint64 *)(x0 + 0x10) = x0_2;
    __asm("cbz x0, #0x1340");
    __asm("cbnz x1, #0x1368");
    x0 = sub_AE0(x0, x0_2);
    x0 = *(uint64 *)(x0 + 16);
    __asm("cbz x0, #0x134c");
    x0 = sub_AE0(x0);
    x20 = 0xFFFFFFFE;
    x0 = sub_AE0(x0);
    loc_1358:
    return (uint32)x20;
    x20 = (uint32)((uint32)((uint32)*(uint32 *)(x19) + (uint32)*(uint32 *)(x0)) + (uint32)*(uint32 *)(x1));
    x0_3 = sub_AE0();
    x0_4 = sub_AE0(*(uint64 *)(x19 + 16));
    x0 = sub_AE0(x19);
    __asm("b #0x1358");
    goto loc_1358;
    x20 = 0xFFFFFFFF;
    __asm("b #0x1358");
    goto loc_1358;
}
uint32 memory_leak(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #2, #0x20");
    x0 = sub_A40(x0);
    __asm("cbz x0, #0x13e8");
    x1 = 0;
    /* cmp (int32)(x19), (int32)(x1) — 次の分岐のための比較 */
    __asm("b.gt #0x13dc");
    loc_13D0:
    return x0;
    *(uint32 *)(x0 + x1 * 4) = (uint32)x1;
    x1 = x1 + 1;
    __asm("b #0x13bc");
    __asm("b #0x13d0");
    goto loc_13D0;
}
uint32 dangling_pointer(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_A40(4);
    __asm("cbz x0, #0x1438");
    x0_2 = sub_A50(1, "value before free: %d\\n", 42);
    x0_3 = sub_AE0(x0_1);
    loc_142C:
    return x0;
    __asm("b #0x142c");
    goto loc_142C;
}
uint32 double_free(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    __asm("cbnz x0, #0x147c");
    x0 = sub_A40(4);
    __asm("cbz x0, #0x1484");
    x0_1 = sub_AE0(x0);
    x0_2 = sub_AE0(x0);
    loc_1470:
    return x0;
    return (uint32)*(uint32 *)(x0);
    __asm("b #0x1470");
    goto loc_1470;
}
uint32 heap_overflow(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_A40(40);
    __asm("cbz x0, #0x14d8");
    x1 = 0;
    x3 = 100;
    x2 = (uint32)((uint32)x1 * (uint32)x3);
    *(uint32 *)(x0 + x1 * 4) = x2;
    x1 = x1 + 1;
    /* cmp x1, 0xB — 次の分岐のための比較 */
    __asm("b.ne #0x14ac");
    x19 = *(uint32 *)(x0);
    x0 = sub_AE0();
    loc_14C8:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x14c8");
    goto loc_14C8;
}
void test_heap_memory(void)
{
    uint64 load_490;
    uint64 load_395;
    uint64 load_230;
    uint64 load_368;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试堆内存操作 ===");
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
    load_490 = var_FFFFFFFFFFFFFFF0;
    if (!(load_490 == 0)) {
        unknown_call(memory_unknown);
        unknown_call(var_FFFFFFFFFFFFFFF0);
    }
    linked_list_heap(/* arguments unknown */);
    unknown_call(1);
    tree_heap_traversal(/* arguments unknown */);
    unknown_call(1);
    memory_leak(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    if (!(call_848 != 0)) {
        dangling_pointer(/* arguments unknown */);
        unknown_call(1);
        unknown_call(0);
    }
    if (condition_le) {
        unknown_call("fork失败");
    } else {
        unknown_call(phi(call_747, call_848));
        if (((uint32_t)memory_unknown & (uint32_t)0x7F) != 0) {
            if ((int32_t)__arm64_sbfx((phi(memory_unknown & 0x7F, call_961)) + 1, 1, 7) > 0) {
                unknown_call(phi(memory_unknown, __arm64_sbfx((phi(memory_unknown & 0x7F, call_961)) + 1, 1, 7)));
            }
        } else {
            goto loc_1678;
        }
    }
    load_395 = global_12FE0;
    load_230 = memory_unknown;
    load_368 = memory_unknown;
    if ((uint64_t)load_230 != (uint64_t)load_368) {
        unknown_call(load_395);
        goto loc_16A0;
    }
    return;
}
void global_var_access(void)
{
    global_13030++;
    return;
}
void global_var_read(void)
{
    return;
}
uint32 global_array_access(uint32 a1)
{
    /* cmp (int32)(a1), 9 — 次の分岐のための比較 */
    __asm("b.hi #0x1710");
    loc_170C:
    return x0;
    __asm("b #0x170c");
    goto loc_170C;
}
uint32 static_local(int64 a1)
{
    x1 = 0x13000;
    __asm("cbnz w0, #0x1738");
    x0 = (uint32)((uint32)*(uint32 *)0x13034 + 1);
    loc_172C:
    *(uint32 *)(x1 + 48 + 4) = (uint32)x0;
    return x0;
    x0 = 0;
    __asm("b #0x172c");
    goto loc_172C;
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
    global_13010 = a1;
    return;
}
void get_file_static(void)
{
    return;
}
void set_global_callback(void)
{
    global_13038 = a1;
    return;
}
void call_global_callback(void)
{
    uint64 load_5;
    load_5 = global_13038;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (load_5 == 0) {
        return;
    } else {
        __asm("br x16");
    }
}
uint32 global_heap_store(void * a1)
{
    __asm("cbz x0, #0x17e0");
    loc_17DC:
    return x0;
    __asm("b #0x17dc");
    goto loc_17DC;
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
    return;
}
void test_static_global(void)
{
    uint32 load_1;
    uint32 load_205;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call("=== 测试静态与全局内存 ===");
    global_var_access(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    global_13034 = 1;
    unknown_call(1);
    load_205 = global_13034;
    global_13034 = load_205 + 1;
    unknown_call(1);
    unknown_call(1);
    load_1 = memory_unknown;
    unknown_call(1);
    call_extern_func(/* arguments unknown */);
    unknown_call(1);
    read_const_data(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    global_struct_access(/* arguments unknown */);
    unknown_call(1);
    global_13010 = 50;
    unknown_call(1);
    global_13038 = 0xC54;
    call_global_callback(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    static_complex_init(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
}
void memop_memset(void)
{
    if (condition_eq) {
        return;
    } else {
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x29;
        local_pFFFFFFFFFFFFFFF0 = local_x19;
        unknown_call(a1);
        return;
    }
}
uint32 memop_memcpy(int64 a1, int64 a2, int64 a3)
{
    // … ほかに 2 個の置き場（退避用など）があります

    /* cmp a1, 0 — 次の分岐のための比較 */
    /* ccmp a2, 0, 4, ne — 次の分岐のための比較 */
    __asm("b.eq #0x1a6c");
    x20 = a3;
    __asm("cbz x2, #0x1a74");
    x19_1 = a1;
    x0 = sub_9D0(a1, a2, a3);
    loc_1A60:
    return x0;
    return 0xFFFFFFFF;
    __asm("b #0x1a60");
    goto loc_1A60;
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
        if (!(a3 == 0)) {
            local_pFFFFFFFFFFFFFFF0 = local_x29;
            local_pFFFFFFFFFFFFFFF0 = local_x29;
            unknown_call(a1);
            return;
        }
    }
    return;
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
    if (condition_ne) {
        if (!(a3 == 0)) {
            local_pFFFFFFFFFFFFFFF0 = local_x29;
            local_pFFFFFFFFFFFFFFF0 = local_x29;
            unknown_call(a2);
            return;
        }
    }
    return;
}
uint32 memop_unaligned_access(void * a1)
{
    __asm("cbz x0, #0x1b78");
    loc_1B74:
    return x0;
    __asm("b #0x1b74");
    goto loc_1B74;
}
uint32 memop_memory_barrier(void * a1)
{
    __asm("cbz x0, #0x1b98");
    loc_1B94:
    return x0;
    __asm("b #0x1b94");
    goto loc_1B94;
}
void test_memory_op_functions(void)
{
    uint64 load_490;
    uint64 load_12;
    uint64 load_452;
    uint64 load_161;
    local_pFFFFFFFFFFFFFE50 = local_x29;
    local_pFFFFFFFFFFFFFE50 = local_x29;
    local_pFFFFFFFFFFFFFE60 = local_x19;
    local_pFFFFFFFFFFFFFE60 = local_x19;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    unknown_call("=== 测试内存操作函数 ===");
    local_pFFFFFFFFFFFFFEB0 = 0;
    local_pFFFFFFFFFFFFFEB0 = 0;
    local_pFFFFFFFFFFFFFEC0 = 0;
    load_490 = global_23FC;
    local_pFFFFFFFFFFFFFE98 = global_23FC;
    local_pFFFFFFFFFFFFFE98 = global_23FC;
    local_pFFFFFFFFFFFFFEA8 = global_240C;
    memop_memset(/* arguments unknown */);
    unknown_call(1);
    memop_memcpy(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFEE8 = global_23C7;
    local_pFFFFFFFFFFFFFEEF = global_23CE;
    memop_memmove(/* arguments unknown */);
    unknown_call(1);
    local_pFFFFFFFFFFFFFE78 = bit_insert(1, 2, 32, 16);
    local_pFFFFFFFFFFFFFE88 = bit_insert(1, 2, 32, 16);
    local_pFFFFFFFFFFFFFE80 = 3;
    local_pFFFFFFFFFFFFFE90 = 4;
    unknown_call((sp + 0xFFFFFFFFFFFFFE50) + 40);
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
    load_12 = global_12FE0;
    load_452 = var_1A8;
    load_161 = memory_unknown;
    if ((uint64_t)load_452 != (uint64_t)load_161) {
        unknown_call(load_12);
    }
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
