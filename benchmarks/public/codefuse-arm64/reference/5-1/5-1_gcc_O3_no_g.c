/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0xE90 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_EB0 @ 0xEB0 */
void sub_EB0()
{
  JUMPOUT(0);
}


/* Function: _Z18test_cpp_exceptionv @ 0x1040 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: main @ 0x1120 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
  return 0;
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x1140 */
__int64 GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _start @ 0x1180 */
void __fastcall __noreturn start(
        void (*rtld_fini)(void),
        int a2,
        int a3,
        int a4,
        int a5,
        int a6,
        int a7,
        int a8,
        int argc,
        char *ubp_av)
{
  __libc_start_main((int (*)(int, char **, char **))main, argc, &ubp_av, 0, 0, rtld_fini, &argc);
  abort();
}


/* Function: call_weak_fn @ 0x11B4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x11D0 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x1200 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1240 */
__int64 _do_global_dtors_aux()
{
  __int64 result; // x0

  result = (unsigned __int8)_bss_start;
  if ( !_bss_start )
  {
    if ( &_cxa_finalize )
      __cxa_finalize(_dso_handle);
    deregister_tm_clones();
    result = 1;
    _bss_start = 1;
  }
  return result;
}


/* Function: frame_dummy @ 0x1290 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x12A0 */
__int64 test_cpp_member_func(void)
{
  char *v0; // x0
  char dest[36]; // [xsp+14h] [xbp+14h] BYREF

  v0 = strncpy(dest, "Test", 0x1Fu);
  dest[31] = 0;
  return (unsigned int)strlen(v0) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1310 */
__int64 test_cpp_constructor(void)
{
  return (unsigned int)(LifecycleClass::instance_count + 21 + 1000 * LifecycleClass::instance_count);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1330 */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD))
{
  return (**a1)(a1);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1340 */
__int64 test_cpp_virtual_func(void)
{
  return 42;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1350 */
__int64 test_cpp_multiple_inheritance(void)
{
  return 71;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1360 */
__int64 test_cpp_diamond_inheritance(void)
{
  return 650;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1370 */
__int64 test_cpp_operator_overload(void)
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1380 */
__int64 test_cpp_template_func(void)
{
  int v0; // w0
  int v1; // w19
  double v2; // d8
  int v4; // [xsp+20h] [xbp+20h] BYREF
  int v5; // [xsp+24h] [xbp+24h] BYREF

  template_max<int>(3, 7, &_stack_chk_guard, 0);
  v1 = v0;
  v2 = template_max<double>(2.5, 1.5);
  v4 = 10;
  v5 = 20;
  template_swap<int>(&v4, &v5);
  return (unsigned int)((int)v2 + v1 + v4 + v5);
}


/* Function: _Z23test_cpp_template_classv @ 0x1420 */
__int64 test_cpp_template_class(void)
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x1430 */
__int64 test_cpp_lambda(void)
{
  return 85;
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1440 */
__int64 test_cpp_smart_ptr(void)
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x1450 */
__int64 test_cpp_rtti(void)
{
  __int64 *v0; // x21
  void *v1; // x20
  __int64 v2; // x24
  const char *v3; // x23
  int v4; // w25
  int v5; // w22
  int v6; // w19
  const char *v7; // x0
  unsigned int v8; // w19

  v0 = (__int64 *)operator new(8u);
  *v0 = (__int64)off_12C28;
  v1 = (void *)operator new(8u);
  v2 = *v0;
  v3 = *(const char **)(*(_QWORD *)(*v0 - 8) + 8LL);
  *(_QWORD *)v1 = off_12C50;
  if ( v3 == "12RTTIDerivedA" )
  {
    v4 = *(unsigned __int8 *)v3;
    v5 = 30;
  }
  else
  {
    v4 = *(unsigned __int8 *)v3;
    if ( v4 == 42 )
    {
      v5 = 20;
    }
    else if ( !strcmp(v3, "12RTTIDerivedA") )
    {
      v5 = 30;
    }
    else
    {
      v5 = 20;
    }
  }
  v6 = v5;
  if ( __dynamic_cast(
         v0,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v6 = v5 + 100;
  }
  if ( __dynamic_cast(
         v1,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v6 += 200;
  }
  if ( v4 == 42 )
    v7 = v3 + 1;
  else
    v7 = v3;
  v8 = v6 + strlen(v7);
  (*(void (__fastcall **)(__int64 *))(v2 + 8))(v0);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v1 + 8LL))(v1);
  return v8;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x15F0 */
void __noreturn test_cpp_oo_features(void)
{
  int v0; // w0
  __int64 v1; // x2
  __int64 v2; // x3
  int v3; // w0
  int v4; // w19
  double v5; // d8
  int v6; // [xsp+28h] [xbp+28h] BYREF
  int v7; // [xsp+2Ch] [xbp+2Ch] BYREF
  char v8[36]; // [xsp+34h] [xbp+34h] BYREF

  puts(asc_1BA0);
  strncpy(v8, "Test", 0x1Fu);
  v8[31] = 0;
  v0 = strlen(v8);
  __printf_chk(1, &unk_1BC8, (unsigned int)(v0 + 4700));
  __printf_chk(
    1,
    &unk_1BE8,
    (unsigned int)(LifecycleClass::instance_count + 21 + 1000 * LifecycleClass::instance_count));
  __printf_chk(1, &unk_1C08, 42);
  __printf_chk(1, &unk_1C28, 71);
  __printf_chk(1, &unk_1C48, 650);
  __printf_chk(1, &unk_1C68, 22);
  template_max<int>(3, 7, v1, v2);
  v4 = v3;
  v5 = template_max<double>(2.5, 1.5);
  v6 = 10;
  v7 = 20;
  template_swap<int>(&v6, &v7);
  __printf_chk(1, &unk_1C88, (unsigned int)((int)v5 + v4 + v6 + v7));
  __printf_chk(1, &unk_1CA8, 16);
  __printf_chk(1, &unk_1CC8, 85);
  test_cpp_exception();
}


/* Function: _ZN4Base12virtual_funcEi @ 0x17D0 */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x17E0 */
const char *__fastcall Base::getName(Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x17F0 */
void __fastcall Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x1800 */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(a2 * *((_DWORD *)this + 2));
}


/* Function: _ZNK7Derived7getNameEv @ 0x1810 */
const char *__fastcall Derived::getName(Derived *this)
{
  return "Derived";
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x1820 */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x1830 */
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x1840 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZN7MiddleA4funcEv @ 0x1850 */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x1870 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 150);
}


/* Function: _ZN7MiddleB4funcEv @ 0x18A0 */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x18C0 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 200);
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x18F0 */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x1910 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 250);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x1934 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*((_QWORD *)this - 2) - 24LL) - 8) + 250);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x1950 */
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x1960 */
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x1970 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  ;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x1980 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  ;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x1990 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x1994 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x19A0 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x19B0 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x19B4 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN7DerivedD2Ev @ 0x19C0 */
void __fastcall Derived::~Derived(Derived *this)
{
  ;
}


