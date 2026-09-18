/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-1/5-1_clang_O0_no_g
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
__int64 _cxx_global_var_init()
{
  std::ios_base::Init::Init((std::ios_base::Init *)&std::__ioinit);
  return __cxa_atexit((void (*)(void *))&std::ios_base::Init::~Init, &std::__ioinit, &_dso_handle);
}


/* Function: _GLOBAL__sub_I_5_1.cpp @ 0x1B80 */
__int64 GLOBAL__sub_I_5_1_cpp()
{
  return _cxx_global_var_init();
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
__int64 test_cpp_member_func(void)
{
  SimpleClass *v0; // x0
  int Value; // [xsp+18h] [xbp-28h]
  _BYTE v3[36]; // [xsp+1Ch] [xbp-24h] BYREF

  SimpleClass::SimpleClass((SimpleClass *)v3, 5, "Test");
  SimpleClass::setValue((SimpleClass *)v3, 10);
  Value = SimpleClass::getValue((SimpleClass *)v3);
  v0 = (SimpleClass *)SimpleClass::compute((SimpleClass *)v3, 3);
  return Value + (_DWORD)v0 + (unsigned int)SimpleClass::getClassID(v0);
}


/* Function: _Z20test_cpp_constructorv @ 0x1D4C */
__int64 test_cpp_constructor(void)
{
  LifecycleClass *Data; // x0
  LifecycleClass *v1; // x0
  int v2; // w0
  int InstanceCount; // [xsp+Ch] [xbp-34h]
  _BYTE v5[20]; // [xsp+28h] [xbp-18h] BYREF
  int v6; // [xsp+3Ch] [xbp-4h]

  v6 = 0;
  LifecycleClass::LifecycleClass((LifecycleClass *)v5, 5u);
  Data = (LifecycleClass *)LifecycleClass::getData((LifecycleClass *)v5, 2u);
  v6 += (int)Data;
  InstanceCount = LifecycleClass::getInstanceCount(Data);
  v6 += InstanceCount;
  LifecycleClass::~LifecycleClass((LifecycleClass *)v5);
  v2 = LifecycleClass::getInstanceCount(v1);
  return (unsigned int)(v6 + 1000 * v2);
}


/* Function: _Z17call_virtual_funcP4Basei @ 0x1DFC */
__int64 __fastcall call_virtual_func(__int64 (__fastcall ***a1)(_QWORD, _QWORD), unsigned int a2)
{
  return (**a1)(a1, a2);
}


/* Function: _Z21test_cpp_virtual_funcv @ 0x1E30 */
__int64 test_cpp_virtual_func(void)
{
  unsigned int v1; // [xsp+4h] [xbp-5Ch]
  int v2; // [xsp+1Ch] [xbp-44h]
  int v3; // [xsp+34h] [xbp-2Ch]
  int v4; // [xsp+38h] [xbp-28h]
  __int64 (__fastcall **v5[2])(_QWORD, _QWORD); // [xsp+48h] [xbp-18h] BYREF
  __int64 (__fastcall **v6)(_QWORD, _QWORD); // [xsp+58h] [xbp-8h] BYREF

  Base::Base((Base *)&v6);
  Derived::Derived((Derived *)v5, 3);
  v4 = Base::virtual_func((Base *)&v6, 5);
  v3 = Derived::virtual_func((Derived *)v5, 5);
  v2 = call_virtual_func(&v6, 5u);
  v1 = v4 + v3 + v2 + call_virtual_func(v5, 5u);
  Derived::~Derived((Derived *)v5);
  Base::~Base((Base *)&v6);
  return v1;
}


/* Function: _Z29test_cpp_multiple_inheritancev @ 0x1F50 */
__int64 test_cpp_multiple_inheritance(void)
{
  unsigned int v1; // [xsp+4h] [xbp-6Ch]
  _QWORD *v2; // [xsp+18h] [xbp-58h]
  int v3; // [xsp+3Ch] [xbp-34h]
  __int64 (__fastcall **v4)(_QWORD); // [xsp+50h] [xbp-20h] BYREF
  int v5; // [xsp+58h] [xbp-18h]
  _DWORD v6[4]; // [xsp+60h] [xbp-10h] BYREF

  MultiDerived::MultiDerived((MultiDerived *)&v4);
  v5 = 100;
  v6[2] = 200;
  v2 = 0;
  if ( &v4 )
    v2 = v6;
  v3 = (*v4)(&v4);
  v1 = v3 + (*(__int64 (__fastcall **)(_QWORD *))*v2)(v2) + (&v4 != v2);
  MultiDerived::~MultiDerived((MultiDerived *)&v4);
  return v1;
}


/* Function: _Z28test_cpp_diamond_inheritancev @ 0x2050 */
__int64 test_cpp_diamond_inheritance(void)
{
  unsigned int v1; // [xsp+4h] [xbp-6Ch]
  __int64 (__fastcall ***v2)(_QWORD); // [xsp+18h] [xbp-58h]
  int v3; // [xsp+34h] [xbp-3Ch]
  _QWORD v4[6]; // [xsp+40h] [xbp-30h] BYREF

  DiamondDerived::DiamondDerived((DiamondDerived *)v4);
  *(_DWORD *)((char *)&v4[1] + *(_QWORD *)(v4[0] - 24LL)) = 50;
  v2 = 0;
  if ( v4 )
    v2 = (__int64 (__fastcall ***)(_QWORD))((char *)v4 + *(_QWORD *)(v4[0] - 24LL));
  v3 = (**v2)(v2);
  *(_DWORD *)((char *)&v4[1] + *(_QWORD *)(v4[0] - 24LL)) = 100;
  v1 = v3 + (**v2)(v2);
  DiamondDerived::~DiamondDerived((DiamondDerived *)v4);
  return v1;
}


/* Function: _Z26test_cpp_operator_overloadv @ 0x2154 */
__int64 test_cpp_operator_overload(void)
{
  int v0; // w9
  char v2; // [xsp+27h] [xbp-19h]
  __int64 v3; // [xsp+28h] [xbp-18h] BYREF
  _BYTE v4[8]; // [xsp+30h] [xbp-10h] BYREF
  _BYTE v5[8]; // [xsp+38h] [xbp-8h] BYREF

  Point::Point((Point *)v5, 1, 2);
  Point::Point((Point *)v4, 3, 4);
  v3 = Point::operator+(v5, v4);
  v2 = Point::operator==(v5, v4) & 1;
  Point::operator++(&v3);
  if ( (v2 & 1) != 0 )
    v0 = 0;
  else
    v0 = 10;
  return (unsigned int)(v3 + HIDWORD(v3) + v0);
}


/* Function: _Z22test_cpp_template_funcv @ 0x21FC */
__int64 test_cpp_template_func(void)
{
  int v0; // w0
  int v2; // [xsp+8h] [xbp-18h] BYREF
  int v3; // [xsp+Ch] [xbp-14h] BYREF
  double v4; // [xsp+10h] [xbp-10h]
  int v5; // [xsp+1Ch] [xbp-4h]

  template_max<int>(3, 7);
  v5 = v0;
  v4 = template_max<double>(2.5, 1.5);
  v3 = 10;
  v2 = 20;
  template_swap<int>(&v3, &v2);
  return (unsigned int)(v5 + (int)v4 + v3 + v2);
}


/* Function: _Z23test_cpp_template_classv @ 0x2270 */
__int64 test_cpp_template_class(void)
{
  double v1; // [xsp+18h] [xbp-98h]
  _BYTE v2[92]; // [xsp+20h] [xbp-90h] BYREF
  int Size; // [xsp+7Ch] [xbp-34h]
  int v4; // [xsp+80h] [xbp-30h]
  _BYTE v5[44]; // [xsp+84h] [xbp-2Ch] BYREF

  Container<int>::Container();
  Container<int>::push(v5, 10);
  Container<int>::push(v5, 20);
  Container<int>::push(v5, 30);
  v4 = Container<int>::get(v5);
  Size = Container<int>::getSize(v5);
  Container<double>::Container();
  Container<double>::push(v2, 3.14);
  v1 = Container<double>::get(v2, 0);
  return (unsigned int)(v4 + Size + (int)v1);
}


/* Function: _Z15test_cpp_lambdav @ 0x2330 */
__int64 test_cpp_lambda(void)
{
  int v1; // [xsp+10h] [xbp-20h]
  char v2; // [xsp+17h] [xbp-19h] BYREF
  int v3; // [xsp+18h] [xbp-18h] BYREF
  _DWORD *v4; // [xsp+20h] [xbp-10h]
  _DWORD v5[2]; // [xsp+28h] [xbp-8h] BYREF

  v5[1] = 10;
  v5[0] = 20;
  v3 = 10;
  v4 = v5;
  v1 = test_cpp_lambda(void)::$_1::operator()(&v3, 3);
  return v1 + (unsigned int)test_cpp_lambda(void)::$_0::operator()<int,int>(&v2, 10, 20);
}


/* Function: _ZZ15test_cpp_lambdavENK3$_1clEi @ 0x23A0 */
__int64 __fastcall test_cpp_lambda(void)::$_1::operator()(__int64 a1, int a2)
{
  **(_DWORD **)(a1 + 8) += 5;
  return (unsigned int)(a2 * *(_DWORD *)a1 + **(_DWORD **)(a1 + 8));
}


/* Function: _ZZ15test_cpp_lambdavENK3$_0clIiiEEDaT_T0_ @ 0x23E0 */
__int64 __fastcall test_cpp_lambda(void)::$_0::operator()<int,int>(__int64 a1, int a2, int a3)
{
  return (unsigned int)(a2 + a3);
}


/* Function: _Z18test_cpp_exceptionv @ 0x2404 */
void __noreturn test_cpp_exception(void)
{
  _DWORD *exception; // x0

  exception = __cxa_allocate_exception(4u);
  *exception = 42;
  __cxa_throw(exception, (struct type_info *)&`typeinfo for'int, 0);
}


/* Function: _Z18test_cpp_smart_ptrv @ 0x2574 */
__int64 test_cpp_smart_ptr(void)
{
  unsigned int v1; // [xsp+4h] [xbp-9Ch]
  _DWORD *v2; // [xsp+10h] [xbp-90h]
  _DWORD *v3; // [xsp+30h] [xbp-70h]
  _BYTE v4[11]; // [xsp+60h] [xbp-40h] BYREF
  int v5; // [xsp+6Ch] [xbp-34h]
  _BYTE v6[12]; // [xsp+70h] [xbp-30h] BYREF
  int v7; // [xsp+7Ch] [xbp-24h]
  _BYTE v8[12]; // [xsp+80h] [xbp-20h] BYREF
  _BYTE v9[8]; // [xsp+98h] [xbp-8h] BYREF

  *(_DWORD *)operator new(4u) = 100;
  std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>();
  *(_DWORD *)std::unique_ptr<int>::operator*(v9) = 200;
  std::move<std::unique_ptr<int> &>(v9);
  std::unique_ptr<int>::unique_ptr();
  v7 = *(_DWORD *)std::unique_ptr<int>::operator*(v8);
  v3 = (_DWORD *)operator new[](0x14u);
  *v3 = 1;
  v3[1] = 2;
  v3[2] = 3;
  v3[3] = 4;
  v3[4] = 5;
  std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>();
  v5 = *(_DWORD *)std::unique_ptr<int []>::operator[](v6, 2);
  *(_DWORD *)operator new(4u) = 500;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::unique_ptr<test_cpp_smart_ptr(void)::$_2,void>();
  v2 = (_DWORD *)std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::operator*(v4);
  v1 = v7 + v5 + *v2;
  std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::~unique_ptr(v4);
  std::unique_ptr<int []>::~unique_ptr(v6);
  std::unique_ptr<int>::~unique_ptr(v8);
  std::unique_ptr<int>::~unique_ptr(v9);
  return v1;
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EC2IS0_vEEPiRKS0_ @ 0x275C */
__int64 std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::unique_ptr<test_cpp_smart_ptr(void)::$_2,void>()
{
  return ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3__2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_();
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2EdeEv @ 0x2798 */
__int64 __fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::operator*(__int64 a1)
{
  return std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get(a1);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2ED2Ev @ 0x27CC */
_QWORD *__fastcall std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::~unique_ptr(__int64 a1)
{
  _QWORD *result; // x0
  _QWORD *v2; // x0
  __int64 deleter; // [xsp+8h] [xbp-28h]
  _QWORD *v5; // [xsp+20h] [xbp-10h]

  result = (_QWORD *)std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr();
  v5 = result;
  if ( *result )
  {
    deleter = std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get_deleter(a1);
    v2 = (_QWORD *)std::move<int *&>(v5);
    result = (_QWORD *)test_cpp_smart_ptr(void)::$_2::operator()(deleter, *v2);
  }
  *v5 = 0;
  return result;
}


/* Function: _Z13test_cpp_rttiv @ 0x284C */
__int64 test_cpp_rtti(void)
{
  const char *v0; // x0
  RTTIDerivedB *v2; // [xsp+20h] [xbp-70h]
  RTTIDerivedA *v3; // [xsp+30h] [xbp-60h]
  RTTIDerivedA *v4; // [xsp+48h] [xbp-48h]
  RTTIDerivedB *v5; // [xsp+58h] [xbp-38h]
  int v6; // [xsp+7Ch] [xbp-14h]
  unsigned int v7; // [xsp+7Ch] [xbp-14h]

  v4 = (RTTIDerivedA *)operator new(8u);
  *(_QWORD *)v4 = 0;
  RTTIDerivedA::RTTIDerivedA(v4);
  v5 = (RTTIDerivedB *)operator new(8u);
  *(_QWORD *)v5 = 0;
  RTTIDerivedB::RTTIDerivedB(v5);
  v6 = 0;
  if ( !v4 )
    __cxa_bad_typeid();
  if ( (std::type_info::operator==(*(_QWORD *)(*(_QWORD *)v4 - 8LL), &`typeinfo for'RTTIDerivedA) & 1) != 0 )
    v6 = 10;
  if ( !v5 )
    __cxa_bad_typeid();
  if ( (std::type_info::operator==(*(_QWORD *)(*(_QWORD *)v5 - 8LL), &`typeinfo for'RTTIDerivedB) & 1) != 0 )
    v6 += 20;
  v3 = (RTTIDerivedA *)__dynamic_cast(
                         v4,
                         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedA,
                         0);
  if ( v3 )
    v6 += RTTIDerivedA::derivedA_data(v3);
  v2 = (RTTIDerivedB *)__dynamic_cast(
                         v5,
                         (const struct __class_type_info *)&`typeinfo for'RTTIBase,
                         (const struct __class_type_info *)&`typeinfo for'RTTIDerivedB,
                         0);
  if ( v2 )
    v6 += RTTIDerivedB::derivedB_data(v2);
  v0 = (const char *)std::type_info::name(*(std::type_info **)(*(_QWORD *)v4 - 8LL));
  v7 = v6 + strlen(v0);
  (*(void (__fastcall **)(RTTIDerivedA *))(*(_QWORD *)v4 + 8LL))(v4);
  (*(void (__fastcall **)(RTTIDerivedB *))(*(_QWORD *)v5 + 8LL))(v5);
  return v7;
}


/* Function: _Z20test_cpp_oo_featuresv @ 0x2A84 */
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


/* Function: main @ 0x2B90 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_cpp_oo_features();
}


/* Function: _ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3$_2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_ @ 0x2BBC */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiZ18test_cpp_smart_ptrvE3__2Lb1ELb0EECI2St15__uniq_ptr_implIiS0_EIRKS0_EEPiOT_(
        __int64 a1,
        __int64 a2,
        __int64 a3)
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::$_2 const&>(
           a1,
           a2,
           a3);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2EC2IRKS0_EEPiOT_ @ 0x2BF0 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::__uniq_ptr_impl<test_cpp_smart_ptr(void)::$_2 const&>(
        __int64 a1,
        __int64 a2,
        __int64 a3)
{
  __int64 v3; // x0
  _QWORD v6[2]; // [xsp+20h] [xbp-10h] BYREF

  v6[1] = a1;
  v6[0] = a2;
  v3 = std::forward<test_cpp_smart_ptr(void)::$_2 const&>(a3);
  return std::tuple<int *,test_cpp_smart_ptr(void)::$_2>::tuple<int *&,test_cpp_smart_ptr(void)::$_2 const&,true>(
           a1,
           v6,
           v3);
}


/* Function: _ZSt7forwardIRKZ18test_cpp_smart_ptrvE3$_2EOT_RNSt16remove_referenceIS3_E4typeE @ 0x2C3C */
void std::forward<test_cpp_smart_ptr(void)::$_2 const&>()
{
  ;
}


/* Function: _ZNSt5tupleIJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_RKS1_Lb1EEEOT_OT0_ @ 0x2C50 */
__int64 __fastcall std::tuple<int *,test_cpp_smart_ptr(void)::$_2>::tuple<int *&,test_cpp_smart_ptr(void)::$_2 const&,true>(
        __int64 a1,
        __int64 a2)
{
  __int64 v2; // x0
  __int64 v4; // [xsp+8h] [xbp-28h]

  v4 = std::forward<int *&>(a2);
  std::forward<test_cpp_smart_ptr(void)::$_2 const&>();
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::$_2 const&,void>(
           a1,
           v4,
           v2);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EEC2IRS0_JRKS1_EvEEOT_DpOT0_ @ 0x2CA8 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl<int *&,test_cpp_smart_ptr(void)::$_2 const&,void>(
        __int64 a1,
        __int64 a2)
{
  __int64 v2; // x0
  __int64 v3; // x0

  std::forward<test_cpp_smart_ptr(void)::$_2 const&>();
  std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl(a1, v2);
  v3 = std::forward<int *&>(a2);
  return std::_Head_base<0ul,int *,false>::_Head_base<int *&>(a1, v3);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EEC2ERKS0_ @ 0x2CFC */
__int64 __fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_Tuple_impl(__int64 a1, __int64 a2)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_Head_base(a1, a2);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EEC2ERKS0_ @ 0x2D28 */
void std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_Head_base()
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv @ 0x2D3C */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZNSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E11get_deleterEv @ 0x2D60 */
__int64 std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get_deleter()
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_deleter();
}


/* Function: _ZZ18test_cpp_smart_ptrvENK3$_2clEPi @ 0x2D94 */
void __fastcall test_cpp_smart_ptr(void)::$_2::operator()(__int64 a1, _DWORD *a2)
{
  *a2 = -1;
  if ( a2 )
    operator delete(a2);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2DDC */
__int64 __fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2E00 */
__int64 __fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS2_ @ 0x2E24 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E10_M_deleterEv @ 0x2E48 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZSt3getILm1EJPiZ18test_cpp_smart_ptrvE3$_2EERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS6_ @ 0x2E6C */
__int64 __fastcall std::get<1ul,int *,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::__get_helper<1ul,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZSt12__get_helperILm1EZ18test_cpp_smart_ptrvE3$_2JEERT0_RSt11_Tuple_implIXT_EJS1_DpT1_EE @ 0x2E90 */
__int64 __fastcall std::__get_helper<1ul,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJZ18test_cpp_smart_ptrvE3$_2EE7_M_headERS1_ @ 0x2EB4 */
__int64 __fastcall std::_Tuple_impl<1ul,test_cpp_smart_ptr(void)::$_2>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1EZ18test_cpp_smart_ptrvE3$_2Lb1EE7_M_headERS1_ @ 0x2ED8 */
void std::_Head_base<1ul,test_cpp_smart_ptr(void)::$_2,true>::_M_head()
{
  ;
}


/* Function: _ZNKSt10unique_ptrIiZ18test_cpp_smart_ptrvE3$_2E3getEv @ 0x2EEC */
__int64 std::unique_ptr<int,test_cpp_smart_ptr(void)::$_2>::get()
{
  return std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr();
}


/* Function: _ZNKSt15__uniq_ptr_implIiZ18test_cpp_smart_ptrvE3$_2E6_M_ptrEv @ 0x2F20 */
__int64 __fastcall std::__uniq_ptr_impl<int,test_cpp_smart_ptr(void)::$_2>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZSt3getILm0EJPiZ18test_cpp_smart_ptrvE3$_2EERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS6_ @ 0x2F48 */
__int64 __fastcall std::get<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJZ18test_cpp_smart_ptrvE3$_2EERKT0_RKSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x2F6C */
__int64 __fastcall std::__get_helper<0ul,int *,test_cpp_smart_ptr(void)::$_2>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiZ18test_cpp_smart_ptrvE3$_2EE7_M_headERKS2_ @ 0x2F90 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,test_cpp_smart_ptr(void)::$_2>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZN11SimpleClassC2EiPKc @ 0x2FB4 */
void __fastcall SimpleClass::SimpleClass(SimpleClass *this, int a2, const char *a3)
{
  *(_DWORD *)this = a2;
  strncpy((char *)this + 4, a3, 0x1Fu);
  *((_BYTE *)this + 35) = 0;
}


/* Function: _ZN11SimpleClass8setValueEi @ 0x3000 */
_DWORD *__fastcall SimpleClass::setValue(_DWORD *this, int a2)
{
  *this = a2;
  return this;
}


/* Function: _ZNK11SimpleClass8getValueEv @ 0x3020 */
__int64 __fastcall SimpleClass::getValue(SimpleClass *this)
{
  return *(unsigned int *)this;
}


/* Function: _ZNK11SimpleClass7computeEi @ 0x3038 */
__int64 __fastcall SimpleClass::compute(SimpleClass *this, int a2)
{
  int v3; // [xsp+0h] [xbp-10h]

  v3 = *(_DWORD *)this * a2;
  return (unsigned int)strlen((const char *)this + 4) + v3;
}


/* Function: _ZN11SimpleClass10getClassIDEv @ 0x3080 */
__int64 __fastcall SimpleClass::getClassID(SimpleClass *this)
{
  return 4660;
}


/* Function: _ZN14LifecycleClassC2Em @ 0x3088 */
void __fastcall LifecycleClass::LifecycleClass(LifecycleClass *this, unsigned __int64 a2)
{
  unsigned __int64 v2; // x0
  unsigned __int64 i; // [xsp+8h] [xbp-18h]

  *((_QWORD *)this + 1) = a2;
  if ( is_mul_ok(a2, 4u) )
    v2 = 4 * a2;
  else
    v2 = -1;
  *(_QWORD *)this = operator new[](v2);
  for ( i = 0; i < a2; ++i )
    *(_DWORD *)(*(_QWORD *)this + 4 * i) = 10 * i;
  ++LifecycleClass::instance_count;
}


/* Function: _ZNK14LifecycleClass7getDataEm @ 0x3138 */
__int64 __fastcall LifecycleClass::getData(LifecycleClass *this, unsigned __int64 a2)
{
  if ( a2 >= *((_QWORD *)this + 1) )
    return (unsigned int)-1;
  else
    return *(unsigned int *)(*(_QWORD *)this + 4 * a2);
}


/* Function: _ZN14LifecycleClass16getInstanceCountEv @ 0x3190 */
__int64 __fastcall LifecycleClass::getInstanceCount(LifecycleClass *this)
{
  return (unsigned int)LifecycleClass::instance_count;
}


/* Function: _ZN14LifecycleClassD2Ev @ 0x319C */
void __fastcall LifecycleClass::~LifecycleClass(void **this)
{
  if ( *this )
    operator delete[](*this);
  --LifecycleClass::instance_count;
}


/* Function: _ZN4BaseC2Ev @ 0x31E8 */
void __fastcall Base::Base(Base *this)
{
  *(_QWORD *)this = &off_17858;
}


/* Function: _ZN7DerivedC2Ei @ 0x320C */
void __fastcall Derived::Derived(Derived *this, int a2)
{
  Base::Base(this);
  *(_QWORD *)this = &off_17898;
  *((_DWORD *)this + 2) = a2;
}


/* Function: _ZN4Base12virtual_funcEi @ 0x325C */
__int64 __fastcall Base::virtual_func(Base *this, int a2)
{
  return (unsigned int)(a2 + 1);
}


/* Function: _ZN7Derived12virtual_funcEi @ 0x3278 */
__int64 __fastcall Derived::virtual_func(Derived *this, int a2)
{
  return (unsigned int)(a2 * *((_DWORD *)this + 2));
}


/* Function: _ZN7DerivedD2Ev @ 0x329C */
void __fastcall Derived::~Derived(Derived *this)
{
  Base::~Base(this);
}


/* Function: _ZN4BaseD2Ev @ 0x32C0 */
void __fastcall Base::~Base(Base *this)
{
  ;
}


/* Function: _ZN12MultiDerivedC2Ev @ 0x32D0 */
void __fastcall MultiDerived::MultiDerived(MultiDerived *this)
{
  BaseA::BaseA(this);
  BaseB::BaseB((MultiDerived *)((char *)this + 16));
  *(_QWORD *)this = &off_178E0;
  *((_QWORD *)this + 2) = &off_17910;
}


/* Function: _ZN12MultiDerivedD2Ev @ 0x3330 */
void __fastcall MultiDerived::~MultiDerived(MultiDerived *this)
{
  BaseB::~BaseB((MultiDerived *)((char *)this + 16));
  BaseA::~BaseA(this);
}


/* Function: _ZN14DiamondDerivedC1Ev @ 0x3364 */
void __fastcall DiamondDerived::DiamondDerived(DiamondDerived *this)
{
  VirtualBase::VirtualBase((DiamondDerived *)((char *)this + 32));
  MiddleA::MiddleA(this);
  MiddleB::MiddleB((DiamondDerived *)((char *)this + 16));
  *(_QWORD *)this = &off_179E8;
  *((_QWORD *)this + 4) = &off_17A50;
  *((_QWORD *)this + 2) = &off_17A18;
}


/* Function: _ZN14DiamondDerivedD1Ev @ 0x3400 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this);
  VirtualBase::~VirtualBase((DiamondDerived *)((char *)this + 32));
}


/* Function: _ZN5PointC2Eii @ 0x343C */
void __fastcall Point::Point(Point *this, int a2, int a3)
{
  *(_DWORD *)this = a2;
  *((_DWORD *)this + 1) = a3;
}


/* Function: _ZNK5PointplERKS_ @ 0x3468 */
__int64 __fastcall Point::operator+(_DWORD *a1, _DWORD *a2)
{
  __int64 v3; // [xsp+18h] [xbp-8h] BYREF

  Point::Point((Point *)&v3, *a1 + *a2, a1[1] + a2[1]);
  return v3;
}


/* Function: _ZNK5PointeqERKS_ @ 0x34B8 */
bool __fastcall Point::operator==(_DWORD *a1, _DWORD *a2)
{
  bool v3; // [xsp+Ch] [xbp-14h]

  v3 = 0;
  if ( *a1 == *a2 )
    return a1[1] == a2[1];
  return v3;
}


/* Function: _ZN5PointppEv @ 0x351C */
_DWORD *__fastcall Point::operator++(_DWORD *result)
{
  ++*result;
  ++result[1];
  return result;
}


/* Function: _Z12template_maxIiET_S0_S0_ @ 0x3548 */
__int64 __fastcall template_max<int>(unsigned int a1, unsigned int a2)
{
  if ( (int)a1 <= (int)a2 )
    return a2;
  else
    return a1;
}


/* Function: _Z12template_maxIdET_S0_S0_ @ 0x358C */
double __fastcall template_max<double>(double a1, double a2)
{
  if ( a1 <= a2 )
    return a2;
  else
    return a1;
}


/* Function: _Z13template_swapIiEvRT_S1_ @ 0x35D4 */
int *__fastcall template_swap<int>(int *result, int *a2)
{
  int v2; // [xsp+Ch] [xbp-14h]

  v2 = *result;
  *result = *a2;
  *a2 = v2;
  return result;
}


/* Function: _ZN9ContainerIiEC2Ev @ 0x3610 */
__int64 __fastcall Container<int>::Container(__int64 result)
{
  *(_DWORD *)(result + 40) = 0;
  return result;
}


/* Function: _ZN9ContainerIiE4pushEi @ 0x3628 */
__int64 __fastcall Container<int>::push(__int64 result, int a2)
{
  __int64 v2; // x10

  if ( *(int *)(result + 40) < 10 )
  {
    v2 = (int)(*(_DWORD *)(result + 40))++;
    *(_DWORD *)(result + 4 * v2) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIiE3getEi @ 0x3674 */
__int64 __fastcall Container<int>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || a2 >= *(_DWORD *)(a1 + 40) )
    return 0;
  else
    return *(unsigned int *)(a1 + 4LL * a2);
}


/* Function: _ZNK9ContainerIiE7getSizeEv @ 0x36D4 */
__int64 __fastcall Container<int>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 40);
}


/* Function: _ZN9ContainerIdEC2Ev @ 0x36EC */
__int64 __fastcall Container<double>::Container(__int64 result)
{
  *(_DWORD *)(result + 80) = 0;
  return result;
}


/* Function: _ZN9ContainerIdE4pushEd @ 0x3704 */
__int64 __fastcall Container<double>::push(__int64 result, double a2)
{
  __int64 v2; // x10

  if ( *(int *)(result + 80) < 10 )
  {
    v2 = (int)(*(_DWORD *)(result + 80))++;
    *(double *)(result + 8 * v2) = a2;
  }
  return result;
}


/* Function: _ZNK9ContainerIdE3getEi @ 0x3750 */
double __fastcall Container<double>::get(__int64 a1, int a2)
{
  if ( a2 < 0 || a2 >= *(_DWORD *)(a1 + 80) )
    return 0.0;
  else
    return *(double *)(a1 + 8LL * a2);
}


/* Function: _ZNK9ContainerIdE7getSizeEv @ 0x37B4 */
__int64 __fastcall Container<double>::getSize(__int64 a1)
{
  return *(unsigned int *)(a1 + 80);
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2IS1_vEEPi @ 0x37CC */
__int64 __fastcall std::unique_ptr<int>::unique_ptr<std::default_delete<int>,void>(__int64 a1, __int64 a2)
{
  return ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(a1, a2);
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEEdeEv @ 0x3800 */
__int64 __fastcall std::unique_ptr<int>::operator*(__int64 a1)
{
  return std::unique_ptr<int>::get(a1);
}


/* Function: _ZSt4moveIRSt10unique_ptrIiSt14default_deleteIiEEEONSt16remove_referenceIT_E4typeEOS6_ @ 0x3834 */
void std::move<std::unique_ptr<int> &>()
{
  ;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEEC2EOS2_ @ 0x3848 */
__int64 __fastcall std::unique_ptr<int>::unique_ptr(__int64 a1, __int64 a2)
{
  return std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(a1, a2);
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EEC2IPiS2_vbEET_ @ 0x3874 */
__int64 __fastcall std::unique_ptr<int []>::unique_ptr<int *,std::default_delete<int []>,void,bool>(
        __int64 a1,
        __int64 a2)
{
  return ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(a1, a2);
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EEixEm @ 0x38A8 */
__int64 __fastcall std::unique_ptr<int []>::operator[](__int64 a1, __int64 a2)
{
  return std::unique_ptr<int []>::get(a1) + 4 * a2;
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EED2Ev @ 0x38E8 */
_QWORD *__fastcall std::unique_ptr<int []>::~unique_ptr(__int64 a1)
{
  _QWORD *result; // x0
  __int64 deleter; // x0
  _QWORD *v4; // [xsp+10h] [xbp-10h]

  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr();
  v4 = result;
  if ( *result )
  {
    deleter = std::unique_ptr<int []>::get_deleter(a1);
    result = (_QWORD *)std::default_delete<int []>::operator()<int>(deleter, *v4);
  }
  *v4 = 0;
  return result;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEED2Ev @ 0x394C */
_QWORD *__fastcall std::unique_ptr<int>::~unique_ptr(__int64 a1)
{
  _QWORD *result; // x0
  _QWORD *v2; // x8
  __int64 deleter; // [xsp+0h] [xbp-20h]
  _QWORD *v5; // [xsp+10h] [xbp-10h]

  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr();
  v5 = result;
  if ( *result )
  {
    deleter = std::unique_ptr<int>::get_deleter(a1);
    v2 = (_QWORD *)std::move<int *&>(v5);
    result = (_QWORD *)std::default_delete<int>::operator()(deleter, *v2);
  }
  *v5 = 0;
  return result;
}


/* Function: _ZN12RTTIDerivedAC2Ev @ 0x39C0 */
void __fastcall RTTIDerivedA::RTTIDerivedA(RTTIDerivedA *this)
{
  RTTIBase::RTTIBase(this);
  *(_QWORD *)this = off_17D30;
}


/* Function: _ZN12RTTIDerivedBC2Ev @ 0x3A04 */
void __fastcall RTTIDerivedB::RTTIDerivedB(RTTIDerivedB *this)
{
  RTTIBase::RTTIBase(this);
  *(_QWORD *)this = off_17D80;
}


/* Function: _ZNKSt9type_infoeqERKS_ @ 0x3A48 */
__int64 __fastcall std::type_info::operator==(__int64 a1, __int64 a2)
{
  bool v3; // [xsp+Ch] [xbp-24h]
  char v4; // [xsp+1Ch] [xbp-14h]

  v4 = 1;
  if ( *(_QWORD *)(a1 + 8) != *(_QWORD *)(a2 + 8) )
  {
    v3 = 0;
    if ( **(_BYTE **)(a1 + 8) != 42 )
      v3 = strcmp(*(const char **)(a1 + 8), *(const char **)(a2 + 8)) == 0;
    v4 = v3;
  }
  return v4 & 1;
}


/* Function: _ZNK12RTTIDerivedA13derivedA_dataEv @ 0x3AE8 */
__int64 __fastcall RTTIDerivedA::derivedA_data(RTTIDerivedA *this)
{
  return 100;
}


/* Function: _ZNK12RTTIDerivedB13derivedB_dataEv @ 0x3AFC */
__int64 __fastcall RTTIDerivedB::derivedB_data(RTTIDerivedB *this)
{
  return 200;
}


/* Function: _ZNKSt9type_info4nameEv @ 0x3B10 */
__int64 __fastcall std::type_info::name(std::type_info *this)
{
  if ( **((_BYTE **)this + 1) == 42 )
    return *((_QWORD *)this + 1) + 1LL;
  else
    return *((_QWORD *)this + 1);
}


/* Function: _ZNK4Base7getNameEv @ 0x3B64 */
const char *__fastcall Base::getName(Base *this)
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
const char *__fastcall Derived::getName(Derived *this)
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
void __fastcall BaseA::BaseA(BaseA *this)
{
  *(_QWORD *)this = &off_17990;
}


/* Function: _ZN5BaseBC2Ev @ 0x3C18 */
void __fastcall BaseB::BaseB(BaseB *this)
{
  *(_QWORD *)this = &off_179B8;
}


/* Function: _ZN12MultiDerived5funcAEv @ 0x3C3C */
__int64 __fastcall MultiDerived::funcA(MultiDerived *this)
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
__int64 __fastcall MultiDerived::funcB(MultiDerived *this)
{
  return 40;
}


/* Function: _ZThn16_N12MultiDerived5funcBEv @ 0x3C94 */
__int64 __fastcall `non-virtual thunk to'MultiDerived::funcB(MultiDerived *this)
{
  return MultiDerived::funcB((MultiDerived *)((char *)this - 16));
}


/* Function: _ZThn16_N12MultiDerivedD1Ev @ 0x3CAC */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZThn16_N12MultiDerivedD0Ev @ 0x3CC4 */
void __fastcall `non-virtual thunk to'MultiDerived::~MultiDerived(MultiDerived *this)
{
  MultiDerived::~MultiDerived((MultiDerived *)((char *)this - 16));
}


/* Function: _ZN5BaseA5funcAEv @ 0x3CDC */
__int64 __fastcall BaseA::funcA(BaseA *this)
{
  return 10;
}


/* Function: _ZN5BaseAD2Ev @ 0x3CF0 */
void __fastcall BaseA::~BaseA(BaseA *this)
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
__int64 __fastcall BaseB::funcB(BaseB *this)
{
  return 20;
}


/* Function: _ZN5BaseBD2Ev @ 0x3D44 */
void __fastcall BaseB::~BaseB(BaseB *this)
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
void __fastcall VirtualBase::VirtualBase(VirtualBase *this)
{
  *(_QWORD *)this = &off_17C18;
}


/* Function: _ZN7MiddleAC2Ev @ 0x3DA8 */
void __fastcall MiddleA::MiddleA(MiddleA *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN7MiddleBC2Ev @ 0x3DDC */
void __fastcall MiddleB::MiddleB(MiddleB *this, _QWORD *a2)
{
  *(_QWORD *)this = *a2;
  *(_QWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)) = a2[1];
}


/* Function: _ZN7MiddleA4funcEv @ 0x3E10 */
__int64 __fastcall MiddleA::func(MiddleA *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 150);
}


/* Function: _ZN7MiddleAD1Ev @ 0x3E38 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA(this);
  VirtualBase::~VirtualBase((MiddleA *)((char *)this + 16));
}


/* Function: _ZN7MiddleAD0Ev @ 0x3E74 */
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA(this);
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleA4funcEv @ 0x3EA4 */
__int64 __fastcall `virtual thunk to'MiddleA::func(MiddleA *this)
{
  return MiddleA::func((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZTv0_n32_N7MiddleAD1Ev @ 0x3EC4 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZTv0_n32_N7MiddleAD0Ev @ 0x3EE4 */
void __fastcall `virtual thunk to'MiddleA::~MiddleA(MiddleA *this)
{
  MiddleA::~MiddleA((MiddleA *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN7MiddleB4funcEv @ 0x3F04 */
__int64 __fastcall MiddleB::func(MiddleB *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 200);
}


/* Function: _ZN7MiddleBD1Ev @ 0x3F2C */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB(this);
  VirtualBase::~VirtualBase((MiddleB *)((char *)this + 16));
}


/* Function: _ZN7MiddleBD0Ev @ 0x3F68 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB(this);
  operator delete(this);
}


/* Function: _ZTv0_n24_N7MiddleB4funcEv @ 0x3F98 */
__int64 __fastcall `virtual thunk to'MiddleB::func(MiddleB *this)
{
  return MiddleB::func((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZTv0_n32_N7MiddleBD1Ev @ 0x3FB8 */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZTv0_n32_N7MiddleBD0Ev @ 0x3FD8 */
void __fastcall `virtual thunk to'MiddleB::~MiddleB(MiddleB *this)
{
  MiddleB::~MiddleB((MiddleB *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN14DiamondDerived4funcEv @ 0x3FF8 */
__int64 __fastcall DiamondDerived::func(DiamondDerived *this)
{
  return (unsigned int)(*(_DWORD *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL) + 8) + 250);
}


/* Function: _ZN14DiamondDerivedD0Ev @ 0x4020 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived(this);
  operator delete(this);
}


/* Function: _ZThn16_N14DiamondDerived4funcEv @ 0x4050 */
__int64 __fastcall `non-virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZThn16_N14DiamondDerivedD1Ev @ 0x4068 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZThn16_N14DiamondDerivedD0Ev @ 0x4080 */
void __fastcall `non-virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this - 16));
}


/* Function: _ZTv0_n24_N14DiamondDerived4funcEv @ 0x4098 */
__int64 __fastcall `virtual thunk to'DiamondDerived::func(DiamondDerived *this)
{
  return DiamondDerived::func((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 24LL)));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD1Ev @ 0x40B8 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZTv0_n32_N14DiamondDerivedD0Ev @ 0x40D8 */
void __fastcall `virtual thunk to'DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  DiamondDerived::~DiamondDerived((DiamondDerived *)((char *)this + *(_QWORD *)(*(_QWORD *)this - 32LL)));
}


/* Function: _ZN11VirtualBase4funcEv @ 0x40F8 */
__int64 __fastcall VirtualBase::func(VirtualBase *this)
{
  return 100;
}


/* Function: _ZN11VirtualBaseD2Ev @ 0x410C */
void __fastcall VirtualBase::~VirtualBase(VirtualBase *this)
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
void __fastcall MiddleA::~MiddleA(MiddleA *this)
{
  ;
}


/* Function: _ZN7MiddleBD2Ev @ 0x4160 */
void __fastcall MiddleB::~MiddleB(MiddleB *this)
{
  ;
}


/* Function: _ZN14DiamondDerivedD2Ev @ 0x4174 */
void __fastcall DiamondDerived::~DiamondDerived(DiamondDerived *this)
{
  MiddleB::~MiddleB((DiamondDerived *)((char *)this + 16));
  MiddleA::~MiddleA(this);
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EEC2EOS2_ @ 0x41C0 */
__int64 __fastcall std::__uniq_ptr_data<int,std::default_delete<int>,true,true>::__uniq_ptr_data(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EOS2_ @ 0x41EC */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(__int64 a1, __int64 a2)
{
  __int64 v2; // x0
  _QWORD *result; // x0

  v2 = std::move<std::tuple<int *,std::default_delete<int>> &>(a2);
  std::tuple<int *,std::default_delete<int>>::tuple(a1, v2);
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a2);
  *result = 0;
  return result;
}


/* Function: _ZSt4moveIRSt5tupleIJPiSt14default_deleteIiEEEEONSt16remove_referenceIT_E4typeEOS7_ @ 0x4244 */
void std::move<std::tuple<int *,std::default_delete<int>> &>()
{
  ;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2EOS3_ @ 0x4258 */
__int64 __fastcall std::tuple<int *,std::default_delete<int>>::tuple(__int64 a1, __int64 a2)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(a1, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x4284 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: __clang_call_terminate @ 0x42A8 */
void __fastcall __noreturn _clang_call_terminate(void *a1)
{
  __cxa_begin_catch(a1);
  std::terminate();
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2EOS3_ @ 0x42B4 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(_QWORD *a1, _QWORD *a2)
{
  __int64 result; // x0

  result = std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl();
  *a1 = *a2;
  return result;
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2EOS2_ @ 0x42F4 */
void std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl()
{
  ;
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4308 */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x432C */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERS3_ @ 0x4350 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERS1_ @ 0x4374 */
void std::_Head_base<0ul,int *,false>::_M_head()
{
  ;
}


/* Function: _ZN8RTTIBaseC2Ev @ 0x4388 */
void __fastcall RTTIBase::RTTIBase(RTTIBase *this)
{
  *(_QWORD *)this = off_17D58;
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
__int64 __fastcall RTTIDerivedA::getType(RTTIDerivedA *this)
{
  return 1;
}


/* Function: _ZN8RTTIBaseD2Ev @ 0x4414 */
void __fastcall RTTIBase::~RTTIBase(RTTIBase *this)
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
__int64 __fastcall RTTIBase::getType(RTTIBase *this)
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
__int64 __fastcall RTTIDerivedB::getType(RTTIDerivedB *this)
{
  return 2;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi @ 0x44D0 */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIiELb1ELb1EECI2St15__uniq_ptr_implIiS1_EEPi(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEEC2EPi @ 0x44FC */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::__uniq_ptr_impl(__int64 a1, __int64 a2)
{
  _QWORD *result; // x0

  std::tuple<int *,std::default_delete<int>>::tuple<true,true>();
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(a1);
  *result = a2;
  return result;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIiEEEC2ILb1ELb1EEEv @ 0x4540 */
__int64 std::tuple<int *,std::default_delete<int>>::tuple<true,true>()
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl();
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEEC2Ev @ 0x456C */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_Tuple_impl(__int64 a1)
{
  std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl();
  return std::_Head_base<0ul,int *,false>::_Head_base(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEEC2Ev @ 0x459C */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_Tuple_impl(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base(a1);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2Ev @ 0x45C0 */
_QWORD *__fastcall std::_Head_base<0ul,int *,false>::_Head_base(_QWORD *result)
{
  *result = 0;
  return result;
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EEC2Ev @ 0x45D8 */
void std::_Head_base<1ul,std::default_delete<int>,true>::_Head_base()
{
  ;
}


/* Function: _ZNSt10unique_ptrIiSt14default_deleteIiEE11get_deleterEv @ 0x45E8 */
__int64 std::unique_ptr<int>::get_deleter()
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter();
}


/* Function: _ZNKSt14default_deleteIiEclEPi @ 0x461C */
void __fastcall std::default_delete<int>::operator()(__int64 a1, void *a2)
{
  if ( a2 )
    operator delete(a2);
}


/* Function: _ZSt4moveIRPiEONSt16remove_referenceIT_E4typeEOS3_ @ 0x4658 */
void std::move<int *&>()
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIiEE10_M_deleterEv @ 0x466C */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIiEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_ @ 0x4690 */
__int64 __fastcall std::get<1ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<1ul,std::default_delete<int>>(a1);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIiEJEERT0_RSt11_Tuple_implIXT_EJS2_DpT1_EE @ 0x46B4 */
__int64 __fastcall std::__get_helper<1ul,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIiEEE7_M_headERS2_ @ 0x46D8 */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int>,true>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIiELb1EE7_M_headERS2_ @ 0x46FC */
void std::_Head_base<1ul,std::default_delete<int>,true>::_M_head()
{
  ;
}


/* Function: _ZNKSt10unique_ptrIiSt14default_deleteIiEE3getEv @ 0x4710 */
__int64 std::unique_ptr<int>::get()
{
  return std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr();
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIiEE6_M_ptrEv @ 0x4744 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int>>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIiEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS7_ @ 0x476C */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int>>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIiEEERKT0_RKSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4790 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIiEEE7_M_headERKS3_ @ 0x47B4 */
__int64 __fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int>>::_M_head(__int64 a1)
{
  return std::_Head_base<0ul,int *,false>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EE7_M_headERKS1_ @ 0x47D8 */
void std::_Head_base<0ul,int *,false>::_M_head()
{
  ;
}


/* Function: _ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi @ 0x47EC */
__int64 __fastcall ZNSt15__uniq_ptr_dataIiSt14default_deleteIA_iELb1ELb1EECI2St15__uniq_ptr_implIiS2_EEPi(
        __int64 a1,
        __int64 a2)
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(a1, a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEEC2EPi @ 0x4818 */
_QWORD *__fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::__uniq_ptr_impl(__int64 a1, __int64 a2)
{
  _QWORD *result; // x0

  std::tuple<int *,std::default_delete<int []>>::tuple<true,true>();
  result = (_QWORD *)std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(a1);
  *result = a2;
  return result;
}


/* Function: _ZNSt5tupleIJPiSt14default_deleteIA_iEEEC2ILb1ELb1EEEv @ 0x485C */
__int64 std::tuple<int *,std::default_delete<int []>>::tuple<true,true>()
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl();
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x4888 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(__int64 a1)
{
  return std::get<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEEC2Ev @ 0x48AC */
_QWORD *__fastcall std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_Tuple_impl(_QWORD *a1)
{
  std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl();
  return std::_Head_base<0ul,int *,false>::_Head_base(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEEC2Ev @ 0x48DC */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_Tuple_impl(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base(a1);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EEC2Ev @ 0x4900 */
void std::_Head_base<1ul,std::default_delete<int []>,true>::_Head_base()
{
  ;
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x4910 */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERT0_RSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4934 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERS4_ @ 0x4958 */
void std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head()
{
  std::_Head_base<0ul,int *,false>::_M_head();
}


/* Function: _ZNSt10unique_ptrIA_iSt14default_deleteIS0_EE11get_deleterEv @ 0x497C */
__int64 std::unique_ptr<int []>::get_deleter()
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter();
}


/* Function: _ZNKSt14default_deleteIA_iEclIiEENSt9enable_ifIXsr14is_convertibleIPA_T_PS0_EE5valueEvE4typeEPS4_ @ 0x49B0 */
void __fastcall std::default_delete<int []>::operator()<int>(__int64 a1, void *a2)
{
  if ( a2 )
    operator delete[](a2);
}


/* Function: _ZNSt15__uniq_ptr_implIiSt14default_deleteIA_iEE10_M_deleterEv @ 0x49EC */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_deleter(__int64 a1)
{
  return std::get<1ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZSt3getILm1EJPiSt14default_deleteIA_iEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS8_ @ 0x4A10 */
__int64 __fastcall std::get<1ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<1ul,std::default_delete<int []>>(a1);
}


/* Function: _ZSt12__get_helperILm1ESt14default_deleteIA_iEJEERT0_RSt11_Tuple_implIXT_EJS3_DpT1_EE @ 0x4A34 */
__int64 __fastcall std::__get_helper<1ul,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm1EJSt14default_deleteIA_iEEE7_M_headERS3_ @ 0x4A58 */
__int64 __fastcall std::_Tuple_impl<1ul,std::default_delete<int []>>::_M_head(__int64 a1)
{
  return std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head(a1);
}


/* Function: _ZNSt10_Head_baseILm1ESt14default_deleteIA_iELb1EE7_M_headERS3_ @ 0x4A7C */
void std::_Head_base<1ul,std::default_delete<int []>,true>::_M_head()
{
  ;
}


/* Function: _ZNKSt10unique_ptrIA_iSt14default_deleteIS0_EE3getEv @ 0x4A90 */
__int64 std::unique_ptr<int []>::get()
{
  return std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr();
}


/* Function: _ZNKSt15__uniq_ptr_implIiSt14default_deleteIA_iEE6_M_ptrEv @ 0x4AC4 */
__int64 __fastcall std::__uniq_ptr_impl<int,std::default_delete<int []>>::_M_ptr(__int64 a1)
{
  return *(_QWORD *)std::get<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZSt3getILm0EJPiSt14default_deleteIA_iEEERKNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERKS8_ @ 0x4AEC */
__int64 __fastcall std::get<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::__get_helper<0ul,int *,std::default_delete<int []>>(a1);
}


/* Function: _ZSt12__get_helperILm0EPiJSt14default_deleteIA_iEEERKT0_RKSt11_Tuple_implIXT_EJS4_DpT1_EE @ 0x4B10 */
__int64 __fastcall std::__get_helper<0ul,int *,std::default_delete<int []>>(__int64 a1)
{
  return std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head(a1);
}


/* Function: _ZNSt11_Tuple_implILm0EJPiSt14default_deleteIA_iEEE7_M_headERKS4_ @ 0x4B34 */
void std::_Tuple_impl<0ul,int *,std::default_delete<int []>>::_M_head()
{
  std::_Head_base<0ul,int *,false>::_M_head();
}


/* Function: _ZSt7forwardIRPiEOT_RNSt16remove_referenceIS2_E4typeE @ 0x4B58 */
void std::forward<int *&>()
{
  ;
}


/* Function: _ZNSt10_Head_baseILm0EPiLb0EEC2IRS0_EEOT_ @ 0x4B6C */
void __fastcall std::_Head_base<0ul,int *,false>::_Head_base<int *&>(_QWORD *a1)
{
  _QWORD *v1; // x0

  std::forward<int *&>();
  *a1 = *v1;
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

/* Total functions decompiled: 216, failed: 25 */
