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
void cxx_global_var_init(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0x180F4;
    unknown_call(0x180F4);
    unknown_call(global_17FE0);
    return;
}
void GLOBAL__sub_I_5_1_cpp(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    cxx_global_var_init(/* arguments unknown */);
    return;
}
void start(void)
{
    uint64 load_32;
    uint64 load_1;
    load_32 = var_0;
    load_1 = global_17FB8;
    unknown_call(load_1);
    unknown_call(load_1);
}
uint64 call_weak_fn(void)
{
    x0_1 = *(uint64 *)0x17FD0;
    __asm("cbz x0, #0x1c04");
    return sub_1B20(x0_1);
    return x0;
}
void deregister_tm_clones(void)
{
    uint64 load_21;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (0x180F0 != 0x180F0) {
        load_21 = global_17FC8;
        if (!(load_21 == 0)) {
            __asm("br x16");
        }
    }
    return;
}
void register_tm_clones(void)
{
    uint64 load_60;
    __asm("semantic-v2 function unknown: unresolved-indirect-control-flow");
    if (!(0 == 0)) {
        load_60 = global_17FD8;
        if (!(load_60 == 0)) {
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
    if (!(global_180F0 != 0)) {
        if (!(global_17FC0 == 0)) {
            unknown_call(global_180C8);
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
    local_m48 = var_220 - 80 + 28;
    ZN11SimpleClassC2EiPKc(/* arguments unknown */);
    ZN11SimpleClass8setValueEi(/* arguments unknown */);
    ZNK11SimpleClass8getValueEv(/* arguments unknown */);
    local_m38 = (uint32_t)call_106;
    ZNK11SimpleClass7computeEi(/* arguments unknown */);
    local_m3C = call_140;
    ZN11SimpleClass10getClassIDEv(/* arguments unknown */);
    local_m40 = call_155;
    return;
}
uint64 test_cpp_constructor(int64 a1, int64 a2)
{
    uint32 var_3C, var_C, var_18, var_1C;
    uint64 var_10, var_20;

    var_3C = 0;
    x0_1 = &var_28;
    var_10 = &var_28;
    x0_2 = LifecycleClass::LifecycleClass(&var_28, 5);
    x0_3 = LifecycleClass::getData(var_10, 2);
    var_18 = (uint32)x0_3;
    __asm("b #0x1d80");
    var_3C = (uint32)((uint32)var_3C + (uint32)var_18);
    var_C = (uint32)LifecycleClass::getInstanceCount();
    __asm("b #0x1d9c");
    var_3C = (uint32)((uint32)var_3C + (uint32)var_C);
    x0_5 = LifecycleClass::~LifecycleClass(&var_28);
    x8 = (uint32)((uint32)var_3C + (uint32)((uint32)LifecycleClass::getInstanceCount(x0_5) * 1000));
    var_3C = x8;
    x8 = var_3C;
    return x8;
    var_20 = x8;
    var_1C = (uint32)x1;
    x0_7 = LifecycleClass::~LifecycleClass(x29 - 24, x1);
    __asm("b #0x1df4");
    x0_8 = sub_1B10(var_20);
}
void Z17call_virtual_funcP4Basei(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    unknown_call(var_8);
    return;
}
uint64 test_cpp_virtual_func(int64 a1, int64 a2)
{
    uint32 var_34, var_38, var_3C, var_4, var_8, var_C, var_10, var_14;
    uint32 var_18, var_1C;
    uint64 var_40, var_20, var_28;

    x0_1 = Base::Base(&var_58);
    x0_2 = Derived::Derived(&var_48, 3);
    __asm("b #0x1e54");
    x0_3 = Base::virtual_func(&var_58, 5);
    var_14 = (uint32)x0_3;
    __asm("b #0x1e68");
    var_38 = (uint32)var_14;
    x0_4 = Derived::virtual_func(&var_48, 5);
    var_10 = (uint32)x0_4;
    __asm("b #0x1e84");
    var_34 = (uint32)var_10;
    x8_1 = &var_58;
    var_28 = &var_58;
    var_20 = &var_48;
    x0_5 = call_virtual_func(&var_58, 5);
    var_C = (uint32)x0_5;
    __asm("b #0x1eb0");
    var_1C = (uint32)var_C;
    x0_6 = call_virtual_func(var_20, 5);
    var_8 = (uint32)x0_6;
    __asm("b #0x1ecc");
    x8_2 = var_8;
    var_18 = x8_2;
    x8_2 = var_18;
    var_4 = (uint32)((uint32)((uint32)((uint32)var_38 + (uint32)var_34) + (uint32)var_1C) + x8_2);
    x0_7 = Derived::~Derived(&var_48);
    x0_8 = Base::~Base(&var_58);
    x0_9 = var_4;
    return x0_9;
    var_40 = x0_9;
    var_3C = (uint32)x1;
    __asm("b #0x1f3c");
    var_40 = x0_9;
    var_3C = (uint32)x1;
    x0_10 = Derived::~Derived(x29 - 24, x1);
    __asm("b #0x1f3c");
    x0_11 = Base::~Base(x29 - 8);
    __asm("b #0x1f48");
    x0_12 = sub_1B10(var_40);
}
uint64 test_cpp_multiple_inheritance(int64 a1, int64 a2)
{
    uint32 var_3C, var_58, var_68, var_4, var_8, var_C, var_24, var_28;
    uint32 var_2C;
    uint64 var_40, var_48, var_10, var_18, var_30;

    x0_1 = &var_50;
    var_10 = &var_50;
    x0_2 = MultiDerived::MultiDerived(&var_50);
    var_58 = 100;
    var_68 = 200;
    var_48 = var_10;
    x9 = 0;
    var_18 = x9;
    __asm("cbz x8, #0x1fa4");
    __asm("b #0x1f94");
    var_18 = &var_60;
    __asm("b #0x1fa4");
    var_40 = var_18;
    x0_3 = (**(uint64 *)(*(uint64 *)(var_48)))(var_48);
    var_C = (uint32)x0_3;
    __asm("b #0x1fc4");
    var_3C = (uint32)var_C;
    x0_4 = (**(uint64 *)(*(uint64 *)(var_40)))(var_40);
    var_8 = (uint32)x0_4;
    __asm("b #0x1fe4");
    x8_1 = var_8;
    var_28 = x8_1;
    x8_2 = (uint32)(var_48 != var_40 ? 1 : x9);
    var_24 = x8_2;
    x8_2 = var_24;
    var_4 = (uint32)((uint32)((uint32)var_3C + x8_1) + x8_2);
    x0_5 = MultiDerived::~MultiDerived(&var_50);
    x0_6 = var_4;
    return x0_6;
    var_30 = x0_6;
    var_2C = (uint32)x1;
    x0_7 = MultiDerived::~MultiDerived(x29 - 32, x1);
    __asm("b #0x2048");
    x0_8 = sub_1B10(var_30);
}
uint64 test_cpp_diamond_inheritance(int64 a1, int64 a2)
{
    uint64 var_40, var_10, var_18, var_28, var_38;
    uint32 var_4, var_8, var_C, var_20, var_24, var_34;

    x0_1 = &var_40;
    var_10 = &var_40;
    x0_2 = DiamondDerived::DiamondDerived(&var_40);
    *(uint32 *)(var_10 + *(uint64 *)(var_40 + -24) + 8) = 50;
    var_18 = 0;
    __asm("cbz x8, #0x20ac");
    __asm("b #0x2094");
    var_18 = &var_40 + *(uint64 *)(var_40 + -24);
    __asm("b #0x20ac");
    x8_1 = var_18;
    var_38 = x8_1;
    x8_1 = var_18;
    var_C = (uint32)(**(uint64 *)(*(uint64 *)(x8_1)))(x8_1);
    __asm("b #0x20cc");
    var_34 = (uint32)var_C;
    *(uint32 *)(&var_40 + *(uint64 *)(var_40 + -24) + 8) = 100;
    x0_4 = (**(uint64 *)(*(uint64 *)(var_38)))(var_38);
    var_8 = (uint32)x0_4;
    __asm("b #0x2104");
    x8_2 = var_8;
    var_20 = x8_2;
    x8_2 = var_20;
    var_4 = (uint32)((uint32)var_34 + x8_2);
    x0_5 = DiamondDerived::~DiamondDerived(&var_40);
    x0_6 = var_4;
    return x0_6;
    var_28 = x0_6;
    var_24 = (uint32)x1;
    x0_7 = DiamondDerived::~DiamondDerived(x29 - 48, x1);
    __asm("b #0x214c");
    x0_8 = sub_1B10(var_28);
}
void Z26test_cpp_operator_overloadv(void)
{
    uint64 load_235;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m48 = var_274 - 80 + 64 - 8;
    local_m3C = 1;
    ZN5PointC2Eii(/* arguments unknown */);
    local_m50 = var_274 - 80 + 64 - 16;
    ZN5PointC2Eii(/* arguments unknown */);
    ZNK5PointplERKS_(/* arguments unknown */);
    load_235 = var_m50;
    local_m38 = var_274 - 80 + 64 - 24;
    local_m28 = call_131;
    ZNK5PointeqERKS_(/* arguments unknown */);
    local_m29 = (uint32_t)call_182 & local_m3C;
    ZN5PointppEv(/* arguments unknown */);
    return;
}
uint32 test_cpp_template_func(void)
{
    uint32 var_1C, var_8, var_C;
    double var_10;

    x0_1 = Z12template_maxIiET_S0_S0_(3, 7);
    var_1C = (uint32)x0_1;
    x0_2 = Z12template_maxIdET_S0_S0_(x0_1);
    var_10 = v0;
    var_C = 10;
    var_8 = 20;
    x0_3 = Z13template_swapIiEvRT_S1_(&var_C, &var_8);
    x9 = (int64)var_10;
    return (uint32)((uint32)((uint32)((uint32)var_1C + (uint32)x9) + (uint32)var_C) + (uint32)var_8);
}
uint32 test_cpp_template_class(void)
{
    uint32 var_7C, var_80, var_14;
    uint64 var_8;
    double var_18;

    x0_1 = &var_84;
    var_0 = &var_84;
    x0_2 = (*0x3610)(&var_84);
    x0_3 = Container::push(*(uint64 *)(sp), 10);
    x0_4 = Container::push(*(uint64 *)(sp), 20);
    x0_5 = Container::push(*(uint64 *)(sp), 30);
    var_14 = 0;
    x0_6 = Container::get(*(uint64 *)(sp), 0);
    var_80 = (uint32)x0_6;
    x0_7 = Container::getSize(*(uint64 *)(sp));
    var_7C = (uint32)x0_7;
    x0_8 = &var_20;
    var_8 = &var_20;
    x0_9 = (*0x36EC)(&var_20);
    x0_10 = Container::push(var_8);
    x0_11 = Container::get(var_8, (uint32)var_14);
    var_18 = v0;
    v0 = var_18;
    x9 = (int64)v0;
    return (uint32)((uint32)((uint32)var_80 + (uint32)var_7C) + (uint32)x9);
}
void Z15test_cpp_lambdav(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m3C = 10;
    local_m14 = 10;
    local_m38 = 20;
    local_m18 = 20;
    local_m28 = local_m14;
    local_m20 = var_193 - 64 + 48 - 8;
    ZZ15test_cpp_lambdavENK3$_1clEi(/* arguments unknown */);
    local_m30 = call_131;
    ZZ15test_cpp_lambdavENK3$_0clIiiEEDaT_T0_(/* arguments unknown */);
    local_m34 = call_173;
    return;
}
void ZZ15test_cpp_lambdavENK3$_1clEi(void)
{
    uint64 load_45;
    local_m8 = a1;
    local_mC = a2;
    load_45 = var_8;
    memory_unknown = memory_unknown + 5;
    return;
}
void ZZ15test_cpp_lambdavENK3$_0clIiiEEDaT_T0_(void)
{
    local_m8 = a1;
    local_mC = a2;
    local_m10 = a3;
    return;
}
uint64 test_cpp_exception(void)
{
    uint32 var_24, var_28, var_2C, var_3C, var_C;
    uint64 var_30, var_10, var_18;

    var_3C = 0;
    x0_1 = sub_1A00(4);
    *(uint32 *)(x0_1) = 42;
    x0_2 = sub_1B00(x0_1, *(uint64 *)0x17FB0, 0);
    return test_cpp_smart_ptr(x0_2);
    var_30 = x0_3;
    var_2C = (uint32)x1;
    __asm("b #0x2448");
    __asm("b.ne #0x2494");
    __asm("b #0x2458");
    x0_4 = sub_19F0(var_30);
    x8_1 = *(uint32 *)(x0_4);
    var_28 = x8_1;
    x8_1 = var_28;
    var_3C = (uint32)((uint32)var_3C + x8_1);
    x0_5 = sub_1AB0(x0_4);
    return test_cpp_smart_ptr(x0_5);
    var_30 = x0_6;
    var_2C = (uint32)x1;
    x0_7 = sub_1AE0(x0_6);
    __asm("b #0x2494");
    __asm("b.ne #0x256c");
    __asm("b #0x24a4");
    x0_8 = sub_19F0(var_30);
    x8_2 = *(uint32 *)(x0_8);
    var_24 = x8_2;
    x8_2 = var_24;
    var_3C = (uint32)((uint32)var_3C + x8_2 * 2);
    x0_9 = sub_1AE0(x0_8);
    __asm("b #0x24cc");
    x0_10 = sub_1A00(1);
    x0_11 = sub_1B00(x0_10, 0x177F0, 0);
    return test_cpp_smart_ptr(x0_11);
    var_30 = x0_12;
    var_2C = (uint32)x1;
    __asm("b #0x24f8");
    var_C = (uint32)var_2C;
    __asm("b.ne #0x253c");
    __asm("b #0x250c");
    x0_13 = sub_19F0(var_30);
    var_10 = x0_13;
    var_3C = (uint32)((uint32)var_3C + 100);
    x0_14 = sub_1AE0(x0_13);
    __asm("b #0x252c");
    return (uint32)var_3C;
    __asm("b.ne #0x256c");
    __asm("b #0x254c");
    x0_15 = sub_19F0(var_30);
    var_18 = x0_15;
    var_3C = (uint32)((uint32)var_3C + 200);
    x0_16 = sub_1AE0(x0_15);
    __asm("b #0x252c");
    x0_17 = sub_1B10(var_30);
}
uint64 test_cpp_smart_ptr(int64 a1, int64 a2)
{
    uint32 var_5C, var_6C, var_7C, var_8C, var_4;
    uint64 var_90, var_8, var_10, var_18, var_20, var_28, var_30, var_38;
    uint64 var_40, var_48, var_50;

    x0_1 = sub_1A40(4);
    *(uint32 *)(x0_1) = 100;
    x0_2 = &var_98;
    var_48 = &var_98;
    x0_3 = ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi(&var_98, x0_1);
    x0_4 = std::unique_ptr::operator*(var_48);
    var_50 = x0_4;
    __asm("b #0x25b0");
    *(uint32 *)(var_50) = 200;
    x0_5 = ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_(&var_98);
    x0_6 = &var_80;
    var_38 = &var_80;
    x0_7 = ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_(&var_80, x0_5);
    x0_8 = std::unique_ptr::operator*(var_38);
    var_40 = x0_8;
    __asm("b #0x25e4");
    var_7C = (uint32)*(uint32 *)(var_40);
    var_30 = sub_19C0(20);
    __asm("b #0x2600");
    x1_1 = var_30;
    *(uint32 *)(x1_1) = 1;
    *(uint32 *)(x1_1 + 4) = 2;
    *(uint32 *)(x1_1 + 8) = 3;
    *(uint32 *)(x1_1 + 0xC) = 4;
    *(uint32 *)(x1_1 + 0x10) = 5;
    x0_10 = &var_70;
    var_20 = &var_70;
    x0_11 = ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_(&var_70, x1_1);
    x0_12 = ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm(var_20, 2);
    var_28 = x0_12;
    __asm("b #0x264c");
    var_6C = (uint32)*(uint32 *)(var_28);
    var_18 = sub_1A40(4);
    __asm("b #0x2668");
    *(uint32 *)(var_18) = 500;
    x0_14 = &var_60;
    var_8 = &var_60;
    x0_15 = ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EC2IS0_vEEPiRKS0_(&var_60, var_18, &var_6B);
    x0_16 = ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EdeEv(var_8);
    var_10 = x0_16;
    __asm("b #0x2694");
    x8 = *(uint32 *)(var_10);
    var_5C = x8;
    x8 = var_5C;
    var_4 = (uint32)((uint32)((uint32)var_7C + (uint32)var_6C) + x8);
    x0_17 = ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2ED2Ev(&var_60);
    x0_18 = ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev(&var_70);
    x0_19 = std::unique_ptr::~(&var_80);
    x0_20 = std::unique_ptr::~(&var_98);
    x0_21 = var_4;
    return x0_21;
    var_90 = x0_21;
    var_8C = (uint32)x1;
    __asm("b #0x2748");
    var_90 = x0_21;
    var_8C = (uint32)x1;
    __asm("b #0x273c");
    var_90 = x0_21;
    var_8C = (uint32)x1;
    __asm("b #0x2730");
    var_90 = x0_21;
    var_8C = (uint32)x1;
    x0_22 = ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2ED2Ev(x29 - 64, x1);
    __asm("b #0x2730");
    x0_23 = ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev(x29 - 48);
    __asm("b #0x273c");
    x0_24 = std::unique_ptr::~(x29 - 32);
    __asm("b #0x2748");
    x0_25 = std::unique_ptr::~(x29 - 8);
    __asm("b #0x2754");
    x0_26 = sub_1B10(var_90);
}
void ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EC2IS0_vEEPiRKS0_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3$_2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_2794:
        x0_3 = clang_call_terminate();
}
void ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EdeEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E3getEv(/* arguments unknown */);
    return;
}
void ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2ED2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m30 = local_m18;
    ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv(/* arguments unknown */);
    local_m28 = call_68;
    local_m20 = local_m28;
    if (!(memory_unknown == 0)) {
        ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E11get_deleterEv(/* arguments unknown */);
        local_m38 = call_102;
        ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_(/* arguments unknown */);
        ZZ18test_cpp_smart_ptrvENK3$_2clEPi(/* arguments unknown */);
    }
    memory_unknown = 0;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_2848:
        x0_6 = clang_call_terminate();
}
void Z13test_cpp_rttiv(void)
{
    uint64 load_86;
    uint64 load_497;
    uint64 load_166;
    uint64 load_144;
    uint64 load_362;
    uint64 load_318;
    uint64 load_61;
    uint64 load_315;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m50 = 8;
    unknown_call(8);
    local_m58 = call_143;
    memory_unknown = 0;
    ZN12RTTIDerivedAC2Ev(/* arguments unknown */);
    local_m18 = local_m58;
    unknown_call(var_m50);
    local_m48 = call_192;
    memory_unknown = 0;
    ZN12RTTIDerivedBC2Ev(/* arguments unknown */);
    load_86 = var_m48;
    local_m20 = load_86;
    local_m24 = 0;
    local_m40 = local_m18;
    if (!(var_m18 != 0)) {
        unknown_call(load_86);
    }
    ZNKSt9type_infoeqERKS_(/* arguments unknown */);
    if (!(bit_extract(call_944, 0, 1) == 0)) {
        memory_unknown = memory_unknown + 10;
    }
    load_315 = memory_unknown;
    memory_unknown = load_315;
    if (!(load_315 != 0)) {
        unknown_call(call_944);
    }
    ZNKSt9type_infoeqERKS_(/* arguments unknown */);
    if (!(bit_extract(call_1121, 0, 1) == 0)) {
        memory_unknown = memory_unknown + 20;
    }
    load_144 = memory_unknown;
    memory_unknown = load_144;
    if (load_144 == 0) {
        memory_unknown = 0;
    } else {
        unknown_call(memory_unknown);
        memory_unknown = call_586;
    }
    memory_unknown = memory_unknown;
    if (!(memory_unknown == 0)) {
        ZNK12RTTIDerivedA13derivedA_dataEv(/* arguments unknown */);
        memory_unknown = memory_unknown + (uint32_t)call_982;
    }
    load_166 = memory_unknown;
    memory_unknown = load_166;
    if (load_166 == 0) {
        memory_unknown = 0;
    } else {
        unknown_call(memory_unknown);
        memory_unknown = call_790;
    }
    memory_unknown = memory_unknown;
    if (!(memory_unknown == 0)) {
        ZNK12RTTIDerivedB13derivedB_dataEv(/* arguments unknown */);
        memory_unknown = memory_unknown + (uint32_t)call_861;
    }
    load_497 = memory_unknown;
    memory_unknown = load_497;
    if (!(load_497 != 0)) {
        unknown_call(phi(phi(phi(phi(call_722, call_1121), call_957), call_977), call_741));
    }
    load_362 = memory_unknown;
    ZNKSt9type_info4nameEv(/* arguments unknown */);
    unknown_call(load_362);
    memory_unknown = (int64_t)memory_unknown + call_701;
    load_318 = memory_unknown;
    memory_unknown = load_318;
    if (!(load_318 == 0)) {
        unknown_call(memory_unknown);
    }
    load_61 = memory_unknown;
    memory_unknown = load_61;
    if (!(load_61 == 0)) {
        unknown_call(memory_unknown);
    }
    return;
}
void Z20test_cpp_oo_featuresv(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    unknown_call(0x4BD5);
    Z20test_cpp_member_funcv(/* arguments unknown */);
    unknown_call(0x4BFA);
    Z20test_cpp_constructorv(/* arguments unknown */);
    unknown_call(0x4C18);
    Z21test_cpp_virtual_funcv(/* arguments unknown */);
    unknown_call(0x4C34);
    Z29test_cpp_multiple_inheritancev(/* arguments unknown */);
    unknown_call(0x4C50);
    Z28test_cpp_diamond_inheritancev(/* arguments unknown */);
    unknown_call(0x4C6C);
    Z26test_cpp_operator_overloadv(/* arguments unknown */);
    unknown_call(0x4C89);
    Z22test_cpp_template_funcv(/* arguments unknown */);
    unknown_call(0x4CA5);
    Z23test_cpp_template_classv(/* arguments unknown */);
    unknown_call(0x4CC1);
    Z15test_cpp_lambdav(/* arguments unknown */);
    unknown_call(0x4CDD);
    Z18test_cpp_exceptionv(/* arguments unknown */);
    unknown_call(0x4CF9);
    Z18test_cpp_smart_ptrv(/* arguments unknown */);
    unknown_call(0x4D16);
    Z13test_cpp_rttiv(/* arguments unknown */);
    unknown_call(0x4D33);
    return;
}
void main(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = 0;
    local_m14 = 0;
    Z20test_cpp_oo_featuresv(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3$_2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2EC2IRKS0_EEPiOT_(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2EC2IRKS0_EEPiOT_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m38 = var_134 - 64 + 48 - 16;
    local_m20 = a2;
    local_m28 = a3;
    local_m30 = local_m18;
    ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE(/* arguments unknown */);
    ZNSt5tupleIJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_RKS1_Lb1EEEOT_OT0_(/* arguments unknown */);
    return;
}
void ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE(void)
{
    local_m8 = a1;
    return;
}
void ZNSt5tupleIJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_RKS1_Lb1EEEOT_OT0_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    local_m30 = local_m18;
    ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE(/* arguments unknown */);
    local_m38 = call_82;
    ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE(/* arguments unknown */);
    ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_JRKS1_EvEEOT_DpOT0_(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_2CA4:
        x0_6 = clang_call_terminate();
}
void ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_JRKS1_EvEEOT_DpOT0_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = a3;
    local_m30 = local_m18;
    ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE(/* arguments unknown */);
    ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EEC2ERKS0_(/* arguments unknown */);
    ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE(/* arguments unknown */);
    ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EEC2ERKS0_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EEC2ERKS0_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EEC2ERKS0_(void)
{
    local_m8 = a1;
    local_m10 = a2;
    return;
}
void ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_(/* arguments unknown */);
    return;
}
void ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E11get_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E10_M_deleterEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_2D90:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZZ18test_cpp_smart_ptrvENK3$_2clEPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    a2->field_0 = 0xFFFFFFFF;
    local_m28 = local_m20;
    if (!(var_10 == 0)) {
        unknown_call(var_p8);
    }
    return;
}
void ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS2_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E10_M_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm1EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_(/* arguments unknown */);
    return;
}
void ZSt3getILm1EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm1EZ18test_cpp_smart_ptrvE3$_2JEERT0_RSt11_Tuple_implIXT_EJS1_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm1EZ18test_cpp_smart_ptrvE3$_2JEERT0_RSt11_Tuple_implIXT_EJS1_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS1_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS1_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EE7_M_headERS1_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EE7_M_headERS1_(void)
{
    local_m8 = a1;
    return;
}
void ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E3getEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_2F1C:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_(/* arguments unknown */);
    return;
}
void ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERKS2_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERKS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_(/* arguments unknown */);
    return;
}
void ZN11SimpleClassC2EiPKc(void)
{
    uint64 load_91;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m28 = a3;
    load_91 = var_m18;
    local_m30 = load_91;
    load_91->field_0 = local_m1C;
    unknown_call(load_91 + 4);
    memory_unknown = 0;
    return;
}
void ZN11SimpleClass8setValueEi(void)
{
    local_m8 = a1;
    local_mC = a2;
    a1->field_0 = local_mC;
    return;
}
void ZNK11SimpleClass8getValueEv(void)
{
    local_m8 = a1;
    return;
}
void ZNK11SimpleClass7computeEi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m1C = a2;
    local_m20 = a1->field_0 * local_m1C;
    unknown_call(var_8 + 4);
    return;
}
void ZN11SimpleClass10getClassIDEv(void)
{
    return;
}
void ZN14LifecycleClassC2Em(void)
{
    uint64 load_40;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = local_m18;
    a1->field_8 = local_m20;
    load_40 = var_10;
    unknown_call(((uint64_t)v53 == 0 ? load_40 * 4 : 0xFFFFFFFFFFFFFFFF));
    memory_unknown = call_149;
    local_m28 = 0;
    while ((uint64_t)var_m28 < (uint64_t)var_10) {
        memory_unknown[local_m28] = local_m28 * 10;
        local_m28++;
        continue;
    }
    global_180F8++;
    return;
}
void ZNK14LifecycleClass7getDataEm(void)
{
    local_m8 = a1;
    local_m10 = a2;
    local_m18 = local_m8;
    if ((uint64_t)var_10 >= (uint64_t)var_18->field_8) {
        local_m1C = 0xFFFFFFFF;
    } else {
        local_m1C = memory_unknown[a2];
    }
    return;
}
void ZN14LifecycleClass16getInstanceCountEv(void)
{
    return;
}
void ZN14LifecycleClassD2Ev(void)
{
    uint64 load_5;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    load_5 = var_8->field_0;
    local_m20 = load_5;
    if (!(load_5 == 0)) {
        unknown_call(var_0);
    }
    global_180F8--;
    return;
}
void ZN4BaseC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0x17858;
    return;
}
void ZN7DerivedC2Ei(void)
{
    uint64 load_6;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = 0x17898;
    local_m18 = a1;
    local_m1C = a2;
    local_m28 = local_m18;
    ZN4BaseC2Ev(/* arguments unknown */);
    load_6 = var_p8;
    memory_unknown = local_m30;
    memory_unknown = local_m1C;
    return;
}
void ZN4Base12virtual_funcEi(void)
{
    local_m8 = a1;
    local_mC = a2;
    return;
}
void ZN7Derived12virtual_funcEi(void)
{
    local_m8 = a1;
    local_mC = a2;
    return;
}
void ZN7DerivedD2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZN4BaseD2Ev(/* arguments unknown */);
    return;
}
void ZN4BaseD2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZN12MultiDerivedC2Ev(void)
{
    uint64 load_14;
    uint64 load_113;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m30 = 0x178E0;
    local_m28 = 0x17910;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN5BaseAC2Ev(/* arguments unknown */);
    ZN5BaseBC2Ev(/* arguments unknown */);
    load_14 = var_p8;
    load_113 = var_10;
    memory_unknown = local_m30;
    memory_unknown = load_14;
    return;
}
void ZN12MultiDerivedD2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN5BaseBD2Ev(/* arguments unknown */);
    ZN5BaseAD2Ev(/* arguments unknown */);
    return;
}
void ZN14DiamondDerivedC1Ev(void)
{
    uint64 load_205;
    uint64 load_6;
    uint64 load_54;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m48 = 0x17A70;
    local_m40 = 0x17A80;
    local_m38 = 0x179E8;
    local_m30 = 0x17A50;
    local_m28 = 0x17A18;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN11VirtualBaseC2Ev(/* arguments unknown */);
    ZN7MiddleAC2Ev(/* arguments unknown */);
    ZN7MiddleBC2Ev(/* arguments unknown */);
    load_205 = var_20;
    load_6 = var_m28;
    load_54 = var_m20;
    memory_unknown = local_m38;
    memory_unknown = load_205;
    memory_unknown = load_6;
    return;
}
void ZN14DiamondDerivedD1Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN14DiamondDerivedD2Ev(/* arguments unknown */);
    ZN11VirtualBaseD2Ev(/* arguments unknown */);
    return;
}
void ZN5PointC2Eii(void)
{
    uint64 load_56;
    local_m8 = a1;
    local_mC = a2;
    local_m10 = a3;
    load_56 = var_8;
    load_56->field_0 = local_mC;
    load_56->field_4 = local_m10;
    return;
}
void ZNK5PointplERKS_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m20 = a1;
    local_m28 = a2;
    ZN5PointC2Eii(/* arguments unknown */);
    return;
}
void ZNK5PointeqERKS_(void)
{
    uint32 load_91;
    uint32 load_96;
    local_m8 = a1;
    local_m10 = a2;
    local_m20 = local_m8;
    load_96 = var_18->field_0;
    load_91 = var_10->field_0;
    local_m14 = 0;
    if ((uint32_t)load_96 == (uint32_t)load_91) {
        local_m14 = (uint32_t)memory_unknown == (uint32_t)a2->field_4 ? 1 : 0;
    }
    return;
}
void ZN5PointppEv(void)
{
    uint64 load_33;
    local_m8 = a1;
    load_33 = var_8;
    load_33->field_0++;
    load_33->field_4++;
    return;
}
void Z12template_maxIiET_S0_S0_(void)
{
    local_m4 = a1;
    local_m8 = a2;
    if ((int32_t)a1 <= (int32_t)a2) {
        local_mC = (uint32_t)a2;
    } else {
        local_mC = (uint32_t)a1;
    }
    return;
}
void Z12template_maxIdET_S0_S0_(void)
{
    local_m8 = var_124;
    local_m10 = var_119;
    __asm("fcmp d0, d1");
    if (condition_le) {
        local_m18 = var_119;
    } else {
        local_m18 = var_124;
    }
    return;
}
void Z13template_swapIiEvRT_S1_(void)
{
    local_m8 = a1;
    local_m10 = a2;
    local_m14 = a1->field_0;
    a1->field_0 = a2->field_0;
    memory_unknown = local_m14;
    return;
}
void ZN9ContainerIiEC1Ev(void)
{
    local_m8 = a1;
    a1->field_28 = 0;
    return;
}
void ZN9ContainerIiE4pushEi(void)
{
    uint32 load_47;
    uint32 load_92;
    uint64 load_64;
    local_m8 = a1;
    local_mC = a2;
    local_m18 = local_m8;
    if ((int32_t)var_18->field_28 < 10) {
        load_64 = var_8;
        load_92 = var_14;
        load_47 = memory_unknown;
        memory_unknown = (uint32_t)(int64_t)load_47 + 1;
        load_64[(int64_t)load_47] = load_92;
    }
    return;
}
void ZNK9ContainerIiE3getEi(void)
{
    local_m10 = a1;
    local_m14 = a2;
    local_m20 = a1;
    if (__arm64_condition_unknown(/* NZCV */)) {
        local_m4 = 0;
    } else {
        if ((int32_t)a2 >= (int32_t)memory_unknown) {
            goto loc_36C0;
        } else {
            local_m4 = a1[(int64_t)(uint32_t)a2];
        }
    }
    return;
}
void ZNK9ContainerIiE7getSizeEv(void)
{
    local_m8 = a1;
    return;
}
void ZN9ContainerIdEC1Ev(void)
{
    local_m8 = a1;
    a1->field_50 = 0;
    return;
}
void ZN9ContainerIdE4pushEd(void)
{
    uint32 load_0;
    uint64 load_31;
    uint64 load_103;
    local_m8 = a1;
    local_m10 = var_127;
    local_m18 = local_m8;
    if ((int32_t)var_18->field_50 < 10) {
        load_31 = var_8;
        load_103 = var_10;
        load_0 = memory_unknown;
        memory_unknown = (uint32_t)(int64_t)load_0 + 1;
        load_31[(int64_t)load_0] = load_103;
    }
    return;
}
void Container::get(int64 a1, int64 a2)
{
    uint32 var_C;
    uint64 var_10;
    double var_18;

    var_10 = a1;
    var_C = (uint32)a2;
    x8 = var_10;
    var_0 = a1;
    __asm("tbnz w8, #0x1f, #0x379c");
    __asm("b #0x3770");
    __asm("b.ge #0x379c");
    __asm("b #0x3788");
    var_18 = *(uint64 *)(*(uint64 *)(sp) + var_C * 8);
    __asm("b #0x37a8");
    d0 = 0; /* vector zero */
    var_18 = v0;
    __asm("b #0x37a8");
    return;
}
void ZNK9ContainerIdE7getSizeEv(void)
{
    local_m8 = a1;
    return;
}
void ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_37FC:
        x0_3 = clang_call_terminate();
}
void ZNKSt10unique_ptrIiSt14default_deleteIiEEdeEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv(/* arguments unknown */);
    return;
}
void ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_(void)
{
    local_m8 = a1;
    return;
}
void ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_(/* arguments unknown */);
    return;
}
void ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_38A4:
        x0_3 = clang_call_terminate();
}
void ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m18;
    ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv(/* arguments unknown */);
    return;
}
void ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev(void)
{
    uint64 load_1;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m28 = local_m18;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv(/* arguments unknown */);
    local_m20 = call_68;
    if (!(memory_unknown == 0)) {
        load_1 = var_p8;
        ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv(/* arguments unknown */);
        ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsr14is_convertibleIPA_T_PS0_EE5valueEvE4typeEPS4_(/* arguments unknown */);
    }
    memory_unknown = 0;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_3948:
        x0_5 = clang_call_terminate();
}
void ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m28 = local_m18;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(/* arguments unknown */);
    local_m20 = call_68;
    if (!(memory_unknown == 0)) {
        ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv(/* arguments unknown */);
        local_m30 = call_110;
        ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_(/* arguments unknown */);
        ZNKSt14default_deleteIiEclEPi(/* arguments unknown */);
    }
    memory_unknown = 0;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_39BC:
        x0_6 = clang_call_terminate();
}
void ZN12RTTIDerivedAC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m28 = 0x17D30;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN8RTTIBaseC2Ev(/* arguments unknown */);
    memory_unknown = local_m28;
    return;
}
void ZN12RTTIDerivedBC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m28 = 0x17D80;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN8RTTIBaseC2Ev(/* arguments unknown */);
    memory_unknown = local_m28;
    return;
}
void ZNKSt9type_infoeqERKS_(void)
{
    uint64 load_34;
    uint64 load_20;
    uint8 load_194;
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = local_m18;
    load_34 = var_m18->field_8;
    load_20 = var_m20->field_8;
    local_m24 = 1;
    if ((uint64_t)load_34 != (uint64_t)load_20) {
        load_194 = memory_unknown;
        local_m34 = 0;
        if ((uint32_t)load_194 != 42) {
            unknown_call(memory_unknown);
            local_m34 = (uint32_t)call_327 == 0 ? 1 : 0;
        }
        memory_unknown = memory_unknown;
    }
    return;
}
void ZNK12RTTIDerivedA13derivedA_dataEv(void)
{
    local_m8 = a1;
    return;
}
void ZNK12RTTIDerivedB13derivedB_dataEv(void)
{
    local_m8 = a1;
    return;
}
void ZNKSt9type_info4nameEv(void)
{
    local_m8 = a1;
    local_m10 = local_m8;
    if ((uint32_t)memory_unknown != 42) {
        local_m18 = memory_unknown;
    } else {
        local_m18 = memory_unknown + 1;
    }
    return;
}
void ZNK4Base7getNameEv(void)
{
    local_m8 = a1;
    return;
}
void ZN4BaseD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN4BaseD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZNK7Derived7getNameEv(void)
{
    local_m8 = a1;
    return;
}
void ZN7DerivedD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN7DerivedD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZN5BaseAC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0x17990;
    return;
}
void ZN5BaseBC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0x179B8;
    return;
}
void ZN12MultiDerived5funcAEv(void)
{
    local_m8 = a1;
    return;
}
void ZN12MultiDerivedD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN12MultiDerivedD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZN12MultiDerived5funcBEv(void)
{
    local_m8 = a1;
    return;
}
void ZThn16_N12MultiDerived5funcBEv(void)
{
    local_m8 = a1;
}
void ZThn16_N12MultiDerivedD1Ev(void)
{
    local_m8 = a1;
}
void ZThn16_N12MultiDerivedD0Ev(void)
{
    local_m8 = a1;
}
void ZN5BaseA5funcAEv(void)
{
    local_m8 = a1;
    return;
}
void ZN5BaseAD2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZN5BaseAD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN5BaseAD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZN5BaseB5funcBEv(void)
{
    local_m8 = a1;
    return;
}
void ZN5BaseBD2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZN5BaseBD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN5BaseBD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZN11VirtualBaseC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0x17C18;
    return;
}
void ZN7MiddleAC2Ev(void)
{
    uint64 load_42;
    uint64 load_21;
    local_m8 = a1;
    local_m10 = a2;
    load_42 = var_8;
    load_21 = var_0;
    load_42->field_0 = load_21->field_0;
    memory_unknown = load_21->field_8;
    return;
}
void ZN7MiddleBC2Ev(void)
{
    uint64 load_63;
    uint64 load_37;
    local_m8 = a1;
    local_m10 = a2;
    load_63 = var_8;
    load_37 = var_0;
    load_63->field_0 = load_37->field_0;
    memory_unknown = load_37->field_8;
    return;
}
void ZN7MiddleA4funcEv(void)
{
    local_m8 = a1;
    return;
}
void ZN7MiddleAD1Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN7MiddleAD2Ev(/* arguments unknown */);
    ZN11VirtualBaseD2Ev(/* arguments unknown */);
    return;
}
void ZN7MiddleAD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN7MiddleAD1Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZTv0_n24_N7MiddleA4funcEv(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N7MiddleAD1Ev(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N7MiddleAD0Ev(void)
{
    local_m8 = a1;
}
void ZN7MiddleB4funcEv(void)
{
    local_m8 = a1;
    return;
}
void ZN7MiddleBD1Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN7MiddleBD2Ev(/* arguments unknown */);
    ZN11VirtualBaseD2Ev(/* arguments unknown */);
    return;
}
void ZN7MiddleBD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN7MiddleBD1Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZTv0_n24_N7MiddleB4funcEv(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N7MiddleBD1Ev(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N7MiddleBD0Ev(void)
{
    local_m8 = a1;
}
void ZN14DiamondDerived4funcEv(void)
{
    local_m8 = a1;
    return;
}
void ZN14DiamondDerivedD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN14DiamondDerivedD1Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZThn16_N14DiamondDerived4funcEv(void)
{
    local_m8 = a1;
}
void ZThn16_N14DiamondDerivedD1Ev(void)
{
    local_m8 = a1;
}
void ZThn16_N14DiamondDerivedD0Ev(void)
{
    local_m8 = a1;
}
void ZTv0_n24_N14DiamondDerived4funcEv(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N14DiamondDerivedD1Ev(void)
{
    local_m8 = a1;
}
void ZTv0_n32_N14DiamondDerivedD0Ev(void)
{
    local_m8 = a1;
}
void ZN11VirtualBase4funcEv(void)
{
    local_m8 = a1;
    return;
}
void ZN11VirtualBaseD2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZN11VirtualBaseD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN11VirtualBaseD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZN7MiddleAD2Ev(void)
{
    local_m8 = a1;
    local_m10 = a2;
    return;
}
void ZN7MiddleBD2Ev(void)
{
    local_m8 = a1;
    local_m10 = a2;
    return;
}
void ZN14DiamondDerivedD2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m18;
    local_m30 = local_m20;
    ZN7MiddleBD2Ev(/* arguments unknown */);
    ZN7MiddleAD2Ev(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = local_m18;
    ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_(/* arguments unknown */);
    ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_(/* arguments unknown */);
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(/* arguments unknown */);
    local_m28 = call_108;
    memory_unknown = 0;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4240:
        x0_5 = clang_call_terminate();
}
void ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_(void)
{
    local_m8 = a1;
    return;
}
void ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(/* arguments unknown */);
    return;
}
void clang_call_terminate(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x30;
    unknown_call(/* target unknown */);
    unknown_call(/* target unknown */);
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m18;
    ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_(/* arguments unknown */);
    memory_unknown = memory_unknown;
    return;
}
void ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_(void)
{
    local_m8 = a1;
    local_m10 = a2;
    return;
}
void ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_(void)
{
    local_m8 = a1;
    return;
}
void ZN8RTTIBaseC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0x17D58;
    return;
}
void ZN12RTTIDerivedAD2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZN8RTTIBaseD2Ev(/* arguments unknown */);
    return;
}
void ZN12RTTIDerivedAD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN12RTTIDerivedAD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZNK12RTTIDerivedA7getTypeEv(void)
{
    local_m8 = a1;
    return;
}
void ZN8RTTIBaseD2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZN8RTTIBaseD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN8RTTIBaseD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZNK8RTTIBase7getTypeEv(void)
{
    local_m8 = a1;
    return;
}
void ZN12RTTIDerivedBD2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZN8RTTIBaseD2Ev(/* arguments unknown */);
    return;
}
void ZN12RTTIDerivedBD0Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZN12RTTIDerivedBD2Ev(/* arguments unknown */);
    unknown_call(var_0);
    return;
}
void ZNK12RTTIDerivedB7getTypeEv(void)
{
    local_m8 = a1;
    return;
}
void ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = local_m18;
    ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv(/* arguments unknown */);
    local_m28 = local_m20;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(/* arguments unknown */);
    memory_unknown = local_m28;
    return;
}
void ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4568:
        x0_3 = clang_call_terminate();
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev(/* arguments unknown */);
    ZNSt10_Head_baseILm0EPiLb0EEC2Ev(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm0EPiLb0EEC2Ev(void)
{
    local_m8 = a1;
    a1->field_0 = 0;
    return;
}
void ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4618:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZNKSt14default_deleteIiEclEPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m20;
    if (!(var_10 == 0)) {
        unknown_call(var_p8);
    }
    return;
}
void ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_(void)
{
    local_m8 = a1;
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(/* arguments unknown */);
    return;
}
void ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_(void)
{
    local_m8 = a1;
    return;
}
void ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4740:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_(/* arguments unknown */);
    return;
}
void ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_(void)
{
    local_m8 = a1;
    return;
}
void ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi(/* arguments unknown */);
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m30 = local_m18;
    ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv(/* arguments unknown */);
    local_m28 = local_m20;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv(/* arguments unknown */);
    memory_unknown = local_m28;
    return;
}
void ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev(/* arguments unknown */);
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4884:
        x0_3 = clang_call_terminate();
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = local_m18;
    ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev(/* arguments unknown */);
    ZNSt10_Head_baseILm0EPiLb0EEC2Ev(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev(void)
{
    local_m8 = a1;
    return;
}
void ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_(/* arguments unknown */);
    return;
}
void ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_49AC:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsr14is_convertibleIPA_T_PS0_EE5valueEvE4typeEPS4_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m20;
    if (!(var_10 == 0)) {
        unknown_call(var_p8);
    }
    return;
}
void ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_(/* arguments unknown */);
    return;
}
void ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_(/* arguments unknown */);
    return;
}
void ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_(void)
{
    local_m8 = a1;
    return;
}
void ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv(/* arguments unknown */);
    local_m20 = call_54;
    return;
    /* Exception landing pads — entered only by runtime unwinding. */
    loc_4AC0:
        x0_3 = clang_call_terminate(*(uint64 *)(sp));
}
void ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_(/* arguments unknown */);
    return;
}
void ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE(/* arguments unknown */);
    return;
}
void ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_(/* arguments unknown */);
    return;
}
void ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_(/* arguments unknown */);
    return;
}
void ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE(void)
{
    local_m8 = a1;
    return;
}
void ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_(void)
{
    local_m10 = local_x29;
    local_m10 = local_x29;
    local_m18 = a1;
    local_m20 = a2;
    local_m28 = local_m18;
    ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE(/* arguments unknown */);
    memory_unknown = memory_unknown;
    return;
}
void fini(void)
{
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    local_pFFFFFFFFFFFFFFF0 = local_x29;
    return;
}
