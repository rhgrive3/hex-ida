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
    test_standard_library_functions(/* arguments unknown */);
    test_system_calls(/* arguments unknown */);
    test_thread_concurrency(/* arguments unknown */);
    return;
}
void init_have_lse_atomics(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(16);
    global_150C4 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_24;
    uint64 load_11;
    load_24 = var_0;
    load_11 = global_14FF0;
    unknown_call(load_11);
    unknown_call(load_11);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x14FE0;
    __asm("cbz x0, #0x1884");
    return sub_1580(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x15010 != 0x15010) {
        if (!(global_14FD0 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_18;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_18 = global_14FF8;
        if (!(load_18 == 0)) {
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
    if (!(global_15010 != 0)) {
        if (!(global_14FD8 == 0)) {
            unknown_call(global_15008);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void signal_handler(void)
{
    global_15018 = 1;
    global_1501C = a1;
    return;
}
void thread_sum(void)
{
    uint32 load_3;
    load_3 = a1->field_4;
    a1->field_8 = 0;
    while ((int32_t)load_3 >= (int32_t)phi(a1->field_0, x1 + 1)) {
        a1->field_8 += (uint32_t)local_phi_99;
        continue;
    }
    return;
}
void thread_compute(void)
{
    uint32 load_31;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    load_31 = a1->field_0;
    unknown_call(4);
    memory_unknown = load_31 * load_31;
    return;
}
void thread_increment(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    while ((int32_t)phi(call_259, 0) < (int32_t)phi(call_194, a1->field_0)) {
        unknown_call(phi(call_247, 0x15020));
        memory_unknown = memory_unknown + 1;
        unknown_call(phi(call_247, 0x15020));
        unknown_call(0x3E8);
        continue;
    }
    return;
}
void consumer_thread(void)
{
    uint32 load_26;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(0x15058);
    while (memory_unknown == 0) {
        unknown_call(phi(call_186, call_200));
        continue;
    }
    load_26 = memory_unknown;
    unknown_call(phi(call_161, call_158));
    unknown_call(4);
    memory_unknown = load_26;
    return;
}
void producer_thread(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(1);
    unknown_call(0x15058);
    global_150BC = 42;
    global_150B8 = 1;
    unknown_call(0x15088);
    unknown_call(0x15058);
    return;
}
void thread_atomic_increment(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    while ((int32_t)phi(call_256, 0) < (int32_t)phi(call_220, a1->field_0)) {
        aarch64_ldadd4_acq_rel(/* arguments unknown */);
        aarch64_cas4_acq_rel(/* arguments unknown */);
        continue;
    }
    return;
}
void thread_atomic_load_store(void)
{
    global_150C0 += 0x64;
    return;
}
void thread_tls_test(void)
{
    uint32 load_11;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    load_11 = memory_unknown;
    memory_unknown = load_11 + 50;
    unknown_call((x3 + 0) + 20);
    unknown_call(8);
    memory_unknown = load_11;
    memory_unknown = load_11;
    return;
}
void param_strcpy(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(a1);
    unknown_call(a1);
    return;
}
void call_strcpy(void)
{
    uint64 load_55;
    uint64 load_0;
    uint64 load_83;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    param_strcpy(/* arguments unknown */);
    load_55 = global_14FE8;
    load_0 = var_38;
    load_83 = memory_unknown;
    if ((uint64_t)load_0 != (uint64_t)load_83) {
        unknown_call((sp + 0xFFFFFFFFFFFFFFC0) + 24);
    }
    return;
}
void param_strcmp(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1);
    return;
}
void call_strcmp(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    param_strcmp(/* arguments unknown */);
    param_strcmp(/* arguments unknown */);
    param_strcmp(/* arguments unknown */);
    return;
}
void param_strlen(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(/* target unknown */);
    return;
}
void call_strlen(void)
{
    return;
}
void param_memcpy(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(a1);
    return;
}
void call_memcpy(void)
{
    uint32 load_18;
    uint32 load_73;
    uint32 load_203;
    uint64 load_174;
    uint64 load_150;
    uint64 load_4;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    local_pFFFFFFFFFFFFFFE0 = 0;
    local_pFFFFFFFFFFFFFFE0 = 0;
    local_pFFFFFFFFFFFFFFC8 = global_3564;
    local_pFFFFFFFFFFFFFFC8 = global_3564;
    local_pFFFFFFFFFFFFFFD8 = global_3574;
    local_pFFFFFFFFFFFFFFF0 = 0;
    param_memcpy(/* arguments unknown */);
    load_73 = var_30;
    load_203 = var_30;
    load_18 = var_40;
    load_174 = global_14FE8;
    load_150 = var_48;
    load_4 = memory_unknown;
    if ((uint64_t)load_150 != (uint64_t)load_4) {
        unknown_call((load_203 + load_73) + load_18);
    }
    return;
}
void param_memcmp(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1);
    return;
}
void call_memcmp(void)
{
    uint64 load_222;
    uint64 load_87;
    uint64 load_45;
    uint64 load_151;
    uint64 load_214;
    local_pFFFFFFFFFFFFFF90 = local_x29;
    local_pFFFFFFFFFFFFFF90 = local_x29;
    local_pFFFFFFFFFFFFFFA0 = local_x19;
    local_pFFFFFFFFFFFFFFA0 = local_x19;
    local_pFFFFFFFFFFFFFFB0 = local_x21;
    load_222 = global_3578;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    load_87 = global_3584;
    local_pFFFFFFFFFFFFFFE0 = global_358C;
    local_pFFFFFFFFFFFFFFC8 = load_222;
    local_pFFFFFFFFFFFFFFD0 = global_3580;
    local_pFFFFFFFFFFFFFFD8 = load_87;
    local_pFFFFFFFFFFFFFFE8 = load_222;
    local_pFFFFFFFFFFFFFFF0 = global_3580;
    param_memcmp(/* arguments unknown */);
    param_memcmp(/* arguments unknown */);
    load_45 = global_14FE8;
    load_151 = var_68;
    load_214 = memory_unknown;
    if ((uint64_t)load_151 != (uint64_t)load_214) {
        unknown_call(call_250 + call_385);
    }
    return;
}
void param_printf(void)
{
}
void call_printf(void)
{
}
uint32 param_scanf(void)
{
    uint64 var_10, var_18;

    var_18 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_16F0();
    /* cmp (int32)(x0_1), 2 — 次の分岐のための比較 */
    __asm("b.ne #0x1ee4");
    x0 = var_10;   x1 = var_14;
    x0_2 = (uint32)((uint32)var_10 + (uint32)var_14);
    loc_1EC4:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x1eec");
    x0_3 = sub_1560();
    x0_4 = 0xFFFFFFFF;
    __asm("b #0x1ec4");
    goto loc_1EC4;
    return x0;
}
void call_scanf(void)
{
}
uint32 param_fopen_fclose(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_14C0();
    __asm("cbz x0, #0x1f40");
    x19 = (uint32)sub_1480(x0_1);
    x0_3 = sub_14B0(x0_1);
    loc_1F30:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x1f30");
    goto loc_1F30;
}
void call_fopen_fclose(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fopen_fclose(/* arguments unknown */);
    return;
}
uint32 param_fread_fwrite(uint64 a1)
{
    uint64 var_68;

    var_68 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_14C0(a1, "w+", 0);
    __asm("cbz x0, #0x2060");
    x0_2 = sub_1670("BinBench Test Data", 1, 18, x0_1);
    /* cmp x0_2, 0x12 — 次の分岐のための比較 */
    __asm("b.eq #0x2004");
    x0_3 = sub_14B0(x0_1);
    x0_4 = 0xFFFFFFFE;
    loc_1FE4:
    x1 = *(uint64 *)0x14FE8;
    x3_1 = var_68 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x2070");
    x0_5 = sub_1560();
    x0_6 = sub_1550();
    x2 = x21;
    x3 = x19;
    x0_7 = sp - 40;
    x0_8 = sub_1610(x0_7, 1, x21, x19);
    *(uint8 *)(x0_7 + x0_8) = 0;
    x0_9 = sub_14B0(x19);
    x0_10 = sub_1790(a1);
    /* cmp x0_8, 0x12 — 次の分岐のための比較 */
    __asm("b.ne #0x2068");
    x1 = x20;
    x0_11 = sub_15F0(x0_7, x20);
    /* cmp (int32)(x0_11), 0 — 次の分岐のための比較 */
    x0_12 = (uint32)((uint32)x0_11 != 0 ? 0xFFFFFFFD : 42);
    __asm("b #0x1fe4");
    goto loc_1FE4;
    x0_13 = 0xFFFFFFFF;
    __asm("b #0x1fe4");
    goto loc_1FE4;
    x0_14 = 0xFFFFFFFD;
    __asm("b #0x1fe4");
    goto loc_1FE4;
    return x0;
}
void call_fread_fwrite(void)
{
}
uint32 param_malloc_free(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_14D0(a1 * 4);
    __asm("cbz x0, #0x20f4");
    x1 = 0;
    x2 = 10;
    /* cmp x1, a1 — 次の分岐のための比較 */
    __asm("b.ne #0x20e4");
    x19 = (uint32)((uint32)*(uint32 *)(x0 + x19 + -4) + (uint32)*(uint32 *)(x0));
    x0 = sub_1630();
    loc_20D4:
    return (uint32)x19;
    x3 = (uint32)((uint32)x1 * (uint32)x2);
    *(uint32 *)(x0 + x1 * 4) = x3;
    x1 = x1 + 1;
    __asm("b #0x20b8");
    x19 = 0xFFFFFFFF;
    __asm("b #0x20d4");
    goto loc_20D4;
}
void call_malloc_free(void)
{
}
void param_memset(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(a1);
    while ((uint64_t)phi(x1 + 1, 0) != (uint64_t)a2) {
        continue;
    }
    return;
}
void call_memset(void)
{
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    (var_165 + 0xFFFFFFFFFFFFFFC0 + 16)[local_phi_196] = 0xFF;
    while ((uint64_t)x1 + 1 != 10) {
    }
    param_memset(/* arguments unknown */);
    if ((uint64_t)var_38 != (uint64_t)memory_unknown) {
        unknown_call(var_FFFFFFFFFFFFFFD0 + var_FFFFFFFFFFFFFFF4);
    }
    return;
}
void param_strchr_strstr(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(a1);
    unknown_call(a1);
    return;
}
void call_strchr_strstr(void)
{
}
void test_standard_library_functions(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试标准库函数调用 ===");
    call_strcpy(/* arguments unknown */);
    unknown_call(1);
    call_strcmp(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    call_memcpy(/* arguments unknown */);
    unknown_call(1);
    call_memcmp(/* arguments unknown */);
    unknown_call(1);
    call_printf(/* arguments unknown */);
    unknown_call(1);
    call_scanf(/* arguments unknown */);
    unknown_call(1);
    call_fopen_fclose(/* arguments unknown */);
    unknown_call(1);
    call_fread_fwrite(/* arguments unknown */);
    unknown_call(1);
    call_malloc_free(/* arguments unknown */);
    unknown_call(1);
    call_memset(/* arguments unknown */);
    unknown_call(1);
    call_strchr_strstr(/* arguments unknown */);
}
uint64 param_linux_syscall(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_1760(56, 0xFFFFFF9C, a1, 0);
    __asm("tbz w0, #0x1f, #0x23a8");
    x19 = (uint32)-(uint32)*(uint32 *)(sub_1710(x0));
    loc_2398:
    return (uint32)x19;
    x1 = x0;
    x19 = (uint32)x0;
    x0 = sub_1760(57, x0);
    __asm("b #0x2398");
    goto loc_2398;
}
void call_linux_syscall(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_linux_syscall(/* arguments unknown */);
    return;
}
uint32 param_win32_api(void)
{
    uint64 var_48, var_98;

    var_98 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_1590();
    __asm("tbnz w0, #0x1f, #0x2440");
    /* cmp var_48, 0 — 次の分岐のための比較 */
    x0_2 = (uint32)(var_48 > 0 ? 42 : 0xFFFFFFFE);
    loc_2420:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_98 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x2448");
    x0_3 = sub_1560();
    x0_4 = 0xFFFFFFFF;
    __asm("b #0x2420");
    goto loc_2420;
    return x0;
}
void call_win32_api(void)
{
}
uint32 param_fork_exec(uint64 a1, uint64 a2)
{
    uint32 var_24;
    uint64 var_28;

    var_28 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_1470(*(uint64 *)0x14FE8, 0);
    /* cmp (int32)(x0_1), 0 — 次の分岐のための比較 */
    __asm("b.lt #0x24fc");
    __asm("b.ne #0x24b0");
    x0_2 = sub_1410(a1, a1, a2, 0);
    x0_3 = sub_13D0(127);
    x0_4 = sub_1780();
    __asm("tbnz w0, #0x1f, #0x24f4");
    /* tst (uint32)var_24, 0x7F — 次の分岐のための比較 */
    x0_5 = (uint32)(Z_tst64((uint32)var_24, 127) ? (uint32)((uint32)var_24 >> 8 & 255) : 0xFFFFFFFD);
    loc_24D4:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_28 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x2504");
    x0_6 = sub_1560();
    x0_7 = 0xFFFFFFFE;
    __asm("b #0x24d4");
    goto loc_24D4;
    x0_8 = 0xFFFFFFFF;
    __asm("b #0x24d4");
    goto loc_24D4;
    return x0;
}
void call_fork_exec(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fork_exec(/* arguments unknown */);
    return;
}
uint32 param_pipe_communication(void)
{
    uint32 var_20, var_24;
    uint64 var_48;

    var_48 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_1460(sp - 48, 0);
    __asm("tbnz w0, #0x1f, #0x2608");
    x0_2 = sub_1470(x0_1);
    /* cmp (int32)(x0_2), 0 — 次の分岐のための比較 */
    __asm("b.lt #0x2610");
    __asm("b.ne #0x25a4");
    x0_3 = sub_1570((uint32)var_20);
    x0_4 = sub_15A0((uint32)var_24, "HelloPipe", 9);
    x0_5 = sub_1570((uint32)var_24);
    x0_6 = sub_13D0(0);
    x0_7 = sub_1570((uint32)var_24);
    x1_1 = sp - 40;
    x0_8 = sub_16C0((uint32)var_20, x1_1, 31);
    *(uint8 *)(x1_1 + x0_8) = 0;
    x0_9 = sub_1570((uint32)var_20);
    x0_10 = sub_1690(0);
    /* cmp x0_8, 0 — 次の分岐のための比較 */
    x0_11 = (uint32)(x0_8 > 0 ? 42 : 0xFFFFFFFD);
    loc_25E8:
    x1_2 = *(uint64 *)0x14FE8;
    x3 = var_48 - *(uint64 *)(x1_2);
    x2 = 0;
    __asm("b.eq #0x2618");
    x0_12 = sub_1560();
    x0_13 = 0xFFFFFFFF;
    __asm("b #0x25e8");
    goto loc_25E8;
    x0_14 = 0xFFFFFFFE;
    __asm("b #0x25e8");
    goto loc_25E8;
    return x0;
}
void call_pipe_communication(void)
{
}
uint32 param_socket_create(void)
{
    uint32 var_24;
    uint64 var_28, var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_16A0(2, 1, 0);
    __asm("tbnz w0, #0x1f, #0x2708");
    var_24 = 1;
    x0_2 = sub_14E0(x0_1, 1, 2, sp - 28, 4);
    __asm("tbz w0, #0x1f, #0x26a8");
    x0_3 = (uint32)x0_1;
    x0_4 = sub_1570(x0_3);
    x0_5 = 0xFFFFFFFE;
    loc_2688:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x2710");
    x0_6 = sub_1560();
    var_28 = 0;   var_30 = 0;
    var_28 = 2;
    x0_7 = sub_1440((uint32)x19, sp - 24, 16);
    __asm("tbz w0, #0x1f, #0x26d8");
    x0_8 = sub_1570((uint32)x19);
    x0_9 = 0xFFFFFFFD;
    __asm("b #0x2688");
    goto loc_2688;
    x0_10 = sub_1420((uint32)x19, 5);
    __asm("tbz w0, #0x1f, #0x26f8");
    x0_11 = sub_1570((uint32)x19);
    x0_12 = 0xFFFFFFFC;
    __asm("b #0x2688");
    goto loc_2688;
    x0_13 = sub_1570((uint32)x19);
    x0_14 = 42;
    __asm("b #0x2688");
    goto loc_2688;
    x0_15 = 0xFFFFFFFF;
    __asm("b #0x2688");
    goto loc_2688;
    return x0;
}
void call_socket_create(void)
{
}
void param_shmget_shmat(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(0x3393);
    if (bit_extract(call_320, 31, 1) == 0) {
        unknown_call(call_320);
        unknown_call(0x3393);
        if (__arm64_condition_unknown(/* NZCV */)) {
        } else {
            unknown_call(call_299);
            if (__arm64_condition_unknown(/* NZCV */)) {
            } else {
                unknown_call(call_416);
                if ((uint64_t)((uint64_t)call_238 + (uint64_t)1) == 0) {
                } else {
                    unknown_call(call_238);
                    unknown_call(call_238);
                    unknown_call(call_238);
                    unknown_call(call_416);
                }
            }
        }
    } else {
        goto loc_274C;
    }
    return;
}
void call_shmget_shmat(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_shmget_shmat(/* arguments unknown */);
    return;
}
uint32 param_signal_handling(void)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x1_1 = 0x1954;
    x0_1 = sub_1490(10, x1_1);
    /* cmn x0_1, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x28d4");
    x0_2 = sub_1490(14, x1_1);
    /* cmn x0_2, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x28f8");
    x19 = 0x15000;
    x20 = 1001;
    *(uint32 *)(x19 + 0x18) = 0;
    x0_3 = sub_13F0(10);
    __asm("cbnz w0, #0x2868");
    x20 = (uint32)((uint32)x20 - 1);
    __asm("b.ne #0x28e0");
    x1_2 = *(uint32 *)(x19 + 0x18);
    x0_4 = x19 + 24;
    __asm("cbz w1, #0x2900");
    /* cmp (int32)((uint32)*(uint32 *)(x19 + 28)), 0xA — 次の分岐のための比較 */
    __asm("b.ne #0x2908");
    x20 = 2001;
    *(uint32 *)(x19 + 0x18) = 0;
    x0_5 = sub_1730(1, x1_2);
    __asm("cbnz w0, #0x28a0");
    x20 = (uint32)((uint32)x20 - 1);
    __asm("b.ne #0x28ec");
    x0_6 = x19 + 24;
    __asm("cbz w1, #0x2910");
    x19 = *(uint32 *)(x0_6 + 4);
    /* cmp (int32)(x19), 0xE — 次の分岐のための比較 */
    __asm("b.ne #0x2910");
    x0_7 = sub_1490(10, 0);
    x0_8 = sub_1490(x19, 0);
    loc_28D4:
    return x0;
    x0_9 = sub_16E0(1000);
    __asm("b #0x2858");
    x0_10 = sub_16E0(1000);
    __asm("b #0x2890");
    __asm("b #0x28d4");
    goto loc_28D4;
    __asm("b #0x28d4");
    goto loc_28D4;
    __asm("b #0x28d4");
    goto loc_28D4;
    __asm("b #0x28d4");
    goto loc_28D4;
}
void call_signal_handling(void)
{
}
void test_system_calls(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试系统调用 ===");
    call_linux_syscall(/* arguments unknown */);
    unknown_call(1);
    call_win32_api(/* arguments unknown */);
    unknown_call(1);
    call_fork_exec(/* arguments unknown */);
    unknown_call(1);
    param_pipe_communication(/* arguments unknown */);
    unknown_call(1);
    param_socket_create(/* arguments unknown */);
    unknown_call(1);
    call_shmget_shmat(/* arguments unknown */);
    unknown_call(1);
    param_signal_handling(/* arguments unknown */);
}
uint32 param_pthread_create(int64 a1)
{
    uint32 var_24;
    uint64 var_28, var_30, var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    var_24 = (uint32)a1;
    x0_1 = sub_1680(sp - 24, 0, 0x1998, sp - 28);
    __asm("cbnz w0, #0x2a54");
    x0_2 = sub_1720(var_28, sp - 16);
    x19 = *(uint32 *)(var_30);
    x0_3 = sub_1630(var_30);
    loc_2A34:
    x0_4 = *(uint64 *)0x14FE8;
    x2 = var_38 - *(uint64 *)(x0_4);
    x1 = 0;
    __asm("b.eq #0x2a5c");
    x0_5 = sub_1560(x0_4, x1, x2);
    x19 = 0xFFFFFFFF;
    __asm("b #0x2a34");
    goto loc_2A34;
    return (uint32)x19;
}
void call_pthread_create(void)
{
}
uint32 param_pthread_join(void)
{
    uint64 var_30, var_40, var_98;

    x22 = 3;
    var_30 = x23;   var_38 = x24;
    x23 = sp - 48;
    var_40 = x25;
    x24 = 0x196C;
    x25 = sp - 72;
    var_98 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = "\\n" + 44;
    v0 = *(vector128 *)(x0_1);   v1 = *(vector128 *)(x0_1 + 0x10);
    *(uint32 *)(x23 + 0x20) = (uint32)*(uint32 *)("\\n" + 76);
    *(vector128 *)(x23) = *(uint128 *)(x0_1);   *(vector128 *)(x23 + 0x10) = *(uint128 *)("\\n" + 60);
    x3 = x23;
    x2 = x24;
    x0 = x21;
    x20 = (uint32)sub_1680(x21, 0, x24, x23);
    __asm("cbnz w0, #0x2b50");
    x21 = x21 + 8;
    x23 = x23 + 12;
    x22 = (uint32)((uint32)x22 - 1);
    __asm("b.ne #0x2ad8");
    x21 = 0;
    x0_4 = sub_1720(*(uint64 *)(x25 + x21 * 8), 0);
    __asm("cbnz w0, #0x2b58");
    x21 = x21 + 1;
    x19 = x19 + 12;
    x20 = (uint32)((uint32)x20 + (uint32)*(uint32 *)(x19 + 8));
    /* cmp x21, 3 — 次の分岐のための比較 */
    __asm("b.ne #0x2b08");
    loc_2B30:
    x0_5 = *(uint64 *)0x14FE8;
    x2 = var_98 - *(uint64 *)(x0_5);
    x1 = 0;
    __asm("b.eq #0x2b60");
    x0_6 = sub_1560(x0_5, x1, x2);
    x20 = 0xFFFFFFFF;
    __asm("b #0x2b30");
    goto loc_2B30;
    x20 = 0xFFFFFFFE;
    __asm("b #0x2b30");
    goto loc_2B30;
    return (uint32)x20;
}
void call_pthread_join(void)
{
}
uint32 param_mutex_lock(int64 a1, int64 a2)
{
    uint32 var_4C;

    x19 = (uint32)a1;
    __asm("sbfiz x0, x0, #3, #0x20");
    var_4C = (uint32)a2;
    x0_1 = sub_14D0(x0, a2);
    __asm("cbz x0, #0x2c58");
    x21 = 0x15000;
    x24 = sp - 4;
    x23 = 0x19C4;
    x22 = 0;
    *(uint32 *)(0x15018 + 0x38) = 0;
    /* cmp (int32)(x19), (int32)(x22) — 次の分岐のための比較 */
    __asm("b.gt #0x2c08");
    x22 = 0;
    /* cmp (int32)(x19), (int32)(x22) — 次の分岐のための比較 */
    __asm("b.gt #0x2c44");
    x0_3 = sub_1630(x20);
    /* cmp (int32)((uint32)*(uint32 *)(x21 + 80)), (int32)((uint32)((uint32)x19 * (uint32)var_4C)) — 次の分岐のための比較 */
    __asm("b #0x2c30");
    x3 = x24;
    x2 = x23;
    x22 = x22 + 1;
    x0_4 = sub_1680(x20 + x22 * 8, 0, x23, x24);
    __asm("cbz w0, #0x2bc8");
    x0_5 = sub_1630(x20);
    loc_2C30:
    return x0;
    x22 = x22 + 1;
    x0_6 = sub_1720(*(uint64 *)(x20 + x22 * 8), 0);
    __asm("b #0x2bd4");
    __asm("b #0x2c30");
    goto loc_2C30;
}
void call_mutex_lock(void)
{
}
uint32 param_condition_variable(void)
{
    uint64 var_20, var_28, var_30, var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    *(uint32 *)(0x15018 + 0xA0) = 0;   *(uint32 *)(0x15018 + 0xA4) = 0;
    x0_1 = sub_1680(sp - 24, 0, 0x1A30, 0);
    __asm("cbnz w0, #0x2d20");
    x0_2 = sub_1680(sp - 32, 0, 0x1A98, 0);
    __asm("cbz w0, #0x2cf8");
    x19 = 0xFFFFFFFE;
    x0_3 = sub_1740(var_28);
    loc_2CD8:
    x0_4 = *(uint64 *)0x14FE8;
    x2 = var_38 - *(uint64 *)(x0_4);
    x1 = 0;
    __asm("b.eq #0x2d28");
    x0_5 = sub_1560(x0_4, x1, x2);
    x0_6 = sub_1720(var_28, sp - 16);
    x0_7 = sub_1720(var_20, 0);
    x19 = *(uint32 *)(var_30);
    x0_8 = sub_1630(var_30);
    __asm("b #0x2cd8");
    goto loc_2CD8;
    x19 = 0xFFFFFFFF;
    __asm("b #0x2cd8");
    goto loc_2CD8;
    return (uint32)x19;
}
void call_condition_variable(void)
{
}
uint32 param_atomic_ops(int64 a1, uint64 a2)
{
    uint32 var_4C;
    uint64 var_50, var_58;

    x21 = (uint32)a1;
    var_4C = (uint32)a2;
    var_58 = *(uint64 *)(*(uint64 *)0x14FE8);
    __asm("sbfiz x0, x21, #3, #0x20");
    x0_1 = sub_14D0(x0, 0);
    __asm("cbz x0, #0x2e5c");
    x20 = 0x15000;
    *(uint32 *)(0x15018 + 168) = 0;
    x24 = sp - 20;
    x23 = 0x1AF0;
    x22 = 0;
    /* cmp (int32)(x21), (int32)(x22) — 次の分岐のための比較 */
    __asm("b.gt #0x2e00");
    x0_2 = sub_1680(sp - 16, 0, 0x1B54, 0);
    __asm("cbnz w0, #0x2dcc");
    x0_3 = sub_1720(var_50, 0);
    x22 = 0;
    loc_2DD0:
    /* cmp (int32)(x21), (int32)(x22) — 次の分岐のための比較 */
    __asm("b.gt #0x2e48");
    x20 = *(uint32 *)(x20 + 192);
    x0_5 = sub_1630(x19);
    /* cmp (int32)(x20), 0 — 次の分岐のための比較 */
    x0_6 = (uint32)(x20 > 0 ? 42 : 0xFFFFFFFD);
    __asm("b #0x2e28");
    x3 = x24;
    x2 = x23;
    x22 = x22 + 1;
    x0_7 = sub_1680(x19 + x22 * 8, 0, x23, x24);
    __asm("cbz w0, #0x2d9c");
    x0_8 = sub_1630(x19);
    x0_9 = 0xFFFFFFFE;
    loc_2E28:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_58 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x2e64");
    x0_10 = sub_1560();
    x22 = x22 + 1;
    x0_11 = sub_1720(*(uint64 *)(x19 + x22 * 8), 0);
    __asm("b #0x2dd0");
    goto loc_2DD0;
    x0_12 = 0xFFFFFFFF;
    __asm("b #0x2e28");
    goto loc_2E28;
    return x0;
}
void call_atomic_ops(void)
{
}
uint32 param_thread_local_storage(int64 a1)
{
    int64 result;   // x22。この関数が 3 段にわたって作り変えている値
    uint64 var_40, var_58;

    x19 = (uint32)a1;
    __asm("sbfiz x20, x19, #3, #0x20");
    var_40 = x25;
    var_58 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_2 = sub_14D0(x20, 0);
    x0_3 = sub_14D0(x20);
    /* cmp x0_2, 0 — 次の分岐のための比較 */
    /* ccmp x0_3, 0, 4, ne — 次の分岐のための比較 */
    __asm("b.eq #0x3020");
    x23 = "Thread-%d";
    result = 0;
    /* cmp (int32)(x19), (int32)(result) — 次の分岐のための比較 */
    __asm("b.gt #0x2f58");
    x23 = 0x1B74;
    result = 0;
    x24 = (uint32)result;
    /* cmp (int32)(x19), (int32)(result) — 次の分岐のための比較 */
    __asm("b.gt #0x2f84");
    x25 = sp - 16;
    result = 0;
    x23 = 0;
    x24 = 0;
    loc_2F18:
    /* cmp (int32)(x19), (int32)(result) — 次の分岐のための比較 */
    __asm("b.gt #0x2fec");
    x0_5 = sub_1630(x20);
    x0_7 = sub_1630(x21);
    x19 = (uint32)((uint32)x19 * 150);
    /* cmp (int32)((uint32)((uint32)x19 * 100)), (int32)(x24) — 次の分岐のための比較 */
    /* ccmp (int32)(x19), (int32)(x23), 0, eq — 次の分岐のための比較 */
    x0_8 = (uint32)(flag_eq ? 42 : 0xFFFFFFFD);
    __asm("b #0x2fcc");
    x0_9 = sub_14D0(16);
    *(uint64 *)(x20 + result * 8) = x0_9;
    x4 = x23;
    result = result + 1;
    x0_10 = sub_14A0(x0_9, 16, 1, 16, x23, (uint32)result);
    __asm("b #0x2ee8");
    x2 = x23;
    result = result + 1;
    x0_11 = sub_1680(x21 + result * 8, 0, x23, *(uint64 *)(x20 + result * 8));
    __asm("cbz w0, #0x2efc");
    x19 = 0;
    x19 = x19 + 1;
    x0_12 = sub_1630(*(uint64 *)(x20 + x19 * 8));
    /* cmp (int32)(x24), (int32)(x19) — 次の分岐のための比較 */
    __asm("b.ge #0x2fa4");
    x0_14 = sub_1630(x20);
    x0_15 = sub_1630(x21);
    x0_16 = 0xFFFFFFFE;
    loc_2FCC:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_58 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.eq #0x3028");
    x0_17 = sub_1560();
    x1 = x25;
    x0_18 = sub_1720(*(uint64 *)(x21 + result * 8), x25);
    x24 = (uint32)((uint32)x24 + (uint32)*(uint32 *)(x0_19));
    x23 = (uint32)((uint32)x23 + (uint32)*(uint32 *)(x0_19 + 4));
    x0_20 = sub_1630(x0_19, (uint32)*(uint32 *)(x0_19 + 4));
    result = result + 1;
    x0_21 = sub_1630(*(uint64 *)(x20 + result * 8));
    __asm("b #0x2f18");
    goto loc_2F18;
    x0_22 = 0xFFFFFFFF;
    __asm("b #0x2fcc");
    goto loc_2FCC;
    return x0;
}
void call_thread_local_storage(void)
{
}
void test_thread_concurrency(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试线程与并发 ===");
    call_pthread_create(/* arguments unknown */);
    unknown_call(1);
    param_pthread_join(/* arguments unknown */);
    unknown_call(1);
    call_mutex_lock(/* arguments unknown */);
    unknown_call(1);
    param_condition_variable(/* arguments unknown */);
    unknown_call(1);
    call_atomic_ops(/* arguments unknown */);
    unknown_call(1);
    call_thread_local_storage(/* arguments unknown */);
}
uint32 aarch64_cas4_acq_rel(int64 a1, int64 a2, void * a3)
{
    __asm("cbz w16, #0x3108");
    *(uint32 *)(a3) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a3));
    /* cmp (int32)(x0), (int32)(x16) — 次の分岐のための比較 */
    __asm("b.ne #0x3120");
    x17 = __atomic_store((uint32 *)(a3), (int32)(a2));
    __asm("cbnz w17, #0x310c");
    return x0;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x3148");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x314c");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
