/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_Os_g
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
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: main @ 0x18D0 */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x18E8 */
void __cdecl GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  std::ios_base::Init::Init(&std::__ioinit);
  __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
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
int __cdecl test_cpp_member_func()
{
  char *v0; // x0
  SimpleClass obj; // [xsp+10h] [xbp+10h] BYREF

  v0 = strncpy(obj.name, "Test", 0x1Fu);
  obj.name[31] = 0;
  return strlen(v0) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1AC0 */
int __cdecl test_cpp_constructor()
{
  return LifecycleClass::instance_count + 21 + 1000 * LifecycleClass::instance_count;
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1AD8 */
int __fastcall call_virtual_func(Base *obj, int x)
{
  return (*obj->_vptr.Base)(obj, x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1AE8 */
int __cdecl test_cpp_virtual_func()
{
  int v0; // w19
  Base base; // [xsp+20h] [xbp+20h] BYREF
  Derived derived; // [xsp+28h] [xbp+28h] BYREF

  base._vptr.Base = (int (**)(...))&off_13868;
  derived._vptr.Base = (int (**)(...))&off_13898;
  derived.multiplier = 3;
  v0 = call_virtual_func(&base, 5);
  return v0 + 21 + call_virtual_func(&derived, 5);
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1B78 */
int __cdecl test_cpp_multiple_inheritance()
{
  return 71;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1B80 */
int __cdecl test_cpp_operator_overload()
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x1B88 */
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


/* Function: _Z23test_cpp_template_classv @ 0x1C30 */
int __cdecl test_cpp_template_class()
{
  int v0; // w1
  int r2[10]; // [xsp+28h] [xbp+28h] BYREF
  int v3; // [xsp+50h] [xbp+50h]

  v3 = 1;
  r2[0] = 10;
  Container<int>::push((Container<int> *const)r2, 20);
  Container<int>::push((Container<int> *const)r2, 30);
  v0 = r2[0];
  if ( v3 <= 0 )
    v0 = 0;
  return v3 + v0 + 3;
}


/* Function: _Z15test_cpp_lambdav @ 0x1CC0 */
int __cdecl test_cpp_lambda()
{
  return 85;
}


/* Function: _Z13test_cpp_rttiv @ 0x1CC8 */
int __cdecl test_cpp_rtti()
{
  __int64 *v0; // x21
  void *v1; // x20
  __int64 v2; // x23
  char *v3; // x22
  int v4; // w24
  int v5; // w19
  int v6; // w19
  int v7; // w19

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
int __cdecl test_cpp_smart_ptr()
{
  __int64 v0; // x0
  std::unique_ptr<int> ptr2; // [xsp+30h] [xbp+30h] BYREF
  std::unique_ptr<int []> arr; // [xsp+40h] [xbp+40h] BYREF

  *(_QWORD *)&ptr2._M_t._M_t._M_head_impl.gap0 = 0;
  ptr2._M_t._M_t._M_head_impl = (int *)operator new(4u);
  *ptr2._M_t._M_t._M_head_impl = 200;
  v0 = operator new[](0x14u);
  *(_QWORD *)&arr._M_t._M_t._M_head_impl.gap0 = v0;
  *(_QWORD *)v0 = 0x200000001LL;
  *(_QWORD *)(v0 + 8) = 0x400000003LL;
  *(_DWORD *)(v0 + 16) = 5;
  std::unique_ptr<int []>::~unique_ptr(&arr);
  std::unique_ptr<int>::~unique_ptr((std::unique_ptr<int> *const)&ptr2._M_t._M_t.std::_Head_base<0,int*,false>);
  std::unique_ptr<int>::~unique_ptr(&ptr2);
  return 703;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1EF8 */
int __cdecl test_cpp_diamond_inheritance()
{
  int v0; // w19
  int v1; // w19
  _BYTE obj[44]; // [xsp+28h] [xbp+28h] BYREF

  *(_QWORD *)obj = &off_13AC8;
  *(_QWORD *)&obj[32] = &off_13B30;
  *(_QWORD *)&obj[16] = &off_13AF8;
  *(_DWORD *)&obj[40] = 50;
  v0 = `virtual thunk to'DiamondDerived::func((DiamondDerived *)&obj[32]);
  *(_DWORD *)&obj[40] = 100;
  v1 = v0 + `virtual thunk to'DiamondDerived::func((DiamondDerived *)&obj[32]);
  DiamondDerived::~DiamondDerived((DiamondDerived *const)obj);
  return v1;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1FA0 */
void __cdecl __noreturn test_cpp_oo_features()
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
int __fastcall Base::virtual_func(Base *const this, int x)
{
  return x + 1;
}


/* Function: _ZNK4Base7getNameEv @ 0x20E0 */
const char *__fastcall Base::getName(const Base *const this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x20EC */
void __fastcall Base::~Base(Base *const this)
{
  ;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x20F0 */
int __fastcall Derived::virtual_func(Derived *const this, int x)
{
  return x * this->multiplier;
}


/* Function: _ZNK7Derived7getNameEv @ 0x20FC */
const char *__fastcall Derived::getName(const Derived *const this)
{
  return "Derived";
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x2108 */
int __fastcall MultiDerived::funcA(MultiDerived *const this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x2110 */
int __fastcall MultiDerived::funcB(MultiDerived *const this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x2118 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZN11VirtualBase4funcEv @ 0x2120 */
int __fastcall VirtualBase::func(VirtualBase *const this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x2128 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *const this)
{
  ;
}


/* Function: _ZN7MiddleA4funcEv @ 0x212C */
int __fastcall MiddleA::func(MiddleA *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 150;
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x2144 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return MiddleA::func((MiddleA *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 3)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x2154 */
int __fastcall MiddleB::func(MiddleB *const this)
{
  return *(int *)((char *)&this->dataB + *((_QWORD *)this->_vptr.MiddleB - 3)) + 200;
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x216C */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return MiddleB::func((MiddleB *)((char *)this + *((_QWORD *)this->_vptr.MiddleB - 3)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x217C */
int __fastcall DiamondDerived::func(DiamondDerived *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 250;
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x2194 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 3)));
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x21A4 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZN7MiddleAD1Ev @ 0x21AC */
void __fastcall MiddleA::~MiddleA(MiddleA *const this)
{
  this->_vptr.MiddleA = (int (**)(...))&off_138E0;
  *((_QWORD *)&this->dataA + 1) = &off_13918;
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x21C8 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  _QWORD *v1; // x3

  v1 = (int (***)(...))((char *)&this->_vptr.MiddleA + *((_QWORD *)this->_vptr.MiddleA - 4));
  *v1 = &off_138E0;
  v1[2] = &off_13918;
}


/* Function: _ZN7MiddleBD1Ev @ 0x21F0 */
void __fastcall MiddleB::~MiddleB(MiddleB *const this)
{
  this->_vptr.MiddleB = (int (**)(...))&off_13958;
  *((_QWORD *)&this->dataB + 1) = &off_13990;
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x220C */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  _QWORD *v1; // x3

  v1 = (int (***)(...))((char *)&this->_vptr.MiddleB + *((_QWORD *)this->_vptr.MiddleB - 4));
  *v1 = &off_13958;
  v1[2] = &off_13990;
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x2234 */
int __fastcall RTTIDerivedA::getType(const RTTIDerivedA *const this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x223C */
int __fastcall RTTIDerivedB::getType(const RTTIDerivedB *const this)
{
  return 2;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x2244 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  ;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x2248 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  ;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x224C */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *const this)
{
  ;
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x2250 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  ;
}


/* Function: _ZN7DerivedD2Ev @ 0x2254 */
void __fastcall Derived::~Derived(Derived *const this)
{
  ;
}


/* Function: _ZN4BaseD0Ev @ 0x2258 */
void __fastcall Base::~Base(Base *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7DerivedD0Ev @ 0x2260 */
void __fastcall Derived::~Derived(Derived *const this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x2268 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *const this)
{
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x2270 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x2278 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *const this)
{
  operator delete(this, 0x10u);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x2280 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x2288 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  operator delete(this, 8u);
}


/* Function: _ZN7MiddleAD0Ev @ 0x2290 */
void __fastcall MiddleA::~MiddleA(MiddleA *const this)
{
  this->_vptr.MiddleA = (int (**)(...))&off_138E0;
  *((_QWORD *)&this->dataA + 1) = &off_13918;
  operator delete(this, 0x20u);
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x22B0 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA((MiddleA *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4)));
}


/* Function: _ZN7MiddleBD0Ev @ 0x22C0 */
void __fastcall MiddleB::~MiddleB(MiddleB *const this)
{
  this->_vptr.MiddleB = (int (**)(...))&off_13958;
  *((_QWORD *)&this->dataB + 1) = &off_13990;
  operator delete(this, 0x20u);
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x22E0 */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB((MiddleB *)((char *)this + *((_QWORD *)this->_vptr.MiddleB - 4)));
}


/* Function: _ZN7MiddleAD4Ev @ 0x22F0 */
void __fastcall MiddleA::~MiddleA(MiddleA *const this, const int __in_chrg, const void **const __vtt_parm)
{
  int (**v3)(...); // x3
  int (**v4)(...); // x1
  __int64 v5; // x2

  if ( __in_chrg )
    v3 = (int (**)(...))&off_138E0;
  else
    v3 = (int (**)(...))*__vtt_parm;
  this->_vptr.MiddleA = v3;
  if ( __in_chrg )
  {
    v5 = 16;
    v4 = (int (**)(...))&off_13918;
  }
  else
  {
    v4 = (int (**)(...))__vtt_parm[1];
    v5 = (__int64)*(v3 - 3);
  }
  *(int (***)(...))((char *)&this->_vptr.MiddleA + v5) = v4;
}


/* Function: _ZN7MiddleAD2Ev @ 0x232C */
void __fastcall MiddleA::~MiddleA(MiddleA *const this, const void **const __vtt_parm)
{
  MiddleA::~MiddleA(this, 0, __vtt_parm);
}


/* Function: _ZN7MiddleBD4Ev @ 0x2338 */
void __fastcall MiddleB::~MiddleB(MiddleB *const this, const int __in_chrg, const void **const __vtt_parm)
{
  int (**v3)(...); // x3
  int (**v4)(...); // x1
  __int64 v5; // x2

  if ( __in_chrg )
    v3 = (int (**)(...))&off_13958;
  else
    v3 = (int (**)(...))*__vtt_parm;
  this->_vptr.MiddleB = v3;
  if ( __in_chrg )
  {
    v5 = 16;
    v4 = (int (**)(...))&off_13990;
  }
  else
  {
    v4 = (int (**)(...))__vtt_parm[1];
    v5 = (__int64)*(v3 - 3);
  }
  *(int (***)(...))((char *)&this->_vptr.MiddleB + v5) = v4;
}


/* Function: _ZN7MiddleBD2Ev @ 0x2374 */
void __fastcall MiddleB::~MiddleB(MiddleB *const this, const void **const __vtt_parm)
{
  MiddleB::~MiddleB(this, 0, __vtt_parm);
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x2380 */
int __fastcall template_max<int>(int a, int b)
{
  if ( a < b )
    return b;
  return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x238C */
double __fastcall template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x2398 */
void __fastcall template_swap<int>(int *a, int *b)
{
  int v2; // w2

  v2 = *a;
  *a = *b;
  *b = v2;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x23AC */
void __fastcall Container<int>::Container(Container<int> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x23B4 */
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


/* Function: _ZNK9ContainerIiE3getEi @ 0x23D0 */
int __fastcall Container<int>::get(const Container<int> *const this, int idx)
{
  if ( idx < 0 || this->size <= idx )
    return 0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x23F0 */
int __fastcall Container<int>::getSize(const Container<int> *const this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x23F8 */
void __fastcall Container<double>::Container(Container<double> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x2400 */
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


/* Function: _ZNK9ContainerIdE3getEi @ 0x241C */
double __fastcall Container<double>::get(const Container<double> *const this, int idx)
{
  if ( idx < 0 || this->size <= idx )
    return 0.0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x243C */
int __fastcall Container<double>::getSize(const Container<double> *const this)
{
  return this->size;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x2444 */
void __fastcall std::unique_ptr<int>::~unique_ptr(std::unique_ptr<int> *const this)
{
  void *v1; // x0

  v1 = *(void **)&this->_M_t._M_t._M_head_impl.gap0;
  if ( v1 )
    operator delete(v1, 4u);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x2458 */
void __fastcall std::unique_ptr<int []>::~unique_ptr(std::unique_ptr<int []> *const this)
{
  void *v1; // x0

  v1 = *(void **)&this->_M_t._M_t._M_head_impl.gap0;
  if ( v1 )
    operator delete[](v1);
}


/* Function: _ZN14DiamondDerivedD4Ev @ 0x2468 */
void __fastcall DiamondDerived::~DiamondDerived(
        DiamondDerived *const this,
        const int __in_chrg,
        const void **const __vtt_parm)
{
  int (**v6)(...); // x0
  __int64 v7; // x0
  int (**v8)(...); // x1
  __int64 (__fastcall **v9)(DiamondDerived *__hidden); // x1
  const void **v10; // x2
  const void **v11; // x19
  const void **v12; // x1
  const void **v13; // x1

  if ( __in_chrg )
    v6 = (int (**)(...))&off_13AC8;
  else
    v6 = (int (**)(...))*__vtt_parm;
  this->_vptr.MiddleA = v6;
  if ( __in_chrg )
  {
    v7 = 32;
    v8 = (int (**)(...))&off_13B30;
  }
  else
  {
    v7 = (__int64)*(v6 - 3);
    v8 = (int (**)(...))__vtt_parm[5];
  }
  *(int (***)(...))((char *)&this->_vptr.MiddleA + v7) = v8;
  if ( __in_chrg )
    v9 = &off_13AF8;
  else
    v9 = (__int64 (__fastcall **)(DiamondDerived *__hidden))__vtt_parm[6];
  v10 = __vtt_parm + 3;
  v11 = __vtt_parm + 1;
  *((_QWORD *)&this->dataA + 1) = v9;
  v12 = (const void **)off_13A90;
  if ( !__in_chrg )
    v12 = v10;
  MiddleB::~MiddleB((MiddleB *const)(&this->dataA + 2), v12);
  v13 = (const void **)off_13A80;
  if ( !__in_chrg )
    v13 = v11;
  MiddleA::~MiddleA(this, v13);
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x2518 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *const this)
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
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4)));
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x253C */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *const this)
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
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4)));
}


/* Function: _ZN14DiamondDerivedD2Ev @ 0x257C */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *const this, const void **const __vtt_parm)
{
  DiamondDerived::~DiamondDerived(this, 0, __vtt_parm);
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
