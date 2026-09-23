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
    uint64 load_4;
    uint64 load_0;
    load_4 = var_0;
    load_0 = global_14FD8;
    unknown_call(load_0);
    unknown_call(load_0);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x14FD0;
    __asm("cbz x0, #0x1784");
    return sub_14B0(x0_1);
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
    uint64 load_68;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    load_68 = var_0;
    unknown_call(var_8);
    unknown_call(var_8);
    return;
}
void call_strcpy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_strcpy(/* arguments unknown */);
    local_m34 = call_60;
    return;
}
void param_strcmp(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    unknown_call(var_m18);
    local_m24 = call_75;
    if ((int32_t)var_m24 <= 0) {
        local_m28 = (int32_t)local_m24 >= 0 ? 0 : 0xFFFFFFFF;
    } else {
        local_m28 = 1;
    }
    return;
}
void call_strcmp(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_strcmp(/* arguments unknown */);
    local_m14 = call_64;
    param_strcmp(/* arguments unknown */);
    local_m18 = call_95;
    param_strcmp(/* arguments unknown */);
    local_m1C = call_136;
    return;
}
void param_strlen(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(var_8);
    local_m20 = call_54;
    return;
}
void call_strlen(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0x3925;
    param_strlen(/* arguments unknown */);
    return;
}
void param_memcpy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    unknown_call(var_m18);
    return;
}
void call_memcpy(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = global_3D04;
    local_m20 = global_3D14;
    local_m48 = 0;
    local_m40 = 0;
    local_m38 = 0;
    param_memcpy(/* arguments unknown */);
    return;
}
void param_memcmp(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    unknown_call(var_m18);
    local_m2C = call_91;
    if ((int32_t)var_m2C <= 0) {
        local_m30 = (int32_t)local_m2C >= 0 ? 0 : 0xFFFFFFFF;
    } else {
        local_m30 = 1;
    }
    return;
}
void call_memcmp(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m50 = var_236 - 96 + 80 - 16;
    local_m20 = global_3D18;
    local_m18 = global_3D20;
    local_m30 = global_3D24;
    local_m28 = global_3D2C;
    local_m60 = var_236 - 96 + 32;
    local_m40 = global_3D30;
    local_m38 = global_3D38;
    local_m58 = 12;
    param_memcmp(/* arguments unknown */);
    local_m44 = (uint32_t)call_226;
    param_memcmp(/* arguments unknown */);
    local_m48 = call_271;
    return;
}
void param_printf(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m14 = a1;
    local_m20 = a2;
    unknown_call("Value: %d, Name: %s\\n");
    local_m24 = call_83;
    return;
}
void call_printf(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_printf(/* arguments unknown */);
    local_m14 = call_56;
    return;
}
void param_scanf(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(var_10);
    local_m2C = call_88;
    if ((uint32_t)var_m2C != 2) {
        local_m14 = 0xFFFFFFFF;
    } else {
        local_m14 = local_m24 + local_m28;
    }
    return;
}
void call_scanf(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_scanf(/* arguments unknown */);
    return;
}
void param_fopen_fclose(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(var_10);
    local_m28 = call_75;
    if (var_m28 != 0) {
        unknown_call(var_m28);
        local_m2C = call_165;
        unknown_call(var_m28);
        local_m14 = local_m2C;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_fopen_fclose(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_fopen_fclose(/* arguments unknown */);
    local_m14 = call_51;
    return;
}
void param_fread_fwrite(void)
{
    uint64 load_242;
    uint64 load_165;
    uint64 load_44;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = 0x3963;
    unknown_call(var_m20);
    local_m50 = call_117;
    if (var_m50 != 0) {
        local_m70 = local_m28;
        unknown_call(var_m28);
        load_242 = var_m50;
        unknown_call(var_m70);
        local_m58 = call_376;
        local_m68 = local_m58;
        unknown_call(var_m28);
        if ((uint64_t)var_m68 == (uint64_t)call_536) {
            unknown_call(var_m50);
            load_165 = var_m58;
            load_44 = var_m50;
            local_m80 = var_625 - 0x80 + 56;
            unknown_call((sp - 0x80) + 56);
            local_m60 = call_544;
            memory_unknown = 0;
            unknown_call(var_m50);
            unknown_call(var_m20);
            local_m74 = 0;
            if ((uint64_t)var_m60 == (uint64_t)var_m58) {
                unknown_call((sp - 0x80) + 56);
                local_m74 = (uint32_t)call_196 == 0 ? 1 : 0;
            }
            memory_unknown = ((uint32_t)memory_unknown & (uint32_t)1) != 0 ? 42 : 0xFFFFFFFD;
        } else {
            unknown_call(var_m50);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_fread_fwrite(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_fread_fwrite(/* arguments unknown */);
    return;
}
void param_malloc_free(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(var_m20 << 2);
    local_m28 = call_79;
    if (var_m28 != 0) {
        local_m30 = 0;
        while ((uint64_t)var_m30 < (uint64_t)var_m20) {
            local_m28[local_m30] = local_m30 * 10;
            local_m30++;
            continue;
        }
        local_m34 = memory_unknown + local_m28[local_m20 - 1];
        unknown_call(var_m28);
        local_m28 = 0;
        local_m14 = local_m34;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_malloc_free(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_malloc_free(/* arguments unknown */);
    return;
}
void param_memset(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    unknown_call(var_m18);
    local_m28 = local_m18;
    local_m2C = 0;
    local_m38 = 0;
    while ((uint64_t)var_m38 < (uint64_t)var_m20) {
        local_m2C += local_m28[local_m38];
        local_m38++;
        continue;
    }
    return;
}
void call_memset(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m3C = 0;
    while ((int32_t)var_4 < 10) {
        (var_168 - 64 + 8)[(int64_t)local_m3C] = 0xFF;
        local_m3C++;
        continue;
    }
    param_memset(/* arguments unknown */);
    return;
}
void param_strchr_strstr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m19 = (uint32_t)a2;
    local_m28 = a3;
    unknown_call(var_m18);
    local_m30 = call_91;
    if (var_m30 == 0) {
        local_m50 = 0xFFFFFFFFFFFFFFFF;
    } else {
        local_m50 = local_m30 - local_m18;
    }
    local_m34 = local_m50;
    unknown_call(var_m18);
    local_m40 = call_282;
    if (var_m40 == 0) {
        local_m58 = 0xFFFFFFFFFFFFFFFF;
    } else {
        local_m58 = local_m40 - local_m18;
    }
    local_m44 = local_m58;
    return;
}
void call_strchr_strstr(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0x3990;
    param_strchr_strstr(/* arguments unknown */);
    local_m1C = call_85;
    return;
}
void test_standard_library_functions(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call("=== 测试标准库函数调用 ===\\n");
    call_strcpy(/* arguments unknown */);
    unknown_call("LIB-L1-01: %d (期望: 8)\\n");
    call_strcmp(/* arguments unknown */);
    unknown_call("LIB-L1-02: %d (期望: 0)\\n");
    call_strlen(/* arguments unknown */);
    unknown_call("LIB-L1-03: %d (期望: 12)\\n");
    call_memcpy(/* arguments unknown */);
    unknown_call("LIB-L1-04: %d (期望: 90)\\n");
    call_memcmp(/* arguments unknown */);
    unknown_call("LIB-L1-05: %d (期望: -1)\\n");
    call_printf(/* arguments unknown */);
    unknown_call("LIB-L1-06: %d (期望: 22)\\n");
    call_scanf(/* arguments unknown */);
    unknown_call("LIB-L1-07: %d (期望: 579)\\n");
    call_fopen_fclose(/* arguments unknown */);
    unknown_call("LIB-L1-08: %d (期望: 42)\\n");
    call_fread_fwrite(/* arguments unknown */);
    unknown_call("LIB-L1-09: %d (期望: 42)\\n");
    call_malloc_free(/* arguments unknown */);
    unknown_call("LIB-L1-10: %d (期望: 90)\\n");
    call_memset(/* arguments unknown */);
    unknown_call("LIB-L1-11: %d (期望: 0)\\n");
    call_strchr_strstr(/* arguments unknown */);
    unknown_call("LIB-L1-12: %d (期望: 15)\\n");
    return;
}
void param_linux_syscall(void)
{
    uint64 load_100;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    load_100 = var_10;
    unknown_call(56);
    local_m24 = (uint32_t)call_83;
    if ((int32_t)var_m24 >= 0) {
        unknown_call(57);
        local_m14 = local_m24;
    } else {
        unknown_call(call_220);
        local_m14 = 0 - memory_unknown;
    }
    return;
}
void call_linux_syscall(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_linux_syscall(/* arguments unknown */);
    local_m14 = call_51;
    return;
}
void param_win32_api(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    unknown_call(var_m20);
    if ((int32_t)call_201 >= 0) {
        local_m14 = (int64_t)local_m70 > 0 ? 42 : 0xFFFFFFFE;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_win32_api(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_win32_api(/* arguments unknown */);
    return;
}
void param_fork_exec(void)
{
    uint64 load_81;
    uint64 load_224;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    unknown_call(a1);
    local_m2C = call_81;
    if ((int32_t)var_m2C >= 0) {
        if (!(var_m2C != 0)) {
            load_81 = var_m20;
            load_224 = var_18;
            unknown_call(var_m20);
            unknown_call(0x7F);
        }
        unknown_call(phi(call_283, call_364));
        memory_unknown = call_311;
        if ((int32_t)memory_unknown >= 0) {
            if (memory_unknown & 0x7F != 0) {
                memory_unknown = 0xFFFFFFFD;
            } else {
                memory_unknown = (int32_t)(memory_unknown & 0xFF00) >> 8;
            }
        } else {
            memory_unknown = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_fork_exec(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_fork_exec(/* arguments unknown */);
    local_m14 = call_55;
    return;
}
void param_pipe_communication(void)
{
    uint64 load_182;
    uint32 load_349;
    uint64 load_230;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(((sp - 0x70) + 96) - 12);
    if ((int32_t)call_633 >= 0) {
        unknown_call(call_633);
        local_m40 = call_461;
        if ((int32_t)var_m40 >= 0) {
            if (!(var_m40 != 0)) {
                unknown_call(var_m1C);
                local_m48 = 0x3B27;
                local_m54 = local_m18;
                local_m60 = local_m48;
                unknown_call(var_m48);
                load_230 = var_m60;
                unknown_call(var_m54);
                unknown_call(var_m18);
                unknown_call(0);
            }
            unknown_call(phi(call_405, call_372));
            load_349 = memory_unknown;
            memory_unknown = local_phi_430 - 44;
            unknown_call(load_349);
            load_182 = memory_unknown;
            memory_unknown = call_168;
            memory_unknown = 0;
            unknown_call(memory_unknown);
            unknown_call(0);
            memory_unknown = (int64_t)memory_unknown > 0 ? 42 : 0xFFFFFFFD;
        } else {
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_pipe_communication(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pipe_communication(/* arguments unknown */);
    return;
}
void param_socket_create(void)
{
    uint64 load_130;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(2);
    local_m18 = call_68;
    if ((int32_t)var_m18 >= 0) {
        local_m1C = 1;
        unknown_call(var_m18);
        if ((int32_t)call_477 >= 0) {
            local_m38 = var_409 - 64 + 16;
            local_m30 = 0;
            local_m28 = 0;
            local_m30 = 2;
            unknown_call(0);
            load_130 = var_m38;
            local_m2E = (uint32_t)call_256;
            local_m2C = 0;
            unknown_call(var_m18);
            if ((int32_t)call_517 >= 0) {
                unknown_call(var_m18);
                if ((int32_t)call_542 >= 0) {
                    unknown_call(var_m18);
                    local_m14 = 42;
                } else {
                    unknown_call(var_m18);
                    local_m14 = 0xFFFFFFFC;
                }
            } else {
                unknown_call(var_m18);
                local_m14 = 0xFFFFFFFD;
            }
        } else {
            unknown_call(var_m18);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_socket_create(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_socket_create(/* arguments unknown */);
    return;
}
void param_shmget_shmat(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = 0x3B31;
    unknown_call(var_m20);
    local_m24 = call_88;
    if ((int32_t)var_m24 >= 0) {
        unknown_call(var_m24);
        unknown_call("/tmp/binbench_shm");
        local_m28 = call_547;
        if ((int32_t)var_m28 >= 0) {
            unknown_call(var_m28);
            local_m2C = call_441;
            if ((int32_t)var_m2C >= 0) {
                unknown_call(var_m2C);
                local_m38 = call_200;
                if ((uint64_t)((uint64_t)var_m38 + (uint64_t)1) != 0) {
                    unknown_call(var_m38);
                    unknown_call(var_m38);
                    local_m3C = (uint32_t)call_287;
                    unknown_call(var_m38);
                    unknown_call(var_m2C);
                    local_m14 = local_m3C;
                } else {
                    local_m14 = 0xFFFFFFFD;
                }
            } else {
                local_m14 = 0xFFFFFFFE;
            }
        } else {
            local_m14 = 0xFFFFFFFF;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_shmget_shmat(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    param_shmget_shmat(/* arguments unknown */);
    local_m14 = call_38;
    return;
}
void param_signal_handling(void)
{
    uint32 load_21;
    uint32 load_83;
    uint32 load_183;
    uint32 load_346;
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call(10);
    if ((uint64_t)((uint64_t)call_543 + (uint64_t)1) != 0) {
        unknown_call(14);
        if ((uint64_t)((uint64_t)call_711 + (uint64_t)1) != 0) {
            global_15200 = 0;
            unknown_call(10);
            local_m18 = 0x3E8;
            load_346 = global_15200;
            memory_unknown = 0;
            load_346 = global_15200;
            memory_unknown = 0;
            if (!(load_346 != 0)) {
                load_83 = memory_unknown;
                memory_unknown = load_83 - 1;
                memory_unknown = (int32_t)load_83 > 0 ? 1 : 0;
            }
            if (!(bit_extract(memory_unknown, 0, 1) == 0)) {
                unknown_call(0x3E8);
                goto loc_28EC;
            }
            if (global_15200 != 0) {
                if ((uint32_t)global_15204 == 10) {
                    global_15200 = 0;
                    unknown_call(1);
                    memory_unknown = 0x7D0;
                    load_183 = global_15200;
                    memory_unknown = 0;
                    load_183 = global_15200;
                    memory_unknown = 0;
                    if (!(load_183 != 0)) {
                        load_21 = memory_unknown;
                        memory_unknown = load_21 - 1;
                        memory_unknown = (int32_t)load_21 > 0 ? 1 : 0;
                    }
                    if (!(bit_extract(memory_unknown, 0, 1) == 0)) {
                        unknown_call(0x3E8);
                        goto loc_2990;
                    }
                    if (global_15200 == 0) {
                        memory_unknown = 0xFFFFFFFB;
                    } else {
                        if ((uint32_t)global_15204 == 14) {
                            memory_unknown = 0;
                            unknown_call(10);
                            unknown_call(14);
                            memory_unknown = 42;
                        } else {
                            goto loc_2A00;
                        }
                    }
                } else {
                    memory_unknown = 0xFFFFFFFC;
                }
            } else {
                memory_unknown = 0xFFFFFFFD;
            }
        } else {
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void signal_handler(void)
{
    local_m4 = a1;
    global_15200 = 1;
    global_15204 = local_m4;
    return;
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
    unknown_call("=== 测试系统调用 ===\\n");
    call_linux_syscall(/* arguments unknown */);
    unknown_call("SYS-L3-01: %d (期望: 42)\\n");
    call_win32_api(/* arguments unknown */);
    unknown_call("SYS-L3-02: %d (期望: 42)\\n");
    call_fork_exec(/* arguments unknown */);
    unknown_call("SYS-L3-03: %d (期望: 42)\\n");
    call_pipe_communication(/* arguments unknown */);
    unknown_call("SYS-L3-04: %d (期望: 42)\\n");
    call_socket_create(/* arguments unknown */);
    unknown_call("SYS-L3-05: %d (期望: 42)\\n");
    call_shmget_shmat(/* arguments unknown */);
    unknown_call("SYS-L3-06: %d (期望: 42)\\n");
    call_signal_handling(/* arguments unknown */);
    unknown_call("SYS-L3-07: %d (期望: 42)\\n");
    return;
}
void thread_compute(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    local_m24 = memory_unknown;
    local_m28 = local_m24 * local_m24;
    unknown_call(4);
    local_m30 = call_125;
    memory_unknown = local_m28;
    return;
}
void param_pthread_create(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m24 = local_m18;
    unknown_call(((sp - 64) + 48) - 16);
    local_m34 = call_109;
    if (var_m34 == 0) {
        unknown_call(var_m20);
        local_m38 = memory_unknown;
        unknown_call(var_m30);
        local_m14 = local_m38;
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_pthread_create(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pthread_create(/* arguments unknown */);
    return;
}
void thread_sum(void)
{
    local_m8 = a1;
    local_m10 = local_m8;
    memory_unknown = 0;
    local_m14 = memory_unknown;
    while ((int32_t)var_C <= (int32_t)memory_unknown) {
        memory_unknown = memory_unknown + local_m14;
        local_m14 = local_m14 + 1;
        continue;
    }
    return;
}
void param_pthread_join(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    unknown_call((sp - 96) + 12);
    local_m54 = 1;
    local_m50 = 10;
    local_m48 = 11;
    local_m44 = 20;
    local_m3C = 21;
    local_m38 = 30;
    local_m58 = 0;
    if ((int32_t)memory_unknown >= 3) {
        memory_unknown = 0;
        memory_unknown = 0;
        if ((int32_t)memory_unknown >= 3) {
            memory_unknown = memory_unknown;
        } else {
            unknown_call(((phi(call_665, phi(call_492, call_582))) - 32)[sext(memory_unknown)]);
            if (call_487 == 0) {
                memory_unknown = memory_unknown + memory_unknown;
                memory_unknown = memory_unknown + 1;
                goto loc_2D60;
            } else {
                memory_unknown = 0xFFFFFFFE;
            }
        }
    } else {
        unknown_call(((phi(call_492, call_582)) - 32) + ((sext(memory_unknown)) << 3));
        if (call_517 == 0) {
            memory_unknown = memory_unknown + 1;
            goto loc_2CEC;
        } else {
            memory_unknown = 0xFFFFFFFF;
        }
    }
    return;
}
void call_pthread_join(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_pthread_join(/* arguments unknown */);
    return;
}
void thread_increment(void)
{
    uint64 load_175;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a1->field_0;
    local_m20 = 0;
    while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
        memory_unknown = 0x15208;
        unknown_call(0x15208);
        load_175 = memory_unknown;
        global_15238++;
        unknown_call(load_175);
        unknown_call(0x3E8);
        memory_unknown = memory_unknown + 1;
        continue;
    }
    return;
}
void param_mutex_lock(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call((sext(var_m18)) << 3);
    local_m28 = call_119;
    if (var_m28 != 0) {
        global_15238 = 0;
        local_m2C = 0;
        if ((int32_t)memory_unknown >= (int32_t)memory_unknown) {
            memory_unknown = 0;
            while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
                unknown_call(memory_unknown[sext(memory_unknown)]);
                memory_unknown = memory_unknown + 1;
                continue;
            }
            unknown_call(memory_unknown);
            memory_unknown = memory_unknown * memory_unknown;
            memory_unknown = (uint32_t)global_15238 == (uint32_t)memory_unknown ? 42 : 0xFFFFFFFD;
        } else {
            unknown_call(memory_unknown + ((sext(memory_unknown)) << 3));
            if (call_554 == 0) {
                memory_unknown = memory_unknown + 1;
                goto loc_2ED8;
            } else {
                unknown_call(memory_unknown);
                memory_unknown = 0xFFFFFFFE;
            }
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_mutex_lock(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_mutex_lock(/* arguments unknown */);
    return;
}
void consumer_thread(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call(0x15240);
    while (!(global_15270 != 0)) {
        unknown_call(0x15278);
        continue;
    }
    memory_unknown = global_152A8;
    unknown_call(0x15240);
    unknown_call(4);
    memory_unknown = call_119;
    memory_unknown = memory_unknown;
    return;
}
void producer_thread(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m24 = 1;
    unknown_call(1);
    local_m20 = 0x15240;
    unknown_call(0x15240);
    global_152A8 = 42;
    global_15270 = local_m24;
    unknown_call(0x15278);
    unknown_call(var_m20);
    return;
}
void param_condition_variable(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    global_15270 = 0;
    global_152A8 = 0;
    unknown_call((sp - 64) + 24);
    if (call_357 == 0) {
        unknown_call(((sp - 64) + 48) - 16);
        if (call_348 == 0) {
            unknown_call(var_m28);
            unknown_call(var_m20);
            local_m34 = memory_unknown;
            unknown_call(var_m30);
            local_m14 = local_m34;
        } else {
            unknown_call(var_m28);
            local_m14 = 0xFFFFFFFE;
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_condition_variable(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_condition_variable(/* arguments unknown */);
    return;
}
void thread_atomic_increment(void)
{
    uint32 load_125;
    uint32 load_188;
    uint32 load_220;
    uint64 load_199;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a1->field_0;
    local_m20 = 0;
    while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
        memory_unknown = 1;
        load_220 = memory_unknown;
        memory_unknown = 0x152AC;
        aarch64_ldadd4_acq_rel(/* arguments unknown */);
        load_199 = memory_unknown;
        memory_unknown = call_219;
        memory_unknown = memory_unknown;
        memory_unknown = memory_unknown + 0x3E8;
        memory_unknown = memory_unknown;
        load_188 = memory_unknown;
        memory_unknown = load_188;
        aarch64_cas4_acq_rel(/* arguments unknown */);
        load_125 = memory_unknown;
        memory_unknown = call_329;
        memory_unknown = (uint32_t)call_329 == (uint32_t)load_125 ? 1 : 0;
        if (__arm64_condition_unknown(/* NZCV */)) {
            memory_unknown = memory_unknown;
        }
        memory_unknown = memory_unknown & 1;
        memory_unknown = memory_unknown + 1;
        continue;
    }
    return;
}
void thread_atomic_load_store(void)
{
    local_m8 = a1;
    local_m10 = global_152AC;
    local_mC = local_m10;
    local_m14 = local_mC + 0x64;
    global_152AC = local_m14;
    return;
}
void param_atomic_ops(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call((sext(var_m18)) << 3);
    local_m28 = call_132;
    if (var_m28 != 0) {
        local_m2C = 0;
        global_152AC = local_m2C;
        local_m30 = 0;
        if ((int32_t)memory_unknown >= (int32_t)memory_unknown) {
            unknown_call((phi(call_627, call_541)) + 24);
            if (call_656 == 0) {
                unknown_call(memory_unknown);
            } else {
            }
            memory_unknown = 0;
            while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
                unknown_call(memory_unknown[sext(memory_unknown)]);
                memory_unknown = memory_unknown + 1;
                continue;
            }
            memory_unknown = global_152AC;
            memory_unknown = memory_unknown;
            unknown_call(memory_unknown);
            memory_unknown = (int32_t)memory_unknown > 0 ? 42 : 0xFFFFFFFD;
        } else {
            unknown_call(memory_unknown + ((sext(memory_unknown)) << 3));
            if (call_827 == 0) {
                memory_unknown = memory_unknown + 1;
                goto loc_3330;
            } else {
                unknown_call(memory_unknown);
                memory_unknown = 0xFFFFFFFE;
            }
        }
    } else {
        local_m14 = 0xFFFFFFFF;
    }
    return;
}
void call_atomic_ops(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    param_atomic_ops(/* arguments unknown */);
    return;
}
void thread_tls_test(void)
{
    uint64 load_32;
    uint64 load_156;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    local_m38 = var_99 + 0 + 16;
    local_m24 = memory_unknown;
    memory_unknown = memory_unknown + 50;
    load_32 = var_m20;
    unknown_call((v106 + 0) + 20);
    unknown_call(8);
    load_156 = var_p8;
    local_m30 = call_189;
    memory_unknown = local_m24;
    memory_unknown = memory_unknown;
    return;
}
void param_thread_local_storage(void)
{
    uint64 load_567;
    uint32 load_451;
    uint32 load_735;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    unknown_call((sext(var_m18)) << 3);
    local_m20 = call_149;
    unknown_call((sext(var_m18)) << 3);
    local_m28 = call_176;
    if (var_m20 == 0) {
        local_m14 = 0xFFFFFFFF;
    } else {
        if (var_m28 != 0) {
            local_m2C = 0;
            while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
                memory_unknown = 16;
                unknown_call(16);
                load_567 = memory_unknown;
                memory_unknown[(int64_t)memory_unknown] = call_290;
                unknown_call(memory_unknown[sext(memory_unknown)]);
                memory_unknown = memory_unknown + 1;
                continue;
            }
            memory_unknown = 0;
            if ((int32_t)memory_unknown >= (int32_t)memory_unknown) {
                memory_unknown = 0;
                memory_unknown = 0;
                memory_unknown = 0;
                while ((int32_t)memory_unknown < (int32_t)memory_unknown) {
                    unknown_call(memory_unknown[sext(memory_unknown)]);
                    memory_unknown = memory_unknown;
                    memory_unknown = memory_unknown + memory_unknown;
                    memory_unknown = memory_unknown + memory_unknown;
                    unknown_call(memory_unknown);
                    unknown_call(memory_unknown[sext(memory_unknown)]);
                    memory_unknown = memory_unknown + 1;
                    continue;
                }
                unknown_call(memory_unknown);
                unknown_call(memory_unknown);
                memory_unknown = memory_unknown * 0x64;
                memory_unknown = memory_unknown * 0x96;
                load_451 = memory_unknown;
                load_735 = memory_unknown;
                memory_unknown = 0;
                if ((uint32_t)load_451 == (uint32_t)load_735) {
                    memory_unknown = (uint32_t)memory_unknown == (uint32_t)memory_unknown ? 1 : 0;
                }
                memory_unknown = ((uint32_t)memory_unknown & (uint32_t)1) != 0 ? 42 : 0xFFFFFFFD;
            } else {
                unknown_call(memory_unknown + ((sext(memory_unknown)) << 3));
                if (call_1491 == 0) {
                    memory_unknown = memory_unknown + 1;
                    goto loc_35C8;
                } else {
                    memory_unknown = 0;
                    while ((int32_t)memory_unknown <= (int32_t)memory_unknown) {
                        unknown_call(memory_unknown[sext(memory_unknown)]);
                        memory_unknown = memory_unknown + 1;
                        continue;
                    }
                    unknown_call(memory_unknown);
                    unknown_call(memory_unknown);
                    memory_unknown = 0xFFFFFFFE;
                }
            }
        } else {
            goto loc_354C;
        }
    }
    return;
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
    unknown_call("=== 测试线程与并发 ===\\n");
    call_pthread_create(/* arguments unknown */);
    unknown_call("THR-L3-01: %d (期望: 49)\\n");
    call_pthread_join(/* arguments unknown */);
    unknown_call("THR-L3-02: %d (期望: 465)\\n");
    call_mutex_lock(/* arguments unknown */);
    unknown_call("THR-L3-03: %d (期望: 42)\\n");
    call_condition_variable(/* arguments unknown */);
    unknown_call("THR-L3-04: %d (期望: 42)\\n");
    call_atomic_ops(/* arguments unknown */);
    unknown_call("THR-L3-05: %d (期望: 42)\\n");
    call_thread_local_storage(/* arguments unknown */);
    unknown_call("THR-L3-06: %d (期望: 42)\\n");
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    test_standard_library_functions(/* arguments unknown */);
    test_system_calls(/* arguments unknown */);
    test_thread_concurrency(/* arguments unknown */);
    return;
}
uint32 aarch64_cas4_acq_rel(int64 a1, int64 a2, void * a3)
{
    __asm("cbz w16, #0x3898");
    *(uint32 *)(a3) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a3));
    /* cmp (int32)(x0), (int32)(x16) — 次の分岐のための比較 */
    __asm("b.ne #0x38b0");
    x17 = __atomic_store((uint32 *)(a3), (int32)(a2));
    __asm("cbnz w17, #0x389c");
    return x0;
}
uint32 aarch64_ldadd4_acq_rel(int64 a1, void * a2)
{
    __asm("cbz w16, #0x38d8");
    *(uint32 *)(a2) = (uint32)a1;
    return a1;
    x16 = (uint32)x0;
    x0 = __atomic_load((uint32 *)(a2));
    x15 = __atomic_store((uint32 *)(a2), (int32)((uint32)(x0 + (uint32)x16)));
    __asm("cbnz w15, #0x38dc");
    return x0;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