/* Function: _ZN4BaseD0Ev @ 0x19D0 */
void __fastcall Base::~Base(Base *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7DerivedD0Ev @ 0x19E0 */
void __fastcall Derived::~Derived(Derived *this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x19F0 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x1A00 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete((char *)this - 16, 0x20u);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x1A10 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x1A20 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x1A30 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete(this, 0x30u);
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x1A40 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL), 0x30u);
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x1A54 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this - 16, 0x30u);
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x1A60 */
__int64 __fastcall template_max<int>(__int64 result, int a2)
{
  if ( (int)result < a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x1A70 */
double __fastcall template_max<double>(double result, double a2)
{
  if ( result <= a2 )
    return a2;
  return result;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x1A80 */
int *__fastcall template_swap<int>(int *result, int *a2)
{
  int v2; // w2

  v2 = *result;
  *result = *a2;
  *a2 = v2;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x1AA0 */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x1AB0 */
__int64 __fastcall Container<int>::push(__int64 result, int a2)
{
  int v2; // w2

  v2 = *(_DWORD *)(result + 40);
  if ( v2 <= 9 )
  {
    *(_DWORD *)(result + 40) = v2 + 1;
    *(_DWORD *)(result + 4LL * v2) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x1AD0 */
__int64 __fastcall Container<int>::get(__int64 a1, int a2)
{
  __int64 result; // x0

  result = 0;
  if ( (a2 & 0x80000000) == 0 )
  {
    result = 0;
    if ( *(_DWORD *)(a1 + 40) > a2 )
      return *(unsigned int *)(a1 + 4LL * a2);
  }
  return result;
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x1B00 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x1B10 */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x1B20 */
__int64 __fastcall Container<double>::push(__int64 result, double a2)
{
  int v2; // w1

  v2 = *(_DWORD *)(result + 80);
  if ( v2 <= 9 )
  {
    *(_DWORD *)(result + 80) = v2 + 1;
    *(double *)(result + 8LL * v2) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x1B40 */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  double result; // d0

  result = 0.0;
  if ( (a2 & 0x80000000) == 0 && *(_DWORD *)(a1 + 80) > a2 )
    return *(double *)(a1 + 8LL * a2);
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x1B60 */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: .term_proc @ 0x1B68 */
void term_proc()
{
  ;
}


/* FAILED to decompile: puts @ 0x130A0 */

/* FAILED to decompile: strlen @ 0x130A8 */

/* FAILED to decompile: __stack_chk_fail @ 0x130B0 */

/* FAILED to decompile: __cxa_begin_catch @ 0x130B8 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x130C8 */

/* FAILED to decompile: __cxa_finalize @ 0x130D0 */

/* FAILED to decompile: __libc_start_main @ 0x130E0 */

/* FAILED to decompile: _Znwm @ 0x130E8 */

/* FAILED to decompile: _ZdlPvm @ 0x130F0 */

/* FAILED to decompile: strncpy @ 0x130F8 */

/* FAILED to decompile: __dynamic_cast @ 0x13100 */

/* FAILED to decompile: __cxa_atexit @ 0x13108 */

/* FAILED to decompile: strcmp @ 0x13118 */

/* FAILED to decompile: __cxa_rethrow @ 0x13120 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x13128 */

/* FAILED to decompile: abort @ 0x13130 */

/* FAILED to decompile: __cxa_end_catch @ 0x13138 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x13140 */

/* FAILED to decompile: __cxa_throw @ 0x13148 */

/* FAILED to decompile: _Unwind_Resume @ 0x13150 */

/* FAILED to decompile: __printf_chk @ 0x13158 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x13160 */

/* FAILED to decompile: __gmon_start__ @ 0x13170 */

/* Total functions decompiled: 70, failed: 23 */
