/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_O1_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1458 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_1470 @ 0x1470 */
void sub_1470()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x1640 */
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


/* Function: call_weak_fn @ 0x1674 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1690 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x16C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1700 */
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


/* Function: frame_dummy @ 0x1750 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1754 */
__int64 test_cpp_member_func(void)
{
  char dest[36]; // [xsp+24h] [xbp+24h] BYREF

  strncpy(dest, "Test", 0x1Fu);
  dest[31] = 0;
  return (unsigned int)strlen(dest) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x17CC */
__int64 test_cpp_constructor(void)
{
  _DWORD *v0; // x0
  int v1; // w1
  int v2; // w19

  v0 = (_DWORD *)operator new[](0x14u);
  v0[1] = 10;
  v0[2] = 20;
  v0[3] = 30;
  v0[4] = 40;
  v1 = LifecycleClass::instance_count++;
  v2 = v1 + 21;
  operator delete[](v0);
  --LifecycleClass::instance_count;
  return (unsigned int)(v2 + 1000 * LifecycleClass::instance_count);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1838 */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD))
{
  return (**a1)(a1);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1854 */
__int64 test_cpp_virtual_func(void)
{
  int v0; // w19
  __int64 (__fastcall **v2)(Base *__hidden, int); // [xsp+20h] [xbp+20h] BYREF
  __int64 (__fastcall **v3)(Derived *__hidden, int); // [xsp+28h] [xbp+28h] BYREF
  int v4; // [xsp+30h] [xbp+30h]

  v2 = &off_13958;
  v3 = &off_13988;
  v4 = 3;
  v0 = call_virtual_func((__int64 (__fastcall ***)(_QWORD))&v2);
  return v0 + 21 + (unsigned int)call_virtual_func((__int64 (__fastcall ***)(_QWORD))&v3);
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x18E4 */
__int64 test_cpp_multiple_inheritance(void)
{
  return 71;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x18EC */
__int64 test_cpp_diamond_inheritance(void)
{
  int v0; // w19
  __int64 (__fastcall **v2)(DiamondDerived *__hidden); // [xsp+48h] [xbp+48h] BYREF
  int v3; // [xsp+50h] [xbp+50h]

  v2 = &off_13B30;
  v3 = 50;
  v0 = `virtual thunk to'DiamondDerived::func((DiamondDerived *)&v2);
  v3 = 100;
  return v0 + (unsigned int)`virtual thunk to'DiamondDerived::func((DiamondDerived *)&v2);
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1988 */
__int64 test_cpp_operator_overload(void)
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1990 */
__int64 test_cpp_template_func(void)
{
  int v0; // w0
  int v1; // w19
  double v2; // d8
  int v4; // [xsp+20h] [xbp+20h] BYREF
  int v5; // [xsp+24h] [xbp+24h] BYREF

  template_max<int>(3, 7);
  v1 = v0;
  v2 = template_max<double>(2.5, 1.5);
  v4 = 10;
  v5 = 20;
  template_swap<int>(&v4, &v5);
  return (unsigned int)((int)v2 + v1 + v4 + v5);
}


/* Function: _Z23test_cpp_template_classv @ 0x1A38 */
__int64 test_cpp_template_class(void)
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x1A40 */
__int64 test_cpp_lambda(void)
{
  return 85;
}


/* Function: _Z18test_cpp_exceptionv @ 0x1A48 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1B20 */
__int64 test_cpp_smart_ptr(void)
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x1B28 */
__int64 test_cpp_rtti(void)
{
  __int64 *v0; // x20
  void *v1; // x21
  __int64 v2; // x23
  char *v3; // x22
  int v4; // w19
  int v5; // w19
  const char *v6; // x0
  unsigned int v7; // w19

  v0 = (__int64 *)operator new(8u);
  *v0 = (__int64)off_13B58;
  v1 = (void *)operator new(8u);
  *(_QWORD *)v1 = off_13B80;
  v2 = *v0;
  v3 = *(char **)(*(_QWORD *)(*v0 - 8) + 8LL);
  v4 = 10;
  if ( v3 != "12RTTIDerivedA" )
  {
    v4 = 0;
    if ( *v3 != 42 )
    {
      if ( !strcmp(*(const char **)(*(_QWORD *)(*v0 - 8) + 8LL), "12RTTIDerivedA") )
        v4 = 10;
      else
        v4 = 0;
    }
  }
  v5 = v4 + 20;
  if ( __dynamic_cast(
         v0,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v5 += 100;
  }
  if ( __dynamic_cast(
         v1,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v5 += 200;
  }
  if ( *v3 == 42 )
    v6 = v3 + 1;
  else
    v6 = v3;
  v7 = v5 + strlen(v6);
  (*(void (__fastcall **)(__int64 *))(v2 + 8))(v0);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v1 + 8LL))(v1);
  return v7;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1C8C */
void __noreturn test_cpp_oo_features(void)
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  puts(asc_2148);
  v0 = test_cpp_member_func();
  __printf_chk(1, &unk_2170, v0);
  v1 = test_cpp_constructor();
  __printf_chk(1, &unk_2190, v1);
  v2 = test_cpp_virtual_func();
  __printf_chk(1, &unk_21B0, v2);
  v3 = test_cpp_multiple_inheritance();
  __printf_chk(1, &unk_21D0, v3);
  v4 = test_cpp_diamond_inheritance();
  __printf_chk(1, &unk_21F0, v4);
  __printf_chk(1, &unk_2210, 22);
  v5 = test_cpp_template_func();
  __printf_chk(1, &unk_2230, v5);
  __printf_chk(1, &unk_2250, 16);
  __printf_chk(1, &unk_2270, 85);
  test_cpp_exception();
}


/* Function: main @ 0x1DBC */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x1DD4 */
__int64 GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _ZN4Base12virtual_funcEi @ 0x1E18 */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x1E20 */
const char *__fastcall Base::getName(Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x1E2C */
void __fastcall Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x1E30 */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(a2 * *((_DWORD *)this + 2));
}


/* Function: _ZNK7Derived7getNameEv @ 0x1E3C */
const char *__fastcall Derived::getName(Derived *this)
{
  return "Derived";
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x1E48 */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x1E50 */
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x1E58 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZN7MiddleA4funcEv @ 0x1E60 */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x1E78 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 150);
}


/* Function: _ZN7MiddleB4funcEv @ 0x1E9C */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x1EB4 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 200);
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x1ED8 */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x1EF0 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 250);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x1F14 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*((_QWORD *)this - 2) - 24LL) - 8) + 250);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x1F2C */
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x1F34 */
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x1F3C */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  ;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x1F40 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  ;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x1F44 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x1F48 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x1F4C */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x1F50 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x1F54 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN7DerivedD2Ev @ 0x1F58 */
void __fastcall Derived::~Derived(Derived *this)
{
  ;
}


