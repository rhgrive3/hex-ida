/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_clang_O1_g
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
void __cdecl GLOBAL__sub_I_5_1_cpp()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
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
int __cdecl test_cpp_member_func()
{
  _BYTE v1[31]; // [xsp+Ch] [xbp-24h] BYREF
  char v2; // [xsp+2Bh] [xbp-5h]

  v2 = 0;
  *(_OWORD *)v1 = *(_OWORD *)"Test";
  *(_OWORD *)&v1[15] = xmmword_2689;
  return strlen(v1) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1964 */
int __cdecl test_cpp_constructor()
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
  return v3 + 1000 * --LifecycleClass::instance_count;
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x19D0 */
int __fastcall call_virtual_func(Base *obj, int x)
{
  return ((__int64 (__fastcall *)(Base *, int))*obj->_vptr$Base)(obj, x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x19EC */
int __cdecl test_cpp_virtual_func()
{
  int v0; // w19
  Derived v2; // [xsp+0h] [xbp-10h] BYREF
  Base v3; // [xsp+28h] [xbp+18h] BYREF

  v3._vptr$Base = (int (**)(void))&off_139A8;
  v2.multiplier = 3;
  v0 = Base::virtual_func(&v3, 5);
  return v0 + Derived::virtual_func(&v2, 5) + 21;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1A5C */
int __cdecl test_cpp_multiple_inheritance()
{
  int v0; // w20
  int v1; // w0
  MultiDerived v3; // [xsp+0h] [xbp-20h] BYREF

  v3._vptr$BaseA = (int (**)(void))&off_13A30;
  v3._vptr$BaseB = (int (**)(void))&off_13A60;
  v3.dataA = 100;
  v3.dataB = 200;
  v0 = MultiDerived::funcA(&v3);
  (*v3._vptr$BaseB)();
  return v0 + v1 + 1;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1ACC */
int __cdecl test_cpp_diamond_inheritance()
{
  int v0; // w0
  int v1; // w20
  int v2; // w0
  __int64 (__fastcall **v4)(DiamondDerived *__hidden); // [xsp+0h] [xbp-30h]
  __int64 (__fastcall **v5)(DiamondDerived *__hidden); // [xsp+10h] [xbp-20h]
  __int64 (__fastcall **v6)(DiamondDerived *__hidden); // [xsp+20h] [xbp-10h]
  int v7; // [xsp+28h] [xbp-8h]

  v4 = &off_13B38;
  v6 = &off_13BA0;
  v5 = &off_13B68;
  `virtual thunk to'DiamondDerived::func();
  v1 = v0;
  v7 = 100;
  `virtual thunk to'DiamondDerived::func();
  return v2 + v1;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1B54 */
int __cdecl test_cpp_operator_overload()
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1B5C */
int __cdecl test_cpp_template_func()
{
  return 39;
}


/* Function: _Z23test_cpp_template_classv @ 0x1B64 */
int __cdecl test_cpp_template_class()
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x1B6C */
int __cdecl test_cpp_lambda()
{
  return 85;
}


/* Function: _Z18test_cpp_exceptionv @ 0x1B74 */
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1C64 */
int __cdecl test_cpp_smart_ptr()
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x1C6C */
int __cdecl test_cpp_rtti()
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
  *v0 = (__int64)&off_13D58;
  v1 = (_QWORD *)operator new(8u);
  v2 = *v0;
  *v1 = 0;
  v3 = v1;
  *v1 = &off_13D80;
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
  return v9 + v11;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1E04 */
void __cdecl __noreturn test_cpp_oo_features()
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
  int v9; // w0
  int v10; // w20
  int v11; // w0
  Base v12; // [xsp+8h] [xbp-38h] BYREF
  _BYTE v13[40]; // [xsp+10h] [xbp-30h] BYREF
  int v14; // [xsp+38h] [xbp-8h]

  puts(asc_25F9);
  *(_DWORD *)v13 = 10;
  *(_OWORD *)&v13[4] = *(_OWORD *)"Test";
  memset(&v13[19], 0, 17);
  v0 = strlen(&v13[4]);
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
  *(_DWORD *)&v13[8] = 3;
  v12._vptr$Base = (int (**)(void))&off_139A8;
  *(_QWORD *)v13 = &off_139E8;
  v6 = Base::virtual_func(&v12, 5);
  v7 = (**(__int64 (__fastcall ***)(_BYTE *, __int64))v13)(v13, 5);
  printf(aCppL303D, (unsigned int)(v6 + v7 + 21));
  *(_QWORD *)v13 = &off_13A30;
  *(_QWORD *)&v13[16] = &off_13A60;
  *(_DWORD *)&v13[8] = 100;
  *(_DWORD *)&v13[24] = 200;
  `non-virtual thunk to'MultiDerived::funcB();
  printf(aCppL304D, (unsigned int)(v8 + 31));
  *(_QWORD *)v13 = &off_13B38;
  *(_QWORD *)&v13[32] = &off_13BA0;
  *(_QWORD *)&v13[16] = &off_13B68;
  v14 = 50;
  `virtual thunk to'DiamondDerived::func();
  v10 = v9;
  *(_DWORD *)&v13[*(_QWORD *)(*(_QWORD *)v13 + 0xFFFFFFFFFFFFFFE8LL) + 8] = 100;
  (**(void (__cdecl ***)())&v13[32])();
  printf(aCppL305D, (unsigned int)(v11 + v10));
  printf(aCppL306D, 22);
  printf(aCppL307D, 39);
  printf(aCppL308D, 16);
  printf(aCppL309D, 85);
  test_cpp_exception();
}


/* Function: sub_2008 @ 0x2008 */
// positive sp value has been detected, the output may be wrong!
__int64 __fastcall sub_2008(unsigned int a1)
{
  unsigned int v1; // w0

  printf(aCppL401D, a1);
  printf(aCppL402D, 703);
  v1 = test_cpp_rtti();
  return printf(aCppL403D, v1);
}


/* Function: main @ 0x2050 */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: sub_205C @ 0x205C */
// positive sp value has been detected, the output may be wrong!
__int64 sub_205C()
{
  return 0;
}


/* Function: _ZN4Base12virtual_funcEi @ 0x2068 */
int __fastcall Base::virtual_func(Base *this, int x)
{
  return x + 1;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x2070 */
int __fastcall Derived::virtual_func(Derived *this, int x)
{
  return this->multiplier * x;
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
int __fastcall template_max<int>(int a, int b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x2094 */
double __fastcall template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x20A0 */
void __fastcall template_swap<int>(int *a, int *b)
{
  int v2; // w9

  v2 = *a;
  *a = *b;
  *b = v2;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x20B4 */
void __fastcall Container<int>::Container(Container<int> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x20BC */
void __fastcall Container<int>::push(Container<int> *this, int value)
{
  __int64 size; // x8

  size = this->size;
  if ( (int)size <= 9 )
  {
    this->size = size + 1;
    this->data[size] = value;
  }
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x20D8 */
int __fastcall Container<int>::get(const Container<int> *this, int idx)
{
  int result; // w0

  result = 0;
  if ( (idx & 0x80000000) == 0 && this->size > idx )
    return this->data[idx];
  return result;
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x20F8 */
int __fastcall Container<int>::getSize(const Container<int> *this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x2100 */
void __fastcall Container<double>::Container(Container<double> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x2108 */
void __fastcall Container<double>::push(Container<double> *this, double value)
{
  __int64 size; // x8

  size = this->size;
  if ( (int)size <= 9 )
  {
    this->data[size] = value;
    this->size = size + 1;
  }
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x2124 */
double __fastcall Container<double>::get(const Container<double> *this, int idx)
{
  double result; // d0

  result = 0.0;
  if ( (idx & 0x80000000) == 0 && this->size > idx )
    return this->data[idx];
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x2140 */
int __fastcall Container<double>::getSize(const Container<double> *this)
{
  return this->size;
}


/* Function: _ZNK4Base7getNameEv @ 0x2148 */
const char *__fastcall Base::getName(const Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD0Ev @ 0x2154 */
void __fastcall Base::~Base(Base *this)
{
  operator delete(this);
}


/* Function: _ZNK7Derived7getNameEv @ 0x2168 */
const char *__fastcall Derived::getName(const Derived *this)
{
  return "Derived";
}


/* Function: _ZN7DerivedD0Ev @ 0x2174 */
void __fastcall Derived::~Derived(Derived *this)
{
  operator delete(this);
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x2188 */
int __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x2190 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(this);
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x21A4 */
int __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x21AC */
void __cdecl `non-virtual thunk to'MultiDerived::funcB()
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x21B4 */
void __cdecl `non-virtual thunk to'MultiDerived::~MultiDerived()
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x21B8 */
void __cdecl `non-virtual thunk to'MultiDerived::~MultiDerived()
{
  __int64 v0; // x0

  operator delete((void *)(v0 - 16));
}


/* Function: _ZN5BaseA5funcAEv @ 0x21D0 */
int __fastcall BaseA::funcA(BaseA *this)
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
int __fastcall BaseB::funcB(BaseB *this)
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
int __fastcall MiddleA::func(MiddleA *this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr$MiddleA - 3)) + 150;
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
void __cdecl `virtual thunk to'MiddleA::func()
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x2264 */
void __cdecl `virtual thunk to'MiddleA::~MiddleA()
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x2268 */
void __cdecl `virtual thunk to'MiddleA::~MiddleA()
{
  _QWORD *v0; // x0

  operator delete((char *)v0 + *(_QWORD *)(*v0 - 32LL));
}


/* Function: _ZN7MiddleB4funcEv @ 0x2288 */
int __fastcall MiddleB::func(MiddleB *this)
{
  return *(int *)((char *)&this->dataB + *((_QWORD *)this->_vptr$MiddleB - 3)) + 200;
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
void __cdecl `virtual thunk to'MiddleB::func()
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x22DC */
void __cdecl `virtual thunk to'MiddleB::~MiddleB()
{
  ;
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x22E0 */
void __cdecl `virtual thunk to'MiddleB::~MiddleB()
{
  _QWORD *v0; // x0

  operator delete((char *)v0 + *(_QWORD *)(*v0 - 32LL));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x2300 */
int __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr$MiddleA - 3)) + 250;
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x2318 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete(this);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x232C */
void __cdecl `non-virtual thunk to'DiamondDerived::func()
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x2344 */
void __cdecl `non-virtual thunk to'DiamondDerived::~DiamondDerived()
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x2348 */
void __cdecl `non-virtual thunk to'DiamondDerived::~DiamondDerived()
{
  __int64 v0; // x0

  operator delete((void *)(v0 - 16));
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x2360 */
void __cdecl `virtual thunk to'DiamondDerived::func()
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x2384 */
void __cdecl `virtual thunk to'DiamondDerived::~DiamondDerived()
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x2388 */
void __cdecl `virtual thunk to'DiamondDerived::~DiamondDerived()
{
  _QWORD *v0; // x0

  operator delete((char *)v0 + *(_QWORD *)(*v0 - 32LL));
}


/* Function: _ZN11VirtualBase4funcEv @ 0x23A8 */
int __fastcall VirtualBase::func(VirtualBase *this)
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
int __fastcall RTTIDerivedA::getType(const RTTIDerivedA *this)
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
int __fastcall RTTIDerivedB::getType(const RTTIDerivedB *this)
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

/* Total functions decompiled: 87, failed: 23 */
