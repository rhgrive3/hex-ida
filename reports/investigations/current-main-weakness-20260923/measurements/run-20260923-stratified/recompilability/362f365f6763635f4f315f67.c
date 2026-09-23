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
void init_have_lse_atomics(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(16);
    global_150C8 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_26;
    uint64 load_5;
    load_26 = var_0;
    load_5 = global_14FF0;
    unknown_call(load_5);
    unknown_call(load_5);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x14FE0;
    __asm("cbz x0, #0x1844");
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
    uint64 load_31;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_31 = global_14FF8;
        if (!(load_31 == 0)) {
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
    uint32 load_7;
    a1->field_8 = 0;
    load_7 = a1->field_4;
    if ((int32_t)a1->field_0 <= (int32_t)load_7) {
        while ((uint32_t)(phi(x1, a1->field_0)) + 1 != (uint32_t)load_7 + 1) {
        }
        a1->field_8 = var_47;
    }
    return;
}
void thread_compute(void)
{
    uint32 load_39;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    load_39 = a1->field_0;
    unknown_call(4);
    memory_unknown = load_39 * load_39;
    return;
}
void thread_increment(void)
{
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    if ((int32_t)a1->field_0 > 0) {
        local_pFFFFFFFFFFFFFFD0 = local_x19;
        local_pFFFFFFFFFFFFFFD0 = local_x19;
        local_pFFFFFFFFFFFFFFF0 = local_x23;
        unknown_call(phi(0x15020, call_223));
        memory_unknown = memory_unknown + 1;
        unknown_call(phi(0x15020, call_223));
        unknown_call(phi(0x3E8, call_314));
        while ((uint32_t)phi(a1->field_0, call_213) != (uint32_t)(phi(0, x19)) + 1) {
        }
    }
    return;
}
void consumer_thread(void)
{
    uint32 load_177;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    unknown_call(0x15058);
    if (!(global_15088 != 0)) {
        local_pFFFFFFFFFFFFFFF0 = call_82;
        unknown_call(phi(0x15090, call_227));
        while (memory_unknown == 0) {
        }
    }
    load_177 = global_150C0;
    unknown_call(0x15058);
    unknown_call(4);
    memory_unknown = load_177;
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
    global_150C0 = 42;
    global_15088 = 1;
    unknown_call(0x15090);
    unknown_call(0x15058);
    return;
}
void thread_atomic_increment(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    if ((int32_t)a1->field_0 > 0) {
        local_pFFFFFFFFFFFFFFE0 = local_x19;
        local_pFFFFFFFFFFFFFFE0 = local_x19;
        aarch64_ldadd4_acq_rel(/* arguments unknown */);
        aarch64_cas4_acq_rel(/* arguments unknown */);
        while ((uint32_t)phi(call_305, a1->field_0) != (uint32_t)x19 + 1) {
        }
    }
    return;
}
void thread_atomic_load_store(void)
{
    global_150C4 += 0x64;
    return;
}
void thread_tls_test(void)
{
    uint32 load_107;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    load_107 = memory_unknown;
    memory_unknown = load_107 + 50;
    unknown_call((x3 + 0) + 24);
    unknown_call(8);
    memory_unknown = load_107;
    memory_unknown = load_107 + 50;
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
    uint64 load_77;
    uint64 load_62;
    uint64 load_22;
    loc_1BE8:
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        param_strcpy(/* arguments unknown */);
        load_77 = global_14FE8;
        load_62 = var_38;
        load_22 = memory_unknown;
        if ((uint64_t)load_62 != (uint64_t)load_22) goto loc_1C38;
        goto loc_1C30;
    loc_1C30:
        return;
    loc_1C38:
        unknown_call((sp + 0xFFFFFFFFFFFFFFC0) + 24);
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
    uint32 load_98;
    uint32 load_140;
    uint32 load_150;
    uint64 load_166;
    uint64 load_13;
    uint64 load_73;
    loc_1CFC:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFC8 = global_38A8;
        local_pFFFFFFFFFFFFFFC8 = global_38A8;
        local_pFFFFFFFFFFFFFFD8 = global_38B8;
        local_pFFFFFFFFFFFFFFE0 = 0;
        local_pFFFFFFFFFFFFFFE0 = 0;
        local_pFFFFFFFFFFFFFFF0 = 0;
        param_memcpy(/* arguments unknown */);
        load_140 = var_30;
        load_98 = var_30;
        load_150 = var_40;
        load_166 = global_14FE8;
        load_13 = var_48;
        load_73 = memory_unknown;
        if ((uint64_t)load_13 != (uint64_t)load_73) goto loc_1D80;
        goto loc_1D78;
    loc_1D78:
        return;
    loc_1D80:
        unknown_call((load_140 + load_98) + load_150);
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
    uint64 load_141;
    uint64 load_163;
    uint64 load_19;
    uint64 load_43;
    uint64 load_20;
    loc_1DA4:
        local_pFFFFFFFFFFFFFF90 = local_x29;
        local_pFFFFFFFFFFFFFF90 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x19;
        local_pFFFFFFFFFFFFFFA0 = local_x19;
        local_pFFFFFFFFFFFFFFB0 = local_x21;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        load_141 = global_38C0;
        local_pFFFFFFFFFFFFFFC8 = load_141;
        local_pFFFFFFFFFFFFFFD0 = global_38C8;
        load_163 = global_38D0;
        local_pFFFFFFFFFFFFFFD8 = load_163;
        local_pFFFFFFFFFFFFFFE0 = global_38D8;
        local_pFFFFFFFFFFFFFFE8 = load_141;
        local_pFFFFFFFFFFFFFFF0 = global_38C8;
        param_memcmp(/* arguments unknown */);
        param_memcmp(/* arguments unknown */);
        load_19 = global_14FE8;
        load_43 = var_68;
        load_20 = memory_unknown;
        if ((uint64_t)load_43 != (uint64_t)load_20) goto loc_1E54;
        goto loc_1E44;
    loc_1E44:
        return;
    loc_1E54:
        unknown_call(call_372 + call_333);
}
void param_printf(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(1);
    return;
}
void call_printf(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_printf(/* arguments unknown */);
    return;
}
uint32 param_scanf(void)
{
    uint32 var_10, var_14;
    uint64 var_18;

    var_18 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_16F0();
    /* cmp (int32)(x0_1), 2 — 次の分岐のための比較 */
    __asm("b.ne #0x1f08");
    x0_2 = (uint32)((uint32)var_10 + (uint32)var_14);
    loc_1EE4:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_18 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x1f10");
    return x0;
    x0_3 = 0xFFFFFFFF;
    __asm("b #0x1ee4");
    goto loc_1EE4;
    x0_4 = sub_1560();
}
void call_scanf(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_scanf(/* arguments unknown */);
    return;
}
uint32 param_fopen_fclose(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_14C0();
    __asm("cbz x0, #0x1f70");
    x20 = (uint32)sub_1480(x0_1);
    x0_3 = sub_14B0(x0_1);
    loc_1F60:
    return (uint32)x20;
    x20 = 0xFFFFFFFF;
    __asm("b #0x1f60");
    goto loc_1F60;
}
void call_fopen_fclose(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fopen_fclose(/* arguments unknown */);
    return;
}
uint32 param_fread_fwrite(int64 a1)
{
    uint64 var_10, var_58;

    var_58 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_14C0(a1, 0x3470, 0);
    __asm("cbz x0, #0x209c");
    var_10 = x19;   var_18 = x20;
    x0_2 = sub_1670(0x3478, 1, 18, x0_1);
    /* cmp x0_2, 0x12 — 次の分岐のための比較 */
    __asm("b.ne #0x2088");
    x0_3 = sub_1550(x0_1);
    x0_4 = sp - 40;
    x0_5 = sub_1610(x0_4, 1, 18, x0_1);
    *(uint8 *)(x0_4 + x0_5) = 0;
    x0_6 = sub_14B0(x0_1);
    x0_7 = sub_1790(a1);
    /* cmp x0_5, 0x12 — 次の分岐のための比較 */
    __asm("b.ne #0x20a4");
    x0_8 = sub_15F0(x0_4, 0x3478);
    /* cmp (int32)(x0_8), 0 — 次の分岐のための比較 */
    x0_9 = (uint32)((uint32)x0_8 != 0 ? 0xFFFFFFFD : 42);
    loc_2060:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_58 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x20b0");
    return x0;
    x0_10 = sub_14B0(x19);
    x0_11 = 0xFFFFFFFE;
    __asm("b #0x2060");
    goto loc_2060;
    x0_12 = 0xFFFFFFFF;
    __asm("b #0x2060");
    goto loc_2060;
    x0_13 = 0xFFFFFFFD;
    __asm("b #0x2060");
    goto loc_2060;
    x0_14 = sub_1560();
}
void call_fread_fwrite(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fread_fwrite(/* arguments unknown */);
    return;
}
uint32 param_malloc_free(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = a1 * 4;
    x0 = sub_14D0(x0_1);
    __asm("cbz x0, #0x2138");
    __asm("cbz x20, #0x2114");
    x3 = x0_1 + x0;
    x1 = 0;
    *(uint32 *)(x2) = (uint32)x1;
    x1 = (uint32)((uint32)x1 + 10);
    /* cmp x2, x3 — 次の分岐のための比較 */
    __asm("b.ne #0x2104");
    x19 = (uint32)((uint32)*(uint32 *)(x0 + x19 + -4) + (uint32)*(uint32 *)(x0));
    x0 = sub_1630();
    loc_2128:
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x2128");
    goto loc_2128;
}
void call_malloc_free(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_malloc_free(/* arguments unknown */);
    return;
}
uint32 param_memset(void * a1, int64 a2)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_1520(a1, 0, a2);
    __asm("cbz x20, #0x21a4");
    x2 = a1 + a2;
    x0 = 0;
    x1 = *(uint8 *)(x3);
    x0 = (uint32)((uint32)x0 + (uint32)*(uint8 *)(x3));
    /* cmp x3, x2 — 次の分岐のための比較 */
    __asm("b.ne #0x2188");
    loc_2198:
    return x0;
    __asm("b #0x2198");
    goto loc_2198;
}
void call_memset(void)
{
    uint32 load_71;
    uint32 load_109;
    uint64 load_55;
    uint64 load_111;
    uint64 load_81;
    loc_21AC:
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
    loc_21D4:
        memory_unknown = 0xFF;
        if ((uint64_t)(phi(x0, (sp + 0xFFFFFFFFFFFFFFC0) + 16)) + 4 != (uint64_t)(sp + 0xFFFFFFFFFFFFFFC0) + 56) goto loc_21D4;
        goto loc_21E0;
    loc_21E0:
        param_memset(/* arguments unknown */);
        load_71 = var_FFFFFFFFFFFFFFD0;
        load_109 = var_FFFFFFFFFFFFFFF4;
        load_55 = global_14FE8;
        load_111 = var_38;
        load_81 = memory_unknown;
        if ((uint64_t)load_111 != (uint64_t)load_81) goto loc_221C;
        goto loc_2214;
    loc_2214:
        return;
    loc_221C:
        unknown_call(load_71 + load_109);
}
void param_strchr_strstr(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x21;
    unknown_call(a1);
    unknown_call(a1);
    return;
}
void call_strchr_strstr(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_strchr_strstr(/* arguments unknown */);
    return;
}
void test_standard_library_functions(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x34C8);
    call_strcpy(/* arguments unknown */);
    unknown_call(1);
    call_strcmp(/* arguments unknown */);
    unknown_call(1);
    call_strlen(/* arguments unknown */);
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
    unknown_call(1);
    return;
}
uint32 param_linux_syscall(int64 a1)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0_1 = sub_1760(56, 0xFFFFFF9C, a1, 0);
    __asm("tbnz w0, #0x1f, #0x2420");
    x19 = (uint32)x0_1;
    x0_2 = sub_1760(57, (uint32)x0_1);
    loc_2410:
    return (uint32)x19;
    x19 = (uint32)-(uint32)*(uint32 *)(sub_1710());
    __asm("b #0x2410");
    goto loc_2410;
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
    __asm("tbnz w0, #0x1f, #0x24b8");
    /* cmp var_48, 0 — 次の分岐のための比較 */
    x0_2 = (uint32)(var_48 > 0 ? 42 : 0xFFFFFFFE);
    loc_2494:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_98 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x24c0");
    return x0;
    x0_3 = 0xFFFFFFFF;
    __asm("b #0x2494");
    goto loc_2494;
    x0_4 = sub_1560();
}
void call_win32_api(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_win32_api(/* arguments unknown */);
    return;
}
uint32 param_fork_exec(uint64 a1, int64 a2)
{
    uint32 var_24;
    uint64 var_28;

    var_28 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_1470(0, a2, *(uint64 *)0x14FE8);
    __asm("tbnz w0, #0x1f, #0x2584");
    __asm("cbz w0, #0x2568");
    x0_2 = sub_1780(x0_1, sp - 12, 0);
    x0_3 = 0xFFFFFFFE;
    __asm("tbnz w1, #0x1f, #0x2540");
    /* tst (uint32)var_24, 0x7F — 次の分岐のための比較 */
    x0_4 = (uint32)(Z_tst64((uint32)var_24, 127) ? (uint32)((uint32)var_24 >> 8 & 255) : 0xFFFFFFFD);
    loc_2540:
    x1_1 = *(uint64 *)0x14FE8;
    x3 = var_28 - *(uint64 *)(x1_1);
    x2 = 0;
    __asm("b.ne #0x258c");
    return x0;
    x2 = a2;
    x1 = a1;
    x0_5 = sub_1410(a1, a1, a2, 0);
    x0_6 = sub_13D0(127);
    x0_7 = 0xFFFFFFFF;
    __asm("b #0x2540");
    goto loc_2540;
    x0_8 = sub_1560();
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
    uint64 var_10, var_48;
    uint32 var_20, var_24;

    var_48 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_1460(sp - 48, 0);
    __asm("tbnz w0, #0x1f, #0x268c");
    x0_2 = sub_1470(x0_1);
    __asm("tbnz w0, #0x1f, #0x2694");
    var_10 = x19;   var_18 = x20;
    __asm("cbnz w0, #0x2620");
    x0_3 = sub_1570((uint32)var_20);
    x0_4 = sub_15A0((uint32)var_24, 0x3680, 9);
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
    loc_2668:
    x1_2 = *(uint64 *)0x14FE8;
    x3 = var_48 - *(uint64 *)(x1_2);
    x2 = 0;
    __asm("b.ne #0x269c");
    return x0;
    x0_12 = 0xFFFFFFFF;
    __asm("b #0x2668");
    goto loc_2668;
    x0_13 = 0xFFFFFFFE;
    __asm("b #0x2668");
    goto loc_2668;
    x0_14 = sub_1560();
}
void call_pipe_communication(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pipe_communication(/* arguments unknown */);
    return;
}
uint32 param_socket_create(void)
{
    uint64 var_10, var_28, var_38;
    uint32 var_24;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = sub_16A0(2, 1, 0);
    __asm("tbnz w0, #0x1f, #0x27ac");
    var_10 = x19;
    var_24 = 1;
    x0_2 = sub_14E0(x0_1, 1, 2, sp - 28, 4);
    __asm("tbnz w0, #0x1f, #0x2770");
    var_28 = 0;   var_30 = 0;
    var_28 = 2;
    x0_3 = (uint32)x0_1;
    x0_4 = sub_1440(x0_3, sp - 24, 16);
    __asm("tbnz w0, #0x1f, #0x2784");
    x0_5 = sub_1420(x0_3, 5);
    __asm("tbnz w0, #0x1f, #0x2798");
    x0_6 = sub_1570(x0_3);
    x0_7 = 42;
    loc_274C:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_38 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x27b4");
    return x0;
    x0_8 = sub_1570((uint32)x19);
    x0_9 = 0xFFFFFFFE;
    __asm("b #0x274c");
    goto loc_274C;
    x0_10 = sub_1570((uint32)x19);
    x0_11 = 0xFFFFFFFD;
    __asm("b #0x274c");
    goto loc_274C;
    x0_12 = sub_1570((uint32)x19);
    x0_13 = 0xFFFFFFFC;
    __asm("b #0x274c");
    goto loc_274C;
    x0_14 = 0xFFFFFFFF;
    __asm("b #0x274c");
    goto loc_274C;
    x0_15 = sub_1560();
}
void call_socket_create(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_socket_create(/* arguments unknown */);
    return;
}
uint32 param_shmget_shmat(void)
{
    uint64 var_10;

    x0_1 = sub_14F0(0x3690, 66, 438);
    __asm("tbnz w0, #0x1f, #0x288c");
    x0_2 = sub_1570(x0_1);
    x0_3 = sub_1620(0x3690, 42);
    __asm("tbnz w0, #0x1f, #0x2894");
    var_10 = x19;   var_18 = x20;
    x0_4 = sub_1640(x0_3, 0x1000, 950);
    __asm("tbnz w0, #0x1f, #0x289c");
    x0_5 = sub_1530(x0_4, 0, 0);
    /* cmn x0_5, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x28a8");
    x0_6 = ".0";
    x1 = *(uint64 *)(x0_6);
    *(uint64 *)(x0_5) = x1;
    *(uint64 *)(x0_5 + 5) = *(uint64 *)(x0_6 + 5);
    x21 = (uint32)sub_13E0(x0_5, x1);
    x0_8 = sub_1430(x0_5);
    x0_9 = (uint32)x0_4;
    x0_10 = sub_1600(x0_9, 0, 0);
    loc_287C:
    return (uint32)x21;
    x21 = 0xFFFFFFFF;
    __asm("b #0x287c");
    goto loc_287C;
    x21 = 0xFFFFFFFF;
    __asm("b #0x287c");
    goto loc_287C;
    x21 = 0xFFFFFFFE;
    __asm("b #0x287c");
    goto loc_287C;
    x21 = 0xFFFFFFFD;
    __asm("b #0x287c");
    goto loc_287C;
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
    uint64 var_10, var_20;

    x0_1 = sub_1490(10, 0x1914);
    /* cmn x0_1, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x29f8");
    x0_2 = sub_1490(14, 0x1914);
    /* cmn x0_2, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x2a00");
    var_10 = x19;   var_18 = x20;
    var_20 = x21;
    *(uint32 *)(0x15000 + 0x18) = 0;
    x0_3 = sub_13F0(10);
    __asm("cbnz w0, #0x2950");
    x19 = 1000;
    x21 = 1000;
    x20 = 0x15000;
    x0_4 = sub_16E0((uint32)x21);
    __asm("cbnz w0, #0x2950");
    x19 = (uint32)((uint32)x19 - 1);
    __asm("b.ne #0x2938");
    __asm("cbz w0, #0x2a08");
    /* cmp (int32)((uint32)*(uint32 *)0x1501C), 0xA — 次の分岐のための比較 */
    __asm("b.ne #0x2a18");
    *(uint32 *)(0x15000 + 0x18) = 0;
    x0_5 = sub_1730(1);
    __asm("cbnz w0, #0x29ac");
    x19 = 2000;
    x21 = 1000;
    x20 = 0x15000;
    x0_6 = sub_16E0((uint32)x21);
    __asm("cbnz w0, #0x29ac");
    x19 = (uint32)((uint32)x19 - 1);
    __asm("b.ne #0x2994");
    __asm("cbz w0, #0x2a28");
    /* cmp (int32)((uint32)*(uint32 *)0x1501C), 0xE — 次の分岐のための比較 */
    __asm("b.ne #0x2a38");
    x0_7 = sub_1490(10, 0);
    x0_8 = sub_1490(14, 0);
    loc_29F0:
    return x0;
    __asm("b #0x29f0");
    goto loc_29F0;
    __asm("b #0x29f0");
    goto loc_29F0;
    __asm("b #0x29f0");
    goto loc_29F0;
    __asm("b #0x29f0");
    goto loc_29F0;
    __asm("b #0x29f0");
    goto loc_29F0;
    __asm("b #0x29f0");
    goto loc_29F0;
}
void call_signal_handling(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_signal_handling(/* arguments unknown */);
    return;
}
void test_system_calls(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x36B8);
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
    unknown_call(1);
    return;
}
uint32 param_pthread_create(int64 a1)
{
    uint32 var_24;
    uint64 var_28, var_30, var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    var_24 = (uint32)a1;
    x0_1 = sub_1680(sp - 24, 0, 0x1964, sp - 28);
    __asm("cbnz w0, #0x2ba4");
    x0_2 = sub_1720(var_28, sp - 16);
    x19 = *(uint32 *)(var_30);
    x0_3 = sub_1630(var_30);
    loc_2B78:
    x0_4 = *(uint64 *)0x14FE8;
    x2 = var_38 - *(uint64 *)(x0_4);
    x1 = 0;
    __asm("b.ne #0x2bac");
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x2b78");
    goto loc_2B78;
    x0_5 = sub_1560();
}
void call_pthread_create(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pthread_create(/* arguments unknown */);
    return;
}
uint32 param_pthread_join(void)
{
    uint64 var_88;

    var_88 = *(uint64 *)(*(uint64 *)0x14FE8);
    x0_1 = 0x38A8 + 56;
    x20 = sp - 48;
    v0 = *(vector128 *)(x0_1);   v1 = *(vector128 *)(x0_1 + 0x10);
    *(vector128 *)(x20) = *(uint128 *)(x0_1);   *(vector128 *)(x20 + 0x10) = *(uint128 *)(0x38A8 + 72);
    *(uint32 *)(x20 + 0x20) = (uint32)*(uint32 *)(0x38A8 + 88);
    x21 = sp - 72;
    x22 = 3;
    x23 = 0x192C;
    x3 = x20;
    x2 = x23;
    x0 = x21;
    x19 = (uint32)sub_1680(x21, 0, x23, x20);
    __asm("cbnz w0, #0x2cb8");
    x21 = x21 + 8;
    x20 = x20 + 12;
    x22 = (uint32)((uint32)x22 - 1);
    __asm("b.ne #0x2c24");
    x20 = 0;
    x21 = sp - 48;
    x0_4 = sub_1720(*(uint64 *)(x24), 0);
    __asm("cbnz w0, #0x2cc0");
    x19 = (uint32)((uint32)x19 + (uint32)*(uint32 *)(x20 + x21 + 8));
    x24 = x24 + 8;
    x20 = x20 + 12;
    /* cmp x20, 0x24 — 次の分岐のための比較 */
    __asm("b.ne #0x2c58");
    loc_2C84:
    x0_5 = *(uint64 *)0x14FE8;
    x2 = var_88 - *(uint64 *)(x0_5);
    x1 = 0;
    __asm("b.ne #0x2cc8");
    return (uint32)x19;
    x19 = 0xFFFFFFFF;
    __asm("b #0x2c84");
    goto loc_2C84;
    x19 = 0xFFFFFFFE;
    __asm("b #0x2c84");
    goto loc_2C84;
    x0_6 = sub_1560();
}
void call_pthread_join(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pthread_join(/* arguments unknown */);
    return;
}
uint32 param_mutex_lock(int64 a1, int64 a2)
{
    uint64 var_10, var_20;
    uint32 var_5C;

    x25 = (uint32)a1;
    var_5C = (uint32)a2;
    __asm("sbfiz x0, x0, #3, #0x20");
    x0_1 = sub_14D0(x0, a2);
    __asm("cbz x0, #0x2dd4");
    *(uint32 *)(0x15018 + 0x38) = 0;
    /* cmp (int32)(x25), 0 — 次の分岐のための比較 */
    __asm("b.le #0x2d7c");
    var_10 = x19;   var_18 = x20;
    var_20 = x21;   var_28 = x22;
    x20 = x0_1 + x25 * 8;
    x23 = sp - 4;
    x22 = 0x1990;
    x3 = x23;
    x2 = x22;
    x0_3 = sub_1680(x19, 0, x22, x23);
    __asm("cbnz w0, #0x2db8");
    x19 = x19 + 8;
    /* cmp x19, x20 — 次の分岐のための比較 */
    __asm("b.ne #0x2d3c");
    x0_4 = sub_1720(*(uint64 *)(x21), 0);
    /* cmp x21, x20 — 次の分岐のための比較 */
    __asm("b.ne #0x2d60");
    x0_5 = sub_1630(x24);
    /* cmp (int32)((uint32)*(uint32 *)0x15050), (int32)((uint32)((uint32)x25 * (uint32)var_5C)) — 次の分岐のための比較 */
    loc_2DAC:
    return x0;
    x0_6 = sub_1630(x24);
    __asm("b #0x2dac");
    goto loc_2DAC;
    __asm("b #0x2dac");
    goto loc_2DAC;
}
void call_mutex_lock(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_mutex_lock(/* arguments unknown */);
    return;
}
uint64 param_condition_variable(void)
{
    uint64 var_20, var_28, var_30, var_38;

    var_38 = *(uint64 *)(*(uint64 *)0x14FE8);
    *(uint32 *)(0x15018 + 0x70) = 0;
    *(uint32 *)(0x15018 + 0xA8) = 0;
    x0_1 = sub_1680(sp - 24, 0, 0x1A0C, 0);
    __asm("cbnz w0, #0x2ebc");
    x0_2 = sub_1680(sp - 32, 0, 0x1A88, 0);
    __asm("cbnz w0, #0x2eac");
    x0_3 = sub_1720(var_28, sp - 16);
    x0_4 = sub_1720(var_20, 0);
    x19 = *(uint32 *)(var_30);
    x0_5 = sub_1630(var_30);
    loc_2E80:
    x0_6 = *(uint64 *)0x14FE8;
    x2 = var_38 - *(uint64 *)(x0_6);
    x1 = 0;
    __asm("b.ne #0x2ec4");
    return (uint32)x19;
    x0_7 = sub_1740(var_28);
    x19 = 0xFFFFFFFE;
    __asm("b #0x2e80");
    goto loc_2E80;
    x19 = 0xFFFFFFFF;
    __asm("b #0x2e80");
    goto loc_2E80;
    x0_8 = sub_1560();
}
void call_condition_variable(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_condition_variable(/* arguments unknown */);
    return;
}
void param_atomic_ops(void)
{
    uint32 load_12;
    loc_2EDC:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x21;
        local_pFFFFFFFFFFFFFFC0 = local_x21;
        local_pFFFFFFFFFFFFFFEC = a2;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call(v501);
        if (call_588 == 0) goto loc_3014;
        goto loc_2F10;
    loc_2F10:
        local_pFFFFFFFFFFFFFFB0 = call_185;
        local_pFFFFFFFFFFFFFFB0 = call_185;
        global_150C4 = 0;
        if ((int32_t)a1 <= 0) goto loc_301C;
        goto loc_2F30;
    loc_2F30:
        local_pFFFFFFFFFFFFFFD0 = call_185;
        local_pFFFFFFFFFFFFFFD0 = call_185;
    loc_2F48:
        unknown_call(phi(x19 + 8, call_588));
        if (call_961 != 0) goto loc_2FFC;
        goto loc_2F60;
    loc_2F60:
        if ((uint64_t)x19 + 8 != (uint64_t)phi(call_940, call_588 + (a1 << 3))) goto loc_2F48;
        goto loc_2F6C;
    loc_2F6C:
        unknown_call((phi(call_750, call_892)) + 80);
        if (call_638 == 0) goto loc_3048;
        goto loc_2F88;
    loc_2F88:
    loc_2F8C:
        unknown_call((phi(call_1021, phi(call_887, call_815)))[phi(x19 + 1, 0)]);
        if ((int32_t)phi(call_954, phi(call_739, call_653)) > (int32_t)x19 + 1) goto loc_2F8C;
        goto loc_2FA4;
    loc_2FA4:
    loc_2FA8:
        load_12 = global_150C4;
        unknown_call(phi(call_1021, call_881, call_719));
    loc_2FD4:
        if ((uint64_t)memory_unknown != (uint64_t)memory_unknown) goto loc_3058;
        goto loc_2FF0;
    loc_2FF0:
        return;
    loc_2FFC:
        unknown_call(phi(call_923, call_588));
        goto loc_2FD4;
    loc_3014:
        goto loc_2FD4;
    loc_301C:
        unknown_call((sp + 0xFFFFFFFFFFFFFFA0) + 80);
        if (call_639 != 0) goto loc_2FA8;
        goto loc_3038;
    loc_3038:
        unknown_call(var_FFFFFFFFFFFFFFF0);
        goto loc_2FA8;
    loc_3048:
        unknown_call(memory_unknown);
        goto loc_2F88;
    loc_3058:
        memory_unknown = local_phi_875;
        memory_unknown = local_phi_875;
        memory_unknown = local_phi_728;
        memory_unknown = local_phi_728;
        unknown_call(phi(0xFFFFFFFE, 0xFFFFFFFF, ((int32_t)load_12 > 0 ? 42 : 0xFFFFFFFD)));
}
void call_atomic_ops(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_atomic_ops(/* arguments unknown */);
    return;
}
uint32 param_thread_local_storage(int64 a1)
{
    uint64 var_20, var_50, var_68;

    x25 = (uint32)a1;
    var_68 = *(uint64 *)(*(uint64 *)0x14FE8);
    __asm("sbfiz x19, x25, #3, #0x20");
    x0_2 = sub_14D0(x19, 0);
    x0_3 = sub_14D0(x19);
    /* cmp x0_2, 0 — 次の分岐のための比較 */
    /* ccmp x0_3, 0, 4, ne — 次の分岐のための比較 */
    __asm("b.eq #0x3268");
    var_20 = x21;   var_28 = x22;
    /* cmp (int32)(x25), 0 — 次の分岐のための比較 */
    __asm("b.le #0x325c");
    var_50 = x27;
    x19 = 0;
    x20 = 16;
    x21 = 0x37B8;
    x26 = 1;
    x0_5 = sub_14D0(x20);
    *(uint64 *)(x22 + x19 * 8) = x0_5;
    x4 = x21;
    x3 = x20;
    x1 = x20;
    x0_6 = sub_14A0(x0_5, x20, (uint32)x26, x20, x21, (uint32)x19);
    x19 = x19 + 1;
    /* cmp x19, x23 — 次の分岐のための比較 */
    __asm("b.ne #0x30fc");
    x21 = x24;
    x19 = 0;
    x26 = 0x1B6C;
    x2 = x26;
    x0 = x21;
    x20 = (uint32)(sub_1680(x21, 0, x26, *(uint64 *)(x22 + x19 * 8)));
    __asm("cbnz w0, #0x321c");
    x19 = x19 + 1;
    x21 = x21 + 8;
    /* cmp x19, x23 — 次の分岐のための比較 */
    __asm("b.ne #0x313c");
    x23 = x23 * 8;
    x21 = (uint32)x0_8;
    x19 = 0;
    x26 = sp - 16;
    x1 = x26;
    x0_9 = sub_1720(*(uint64 *)(x24 + x19), x26);
    x20 = (uint32)((uint32)x20 + (uint32)*(uint32 *)(x0_10));
    x21 = (uint32)((uint32)x21 + (uint32)*(uint32 *)(x0_10 + 4));
    x0_11 = sub_1630(x0_10, (uint32)*(uint32 *)(x0_10 + 4));
    x0_12 = sub_1630(*(uint64 *)(x22 + x19));
    x19 = x19 + 8;
    /* cmp x19, x23 — 次の分岐のための比較 */
    __asm("b.ne #0x3178");
    loc_31B4:
    x0_13 = sub_1630(x22);
    x0_14 = sub_1630(x24);
    /* cmp (int32)((uint32)((uint32)x25 * 100)), (int32)(x20) — 次の分岐のための比較 */
    /* ccmp (int32)((uint32)((uint32)x25 * 150)), (int32)(x21), 0, eq — 次の分岐のための比較 */
    x0_15 = (uint32)(flag_eq ? 42 : 0xFFFFFFFD);
    loc_31EC:
    x1 = *(uint64 *)0x14FE8;
    x3 = var_68 - *(uint64 *)(x1);
    x2 = 0;
    __asm("b.ne #0x3270");
    return x0;
    __asm("tbnz w19, #0x1f, #0x323c");
    x20 = x22;
    x19 = x22 + 8 + (uint32)x19 * 8;
    x0_16 = sub_1630(*(uint64 *)(x20));
    /* cmp x20, x19 — 次の分岐のための比較 */
    __asm("b.ne #0x322c");
    x0_17 = sub_1630(x22);
    x0_18 = sub_1630(x24);
    x0_19 = 0xFFFFFFFE;
    __asm("b #0x31ec");
    goto loc_31EC;
    x21 = 0;
    x20 = 0;
    __asm("b #0x31b4");
    goto loc_31B4;
    x0_20 = 0xFFFFFFFF;
    __asm("b #0x31ec");
    goto loc_31EC;
    x0_21 = sub_1560();
}
void call_thread_local_storage(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_thread_local_storage(/* arguments unknown */);
    return;
}
void test_thread_concurrency(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x37C8);
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
    unknown_call(1);
    return;
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
uint32 aarch64_cas4_acq_rel(int64 a1, int64 a2, void * a3)
{
    __asm("cbz w16, #0x3378");
    *(uint32 *)(a3) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a3));
    /* cmp (int32)(x0), (int32)(x16) — 次の分岐のための比較 */
    __asm("b.ne #0x3390");
    x17 = __atomic_store((uint32 *)(a3), (int32)(a2));
    __asm("cbnz w17, #0x337c");
    return x0;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x33b8");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x33bc");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