/* Function: _ZN4BaseD0Ev @ 0x1F5C */
void __fastcall Base::~Base(Base *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7DerivedD0Ev @ 0x1F74 */
void __fastcall Derived::~Derived(Derived *this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x1F8C */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x1FA4 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete((char *)this - 16, 0x20u);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x1FC0 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x1FD8 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x1FF0 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete(this, 0x30u);
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x2008 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL), 0x30u);
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x202C */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this - 16, 0x30u);
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x2048 */
__int64 __fastcall template_max<int>(__int64 result, int a2)
{
  if ( (int)result < a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x2054 */
double __fastcall template_max<double>(double result, double a2)
{
  if ( result <= a2 )
    return a2;
  return result;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x2060 */
int *__fastcall template_swap<int>(int *result, int *a2)
{
  int v2; // w2

  v2 = *result;
  *result = *a2;
  *a2 = v2;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x2074 */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x207C */
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


/* Function: _ZNK9ContainerIiE3getEi @ 0x2098 */
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


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x20C0 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x20C8 */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x20D0 */
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


/* Function: _ZNK9ContainerIdE3getEi @ 0x20EC */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  double result; // d0

  result = 0.0;
  if ( (a2 & 0x80000000) == 0 && *(_DWORD *)(a1 + 80) > a2 )
    return *(double *)(a1 + 8LL * a2);
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x210C */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: .term_proc @ 0x2114 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _Znam @ 0x14098 */

/* FAILED to decompile: puts @ 0x140A8 */

/* FAILED to decompile: strlen @ 0x140B0 */

/* FAILED to decompile: __stack_chk_fail @ 0x140B8 */

/* FAILED to decompile: __cxa_begin_catch @ 0x140C0 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x140D0 */

/* FAILED to decompile: __cxa_finalize @ 0x140D8 */

/* FAILED to decompile: __libc_start_main @ 0x140E8 */

/* FAILED to decompile: _Znwm @ 0x140F0 */

/* FAILED to decompile: _ZdlPvm @ 0x140F8 */

/* FAILED to decompile: strncpy @ 0x14100 */

/* FAILED to decompile: __dynamic_cast @ 0x14108 */

/* FAILED to decompile: __cxa_atexit @ 0x14110 */

/* FAILED to decompile: _ZdaPv @ 0x14118 */

/* FAILED to decompile: strcmp @ 0x14128 */

/* FAILED to decompile: __cxa_rethrow @ 0x14130 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x14138 */

/* FAILED to decompile: abort @ 0x14140 */

/* FAILED to decompile: __cxa_end_catch @ 0x14148 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x14150 */

/* FAILED to decompile: __cxa_throw @ 0x14158 */

/* FAILED to decompile: _Unwind_Resume @ 0x14168 */

/* FAILED to decompile: __printf_chk @ 0x14170 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x14178 */

/* FAILED to decompile: __gmon_start__ @ 0x14188 */

/* Total functions decompiled: 70, failed: 25 */
