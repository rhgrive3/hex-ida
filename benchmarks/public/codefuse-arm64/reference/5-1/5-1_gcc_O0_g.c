/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1820 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_1840 @ 0x1840 */
void sub_1840()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x1A00 */
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


/* Function: call_weak_fn @ 0x1A34 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1A50 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x1A80 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1AC0 */
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


/* Function: frame_dummy @ 0x1B10 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: _Z20test_cpp_member_funcv @ 0x1B14 */
int __cdecl test_cpp_member_func()
{
  int r1; // [xsp+14h] [xbp+14h]
  int r2; // [xsp+18h] [xbp+18h]
  SimpleClass obj; // [xsp+20h] [xbp+20h] BYREF

  SimpleClass::SimpleClass(&obj, 5, "Test");
  SimpleClass::setValue(&obj, 10);
  r1 = SimpleClass::getValue(&obj);
  r2 = SimpleClass::compute(&obj, 3);
  return r1 + r2 + SimpleClass::getClassID();
}


/* Function: _Z20test_cpp_constructorv @ 0x1BBC */
int __cdecl test_cpp_constructor()
{
  int result; // [xsp+14h] [xbp+14h]
  int resulta; // [xsp+14h] [xbp+14h]
  LifecycleClass obj; // [xsp+18h] [xbp+18h] BYREF

  LifecycleClass::LifecycleClass(&obj, 5u);
  result = LifecycleClass::getData(&obj, 2u);
  resulta = result + LifecycleClass::getInstanceCount();
  LifecycleClass::~LifecycleClass(&obj);
  return resulta + 1000 * LifecycleClass::getInstanceCount();
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1C70 */
int __cdecl call_virtual_func(Base *obj, int x)
{
  return (*obj->_vptr.Base)(obj, (unsigned int)x);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1CA0 */
int __cdecl test_cpp_virtual_func()
{
  int v0; // w19
  int r1; // [xsp+20h] [xbp+20h]
  int r2; // [xsp+24h] [xbp+24h]
  int r3; // [xsp+28h] [xbp+28h]
  Base base; // [xsp+30h] [xbp+30h] BYREF
  Base *pb; // [xsp+38h] [xbp+38h]
  Base *pd; // [xsp+40h] [xbp+40h]
  Derived derived; // [xsp+48h] [xbp+48h] BYREF

  base._vptr.Base = (int (**)(...))&off_16B10;
  Derived::Derived(&derived, 3);
  r1 = Base::virtual_func(&base, 5);
  r2 = Derived::virtual_func(&derived, 5);
  pb = &base;
  pd = &derived;
  r3 = call_virtual_func(&base, 5);
  v0 = r1 + r2 + r3 + call_virtual_func(pd, 5);
  Derived::~Derived(&derived);
  Base::~Base(&base);
  return v0;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1DA8 */
int __cdecl test_cpp_multiple_inheritance()
{
  int v0; // w19
  int r1; // [xsp+2Ch] [xbp+2Ch]
  MultiDerived obj; // [xsp+48h] [xbp+48h] BYREF

  MultiDerived::MultiDerived(&obj);
  obj.dataA = 100;
  obj.dataB = 200;
  r1 = (*obj._vptr.BaseA)(&obj);
  v0 = r1 + (*(__int64 (__fastcall **)(BaseB *))obj._vptr.BaseB)(&obj.BaseB) + (&obj != (MultiDerived *)&obj.BaseB);
  MultiDerived::~MultiDerived(&obj);
  return v0;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1EA4 */
int __cdecl test_cpp_diamond_inheritance()
{
  int v0; // w19
  int r1; // [xsp+28h] [xbp+28h]
  _BYTE obj[44]; // [xsp+38h] [xbp+38h] BYREF

  DiamondDerived::DiamondDerived((DiamondDerived *const)obj);
  *(_DWORD *)&obj[40] = 50;
  r1 = (**(__int64 (__fastcall ***)(_BYTE *))&obj[32])(&obj[32]);
  *(_DWORD *)&obj[40] = 100;
  v0 = r1 + (**(__int64 (__fastcall ***)(_BYTE *))&obj[32])(&obj[32]);
  DiamondDerived::~DiamondDerived((DiamondDerived *const)obj);
  return v0;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1F78 */
int __cdecl test_cpp_operator_overload()
{
  int v0; // w0
  bool eq; // [xsp+1Fh] [xbp+1Fh]
  Point p1; // [xsp+20h] [xbp+20h] BYREF
  Point p2; // [xsp+28h] [xbp+28h] BYREF
  Point p3; // [xsp+30h] [xbp+30h] BYREF

  Point::Point(&p1, 1, 2);
  Point::Point(&p2, 3, 4);
  p3 = Point::operator+(&p1, &p2);
  eq = Point::operator==(&p1, &p2);
  Point::operator++(&p3);
  if ( eq )
    v0 = 0;
  else
    v0 = 10;
  return v0 + p3.x + p3.y;
}


/* Function: _Z22test_cpp_template_funcv @ 0x2034 */
int __cdecl test_cpp_template_func()
{
  int a; // [xsp+14h] [xbp+14h] BYREF
  int b; // [xsp+18h] [xbp+18h] BYREF
  int r1; // [xsp+1Ch] [xbp+1Ch]
  double r2; // [xsp+20h] [xbp+20h]

  r1 = template_max<int>(3, 7);
  r2 = template_max<double>(2.5, 1.5);
  a = 10;
  b = 20;
  template_swap<int>(&a, &b);
  return (int)r2 + r1 + a + b;
}


/* Function: _Z23test_cpp_template_classv @ 0x20DC */
int __cdecl test_cpp_template_class()
{
  int r1; // [xsp+10h] [xbp+10h]
  int r2; // [xsp+14h] [xbp+14h]
  Container<int> int_container; // [xsp+20h] [xbp+20h] BYREF
  Container<double> double_container; // [xsp+50h] [xbp+50h] BYREF

  Container<int>::Container(&int_container);
  Container<int>::push(&int_container, 10);
  Container<int>::push(&int_container, 20);
  Container<int>::push(&int_container, 30);
  r1 = Container<int>::get(&int_container, 0);
  r2 = Container<int>::getSize(&int_container);
  Container<double>::Container(&double_container);
  Container<double>::push(&double_container, 3.14);
  return r1 + r2 + (int)Container<double>::get(&double_container, 0);
}


/* Function: _ZZ15test_cpp_lambdavENKUliE_clEi @ 0x21B0 */
int __cdecl test_cpp_lambda(void)::{lambda(int)#1}::operator()(
        const const struct {int __capture_by_value;int *__capture_by_ref;} *const __closure,
        int x)
{
  *__closure->__capture_by_ref += 5;
  return __closure->__capture_by_value * x + *__closure->__capture_by_ref;
}


/* Function: _Z15test_cpp_lambdav @ 0x2200 */
// local variable allocation has failed, the output may be wrong!
int __cdecl test_cpp_lambda()
{
  int capture_by_ref; // [xsp+18h] [xbp+18h] BYREF
  int capture_by_value; // [xsp+1Ch] [xbp+1Ch]
  int lambda2; // [xsp+28h] [xbp+28h] OVERLAPPED BYREF
  int *p_capture_by_ref; // [xsp+30h] [xbp+30h]

  capture_by_value = 10;
  capture_by_ref = 20;
  lambda2 = 10;
  p_capture_by_ref = &capture_by_ref;
  return test_cpp_lambda(void)::{lambda(int)#1}::operator()(
           (const const struct {int __capture_by_value;int *__capture_by_ref;} *const)&lambda2,
           3)
       + 30;
}


/* Function: _Z18test_cpp_exceptionv @ 0x2290 */
int __cdecl __noreturn test_cpp_exception()
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _ZZ18test_cpp_smart_ptrvENKUlPiE_clES_ @ 0x23B4 */
void __cdecl test_cpp_smart_ptr(void)::{lambda(int *)#1}::operator()(
        const const struct {_BYTE gap0;} *const __closure,
        int *p)
{
  *p = -1;
  if ( p )
    operator delete(p, 4u);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x23F0 */
int __cdecl test_cpp_smart_ptr()
{
  int *v0; // x0
  std::remove_reference<std::unique_ptr<int>&>::type *v1; // x0
  int *v2; // x2
  int *v3; // x0
  int v4; // w19
  $44B1EA910F358000232221CCB0AF3F67 deleter; // [xsp+28h] [xbp+28h] BYREF
  int r1; // [xsp+2Ch] [xbp+2Ch]
  int r2; // [xsp+30h] [xbp+30h]
  int r3; // [xsp+34h] [xbp+34h]
  std::unique_ptr<int> ptr2; // [xsp+38h] [xbp+38h] BYREF
  std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > ptr3; // [xsp+48h] [xbp+48h] BYREF

  v0 = (int *)operator new(4u);
  *v0 = 100;
  std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(&ptr2, v0);
  *std::unique_ptr<int>::operator*(&ptr2) = 200;
  v1 = std::move<std::unique_ptr<int> &>(&ptr2);
  std::unique_ptr<int>::unique_ptr((std::unique_ptr<int> *const)&ptr2._M_t._M_t.std::_Head_base<0,int*,false>, v1);
  r1 = *std::unique_ptr<int>::operator*((const std::unique_ptr<int> *const)&ptr2._M_t._M_t.std::_Head_base<0,int*,false>);
  v2 = (int *)operator new[](0x14u);
  *v2 = 1;
  v2[1] = 2;
  v2[2] = 3;
  v2[3] = 4;
  v2[4] = 5;
  std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(
    (std::unique_ptr<int []> *const)&ptr3,
    v2);
  r2 = *std::unique_ptr<int []>::operator[]((const std::unique_ptr<int []> *const)&ptr3, 2u);
  v3 = (int *)operator new(4u);
  *v3 = 500;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::unique_ptr<test_cpp_smart_ptr(void)::{lambda(int *)#1},void>(
    (std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const)&ptr3._M_t._M_t.std::_Head_base<0,int*,false>,
    v3,
    (const std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::deleter_type *)&deleter);
  r3 = *std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::operator*((const std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const)&ptr3._M_t._M_t.std::_Head_base<0,int*,false>);
  v4 = r1 + r2 + r3;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::~unique_ptr((std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const)&ptr3._M_t._M_t.std::_Head_base<0,int*,false>);
  std::unique_ptr<int []>::~unique_ptr((std::unique_ptr<int []> *const)&ptr3);
  std::unique_ptr<int>::~unique_ptr((std::unique_ptr<int> *const)&ptr2._M_t._M_t.std::_Head_base<0,int*,false>);
  std::unique_ptr<int>::~unique_ptr(&ptr2);
  return v4;
}


/* Function: _Z13test_cpp_rttiv @ 0x25A0 */
int __cdecl test_cpp_rtti()
{
  RTTIDerivedA *v0; // x19
  RTTIDerivedB *v1; // x19
  const RTTIDerivedA *v2; // x0
  const RTTIDerivedB *v3; // x0
  const char *v4; // x0
  int result; // [xsp+2Ch] [xbp+2Ch]
  int resulta; // [xsp+2Ch] [xbp+2Ch]
  RTTIBase *obj1; // [xsp+30h] [xbp+30h]

  v0 = (RTTIDerivedA *)operator new(8u);
  v0->_vptr.RTTIBase = 0;
  RTTIDerivedA::RTTIDerivedA(v0);
  obj1 = v0;
  v1 = (RTTIDerivedB *)operator new(8u);
  v1->_vptr.RTTIBase = 0;
  RTTIDerivedB::RTTIDerivedB(v1);
  result = 0;
  if ( !obj1 )
    __cxa_bad_typeid();
  if ( std::type_info::operator==(
         *((const std::type_info *const *)obj1->_vptr.RTTIBase - 1),
         (const std::type_info *)&`typeinfo for'RTTIDerivedA) )
  {
    result = 10;
  }
  if ( !v1 )
    __cxa_bad_typeid();
  if ( std::type_info::operator==(
         *((const std::type_info *const *)v1->_vptr.RTTIBase - 1),
         (const std::type_info *)&`typeinfo for'RTTIDerivedB) )
  {
    result += 20;
  }
  v2 = (const RTTIDerivedA *)__dynamic_cast(
                               obj1,
                               (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                               (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
                               0);
  if ( v2 )
    result += RTTIDerivedA::derivedA_data(v2);
  v3 = (const RTTIDerivedB *)__dynamic_cast(
                               v1,
                               (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                               (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
                               0);
  if ( v3 )
    result += RTTIDerivedB::derivedB_data(v3);
  v4 = std::type_info::name(*((const std::type_info *const *)obj1->_vptr.RTTIBase - 1));
  resulta = strlen(v4) + result;
  (*((void (**)(void))obj1->_vptr.RTTIBase + 1))();
  (*((void (__fastcall **)(RTTIDerivedB *))v1->_vptr.RTTIBase + 1))(v1);
  return resulta;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x2794 */
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

  puts(asc_45E8);
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


/* Function: main @ 0x28A4 */
int __fastcall __noreturn main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: std::__uniq_ptr_data_int_test_cpp_smart_ptr()::_lambda(int_)__true_false_::__uniq_ptr_data_const_test_cpp_smart_ptr()::_lambda(int_)_&_ @ 0x28BC */
void __cdecl std::__uniq_ptr_data_int_test_cpp_smart_ptr__::_lambda_int____true_false_::__uniq_ptr_data_const_test_cpp_smart_ptr__::_lambda_int_____(
        std::__uniq_ptr_data<int,test_cpp_smart_ptr()::<lambda(int*)>,true,false> *const this,
        std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer a2,
        const const struct {_BYTE gap0;} *a3)
{
  std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(
    this,
    a2,
    a3);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_EC2IS1_vEES0_RKS1_ @ 0x28EC */
void __cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::unique_ptr<test_cpp_smart_ptr(void)::{lambda(int *)#1},void>(
        std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this,
        std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer __p,
        const std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::deleter_type *__d)
{
  std::__uniq_ptr_data_int_test_cpp_smart_ptr__::_lambda_int____true_false_::__uniq_ptr_data_const_test_cpp_smart_ptr__::_lambda_int_____(
    &this->_M_t,
    __p,
    __d);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_ED2Ev @ 0x291C */
void __cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::~unique_ptr(
        std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::deleter_type *deleter; // x19
  int **v2; // x0
  std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer *__ptr; // [xsp+38h] [xbp+38h]

  __ptr = std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(&this->_M_t);
  if ( *__ptr )
  {
    deleter = std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get_deleter(this);
    v2 = std::move<int *&>(__ptr);
    test_cpp_smart_ptr(void)::{lambda(int *)#1}::operator()(deleter, *v2);
  }
  *__ptr = 0;
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_EdeEv @ 0x2984 */
std::__add_lvalue_reference_helper<int,true>::type __cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::operator*(
        const std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get(this);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_EC2IRKS1_EES0_OT_ @ 0x29A8 */
void __cdecl std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(
        std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this,
        std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer __p,
        const const struct {_BYTE gap0;} *__d)
{
  const const struct {_BYTE gap0;} *v4; // x0
  std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer __pa; // [xsp+30h] [xbp+30h] BYREF
  std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> > *thisa; // [xsp+38h] [xbp+38h]

  thisa = this;
  __pa = __p;
  v4 = std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>((std::remove_reference<const test_cpp_smart_ptr()::<lambda(int*)>&>::type *)__d);
  std::tuple<int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::tuple<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,true>(
    &this->_M_t,
    &__pa,
    v4);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E6_M_ptrEv @ 0x29F4 */
std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer *__cdecl std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(
        std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(&this->_M_t);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_E11get_deleterEv @ 0x2A10 */
std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::deleter_type *__cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get_deleter(
        std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return (std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::deleter_type *)std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_deleter(&this->_M_t);
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_E3getEv @ 0x2A2C */
std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer __cdecl std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get(
        const std::unique_ptr<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(&this->_M_t);
}


/* Function: _ZSt7forwardIRKZ18test_cpp_smart_ptrvEUlPiE_EOT_RNSt16remove_referenceIS4_E4typeE @ 0x2A48 */
const const struct {_BYTE gap0;} *__cdecl std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(
        std::remove_reference<const test_cpp_smart_ptr()::<lambda(int*)>&>::type *__t)
{
  return (const const struct {_BYTE gap0;} *)__t;
}


/* Function: _ZNSt5tupleIJPiZ18test_cpp_smart_ptrvEUlS0_E_EEC2IRS0_RKS1_Lb1EEEOT_OT0_ @ 0x2A5C */
void __cdecl std::tuple<int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::tuple<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,true>(
        std::tuple<int*,test_cpp_smart_ptr()::<lambda(int*)> > *const this,
        int **__a1,
        const const struct {_BYTE gap0;} *__a2)
{
  int **v4; // x20
  const const struct {_BYTE gap0;} *v5; // x0

  v4 = std::forward<int *&>(__a1);
  v5 = std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>((std::remove_reference<const test_cpp_smart_ptr()::<lambda(int*)>&>::type *)__a2);
  std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,void>(
    this,
    v4,
    v5);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2AAC */
std::__tuple_element_t_1 *__cdecl std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(
        std::tuple<int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__t);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E10_M_deleterEv @ 0x2AC8 */
struct {_BYTE gap0;} *__cdecl std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_deleter(
        std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return (struct {_BYTE gap0;} *)std::get<1ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E6_M_ptrEv @ 0x2AE4 */
std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> >::pointer __cdecl std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(
        const std::__uniq_ptr_impl<int,test_cpp_smart_ptr()::<lambda(int*)> > *const this)
{
  return *std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(&this->_M_t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EEC2IRS0_JRKS1_EvEEOT_DpOT0_ @ 0x2B04 */
void __cdecl std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,void>(
        std::_Tuple_impl<0,int*,test_cpp_smart_ptr()::<lambda(int*)> > *const this,
        int **__head,
        const const struct {_BYTE gap0;} *a3)
{
  const const struct {_BYTE gap0;} *v3; // x0
  int **v4; // x0

  v3 = std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>((std::remove_reference<const test_cpp_smart_ptr()::<lambda(int*)>&>::type *)a3);
  std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl(this, v3);
  v4 = std::forward<int *&>(__head);
  std::_Head_base<0ul,int *,false>::_Head_base<int *&>((std::_Head_base<0,int*,false> *const)this, v4);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvEUlS0_E_EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2B58 */
int **__cdecl std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(
        std::_Tuple_impl<0,int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__t);
}


/* Function: _ZSt3getILm1EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2B74 */
std::__tuple_element_t *__cdecl std::get<1ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(
        std::tuple<int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return (std::__tuple_element_t *)std::__get_helper_1_test_cpp_smart_ptr__::_lambda_int_____(__t);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_ @ 0x2B90 */
const std::__tuple_element_t_1 *__cdecl std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(
        const std::tuple<int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__t);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvEUlPiE_EEC2ERKS1_ @ 0x2BAC */
void __cdecl std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl(
        std::_Tuple_impl<1,test_cpp_smart_ptr()::<lambda(int*)> > *const this,
        const const struct {_BYTE gap0;} *__head)
{
  std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_Head_base(this, __head);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EE7_M_headERS2_ @ 0x2BD4 */
int **__cdecl std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(
        std::_Tuple_impl<0,int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((std::_Head_base<0,int*,false> *)__t);
}


/* Function: std::__get_helper_1_test_cpp_smart_ptr()::_lambda(int_)___ @ 0x2BF0 */
struct {_BYTE gap0;} *__cdecl std::__get_helper_1_test_cpp_smart_ptr__::_lambda_int_____(
        std::_Tuple_impl<1,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvEUlS0_E_EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2C0C */
int *const *__cdecl std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(
        const std::_Tuple_impl<0,int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvEUlPiE_Lb1EEC2ERKS1_ @ 0x2C28 */
void __cdecl std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_Head_base(
        std::_Head_base<1,test_cpp_smart_ptr()::<lambda(int*)>,true> *const this,
        const const struct {_BYTE gap0;} *__h)
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvEUlPiE_EE7_M_headERS2_ @ 0x2C40 */
struct {_BYTE gap0;} *__cdecl std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(
        std::_Tuple_impl<1,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EE7_M_headERKS2_ @ 0x2C5C */
int *const *__cdecl std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(
        const std::_Tuple_impl<0,int*,test_cpp_smart_ptr()::<lambda(int*)> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((const std::_Head_base<0,int*,false> *)__t);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvEUlPiE_Lb1EE7_M_headERS2_ @ 0x2C78 */
struct {_BYTE gap0;} *__cdecl std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_M_head(
        std::_Head_base<1,test_cpp_smart_ptr()::<lambda(int*)>,true> *__b)
{
  return (struct {_BYTE gap0;} *)__b;
}


/* Function: _Z41__static_initialization_and_destruction_0ii @ 0x2C8C */
void __cdecl __static_initialization_and_destruction_0(int __initialize_p, int __priority)
{
  if ( __initialize_p == 1 && __priority == 0xFFFF )
  {
    std::ios_base::Init::Init(&std::__ioinit);
    __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
  }
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x2CEC */
void __cdecl GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  __static_initialization_and_destruction_0(1, 0xFFFF);
}


/* Function: _ZNKSt9type_info4nameEv @ 0x2D08 */
const char *__cdecl std::type_info::name(const std::type_info *const this)
{
  if ( **((_BYTE **)this + 1) == 42 )
    return (const char *)(*((_QWORD *)this + 1) + 1LL);
  else
    return (const char *)*((_QWORD *)this + 1);
}


/* Function: _ZNKSt9type_infoeqERKS_ @ 0x2D44 */
bool __cdecl std::type_info::operator==(const std::type_info *const this, const std::type_info *__arg)
{
  return *((_QWORD *)this + 1) == *((_QWORD *)__arg + 1)
      || **((_BYTE **)this + 1) != 42 && !strcmp(*((const char **)this + 1), *((const char **)__arg + 1));
}


/* Function: _ZN11SimpleClassC2EiPKc @ 0x2DB8 */
void __cdecl SimpleClass::SimpleClass(SimpleClass *const this, int v, const char *n)
{
  this->value = v;
  strncpy(this->name, n, 0x1Fu);
  this->name[31] = 0;
}


/* Function: _ZNK11SimpleClass8getValueEv @ 0x2E00 */
int __cdecl SimpleClass::getValue(const SimpleClass *const this)
{
  return this->value;
}


/* Function: _ZN11SimpleClass8setValueEi @ 0x2E18 */
void __cdecl SimpleClass::setValue(SimpleClass *const this, int v)
{
  this->value = v;
}


/* Function: _ZNK11SimpleClass7computeEi @ 0x2E3C */
int __cdecl SimpleClass::compute(const SimpleClass *const this, int x)
{
  int v2; // w19

  v2 = this->value * x;
  return v2 + strlen(this->name);
}


/* Function: _ZN11SimpleClass10getClassIDEv @ 0x2E80 */
int __cdecl SimpleClass::getClassID()
{
  return 4660;
}


/* Function: _ZN14LifecycleClassC2Em @ 0x2E88 */
void __cdecl LifecycleClass::LifecycleClass(LifecycleClass *const this, size_t s)
{
  size_t i; // [xsp+28h] [xbp+28h]

  this->size = s;
  if ( s > 0x1FFFFFFFFFFFFFFELL )
    __cxa_throw_bad_array_new_length();
  this->data = (int *)operator new[](4 * s);
  for ( i = 0; i < s; ++i )
    this->data[i] = 10 * i;
  ++LifecycleClass::instance_count;
}


/* Function: _ZN14LifecycleClassD2Ev @ 0x2F50 */
void __cdecl LifecycleClass::~LifecycleClass(LifecycleClass *const this)
{
  if ( this->data )
    operator delete[](this->data);
  --LifecycleClass::instance_count;
}


/* Function: _ZNK14LifecycleClass7getDataEm @ 0x2FA0 */
int __cdecl LifecycleClass::getData(const LifecycleClass *const this, size_t idx)
{
  if ( idx >= this->size )
    return -1;
  else
    return this->data[idx];
}


/* Function: _ZN14LifecycleClass16getInstanceCountEv @ 0x2FE8 */
int __cdecl LifecycleClass::getInstanceCount()
{
  return LifecycleClass::instance_count;
}


/* Function: _ZN4Base12virtual_funcEi @ 0x2FF8 */
int __cdecl Base::virtual_func(Base *const this, int x)
{
  return x + 1;
}


/* Function: _ZNK4Base7getNameEv @ 0x3014 */
const char *__cdecl Base::getName(const Base *const this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x302C */
void __cdecl Base::~Base(Base *const this)
{
  this->_vptr.Base = (int (**)(...))&off_16B10;
}


/* Function: _ZN4BaseD0Ev @ 0x3050 */
void __cdecl Base::~Base(Base *const this)
{
  Base::~Base(this);
  operator delete(this, 8u);
}


/* Function: _ZN4BaseC2Ev @ 0x3078 */
void __cdecl Base::Base(Base *const this)
{
  this->_vptr.Base = (int (**)(...))&off_16B10;
}


/* Function: _ZN7DerivedC2Ei @ 0x309C */
void __cdecl Derived::Derived(Derived *const this, int m)
{
  Base::Base(this);
  this->_vptr.Base = (int (**)(...))&off_16AE0;
  this->multiplier = m;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x30DC */
int __cdecl Derived::virtual_func(Derived *const this, int x)
{
  return this->multiplier * x;
}


/* Function: _ZNK7Derived7getNameEv @ 0x3100 */
const char *__cdecl Derived::getName(const Derived *const this)
{
  return "Derived";
}


/* Function: _ZN5BaseA5funcAEv @ 0x3118 */
int __cdecl BaseA::funcA(BaseA *const this)
{
  return 10;
}


/* Function: _ZN5BaseAD2Ev @ 0x312C */
void __cdecl BaseA::~BaseA(BaseA *const this)
{
  this->_vptr.BaseA = (int (**)(...))&off_16AB8;
}


/* Function: _ZN5BaseAD0Ev @ 0x3150 */
void __cdecl BaseA::~BaseA(BaseA *const this)
{
  BaseA::~BaseA(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN5BaseB5funcBEv @ 0x3178 */
int __cdecl BaseB::funcB(BaseB *const this)
{
  return 20;
}


/* Function: _ZN5BaseBD2Ev @ 0x318C */
void __cdecl BaseB::~BaseB(BaseB *const this)
{
  this->_vptr.BaseB = (int (**)(...))&off_16A90;
}


/* Function: _ZN5BaseBD0Ev @ 0x31B0 */
void __cdecl BaseB::~BaseB(BaseB *const this)
{
  BaseB::~BaseB(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x31D8 */
int __cdecl MultiDerived::funcA(MultiDerived *const this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x31EC */
int __cdecl MultiDerived::funcB(MultiDerived *const this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x3200 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return MultiDerived::funcB((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN5BaseAC2Ev @ 0x3208 */
void __cdecl BaseA::BaseA(BaseA *const this)
{
  this->_vptr.BaseA = (int (**)(...))&off_16AB8;
}


/* Function: _ZN5BaseBC2Ev @ 0x322C */
void __cdecl BaseB::BaseB(BaseB *const this)
{
  this->_vptr.BaseB = (int (**)(...))&off_16A90;
}


/* Function: _ZN12MultiDerivedC2Ev @ 0x3250 */
void __cdecl MultiDerived::MultiDerived(MultiDerived *const this)
{
  BaseA::BaseA(this);
  BaseB::BaseB(&this->BaseB);
  this->_vptr.BaseA = (int (**)(...))&off_16A38;
  this->_vptr.BaseB = (int (**)(...))&off_16A68;
}


/* Function: _ZN11VirtualBase4funcEv @ 0x329C */
int __cdecl VirtualBase::func(VirtualBase *const this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x32B0 */
void __cdecl VirtualBase::~VirtualBase(VirtualBase *const this)
{
  this->_vptr.VirtualBase = (int (**)(...))&off_16A10;
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x32D4 */
void __cdecl VirtualBase::~VirtualBase(VirtualBase *const this)
{
  VirtualBase::~VirtualBase(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN7MiddleA4funcEv @ 0x32FC */
int __cdecl MiddleA::func(MiddleA *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 150;
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x3330 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return MiddleA::func((MiddleA *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 3)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x3340 */
int __cdecl MiddleB::func(MiddleB *const this)
{
  return *(int *)((char *)&this->dataB + *((_QWORD *)this->_vptr.MiddleB - 3)) + 200;
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x3374 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return MiddleB::func((MiddleB *)((char *)this + *((_QWORD *)this->_vptr.MiddleB - 3)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x3384 */
int __cdecl DiamondDerived::func(DiamondDerived *const this)
{
  return *(int *)((char *)&this->dataA + *((_QWORD *)this->_vptr.MiddleA - 3)) + 250;
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x33B8 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 3)));
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x33C8 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZN11VirtualBaseC2Ev @ 0x33D0 */
void __cdecl VirtualBase::VirtualBase(VirtualBase *const this)
{
  this->_vptr.VirtualBase = (int (**)(...))&off_16A10;
}


/* Function: _ZN7MiddleAC2Ev @ 0x33F4 */
void __cdecl MiddleA::MiddleA(MiddleA *const this, const void **const __vtt_parm)
{
  this->_vptr.MiddleA = (int (**)(...))*__vtt_parm;
  *(int (***)(...))((char *)&this->_vptr.MiddleA + *((_QWORD *)this->_vptr.MiddleA - 3)) = (int (**)(...))__vtt_parm[1];
}


/* Function: _ZN7MiddleAD2Ev @ 0x3444 */
void __cdecl MiddleA::~MiddleA(MiddleA *const this, const void **const __vtt_parm)
{
  this->_vptr.MiddleA = (int (**)(...))*__vtt_parm;
  *(int (***)(...))((char *)&this->_vptr.MiddleA + *((_QWORD *)this->_vptr.MiddleA - 3)) = (int (**)(...))__vtt_parm[1];
}


/* Function: _ZN7MiddleBC2Ev @ 0x3494 */
void __cdecl MiddleB::MiddleB(MiddleB *const this, const void **const __vtt_parm)
{
  this->_vptr.MiddleB = (int (**)(...))*__vtt_parm;
  *(int (***)(...))((char *)&this->_vptr.MiddleB + *((_QWORD *)this->_vptr.MiddleB - 3)) = (int (**)(...))__vtt_parm[1];
}


/* Function: _ZN7MiddleBD2Ev @ 0x34E4 */
void __cdecl MiddleB::~MiddleB(MiddleB *const this, const void **const __vtt_parm)
{
  this->_vptr.MiddleB = (int (**)(...))*__vtt_parm;
  *(int (***)(...))((char *)&this->_vptr.MiddleB + *((_QWORD *)this->_vptr.MiddleB - 3)) = (int (**)(...))__vtt_parm[1];
}


/* Function: _ZN14DiamondDerivedC1Ev @ 0x3534 */
void __cdecl DiamondDerived::DiamondDerived(DiamondDerived *const this)
{
  VirtualBase::VirtualBase((VirtualBase *const)&this->MiddleB);
  MiddleA::MiddleA(this, (const void **const)off_16900);
  MiddleB::MiddleB((MiddleB *const)(&this->dataA + 2), (const void **const)off_16910);
  this->_vptr.MiddleA = (int (**)(...))&off_16878;
  this->_vptr.MiddleB = (int (**)(...))&off_168E0;
  *((_QWORD *)&this->dataA + 1) = &off_168A8;
}


/* Function: _ZN5PointC2Eii @ 0x35C0 */
void __cdecl Point::Point(Point *const this, int _x, int _y)
{
  this->x = _x;
  this->y = _y;
}


/* Function: _ZNK5PointplERKS_ @ 0x35F4 */
Point __cdecl Point::operator+(const Point *const this, const Point *other)
{
  Point v3; // [xsp+20h] [xbp+20h] BYREF

  Point::Point(&v3, this->x + other->x, this->y + other->y);
  return v3;
}


/* Function: _ZNK5PointeqERKS_ @ 0x3684 */
bool __cdecl Point::operator==(const Point *const this, const Point *other)
{
  return this->x == other->x && this->y == other->y;
}


/* Function: _ZN5PointppEv @ 0x36D4 */
Point *__cdecl Point::operator++(Point *const this)
{
  ++this->x;
  ++this->y;
  return this;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x3710 */
int __cdecl template_max<int>(int a, int b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x3740 */
double __cdecl template_max<double>(double a, double b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x3774 */
void __cdecl template_swap<int>(int *a, int *b)
{
  int temp; // [xsp+1Ch] [xbp-4h]

  temp = *a;
  *a = *b;
  *b = temp;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x37B4 */
void __cdecl Container<int>::Container(Container<int> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x37D0 */
void __cdecl Container<int>::push(Container<int> *const this, int value)
{
  int size; // w0

  if ( this->size <= 9 )
  {
    size = this->size;
    this->size = size + 1;
    this->data[size] = value;
  }
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x381C */
int __cdecl Container<int>::get(const Container<int> *const this, int idx)
{
  if ( idx < 0 || idx >= this->size )
    return 0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x3864 */
int __cdecl Container<int>::getSize(const Container<int> *const this)
{
  return this->size;
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x387C */
void __cdecl Container<double>::Container(Container<double> *const this)
{
  this->size = 0;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x3898 */
void __cdecl Container<double>::push(Container<double> *const this, double value)
{
  int size; // w0

  if ( this->size <= 9 )
  {
    size = this->size;
    this->size = size + 1;
    this->data[size] = value;
  }
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x38E4 */
double __cdecl Container<double>::get(const Container<double> *const this, int idx)
{
  if ( idx < 0 || idx >= this->size )
    return 0.0;
  else
    return this->data[idx];
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x392C */
int __cdecl Container<double>::getSize(const Container<double> *const this)
{
  return this->size;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_ @ 0x3944 */
void __cdecl std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *const this,
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_ @ 0x396C */
void __cdecl std::unique_ptr<int>::unique_ptr(std::unique_ptr<int> *const this, std::unique_ptr<int> *a2)
{
  std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(&this->_M_t, &a2->_M_t);
}


/* Function: _ZNK8RTTIBase7getTypeEv @ 0x3994 */
int __cdecl RTTIBase::getType(const RTTIBase *const this)
{
  return 0;
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x39A8 */
int __cdecl RTTIDerivedA::getType(const RTTIDerivedA *const this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedA13derivedA_dataEv @ 0x39BC */
int __cdecl RTTIDerivedA::derivedA_data(const RTTIDerivedA *const this)
{
  return 100;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x39D0 */
int __cdecl RTTIDerivedB::getType(const RTTIDerivedB *const this)
{
  return 2;
}


/* Function: _ZNK12RTTIDerivedB13derivedB_dataEv @ 0x39E4 */
int __cdecl RTTIDerivedB::derivedB_data(const RTTIDerivedB *const this)
{
  return 200;
}


/* Function: _ZN8RTTIBaseC2Ev @ 0x39F8 */
void __cdecl RTTIBase::RTTIBase(RTTIBase *const this)
{
  this->_vptr.RTTIBase = (int (**)(...))off_16848;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x3A1C */
void __cdecl RTTIBase::~RTTIBase(RTTIBase *const this)
{
  this->_vptr.RTTIBase = (int (**)(...))off_16848;
}


/* Function: _ZN8RTTIBaseD0Ev @ 0x3A40 */
void __cdecl RTTIBase::~RTTIBase(RTTIBase *const this)
{
  RTTIBase::~RTTIBase(this);
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAC2Ev @ 0x3A68 */
void __cdecl RTTIDerivedA::RTTIDerivedA(RTTIDerivedA *const this)
{
  RTTIBase::RTTIBase(this);
  this->_vptr.RTTIBase = (int (**)(...))off_16820;
}


/* Function: _ZN12RTTIDerivedBC2Ev @ 0x3A98 */
void __cdecl RTTIDerivedB::RTTIDerivedB(RTTIDerivedB *const this)
{
  RTTIBase::RTTIBase(this);
  this->_vptr.RTTIBase = (int (**)(...))off_167F8;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi @ 0x3AC8 */
void __cdecl ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(
        std::__uniq_ptr_data<int,std::default_delete<int>,true,true> *const this,
        std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi @ 0x3AF0 */
void __cdecl std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(
        std::unique_ptr<int> *const this,
        std::unique_ptr<int>::pointer __p)
{
  ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(&this->_M_t, __p);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x3B18 */
void __cdecl std::unique_ptr<int>::~unique_ptr(std::unique_ptr<int> *const this)
{
  std::unique_ptr<int>::deleter_type *deleter; // x19
  int **v2; // x0
  std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer *__ptr; // [xsp+38h] [xbp+38h]

  __ptr = std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(&this->_M_t);
  if ( *__ptr )
  {
    deleter = std::unique_ptr<int>::get_deleter(this);
    v2 = std::move<int *&>(__ptr);
    std::default_delete<int>::operator()(deleter, *v2);
  }
  *__ptr = 0;
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEEdeEv @ 0x3B80 */
std::__add_lvalue_reference_helper<int,true>::type __cdecl std::unique_ptr<int>::operator*(
        const std::unique_ptr<int> *const this)
{
  return std::unique_ptr<int>::get(this);
}


/* Function: _ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_ @ 0x3BA4 */
std::remove_reference<std::unique_ptr<int>&>::type *__cdecl std::move<std::unique_ptr<int> &>(
        std::unique_ptr<int> *__t)
{
  return __t;
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_ @ 0x3BB8 */
void __cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<0,int*,std::default_delete<int> > *const this,
        std::_Tuple_impl<0,int*,std::default_delete<int> > *a2)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(this, a2);
  *(_QWORD *)&this->std::_Tuple_impl<1,std::default_delete<int> >::std::_Head_base<1,std::default_delete<int>,true>::_M_head_impl.gap0 = *(_QWORD *)&a2->std::_Tuple_impl<1,std::default_delete<int> >::std::_Head_base<1,std::default_delete<int>,true>::_M_head_impl.gap0;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_ @ 0x3BF0 */
void __cdecl std::tuple<int *,std::default_delete<int>>::tuple(
        std::tuple<int*,std::default_delete<int> > *const this,
        std::tuple<int*,std::default_delete<int> > *a2)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(this, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_ @ 0x3C18 */
void __cdecl std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *const this,
        std::__uniq_ptr_impl<int,std::default_delete<int> > *__u)
{
  std::tuple<int*,std::default_delete<int> > *v3; // x0

  v3 = std::move<std::tuple<int *,std::default_delete<int>> &>(&__u->_M_t);
  std::tuple<int *,std::default_delete<int>>::tuple(&this->_M_t, v3);
  *std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__u) = 0;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi @ 0x3C60 */
void __cdecl ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(
        std::__uniq_ptr_data<int,std::default_delete<int []>,true,true> *const this,
        std::__uniq_ptr_impl<int,std::default_delete<int []> >::pointer a2)
{
  std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(this, a2);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_ @ 0x3C88 */
void __cdecl std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(
        std::unique_ptr<int []> *const this,
        int *__p)
{
  ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(&this->_M_t, __p);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x3CB0 */
void __cdecl std::unique_ptr<int []>::~unique_ptr(std::unique_ptr<int []> *const this)
{
  std::unique_ptr<int []>::deleter_type *deleter; // x0
  std::__uniq_ptr_impl<int,std::default_delete<int []> >::pointer *__ptr; // [xsp+28h] [xbp+28h]

  __ptr = std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(&this->_M_t);
  if ( *__ptr )
  {
    deleter = std::unique_ptr<int []>::get_deleter(this);
    std::default_delete<int []>::operator()<int>(deleter, *__ptr);
  }
  *__ptr = 0;
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm @ 0x3D0C */
std::__add_lvalue_reference_helper<int,true>::type __cdecl std::unique_ptr<int []>::operator[](
        const std::unique_ptr<int []> *const this,
        std::size_t __i)
{
  return &std::unique_ptr<int []>::get(this)[__i];
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi @ 0x3D44 */
void __cdecl std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *const this,
        std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer __p)
{
  std::tuple<int *,std::default_delete<int>>::tuple<true,true>(&this->_M_t);
  *std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(this) = __p;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x3D80 */
std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer *__cdecl std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *const this)
{
  return std::get<0ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv @ 0x3D9C */
std::unique_ptr<int>::deleter_type *__cdecl std::unique_ptr<int>::get_deleter(std::unique_ptr<int> *const this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(&this->_M_t);
}


/* Function: _ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_ @ 0x3DB8 */
std::remove_reference<int*&>::type *__cdecl std::move<int *&>(int **__t)
{
  return __t;
}


/* Function: _ZNKSt14default_deleteIiEclEPi @ 0x3DCC */
void __cdecl std::default_delete<int>::operator()(const std::default_delete<int> *const this, int *__ptr)
{
  if ( __ptr )
    operator delete(__ptr, 4u);
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv @ 0x3DFC */
std::unique_ptr<int>::pointer __cdecl std::unique_ptr<int>::get(const std::unique_ptr<int> *const this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(&this->_M_t);
}


/* Function: _ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_ @ 0x3E18 */
std::remove_reference<std::tuple<int*,std::default_delete<int> >&>::type *__cdecl std::move<std::tuple<int *,std::default_delete<int>> &>(
        std::tuple<int*,std::default_delete<int> > *__t)
{
  return __t;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_ @ 0x3E2C */
void __cdecl std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<1,std::default_delete<int> > *const this,
        std::_Tuple_impl<1,std::default_delete<int> > *__in)
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi @ 0x3E44 */
void __cdecl std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(
        std::__uniq_ptr_impl<int,std::default_delete<int []> > *const this,
        std::__uniq_ptr_impl<int,std::default_delete<int []> >::pointer __p)
{
  std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(&this->_M_t);
  *std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(this) = __p;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x3E80 */
std::__uniq_ptr_impl<int,std::default_delete<int []> >::pointer *__cdecl std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(
        std::__uniq_ptr_impl<int,std::default_delete<int []> > *const this)
{
  return std::get<0ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv @ 0x3E9C */
std::unique_ptr<int []>::deleter_type *__cdecl std::unique_ptr<int []>::get_deleter(
        std::unique_ptr<int []> *const this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(&this->_M_t);
}


/* Function: _ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsrSt14is_convertibleIPA_T_PS0_E5valueEvE4typeEPS5_ @ 0x3EB8 */
void __cdecl std::default_delete<int []>::operator()<int>(const std::default_delete<int []> *const this, int *__ptr)
{
  if ( __ptr )
    operator delete[](__ptr);
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv @ 0x3EE8 */
std::unique_ptr<int []>::pointer __cdecl std::unique_ptr<int []>::get(const std::unique_ptr<int []> *const this)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(&this->_M_t);
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv @ 0x3F04 */
void __cdecl std::tuple<int *,std::default_delete<int>>::tuple<true,true>(
        std::tuple<int*,std::default_delete<int> > *const this)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(this);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x3F24 */
std::__tuple_element_t *__cdecl std::get<0ul,int *,std::default_delete<int>>(
        std::tuple<int*,std::default_delete<int> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(__t);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv @ 0x3F40 */
std::default_delete<int> *__cdecl std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(
        std::__uniq_ptr_impl<int,std::default_delete<int> > *const this)
{
  return (std::default_delete<int> *)std::get<1ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x3F5C */
std::__uniq_ptr_impl<int,std::default_delete<int> >::pointer __cdecl std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(
        const std::__uniq_ptr_impl<int,std::default_delete<int> > *const this)
{
  return *std::get<0ul,int *,std::default_delete<int>>(&this->_M_t);
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv @ 0x3F7C */
void __cdecl std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(
        std::tuple<int*,std::default_delete<int []> > *const this)
{
  std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(this);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x3F9C */
std::__tuple_element_t_0 *__cdecl std::get<0ul,int *,std::default_delete<int []>>(
        std::tuple<int*,std::default_delete<int []> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(__t);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv @ 0x3FB8 */
std::default_delete<int []> *__cdecl std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(
        std::__uniq_ptr_impl<int,std::default_delete<int []> > *const this)
{
  return (std::default_delete<int []> *)std::get<1ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x3FD4 */
std::__uniq_ptr_impl<int,std::default_delete<int []> >::pointer __cdecl std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(
        const std::__uniq_ptr_impl<int,std::default_delete<int []> > *const this)
{
  return *std::get<0ul,int *,std::default_delete<int []>>(&this->_M_t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev @ 0x3FF4 */
void __cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<0,int*,std::default_delete<int> > *const this)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(this);
  std::_Head_base<0ul,int *,false>::_Head_base((std::_Head_base<0,int*,false> *const)this);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x401C */
int **__cdecl std::__get_helper<0ul,int *,std::default_delete<int>>(
        std::_Tuple_impl<0,int*,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4038 */
std::__tuple_element_t *__cdecl std::get<1ul,int *,std::default_delete<int>>(
        std::tuple<int*,std::default_delete<int> > *__t)
{
  return (std::__tuple_element_t *)std::__get_helper<1ul,std::default_delete<int>>(__t);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_ @ 0x4054 */
const std::__tuple_element_t *__cdecl std::get<0ul,int *,std::default_delete<int>>(
        const std::tuple<int*,std::default_delete<int> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev @ 0x4070 */
void __cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(
        std::_Tuple_impl<0,int*,std::default_delete<int []> > *const this)
{
  std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(this);
  std::_Head_base<0ul,int *,false>::_Head_base((std::_Head_base<0,int*,false> *const)this);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4098 */
int **__cdecl std::__get_helper<0ul,int *,std::default_delete<int []>>(
        std::_Tuple_impl<0,int*,std::default_delete<int []> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x40B4 */
std::__tuple_element_t *__cdecl std::get<1ul,int *,std::default_delete<int []>>(
        std::tuple<int*,std::default_delete<int []> > *__t)
{
  return (std::__tuple_element_t *)std::__get_helper<1ul,std::default_delete<int []>>(__t);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_ @ 0x40D0 */
const std::__tuple_element_t_0 *__cdecl std::get<0ul,int *,std::default_delete<int []>>(
        const std::tuple<int*,std::default_delete<int []> > *__t)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(__t);
}


/* Function: _ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE @ 0x40EC */
int **__cdecl std::forward<int *&>(std::remove_reference<int*&>::type *__t)
{
  return __t;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev @ 0x4100 */
void __cdecl std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(
        std::_Tuple_impl<1,std::default_delete<int> > *const this)
{
  std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(this);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2Ev @ 0x4120 */
void __cdecl std::_Head_base<0ul,int *,false>::_Head_base(std::_Head_base<0,int*,false> *const this)
{
  this->_M_head_impl = 0;
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_ @ 0x413C */
int **__cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(
        std::_Tuple_impl<0,int*,std::default_delete<int> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((std::_Head_base<0,int*,false> *)__t);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x4158 */
std::default_delete<int> *__cdecl std::__get_helper<1ul,std::default_delete<int>>(
        std::_Tuple_impl<1,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4174 */
int *const *__cdecl std::__get_helper<0ul,int *,std::default_delete<int>>(
        const std::_Tuple_impl<0,int*,std::default_delete<int> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev @ 0x4190 */
void __cdecl std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(
        std::_Tuple_impl<1,std::default_delete<int []> > *const this)
{
  std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(this);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_ @ 0x41B0 */
int **__cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(
        std::_Tuple_impl<0,int*,std::default_delete<int []> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((std::_Head_base<0,int*,false> *)__t);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x41CC */
std::default_delete<int []> *__cdecl std::__get_helper<1ul,std::default_delete<int []>>(
        std::_Tuple_impl<1,std::default_delete<int []> > *__t)
{
  return std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x41E8 */
int *const *__cdecl std::__get_helper<0ul,int *,std::default_delete<int []>>(
        const std::_Tuple_impl<0,int*,std::default_delete<int []> > *__t)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__t);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_ @ 0x4204 */
void __cdecl std::_Head_base<0ul,int *,false>::_Head_base<int *&>(std::_Head_base<0,int*,false> *const this, int **__h)
{
  this->_M_head_impl = *std::forward<int *&>(__h);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev @ 0x4234 */
void __cdecl std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(
        std::_Head_base<1,std::default_delete<int>,true> *const this)
{
  ;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_ @ 0x4248 */
int **__cdecl std::_Head_base<0ul,int *,false>::_M_head(std::_Head_base<0,int*,false> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_ @ 0x425C */
std::default_delete<int> *__cdecl std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(
        std::_Tuple_impl<1,std::default_delete<int> > *__t)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_ @ 0x4278 */
int *const *__cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(
        const std::_Tuple_impl<0,int*,std::default_delete<int> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((const std::_Head_base<0,int*,false> *)__t);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev @ 0x4294 */
void __cdecl std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(
        std::_Head_base<1,std::default_delete<int []>,true> *const this)
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_ @ 0x42A8 */
std::default_delete<int []> *__cdecl std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(
        std::_Tuple_impl<1,std::default_delete<int []> > *__t)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(__t);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_ @ 0x42C4 */
int *const *__cdecl std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(
        const std::_Tuple_impl<0,int*,std::default_delete<int []> > *__t)
{
  return std::_Head_base<0ul,int *,false>::_M_head((const std::_Head_base<0,int*,false> *)__t);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_ @ 0x42E0 */
std::default_delete<int> *__cdecl std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(
        std::_Head_base<1,std::default_delete<int>,true> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_ @ 0x42F4 */
int *const *__cdecl std::_Head_base<0ul,int *,false>::_M_head(const std::_Head_base<0,int*,false> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_ @ 0x4308 */
std::default_delete<int []> *__cdecl std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(
        std::_Head_base<1,std::default_delete<int []>,true> *__b)
{
  return &__b->_M_head_impl;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x431C */
void __cdecl RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  this->_vptr.RTTIBase = (int (**)(...))off_167F8;
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x434C */
void __cdecl RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *const this)
{
  RTTIDerivedB::~RTTIDerivedB(this);
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x4374 */
void __cdecl RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  this->_vptr.RTTIBase = (int (**)(...))off_16820;
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x43A4 */
void __cdecl RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *const this)
{
  RTTIDerivedA::~RTTIDerivedA(this);
  operator delete(this, 8u);
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x43CC */
void __cdecl DiamondDerived::~DiamondDerived(DiamondDerived *const this)
{
  this->_vptr.MiddleA = (int (**)(...))&off_16878;
  this->_vptr.MiddleB = (int (**)(...))&off_168E0;
  *((_QWORD *)&this->dataA + 1) = &off_168A8;
  MiddleB::~MiddleB((MiddleB *const)(&this->dataA + 2), (const void **const)off_16910);
  MiddleA::~MiddleA(this, (const void **const)off_16900);
  VirtualBase::~VirtualBase((VirtualBase *const)&this->MiddleB);
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x4458 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x4460 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4)));
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x4470 */
void __cdecl DiamondDerived::~DiamondDerived(DiamondDerived *const this)
{
  DiamondDerived::~DiamondDerived(this);
  operator delete(this, 0x30u);
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x4498 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x44A0 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *((_QWORD *)this->_vptr.MiddleA - 4)));
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x44B0 */
void __cdecl MultiDerived::~MultiDerived(MultiDerived *const this)
{
  this->_vptr.BaseA = (int (**)(...))&off_16A38;
  this->_vptr.BaseB = (int (**)(...))&off_16A68;
  BaseB::~BaseB(&this->BaseB);
  BaseA::~BaseA(this);
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x44FC */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x4504 */
void __cdecl MultiDerived::~MultiDerived(MultiDerived *const this)
{
  MultiDerived::~MultiDerived(this);
  operator delete(this, 0x20u);
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x452C */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN7DerivedD2Ev @ 0x4534 */
void __cdecl Derived::~Derived(Derived *const this)
{
  this->_vptr.Base = (int (**)(...))&off_16AE0;
  Base::~Base(this);
}


/* Function: _ZN7DerivedD0Ev @ 0x4564 */
void __cdecl Derived::~Derived(Derived *const this)
{
  Derived::~Derived(this);
  operator delete(this, 0x10u);
}


/* Function: .term_proc @ 0x458C */
void term_proc()
{
  ;
}


/* FAILED to decompile: _Znam @ 0x17098 */

/* FAILED to decompile: puts @ 0x170A8 */

/* FAILED to decompile: strlen @ 0x170B0 */

/* FAILED to decompile: __stack_chk_fail @ 0x170B8 */

/* FAILED to decompile: __cxa_begin_catch @ 0x170C0 */

/* FAILED to decompile: __cxa_allocate_exception @ 0x170D0 */

/* FAILED to decompile: __cxa_finalize @ 0x170D8 */

/* FAILED to decompile: __libc_start_main @ 0x170E8 */

/* FAILED to decompile: _Znwm @ 0x170F0 */

/* FAILED to decompile: _ZdlPvm @ 0x170F8 */

/* FAILED to decompile: strncpy @ 0x17100 */

/* FAILED to decompile: __cxa_bad_typeid @ 0x17108 */

/* FAILED to decompile: __dynamic_cast @ 0x17110 */

/* FAILED to decompile: __cxa_atexit @ 0x17118 */

/* FAILED to decompile: _ZdaPv @ 0x17120 */

/* FAILED to decompile: __cxa_throw_bad_array_new_length @ 0x17130 */

/* FAILED to decompile: strcmp @ 0x17138 */

/* FAILED to decompile: __cxa_rethrow @ 0x17140 */

/* FAILED to decompile: _ZNSt8ios_base4InitC1Ev @ 0x17148 */

/* FAILED to decompile: abort @ 0x17150 */

/* FAILED to decompile: __cxa_end_catch @ 0x17158 */

/* FAILED to decompile: __gxx_personality_v0 @ 0x17160 */

/* FAILED to decompile: __cxa_throw @ 0x17168 */

/* FAILED to decompile: _Unwind_Resume @ 0x17178 */

/* FAILED to decompile: printf @ 0x17180 */

/* FAILED to decompile: _ZNSt8ios_base4InitD1Ev @ 0x17188 */

/* FAILED to decompile: __gmon_start__ @ 0x17198 */

/* Total functions decompiled: 205, failed: 27 */
