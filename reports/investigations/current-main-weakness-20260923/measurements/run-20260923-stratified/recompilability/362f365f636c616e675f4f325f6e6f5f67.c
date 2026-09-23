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
    global_152B0 = bit_extract((uint32_t)call_30, 8, 1);
    return;
}
void start(void)
{
    uint64 load_8;
    uint64 load_7;
    load_8 = var_0;
    load_7 = global_14FD8;
    unknown_call(load_7);
    unknown_call(load_7);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x14FD0;
    __asm("cbz x0, #0x1784");
    return sub_14A0(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x151F8 != 0x151F8) {
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
    if (!(global_151F8 != 0)) {
        if (!(global_14FC8 == 0)) {
            unknown_call(global_151F0);
        }
        deregister_tm_clones(/* arguments unknown */);
        memory_unknown = 1;
    }
    return;
}
void frame_dummy(void)
{
}
void param_strcpy(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(/* target unknown */);
    unknown_call(/* target unknown */);
    return;
}
void call_strcpy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m28 = 0;
    local_m30 = global_3138;
    unknown_call(sp - 48);
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
    return;
}
void param_printf(void)
{
}
void call_printf(void)
{
}
void param_scanf(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(a1);
    return;
}
void call_scanf(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("123,456");
    return;
}
void param_fopen_fclose(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(a1);
    if (call_149 == 0) {
    } else {
        unknown_call(call_149);
        unknown_call(call_149);
    }
    return;
}
void call_fopen_fclose(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call("/etc/passwd");
    if (call_216 == 0) {
    } else {
        unknown_call(call_216);
        unknown_call(call_216);
    }
    return;
}
void param_fread_fwrite(void)
{
    local_m30 = local_x29;
    local_m30 = local_x29;
    local_m20 = local_x22;
    local_m20 = local_x22;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call(a1);
    if (call_638 == 0) {
    } else {
        unknown_call("BinBench Test Data");
        if ((uint64_t)call_355 != 18) {
            unknown_call(call_638);
        } else {
            unknown_call(call_638);
            unknown_call(sp - 80);
            (var_400 - 80)[call_163] = 0;
            unknown_call(call_638);
            unknown_call(a1);
            if ((uint64_t)call_459 == 18) {
            }
        }
    }
    return;
}
void call_fread_fwrite(void)
{
}
void param_malloc_free(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(a1 << 2);
    if (call_335 == 0) {
    } else {
        if (a1 == 0) {
        } else {
            if ((uint64_t)a1 >= 8) {
                memory_unknown = var_147;
                memory_unknown = var_147;
                while ((uint64_t)phi(v45 - 8, a1 & 0xFFFFFFFFFFFFFFF8) != 8) {
                }
                if ((uint64_t)a1 & 0xFFFFFFFFFFFFFFF8 != (uint64_t)a1) {
                    memory_unknown = local_phi_382;
                    while ((uint64_t)phi(v187 - 1, a1 - (phi(0, a1 & 0xFFFFFFFFFFFFFFF8))) != 1) {
                    }
                }
            } else {
                goto loc_1C34;
            }
        }
        unknown_call(call_335);
    }
    return;
}
void call_malloc_free(void)
{
    return;
}
uint32 param_memset(int64 a1, uint64 a2)
{
    // … ほかに 2 個の置き場（退避用など）があります

    x0 = sub_1450(a1, 0, a2);
    __asm("cbz x20, #0x1cb8");
    /* cmp a2, 8 — 次の分岐のための比較 */
    __asm("b.hs #0x1cc0");
    x8 = 0;
    x0 = 0;
    __asm("b #0x1d08");
    __asm("b #0x1d20");
    x9 = a1 + 4;
    v0.2d = 0; /* vector zero */
    x10 = a2 & 0xFFFFFFFFFFFFFFF8;
    v1.2d = 0; /* vector zero */
    v2 = *(float *)(x9 + -4);   v3 = *(float *)(x9);
    x9 = x9 + 8;
    x10 = x10 - 8;
    __asm("ushll v2.8h, v2.8b, #0");
    __asm("ushll v3.8h, v3.8b, #0");
    __asm("uaddw v0.4s, v0.4s, v2.4h");
    __asm("uaddw v1.4s, v1.4s, v3.4h");
    __asm("b.ne #0x1cd4");
    v0 = v1 + v0;
    /* cmp x8, a2 — 次の分岐のための比較 */
    __asm("addv s0, v0.4s");
    x0 = (uint32)v0;
    __asm("b.eq #0x1d20");
    x9 = a2 - x8;
    x8 = a1 + x8;
    x10 = *(uint8 *)(x8);
    x9 = x9 - 1;
    x0 = (uint32)((uint32)x0 + (uint32)*(uint8 *)(x8));
    __asm("b.ne #0x1d10");
    return x0;
}
void call_memset(void)
{
    return;
}
void param_strchr_strstr(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(a1);
    unknown_call(a1);
    return;
}
void call_strchr_strstr(void)
{
    return;
}
void test_standard_library_functions(void)
{
    local_m30 = local_x29;
    local_m30 = local_x29;
    local_m20 = local_x21;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call("=== 测试标准库函数调用 ===");
    local_m48 = 0;
    local_m50 = global_3138;
    unknown_call(sp - 80);
    unknown_call("LIB-L1-01: %d (期望: 8)\\n");
    unknown_call("LIB-L1-02: %d (期望: 0)\\n");
    unknown_call("LIB-L1-03: %d (期望: 12)\\n");
    unknown_call("LIB-L1-04: %d (期望: 90)\\n");
    unknown_call("LIB-L1-05: %d (期望: -1)\\n");
    unknown_call("Value: %d, Name: %s\\n");
    unknown_call("LIB-L1-06: %d (期望: 22)\\n");
    unknown_call("123,456");
    unknown_call("LIB-L1-07: %d (期望: 579)\\n");
    unknown_call("/etc/passwd");
    if (!(call_1029 == 0)) {
        unknown_call(call_1029);
        unknown_call(call_1029);
    }
    unknown_call("LIB-L1-08: %d (期望: 42)\\n");
    param_fread_fwrite(/* arguments unknown */);
    unknown_call("LIB-L1-09: %d (期望: 42)\\n");
    unknown_call("LIB-L1-10: %d (期望: 90)\\n");
    unknown_call("LIB-L1-11: %d (期望: 0)\\n");
    unknown_call("LIB-L1-12: %d (期望: 15)\\n");
    return;
}
void param_linux_syscall(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(56);
    if (__arm64_condition_unknown(/* NZCV */)) {
        unknown_call(call_151);
    } else {
        unknown_call(57);
    }
    return;
}
void call_linux_syscall(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(56);
    if (__arm64_condition_unknown(/* NZCV */)) {
        unknown_call(call_136);
    } else {
        unknown_call(57);
    }
    return;
}
void param_win32_api(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(a1);
    return;
}
void call_win32_api(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call("/etc/passwd");
    return;
}
void param_fork_exec(void)
{
    loc_2064:
        local_m20 = local_x29;
        local_m20 = local_x29;
        local_m10 = local_x20;
        local_m10 = local_x20;
        unknown_call(a1);
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_20AC;
        goto loc_2084;
    loc_2084:
        if (call_266 == 0) goto loc_20D0;
        goto loc_2088;
    loc_2088:
        unknown_call(call_266);
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_20B4;
        goto loc_2098;
    loc_2098:
        if (((uint32_t)var_m24 & (uint32_t)0x7F) == 0) goto loc_20BC;
        goto loc_20A4;
    loc_20A4:
        goto loc_20C0;
    loc_20AC:
        goto loc_20C0;
    loc_20B4:
        goto loc_20C0;
    loc_20BC:
    loc_20C0:
        return;
    loc_20D0:
        unknown_call(a1);
        unknown_call(0x7F);
}
uint32 call_fork_exec(int64 a1)
{
    uint32 var_C;

    x0_1 = sub_13B0();
    __asm("tbnz w0, #0x1f, #0x2120");
    __asm("cbz w0, #0x2140");
    x0_2 = sub_16B0(x0_1, &var_C, 0);
    __asm("tbnz w0, #0x1f, #0x2120");
    /* tst (int32)(var_C), 0x7F — 次の分岐のための比較 */
    __asm("b.eq #0x2130");
    loc_2124:
    return x0;
    /* tst (int32)(x8), 0xFF00 — 次の分岐のための比較 */
    __asm("b #0x2124");
    goto loc_2124;
    x0_3 = sub_1350("/bin/true", "/bin/true", 0, 0);
    x0_4 = sub_1310(127);
}
void param_pipe_communication(void)
{
    uint32 load_14;
    loc_2160:
        local_m20 = local_x29;
        local_m20 = local_x29;
        local_m10 = local_x20;
        local_m10 = local_x20;
        unknown_call(((sp - 80) + 48) - 8);
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_21D0;
        goto loc_217C;
    loc_217C:
        unknown_call(call_432);
        if (__arm64_condition_unknown(/* NZCV */)) goto loc_21D8;
        goto loc_2184;
    loc_2184:
        if (call_317 == 0) goto loc_21EC;
        goto loc_2188;
    loc_2188:
        unknown_call(var_m24);
        unknown_call(var_m28);
        load_14 = var_m28;
        (var_304 - 80 + 8)[call_270] = 0;
        unknown_call(load_14);
        unknown_call(0);
        goto loc_21DC;
    loc_21D0:
        goto loc_21DC;
    loc_21D8:
    loc_21DC:
        return;
    loc_21EC:
        unknown_call(var_m28);
        unknown_call(var_m24);
        unknown_call(var_m24);
        unknown_call(0);
}
void call_pipe_communication(void)
{
}
void param_socket_create(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call(2);
    if (__arm64_condition_unknown(/* NZCV */)) {
    } else {
        local_m24 = 1;
        unknown_call(call_303);
        if (__arm64_condition_unknown(/* NZCV */)) {
            unknown_call(call_303);
        } else {
            local_m38 = 2;
            local_m38 = 2;
            unknown_call(call_303);
            if (__arm64_condition_unknown(/* NZCV */)) {
                unknown_call(call_303);
            } else {
                unknown_call(call_303);
                unknown_call(call_303);
            }
        }
    }
    return;
}
void call_socket_create(void)
{
}
uint32 param_shmget_shmat(void)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0_1 = sub_1430("/tmp/binbench_shm", 66, 438);
    __asm("tbnz w0, #0x1f, #0x238c");
    x0_2 = sub_1490(x0_1);
    x0_3 = sub_1540("/tmp/binbench_shm", 42);
    __asm("tbnz w0, #0x1f, #0x238c");
    x0_4 = sub_1560(x0_3, 0x1000, 950);
    __asm("tbnz w0, #0x1f, #0x23a4");
    x0_5 = sub_1460(x0_4, 0, 0);
    /* cmn x0_5, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x23ac");
    *(uint64 *)(x0_5 + 5) = "dMemory";
    *(uint64 *)(x0_5) = *(uint64 *)("SharedMemory");
    x0_6 = sub_1320(x0_5);
    x0_7 = sub_1370(x0_5);
    x0_8 = (uint32)x0_4;
    x0_9 = sub_1520(x0_8, 0, 0);
    __asm("b #0x2390");
    x20 = 0xFFFFFFFF;
    loc_2390:
    return (uint32)x20;
    x20 = 0xFFFFFFFE;
    __asm("b #0x2390");
    goto loc_2390;
    x20 = 0xFFFFFFFD;
    __asm("b #0x2390");
    goto loc_2390;
}
void call_shmget_shmat(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_shmget_shmat(/* arguments unknown */);
    return;
}
void param_signal_handling(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(10);
    if ((uint64_t)((uint64_t)call_478 + (uint64_t)1) == 0) {
    } else {
        unknown_call(14);
        if ((uint64_t)((uint64_t)call_409 + (uint64_t)1) == 0) {
        } else {
            global_15200 = 0;
            unknown_call(10);
            if (!(global_15200 != 0)) {
                unknown_call(0x3E8);
                while (condition_hi) {
                }
            }
            if (memory_unknown == 0) {
            } else {
                if ((uint32_t)global_15204 != 10) {
                } else {
                    memory_unknown = 0;
                    unknown_call(1);
                    if (!(memory_unknown != 0)) {
                        unknown_call(phi(call_784, call_453));
                        while (condition_hi) {
                        }
                    }
                    if (memory_unknown == 0) {
                    } else {
                        if ((uint32_t)memory_unknown != 14) {
                            goto loc_24F4;
                        } else {
                            unknown_call(10);
                            unknown_call(14);
                        }
                    }
                }
            }
        }
    }
    return;
}
void signal_handler(void)
{
    global_15200 = 1;
    global_15204 = a1;
    return;
}
void call_signal_handling(void)
{
}
uint32 test_system_calls(void)
{
    uint64 var_30;

    x0_1 = sub_14F0("=== 测试系统调用 ===");
    x0_2 = sub_1690(56, 0xFFFFFF9C, "/etc/passwd", 0);
    __asm("tbnz w19, #0x1f, #0x2570");
    x0_3 = sub_1690(57, (uint32)x0_2);
    __asm("b #0x257c");
    x19 = (uint32)-(uint32)*(uint32 *)(sub_1640());
    /* cmp (int32)(x19), 0 — 次の分岐のための比較 */
    x19 = 42;
    x0_5 = sub_1630("SYS-L3-01: %d (期望: 42)\\n", (uint32)((uint32)x19 >= 0 ? 42 : -1));
    x0_6 = sub_14B0("/etc/passwd", &var_0);
    /* cmp var_30, 0 — 次の分岐のための比較 */
    /* cmp (int32)(x0_6), 0 — 次の分岐のための比較 */
    x0_7 = sub_1630("SYS-L3-02: %d (期望: 42)\\n", (uint32)((uint32)x0_6 >= 0 ? (uint32)(var_30 > 0 ? 42 : 0xFFFFFFFE) : -1));
    x0_8 = sub_13B0(x0_7);
    __asm("tbnz w0, #0x1f, #0x25f0");
    __asm("cbz w0, #0x2674");
    x0_9 = sub_16B0(x0_8, &var_0, 0);
    __asm("tbnz w0, #0x1f, #0x25f0");
    /* tst (int32)(var_0), 0x7F — 次の分岐のための比較 */
    __asm("b.eq #0x2664");
    x1_1 = 0xFFFFFFFF;
    loc_25F4:
    x0_10 = sub_1630("SYS-L3-03: %d (期望: 42)\\n");
    x0_11 = param_pipe_communication(x0_10);
    x0_12 = sub_1630("SYS-L3-04: %d (期望: 42)\\n", (uint32)x0_11);
    x0_13 = param_socket_create(x0_12);
    x0_14 = sub_1630("SYS-L3-05: %d (期望: 42)\\n", (uint32)x0_13);
    x0_15 = param_shmget_shmat(x0_14);
    /* cmp (int32)(x0_15), 0 — 次の分岐のための比較 */
    x0_16 = sub_1630("SYS-L3-06: %d (期望: 42)\\n", (uint32)((uint32)x0_15 > 0 ? (uint32)x19 : -1));
    x0_17 = param_signal_handling(x0_16);
    x0_18 = sub_1630("SYS-L3-07: %d (期望: 42)\\n", (uint32)x0_17);
    return x0_18;
    /* tst (int32)(x8), 0xFF00 — 次の分岐のための比較 */
    x1_2 = (uint32)(Z_tst32((uint32)x8, 0xFF00) ? 42 : -1);
    __asm("b #0x25f4");
    goto loc_25F4;
    x0_19 = sub_1350("/bin/true", "/bin/true", 0, 0);
    x0_20 = sub_1310(127);
}
void thread_compute(void)
{
    uint32 load_42;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    load_42 = a1->field_0;
    unknown_call(4);
    memory_unknown = load_42 * load_42;
    return;
}
void param_pthread_create(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    local_m24 = a1;
    unknown_call(((sp - 48) + 16) + 24);
    if (call_170 == 0) {
        unknown_call(var_m8);
        unknown_call(var_m30);
    } else {
    }
    return;
}
void call_pthread_create(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    local_m24 = 7;
    unknown_call(((sp - 48) + 16) + 24);
    if (call_239 == 0) {
        unknown_call(var_m8);
        unknown_call(var_m30);
    } else {
    }
    return;
}
void thread_sum(void)
{
    uint32 load_37;
    uint32 load_50;
    load_50 = a1->field_0;
    load_37 = a1->field_4;
    a1->field_8 = 0;
    if ((int32_t)load_37 >= (int32_t)load_50) {
        a1->field_8 = load_37 + (load_37 - load_50) * load_50 + (uint32_t)((uint64_t)((load_37 + ~load_50) * (load_37 - load_50)) >> 1);
    }
    return;
}
uint32 param_pthread_join(void)
{
    uint64 var_28, var_30, var_38, var_8;
    double var_C, var_18;
    uint32 var_20;

    x1 = 0;
    var_8 = x1;   var_10 = x1;
    var_20 = x1;
    x20 = &var_28;
    var_0 = *(uint64 *)0x3120;
    var_C = *(uint64 *)0x3128;
    var_18 = *(uint64 *)0x3130;
    x0_1 = sub_15A0(&var_28, x1, 0x278C, &var_0);
    __asm("cbnz w0, #0x2860");
    x0_2 = sub_15A0(&var_30, x1, 0x278C, &var_C);
    __asm("cbnz w0, #0x2860");
    x0_3 = sub_15A0(&var_38, x1, 0x278C, &var_18);
    __asm("cbz w0, #0x2874");
    loc_2864:
    return x0;
    x0_4 = sub_1650(var_28, x1);
    __asm("cbnz w0, #0x28ac");
    x19 = var_8;
    x0_5 = sub_1650(var_30, x1);
    __asm("cbnz w0, #0x28ac");
    x0_6 = sub_1650(var_38, x1);
    __asm("cbz w0, #0x28b4");
    __asm("b #0x2864");
    goto loc_2864;
    __asm("b #0x2864");
    goto loc_2864;
}
void call_pthread_join(void)
{
}
void thread_increment(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    if ((int32_t)a1->field_0 >= 1) {
        unknown_call(phi(call_206, 0x15208));
        memory_unknown = memory_unknown + 1;
        unknown_call(phi(call_206, 0x15208));
        unknown_call(0x3E8);
        while ((uint32_t)phi(v95 - 1, a1->field_0) != 1) {
        }
    }
    return;
}
void param_mutex_lock(void)
{
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFB0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x25;
    local_pFFFFFFFFFFFFFFD0 = local_x24;
    local_pFFFFFFFFFFFFFFD0 = local_x24;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFCC = a2;
    unknown_call(x0);
    if (call_565 == 0) {
    } else {
        global_15238 = 0;
        if ((int32_t)a1 < 1) {
            unknown_call(phi(call_389, call_565, call_470));
        } else {
            unknown_call((phi(call_565, call_477)) + (phi(0, x24 + 8)));
            unknown_call((phi(call_565, call_477)) + (phi(0, x24 + 8)));
            if (call_470 != 0) {
                unknown_call(phi(call_565, call_477));
            } else {
                if ((uint64_t)phi(a1 << 3, call_561) != (uint64_t)x24 + 8) {
                    goto loc_2984;
                } else {
                    if ((int32_t)phi(call_344, call_654) >= 1) {
                        unknown_call(phi(call_470, call_389));
                        while ((uint64_t)phi(call_484, v103 - 1) != 1) {
                        }
                    }
                    goto loc_29C8;
                }
            }
        }
    }
    return;
}
void call_mutex_lock(void)
{
}
void consumer_thread(void)
{
    uint8 load_55;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(0x15240);
    if (__arm64_condition_unknown(/* NZCV */)) {
        unknown_call(phi(call_269, call_244));
        while ((uint32_t)memory_unknown != 1) {
        }
    }
    load_55 = global_152A8;
    unknown_call(0x15240);
    unknown_call(4);
    memory_unknown = (uint8_t)load_55 != 0 ? 42 : 0;
    return;
}
void producer_thread(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(1);
    unknown_call(0x15240);
    global_152A8 = 1;
    global_15270 = 1;
    unknown_call(0x15278);
    unknown_call(0x15240);
    return;
}
void param_condition_variable(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    global_15270 = 0;
    global_152A8 = 0;
    unknown_call((sp - 48) + 8);
    if (call_200 == 0) {
        unknown_call(((sp - 48) + 16) + 24);
        if (call_320 == 0) {
            unknown_call(var_m28);
            unknown_call(var_m8);
            unknown_call(var_m30);
        } else {
            unknown_call(var_m28);
        }
    } else {
    }
    return;
}
void call_condition_variable(void)
{
}
void thread_atomic_increment(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    if ((int32_t)a1->field_0 >= 1) {
        aarch64_ldadd4_acq_rel(/* arguments unknown */);
        aarch64_cas4_acq_rel(/* arguments unknown */);
        while ((uint32_t)x19 + 1 != (uint32_t)phi(a1->field_0, call_240)) {
        }
    }
    return;
}
void thread_atomic_load_store(void)
{
    global_152AC += 0x64;
    return;
}
void param_atomic_ops(void)
{
    uint32 load_68;
    local_m40 = local_x29;
    local_m40 = local_x29;
    local_m30 = local_x24;
    local_m30 = local_x24;
    local_m20 = local_x22;
    local_m20 = local_x22;
    local_m10 = local_x20;
    local_m10 = local_x20;
    local_m44 = a2;
    unknown_call(x0);
    if (call_631 == 0) {
    } else {
        global_152AC = 0;
        if ((int32_t)a1 < 1) {
            unknown_call(phi(call_595, call_534));
            if (!(call_450 != 0)) {
                unknown_call(memory_unknown);
            }
            if ((int32_t)phi(call_674, call_639) >= 1) {
                unknown_call(phi(call_730, phi(call_450, call_451)));
                while ((uint64_t)phi(v186 - 1, phi(call_674, call_639)) != 1) {
                }
            }
            load_68 = memory_unknown;
            unknown_call(phi(phi(call_450, call_451), call_730));
        } else {
            unknown_call(phi(call_631, call_664));
            unknown_call(phi(call_631, call_664));
            if (call_664 != 0) {
                unknown_call(phi(call_631, call_401));
            } else {
                if ((uint64_t)phi(a1 << 3, call_564) != (uint64_t)x23 + 8) {
                    goto loc_2C94;
                } else {
                    goto loc_2CB8;
                }
            }
        }
    }
    return;
}
void call_atomic_ops(void)
{
}
void thread_tls_test(void)
{
    uint32 load_11;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    load_11 = memory_unknown;
    memory_unknown = load_11 + 50;
    unknown_call((v133 + 0) + 20);
    unknown_call(8);
    memory_unknown = load_11;
    memory_unknown = load_11;
    return;
}
void param_thread_local_storage(void)
{
    local_m50 = local_x29;
    local_m50 = local_x29;
    local_m40 = local_x26;
    local_m40 = local_x26;
    local_m30 = local_x24;
    local_m30 = local_x24;
    local_m20 = local_x22;
    local_m20 = local_x22;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call(x21);
    unknown_call(x21);
    if (!(call_600 == 0)) {
        if (!(call_1143 == 0)) {
            if ((int32_t)a1 < 1) {
                unknown_call(phi(call_1172, phi(call_974, call_809, call_1143)));
                unknown_call(phi(call_891, phi(call_944, call_748, call_1144)));
            } else {
                unknown_call(phi(call_980, 0xFFFFFFFF));
                local_phi_1148[local_phi_1257] = call_848;
                unknown_call(call_1023);
                while ((uint64_t)phi(call_1195, a1) != (uint64_t)x22 + 1) {
                }
                if ((int32_t)phi(call_723, call_656) < 1) {
                    goto loc_2EC0;
                } else {
                    unknown_call(phi(x22 + 8, phi(call_944, call_1144)));
                    unknown_call(phi(x22 + 8, phi(call_944, call_1144)));
                    if (call_632 != 0) {
                        unknown_call(phi(call_632, call_1254));
                        while ((uint64_t)phi((phi(x25, 0)) + 1, call_1185) != (uint64_t)x20 + 1) {
                        }
                        unknown_call(phi(call_809, call_967));
                        unknown_call(phi(call_748, call_757));
                    } else {
                        if ((uint64_t)phi(call_991, call_1195) != (uint64_t)(phi(x25, 0)) + 1) {
                            goto loc_2E4C;
                        } else {
                            if ((int32_t)phi(call_673, call_723) < 1) {
                                goto loc_2EC0;
                            } else {
                                unknown_call(phi(call_622, call_632));
                                unknown_call(memory_unknown);
                                unknown_call(memory_unknown);
                                while ((uint64_t)phi(v546 - 1, call_991) != 1) {
                                }
                            }
                            goto loc_2EC8;
                        }
                    }
                }
            }
        }
    }
    return;
}
void call_thread_local_storage(void)
{
}
void test_thread_concurrency(void)
{
    local_m20 = local_x29;
    local_m20 = local_x29;
    local_m10 = local_x19;
    unknown_call("=== 测试线程与并发 ===");
    local_m24 = 7;
    unknown_call(((sp - 48) + 16) + 24);
    if (call_575 == 0) {
        unknown_call(var_m8);
        unknown_call(var_m30);
    } else {
    }
    unknown_call("THR-L3-01: %d (期望: 49)\\n");
    param_pthread_join(/* arguments unknown */);
    unknown_call("THR-L3-02: %d (期望: 465)\\n");
    param_mutex_lock(/* arguments unknown */);
    unknown_call("THR-L3-03: %d (期望: 42)\\n");
    param_condition_variable(/* arguments unknown */);
    unknown_call("THR-L3-04: %d (期望: 42)\\n");
    param_atomic_ops(/* arguments unknown */);
    unknown_call("THR-L3-05: %d (期望: 42)\\n");
    param_thread_local_storage(/* arguments unknown */);
    unknown_call("THR-L3-06: %d (期望: 42)\\n");
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
    __asm("cbz w16, #0x3088");
    *(uint32 *)(a3) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a3));
    /* cmp (int32)(x0), (int32)(x16) — 次の分岐のための比較 */
    __asm("b.ne #0x30a0");
    x17 = __atomic_store((uint32 *)(a3), (int32)(a2));
    __asm("cbnz w17, #0x308c");
    return x0;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x30c8");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x30cc");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
