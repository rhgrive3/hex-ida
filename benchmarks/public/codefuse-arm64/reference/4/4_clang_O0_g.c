/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x6B0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_6D0 @ 0x6D0 */
void sub_6D0()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x780 */
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


/* Function: call_weak_fn @ 0x7B4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x7D0 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x800 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x840 */
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


/* Function: frame_dummy @ 0x890 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: cdecl_func @ 0x894 */
int __cdecl cdecl_func(int a, int b)
{
  return a + b;
}


/* Function: call_cdecl @ 0x8B4 */
int __cdecl call_cdecl()
{
  return cdecl_func(5, 10);
}


/* Function: stdcall_func @ 0x8D0 */
int __cdecl stdcall_func(int a, int b)
{
  return a * b;
}


/* Function: call_stdcall @ 0x8F0 */
int __cdecl call_stdcall()
{
  return stdcall_func(5, 10);
}


/* Function: fastcall_func @ 0x90C */
int __cdecl fastcall_func(int a, int b, int c)
{
  return a + b + c;
}


/* Function: call_fastcall @ 0x938 */
int __cdecl call_fastcall()
{
  return fastcall_func(1, 2, 3);
}


/* Function: call_thiscall @ 0x958 */
int __cdecl call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x960 */
int __cdecl arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_arm_aapcs @ 0x9A4 */
int __cdecl call_arm_aapcs()
{
  return arm_aapcs_func(1, 2, 3, 4, 5);
}


/* Function: mips_func @ 0x9CC */
int __cdecl mips_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_mips @ 0xA04 */
int __cdecl call_mips()
{
  return mips_func(10, 20, 30, 40);
}


/* Function: amd64_sysv_func @ 0xA28 */
int __cdecl amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return a + b + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0xA78 */
int __cdecl call_amd64_sysv()
{
  return amd64_sysv_func(1, 2, 3, 4, 5, 6);
}


/* Function: ms_x64_func @ 0xAA4 */
int __cdecl ms_x64_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_ms_x64 @ 0xAE8 */
int __cdecl call_ms_x64()
{
  return ms_x64_func(1, 2, 3, 4, 5);
}


/* Function: vectorcall_func @ 0xB10 */
int __cdecl vectorcall_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_vectorcall @ 0xB48 */
int __cdecl call_vectorcall()
{
  return vectorcall_func(1, 2, 3, 4);
}


/* Function: mixed_conventions_test @ 0xB6C */
int __cdecl mixed_conventions_test()
{
  int sum; // [xsp+Ch] [xbp-4h]
  int suma; // [xsp+Ch] [xbp-4h]

  sum = cdecl_func(1, 2);
  suma = sum + stdcall_func(3, 4);
  return suma + fastcall_func(5, 6, 7);
}


/* Function: varargs_func @ 0xBD8 */
int varargs_func(int count, ...)
{
  _DWORD *stack; // x8
  _DWORD *v3; // [xsp+8h] [xbp-118h]
  int gr_offs; // [xsp+1Ch] [xbp-104h]
  int i; // [xsp+E0h] [xbp-40h]
  int v6; // [xsp+E4h] [xbp-3Ch]
  gcc_va_list va; // [xsp+E8h] [xbp-38h] BYREF
  int v8; // [xsp+10Ch] [xbp-14h]

  va_start(va, count);
  v8 = count;
  v6 = 0;
  for ( i = 0; i < v8; ++i )
  {
    gr_offs = va[0].__gr_offs;
    if ( va[0].__gr_offs < 0 && (va[0].__gr_offs += 8, gr_offs + 8 <= 0) )
    {
      v3 = (char *)va[0].__gr_top + gr_offs;
    }
    else
    {
      stack = va[0].__stack;
      va[0].__stack = (char *)va[0].__stack + 8;
      v3 = stack;
    }
    v6 += *v3;
  }
  return v6;
}


/* Function: func_no_args @ 0xD10 */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xD18 */
int __cdecl func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return a + b + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0xD80 */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v5; // [xsp+0h] [xbp-30h]

  if ( s )
    v5 = strlen(s);
  else
    v5 = 0;
  return (unsigned int)(int)((double)(x + v5) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xE00 */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  int i; // [xsp+14h] [xbp-Ch]
  __int64 v3; // [xsp+18h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < 16; ++i )
    v3 += s->data[i];
  return (unsigned int)v3;
}


