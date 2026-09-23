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
void GLOBAL__sub_I_5_1_cpp(void)
{
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x19;
    unknown_call(0x120CC);
}
void start(void)
{
    uint64 load_28;
    uint64 load_17;
    load_28 = var_0;
    load_17 = global_11FB8;
    unknown_call(load_17);
    unknown_call(load_17);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x11FD0;
    __asm("cbz x0, #0xf44");
    return sub_E90(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_48;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x120C8 != 0x120C8) {
        load_48 = global_11FC8;
        if (!(load_48 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_20;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_20 = global_11FD8;
        if (!(load_20 == 0)) {
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
    if (!(global_120C8 != 0)) {
        if (!(global_11FC0 == 0)) {
            unknown_call(global_120A0);
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
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m15 = 0;
    local_m38 = 10;
    local_m34 = global_174C;
    local_m25 = global_175B;
    unknown_call(((sp - 64) + 8) | 4);
    return;
}
void Z20test_cpp_constructorv(void)
{
    return;
}
void call_virtual_func(void * a1)
{
    __asm("br x2");
}
void Z21test_cpp_virtual_funcv(void)
{
    return;
}
void Z29test_cpp_multiple_inheritancev(void)
{
    return;
}
void Z28test_cpp_diamond_inheritancev(void)
{
    return;
}
void Z26test_cpp_operator_overloadv(void)
{
    return;
}
void Z22test_cpp_template_funcv(void)
{
    return;
}
void Z23test_cpp_template_classv(void)
{
    return;
}
void Z15test_cpp_lambdav(void)
{
    return;
}
uint64 test_cpp_exception(int64 a1, int64 a2)
{
    // … ほかに 3 個の置き場（退避用など）があります

    x0_1 = sub_DB0(4);
    *(uint32 *)(x0_1) = 42;
    x0 = sub_E70(x0_1, *(uint64 *)0x11FB0, 0);
    __asm("b #0x1160");
    /* cmp (int32)(x1), 1 — 次の分岐のための比較 */
    __asm("b.ne #0x1114");
    x0_2 = sub_DA0(x0, x1);
    x21 = *(uint32 *)(x0_2);
    x0 = sub_E20(x0_2);
    __asm("b #0x1160");
    x21 = 0;
    __asm("b #0x112c");
    x20 = x1;
    x19 = x0;
    x0 = sub_E50(x0, x1);
    x1 = (uint32)x1;
    /* cmp (int32)(x1), (int32)(1) — 次の分岐のための比較 */
    __asm("b.ne #0x11a8");
    x0_3 = sub_DA0(x19, x1);
    x20 = *(uint32 *)(x0_3);
    x0_4 = sub_E50(x0_3);
    x0_5 = sub_DB0(1);
    x0 = sub_E70(x0_5, 0x11CF0, 0);
    x19 = x0;
    /* cmp (int32)(x1), 3 — 次の分岐のための比較 */
    __asm("b.ne #0x1174");
    x22 = 100;
    __asm("b #0x1180");
    /* cmp (int32)(x1), 2 — 次の分岐のための比較 */
    __asm("b.ne #0x11a8");
    x22 = 200;
    x0 = x0;
    x0_6 = sub_DA0(x0);
    x0_7 = sub_E50(x0_6);
    return (uint32)((uint32)((uint32)x21 + (uint32)x20 * 2) + (uint32)x22);
    x0 = sub_E80(x19);
}
void Z18test_cpp_smart_ptrv(void)
{
    return;
}
void Z13test_cpp_rttiv(void)
{
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFD0 = local_x29;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFE0 = local_x22;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    local_pFFFFFFFFFFFFFFF0 = local_x20;
    unknown_call(8);
    memory_unknown = 0x11D58;
    unknown_call(8);
    memory_unknown = 0x11D80;
    unknown_call(call_358);
    unknown_call(call_271);
    unknown_call(call_358);
    unknown_call(call_271);
    return;
}
void Z20test_cpp_oo_featuresv(void)
{
    uint64 load_114;
    uint64 load_451;
    local_m30 = local_x29;
    local_m30 = local_x29;
    local_m20 = local_x22;
    local_m20 = local_x22;
    local_m10 = local_x20;
    local_m10 = local_x20;
    unknown_call("=== 测试C++面向对象特性 ===");
    local_m35 = 0;
    local_m58 = 10;
    load_114 = global_174C;
    load_451 = global_175B;
    local_m54 = load_114;
    local_m45 = load_451;
    unknown_call(((sp - 96) + 8) | 4);
    unknown_call("CPP-L3-01: %d (期望: 4704)\\n");
    unknown_call("CPP-L3-02: %d (期望: 21)\\n");
    unknown_call("CPP-L3-03: %d (期望: 42)\\n");
    unknown_call("CPP-L3-04: %d (期望: 71)\\n");
    unknown_call("CPP-L3-05: %d (期望: 650)\\n");
    unknown_call("CPP-L3-06: %d (期望: 22)\\n");
    unknown_call("CPP-L3-07: %d (期望: 39)\\n");
    unknown_call("CPP-L3-08: %d (期望: 16)\\n");
    unknown_call("CPP-L3-09: %d (期望: 85)\\n");
    Z18test_cpp_exceptionv(/* arguments unknown */);
    unknown_call("CPP-L4-01: %d (期望: 226)\\n");
    unknown_call("CPP-L4-02: %d (期望: 703)\\n");
    unknown_call(8);
    memory_unknown = 0x11D58;
    unknown_call(8);
    memory_unknown = 0x11D80;
    unknown_call(call_1012);
    unknown_call(call_1078);
    unknown_call(call_1012);
    unknown_call(call_1078);
}
void main(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    Z20test_cpp_oo_featuresv(/* arguments unknown */);
    return;
}
void Z12template_maxIiET_S0_S0_(void)
{
    return;
}
void Z12template_maxIdET_S0_S0_(void)
{
    __asm("fcmp d0, d1");
    return;
}
void Z13template_swapIiEvRT_S1_(void)
{
    uint32 load_15;
    load_15 = a1->field_0;
    a1->field_0 = a2->field_0;
    a2->field_0 = load_15;
    return;
}
void ZN9ContainerIiEC1Ev(void)
{
    a1->field_28 = 0;
    return;
}
void ZN9ContainerIiE4pushEi(void)
{
    uint32 load_34;
    load_34 = a1->field_28;
    if ((int32_t)sext(load_34) <= 9) {
        a1->field_28 = load_34 + 1;
        a1[(int64_t)load_34] = a2;
    }
    return;
}
void ZNK9ContainerIiE3getEi(void)
{
    if (__arm64_condition_unknown(/* NZCV */)) {
        if ((int32_t)a1->field_28 > (int32_t)a2) {
        }
    }
    return;
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
    uint32 load_42;
    load_42 = a1->field_50;
    if ((int32_t)sext(load_42) <= 9) {
        a1[(int64_t)load_42] = var_42;
        a1->field_50 = load_42 + 1;
    }
    return;
}
void Container::get(void * a1, int64 a2)
{
    d0 = 0; /* vector zero */
    __asm("tbnz w1, #0x1f, #0x1518");
    /* cmp (int32)((uint32)*(uint32 *)(a1 + 80)), (int32)(a2) — 次の分岐のための比較 */
    __asm("b.le #0x1518");
    return;
}
void ZNK9ContainerIdE7getSizeEv(void)
{
    return;
}
void ZN12RTTIDerivedAD0Ev(void)
{
}
void ZNK12RTTIDerivedA7getTypeEv(void)
{
    return;
}
void ZN8RTTIBaseD2Ev(void)
{
    return;
}
void ZN12RTTIDerivedBD0Ev(void)
{
}
void ZNK12RTTIDerivedB7getTypeEv(void)
{
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
