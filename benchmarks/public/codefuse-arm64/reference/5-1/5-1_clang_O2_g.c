/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_clang_O2_g
 * Processor: arm
 */

/* Function: .init_proc @ 0xD48 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_D60 @ 0xD60 */
void sub_D60()
{
  JUMPOUT(0);
}


/* Function: _GLOBAL__sub_I_5_1.cpp @ 0xEC0 */
void __cdecl GLOBAL__sub_I_5_1_cpp()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _start @ 0xF00 */
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


/* Function: call_weak_fn @ 0xF34 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xF50 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0xF80 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xFC0 */
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


/* Function: frame_dummy @ 0x1010 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1014 */
int __cdecl test_cpp_member_func()
{
  _BYTE v1[31]; // [xsp+Ch] [xbp-24h] BYREF
  char v2; // [xsp+2Bh] [xbp-5h]

  v2 = 0;
  *(_OWORD *)v1 = *(_OWORD *)"Test";
  *(_OWORD *)&v1[15] = xmmword_175B;
  return strlen(v1) + 4700;
}


/* Function: _Z20test_cpp_constructorv @ 0x1064 */
int __cdecl test_cpp_constructor()
{
  return 1001 * LifecycleClass::instance_count + 21;
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x107C */
int __fastcall call_virtual_func(Base *obj, int x)
{
  return ((__int64 (__fastcall *)(Base *, int))*obj->_vptr$Base)(obj, x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1088 */
int __cdecl test_cpp_virtual_func()
{
  return 42;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1090 */
int __cdecl test_cpp_multiple_inheritance()
{
  return 71;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1098 */
int __cdecl test_cpp_diamond_inheritance()
{
  return 650;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x10A0 */
int __cdecl test_cpp_operator_overload()
{
  return 22;
}


/* Function: _Z22test_cpp_template_funcv @ 0x10A8 */
int __cdecl test_cpp_template_func()
{
  return 39;
}


/* Function: _Z23test_cpp_template_classv @ 0x10B0 */
int __cdecl test_cpp_template_class()
{
  return 16;
}


/* Function: _Z15test_cpp_lambdav @ 0x10B8 */
int __cdecl test_cpp_lambda()
{
  return 85;
}


/* Function: _Z18test_cpp_exceptionv @ 0x10C0 */
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x11B0 */
int __cdecl test_cpp_smart_ptr()
{
  return 703;
}


/* Function: _Z13test_cpp_rttiv @ 0x11B8 */
int __cdecl test_cpp_rtti()
{
  _QWORD *v0; // x19
  void *v1; // x20
  int v2; // w22
  int v3; // w21

  v0 = (_QWORD *)operator new(8u);
  *v0 = &off_11D58;
  v1 = (void *)operator new(8u);
  *(_QWORD *)v1 = &off_11D80;
  if ( __dynamic_cast(
         v0,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v2 = 130;
  }
  else
  {
    v2 = 30;
  }
  if ( __dynamic_cast(
         v1,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v3 = v2 + 200;
  }
  else
  {
    v3 = v2;
  }
  operator delete(v0);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v1 + 8LL))(v1);
  return v3 + 14;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x1278 */
void __cdecl __noreturn test_cpp_oo_features()
{
  int v0; // w0
  _BYTE v1[31]; // [xsp+Ch] [xbp-24h] BYREF
  char v2; // [xsp+2Bh] [xbp-5h]

  puts(asc_1728);
  v2 = 0;
  *(_OWORD *)v1 = *(_OWORD *)"Test";
  *(_OWORD *)&v1[15] = xmmword_175B;
  v0 = strlen(v1);
  printf(aCppL301D, (unsigned int)(v0 + 4700));
  printf(aCppL302D, (unsigned int)(1001 * LifecycleClass::instance_count + 21));
  printf(aCppL303D, 42);
  printf(aCppL304D, 71);
  printf(aCppL305D, 650);
  printf(aCppL306D, 22);
  printf(aCppL307D, 39);
  printf(aCppL308D, 16);
  printf(aCppL309D, 85);
  test_cpp_exception();
}


/* Function: sub_1370 @ 0x1370 */
// positive sp value has been detected, the output may be wrong!
__int64 __fastcall sub_1370(unsigned int a1)
{
  _QWORD *v1; // x19
  void *v2; // x20
  int v3; // w22
  int v4; // w21

  printf(aCppL401D, a1);
  printf(aCppL402D, 703);
  v1 = (_QWORD *)operator new(8u);
  *v1 = &off_11D58;
  v2 = (void *)operator new(8u);
  *(_QWORD *)v2 = &off_11D80;
  if ( __dynamic_cast(
         v1,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
         0) )
  {
    v3 = 130;
  }
  else
  {
    v3 = 30;
  }
  if ( __dynamic_cast(
         v2,
         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
         0) )
  {
    v4 = v3 + 200;
  }
  else
  {
    v4 = v3;
  }
  operator delete(v1);
  (*(void (__fastcall **)(void *))(*(_QWORD *)v2 + 8LL))(v2);
  return printf(aCppL403D, (unsigned int)(v4 + 14));
}


/* Function: main @ 0x144C */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: sub_1458 @ 0x1458 */
// positive sp value has been detected, the output may be wrong!
__int64 sub_1458()
{
  return 0;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x1464 */
int __fastcall template_max<int>(int a, int b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x1470 */
double __fastcall template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x147C */
void __fastcall template_swap<int>(int *a, int *b)
{
  int v2; // w9

  v2 = *a;
  *a = *b;
  *b = v2;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x1490 */
void __fastcall Container<int>::Container(Container<int> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x1498 */
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


/* Function: _ZNK9ContainerIiE3getEi @ 0x14B4 */
int __fastcall Container<int>::get(const Container<int> *this, int idx)
{
  int result; // w0

  result = 0;
  if ( (idx & 0x80000000) == 0 && this->size > idx )
    return this->data[idx];
  return result;
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x14D4 */
int __fastcall Container<int>::getSize(const Container<int> *this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x14DC */
void __fastcall Container<double>::Container(Container<double> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x14E4 */
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


/* Function: _ZNK9ContainerIdE3getEi @ 0x1500 */
double __fastcall Container<double>::get(const Container<double> *this, int idx)
{
  double result; // d0

  result = 0.0;
  if ( (idx & 0x80000000) == 0 && this->size > idx )
    return this->data[idx];
  return result;
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x151C */
int __fastcall Container<double>::getSize(const Container<double> *this)
{
  return this->size;
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x1524 */
// attributes: thunk
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x1528 */
int __fastcall RTTIDerivedA::getType(const RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x1530 */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
{
  ;
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x1534 */
// attributes: thunk
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x1538 */
int __fastcall RTTIDerivedB::getType(const RTTIDerivedB *this)
{
  return 2;
}


/* Function: .term_proc @ 0x1540 */
void term_proc()
{
  ;
}


/* FAILED to decompile: puts @ 0x12130 */

/* FAILED to decompile: strlen @ 0x12138 */

/* FAILED to decompile: __cxa_begin_catch @ 0x12140 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x12148 */

/* FAILED to decompile: __cxa_finalize @ 0x12150 */

/* FAILED to decompile: __libc_start_main @ 0x12160 */

/* FAILED to decompile: _ZdlPv @ 0x12168 */

/* FAILED to decompile: _Znwm @ 0x12170 */

/* FAILED to decompile: __dynamic_cast @ 0x12178 */

/* FAILED to decompile: __cxa_atexit @ 0x12180 */

/* FAILED to decompile: __cxa_rethrow @ 0x12190 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x12198 */

/* FAILED to decompile: abort @ 0x121A0 */

/* FAILED to decompile: __cxa_end_catch @ 0x121A8 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x121B0 */

/* FAILED to decompile: __cxa_throw @ 0x121B8 */

/* FAILED to decompile: _Unwind_Resume @ 0x121C0 */

/* FAILED to decompile: printf @ 0x121C8 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x121D0 */

/* FAILED to decompile: __gmon_start__ @ 0x121E0 */

/* Total functions decompiled: 43, failed: 20 */