/* Function: func_struct_byptr @ 0xE60 */
int __cdecl func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->x * p->y;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xEA8 */
void __cdecl test_calling_conventions()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v8; // w0
  int v9; // w0
  unsigned int v10; // [xsp+2Ch] [xbp-134h]
  SmallStruct p; // [xsp+30h] [xbp-130h] BYREF
  LargeStruct dest; // [xsp+38h] [xbp-128h] BYREF
  unsigned int v13; // [xsp+B8h] [xbp-A8h]
  int i; // [xsp+BCh] [xbp-A4h]
  _QWORD src[3]; // [xsp+C0h] [xbp-A0h] BYREF
  LargeStruct large; // [xsp+E0h] [xbp-80h]

  printf(asc_1DC0);
  v0 = call_cdecl();
  printf("CALL-L1-01: %d\n", v0);
  v1 = call_stdcall();
  printf("CALL-L1-02: %d\n", v1);
  v2 = call_fastcall();
  printf("CALL-L1-03: %d\n", v2);
  v3 = call_thiscall();
  printf("CALL-L1-04: %d\n", v3);
  v4 = call_arm_aapcs();
  printf("CALL-L1-05: %d\n", v4);
  v5 = call_mips();
  printf("CALL-L1-06: %d\n", v5);
  v6 = call_amd64_sysv();
  printf("CALL-L1-07: %d\n", v6);
  v7 = call_ms_x64();
  printf("CALL-L1-08: %d\n", v7);
  v8 = call_vectorcall();
  printf("CALL-L1-09: %d\n", v8);
  v9 = mixed_conventions_test();
  printf("CALL-L1-10: %d\n", v9);
  HIDWORD(large.data[15]) = varargs_func(5);
  printf(aCallL206, HIDWORD(large.data[15]));
  LODWORD(large.data[15]) = func_no_args();
  printf(aCallL207, LODWORD(large.data[15]));
  HIDWORD(large.data[14]) = func_many_args(1, 2, 3, 4, 5, 6, 7, 8);
  printf(aCallL208, HIDWORD(large.data[14]));
  large.data[13] = (__int64)"test";
  HIDWORD(large.data[12]) = func_mixed_args(10, "test", 3.14, 100);
  printf(aCallL209, HIDWORD(large.data[12]));
  for ( i = 0; i < 16; ++i )
    src[i] = i + 1;
  memcpy(&dest, src, sizeof(dest));
  v13 = func_struct_byval(&dest);
  printf(aCallL210, v13);
  p = (SmallStruct)0xA00000005LL;
  v10 = func_struct_byptr(&p);
  printf(aCallL211, v10);
}


/* Function: param_by_value_int @ 0x1118 */
int __cdecl param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0x1138 */
int __cdecl call_by_value_int()
{
  return param_by_value_int(5) + 5;
}


/* Function: param_by_value_ptr @ 0x1170 */
int __cdecl param_by_value_ptr(int *p)
{
  *p *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0x11A8 */
int __cdecl call_by_value_ptr()
{
  int v1; // [xsp+Ch] [xbp-14h]
  int val; // [xsp+1Ch] [xbp-4h] BYREF

  val = 5;
  v1 = param_by_value_ptr(&val);
  return val + v1;
}


/* Function: param_array_decay @ 0x11E8 */
int __cdecl param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0x1200 */
int __cdecl call_array_decay()
{
  int s[10]; // [xsp+8h] [xbp-28h] BYREF

  memset(s, 0, sizeof(s));
  return param_array_decay(s, 10);
}


/* Function: param_string @ 0x1238 */
int __cdecl param_string(const char *str)
{
  return *(unsigned __int8 *)str + *((unsigned __int8 *)str + 1);
}


/* Function: call_string_param @ 0x125C */
int __cdecl call_string_param()
{
  return param_string("Hello");
}


/* Function: param_ptr_array @ 0x1278 */
int __cdecl param_ptr_array(char **arr, int n)
{
  int i; // [xsp+Ch] [xbp-14h]
  int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < n; ++i )
    v4 += (unsigned __int8)*arr[i];
  return v4;
}


/* Function: call_ptr_array @ 0x12E0 */
int __cdecl call_ptr_array()
{
  __int128 v1; // [xsp+0h] [xbp-20h] BYREF
  const char *v2; // [xsp+10h] [xbp-10h]

  v1 = *(_OWORD *)off_12DC0;
  v2 = "ghi";
  return param_ptr_array((char **)&v1, 3);
}


/* Function: param_varargs @ 0x131C */
int param_varargs(int count, ...)
{
  _DWORD *stack; // x8
  _DWORD *v3; // [xsp+8h] [xbp-118h]
  int gr_offs; // [xsp+1Ch] [xbp-104h]
  int i; // [xsp+E0h] [xbp-40h]
  int v6; // [xsp+E4h] [xbp-3Ch]
  gcc_va_list va; // [xsp+E8h] [xbp-38h] BYREF
  int v8; // [xsp+10Ch] [xbp-14h]

  va_start(va, count);
  v8 = count;
  v6 = 0;
  for ( i = 0; i < v8; ++i )
  {
    gr_offs = va[0].__gr_offs;
    if ( va[0].__gr_offs < 0 && (va[0].__gr_offs += 8, gr_offs + 8 <= 0) )
    {
      v3 = (char *)va[0].__gr_top + gr_offs;
    }
    else
    {
      stack = va[0].__stack;
      va[0].__stack = (char *)va[0].__stack + 8;
      v3 = stack;
    }
    v6 += *v3;
  }
  return v6;
}


