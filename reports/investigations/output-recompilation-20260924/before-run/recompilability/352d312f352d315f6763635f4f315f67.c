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
    uint64 load_5;
    uint64 load_19;
    load_5 = var_0;
    load_19 = global_13FD0;
    unknown_call(load_19);
    unknown_call(load_19);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x13FE8;
    __asm("cbz x0, #0x1684");
    return sub_1600(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_19;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x14030 != 0x14030) {
        load_19 = global_13FE0;
        if (!(load_19 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        if (!(global_13FF0 == 0)) {
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
    if (!(global_14030 != 0)) {
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
void Z20test_cpp_member_funcv(void)
{
    uint64 load_42;
    uint64 load_81;
    uint64 load_67;
    loc_1754:
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        unknown_call((sp + 0xFFFFFFFFFFFFFFB0) + 36);
        local_pFFFFFFFFFFFFFFF3 = 0;
        unknown_call((sp + 0xFFFFFFFFFFFFFFB0) + 36);
        load_42 = global_13FC8;
        load_81 = var_48;
        load_67 = memory_unknown;
        if ((uint64_t)load_81 != (uint64_t)load_67) goto loc_17C8;
        goto loc_17B4;
    loc_17B4:
        return;
    loc_17C8:
        unknown_call((sp + 0xFFFFFFFFFFFFFFB0) + 36);
}
void Z20test_cpp_constructorv(void)
{
    uint32 load_35;
    uint32 load_43;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(20);
    memory_unknown = 10;
    memory_unknown = 20;
    memory_unknown = 30;
    memory_unknown = 40;
    load_35 = global_14038;
    global_14038 = load_35 + 1;
    unknown_call(call_217);
    load_43 = global_14038;
    global_14038 = load_43 - 1;
    return;
}
void Z17call_virtual_funcP4Basei(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1);
    return;
}
void Z21test_cpp_virtual_funcv(void)
{
    uint64 load_69;
    uint64 load_185;
    uint64 load_80;
    loc_1854:
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFC0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFE0 = 0x13958;
        local_pFFFFFFFFFFFFFFE8 = 0x13988;
        local_pFFFFFFFFFFFFFFF0 = 3;
        Z17call_virtual_funcP4Basei(/* arguments unknown */);
        Z17call_virtual_funcP4Basei(/* arguments unknown */);
        load_69 = global_13FC8;
        load_185 = var_38;
        load_80 = memory_unknown;
        if ((uint64_t)load_185 != (uint64_t)load_80) goto loc_18E0;
        goto loc_18D4;
    loc_18D4:
        return;
    loc_18E0:
        unknown_call((call_197 + 21) + call_292);
}
void Z29test_cpp_multiple_inheritancev(void)
{
    return;
}
void Z28test_cpp_diamond_inheritancev(void)
{
    uint64 load_134;
    uint64 load_4;
    uint64 load_135;
    loc_18EC:
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFA0 = local_x29;
        local_pFFFFFFFFFFFFFFB0 = local_x19;
        local_pFFFFFFFFFFFFFFB0 = local_x19;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        local_pFFFFFFFFFFFFFFC8 = 0x13AC8;
        local_pFFFFFFFFFFFFFFE8 = 0x13B30;
        local_pFFFFFFFFFFFFFFD8 = 0x13AF8;
        local_pFFFFFFFFFFFFFFF0 = 50;
        ZTv0_n24_N14DiamondDerived4funcEv(/* arguments unknown */);
        local_pFFFFFFFFFFFFFFF0 = 0x64;
        ZTv0_n24_N14DiamondDerived4funcEv(/* arguments unknown */);
        load_134 = global_13FC8;
        load_4 = var_58;
        load_135 = memory_unknown;
        if ((uint64_t)load_4 != (uint64_t)load_135) goto loc_1984;
        goto loc_1978;
    loc_1978:
        return;
    loc_1984:
        unknown_call(call_283 + call_222);
}
void Z26test_cpp_operator_overloadv(void)
{
    return;
}
void Z22test_cpp_template_funcv(void)
{
    uint32 load_65;
    uint32 load_155;
    uint64 load_84;
    uint64 load_101;
    uint64 load_136;
    loc_1990:
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFD0 = local_x29;
        local_pFFFFFFFFFFFFFFE0 = local_x19;
        local_pFFFFFFFFFFFFFFE8 = var_299;
        local_pFFFFFFFFFFFFFFF8 = memory_unknown;
        Z12template_maxIiET_S0_S0_(/* arguments unknown */);
        Z12template_maxIdET_S0_S0_(/* arguments unknown */);
        local_pFFFFFFFFFFFFFFF0 = 10;
        local_pFFFFFFFFFFFFFFF4 = 20;
        Z13template_swapIiEvRT_S1_(/* arguments unknown */);
        __asm("fcvtzs w0, d8");
        load_65 = var_FFFFFFFFFFFFFFF0;
        load_155 = var_FFFFFFFFFFFFFFF4;
        load_84 = global_13FC8;
        load_101 = var_28;
        load_136 = memory_unknown;
        if ((uint64_t)load_101 != (uint64_t)load_136) goto loc_1A34;
        goto loc_1A24;
    loc_1A24:
        return;
    loc_1A34:
        unknown_call(((v182 + call_246) + load_65) + load_155);
}
void Z23test_cpp_template_classv(void)
{
    return;
}
void Z15test_cpp_lambdav(void)
{
    return;
}
uint32 test_cpp_exception(void)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0_1 = sub_14E0(4);
    *(uint32 *)(x0_1) = 42;
    x0_2 = sub_15D0(x0_1, *(uint64 *)0x13FC0, 0);
    /* cmp x1, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1a90");
    x21 = 0;
    loc_1A84:
    /* cmp x1, 1 — 次の分岐のための比較 */
    __asm("b.eq #0x1ab4");
    x0_3 = sub_15E0();
    x0_4 = sub_14D0();
    x21 = *(uint32 *)(x0_4);
    x0_5 = sub_1580(x0_4);
    x20 = x1;
    x0_6 = sub_15B0(x0_5);
    x1 = x1;
    __asm("b #0x1a84");
    goto loc_1A84;
    x0_7 = sub_14D0();
    x19 = (uint32)((uint32)x21 + (uint32)*(uint32 *)(x0_7) * 2);
    x0_8 = sub_15B0(x0_7);
    x0_9 = sub_14E0(1);
    x0_10 = sub_15D0(x0_9, 0x13C98, 0);
    /* cmp x1, 2 — 次の分岐のための比較 */
    __asm("b.eq #0x1af0");
    /* cmp x1, 3 — 次の分岐のための比較 */
    __asm("b.eq #0x1b10");
    x0_11 = sub_15E0(x0_10);
    x0_12 = sub_14D0();
    x19 = (uint32)(x19 + 100);
    x0_13 = sub_15B0(x0_12);
    loc_1AFC:
    return (uint32)x19;
    x0_14 = sub_14D0();
    x19 = (uint32)((uint32)x19 + 200);
    x0_15 = sub_15B0(x0_14);
    __asm("b #0x1afc");
    goto loc_1AFC;
}
void Z18test_cpp_smart_ptrv(void)
{
    return;
}
void Z13test_cpp_rttiv(void)
{
    uint64 load_181;
    uint64 load_487;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFC0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x19;
    local_pFFFFFFFFFFFFFFD0 = local_x19;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFE0 = local_x21;
    local_pFFFFFFFFFFFFFFF0 = local_x23;
    unknown_call(8);
    memory_unknown = 0x13B58;
    unknown_call(8);
    memory_unknown = 0x13B80;
    load_181 = memory_unknown;
    if ((uint64_t)load_181 != 0x2360) {
        if ((uint32_t)memory_unknown != 42) {
            unknown_call(load_181);
        }
    }
    load_487 = memory_unknown;
    if ((uint64_t)load_487 == 0x2370) {
    } else {
        if ((uint32_t)memory_unknown != 42) {
            unknown_call(load_487);
            if (!(call_751 != 0)) {
                goto loc_1BF0;
            }
        }
    }
    unknown_call(phi(phi(call_822, phi(call_652, call_753)), call_822, phi(call_652, call_753)));
    unknown_call(phi(phi(call_545, phi(call_679, call_672)), call_545, phi(call_679, call_672)));
    unknown_call(((uint32_t)memory_unknown == 42 ? (phi(phi(call_761, phi(call_568, load_181)), call_761, phi(call_568, load_181))) + 1 : phi(phi(call_761, phi(call_568, load_181)), call_761, phi(call_568, load_181))));
    unknown_call(phi(phi(call_822, phi(call_652, call_753)), call_822, phi(call_652, call_753)));
    unknown_call(phi(phi(call_545, phi(call_679, call_672)), call_545, phi(call_679, call_672)));
    return;
}
void Z20test_cpp_oo_featuresv(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x2148);
    Z20test_cpp_member_funcv(/* arguments unknown */);
    unknown_call(1);
    Z20test_cpp_constructorv(/* arguments unknown */);
    unknown_call(1);
    Z21test_cpp_virtual_funcv(/* arguments unknown */);
    unknown_call(1);
    Z29test_cpp_multiple_inheritancev(/* arguments unknown */);
    unknown_call(1);
    Z28test_cpp_diamond_inheritancev(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    Z22test_cpp_template_funcv(/* arguments unknown */);
    unknown_call(1);
    unknown_call(1);
    unknown_call(1);
    Z18test_cpp_exceptionv(/* arguments unknown */);
    unknown_call(1);
    Z18test_cpp_smart_ptrv(/* arguments unknown */);
    unknown_call(1);
    Z13test_cpp_rttiv(/* arguments unknown */);
    unknown_call(1);
    return;
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    Z20test_cpp_oo_featuresv(/* arguments unknown */);
    return;
}
void GLOBAL__sub_I__Z20test_cpp_member_funcv(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(0x14040);
    unknown_call(global_13FF8);
    return;
}
void ZN4Base12virtual_funcEi(void)
{
    return;
}
void ZNK4Base7getNameEv(void)
{
    return;
}
void ZN4BaseD1Ev(void)
{
    return;
}
void ZN7Derived12virtual_funcEi(void)
{
    return;
}
void ZNK7Derived7getNameEv(void)
{
    return;
}
void ZN12MultiDerived5funcAEv(void)
{
    return;
}
void ZN12MultiDerived5funcBEv(void)
{
    return;
}
void ZThn16_N12MultiDerived5funcBEv(void)
{
    return;
}
void ZN7MiddleA4funcEv(void)
{
    return;
}
void ZTv0_n24_N7MiddleA4funcEv(void)
{
    return;
}
void ZN7MiddleB4funcEv(void)
{
    return;
}
void ZTv0_n24_N7MiddleB4funcEv(void)
{
    return;
}
void ZN14DiamondDerived4funcEv(void)
{
    return;
}
void ZTv0_n24_N14DiamondDerived4funcEv(void)
{
    return;
}
void ZThn16_N14DiamondDerived4funcEv(void)
{
    return;
}
void ZNK12RTTIDerivedA7getTypeEv(void)
{
    return;
}
void ZNK12RTTIDerivedB7getTypeEv(void)
{
    return;
}
void ZN12RTTIDerivedBD1Ev(void)
{
    return;
}
void ZN12RTTIDerivedAD1Ev(void)
{
    return;
}
void ZN14DiamondDerivedD1Ev(void)
{
    return;
}
void ZThn16_N14DiamondDerivedD1Ev(void)
{
    return;
}
void ZTv0_n32_N14DiamondDerivedD1Ev(void)
{
    return;
}
void ZN12MultiDerivedD1Ev(void)
{
    return;
}
void ZThn16_N12MultiDerivedD1Ev(void)
{
    return;
}
void ZN7DerivedD1Ev(void)
{
    return;
}
void ZN4BaseD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(8);
    return;
}
void ZN7DerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(16);
    return;
}
void ZN12MultiDerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(32);
    return;
}
void ZThn16_N12MultiDerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1 - 16);
    return;
}
void ZN12RTTIDerivedAD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(8);
    return;
}
void ZN12RTTIDerivedBD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(8);
    return;
}
void ZN14DiamondDerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(48);
    return;
}
void ZTv0_n32_N14DiamondDerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1 + memory_unknown);
    return;
}
void ZThn16_N14DiamondDerivedD0Ev(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(a1 - 16);
    return;
}
void Z12template_maxIiET_S0_S0_(void)
{
    return;
}
void Z12template_maxIdET_S0_S0_(void)
{
    __asm("fcmpe d0, d1");
    return;
}
void Z13template_swapIiEvRT_S1_(void)
{
    uint32 load_22;
    load_22 = a1->field_0;
    a1->field_0 = a2->field_0;
    a2->field_0 = load_22;
    return;
}
void ZN9ContainerIiEC1Ev(void)
{
    a1->field_28 = 0;
    return;
}
void ZN9ContainerIiE4pushEi(void)
{
    uint32 load_35;
    load_35 = a1->field_28;
    if ((int32_t)load_35 <= 9) {
        a1->field_28 = load_35 + 1;
        a1[a3] = a2;
    }
    return;
}
uint32 Container::get(void * a1, int64 a2)
{
    x2 = a1;
    __asm("tbnz w1, #0x1f, #0x20b4");
    /* cmp (int32)((uint32)*(uint32 *)(a1 + 40)), (int32)(a2) — 次の分岐のための比較 */
    __asm("b.gt #0x20b8");
    loc_20B4:
    return x0;
    __asm("b #0x20b4");
    goto loc_20B4;
}
void ZNK9ContainerIiE7getSizeEv(void)
{
    return;
}
void ZN9ContainerIdEC1Ev(void)
{
    a1->field_50 = 0;
    return;
}
void ZN9ContainerIdE4pushEd(void)
{
    uint32 load_32;
    load_32 = a1->field_50;
    if ((int32_t)load_32 <= 9) {
        a1->field_50 = load_32 + 1;
        a1[a2] = var_49;
    }
    return;
}
void Container::get(void * a1, int64 a2)
{
    d0 = 0; /* vector zero */
    __asm("tbnz w1, #0x1f, #0x2100");
    /* cmp (int32)((uint32)*(uint32 *)(a1 + 80)), (int32)(a2) — 次の分岐のための比較 */
    __asm("b.gt #0x2104");
    loc_2100:
    return;
    __asm("b #0x2100");
    goto loc_2100;
}
void ZNK9ContainerIdE7getSizeEv(void)
{
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
