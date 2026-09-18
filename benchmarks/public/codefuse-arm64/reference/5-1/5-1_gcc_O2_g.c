/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_O2_g
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
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: main @ 0x1120 */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x1140 */
void __cdecl GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  std::ios_base::Init::Init(&std::__ioinit);
  __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
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
int __cdecl test_cpp_member_func()
{
  char *v0; // x0
  SimpleClass obj; // [xsp+10h] [xbp+10h] BYREF

  v0 = strncpy(obj.name, "Test", 0x1Fu);
  obj.name[31] = 0;
  return strlen(v0) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1310 */
int __cdecl test_cpp_constructor()
{
  return LifecycleClass::instance_count + 21 + 1000 * LifecycleClass::instance_count;
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1330 */
int __fastcall call_virtual_func(Base *obj, int x)
{
  return (*obj->_vptr.Base)(obj, x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1340 */
int __cdecl test_cpp_virtual_func()
{
  return 42;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1350 */
int __cdecl test_cpp_multiple_inheritance()
{
  return 71;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1360 */
int __cdecl test_cpp_diamond_inheritance()
{
  return 650;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1370 */
int __cdecl test_cpp_operator_overload()
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1380 */
int __cdecl test_cpp_template_func()
{
  int v0; // w19
  double v1; // d8
  int a; // [xsp+20h] [xbp+20h] BYREF
  int b; // [xsp+24h] [xbp+24h] BYREF

  v0 = template_max<int>(3, 7);
  v1 = template_max<double>(2.5, 1.5);
  a = 10;
  b = 20;
  template_swap<int>(&a, &b);
  return (int)v1 + v0 + a + b;
}


/* Function: _Z23test_cpp_template_classv @ 0x1420 */
int __cdecl test_cpp_template_class()
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x1430 */
int __cdecl test_cpp_lambda()
{
  return 85;
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x1440 */
int __cdecl test_cpp_smart_ptr()
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x1450 */
int __cdecl test_cpp_rtti()
{
  int v0; // w19
  __int64 *v1; // x21
  void *v2; // x20
  __int64 v3; // x24
  const char *v4; // x23
  int v5; // w25
  int v6; // w19
  const char *v7; // x0
  int v8; // w19

  v0 = 10;
  v1 = (__int64 *)operator new(8u);
  *v1 = (__int64)off_12C28;
  v2 = (void *)operator new(8u);
  v3 = *v1;
  v4 = *(const char **)(*(_QWORD *)(*v1 - 8) + 8LL);
  *(_QWORD *)v2 = off_12C50;
  v5 = *(unsigned __int8 *)v4;
  if ( v4 != "12RTTIDerivedA" )
  {
    v0 = 0;
    if ( v5 != 42 )
    {
      if ( !strcmp(v4, "12RTTIDerivedA") )
        v0 = 10;
      else
        v0 = 0;
    }
  }
  v6 = v0 + 20;
  if ( __dynamic_cast(
         v1,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v6 += 100;
  }
  if ( __dynamic_cast(
         v2,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v6 += 200;
  }
  if ( v5 == 42 )
    v7 = v4 + 1;
  else
    v7 = v4;
  v8 = v6 + strlen(v7);
  (*(void (__fastcall **)(__int64 *))(v3 + 8))(v1);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v2 + 8LL))(v2);
  return v8;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x15B0 */
void __cdecl __noreturn test_cpp_oo_features()
{
  int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  char v4[36]; // [xsp+24h] [xbp+24h] BYREF

  puts(asc_1B10);
  strncpy(v4, "Test", 0x1Fu);
  v4[31] = 0;
  v0 = strlen(v4);
  __printf_chk(1, &unk_1B38, (unsigned int)(v0 + 4700));
  v1 = test_cpp_constructor();
  __printf_chk(1, &unk_1B58, v1);
  __printf_chk(1, &unk_1B78, 42);
  __printf_chk(1, &unk_1B98, 71);
  v2 = test_cpp_diamond_inheritance();
  __printf_chk(1, &unk_1BB8, v2);
  __printf_chk(1, &unk_1BD8, 22);
  v3 = test_cpp_template_func();
  __printf_chk(1, &unk_1BF8, v3);
  __printf_chk(1, &unk_1C18, 16);
  __printf_chk(1, &unk_1C38, 85);
  test_cpp_exception();
}


/* Function: _ZN4Base12virtual_funcEi @ 0x1740 */
int __fastcall Base::virtual_func(Base *const this, int x)
{
  return x + 1;
}


/* Function: _ZNK4Base7getNameEv @ 0x1750 */
const char *__fastcall Base::getName(const Base *const this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x1760 */
void __fastcall Base::~Base(Base *const this)
{
  ;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x1770 */
int __fastcall Derived::virtual_func(Derived *const this, int x)
{
  return x * this->multiplier;
}


/* Function: _ZNK7Derived7getNameEv @ 0x1780 */
const char *__fastcall Derived::getName(const Derived *const this)
{
  return "Derived";
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x1790 */
int __fastcall MultiDerived::funcA(MultiDerived *const this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x17A0 */
int __fastcall MultiDerived::funcB(MultiDerived *const this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x17B0 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZN7MiddleA4funcEv @ 0x17C0 */
int __fastcall MiddleA::func(MiddleA *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 150;
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x17E0 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(int *)((char *)&this->dataA
                               + *((_QWORD *)this->_vptr.MiddleA - 3)
                               + *(*(_QWORD **)((char *)&this->_vptr.MiddleA + *((_QWORD *)this->_vptr.MiddleA - 3)) - 3))
                      + 150);
}


/* Function: _ZN7MiddleB4funcEv @ 0x1810 */
int __fastcall MiddleB::func(MiddleB *const this)
{
  return *(int *)((char *)&this->dataB + *((_QWORD *)this->_vptr.MiddleB - 3)) + 200;
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x1830 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(int *)((char *)&this->dataB
                               + *((_QWORD *)this->_vptr.MiddleB - 3)
                               + *(*(_QWORD **)((char *)&this->_vptr.MiddleB + *((_QWORD *)this->_vptr.MiddleB - 3)) - 3))
                      + 200);
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x1860 */
int __fastcall DiamondDerived::func(DiamondDerived *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 250;
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x1880 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(int *)((char *)&this->dataA
                               + *((_QWORD *)this->_vptr.MiddleA - 3)
                               + *(*(_QWORD **)((char *)&this->_vptr.MiddleA + *((_QWORD *)this->_vptr.MiddleA - 3)) - 3))
                      + 250);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x18A4 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*((_QWORD *)&this[-1].dataB + 1) - 24LL) - 8) + 250);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x18C0 */
int __fastcall RTTIDerivedA::getType(const RTTIDerivedA *const this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x18D0 */
int __fastcall RTTIDerivedB::getType(const RTTIDerivedB *const this)
{
  return 2;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x18E0 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  ;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x18F0 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  ;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x1900 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *const this)
{
  ;
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x1904 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x1910 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x1920 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *const this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x1924 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN7DerivedD2Ev @ 0x1930 */
void __fastcall Derived::~Derived(Derived *const this)
{
  ;
}


/* Function: _ZN4BaseD0Ev @ 0x1940 */
void __fastcall Base::~Base(Base *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7DerivedD0Ev @ 0x1950 */
void __fastcall Derived::~Derived(Derived *const this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x1960 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *const this)
{
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x1970 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  operator delete(&this[-1].BaseB, 0x20u);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x1980 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x1990 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x19A0 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *const this)
{
  operator delete(this, 0x30u);
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x19B0 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4), 0x30u);
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x19C4 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  operator delete(&this[-1].dataB + 2, 0x30u);
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x19D0 */
int __fastcall template_max<int>(int a, int b)
{
  if ( a < b )
    return b;
  return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x19E0 */
double __fastcall template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x19F0 */
void __fastcall template_swap<int>(int *a, int *b)
{
  int v2; // w2

  v2 = *a;
  *a = *b;
  *b = v2;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x1A10 */
void __fastcall Container<int>::Container(Container<int> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x1A20 */
void __fastcall Container<int>::push(Container<int> *const this, int value)
{
  int size; // w2

  size = this->size;
  if ( size <= 9 )
  {
    this->size = size + 1;
    this->data[size] = value;
  }
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x1A40 */
int __fastcall Container<int>::get(const Container<int> *const this, int idx)
{
  int result; // w0

  result = 0;
  if ( (idx & 0x80000000) == 0 )
  {
    result = 0;
    if ( this->size > idx )
      return this->data[idx];
  }
  return result;
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x1A70 */
int __fastcall Container<int>::getSize(const Container<int> *const this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x1A80 */
void __fastcall Container<double>::Container(Container<double> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x1A90 */
void __fastcall Container<double>::push(Container<double> *const this, double value)
{
  int size; // w1

  size = this->size;
  if ( size <= 9 )
  {
    this->size = size + 1;
    this->data[size] = value;
  }
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x1AB0 */
double __fastcall Container<double>::get(const Container<double> *const this, int idx)
{
  double result; // d0

  result = 0.0;
  if ( (idx & 0x80000000) == 0 && this->size > idx )
    return this->data[idx];
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x1AD0 */
int __fastcall Container<double>::getSize(const Container<double> *const this)
{
  return this->size;
}


/* Function: .term_proc @ 0x1AD8 */
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
