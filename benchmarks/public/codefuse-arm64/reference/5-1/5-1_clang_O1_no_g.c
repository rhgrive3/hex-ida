/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_clang_O1_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1618 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_1630 @ 0x1630 */
void sub_1630()
{
  JUMPOUT(0);
}


/* Function: _GLOBAL__sub_I_5_1.cpp @ 0x17C0 */
__int64 GLOBAL__sub_I_5_1_cpp()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _start @ 0x1800 */
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


/* Function: call_weak_fn @ 0x1834 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1850 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x1880 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x18C0 */
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


/* Function: frame_dummy @ 0x1910 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1914 */
__int64 test_cpp_member_func(void)
{
  _BYTE v1[31]; // [xsp+Ch] [xbp-24h] BYREF
  char v2; // [xsp+2Bh] [xbp-5h]

  v2 = 0;
  *(_OWORD *)v1 = *(_OWORD *)"Test";
  *(_OWORD *)&v1[15] = xmmword_2689;
  return (unsigned int)strlen(v1) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1964 */
__int64 test_cpp_constructor(void)
{
  _DWORD *v0; // x0
  int v1; // w8
  __int64 i; // x9
  int v3; // w20

  v0 = (_DWORD *)operator new[](0x14u);
  v1 = 0;
  for ( i = 0; i != 5; ++i )
  {
    v0[i] = v1;
    v1 += 10;
  }
  v3 = v0[2] + ++LifecycleClass::instance_count;
  operator delete[](v0);
  return (unsigned int)(v3 + 1000 * --LifecycleClass::instance_count);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x19D0 */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD))
{
  return (**a1)(a1);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x19EC */
__int64 test_cpp_virtual_func(void)
{
  int v0; // w19
  __int64 v2; // [xsp+0h] [xbp-10h] BYREF
  int v3; // [xsp+8h] [xbp-8h]
  __int64 (__fastcall **v4)(Base *__hidden, int); // [xsp+28h] [xbp+18h] BYREF

  v4 = &off_139A8;
  v3 = 3;
  v0 = Base::virtual_func((Base *)&v4, 5);
  return v0 + (unsigned int)Derived::virtual_func((Derived *)&v2, 5) + 21;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1A5C */
__int64 test_cpp_multiple_inheritance(void)
{
  int v0; // w20
  __int64 (__fastcall **v2)(MultiDerived *__hidden); // [xsp+0h] [xbp-20h] BYREF
  int v3; // [xsp+8h] [xbp-18h]
  unsigned int (__fastcall **v4)(MultiDerived *__hidden); // [xsp+10h] [xbp-10h] BYREF
  int v5; // [xsp+18h] [xbp-8h]

  v2 = &off_13A30;
  v4 = (unsigned int (__fastcall **)(MultiDerived *__hidden))&off_13A60;
  v3 = 100;
  v5 = 200;
  v0 = MultiDerived::funcA((MultiDerived *)&v2);
  return v0 + (*v4)((MultiDerived *)&v4) + 1;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1ACC */
__int64 test_cpp_diamond_inheritance(void)
{
  int v0; // w0
  __int64 (__fastcall **v2)(DiamondDerived *__hidden); // [xsp+0h] [xbp-30h]
  __int64 (__fastcall **v3)(DiamondDerived *__hidden); // [xsp+10h] [xbp-20h]
  unsigned int (__fastcall **v4)(DiamondDerived *__hidden); // [xsp+20h] [xbp-10h] BYREF
  int v5; // [xsp+28h] [xbp-8h]

  v2 = &off_13B38;
  v4 = (unsigned int (__fastcall **)(DiamondDerived *__hidden))&off_13BA0;
  v3 = &off_13B68;
  v5 = 50;
  v0 = `virtual thunk to'DiamondDerived::func((DiamondDerived *)&v4);
  v5 = 100;
  return (*v4)((DiamondDerived *)&v4) + v0;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1B54 */
__int64 test_cpp_operator_overload(void)
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1B5C */
__int64 test_cpp_template_func(void)
{
  return 39;
}


/* Function: _Z23test_cpp_template_classv @ 0x1B64 */
__int64 test_cpp_template_class(void)
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x1B6C */
__int64 test_cpp_lambda(void)
{
  return 85;
}


/* Function: _Z18test_cpp_exceptionv @ 0x1B74 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1C64 */
__int64 test_cpp_smart_ptr(void)
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x1C6C */
__int64 test_cpp_rtti(void)
{
  __int64 *v0; // x19
  _QWORD *v1; // x0
  __int64 v2; // x8
  const void *v3; // x20
  const char *v4; // x21
  int v5; // w22
  const char *v6; // x0
  _BOOL4 v7; // w8
  int v8; // w23
  int v9; // w22
  const char *v10; // x0
  int v11; // w21

  v0 = (__int64 *)operator new(8u);
  *v0 = (__int64)off_13D58;
  v1 = (_QWORD *)operator new(8u);
  v2 = *v0;
  *v1 = 0;
  v3 = v1;
  *v1 = off_13D80;
  v4 = *(const char **)(*(_QWORD *)(v2 - 8) + 8LL);
  if ( v4 == "12RTTIDerivedA" )
  {
    v5 = 10;
  }
  else if ( *v4 == 42 )
  {
    v5 = 0;
  }
  else if ( !strcmp(v4, "12RTTIDerivedA") )
  {
    v5 = 10;
  }
  else
  {
    v5 = 0;
  }
  v6 = *(const char **)(*(_QWORD *)(*(_QWORD *)v3 - 8LL) + 8LL);
  if ( v6 == "12RTTIDerivedB" )
    v7 = 1;
  else
    v7 = *v6 != 42 && strcmp(v6, "12RTTIDerivedB") == 0;
  if ( v7 )
    v8 = v5 | 0x14;
  else
    v8 = v5;
  if ( __dynamic_cast(
         v0,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v8 += 100;
  }
  if ( __dynamic_cast(
         v3,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v9 = v8 + 200;
  }
  else
  {
    v9 = v8;
  }
  if ( *v4 == 42 )
    v10 = v4 + 1;
  else
    v10 = v4;
  v11 = strlen(v10);
  (*(void (__fastcall **)(__int64 *))(*v0 + 8))(v0);
  (*(void (__fastcall **)(const void *))(*(_QWORD *)v3 + 8LL))(v3);
  return (unsigned int)(v9 + v11);
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1E04 */
void __noreturn test_cpp_oo_features(void)
{
  int v0; // w0
  _DWORD *v1; // x0
  int v2; // w8
  __int64 i; // x9
  int v4; // w20
  __int64 v5; // x1
  int v6; // w19
  int v7; // w0
  int v8; // w0
  int v9; // w20
  int v10; // w0
  __int64 (__fastcall **v11)(Base *__hidden, int); // [xsp+8h] [xbp-38h] BYREF
  _BYTE v12[40]; // [xsp+10h] [xbp-30h] BYREF
  int v13; // [xsp+38h] [xbp-8h]

  puts(asc_25F9);
  *(_DWORD *)v12 = 10;
  *(_OWORD *)&v12[4] = *(_OWORD *)"Test";
  memset(&v12[19], 0, 17);
  v0 = strlen(&v12[4]);
  printf(aCppL301D, (unsigned int)(v0 + 4700));
  v1 = (_DWORD *)operator new[](0x14u);
  v2 = 0;
  for ( i = 0; i != 5; ++i )
  {
    v1[i] = v2;
    v2 += 10;
  }
  v4 = v1[2] + ++LifecycleClass::instance_count;
  operator delete[](v1);
  v5 = (unsigned int)(v4 + 1000 * --LifecycleClass::instance_count);
  printf(aCppL302D, v5);
  *(_DWORD *)&v12[8] = 3;
  v11 = &off_139A8;
  *(_QWORD *)v12 = &off_139E8;
  v6 = Base::virtual_func((Base *)&v11, 5);
  v7 = (**(__int64 (__fastcall ***)(_BYTE *, __int64))v12)(v12, 5);
  printf(aCppL303D, (unsigned int)(v6 + v7 + 21));
  *(_QWORD *)v12 = &off_13A30;
  *(_QWORD *)&v12[16] = &off_13A60;
  *(_DWORD *)&v12[8] = 100;
  *(_DWORD *)&v12[24] = 200;
  v8 = `non-virtual thunk to'MultiDerived::funcB((MultiDerived *)&v12[16]);
  printf(aCppL304D, (unsigned int)(v8 + 31));
  *(_QWORD *)v12 = &off_13B38;
  *(_QWORD *)&v12[32] = &off_13BA0;
  *(_QWORD *)&v12[16] = &off_13B68;
  v13 = 50;
  v9 = `virtual thunk to'DiamondDerived::func((DiamondDerived *)&v12[32]);
  *(_DWORD *)&v12[*(_QWORD *)(*(_QWORD *)v12 + 0xFFFFFFFFFFFFFFE8LL) + 8] = 100;
  v10 = (**(__int64 (__fastcall ***)(DiamondDerived *__hidden))&v12[32])((DiamondDerived *)&v12[32]);
  printf(aCppL305D, (unsigned int)(v10 + v9));
  printf(aCppL306D, 22);
  printf(aCppL307D, 39);
  printf(aCppL308D, 16);
  printf(aCppL309D, 85);
  test_cpp_exception();
}


/* Function: main @ 0x2050 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _ZN4Base12virtual_funcEi @ 0x2068 */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x2070 */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(*((_DWORD *)this + 2) * a2);
}


/* Function: _ZN4BaseD2Ev @ 0x207C */
void __fastcall Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x2080 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x2084 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x2088 */
__int64 __fastcall template_max<int>(__int64 result, int a2)
{
  if ( (int)result <= a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x2094 */
double __fastcall template_max<double>(double result, double a2)
{
  if ( result <= a2 )
    return a2;
  return result;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x20A0 */
int *__fastcall template_swap<int>(int *result, int *a2)
{
  int v2; // w9

  v2 = *result;
  *result = *a2;
  *a2 = v2;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x20B4 */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x20BC */
__int64 __fastcall Container<int>::push(__int64 result, int a2)
{
  __int64 v2; // x8

  v2 = *(int *)(result + 40);
  if ( (int)v2 <= 9 )
  {
    *(_DWORD *)(result + 40) = v2 + 1;
    *(_DWORD *)(result + 4 * v2) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x20D8 */
__int64 __fastcall Container<int>::get(__int64 a1, int a2)
{
  __int64 result; // x0

  result = 0;
  if ( (a2 & 0x80000000) == 0 && *(_DWORD *)(a1 + 40) > a2 )
    return *(unsigned int *)(a1 + 4LL * a2);
  return result;
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x20F8 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x2100 */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x2108 */
__int64 __fastcall Container<double>::push(__int64 result, double a2)
{
  __int64 v2; // x8

  v2 = *(int *)(result + 80);
  if ( (int)v2 <= 9 )
  {
    *(double *)(result + 8 * v2) = a2;
    *(_DWORD *)(result + 80) = v2 + 1;
  }
  return result;
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x2124 */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  double result; // d0

  result = 0.0;
  if ( (a2 & 0x80000000) == 0 && *(_DWORD *)(a1 + 80) > a2 )
    return *(double *)(a1 + 8LL * a2);
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x2140 */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: _ZNK4Base7getNameEv @ 0x2148 */
const char *__fastcall Base::getName(Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD0Ev @ 0x2154 */
void __fastcall Base::~Base(Base *this)
{
  operator delete(this);
}


/* Function: _ZNK7Derived7getNameEv @ 0x2168 */
const char *__fastcall Derived::getName(Derived *this)
{
  return "Derived";
}


/* Function: _ZN7DerivedD0Ev @ 0x2174 */
void __fastcall Derived::~Derived(Derived *this)
{
  operator delete(this);
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x2188 */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x2190 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(this);
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x21A4 */
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x21AC */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x21B4 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x21B8 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete((char *)this - 16);
}


/* Function: _ZN5BaseA5funcAEv @ 0x21D0 */
__int64 __fastcall BaseA::funcA(BaseA *this)
{
  return 10;
}


/* Function: _ZN5BaseAD2Ev @ 0x21D8 */
void __fastcall BaseA::~BaseA(BaseA *this)
{
  ;
}


/* Function: _ZN5BaseAD0Ev @ 0x21DC */
void __fastcall BaseA::~BaseA(BaseA *this)
{
  operator delete(this);
}


/* Function: _ZN5BaseB5funcBEv @ 0x21F0 */
__int64 __fastcall BaseB::funcB(BaseB *this)
{
  return 20;
}


/* Function: _ZN5BaseBD2Ev @ 0x21F8 */
void __fastcall BaseB::~BaseB(BaseB *this)
{
  ;
}


/* Function: _ZN5BaseBD0Ev @ 0x21FC */
void __fastcall BaseB::~BaseB(BaseB *this)
{
  operator delete(this);
}


/* Function: _ZN7MiddleA4funcEv @ 0x2210 */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZN7MiddleAD1Ev @ 0x2228 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  ;
}


/* Function: _ZN7MiddleAD0Ev @ 0x222C */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x2240 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 150);
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x2264 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x2268 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  operator delete((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL));
}


/* Function: _ZN7MiddleB4funcEv @ 0x2288 */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZN7MiddleBD1Ev @ 0x22A0 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  ;
}


/* Function: _ZN7MiddleBD0Ev @ 0x22A4 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x22B8 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 200);
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x22DC */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x22E0 */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  operator delete((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x2300 */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x2318 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete(this);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x232C */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*((_QWORD *)this - 2) - 24LL) - 8) + 250);
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x2344 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x2348 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this - 16);
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x2360 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this
                                  + *(_QWORD *)(*(_QWORD *)this - 24LL)
                                  + *(_QWORD *)(*(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) - 24LL)
                                  + 8)
                      + 250);
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x2384 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x2388 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL));
}


/* Function: _ZN11VirtualBase4funcEv @ 0x23A8 */
__int64 __fastcall VirtualBase::func(VirtualBase *this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x23B0 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  ;
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x23B4 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  operator delete(this);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x23C8 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x23DC */
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x23E4 */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
{
  ;
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x23E8 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x23FC */
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: .term_proc @ 0x2404 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _Znam @ 0x14140 */

/* FAILED to decompile: puts @ 0x14150 */

/* FAILED to decompile: strlen @ 0x14158 */

/* FAILED to decompile: __cxa_begin_catch @ 0x14160 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x14168 */

/* FAILED to decompile: __cxa_finalize @ 0x14170 */

/* FAILED to decompile: __libc_start_main @ 0x14180 */

/* FAILED to decompile: _ZdlPv @ 0x14188 */

/* FAILED to decompile: _Znwm @ 0x14190 */

/* FAILED to decompile: __dynamic_cast @ 0x14198 */

/* FAILED to decompile: __cxa_atexit @ 0x141A0 */

/* FAILED to decompile: _ZdaPv @ 0x141A8 */

/* FAILED to decompile: strcmp @ 0x141B8 */

/* FAILED to decompile: __cxa_rethrow @ 0x141C0 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x141C8 */

/* FAILED to decompile: abort @ 0x141D0 */

/* FAILED to decompile: __cxa_end_catch @ 0x141D8 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x141E0 */

/* FAILED to decompile: __cxa_throw @ 0x141E8 */

/* FAILED to decompile: _Unwind_Resume @ 0x141F8 */

/* FAILED to decompile: printf @ 0x14200 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x14208 */

/* FAILED to decompile: __gmon_start__ @ 0x14218 */

/* Total functions decompiled: 85, failed: 23 */
