/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1638 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_1650 @ 0x1650 */
void sub_1650()
{
  JUMPOUT(0);
}


/* Function: _Z18test_cpp_exceptionv @ 0x1800 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: main @ 0x18D0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
  return 0;
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x18E8 */
__int64 GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _start @ 0x1940 */
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


/* Function: call_weak_fn @ 0x1974 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1990 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x19C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1A00 */
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


/* Function: frame_dummy @ 0x1A50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1A54 */
__int64 test_cpp_member_func(void)
{
  char *v0; // x0
  char dest[36]; // [xsp+14h] [xbp+14h] BYREF

  v0 = strncpy(dest, "Test", 0x1Fu);
  dest[31] = 0;
  return (unsigned int)strlen(v0) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1AC0 */
__int64 test_cpp_constructor(void)
{
  return (unsigned int)(LifecycleClass::instance_count + 21 + 1000 * LifecycleClass::instance_count);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1AD8 */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD))
{
  return (**a1)(a1);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1AE8 */
__int64 test_cpp_virtual_func(void)
{
  int v0; // w19
  __int64 (__fastcall **v2)(Base *__hidden, int); // [xsp+20h] [xbp+20h] BYREF
  __int64 (__fastcall **v3)(Derived *__hidden, int); // [xsp+28h] [xbp+28h] BYREF
  int v4; // [xsp+30h] [xbp+30h]

  v2 = &off_13868;
  v3 = &off_13898;
  v4 = 3;
  v0 = call_virtual_func((__int64 (__fastcall ***)(_QWORD))&v2);
  return v0 + 21 + (unsigned int)call_virtual_func((__int64 (__fastcall ***)(_QWORD))&v3);
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1B78 */
__int64 test_cpp_multiple_inheritance(void)
{
  return 71;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1B80 */
__int64 test_cpp_operator_overload(void)
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1B88 */
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


/* Function: _Z23test_cpp_template_classv @ 0x1C30 */
__int64 test_cpp_template_class(void)
{
  int v0; // w1
  _DWORD v2[10]; // [xsp+28h] [xbp+28h] BYREF
  int v3; // [xsp+50h] [xbp+50h]

  v3 = 1;
  v2[0] = 10;
  Container<int>::push(v2, 20);
  Container<int>::push(v2, 30);
  v0 = v2[0];
  if ( v3 <= 0 )
    v0 = 0;
  return (unsigned int)(v3 + v0 + 3);
}


/* Function: _Z15test_cpp_lambdav @ 0x1CC0 */
__int64 test_cpp_lambda(void)
{
  return 85;
}


/* Function: _Z13test_cpp_rttiv @ 0x1CC8 */
__int64 test_cpp_rtti(void)
{
  __int64 *v0; // x21
  void *v1; // x20
  __int64 v2; // x23
  char *v3; // x22
  int v4; // w24
  int v5; // w19
  int v6; // w19
  unsigned int v7; // w19

  v0 = (__int64 *)operator new(8u);
  *v0 = (__int64)off_13B58;
  v1 = (void *)operator new(8u);
  v2 = *v0;
  *(_QWORD *)v1 = off_13B80;
  v3 = *(char **)(*(_QWORD *)(v2 - 8) + 8LL);
  v4 = (unsigned __int8)*v3;
  if ( v3 == "12RTTIDerivedA" )
  {
    v5 = 10;
  }
  else if ( v4 == 42 )
  {
    v5 = 0;
  }
  else if ( !strcmp(*(const char **)(*(_QWORD *)(v2 - 8) + 8LL), "12RTTIDerivedA") )
  {
    v5 = 10;
  }
  else
  {
    v5 = 0;
  }
  v6 = v5 + 20;
  if ( __dynamic_cast(
         v0,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v6 += 100;
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
    ++v3;
  v7 = v6 + strlen(v3);
  (*(void (__fastcall **)(__int64 *))(v2 + 8))(v0);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v1 + 8LL))(v1);
  return v7;
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1E24 */
__int64 test_cpp_smart_ptr(void)
{
  __int64 v0; // x0
  __int64 v2; // [xsp+30h] [xbp+30h] BYREF
  _DWORD *v3; // [xsp+38h] [xbp+38h] BYREF
  __int64 v4; // [xsp+40h] [xbp+40h] BYREF

  v2 = 0;
  v3 = (_DWORD *)operator new(4u);
  *v3 = 200;
  v0 = operator new[](0x14u);
  v4 = v0;
  *(_QWORD *)v0 = 0x200000001LL;
  *(_QWORD *)(v0 + 8) = 0x400000003LL;
  *(_DWORD *)(v0 + 16) = 5;
  std::unique_ptr<int []>::~unique_ptr(&v4);
  std::unique_ptr<int>::~unique_ptr(&v3);
  std::unique_ptr<int>::~unique_ptr(&v2);
  return 703;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1EF8 */
__int64 test_cpp_diamond_inheritance(void)
{
  int v0; // w19
  unsigned int v1; // w19
  _QWORD v3[4]; // [xsp+28h] [xbp+28h] BYREF
  __int64 (__fastcall **v4)(DiamondDerived *__hidden); // [xsp+48h] [xbp+48h] BYREF
  int v5; // [xsp+50h] [xbp+50h]

  v3[0] = &off_13AC8;
  v4 = &off_13B30;
  v3[2] = &off_13AF8;
  v5 = 50;
  v0 = `virtual thunk to'DiamondDerived::func((DiamondDerived *)&v4);
  v5 = 100;
  v1 = v0 + `virtual thunk to'DiamondDerived::func((DiamondDerived *)&v4);
  DiamondDerived::~DiamondDerived((DiamondDerived *)v3);
  return v1;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1FA0 */
void __noreturn test_cpp_oo_features(void)
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0
  unsigned int v7; // w0
  unsigned int v8; // w0

  puts(asc_25B2);
  v0 = test_cpp_member_func();
  __printf_chk(1, &unk_25D6, v0);
  v1 = test_cpp_constructor();
  __printf_chk(1, &unk_25F4, v1);
  v2 = test_cpp_virtual_func();
  __printf_chk(1, &unk_2610, v2);
  v3 = test_cpp_multiple_inheritance();
  __printf_chk(1, &unk_262C, v3);
  v4 = test_cpp_diamond_inheritance();
  __printf_chk(1, &unk_2648, v4);
  v5 = test_cpp_operator_overload();
  __printf_chk(1, &unk_2665, v5);
  v6 = test_cpp_template_func();
  __printf_chk(1, &unk_2681, v6);
  v7 = test_cpp_template_class();
  __printf_chk(1, &unk_269D, v7);
  v8 = test_cpp_lambda();
  __printf_chk(1, &unk_26B9, v8);
  test_cpp_exception();
}


/* Function: _ZN4Base12virtual_funcEi @ 0x20D8 */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x20E0 */
const char *__fastcall Base::getName(Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x20EC */
void __fastcall Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x20F0 */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(a2 * *((_DWORD *)this + 2));
}


/* Function: _ZNK7Derived7getNameEv @ 0x20FC */
const char *__fastcall Derived::getName(Derived *this)
{
  return "Derived";
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x2108 */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x2110 */
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x2118 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZN11VirtualBase4funcEv @ 0x2120 */
__int64 __fastcall VirtualBase::func(VirtualBase *this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x2128 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  ;
}


/* Function: _ZN7MiddleA4funcEv @ 0x212C */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x2144 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return MiddleA::func((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x2154 */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x216C */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return MiddleB::func((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x217C */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x2194 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x21A4 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZN7MiddleAD1Ev @ 0x21AC */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  *(_QWORD *)this = &off_138E0;
  *((_QWORD *)this + 2) = &off_13918;
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x21C8 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  _QWORD *v1; // x3

  v1 = (_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL));
  *v1 = &off_138E0;
  v1[2] = &off_13918;
}


/* Function: _ZN7MiddleBD1Ev @ 0x21F0 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  *(_QWORD *)this = &off_13958;
  *((_QWORD *)this + 2) = &off_13990;
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x220C */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  _QWORD *v1; // x3

  v1 = (_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL));
  *v1 = &off_13958;
  v1[2] = &off_13990;
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x2234 */
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x223C */
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x2244 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  ;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x2248 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x224C */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x2250 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN7DerivedD2Ev @ 0x2254 */
void __fastcall Derived::~Derived(Derived *this)
{
  ;
}


/* Function: _ZN4BaseD0Ev @ 0x2258 */
void __fastcall Base::~Base(Base *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7DerivedD0Ev @ 0x2260 */
void __fastcall Derived::~Derived(Derived *this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x2268 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x2270 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x2278 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x2280 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x2288 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7MiddleAD0Ev @ 0x2290 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  *(_QWORD *)this = &off_138E0;
  *((_QWORD *)this + 2) = &off_13918;
  operator delete(this, 0x20u);
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x22B0 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN7MiddleBD0Ev @ 0x22C0 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  *(_QWORD *)this = &off_13958;
  *((_QWORD *)this + 2) = &off_13990;
  operator delete(this, 0x20u);
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x22E0 */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN7MiddleAD4Ev @ 0x22F0 */
void __fastcall MiddleA::~MiddleA(MiddleA *this, int a2, __int64 (__fastcall ***a3)(MiddleA *__hidden this))
{
  __int64 (__fastcall **v3)(MiddleA *__hidden); // x3
  __int64 (__fastcall **v4)(MiddleA *__hidden); // x1
  __int64 v5; // x2

  if ( a2 )
    v3 = &off_138E0;
  else
    v3 = *a3;
  *(_QWORD *)this = v3;
  if ( a2 )
  {
    v5 = 16;
    v4 = &off_13918;
  }
  else
  {
    v4 = a3[1];
    v5 = (__int64)*(v3 - 3);
  }
  *(_QWORD *)((char *)this + v5) = v4;
}


/* Function: _ZN7MiddleAD2Ev @ 0x232C */
void __fastcall MiddleA::~MiddleA(MiddleA *this, __int64 (__fastcall ***a2)(MiddleA *__hidden this))
{
  MiddleA::~MiddleA(this, 0, a2);
}


/* Function: _ZN7MiddleBD4Ev @ 0x2338 */
void __fastcall MiddleB::~MiddleB(MiddleB *this, int a2, __int64 (__fastcall ***a3)(MiddleB *__hidden this))
{
  __int64 (__fastcall **v3)(MiddleB *__hidden); // x3
  __int64 (__fastcall **v4)(MiddleB *__hidden); // x1
  __int64 v5; // x2

  if ( a2 )
    v3 = &off_13958;
  else
    v3 = *a3;
  *(_QWORD *)this = v3;
  if ( a2 )
  {
    v5 = 16;
    v4 = &off_13990;
  }
  else
  {
    v4 = a3[1];
    v5 = (__int64)*(v3 - 3);
  }
  *(_QWORD *)((char *)this + v5) = v4;
}


/* Function: _ZN7MiddleBD2Ev @ 0x2374 */
void __fastcall MiddleB::~MiddleB(MiddleB *this, __int64 (__fastcall ***a2)(MiddleB *__hidden this))
{
  MiddleB::~MiddleB(this, 0, a2);
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x2380 */
__int64 __fastcall template_max<int>(__int64 result, int a2)
{
  if ( (int)result < a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x238C */
double __fastcall template_max<double>(double result, double a2)
{
  if ( result <= a2 )
    return a2;
  return result;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x2398 */
int *__fastcall template_swap<int>(int *result, int *a2)
{
  int v2; // w2

  v2 = *result;
  *result = *a2;
  *a2 = v2;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x23AC */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x23B4 */
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


/* Function: _ZNK9ContainerIiE3getEi @ 0x23D0 */
__int64 __fastcall Container<int>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || *(_DWORD *)(a1 + 40) <= a2 )
    return 0;
  else
    return *(unsigned int *)(a1 + 4LL * a2);
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x23F0 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x23F8 */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x2400 */
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


/* Function: _ZNK9ContainerIdE3getEi @ 0x241C */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || *(_DWORD *)(a1 + 80) <= a2 )
    return 0.0;
  else
    return *(double *)(a1 + 8LL * a2);
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x243C */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x2444 */
void __fastcall std::unique_ptr<int>::~unique_ptr(void **a1)
{
  void *v1; // x0

  v1 = *a1;
  if ( v1 )
    operator delete(v1, 4u);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x2458 */
void __fastcall std::unique_ptr<int []>::~unique_ptr(void **a1)
{
  void *v1; // x0

  v1 = *a1;
  if ( v1 )
    operator delete[](v1);
}


/* Function: _ZN14DiamondDerivedD4Ev @ 0x2468 */
void __fastcall DiamondDerived::~DiamondDerived(
        DiamondDerived *this,
        int a2,
        __int64 (__fastcall ***a3)(DiamondDerived *__hidden this))
{
  __int64 (__fastcall **v6)(DiamondDerived *__hidden); // x0
  __int64 v7; // x0
  __int64 (__fastcall **v8)(DiamondDerived *__hidden); // x1
  __int64 (__fastcall **v9)(DiamondDerived *__hidden); // x1
  __int64 (__fastcall ***v10)(MiddleB *__hidden); // x2
  __int64 (__fastcall ***v11)(MiddleA *__hidden); // x19
  __int64 (__fastcall ***v12)(MiddleB *__hidden); // x1
  __int64 (__fastcall ***v13)(MiddleA *__hidden); // x1

  if ( a2 )
    v6 = &off_13AC8;
  else
    v6 = *a3;
  *(_QWORD *)this = v6;
  if ( a2 )
  {
    v7 = 32;
    v8 = &off_13B30;
  }
  else
  {
    v7 = (__int64)*(v6 - 3);
    v8 = a3[5];
  }
  *(_QWORD *)((char *)this + v7) = v8;
  if ( a2 )
    v9 = &off_13AF8;
  else
    v9 = a3[6];
  v10 = a3 + 3;
  v11 = a3 + 1;
  *((_QWORD *)this + 2) = v9;
  v12 = off_13A90;
  if ( !a2 )
    v12 = v10;
  MiddleB::~MiddleB((DiamondDerived *)((char *)this + 16), v12);
  v13 = off_13A80;
  if ( !a2 )
    v13 = v11;
  MiddleA::~MiddleA(this, v13);
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x2518 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this, 2, 0);
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x2524 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x252C */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x253C */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this);
  operator delete(this, 0x30u);
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x2564 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x256C */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN14DiamondDerivedD2Ev @ 0x257C */
void __fastcall DiamondDerived::~DiamondDerived(
        DiamondDerived *this,
        __int64 (__fastcall ***a2)(DiamondDerived *__hidden this))
{
  DiamondDerived::~DiamondDerived(this, 0, a2);
}


/* Function: .term_proc @ 0x2588 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _Znam @ 0x14090 */

/* FAILED to decompile: puts @ 0x140A0 */

/* FAILED to decompile: strlen @ 0x140A8 */

/* FAILED to decompile: __stack_chk_fail @ 0x140B0 */

/* FAILED to decompile: __cxa_begin_catch @ 0x140B8 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x140C8 */

/* FAILED to decompile: __cxa_finalize @ 0x140D0 */

/* FAILED to decompile: __libc_start_main @ 0x140E0 */

/* FAILED to decompile: _Znwm @ 0x140E8 */

/* FAILED to decompile: _ZdlPvm @ 0x140F0 */

/* FAILED to decompile: strncpy @ 0x140F8 */

/* FAILED to decompile: __dynamic_cast @ 0x14100 */

/* FAILED to decompile: __cxa_atexit @ 0x14108 */

/* FAILED to decompile: _ZdaPv @ 0x14110 */

/* FAILED to decompile: strcmp @ 0x14120 */

/* FAILED to decompile: __cxa_rethrow @ 0x14128 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x14130 */

/* FAILED to decompile: abort @ 0x14138 */

/* FAILED to decompile: __cxa_end_catch @ 0x14140 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x14148 */

/* FAILED to decompile: __cxa_throw @ 0x14150 */

/* FAILED to decompile: _Unwind_Resume @ 0x14160 */

/* FAILED to decompile: __printf_chk @ 0x14168 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x14170 */

/* FAILED to decompile: __gmon_start__ @ 0x14180 */

/* Total functions decompiled: 89, failed: 25 */