/* Function: call_varargs_param @ 0x1454 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0x147C */
__int64 __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return (unsigned int)callback(x) + 10;
}


/* Function: call_func_ptr_param @ 0x14AC */
int __cdecl call_func_ptr_param()
{
  return param_func_ptr((int (*)(int))callback_func, 5);
}


/* Function: callback_func @ 0x14CC */
int __cdecl callback_func(int x)
{
  return 2 * x;
}


/* Function: param_double_ptr @ 0x14E4 */
int __cdecl param_double_ptr(int **pp, int new_val)
{
  if ( !pp || !*pp )
    return -1;
  **pp = new_val;
  *pp = 0;
  return 1;
}


/* Function: call_double_ptr @ 0x1548 */
int __cdecl call_double_ptr()
{
  int *pp; // [xsp+10h] [xbp-10h] BYREF
  int val; // [xsp+1Ch] [xbp-4h] BYREF

  val = 10;
  pp = &val;
  param_double_ptr(&pp, 20);
  return val + (pp == 0);
}


/* Function: param_complex_cast @ 0x1598 */
int __cdecl param_complex_cast(void *p, int type)
{
  if ( !type )
    return *(_DWORD *)p;
  if ( type == 1 )
    return *(_DWORD *)p + *((_DWORD *)p + 1);
  return -1;
}


/* Function: call_complex_cast @ 0x1628 */
int __cdecl call_complex_cast()
{
  __int64 p; // [xsp+10h] [xbp-10h] BYREF
  int val; // [xsp+1Ch] [xbp-4h] BYREF

  val = 305419896;
  p = 0xC800000064LL;
  param_complex_cast(&p, 1);
  return param_complex_cast(&val, 0);
}


/* Function: param_struct_byval @ 0x167C */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[0] + s->data[15]);
}


/* Function: call_struct_byval @ 0x168C */
int __cdecl call_struct_byval()
{
  BigStruct dest; // [xsp+Ch] [xbp-84h] BYREF
  int i; // [xsp+4Ch] [xbp-44h]
  BigStruct s; // [xsp+50h] [xbp-40h] BYREF

  for ( i = 0; i < 16; ++i )
    s.data[i] = i;
  memcpy(&dest, &s, sizeof(dest));
  return param_struct_byval(&dest);
}


/* Function: param_order_dep @ 0x16FC */
int __cdecl param_order_dep(int a, int b)
{
  return a + b;
}


/* Function: call_order_dep @ 0x171C */
int __cdecl call_order_dep()
{
  return param_order_dep(1, 2);
}


/* Function: test_parameter_passing @ 0x1754 */
void __cdecl test_parameter_passing()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v8; // w0
  int v9; // w0
  int v10; // w0

  printf(asc_1F8B);
  v0 = call_by_value_int();
  printf("PARAM-L1-01: %d\n", v0);
  v1 = call_by_value_ptr();
  printf("PARAM-L1-02: %d\n", v1);
  v2 = call_array_decay();
  printf("PARAM-L2-01: %d\n", v2);
  v3 = call_string_param();
  printf("PARAM-L2-02: %d\n", v3);
  v4 = call_ptr_array();
  printf("PARAM-L2-03: %d\n", v4);
  v5 = call_varargs_param();
  printf("PARAM-L2-04: %d\n", v5);
  v6 = call_func_ptr_param();
  printf("PARAM-L3-01: %d\n", v6);
  v7 = call_double_ptr();
  printf("PARAM-L3-02: %d\n", v7);
  v8 = call_complex_cast();
  printf("PARAM-L3-03: %d\n", v8);
  v9 = call_struct_byval();
  printf("PARAM-L3-04: %d\n", v9);
  v10 = call_order_dep();
  printf("PARAM-L3-05: %d\n", v10);
}


/* Function: ret_basic_type @ 0x184C */
int __cdecl ret_basic_type(int x)
{
  return 2 * x;
}


/* Function: call_ret_basic @ 0x1864 */
int __cdecl call_ret_basic()
{
  return ret_basic_type(21);
}


/* Function: ret_pointer @ 0x1894 */
int *__cdecl ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0x18AC */
int __cdecl call_ret_pointer()
{
  int p[2]; // [xsp+10h] [xbp-10h] BYREF
  int v2; // [xsp+18h] [xbp-8h]

  *(_QWORD *)p = 0x140000000ALL;
  v2 = 30;
  return *ret_pointer(p);
}


