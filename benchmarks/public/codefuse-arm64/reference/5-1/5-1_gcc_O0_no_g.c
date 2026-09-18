/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_gcc_O0_no_g
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
__int64 test_cpp_member_func(void)
{
  SimpleClass *v0; // x0
  int Value; // [xsp+14h] [xbp+14h]
  _BYTE v3[40]; // [xsp+20h] [xbp+20h] BYREF

  SimpleClass::SimpleClass((SimpleClass *)v3, 5, "Test");
  SimpleClass::setValue((SimpleClass *)v3, 10);
  Value = SimpleClass::getValue((SimpleClass *)v3);
  v0 = (SimpleClass *)SimpleClass::compute((SimpleClass *)v3, 3);
  return Value + (_DWORD)v0 + (unsigned int)SimpleClass::getClassID(v0);
}


/* Function: _Z20test_cpp_constructorv @ 0x1BBC */
__int64 test_cpp_constructor(void)
{
  LifecycleClass *Data; // x0
  LifecycleClass *v1; // x0
  int v3; // [xsp+14h] [xbp+14h]
  _BYTE v4[16]; // [xsp+18h] [xbp+18h] BYREF

  LifecycleClass::LifecycleClass((LifecycleClass *)v4, 5u);
  Data = (LifecycleClass *)(unsigned int)LifecycleClass::getData((LifecycleClass *)v4, 2u);
  v3 = (_DWORD)Data + LifecycleClass::getInstanceCount(Data);
  LifecycleClass::~LifecycleClass((LifecycleClass *)v4);
  return v3 + 1000 * (unsigned int)LifecycleClass::getInstanceCount(v1);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1C70 */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD, _QWORD), unsigned int a2)
{
  return (**a1)(a1, a2);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1CA0 */
__int64 test_cpp_virtual_func(void)
{
  unsigned int v0; // w19
  int v2; // [xsp+20h] [xbp+20h]
  int v3; // [xsp+24h] [xbp+24h]
  int v4; // [xsp+28h] [xbp+28h]
  __int64 (__fastcall **v5[2])(_QWORD, _QWORD); // [xsp+30h] [xbp+30h] BYREF
  _BYTE *v6; // [xsp+40h] [xbp+40h]
  _BYTE v7[16]; // [xsp+48h] [xbp+48h] BYREF

  v5[0] = (__int64 (__fastcall **)(_QWORD, _QWORD))&off_16B10;
  Derived::Derived((Derived *)v7, 3);
  v2 = Base::virtual_func((Base *)v5, 5);
  v3 = Derived::virtual_func((Derived *)v7, 5);
  v5[1] = (__int64 (__fastcall **)(_QWORD, _QWORD))v5;
  v6 = v7;
  v4 = call_virtual_func(v5, 5u);
  v0 = v2 + v3 + v4 + call_virtual_func((__int64 (__fastcall ***)(_QWORD, _QWORD))v6, 5u);
  Derived::~Derived((Derived *)v7);
  Base::~Base((Base *)v5);
  return v0;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1DA8 */
__int64 test_cpp_multiple_inheritance(void)
{
  unsigned int v0; // w19
  int v2; // [xsp+2Ch] [xbp+2Ch]
  __int64 (__fastcall **v3)(_QWORD); // [xsp+48h] [xbp+48h] BYREF
  int v4; // [xsp+50h] [xbp+50h]
  __int64 (__fastcall **v5)(_QWORD); // [xsp+58h] [xbp+58h] BYREF
  int v6; // [xsp+60h] [xbp+60h]

  MultiDerived::MultiDerived((MultiDerived *)&v3);
  v4 = 100;
  v6 = 200;
  v2 = (*v3)(&v3);
  v0 = v2 + (*v5)(&v5) + (&v3 != &v5);
  MultiDerived::~MultiDerived((MultiDerived *)&v3);
  return v0;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x1EA4 */
__int64 test_cpp_diamond_inheritance(void)
{
  unsigned int v0; // w19
  int v2; // [xsp+28h] [xbp+28h]
  _BYTE v3[32]; // [xsp+38h] [xbp+38h] BYREF
  __int64 (__fastcall **v4)(_QWORD); // [xsp+58h] [xbp+58h] BYREF
  int v5; // [xsp+60h] [xbp+60h]

  DiamondDerived::DiamondDerived((DiamondDerived *)v3);
  v5 = 50;
  v2 = (*v4)(&v4);
  v5 = 100;
  v0 = v2 + (*v4)(&v4);
  DiamondDerived::~DiamondDerived((DiamondDerived *)v3);
  return v0;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x1F78 */
__int64 test_cpp_operator_overload(void)
{
  int v0; // w0
  char v2; // [xsp+1Fh] [xbp+1Fh]
  _BYTE v3[8]; // [xsp+20h] [xbp+20h] BYREF
  _BYTE v4[8]; // [xsp+28h] [xbp+28h] BYREF
  __int64 v5; // [xsp+30h] [xbp+30h] BYREF

  Point::Point((Point *)v3, 1, 2);
  Point::Point((Point *)v4, 3, 4);
  v5 = Point::operator+(v3, v4);
  v2 = Point::operator==(v3, v4);
  Point::operator++(&v5);
  if ( v2 )
    v0 = 0;
  else
    v0 = 10;
  return (unsigned int)(v0 + v5 + HIDWORD(v5));
}


/* Function: _Z22test_cpp_template_funcv @ 0x2034 */
__int64 test_cpp_template_func(void)
{
  int v0; // w0
  int v2; // [xsp+14h] [xbp+14h] BYREF
  int v3; // [xsp+18h] [xbp+18h] BYREF
  int v4; // [xsp+1Ch] [xbp+1Ch]
  double v5; // [xsp+20h] [xbp+20h]

  template_max<int>(3, 7);
  v4 = v0;
  v5 = template_max<double>(2.5, 1.5);
  v2 = 10;
  v3 = 20;
  template_swap<int>(&v2, &v3);
  return (unsigned int)((int)v5 + v4 + v2 + v3);
}


/* Function: _Z23test_cpp_template_classv @ 0x20DC */
__int64 test_cpp_template_class(void)
{
  int v1; // [xsp+10h] [xbp+10h]
  int Size; // [xsp+14h] [xbp+14h]
  _BYTE v3[48]; // [xsp+20h] [xbp+20h] BYREF
  _BYTE v4[88]; // [xsp+50h] [xbp+50h] BYREF

  Container<int>::Container(v3, 0);
  Container<int>::push(v3, 10);
  Container<int>::push(v3, 20);
  Container<int>::push(v3, 30);
  v1 = Container<int>::get(v3, 0);
  Size = Container<int>::getSize(v3);
  Container<double>::Container(v4);
  Container<double>::push(v4, 3.14);
  return (unsigned int)(v1 + Size + (int)Container<double>::get(v4, 0));
}


/* Function: _ZZ15test_cpp_lambdavENKUliE_clEi @ 0x21B0 */
__int64 __fastcall test_cpp_lambda(void)::{lambda(int)#1}::operator()(__int64 a1, int a2)
{
  **(_DWORD **)(a1 + 8) += 5;
  return (unsigned int)(*(_DWORD *)a1 * a2 + **(_DWORD **)(a1 + 8));
}


/* Function: _Z15test_cpp_lambdav @ 0x2200 */
__int64 test_cpp_lambda(void)
{
  _DWORD v1[2]; // [xsp+18h] [xbp+18h] BYREF
  int v2; // [xsp+28h] [xbp+28h] BYREF
  _DWORD *v3; // [xsp+30h] [xbp+30h]

  v1[1] = 10;
  v1[0] = 20;
  v2 = 10;
  v3 = v1;
  return (unsigned int)test_cpp_lambda(void)::{lambda(int)#1}::operator()((__int64)&v2, 3) + 30;
}


/* Function: _Z18test_cpp_exceptionv @ 0x2290 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _ZZ18test_cpp_smart_ptrvENKUlPiE_clES_ @ 0x23B4 */
void __fastcall test_cpp_smart_ptr(void)::{lambda(int *)#1}::operator()(__int64 a1, _DWORD *a2)
{
  *a2 = -1;
  if ( a2 )
    operator delete(a2, 4u);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x23F0 */
__int64 test_cpp_smart_ptr(void)
{
  _DWORD *v0; // x0
  __int64 v1; // x0
  _DWORD *v2; // x2
  _DWORD *v3; // x0
  unsigned int v4; // w19
  _BYTE v6[4]; // [xsp+28h] [xbp+28h] BYREF
  int v7; // [xsp+2Ch] [xbp+2Ch]
  int v8; // [xsp+30h] [xbp+30h]
  int v9; // [xsp+34h] [xbp+34h]
  _BYTE v10[8]; // [xsp+38h] [xbp+38h] BYREF
  _BYTE v11[8]; // [xsp+40h] [xbp+40h] BYREF
  _BYTE v12[8]; // [xsp+48h] [xbp+48h] BYREF
  _BYTE v13[8]; // [xsp+50h] [xbp+50h] BYREF

  v0 = (_DWORD *)operator new(4u);
  *v0 = 100;
  std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(v10, v0);
  *(_DWORD *)std::unique_ptr<int>::operator*(v10) = 200;
  v1 = std::move<std::unique_ptr<int> &>(v10);
  std::unique_ptr<int>::unique_ptr(v11, v1);
  v7 = *(_DWORD *)std::unique_ptr<int>::operator*(v11);
  v2 = (_DWORD *)operator new[](0x14u);
  *v2 = 1;
  v2[1] = 2;
  v2[2] = 3;
  v2[3] = 4;
  v2[4] = 5;
  std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(v12, v2);
  v8 = *(_DWORD *)std::unique_ptr<int []>::operator[](v12, 2);
  v3 = (_DWORD *)operator new(4u);
  *v3 = 500;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::unique_ptr<test_cpp_smart_ptr(void)::{lambda(int *)#1},void>(
    v13,
    v3,
    v6);
  v9 = *(_DWORD *)std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::operator*(v13);
  v4 = v7 + v8 + v9;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::~unique_ptr(v13);
  std::unique_ptr<int []>::~unique_ptr(v12);
  std::unique_ptr<int>::~unique_ptr(v11);
  std::unique_ptr<int>::~unique_ptr(v10);
  return v4;
}


/* Function: _Z13test_cpp_rttiv @ 0x25A0 */
__int64 test_cpp_rtti(void)
{
  RTTIDerivedA *v0; // x19
  RTTIDerivedB *v1; // x19
  RTTIDerivedA *v2; // x0
  RTTIDerivedB *v3; // x0
  const char *v4; // x0
  int v6; // [xsp+2Ch] [xbp+2Ch]
  unsigned int v7; // [xsp+2Ch] [xbp+2Ch]
  RTTIDerivedA *lpsrc; // [xsp+30h] [xbp+30h]

  v0 = (RTTIDerivedA *)operator new(8u);
  *(_QWORD *)v0 = 0;
  RTTIDerivedA::RTTIDerivedA(v0);
  lpsrc = v0;
  v1 = (RTTIDerivedB *)operator new(8u);
  *(_QWORD *)v1 = 0;
  RTTIDerivedB::RTTIDerivedB(v1);
  v6 = 0;
  if ( !lpsrc )
    __cxa_bad_typeid();
  if ( (unsigned __int8)std::type_info::operator==(*(_QWORD *)(*(_QWORD *)lpsrc - 8LL), &`typeinfo for'RTTIDerivedA) )
    v6 = 10;
  if ( !v1 )
    __cxa_bad_typeid();
  if ( (unsigned __int8)std::type_info::operator==(*(_QWORD *)(*(_QWORD *)v1 - 8LL), &`typeinfo for'RTTIDerivedB) )
    v6 += 20;
  v2 = (RTTIDerivedA *)__dynamic_cast(
                         lpsrc,
                         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
                         0);
  if ( v2 )
    v6 += RTTIDerivedA::derivedA_data(v2);
  v3 = (RTTIDerivedB *)__dynamic_cast(
                         v1,
                         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
                         0);
  if ( v3 )
    v6 += RTTIDerivedB::derivedB_data(v3);
  v4 = (const char *)std::type_info::name(*(std::type_info **)(*(_QWORD *)lpsrc - 8LL));
  v7 = strlen(v4) + v6;
  (*(void (**)(void))(*(_QWORD *)lpsrc + 8LL))();
  (*(void (__fastcall **)(RTTIDerivedB *))(*(_QWORD *)v1 + 8LL))(v1);
  return v7;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x2794 */
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
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvEUlPiE_Lb1ELb0EECI2St15__uniq_ptr_implIiS1_EIRKS1_EES0_OT_ @ 0x28BC */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvEUlPiE_Lb1ELb0EECI2St15__uniq_ptr_implIiS1_EIRKS1_EES0_OT_(
        __int64 a1,
        __int64 a2,
        __int64 a3)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(
           a1,
           a2,
           a3);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_EC2IS1_vEES0_RKS1_ @ 0x28EC */
__int64 __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::unique_ptr<test_cpp_smart_ptr(void)::{lambda(int *)#1},void>(
        __int64 a1,
        __int64 a2,
        __int64 a3)
{
  return ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvEUlPiE_Lb1ELb0EECI2St15__uniq_ptr_implIiS1_EIRKS1_EES0_OT_(
           a1,
           a2,
           a3);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_ED2Ev @ 0x291C */
_QWORD *__fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::~unique_ptr(__int64 a1)
{
  __int64 deleter; // x19
  _DWORD **v2; // x0
  _QWORD *result; // x0
  _QWORD *v5; // [xsp+38h] [xbp+38h]

  v5 = (_QWORD *)std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(a1);
  if ( *v5 )
  {
    deleter = std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get_deleter(a1);
    v2 = (_DWORD **)std::move<int *&>(v5);
    test_cpp_smart_ptr(void)::{lambda(int *)#1}::operator()(deleter, *v2);
  }
  result = v5;
  *v5 = 0;
  return result;
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_EdeEv @ 0x2984 */
__int64 __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::operator*(__int64 a1)
{
  return std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get(a1);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_EC2IRKS1_EES0_OT_ @ 0x29A8 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(
        __int64 a1,
        __int64 a2,
        __int64 a3)
{
  __int64 v4; // x0
  _QWORD v6[2]; // [xsp+30h] [xbp+30h] BYREF

  v6[1] = a1;
  v6[0] = a2;
  v4 = std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>(a3);
  return std::tuple<int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::tuple<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,true>(
           a1,
           v6,
           v4);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E6_M_ptrEv @ 0x29F4 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_E11get_deleterEv @ 0x2A10 */
__int64 __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get_deleter(__int64 a1)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_deleter(a1);
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvEUlPiE_E3getEv @ 0x2A2C */
__int64 __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::get(__int64 a1)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(a1);
}


/* Function: _ZSt7forwardIRKZ18test_cpp_smart_ptrvEUlPiE_EOT_RNSt16remove_referenceIS4_E4typeE @ 0x2A48 */
void std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>()
{
  ;
}


/* Function: _ZNSt5tupleIJPiZ18test_cpp_smart_ptrvEUlS0_E_EEC2IRS0_RKS1_Lb1EEEOT_OT0_ @ 0x2A5C */
__int64 __fastcall std::tuple<int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::tuple<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,true>(
        __int64 a1,
        __int64 a2)
{
  __int64 v3; // x20
  __int64 v4; // x0

  v3 = std::forward<int *&>(a2);
  std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>();
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,void>(
           a1,
           v3,
           v4);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2AAC */
__int64 __fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E10_M_deleterEv @ 0x2AC8 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvEUlPiE_E6_M_ptrEv @ 0x2AE4 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EEC2IRS0_JRKS1_EvEEOT_DpOT0_ @ 0x2B04 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::{lambda(int *)#1} const&,void>(
        __int64 a1,
        __int64 a2)
{
  __int64 v2; // x0
  __int64 v3; // x0

  std::forward<test_cpp_smart_ptr(void)::{lambda(int *)#1} const&>();
  std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl(a1, v2);
  v3 = std::forward<int *&>(a2);
  return std::_Head_base<0ul,int *,false>::_Head_base<int *&>(a1, v3);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvEUlS0_E_EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2B58 */
__int64 __fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(a1);
}


/* Function: _ZSt3getILm1EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2B74 */
__int64 __fastcall std::get<1ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::__get_helper<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_ @ 0x2B90 */
__int64 __fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvEUlPiE_EEC2ERKS1_ @ 0x2BAC */
__int64 __fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_Tuple_impl(
        __int64 a1,
        __int64 a2)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_Head_base(a1, a2);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EE7_M_headERS2_ @ 0x2BD4 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm1EZ18test_cpp_smart_ptrvEUlPiE_JEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2BF0 */
__int64 __fastcall std::__get_helper<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvEUlS0_E_EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2C0C */
__int64 __fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvEUlPiE_Lb1EEC2ERKS1_ @ 0x2C28 */
void std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_Head_base()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvEUlPiE_EE7_M_headERS2_ @ 0x2C40 */
__int64 __fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvEUlS0_E_EE7_M_headERKS2_ @ 0x2C5C */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::{lambda(int *)#1}>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvEUlPiE_Lb1EE7_M_headERS2_ @ 0x2C78 */
void std::_Head_base<1ul,test_cpp_smart_ptr(void)::{lambda(int *)#1},true>::_M_head()
{
  ;
}


/* Function: _Z41__static_initialization_and_destruction_0ii @ 0x2C8C */
__int64 __fastcall __static_initialization_and_destruction_0(__int64 result, int a2)
{
  result = (unsigned int)result;
  if ( (_DWORD)result == 1 )
  {
    result = 0xFFFF;
    if ( a2 == 0xFFFF )
    {
      std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
      return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
    }
  }
  return result;
}


/* Function: _GLOBAL__sub_I__Z20test_cpp_member_funcv @ 0x2CEC */
__int64 GLOBAL__sub_I__Z20test_cpp_member_funcv()
{
  return __static_initialization_and_destruction_0(1, 0xFFFF);
}


/* Function: _ZNKSt9type_info4nameEv @ 0x2D08 */
__int64 __fastcall std::type_info::name(std::type_info *this)
{
  if ( **((_BYTE **)this + 1) == 42 )
    return *((_QWORD *)this + 1) + 1LL;
  else
    return *((_QWORD *)this + 1);
}


/* Function: _ZNKSt9type_infoeqERKS_ @ 0x2D44 */
bool __fastcall std::type_info::operator==(__int64 a1, __int64 a2)
{
  return *(_QWORD *)(a1 + 8) == *(_QWORD *)(a2 + 8)
      || **(_BYTE **)(a1 + 8) != 42 && !strcmp(*(const char **)(a1 + 8), *(const char **)(a2 + 8));
}


/* Function: _ZN11SimpleClassC2EiPKc @ 0x2DB8 */
void __fastcall SimpleClass::SimpleClass(SimpleClass *this, int a2, const char *a3)
{
  *(_DWORD *)this = a2;
  strncpy((char *)this + 4, a3, 0x1Fu);
  *((_BYTE *)this + 35) = 0;
}


/* Function: _ZNK11SimpleClass8getValueEv @ 0x2E00 */
__int64 __fastcall SimpleClass::getValue(SimpleClass *this)
{
  return *(unsigned int *)this;
}


/* Function: _ZN11SimpleClass8setValueEi @ 0x2E18 */
_DWORD *__fastcall SimpleClass::setValue(_DWORD *this, int a2)
{
  *this = a2;
  return this;
}


/* Function: _ZNK11SimpleClass7computeEi @ 0x2E3C */
__int64 __fastcall SimpleClass::compute(SimpleClass *this, int a2)
{
  int v2; // w19

  v2 = *(_DWORD *)this * a2;
  return v2 + (unsigned int)strlen((const char *)this + 4);
}


/* Function: _ZN11SimpleClass10getClassIDEv @ 0x2E80 */
__int64 __fastcall SimpleClass::getClassID(SimpleClass *this)
{
  return 4660;
}


/* Function: _ZN14LifecycleClassC2Em @ 0x2E88 */
void __fastcall LifecycleClass::LifecycleClass(LifecycleClass *this, unsigned __int64 a2)
{
  unsigned __int64 i; // [xsp+28h] [xbp+28h]

  *((_QWORD *)this + 1) = a2;
  if ( a2 > 0x1FFFFFFFFFFFFFFELL )
    __cxa_throw_bad_array_new_length();
  *(_QWORD *)this = operator new[](4 * a2);
  for ( i = 0; i < a2; ++i )
    *(_DWORD *)(*(_QWORD *)this + 4 * i) = 10 * i;
  ++LifecycleClass::instance_count;
}


/* Function: _ZN14LifecycleClassD2Ev @ 0x2F50 */
void __fastcall LifecycleClass::~LifecycleClass(void **this)
{
  if ( *this )
    operator delete[](*this);
  --LifecycleClass::instance_count;
}


/* Function: _ZNK14LifecycleClass7getDataEm @ 0x2FA0 */
__int64 __fastcall LifecycleClass::getData(LifecycleClass *this, unsigned __int64 a2)
{
  if ( a2 >= *((_QWORD *)this + 1) )
    return 0xFFFFFFFFLL;
  else
    return *(unsigned int *)(*(_QWORD *)this + 4 * a2);
}


/* Function: _ZN14LifecycleClass16getInstanceCountEv @ 0x2FE8 */
__int64 __fastcall LifecycleClass::getInstanceCount(LifecycleClass *this)
{
  return (unsigned int)LifecycleClass::instance_count;
}


/* Function: _ZN4Base12virtual_funcEi @ 0x2FF8 */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x3014 */
const char *__fastcall Base::getName(Base *this)
{
  return "Base";
}


/* Function: _ZN4BaseD2Ev @ 0x302C */
void __fastcall Base::~Base(Base *this)
{
  *(_QWORD *)this = &off_16B10;
}


/* Function: _ZN4BaseD0Ev @ 0x3050 */
void __fastcall Base::~Base(Base *this)
{
  Base::~Base(this);
  operator delete(this, 8u);
}


/* Function: _ZN4BaseC2Ev @ 0x3078 */
void __fastcall Base::Base(Base *this)
{
  *(_QWORD *)this = &off_16B10;
}


/* Function: _ZN7DerivedC2Ei @ 0x309C */
void __fastcall Derived::Derived(Derived *this, int a2)
{
  Base::Base(this);
  *(_QWORD *)this = &off_16AE0;
  *((_DWORD *)this + 2) = a2;
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x30DC */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(*((_DWORD *)this + 2) * a2);
}


/* Function: _ZNK7Derived7getNameEv @ 0x3100 */
const char *__fastcall Derived::getName(Derived *this)
{
  return "Derived";
}


/* Function: _ZN5BaseA5funcAEv @ 0x3118 */
__int64 __fastcall BaseA::funcA(BaseA *this)
{
  return 10;
}


/* Function: _ZN5BaseAD2Ev @ 0x312C */
void __fastcall BaseA::~BaseA(BaseA *this)
{
  *(_QWORD *)this = &off_16AB8;
}


/* Function: _ZN5BaseAD0Ev @ 0x3150 */
void __fastcall BaseA::~BaseA(BaseA *this)
{
  BaseA::~BaseA(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN5BaseB5funcBEv @ 0x3178 */
__int64 __fastcall BaseB::funcB(BaseB *this)
{
  return 20;
}


/* Function: _ZN5BaseBD2Ev @ 0x318C */
void __fastcall BaseB::~BaseB(BaseB *this)
{
  *(_QWORD *)this = &off_16A90;
}


/* Function: _ZN5BaseBD0Ev @ 0x31B0 */
void __fastcall BaseB::~BaseB(BaseB *this)
{
  BaseB::~BaseB(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x31D8 */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
{
  return 30;
}


/* Function: _ZN12MultiDerived5funcBEv @ 0x31EC */
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x3200 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return MultiDerived::funcB((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN5BaseAC2Ev @ 0x3208 */
void __fastcall BaseA::BaseA(BaseA *this)
{
  *(_QWORD *)this = &off_16AB8;
}


/* Function: _ZN5BaseBC2Ev @ 0x322C */
void __fastcall BaseB::BaseB(BaseB *this)
{
  *(_QWORD *)this = &off_16A90;
}


/* Function: _ZN12MultiDerivedC2Ev @ 0x3250 */
void __fastcall MultiDerived::MultiDerived(MultiDerived *this)
{
  BaseA::BaseA(this);
  BaseB::BaseB((MultiDerived *)((char *)this + 16));
  *(_QWORD *)this = &off_16A38;
  *((_QWORD *)this + 2) = &off_16A68;
}


/* Function: _ZN11VirtualBase4funcEv @ 0x329C */
__int64 __fastcall VirtualBase::func(VirtualBase *this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x32B0 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  *(_QWORD *)this = &off_16A10;
}


/* Function: _ZN11VirtualBaseD0Ev @ 0x32D4 */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
{
  VirtualBase::~VirtualBase(this);
  operator delete(this, 0x10u);
}


/* Function: _ZN7MiddleA4funcEv @ 0x32FC */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x3330 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return MiddleA::func((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x3340 */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x3374 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return MiddleB::func((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x3384 */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x33B8 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x33C8 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZN11VirtualBaseC2Ev @ 0x33D0 */
void __fastcall VirtualBase::VirtualBase(VirtualBase *this)
{
  *(_QWORD *)this = &off_16A10;
}


/* Function: _ZN7MiddleAC2Ev @ 0x33F4 */
void __fastcall MiddleA::MiddleA(MiddleA *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN7MiddleAD2Ev @ 0x3444 */
void __fastcall MiddleA::~MiddleA(MiddleA *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN7MiddleBC2Ev @ 0x3494 */
void __fastcall MiddleB::MiddleB(MiddleB *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN7MiddleBD2Ev @ 0x34E4 */
void __fastcall MiddleB::~MiddleB(MiddleB *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN14DiamondDerivedC1Ev @ 0x3534 */
void __fastcall DiamondDerived::DiamondDerived(DiamondDerived *this)
{
  VirtualBase::VirtualBase((DiamondDerived *)((char *)this + 32));
  MiddleA::MiddleA(this, off_16900);
  MiddleB::MiddleB((DiamondDerived *)((char *)this + 16), off_16910);
  *(_QWORD *)this = &off_16878;
  *((_QWORD *)this + 4) = &off_168E0;
  *((_QWORD *)this + 2) = &off_168A8;
}


/* Function: _ZN5PointC2Eii @ 0x35C0 */
void __fastcall Point::Point(Point *this, int a2, int a3)
{
  *(_DWORD *)this = a2;
  *((_DWORD *)this + 1) = a3;
}


/* Function: _ZNK5PointplERKS_ @ 0x35F4 */
__int64 __fastcall Point::operator+(_DWORD *a1, _DWORD *a2)
{
  __int64 v3; // [xsp+20h] [xbp+20h] BYREF

  Point::Point((Point *)&v3, *a1 + *a2, a1[1] + a2[1]);
  return v3;
}


/* Function: _ZNK5PointeqERKS_ @ 0x3684 */
bool __fastcall Point::operator==(_DWORD *a1, _DWORD *a2)
{
  return *a1 == *a2 && a1[1] == a2[1];
}


/* Function: _ZN5PointppEv @ 0x36D4 */
_DWORD *__fastcall Point::operator++(_DWORD *result)
{
  ++*result;
  ++result[1];
  return result;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x3710 */
__int64 __fastcall template_max<int>(__int64 result, int a2)
{
  if ( (int)result <= a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x3740 */
double __fastcall template_max<double>(double result, double a2)
{
  if ( result <= a2 )
    return a2;
  return result;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x3774 */
int *__fastcall template_swap<int>(int *a1, int *a2)
{
  int *result; // x0
  int v3; // [xsp+1Ch] [xbp-4h]

  v3 = *a1;
  *a1 = *a2;
  result = a2;
  *a2 = v3;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x37B4 */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x37D0 */
__int64 __fastcall Container<int>::push(__int64 a1, int a2)
{
  __int64 result; // x0

  result = *(unsigned int *)(a1 + 40);
  if ( (int)result <= 9 )
  {
    LODWORD(result) = *(_DWORD *)(a1 + 40);
    *(_DWORD *)(a1 + 40) = result + 1;
    result = (int)result;
    *(_DWORD *)(a1 + 4LL * (int)result) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x381C */
__int64 __fastcall Container<int>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || a2 >= *(_DWORD *)(a1 + 40) )
    return 0;
  else
    return *(unsigned int *)(a1 + 4LL * a2);
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x3864 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x387C */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x3898 */
__int64 __fastcall Container<double>::push(__int64 a1, double a2)
{
  __int64 result; // x0

  result = *(unsigned int *)(a1 + 80);
  if ( (int)result <= 9 )
  {
    LODWORD(result) = *(_DWORD *)(a1 + 80);
    *(_DWORD *)(a1 + 80) = result + 1;
    result = (int)result;
    *(double *)(a1 + 8LL * (int)result) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x38E4 */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || a2 >= *(_DWORD *)(a1 + 80) )
    return 0.0;
  else
    return *(double *)(a1 + 8LL * a2);
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x392C */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_ @ 0x3944 */
__int64 __fastcall std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_ @ 0x396C */
__int64 __fastcall std::unique_ptr<int>::unique_ptr(__int64 a1, __int64 a2)
{
  return std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(a1, a2);
}


/* Function: _ZNK8RTTIBase7getTypeEv @ 0x3994 */
__int64 __fastcall RTTIBase::getType(RTTIBase *this)
{
  return 0;
}


/* Function: _ZNK12RTTIDerivedA7getTypeEv @ 0x39A8 */
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZNK12RTTIDerivedA13derivedA_dataEv @ 0x39BC */
__int64 __fastcall RTTIDerivedA::derivedA_data(RTTIDerivedA *this)
{
  return 100;
}


/* Function: _ZNK12RTTIDerivedB7getTypeEv @ 0x39D0 */
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZNK12RTTIDerivedB13derivedB_dataEv @ 0x39E4 */
__int64 __fastcall RTTIDerivedB::derivedB_data(RTTIDerivedB *this)
{
  return 200;
}


/* Function: _ZN8RTTIBaseC2Ev @ 0x39F8 */
void __fastcall RTTIBase::RTTIBase(RTTIBase *this)
{
  *(_QWORD *)this = off_16848;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x3A1C */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
{
  *(_QWORD *)this = off_16848;
}


/* Function: _ZN8RTTIBaseD0Ev @ 0x3A40 */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
{
  RTTIBase::~RTTIBase(this);
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAC2Ev @ 0x3A68 */
void __fastcall RTTIDerivedA::RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIBase::RTTIBase(this);
  *(_QWORD *)this = off_16820;
}


/* Function: _ZN12RTTIDerivedBC2Ev @ 0x3A98 */
void __fastcall RTTIDerivedB::RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIBase::RTTIBase(this);
  *(_QWORD *)this = off_167F8;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi @ 0x3AC8 */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi @ 0x3AF0 */
__int64 __fastcall std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(__int64 a1, __int64 a2)
{
  return ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(a1, a2);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x3B18 */
_QWORD *__fastcall std::unique_ptr<int>::~unique_ptr(__int64 a1)
{
  __int64 deleter; // x19
  _QWORD *v2; // x0
  _QWORD *result; // x0
  _QWORD *v5; // [xsp+38h] [xbp+38h]

  v5 = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a1);
  if ( *v5 )
  {
    deleter = std::unique_ptr<int>::get_deleter(a1);
    v2 = (_QWORD *)std::move<int *&>(v5);
    std::default_delete<int>::operator()(deleter, *v2);
  }
  result = v5;
  *v5 = 0;
  return result;
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEEdeEv @ 0x3B80 */
__int64 __fastcall std::unique_ptr<int>::operator*(__int64 a1)
{
  return std::unique_ptr<int>::get(a1);
}


/* Function: _ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_ @ 0x3BA4 */
void std::move<std::unique_ptr<int> &>()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_ @ 0x3BB8 */
_QWORD *__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(_QWORD *a1, _QWORD *a2)
{
  _QWORD *result; // x0

  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(a1, a2);
  result = a1;
  *a1 = *a2;
  return result;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_ @ 0x3BF0 */
_QWORD *__fastcall std::tuple<int *,std::default_delete<int>>::tuple(_QWORD *a1, _QWORD *a2)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(a1, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_ @ 0x3C18 */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(_QWORD *a1, __int64 a2)
{
  _QWORD *v3; // x0
  _QWORD *result; // x0

  v3 = (_QWORD *)std::move<std::tuple<int *,std::default_delete<int>> &>(a2);
  std::tuple<int *,std::default_delete<int>>::tuple(a1, v3);
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a2);
  *result = 0;
  return result;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi @ 0x3C60 */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_ @ 0x3C88 */
__int64 __fastcall std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(
        __int64 a1,
        __int64 a2)
{
  return ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(a1, a2);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x3CB0 */
_QWORD *__fastcall std::unique_ptr<int []>::~unique_ptr(__int64 a1)
{
  __int64 deleter; // x0
  _QWORD *result; // x0
  _QWORD *v4; // [xsp+28h] [xbp+28h]

  v4 = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(a1);
  if ( *v4 )
  {
    deleter = std::unique_ptr<int []>::get_deleter(a1);
    std::default_delete<int []>::operator()<int>(deleter, *v4);
  }
  result = v4;
  *v4 = 0;
  return result;
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm @ 0x3D0C */
__int64 __fastcall std::unique_ptr<int []>::operator[](__int64 a1, __int64 a2)
{
  return std::unique_ptr<int []>::get(a1) + 4 * a2;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi @ 0x3D44 */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(__int64 a1, __int64 a2)
{
  _QWORD *result; // x0

  std::tuple<int *,std::default_delete<int>>::tuple<true,true>(a1);
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a1);
  *result = a2;
  return result;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x3D80 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv @ 0x3D9C */
__int64 __fastcall std::unique_ptr<int>::get_deleter(__int64 a1)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(a1);
}


/* Function: _ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_ @ 0x3DB8 */
void std::move<int *&>()
{
  ;
}


/* Function: _ZNKSt14default_deleteIiEclEPi @ 0x3DCC */
void __fastcall std::default_delete<int>::operator()(__int64 a1, void *a2)
{
  if ( a2 )
    operator delete(a2, 4u);
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv @ 0x3DFC */
__int64 __fastcall std::unique_ptr<int>::get(__int64 a1)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a1);
}


/* Function: _ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_ @ 0x3E18 */
void std::move<std::tuple<int *,std::default_delete<int>> &>()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_ @ 0x3E2C */
void std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl()
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi @ 0x3E44 */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(__int64 a1, __int64 a2)
{
  _QWORD *result; // x0

  std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(a1);
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(a1);
  *result = a2;
  return result;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x3E80 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv @ 0x3E9C */
__int64 __fastcall std::unique_ptr<int []>::get_deleter(__int64 a1)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(a1);
}


/* Function: _ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsrSt14is_convertibleIPA_T_PS0_E5valueEvE4typeEPS5_ @ 0x3EB8 */
void __fastcall std::default_delete<int []>::operator()<int>(__int64 a1, void *a2)
{
  if ( a2 )
    operator delete[](a2);
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv @ 0x3EE8 */
__int64 __fastcall std::unique_ptr<int []>::get(__int64 a1)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(a1);
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv @ 0x3F04 */
__int64 __fastcall std::tuple<int *,std::default_delete<int>>::tuple<true,true>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x3F24 */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv @ 0x3F40 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x3F5C */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv @ 0x3F7C */
__int64 __fastcall std::tuple<int *,std::default_delete<int []>>::tuple<true,true>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x3F9C */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv @ 0x3FB8 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x3FD4 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev @ 0x3FF4 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(__int64 a1)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(a1);
  return std::_Head_base<0ul,int *,false>::_Head_base(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x401C */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4038 */
__int64 __fastcall std::get<1ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<1ul,std::default_delete<int>>(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_ @ 0x4054 */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev @ 0x4070 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(__int64 a1)
{
  std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(a1);
  return std::_Head_base<0ul,int *,false>::_Head_base(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4098 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x40B4 */
__int64 __fastcall std::get<1ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<1ul,std::default_delete<int []>>(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_ @ 0x40D0 */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE @ 0x40EC */
void std::forward<int *&>()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev @ 0x4100 */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(a1);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2Ev @ 0x4120 */
_QWORD *__fastcall std::_Head_base<0ul,int *,false>::_Head_base(_QWORD *result)
{
  *result = 0;
  return result;
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_ @ 0x413C */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x4158 */
__int64 __fastcall std::__get_helper<1ul,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4174 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev @ 0x4190 */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_ @ 0x41B0 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x41CC */
__int64 __fastcall std::__get_helper<1ul,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x41E8 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_ @ 0x4204 */
_QWORD *__fastcall std::_Head_base<0ul,int *,false>::_Head_base<int *&>(_QWORD *a1)
{
  __int64 *v1; // x0
  __int64 v2; // x1
  _QWORD *result; // x0

  std::forward<int *&>();
  v2 = *v1;
  result = a1;
  *a1 = v2;
  return result;
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev @ 0x4234 */
void std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base()
{
  ;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_ @ 0x4248 */
void std::_Head_base<0ul,int *,false>::_M_head()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_ @ 0x425C */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_ @ 0x4278 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev @ 0x4294 */
void std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base()
{
  ;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_ @ 0x42A8 */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_ @ 0x42C4 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_ @ 0x42E0 */
void std::_Head_base<1ul,std::default_delete<int>,true>::_M_head()
{
  ;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_ @ 0x42F4 */
void std::_Head_base<0ul,int *,false>::_M_head()
{
  ;
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_ @ 0x4308 */
void std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head()
{
  ;
}


/* Function: _ZN12RTTIDerivedBD2Ev @ 0x431C */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  *(_QWORD *)this = off_167F8;
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedBD0Ev @ 0x434C */
void __fastcall RTTIDerivedB::~RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIDerivedB::~RTTIDerivedB(this);
  operator delete(this, 8u);
}


/* Function: _ZN12RTTIDerivedAD2Ev @ 0x4374 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  *(_QWORD *)this = off_16820;
  RTTIBase::~RTTIBase(this);
}


/* Function: _ZN12RTTIDerivedAD0Ev @ 0x43A4 */
void __fastcall RTTIDerivedA::~RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIDerivedA::~RTTIDerivedA(this);
  operator delete(this, 8u);
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x43CC */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  *(_QWORD *)this = &off_16878;
  *((_QWORD *)this + 4) = &off_168E0;
  *((_QWORD *)this + 2) = &off_168A8;
  MiddleB::~MiddleB((DiamondDerived *)((char *)this + 16), off_16910);
  MiddleA::~MiddleA(this, off_16900);
  VirtualBase::~VirtualBase((DiamondDerived *)((char *)this + 32));
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x4458 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x4460 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x4470 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
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
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x44B0 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  *(_QWORD *)this = &off_16A38;
  *((_QWORD *)this + 2) = &off_16A68;
  BaseB::~BaseB((MultiDerived *)((char *)this + 16));
  BaseA::~BaseA(this);
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x44FC */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN12MultiDerivedD0Ev @ 0x4504 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
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
void __fastcall Derived::~Derived(Derived *this)
{
  *(_QWORD *)this = &off_16AE0;
  Base::~Base(this);
}


/* Function: _ZN7DerivedD0Ev @ 0x4564 */
void __fastcall Derived::~Derived(Derived *this)
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
