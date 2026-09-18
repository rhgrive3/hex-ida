/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_clang_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1988 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_19A0 @ 0x19A0 */
void sub_19A0()
{
  JUMPOUT(0);
}


/* Function: __cxx_global_var_init @ 0x1B40 */
void __cdecl _cxx_global_var_init()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _GLOBAL__sub_I_5_1.cpp @ 0x1B80 */
void __cdecl GLOBAL__sub_I_5_1_cpp()
{
  _cxx_global_var_init();
}


/* Function: _start @ 0x1BC0 */
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


/* Function: call_weak_fn @ 0x1BF4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1C10 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x1C40 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1C80 */
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


/* Function: frame_dummy @ 0x1CD0 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1CD4 */
int __cdecl test_cpp_member_func()
{
  int v1; // [xsp+14h] [xbp-2Ch]
  int Value; // [xsp+18h] [xbp-28h]
  SimpleClass v3; // [xsp+1Ch] [xbp-24h] BYREF

  SimpleClass::SimpleClass(&v3, 5, "Test");
  SimpleClass::setValue(&v3, 10);
  Value = SimpleClass::getValue(&v3);
  v1 = SimpleClass::compute(&v3, 3);
  return Value + v1 + SimpleClass::getClassID();
}


/* Function: _Z20test_cpp_constructorv @ 0x1D4C */
int __cdecl test_cpp_constructor()
{
  int Data; // [xsp+18h] [xbp-28h]
  LifecycleClass obj; // [xsp+28h] [xbp-18h] BYREF
  int result; // [xsp+3Ch] [xbp-4h]

  result = 0;
  LifecycleClass::LifecycleClass(&obj, 5u);
  Data = LifecycleClass::getData(&obj, 2u);
  result += Data;
  result += LifecycleClass::getInstanceCount();
  LifecycleClass::~LifecycleClass(&obj);
  return result + 1000 * LifecycleClass::getInstanceCount();
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1DFC */
__int64 __fastcall call_virtual_func(Base *obj, unsigned int x)
{
  return ((__int64 (__fastcall *)(Base *, _QWORD))*obj->_vptr$Base)(obj, x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1E30 */
int __cdecl test_cpp_virtual_func()
{
  int v1; // [xsp+4h] [xbp-5Ch]
  int v2; // [xsp+1Ch] [xbp-44h]
  int r2; // [xsp+34h] [xbp-2Ch]
  int r1; // [xsp+38h] [xbp-28h]
  Derived derived; // [xsp+48h] [xbp-18h] BYREF
  Base base; // [xsp+58h] [xbp-8h] BYREF

  Base::Base(&base);
  Derived::Derived(&derived, 3);
  r1 = Base::virtual_func(&base, 5);
  r2 = Derived::virtual_func(&derived, 5);
  v2 = call_virtual_func(&base, 5u);
  v1 = r1 + r2 + v2 + call_virtual_func(&derived, 5u);
  Derived::~Derived(&derived);
  Base::~Base(&base);
  return v1;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1F50 */
int __cdecl test_cpp_multiple_inheritance()
{
  int v1; // [xsp+4h] [xbp-6Ch]
  MultiDerived *v2; // [xsp+18h] [xbp-58h]
  int r1; // [xsp+3Ch] [xbp-34h]
  MultiDerived obj; // [xsp+50h] [xbp-20h] BYREF

  MultiDerived::MultiDerived(&obj);
  obj.dataA = 100;
  obj.dataB = 200;
  v2 = 0;
  if ( &obj )
    v2 = (MultiDerived *)&obj.BaseB;
  r1 = ((__int64 (__fastcall *)(MultiDerived *))*obj._vptr$BaseA)(&obj);
  v1 = r1 + (*(__int64 (__fastcall **)(MultiDerived *))v2->_vptr$BaseA)(v2) + (&obj != v2);
  MultiDerived::~MultiDerived(&obj);
  return v1;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x2050 */
int __cdecl test_cpp_diamond_inheritance()
{
  int v1; // [xsp+4h] [xbp-6Ch]
  __int64 (__fastcall ***v2)(_QWORD); // [xsp+18h] [xbp-58h]
  int v3; // [xsp+34h] [xbp-3Ch]
  DiamondDerived var30; // [xsp+40h] [xbp-30h] BYREF

  DiamondDerived::DiamondDerived(&var30);
  *(int *)((char *)&var30.dataA + *((_QWORD *)var30._vptr$MiddleA - 3)) = 50;
  v2 = 0;
  if ( &var30 )
    v2 = (__int64 (__fastcall ***)(_QWORD))((char *)&var30 + *((_QWORD *)var30._vptr$MiddleA - 3));
  v3 = (**v2)(v2);
  *(int *)((char *)&var30.dataA + *((_QWORD *)var30._vptr$MiddleA - 3)) = 100;
  v1 = v3 + (**v2)(v2);
  DiamondDerived::~DiamondDerived(&var30);
  return v1;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x2154 */
int __cdecl test_cpp_operator_overload()
{
  int v0; // w9
  bool eq; // [xsp+27h] [xbp-19h]
  Point p3; // [xsp+28h] [xbp-18h] BYREF
  Point p2; // [xsp+30h] [xbp-10h] BYREF
  Point p1; // [xsp+38h] [xbp-8h] BYREF

  Point::Point(&p1, 1, 2);
  Point::Point(&p2, 3, 4);
  p3 = Point::operator+(&p1, &p2);
  eq = Point::operator==(&p1, &p2);
  Point::operator++(&p3);
  if ( eq )
    v0 = 0;
  else
    v0 = 10;
  return p3.x + p3.y + v0;
}


/* Function: _Z22test_cpp_template_funcv @ 0x21FC */
int __cdecl test_cpp_template_func()
{
  int b; // [xsp+8h] [xbp-18h] BYREF
  int a; // [xsp+Ch] [xbp-14h] BYREF
  double v3; // [xsp+10h] [xbp-10h]
  int r1; // [xsp+1Ch] [xbp-4h]

  r1 = template_max<int>(3, 7);
  v3 = template_max<double>(2.5, 1.5);
  a = 10;
  b = 20;
  template_swap<int>(&a, &b);
  return r1 + (int)v3 + a + b;
}


/* Function: _Z23test_cpp_template_classv @ 0x2270 */
int __cdecl test_cpp_template_class()
{
  double v1; // [xsp+18h] [xbp-98h]
  Container<double> v2; // [xsp+20h] [xbp-90h] BYREF
  int r2; // [xsp+7Ch] [xbp-34h]
  int r1; // [xsp+80h] [xbp-30h]
  Container<int> int_container; // [xsp+84h] [xbp-2Ch] BYREF

  Container<int>::Container(&int_container);
  Container<int>::push(&int_container, 10);
  Container<int>::push(&int_container, 20);
  Container<int>::push(&int_container, 30);
  r1 = Container<int>::get(&int_container, 0);
  r2 = Container<int>::getSize(&int_container);
  Container<double>::Container(&v2);
  Container<double>::push(&v2, 3.14);
  v1 = Container<double>::get(&v2, 0);
  return r1 + r2 + (int)v1;
}


/* Function: _Z15test_cpp_lambdav @ 0x2330 */
int __cdecl test_cpp_lambda()
{
  int v0; // w0
  int v2; // [xsp+10h] [xbp-20h]
  $44B1EA910F358000232221CCB0AF3F67 v3; // [xsp+17h] [xbp-19h] BYREF
  $53A263AF813E6A51E9D2036C8CF165B2 v4; // [xsp+18h] [xbp-18h] BYREF
  int capture_by_ref; // [xsp+28h] [xbp-8h] BYREF
  int capture_by_value; // [xsp+2Ch] [xbp-4h]

  capture_by_value = 10;
  capture_by_ref = 20;
  v4.capture_by_value = 10;
  v4.capture_by_ref = &capture_by_ref;
  v2 = test_cpp_lambda(void)::$_1::operator()(
         (const const struct __cppobj {int capture_by_value;int *capture_by_ref;} *)&v4,
         3);
  test_cpp_lambda(void)::$_0::operator()<int,int>(&v3, 10, 20);
  return v2 + v0;
}


/* Function: _ZZ15test_cpp_lambdavENK3$_1clEi @ 0x23A0 */
int __cdecl test_cpp_lambda(void)::$_1::operator()(
        const const struct __cppobj {int capture_by_value;int *capture_by_ref;} *this,
        int x)
{
  *this->capture_by_ref += 5;
  return x * this->capture_by_value + *this->capture_by_ref;
}


/* Function: _ZZ15test_cpp_lambdavENK3$_0clIiiEEDaT_T0_ @ 0x23E0 */
void __cdecl test_cpp_lambda(void)::$_0::operator()<int,int>(const const struct {_BYTE gap0;} *this, int a, int b)
{
  ;
}


/* Function: _Z18test_cpp_exceptionv @ 0x2404 */
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x2574 */
int __cdecl test_cpp_smart_ptr()
{
  int *v0; // x0
  std::unique_ptr<int> *v1; // x0
  int v3; // [xsp+4h] [xbp-9Ch]
  std::__add_lvalue_reference_helper<int,true>::type v4; // [xsp+10h] [xbp-90h]
  std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::pointer v5; // [xsp+18h] [xbp-88h]
  int *__p; // [xsp+30h] [xbp-70h]
  std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> v7; // [xsp+60h] [xbp-40h] BYREF
  std::unique_ptr<int[]> v8; // [xsp+70h] [xbp-30h] BYREF
  std::unique_ptr<int> ptr2; // [xsp+80h] [xbp-20h] BYREF
  std::unique_ptr<int> __t; // [xsp+98h] [xbp-8h] BYREF

  v0 = (int *)operator new(4u);
  *v0 = 100;
  std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(&__t, v0);
  *std::unique_ptr<int>::operator*(&__t) = 200;
  v1 = std::move<std::unique_ptr<int> &>(&__t);
  std::unique_ptr<int>::unique_ptr(&ptr2, v1);
  HIDWORD(v8._M_t._M_t._M_head_impl) = *std::unique_ptr<int>::operator*(&ptr2);
  __p = (int *)operator new[](0x14u);
  *__p = 1;
  __p[1] = 2;
  __p[2] = 3;
  __p[3] = 4;
  __p[4] = 5;
  std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(&v8, __p);
  HIDWORD(v7._M_t._M_t._M_head_impl) = *std::unique_ptr<int []>::operator[](&v8, 2u);
  v5 = (std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::pointer)operator new(4u);
  *v5 = 500;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::unique_ptr<test_cpp_smart_ptr(void)::$_2,void>(
    &v7,
    v5,
    (const std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::deleter_type *)&v7._M_t._M_t._M_head_impl + 3);
  v4 = std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::operator*(&v7);
  v3 = HIDWORD(v8._M_t._M_t._M_head_impl) + HIDWORD(v7._M_t._M_t._M_head_impl) + *v4;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::~unique_ptr(&v7);
  std::unique_ptr<int []>::~unique_ptr(&v8);
  std::unique_ptr<int>::~unique_ptr(&ptr2);
  std::unique_ptr<int>::~unique_ptr(&__t);
  return v3;
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EC2IS0_vEEPiRKS0_ @ 0x275C */
void __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::unique_ptr<test_cpp_smart_ptr(void)::$_2,void>(
        std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> *this,
        std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::pointer __p,
        const std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::deleter_type *__d)
{
  ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3__2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_(
    &this->_M_t,
    __p,
    __d);
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EdeEv @ 0x2798 */
std::__add_lvalue_reference_helper<int,true>::type __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::operator*(
        const std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get(this);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2ED2Ev @ 0x27CC */
void __cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::~unique_ptr(
        std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  int **v1; // x0
  std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::deleter_type *deleter; // [xsp+8h] [xbp-28h]
  int **__ptr; // [xsp+20h] [xbp-10h]

  __ptr = std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(&this->_M_t);
  if ( *__ptr )
  {
    deleter = std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get_deleter(this);
    v1 = std::move<int *&>(__ptr);
    test_cpp_smart_ptr(void)::$_2::operator()(deleter, *v1);
  }
  *__ptr = 0;
}


/* Function: _Z13test_cpp_rttiv @ 0x284C */
int __cdecl test_cpp_rtti()
{
  const char *v0; // x0
  const RTTIDerivedB *v2; // [xsp+20h] [xbp-70h]
  const RTTIDerivedA *v3; // [xsp+30h] [xbp-60h]
  RTTIDerivedA *v4; // [xsp+48h] [xbp-48h]
  RTTIDerivedB *v5; // [xsp+58h] [xbp-38h]
  int result; // [xsp+7Ch] [xbp-14h]
  int resulta; // [xsp+7Ch] [xbp-14h]

  v4 = (RTTIDerivedA *)operator new(8u);
  v4->_vptr$RTTIBase = 0;
  RTTIDerivedA::RTTIDerivedA(v4);
  v5 = (RTTIDerivedB *)operator new(8u);
  v5->_vptr$RTTIBase = 0;
  RTTIDerivedB::RTTIDerivedB(v5);
  result = 0;
  if ( !v4 )
    __cxa_bad_typeid();
  if ( std::type_info::operator==(
         *((const std::type_info **)v4->_vptr$RTTIBase - 1),
         (const std::type_info *)&`typeinfo for'RTTIDerivedA) )
  {
    result = 10;
  }
  if ( !v5 )
    __cxa_bad_typeid();
  if ( std::type_info::operator==(
         *((const std::type_info **)v5->_vptr$RTTIBase - 1),
         (const std::type_info *)&`typeinfo for'RTTIDerivedB) )
  {
    result += 20;
  }
  v3 = (const RTTIDerivedA *)__dynamic_cast(
                               v4,
                               (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                               (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
                               0);
  if ( v3 )
    result += RTTIDerivedA::derivedA_data(v3);
  v2 = (const RTTIDerivedB *)__dynamic_cast(
                               v5,
                               (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                               (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
                               0);
  if ( v2 )
    result += RTTIDerivedB::derivedB_data(v2);
  v0 = std::type_info::name(*((const std::type_info **)v4->_vptr$RTTIBase - 1));
  resulta = result + strlen(v0);
  (*((void (__fastcall **)(RTTIDerivedA *))v4->_vptr$RTTIBase + 1))(v4);
  (*((void (__fastcall **)(RTTIDerivedB *))v5->_vptr$RTTIBase + 1))(v5);
  return resulta;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x2A84 */
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

  printf(asc_4BD5);
  v0 = test_cpp_member_func();
  printf(aCppL301D, v0);
  v1 = test_cpp_constructor();
  printf(aCppL302D, v1);
  v2 = test_cpp_virtual_func();
  printf(aCppL303D, v2);
  v3 = test_cpp_multiple_inheritance();
  printf(aCppL304D, v3);
  v4 = test_cpp_diamond_inheritance();
  printf(aCppL305D, v4);
  v5 = test_cpp_operator_overload();
  printf(aCppL306D, v5);
  v6 = test_cpp_template_func();
  printf(aCppL307D, v6);
  v7 = test_cpp_template_class();
  printf(aCppL308D, v7);
  v8 = test_cpp_lambda();
  printf(aCppL309D, v8);
  test_cpp_exception();
}


/* Function: sub_2B50 @ 0x2B50 */
// positive sp value has been detected, the output may be wrong!
__int64 __fastcall sub_2B50(unsigned int a1)
{
  unsigned int v1; // w0
  unsigned int v2; // w0

  printf(aCppL401D, a1);
  v1 = test_cpp_smart_ptr();
  printf(aCppL402D, v1);
  v2 = test_cpp_rtti();
  return printf(aCppL403D, v2);
}


/* Function: main @ 0x2B90 */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: sub_2BAC @ 0x2BAC */
// positive sp value has been detected, the output may be wrong!
__int64 sub_2BAC()
{
  unsigned int v1; // [xsp-18h] [xbp-18h]

  return v1;
}


/* Function: _ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3$_2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_ @ 0x2BBC */
void __fastcall ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3__2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_(
        std::__uniq_ptr_data<int,(lambda at src_5-1_cpp:445:20),true,false> *this,
        std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)>::pointer a2,
        const const struct {_BYTE gap0;} *a3)
{
  std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::$_2 const&>(
    this,
    a2,
    a3);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2EC2IRKS0_EEPiOT_ @ 0x2BF0 */
void __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::$_2 const&>(
        std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)> *this,
        std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)>::pointer __p,
        std::remove_reference<const (lambda at src_5-1_cpp:445:20) &>::type *__d)
{
  const const struct {_BYTE gap0;} *v3; // x0
  std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)>::pointer __pa; // [xsp+20h] [xbp-10h] BYREF
  std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)> *thisa; // [xsp+28h] [xbp-8h]

  thisa = this;
  __pa = __p;
  v3 = std::forward<test_cpp_smart_ptr(void)::$_2 const&>(__d);
  std::tuple<int *,test_cpp_smart_ptr(void)::$_2>::tuple<int *&,test_cpp_smart_ptr(void)::$_2 const&,true>(
    &this->_M_t,
    &__pa,
    v3);
}


/* Function: _ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE @ 0x2C3C */
const const struct {_BYTE gap0;} *__cdecl std::forward<test_cpp_smart_ptr(void)::$_2 const&>(
        std::remove_reference<const (lambda at src_5-1_cpp:445:20) &>::type *__t)
{
  return (const const struct {_BYTE gap0;} *)__t;
}


/* Function: _ZNSt5tupleIJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_RKS1_Lb1EEEOT_OT0_ @ 0x2C50 */
void __fastcall std::tuple<int *,test_cpp_smart_ptr(void)::$_2>::tuple<int *&,test_cpp_smart_ptr(void)::$_2 const&,true>(
        std::tuple<int *,(lambda at src_5-1_cpp:445:20)> *this,
        int **__a1,
        std::remove_reference<const (lambda at src_5-1_cpp:445:20) &>::type *__a2)
{
  const const struct {_BYTE gap0;} *v3; // x0
  int **__head; // [xsp+8h] [xbp-28h]

  __head = std::forward<int *&>(__a1);
  v3 = std::forward<test_cpp_smart_ptr(void)::$_2 const&>(__a2);
  std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::$_2 const&,void>(
    this,
    __head,
    v3);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_JRKS1_EvEEOT_DpOT0_ @ 0x2CA8 */
void __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::$_2 const&,void>(
        std::_Tuple_impl<0UL,int *,(lambda at src_5-1_cpp:445:20)> *this,
        int **__head,
        std::remove_reference<const (lambda at src_5-1_cpp:445:20) &>::type *__tail)
{
  const const struct {_BYTE gap0;} *v3; // x0
  int **v4; // x0

  v3 = std::forward<test_cpp_smart_ptr(void)::$_2 const&>(__tail);
  std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl(this, v3);
  v4 = std::forward<int *&>(__head);
  std::_Head_base<0ul,int *,false>::_Head_base<int *&>((std::_Head_base<0UL,int *,false> *)this, v4);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EEC2ERKS0_ @ 0x2CFC */
void __fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl(
        std::_Tuple_impl<1UL,(lambda at src_5-1_cpp:445:20)> *this,
        const const struct {_BYTE gap0;} *__head)
{
  std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_Head_base(this, __head);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EEC2ERKS0_ @ 0x2D28 */
void __cdecl std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_Head_base(
        std::_Head_base<1UL,(lambda at src_5-1_cpp:445:20),true> *this,
        const const struct {_BYTE gap0;} *__h)
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv @ 0x2D3C */
std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)>::pointer *__fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(
        std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(&this->_M_t);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E11get_deleterEv @ 0x2D60 */
std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::deleter_type *__fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get_deleter(
        std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return (std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::deleter_type *)std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_deleter(&this->_M_t);
}


/* Function: _ZZ18test_cpp_smart_ptrvENK3$_2clEPi @ 0x2D94 */
void __fastcall test_cpp_smart_ptr(void)::$_2::operator()(const const struct {_BYTE gap0;} *this, int *p)
{
  *p = -1;
  if ( p )
    operator delete(p);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2DDC */
std::__tuple_element_t<0UL,std::tuple<int *,(lambda at src_5-1_cpp:445:20)> > *__fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(
        std::tuple<int *,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2E00 */
int **__fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(
        std::_Tuple_impl<0UL,int *,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS2_ @ 0x2E24 */
int **__fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(
        std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E10_M_deleterEv @ 0x2E48 */
std::__tuple_element_t<1UL,std::tuple<int *,(lambda at src_5-1_cpp:445:20)> > *__fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_deleter(
        std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return std::get<1ul,int *,test_cpp_smart_ptr(void)::$_2>(&this->_M_t);
}


/* Function: _ZSt3getILm1EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2E6C */
std::__tuple_element_t<1UL,std::tuple<int *,(lambda at src_5-1_cpp:445:20)> > *__fastcall std::get<1ul,int *,test_cpp_smart_ptr(void)::$_2>(
        std::tuple<int *,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return (std::__tuple_element_t<1UL,std::tuple<int *,(lambda at src_5-1_cpp:445:20)> > *)std::__get_helper<1ul,test_cpp_smart_ptr(void)::$_2>(__t);
}


/* Function: _ZSt12__get_helperILm1EZ18test_cpp_smart_ptrvE3$_2JEERT0_RSt11_Tuple_implIXT_EJS1_DpT1_EE @ 0x2E90 */
struct {_BYTE gap0;} *__fastcall std::__get_helper<1ul,test_cpp_smart_ptr(void)::$_2>(
        std::_Tuple_impl<1UL,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS1_ @ 0x2EB4 */
struct {_BYTE gap0;} *__fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_M_head(
        std::_Tuple_impl<1UL,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EE7_M_headERS1_ @ 0x2ED8 */
struct {_BYTE gap0;} *__cdecl std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_M_head(
        std::_Head_base<1UL,(lambda at src_5-1_cpp:445:20),true> *__b)
{
  return (struct {_BYTE gap0;} *)__b;
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E3getEv @ 0x2EEC */
std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)>::pointer __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get(
        const std::unique_ptr<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv @ 0x2F20 */
std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)>::pointer __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(
        const std::__uniq_ptr_impl<int,(lambda at src_5-1_cpp:445:20)> *this)
{
  return *std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(&this->_M_t);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_ @ 0x2F48 */
const std::__tuple_element_t<0UL,std::tuple<int *,(lambda at src_5-1_cpp:445:20)> > *__fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(
        const std::tuple<int *,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2F6C */
int *const *__fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(
        const std::_Tuple_impl<0UL,int *,(lambda at src_5-1_cpp:445:20)> *__t)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERKS2_ @ 0x2F90 */
int *const *__fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(
        const std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZN11SimpleClassC2EiPKc @ 0x2FB4 */
void __fastcall SimpleClass::SimpleClass(SimpleClass *this, int v, const char *n)
{
  this->value = v;
  strncpy(this->name, n, 0x1Fu);
  this->name[31] = 0;
}


/* Function: _ZN11SimpleClass8setValueEi @ 0x3000 */
void __cdecl SimpleClass::setValue(SimpleClass *this, int v)
{
  this->value = v;
}


/* Function: _ZNK11SimpleClass8getValueEv @ 0x3020 */
int __cdecl SimpleClass::getValue(const SimpleClass *this)
{
  return this->value;
}


/* Function: _ZNK11SimpleClass7computeEi @ 0x3038 */
__int64 __fastcall SimpleClass::compute(const SimpleClass *this, int x)
{
  int v3; // [xsp+0h] [xbp-10h]

  v3 = this->value * x;
  return (unsigned int)strlen(this->name) + v3;
}


/* Function: _ZN11SimpleClass10getClassIDEv @ 0x3080 */
int __cdecl SimpleClass::getClassID()
{
  return 4660;
}


/* Function: _ZN14LifecycleClassC2Em @ 0x3088 */
void __fastcall LifecycleClass::LifecycleClass(LifecycleClass *this, size_t s)
{
  unsigned __int64 v2; // x0
  size_t i; // [xsp+8h] [xbp-18h]

  this->size = s;
  if ( is_mul_ok(s, 4u) )
    v2 = 4 * s;
  else
    v2 = -1;
  this->data = (int *)operator new[](v2);
  for ( i = 0; i < s; ++i )
    this->data[i] = 10 * i;
  ++LifecycleClass::instance_count;
}


/* Function: _ZNK14LifecycleClass7getDataEm @ 0x3138 */
int __cdecl LifecycleClass::getData(const LifecycleClass *this, size_t idx)
{
  if ( idx >= this->size )
    return -1;
  else
    return this->data[idx];
}


/* Function: _ZN14LifecycleClass16getInstanceCountEv @ 0x3190 */
int __cdecl LifecycleClass::getInstanceCount()
{
  return LifecycleClass::instance_count;
}


/* Function: _ZN14LifecycleClassD2Ev @ 0x319C */
void __fastcall LifecycleClass::~LifecycleClass(LifecycleClass *this)
{
  if ( this->data )
    operator delete[](this->data);
  --LifecycleClass::instance_count;
}


/* Function: _ZN4BaseC2Ev @ 0x31E8 */
void __cdecl Base::Base(Base *this)
{
  this->_vptr$Base = (int (**)(void))&off_17858;
}


/* Function: _ZN7DerivedC2Ei @ 0x320C */
void __cdecl Derived::Derived(Derived *this, int m)
{
  Base::Base(this);
  this->_vptr$Base = (int (**)(void))&off_17898;
  this->multiplier = m;
}


/* Function: _ZN4Base12virtual_funcEi @ 0x325C */
int __cdecl Base::virtual_func(Base *this, int x)
{
  return x + 1;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x3278 */
int __cdecl Derived::virtual_func(Derived *this, int x)
{
  return x * this->multiplier;
}


/* Function: _ZN7DerivedD2Ev @ 0x329C */
void __fastcall Derived::~Derived(Derived *this)
{
  Base::~Base(this);
}


/* Function: _ZN4BaseD2Ev @ 0x32C0 */
void __cdecl Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN12MultiDerivedC2Ev @ 0x32D0 */
void __cdecl MultiDerived::MultiDerived(MultiDerived *this)
{
  BaseA::BaseA(this);
  BaseB::BaseB(&this->BaseB);
  this->_vptr$BaseA = (int (**)(void))&off_178E0;
  this->_vptr$BaseB = (int (**)(void))&off_17910;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x3330 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  BaseB::~BaseB(&this->BaseB);
  BaseA::~BaseA(this);
}


/* Function: _ZN14DiamondDerivedC1Ev @ 0x3364 */
void __cdecl DiamondDerived::DiamondDerived(DiamondDerived *this)
{
  VirtualBase::VirtualBase((VirtualBase *)&this->MiddleB);
  MiddleA::MiddleA(this, (void **)off_17A70);
  MiddleB::MiddleB((MiddleB *)(&this->dataA + 2), (void **)off_17A80);
  this->_vptr$MiddleA = (int (**)(void))&off_179E8;
  this->_vptr$MiddleB = (int (**)(void))&off_17A50;
  *((_QWORD *)&this->dataA + 1) = &off_17A18;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x3400 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this, (void **)&`VTT for'DiamondDerived);
  VirtualBase::~VirtualBase((VirtualBase *)&this->MiddleB);
}


/* Function: _ZN5PointC2Eii @ 0x343C */
void __cdecl Point::Point(Point *this, int _x, int _y)
{
  this->x = _x;
  this->y = _y;
}


/* Function: _ZNK5PointplERKS_ @ 0x3468 */
Point __fastcall Point::operator+(const Point *this, const Point *other)
{
  Point v3; // [xsp+18h] [xbp-8h] BYREF

  Point::Point(&v3, this->x + other->x, this->y + other->y);
  return v3;
}


/* Function: _ZNK5PointeqERKS_ @ 0x34B8 */
bool __cdecl Point::operator==(const Point *this, const Point *other)
{
  bool v3; // [xsp+Ch] [xbp-14h]

  v3 = 0;
  if ( this->x == other->x )
    return this->y == other->y;
  return v3;
}


/* Function: _ZN5PointppEv @ 0x351C */
Point *__cdecl Point::operator++(Point *this)
{
  ++this->x;
  ++this->y;
  return this;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x3548 */
int __cdecl template_max<int>(int a, int b)
{
  if ( a <= b )
    return b;
  else
    return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x358C */
double __cdecl template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  else
    return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x35D4 */
void __cdecl template_swap<int>(int *a, int *b)
{
  int v2; // [xsp+Ch] [xbp-14h]

  v2 = *a;
  *a = *b;
  *b = v2;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x3610 */
void __cdecl Container<int>::Container(Container<int> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x3628 */
void __cdecl Container<int>::push(Container<int> *this, int value)
{
  __int64 v2; // x10

  if ( this->size < 10 )
  {
    v2 = this->size++;
    this->data[v2] = value;
  }
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x3674 */
int __cdecl Container<int>::get(const Container<int> *this, int idx)
{
  if ( idx < 0 || idx >= this->size )
    return 0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x36D4 */
int __cdecl Container<int>::getSize(const Container<int> *this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x36EC */
void __cdecl Container<double>::Container(Container<double> *this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x3704 */
void __cdecl Container<double>::push(Container<double> *this, double value)
{
  __int64 v2; // x10

  if ( this->size < 10 )
  {
    v2 = this->size++;
    this->data[v2] = value;
  }
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x3750 */
double __cdecl Container<double>::get(const Container<double> *this, int idx)
{
  if ( idx < 0 || idx >= this->size )
    return 0.0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x37B4 */
int __cdecl Container<double>::getSize(const Container<double> *this)
{
  return this->size;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi @ 0x37CC */
void __fastcall std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(
        std::unique_ptr<int> *this,
        std::unique_ptr<int>::pointer __p)
{
  ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(&this->_M_t, __p);
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEEdeEv @ 0x3800 */
std::__add_lvalue_reference_helper<int,true>::type __fastcall std::unique_ptr<int>::operator*(
        const std::unique_ptr<int> *this)
{
  return std::unique_ptr<int>::get(this);
}


/* Function: _ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_ @ 0x3834 */
std::remove_reference<std::unique_ptr<int> &>::type *__cdecl std::move<std::unique_ptr<int> &>(
        std::unique_ptr<int> *__t)
{
  return __t;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_ @ 0x3848 */
void __fastcall std::unique_ptr<int>::unique_ptr(std::unique_ptr<int> *this, std::unique_ptr<int> *a2)
{
  std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(&this->_M_t, &a2->_M_t);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_ @ 0x3874 */
void __fastcall std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(
        std::unique_ptr<int[]> *this,
        int *__p)
{
  ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(&this->_M_t, __p);
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm @ 0x38A8 */
std::__add_lvalue_reference_helper<int,true>::type __fastcall std::unique_ptr<int []>::operator[](
        const std::unique_ptr<int[]> *this,
        std::size_t __i)
{
  return &std::unique_ptr<int []>::get(this)[__i];
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x38E8 */
void __cdecl std::unique_ptr<int []>::~unique_ptr(std::unique_ptr<int[]> *this)
{
  const std::default_delete<int[]> *deleter; // x0
  int **v3; // [xsp+10h] [xbp-10h]

  v3 = std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(&this->_M_t);
  if ( *v3 )
  {
    deleter = std::unique_ptr<int []>::get_deleter(this);
    std::default_delete<int []>::operator()<int>(deleter, *v3);
  }
  *v3 = 0;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x394C */
void __cdecl std::unique_ptr<int>::~unique_ptr(std::unique_ptr<int> *this)
{
  int **v1; // x8
  std::default_delete<int> *deleter; // [xsp+0h] [xbp-20h]
  std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer *__t; // [xsp+10h] [xbp-10h]

  __t = std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(&this->_M_t);
  if ( *__t )
  {
    deleter = std::unique_ptr<int>::get_deleter(this);
    v1 = std::move<int *&>(__t);
    std::default_delete<int>::operator()(deleter, *v1);
  }
  *__t = 0;
}


/* Function: _ZN12RTTIDerivedAC2Ev @ 0x39C0 */
void __cdecl RTTIDerivedA::RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIBase::RTTIBase(this);
  this->_vptr$RTTIBase = (int (**)(void))off_17D30;
}


/* Function: _ZN12RTTIDerivedBC2Ev @ 0x3A04 */
void __cdecl RTTIDerivedB::RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIBase::RTTIBase(this);
  this->_vptr$RTTIBase = (int (**)(void))off_17D80;
}


/* Function: _ZNKSt9type_infoeqERKS_ @ 0x3A48 */
bool __cdecl std::type_info::operator==(const std::type_info *this, const std::type_info *__arg)
{
  bool v3; // [xsp+Ch] [xbp-24h]
  bool v4; // [xsp+1Ch] [xbp-14h]

  v4 = 1;
  if ( *((_QWORD *)this + 1) != *((_QWORD *)__arg + 1) )
  {
    v3 = 0;
    if ( **((_BYTE **)this + 1) != 42 )
      return strcmp(*((const char **)this + 1), *((const char **)__arg + 1)) == 0;
    return v3;
  }
  return v4;
}


/* Function: _ZNK12RTTIDerivedA13derivedA_dataEv @ 0x3AE8 */
int __cdecl RTTIDerivedA::derivedA_data(const RTTIDerivedA *this)
{
  return 100;
}


/* Function: _ZNK12RTTIDerivedB13derivedB_dataEv @ 0x3AFC */
int __cdecl RTTIDerivedB::derivedB_data(const RTTIDerivedB *this)
{
  return 200;
}


/* Function: _ZNKSt9type_info4nameEv @ 0x3B10 */
const char *__cdecl std::type_info::name(const std::type_info *this)
{
  if ( **((_BYTE **)this + 1) == 42 )
    return (const char *)(*((_QWORD *)this + 1) + 1LL);
  else
    return (const char *)*((_QWORD *)this + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x3B64 */
const char *__cdecl Base::getName(const Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD0Ev @ 0x3B7C */
void __fastcall Base::~Base(Base *this)
{
  Base::~Base(this);
  operator delete(this);
}


/* Function: _ZNK7Derived7getNameEv @ 0x3BAC */
const char *__cdecl Derived::getName(const Derived *this)
{
  return "Derived";
}


/* Function: _ZN7DerivedD0Ev @ 0x3BC4 */
void __fastcall Derived::~Derived(Derived *this)
{
  Derived::~Derived(this);
  operator delete(this);
}


/* Function: _ZN5BaseAC2Ev @ 0x3BF4 */
void __cdecl BaseA::BaseA(BaseA *this)
{
  this->_vptr$BaseA = (int (**)(void))&off_17990;
}


/* Function: _ZN5BaseBC2Ev @ 0x3C18 */
void __cdecl BaseB::BaseB(BaseB *this)
{
  this->_vptr$BaseB = (int (**)(void))&off_179B8;
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x3C3C */
int __cdecl MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x3C50 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived(this);
  operator delete(this);
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x3C80 */
int __cdecl MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x3C94 */
void __cdecl `non-virtual thunk to'MultiDerived::funcB()
{
  __int64 v0; // x0

  MultiDerived::funcB((MultiDerived *)(v0 - 16));
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x3CAC */
void __cdecl `non-virtual thunk to'MultiDerived::~MultiDerived()
{
  __int64 v0; // x0

  MultiDerived::~MultiDerived((MultiDerived *)(v0 - 16));
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x3CC4 */
void __cdecl `non-virtual thunk to'MultiDerived::~MultiDerived()
{
  __int64 v0; // x0

  MultiDerived::~MultiDerived((MultiDerived *)(v0 - 16));
}


/* Function: _ZN5BaseA5funcAEv @ 0x3CDC */
int __cdecl BaseA::funcA(BaseA *this)
{
  return 10;
}


/* Function: _ZN5BaseAD2Ev @ 0x3CF0 */
void __cdecl BaseA::~BaseA(BaseA *this)
{
  ;
}


/* Function: _ZN5BaseAD0Ev @ 0x3D00 */
void __fastcall BaseA::~BaseA(BaseA *this)
{
  BaseA::~BaseA(this);
  operator delete(this);
}


/* Function: _ZN5BaseB5funcBEv @ 0x3D30 */
int __cdecl BaseB::funcB(BaseB *this)
{
  return 20;
}


/* Function: _ZN5BaseBD2Ev @ 0x3D44 */
void __cdecl BaseB::~BaseB(BaseB *this)
{
  ;
}


/* Function: _ZN5BaseBD0Ev @ 0x3D54 */
void __fastcall BaseB::~BaseB(BaseB *this)
{
  BaseB::~BaseB(this);
  operator delete(this);
}


/* Function: _ZN11VirtualBaseC2Ev @ 0x3D84 */
void __cdecl VirtualBase::VirtualBase(VirtualBase *this)
{
  this->_vptr$VirtualBase = (int (**)(void))&off_17C18;
}


/* Function: _ZN7MiddleAC2Ev @ 0x3DA8 */
void __cdecl MiddleA::MiddleA(MiddleA *this, void **vtt)
{
  this->_vptr$MiddleA = (int (**)(void))*vtt;
  *(int (***)(void))((char *)&this->_vptr$MiddleA + *((_QWORD *)this->_vptr$MiddleA - 3)) = (int (**)(void))vtt[1];
}


/* Function: _ZN7MiddleBC2Ev @ 0x3DDC */
void __cdecl MiddleB::MiddleB(MiddleB *this, void **vtt)
{
  this->_vptr$MiddleB = (int (**)(void))*vtt;
  *(int (***)(void))((char *)&this->_vptr$MiddleB + *((_QWORD *)this->_vptr$MiddleB - 3)) = (int (**)(void))vtt[1];
}


/* Function: _ZN7MiddleA4funcEv @ 0x3E10 */
int __cdecl MiddleA::func(MiddleA *this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr$MiddleA - 3)) + 150;
}


/* Function: _ZN7MiddleAD1Ev @ 0x3E38 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA(this, (void **)`VTT for'MiddleA);
  VirtualBase::~VirtualBase((VirtualBase *)(&this->dataA + 2));
}


/* Function: _ZN7MiddleAD0Ev @ 0x3E74 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA(this);
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x3EA4 */
void __cdecl `virtual thunk to'MiddleA::func()
{
  _QWORD *v0; // x0

  MiddleA::func((MiddleA *)((char *)v0 + *(_QWORD *)(*v0 - 24LL)));
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x3EC4 */
void __cdecl `virtual thunk to'MiddleA::~MiddleA()
{
  _QWORD *v0; // x0

  MiddleA::~MiddleA((MiddleA *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x3EE4 */
void __cdecl `virtual thunk to'MiddleA::~MiddleA()
{
  _QWORD *v0; // x0

  MiddleA::~MiddleA((MiddleA *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x3F04 */
int __cdecl MiddleB::func(MiddleB *this)
{
  return *(int *)((char *)&this->dataB + *((_QWORD *)this->_vptr$MiddleB - 3)) + 200;
}


/* Function: _ZN7MiddleBD1Ev @ 0x3F2C */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB(this, (void **)`VTT for'MiddleB);
  VirtualBase::~VirtualBase((VirtualBase *)(&this->dataB + 2));
}


/* Function: _ZN7MiddleBD0Ev @ 0x3F68 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB(this);
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x3F98 */
void __cdecl `virtual thunk to'MiddleB::func()
{
  _QWORD *v0; // x0

  MiddleB::func((MiddleB *)((char *)v0 + *(_QWORD *)(*v0 - 24LL)));
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x3FB8 */
void __cdecl `virtual thunk to'MiddleB::~MiddleB()
{
  _QWORD *v0; // x0

  MiddleB::~MiddleB((MiddleB *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x3FD8 */
void __cdecl `virtual thunk to'MiddleB::~MiddleB()
{
  _QWORD *v0; // x0

  MiddleB::~MiddleB((MiddleB *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x3FF8 */
int __cdecl DiamondDerived::func(DiamondDerived *this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr$MiddleA - 3)) + 250;
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x4020 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this);
  operator delete(this);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x4050 */
void __cdecl `non-virtual thunk to'DiamondDerived::func()
{
  __int64 v0; // x0

  DiamondDerived::func((DiamondDerived *)(v0 - 16));
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x4068 */
void __cdecl `non-virtual thunk to'DiamondDerived::~DiamondDerived()
{
  __int64 v0; // x0

  DiamondDerived::~DiamondDerived((DiamondDerived *)(v0 - 16));
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x4080 */
void __cdecl `non-virtual thunk to'DiamondDerived::~DiamondDerived()
{
  __int64 v0; // x0

  DiamondDerived::~DiamondDerived((DiamondDerived *)(v0 - 16));
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x4098 */
void __cdecl `virtual thunk to'DiamondDerived::func()
{
  _QWORD *v0; // x0

  DiamondDerived::func((DiamondDerived *)((char *)v0 + *(_QWORD *)(*v0 - 24LL)));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x40B8 */
void __cdecl `virtual thunk to'DiamondDerived::~DiamondDerived()
{
  _QWORD *v0; // x0

  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x40D8 */
void __cdecl `virtual thunk to'DiamondDerived::~DiamondDerived()
{
  _QWORD *v0; // x0

  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)v0 + *(_QWORD *)(*v0 - 32LL)));
}


/* Function: _ZN11VirtualBase4funcEv @ 0x40F8 */
int __cdecl VirtualBase::func(VirtualBase *this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x410C */
void __cdecl VirtualBase::~VirtualBase(VirtualBase *this)
{
  ;
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x411C */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  VirtualBase::~VirtualBase(this);
  operator delete(this);
}


/* Function: _ZN7MiddleAD2Ev @ 0x414C */
void __cdecl MiddleA::~MiddleA(MiddleA *this, void **vtt)
{
  ;
}


/* Function: _ZN7MiddleBD2Ev @ 0x4160 */
void __cdecl MiddleB::~MiddleB(MiddleB *this, void **vtt)
{
  ;
}


/* Function: _ZN14DiamondDerivedD2Ev @ 0x4174 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this, void **vtt)
{
  MiddleB::~MiddleB((MiddleB *)(&this->dataA + 2), vtt + 3);
  MiddleA::~MiddleA(this, vtt + 1);
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_ @ 0x41C0 */
void __fastcall std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *this,
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_ @ 0x41EC */
void __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *this,
        std::__uniq_ptr_impl<int,std::default_delete<int> > *__u)
{
  std::tuple<int *,std::default_delete<int> > *v2; // x0

  v2 = std::move<std::tuple<int *,std::default_delete<int>> &>(&__u->_M_t);
  std::tuple<int *,std::default_delete<int>>::tuple(&this->_M_t, v2);
  *std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__u) = 0;
}


/* Function: _ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_ @ 0x4244 */
std::remove_reference<std::tuple<int *,std::default_delete<int> > &>::type *__cdecl std::move<std::tuple<int *,std::default_delete<int>> &>(
        std::tuple<int *,std::default_delete<int> > *__t)
{
  return __t;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_ @ 0x4258 */
void __fastcall std::tuple<int *,std::default_delete<int>>::tuple(
        std::tuple<int *,std::default_delete<int> > *this,
        std::tuple<int *,std::default_delete<int> > *a2)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(this, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x4284 */
std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *this)
{
  return std::get<0ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: __clang_call_terminate @ 0x42A8 */
void __fastcall __noreturn _clang_call_terminate(void *a1)
{
  __cxa_begin_catch(a1);
  std::terminate();
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_ @ 0x42B4 */
void __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<0UL,int *,std::default_delete<int> > *this,
        std::_Tuple_impl<0UL,int *,std::default_delete<int> > *a2)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(this, a2);
  *(_QWORD *)&this->std::_Tuple_impl<1UL,std::default_delete<int> >::std::_Head_base<1UL,std::default_delete<int>,true>::_M_head_impl.gap0 = *(_QWORD *)&a2->std::_Tuple_impl<1UL,std::default_delete<int> >::std::_Head_base<1UL,std::default_delete<int>,true>::_M_head_impl.gap0;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_ @ 0x42F4 */
void __cdecl std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<1UL,std::default_delete<int> > *this,
        std::_Tuple_impl<1UL,std::default_delete<int> > *__in)
{
  ;
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4308 */
std::__tuple_element_t<0UL,std::tuple<int *,std::default_delete<int> > > *__fastcall std::get<0ul,int *,std::default_delete<int>>(
        std::tuple<int *,std::default_delete<int> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x432C */
int **__fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(
        std::_Tuple_impl<0UL,int *,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_ @ 0x4350 */
int **__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_ @ 0x4374 */
int **__cdecl std::_Head_base<0ul,int *,false>::_M_head(std::_Head_base<0UL,int *,false> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZN8RTTIBaseC2Ev @ 0x4388 */
void __cdecl RTTIBase::RTTIBase(RTTIBase *this)
{
  this->_vptr$RTTIBase = (int (**)(void))off_17D58;
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x43AC */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x43D0 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIDerivedA::~RTTIDerivedA(this);
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x4400 */
int __cdecl RTTIDerivedA::getType(const RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x4414 */
void __cdecl RTTIBase::~RTTIBase(RTTIBase *this)
{
  ;
}


/* Function: _ZN8RTTIBaseD0Ev @ 0x4424 */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
{
  RTTIBase::~RTTIBase(this);
  operator delete(this);
}


/* Function: _ZNK8RTTIBase7getTypeEv @ 0x4454 */
int __cdecl RTTIBase::getType(const RTTIBase *this)
{
  return 0;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x4468 */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x448C */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIDerivedB::~RTTIDerivedB(this);
  operator delete(this);
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x44BC */
int __cdecl RTTIDerivedB::getType(const RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi @ 0x44D0 */
void __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *this,
        std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi @ 0x44FC */
void __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *this,
        std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer __p)
{
  std::tuple<int *,std::default_delete<int>>::tuple<true,true>(&this->_M_t);
  *std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(this) = __p;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv @ 0x4540 */
void __fastcall std::tuple<int *,std::default_delete<int>>::tuple<true,true>(
        std::tuple<int *,std::default_delete<int> > *this)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(this);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev @ 0x456C */
void __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<0UL,int *,std::default_delete<int> > *this)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(this);
  std::_Head_base<0ul,int *,false>::_Head_base((std::_Head_base<0UL,int *,false> *)this);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev @ 0x459C */
void __fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<1UL,std::default_delete<int> > *this)
{
  std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(this);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2Ev @ 0x45C0 */
void __cdecl std::_Head_base<0ul,int *,false>::_Head_base(std::_Head_base<0UL,int *,false> *this)
{
  this->_M_head_impl = 0;
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev @ 0x45D8 */
void __cdecl std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(
        std::_Head_base<1UL,std::default_delete<int>,true> *this)
{
  ;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv @ 0x45E8 */
std::unique_ptr<int>::deleter_type *__fastcall std::unique_ptr<int>::get_deleter(std::unique_ptr<int> *this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(&this->_M_t);
}


/* Function: _ZNKSt14default_deleteIiEclEPi @ 0x461C */
void __fastcall std::default_delete<int>::operator()(const std::default_delete<int> *this, int *__ptr)
{
  if ( __ptr )
    operator delete(__ptr);
}


/* Function: _ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_ @ 0x4658 */
std::remove_reference<int *&>::type *__cdecl std::move<int *&>(int **__t)
{
  return __t;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv @ 0x466C */
std::default_delete<int> *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *this)
{
  return std::get<1ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4690 */
std::__tuple_element_t<1UL,std::tuple<int *,std::default_delete<int> > > *__fastcall std::get<1ul,int *,std::default_delete<int>>(
        std::tuple<int *,std::default_delete<int> > *__t)
{
  return std::__get_helper<1ul,std::default_delete<int>>(__t);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x46B4 */
std::default_delete<int> *__fastcall std::__get_helper<1ul,std::default_delete<int>>(
        std::_Tuple_impl<1UL,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_ @ 0x46D8 */
std::default_delete<int> *__fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(
        std::_Tuple_impl<1UL,std::default_delete<int> > *__t)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_ @ 0x46FC */
std::default_delete<int> *__cdecl std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(
        std::_Head_base<1UL,std::default_delete<int>,true> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv @ 0x4710 */
std::unique_ptr<int>::pointer __fastcall std::unique_ptr<int>::get(const std::unique_ptr<int> *this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x4744 */
std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(
        const std::__uniq_ptr_impl<int,std::default_delete<int> > *this)
{
  return *std::get<0ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_ @ 0x476C */
const std::__tuple_element_t<0UL,std::tuple<int *,std::default_delete<int> > > *__fastcall std::get<0ul,int *,std::default_delete<int>>(
        const std::tuple<int *,std::default_delete<int> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4790 */
int *const *__fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(
        const std::_Tuple_impl<0UL,int *,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_ @ 0x47B4 */
int *const *__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(
        const std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_ @ 0x47D8 */
int *const *__cdecl std::_Head_base<0ul,int *,false>::_M_head(const std::_Head_base<0UL,int *,false> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi @ 0x47EC */
void __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(
        std::__uniq_ptr_data<int,std::default_delete<int[]>,true,true> *this,
        std::__uniq_ptr_impl<int,std::default_delete<int[]> >::pointer a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi @ 0x4818 */
void __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int[]> > *this,
        std::__uniq_ptr_impl<int,std::default_delete<int[]> >::pointer __p)
{
  std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(&this->_M_t);
  *std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(this) = __p;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv @ 0x485C */
void __fastcall std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(
        std::tuple<int *,std::default_delete<int[]> > *this)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(this);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x4888 */
std::__uniq_ptr_impl<int,std::default_delete<int[]> >::pointer *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(
        std::__uniq_ptr_impl<int,std::default_delete<int[]> > *this)
{
  return std::get<0ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev @ 0x48AC */
void __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(
        std::_Tuple_impl<0UL,int *,std::default_delete<int[]> > *this)
{
  std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(this);
  std::_Head_base<0ul,int *,false>::_Head_base((std::_Head_base<0UL,int *,false> *)this);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev @ 0x48DC */
void __fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(
        std::_Tuple_impl<1UL,std::default_delete<int[]> > *this)
{
  std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(this);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev @ 0x4900 */
void __cdecl std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(
        std::_Head_base<1UL,std::default_delete<int[]>,true> *this)
{
  ;
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x4910 */
std::__tuple_element_t<0UL,std::tuple<int *,std::default_delete<int[]> > > *__fastcall std::get<0ul,int *,std::default_delete<int []>>(
        std::tuple<int *,std::default_delete<int[]> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4934 */
int **__fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(
        std::_Tuple_impl<0UL,int *,std::default_delete<int[]> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_ @ 0x4958 */
int **__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(
        std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv @ 0x497C */
std::unique_ptr<int[]>::deleter_type *__fastcall std::unique_ptr<int []>::get_deleter(std::unique_ptr<int[]> *this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(&this->_M_t);
}


/* Function: _ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsr14is_convertibleIPA_T_PS0_EE5valueEvE4typeEPS4_ @ 0x49B0 */
void __fastcall std::default_delete<int []>::operator()<int>(const std::default_delete<int[]> *this, int *__ptr)
{
  if ( __ptr )
    operator delete[](__ptr);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv @ 0x49EC */
std::default_delete<int[]> *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(
        std::__uniq_ptr_impl<int,std::default_delete<int[]> > *this)
{
  return std::get<1ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x4A10 */
std::__tuple_element_t<1UL,std::tuple<int *,std::default_delete<int[]> > > *__fastcall std::get<1ul,int *,std::default_delete<int []>>(
        std::tuple<int *,std::default_delete<int[]> > *__t)
{
  return std::__get_helper<1ul,std::default_delete<int []>>(__t);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4A34 */
std::default_delete<int[]> *__fastcall std::__get_helper<1ul,std::default_delete<int []>>(
        std::_Tuple_impl<1UL,std::default_delete<int[]> > *__t)
{
  return std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_ @ 0x4A58 */
std::default_delete<int[]> *__fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(
        std::_Tuple_impl<1UL,std::default_delete<int[]> > *__t)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_ @ 0x4A7C */
std::default_delete<int[]> *__cdecl std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(
        std::_Head_base<1UL,std::default_delete<int[]>,true> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv @ 0x4A90 */
std::unique_ptr<int[]>::pointer __fastcall std::unique_ptr<int []>::get(const std::unique_ptr<int[]> *this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x4AC4 */
std::__uniq_ptr_impl<int,std::default_delete<int[]> >::pointer __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(
        const std::__uniq_ptr_impl<int,std::default_delete<int[]> > *this)
{
  return *std::get<0ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_ @ 0x4AEC */
const std::__tuple_element_t<0UL,std::tuple<int *,std::default_delete<int[]> > > *__fastcall std::get<0ul,int *,std::default_delete<int []>>(
        const std::tuple<int *,std::default_delete<int[]> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4B10 */
int *const *__fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(
        const std::_Tuple_impl<0UL,int *,std::default_delete<int[]> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_ @ 0x4B34 */
int *const *__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(
        const std::_Head_base<0UL,int *,false> *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head(__t);
}


/* Function: _ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE @ 0x4B58 */
int **__cdecl std::forward<int *&>(std::remove_reference<int *&>::type *__t)
{
  return __t;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_ @ 0x4B6C */
void __fastcall std::_Head_base<0ul,int *,false>::_Head_base<int *&>(std::_Head_base<0UL,int *,false> *this, int **__h)
{
  this->_M_head_impl = *std::forward<int *&>(__h);
}


/* Function: .term_proc @ 0x4BA8 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _Znam @ 0x18150 */

/* FAILED to decompile: _ZSt9terminatev @ 0x18160 */

/* FAILED to decompile: strlen @ 0x18168 */

/* FAILED to decompile: __cxa_begin_catch @ 0x18170 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x18178 */

/* FAILED to decompile: __cxa_finalize @ 0x18180 */

/* FAILED to decompile: __libc_start_main @ 0x18190 */

/* FAILED to decompile: _ZdlPv @ 0x18198 */

/* FAILED to decompile: _Znwm @ 0x181A0 */

/* FAILED to decompile: strncpy @ 0x181A8 */

/* FAILED to decompile: __cxa_bad_typeid @ 0x181B0 */

/* FAILED to decompile: __dynamic_cast @ 0x181B8 */

/* FAILED to decompile: __cxa_atexit @ 0x181C0 */

/* FAILED to decompile: _ZdaPv @ 0x181C8 */

/* FAILED to decompile: strcmp @ 0x181D8 */

/* FAILED to decompile: __cxa_rethrow @ 0x181E0 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x181E8 */

/* FAILED to decompile: abort @ 0x181F0 */

/* FAILED to decompile: __cxa_end_catch @ 0x181F8 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x18200 */

/* FAILED to decompile: __cxa_throw @ 0x18208 */

/* FAILED to decompile: _Unwind_Resume @ 0x18218 */

/* FAILED to decompile: printf @ 0x18220 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x18228 */

/* FAILED to decompile: __gmon_start__ @ 0x18238 */

/* Total functions decompiled: 218, failed: 25 */