/* Function: ret_small_struct @ 0x18F0 */
SmallPoint __cdecl ret_small_struct(int x, int y)
{
  return (SmallPoint)__PAIR64__(y, x);
}


/* Function: call_ret_small_struct @ 0x1918 */
int __cdecl call_ret_small_struct()
{
  SmallPoint v1; // [xsp+8h] [xbp-8h]

  v1 = ret_small_struct(3, 4);
  return v1.x + v1.y;
}


/* Function: ret_large_struct @ 0x194C */
// local variable allocation has failed, the output may be wrong!
LargeData *__cdecl ret_large_struct(LargeData *__return_ptr retstr, int seed)
{
  LargeData *result; // x0
  int i; // [xsp+8h] [xbp-8h]

  for ( i = 0; i < 16; ++i )
    retstr->data[i] = seed + i;
  LODWORD(result) = seed;
  return result;
}


/* Function: call_ret_large_struct @ 0x19A4 */
int __cdecl call_ret_large_struct()
{
  LargeData v1; // [xsp+0h] [xbp-40h] BYREF

  ret_large_struct(&v1, 100);
  return v1.data[0] + v1.data[15];
}


/* Function: func_a @ 0x19D4 */
int __cdecl func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0x19EC */
int __cdecl func_b(int x)
{
  return 2 * x;
}


/* Function: ret_func_ptr @ 0x1A04 */
func_ptr_t __cdecl ret_func_ptr(int selector)
{
  if ( selector )
    return (func_ptr_t)func_b;
  else
    return (func_ptr_t)func_a;
}


/* Function: call_ret_func_ptr @ 0x1A30 */
int __cdecl call_ret_func_ptr()
{
  func_ptr_t v1; // [xsp+8h] [xbp-8h]

  v1 = ret_func_ptr(1);
  return v1(5);
}


/* Function: ret_opaque_handle @ 0x1A60 */
void *__cdecl ret_opaque_handle(int type)
{
  if ( type )
    return &ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1A8C */
int __cdecl call_ret_opaque()
{
  return *(_DWORD *)ret_opaque_handle(0);
}


/* Function: ret_complex_expr @ 0x1AB8 */
int __cdecl ret_complex_expr(int x, int y, int z)
{
  if ( x <= y )
    return z + 10;
  else
    return 2 * z;
}


/* Function: call_ret_complex_expr @ 0x1B08 */
int __cdecl call_ret_complex_expr()
{
  int r1; // [xsp+1Ch] [xbp-4h]

  r1 = ret_complex_expr(5, 3, 10);
  return r1 + ret_complex_expr(3, 5, 10);
}


/* Function: ret_multi_branch @ 0x1B64 */
int __cdecl ret_multi_branch(int op)
{
  switch ( op )
  {
    case 0:
      return 10;
    case 1:
      return 20;
    case 2:
      return 30;
  }
  return -1;
}


/* Function: call_ret_multi_branch @ 0x1BD8 */
int __cdecl call_ret_multi_branch()
{
  int sum; // [xsp+Ch] [xbp-4h]
  int suma; // [xsp+Ch] [xbp-4h]

  sum = ret_multi_branch(0);
  suma = sum + ret_multi_branch(1);
  return suma + ret_multi_branch(2);
}


/* Function: ret_void @ 0x1C34 */
void __cdecl ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x1C5C */
int __cdecl call_ret_void()
{
  int result; // [xsp+Ch] [xbp-4h] BYREF

  ret_void(7, &result);
  return result;
}


/* Function: test_return_values @ 0x1C84 */
void __cdecl test_return_values()
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

  printf(asc_2068);
  v0 = call_ret_basic();
  printf(aRetL101D, v0);
  v1 = call_ret_pointer();
  printf(aRetL102D, v1);
  v2 = call_ret_small_struct();
  printf(aRetL103D, v2);
  v3 = call_ret_large_struct();
  printf(aRetL104D, v3);
  v4 = call_ret_func_ptr();
  printf(aRetL201D, v4);
  v5 = call_ret_opaque();
  printf(aRetL202D, v5);
  v6 = call_ret_complex_expr();
  printf(aRetL301D, v6);
  v7 = call_ret_multi_branch();
  printf(aRetL302D, v7);
  v8 = call_ret_void();
  printf(aRetL303D, v8);
}


/* Function: main @ 0x1D54 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x1D88 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x130B8 */

/* FAILED to decompile: strlen @ 0x130C0 */

/* FAILED to decompile: __libc_start_main @ 0x130C8 */

/* FAILED to decompile: __cxa_finalize @ 0x130D0 */

/* FAILED to decompile: memset @ 0x130D8 */

/* FAILED to decompile: abort @ 0x130E0 */

/* FAILED to decompile: printf @ 0x130E8 */

/* FAILED to decompile: __gmon_start__ @ 0x130F8 */

/* Total functions decompiled: 80, failed: 8 */
