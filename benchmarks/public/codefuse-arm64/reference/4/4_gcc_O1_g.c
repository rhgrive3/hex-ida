/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_O1_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x738 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_750 @ 0x750 */
void sub_750()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x800 */
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


/* Function: call_weak_fn @ 0x834 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x850 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x880 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x8C0 */
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


/* Function: frame_dummy @ 0x910 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: callback_func @ 0x914 */
int __fastcall callback_func(int x)
{
  return 2 * x;
}


/* Function: func_a @ 0x91C */
int __fastcall func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0x924 */
int __fastcall func_b(int x)
{
  return 2 * x;
}


/* Function: cdecl_func @ 0x92C */
int __fastcall cdecl_func(int a, int b)
{
  return a + b;
}


/* Function: call_cdecl @ 0x934 */
int __cdecl call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x93C */
int __fastcall stdcall_func(int a, int b)
{
  return a * b;
}


/* Function: call_stdcall @ 0x944 */
int __cdecl call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x94C */
int __fastcall fastcall_func(int a, int b, int c)
{
  return a + b + c;
}


/* Function: call_fastcall @ 0x958 */
int __cdecl call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x960 */
int __cdecl call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x968 */
int __fastcall arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_arm_aapcs @ 0x97C */
int __cdecl call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x984 */
int __fastcall mips_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_mips @ 0x994 */
int __cdecl call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x99C */
int __fastcall amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return a + b + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0x9B4 */
int __cdecl call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x9BC */
int __fastcall ms_x64_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_ms_x64 @ 0x9D0 */
int __cdecl call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0x9D8 */
int __fastcall vectorcall_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_vectorcall @ 0x9E8 */
int __cdecl call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0x9F0 */
int __cdecl mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0x9F8 */
int varargs_func(int count, ...)
{
  int v2; // w1
  int result; // w0
  int gr_offs; // w3
  char *stack; // x2
  gcc_va_list args; // [xsp+18h] [xbp+18h] BYREF
  char v7; // [xsp+80h] [xbp+80h] BYREF

  v2 = 0;
  va_copy(args, args);
  args[0].__gr_offs = -56;
  if ( count <= 0 )
    return 0;
  result = 0;
  do
  {
    gr_offs = args[0].__gr_offs;
    stack = (char *)args[0].__stack;
    if ( args[0].__gr_offs < 0 )
    {
      args[0].__gr_offs += 8;
      if ( gr_offs + 8 <= 0 )
        stack = &v7 + gr_offs;
      else
        args[0].__stack = (void *)(((unsigned __int64)args[0].__stack + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    else
    {
      args[0].__stack = (void *)(((unsigned __int64)args[0].__stack + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    result += *(_DWORD *)stack;
    ++v2;
  }
  while ( count != v2 );
  return result;
}


/* Function: func_no_args @ 0xAE8 */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xAF0 */
int __fastcall func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return a + b + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0xB10 */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v7; // w0

  v7 = 0;
  if ( s )
    v7 = strlen(s);
  return (unsigned int)(int)((double)(v7 + x) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xB64 */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  LargeStruct *v1; // x1
  LargeStruct *v2; // x3
  __int64 result; // x0
  __int64 v4; // t1

  v1 = s;
  v2 = s + 1;
  result = 0;
  do
  {
    v4 = v1->data[0];
    v1 = (LargeStruct *)((char *)v1 + 8);
    result += v4;
  }
  while ( v1 != v2 );
  return result;
}


/* Function: func_struct_byptr @ 0xB84 */
int __fastcall func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->x * p->y;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xBA0 */
void __cdecl test_calling_conventions()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  __int64 i; // x0
  LargeStruct *v3; // x0
  __int64 v4; // x2
  __int64 v5; // t1
  LargeStruct large; // [xsp+18h] [xbp+18h] BYREF
  LargeStruct v7; // [xsp+98h] [xbp+98h] BYREF
  __int64 v8; // [xsp+118h] [xbp+118h] BYREF

  puts(asc_1570);
  __printf_chk(1, "CALL-L1-01: %d\n", 15);
  __printf_chk(1, "CALL-L1-02: %d\n", 50);
  __printf_chk(1, "CALL-L1-03: %d\n", 6);
  __printf_chk(1, "CALL-L1-04: %d\n", 15);
  __printf_chk(1, "CALL-L1-05: %d\n", 15);
  __printf_chk(1, "CALL-L1-06: %d\n", 100);
  __printf_chk(1, "CALL-L1-07: %d\n", 21);
  __printf_chk(1, "CALL-L1-08: %d\n", 15);
  __printf_chk(1, "CALL-L1-09: %d\n", 10);
  __printf_chk(1, "CALL-L1-10: %d\n", 33);
  v0 = varargs_func(5, 1, 2, 3, 4);
  __printf_chk(1, aCallL206, v0);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  v1 = func_mixed_args(10, "test", 3.14, 100);
  __printf_chk(1, aCallL209, v1);
  for ( i = 1; i != 17; ++i )
    large.data[i - 1] = i;
  v3 = &v7;
  v7 = large;
  v4 = 0;
  do
  {
    v5 = v3->data[0];
    v3 = (LargeStruct *)((char *)v3 + 8);
    v4 += v5;
  }
  while ( &v8 != (__int64 *)v3 );
  __printf_chk(1, aCallL210, v4, &v8);
  __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xDC0 */
int __fastcall param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0xDC8 */
int __cdecl call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xDD0 */
int __fastcall param_by_value_ptr(int *p)
{
  *p *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0xDE4 */
int __cdecl call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xDEC */
int __fastcall param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0xDF4 */
int __cdecl call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xDFC */
int __fastcall param_string(const char *str)
{
  return *(unsigned __int8 *)str + *((unsigned __int8 *)str + 1);
}


/* Function: call_string_param @ 0xE0C */
int __cdecl call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xE14 */
int __fastcall param_ptr_array(char **arr, int n)
{
  __int64 v3; // x2
  int result; // w0

  if ( n <= 0 )
    return 0;
  v3 = 0;
  result = 0;
  do
    result += (unsigned __int8)*arr[v3++];
  while ( n > (int)v3 );
  return result;
}


/* Function: call_ptr_array @ 0xE4C */
int __cdecl call_ptr_array()
{
  char *strs[3]; // [xsp+10h] [xbp+10h] BYREF

  strs[0] = (char *)off_13010;
  strs[1] = (char *)off_13018;
  strs[2] = (char *)off_13020;
  return param_ptr_array(strs, 3);
}


/* Function: param_varargs @ 0xEB4 */
int param_varargs(int count, ...)
{
  int v2; // w1
  int result; // w0
  int gr_offs; // w3
  char *stack; // x2
  gcc_va_list args; // [xsp+18h] [xbp+18h] BYREF
  char v7; // [xsp+80h] [xbp+80h] BYREF

  v2 = 0;
  va_copy(args, args);
  args[0].__gr_offs = -56;
  if ( count <= 0 )
    return 0;
  result = 0;
  do
  {
    gr_offs = args[0].__gr_offs;
    stack = (char *)args[0].__stack;
    if ( args[0].__gr_offs < 0 )
    {
      args[0].__gr_offs += 8;
      if ( gr_offs + 8 <= 0 )
        stack = &v7 + gr_offs;
      else
        args[0].__stack = (void *)(((unsigned __int64)args[0].__stack + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    else
    {
      args[0].__stack = (void *)(((unsigned __int64)args[0].__stack + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    result += *(_DWORD *)stack;
    ++v2;
  }
  while ( count != v2 );
  return result;
}


/* Function: call_varargs_param @ 0xFA4 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0xFCC */
int __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: call_func_ptr_param @ 0xFEC */
int __cdecl call_func_ptr_param()
{
  return param_func_ptr(callback_func, 5);
}


/* Function: param_double_ptr @ 0x100C */
int __fastcall param_double_ptr(int **pp, int new_val)
{
  if ( !pp )
    return -1;
  if ( !*pp )
    return -1;
  **pp = new_val;
  *pp = 0;
  return 1;
}


/* Function: call_double_ptr @ 0x1038 */
int __cdecl call_double_ptr()
{
  int result; // w0
  int val; // [xsp+1Ch] [xbp+1Ch] BYREF
  int *ptr; // [xsp+20h] [xbp+20h] BYREF

  val = 10;
  ptr = &val;
  param_double_ptr(&ptr, 20);
  result = val;
  if ( !ptr )
    return val + 1;
  return result;
}


/* Function: param_complex_cast @ 0x10A8 */
int __fastcall param_complex_cast(void *p, int type)
{
  if ( !type )
    return *(_DWORD *)p;
  if ( type == 1 )
    return *(_DWORD *)p + *((_DWORD *)p + 1);
  return -1;
}


/* Function: call_complex_cast @ 0x10D4 */
int __cdecl call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x10E0 */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[0] + s->data[15]);
}


/* Function: call_struct_byval @ 0x10F0 */
int __cdecl call_struct_byval()
{
  BigStruct *p_s; // x1
  int i; // w0
  BigStruct s; // [xsp+18h] [xbp+18h] BYREF

  p_s = &s;
  for ( i = 0; i != 16; ++i )
  {
    p_s->data[0] = i;
    p_s = (BigStruct *)((char *)p_s + 4);
  }
  return s.data[15] + s.data[0];
}


/* Function: param_order_dep @ 0x1158 */
int __fastcall param_order_dep(int a, int b)
{
  return a + b;
}


/* Function: call_order_dep @ 0x1160 */
int __cdecl call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x1168 */
void __cdecl test_parameter_passing()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0

  puts(asc_1740);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  v0 = call_by_value_ptr();
  __printf_chk(1, "PARAM-L1-02: %d\n", v0);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  v1 = call_ptr_array();
  __printf_chk(1, "PARAM-L2-03: %d\n", v1);
  v2 = call_varargs_param();
  __printf_chk(1, "PARAM-L2-04: %d\n", v2);
  v3 = call_func_ptr_param();
  __printf_chk(1, "PARAM-L3-01: %d\n", v3);
  v4 = call_double_ptr();
  __printf_chk(1, "PARAM-L3-02: %d\n", v4);
  v5 = call_complex_cast();
  __printf_chk(1, "PARAM-L3-03: %d\n", v5);
  v6 = call_struct_byval();
  __printf_chk(1, "PARAM-L3-04: %d\n", v6);
  __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x127C */
int __fastcall ret_basic_type(int x)
{
  return 2 * x;
}


/* Function: call_ret_basic @ 0x1284 */
int __cdecl call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x128C */
int *__fastcall ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0x1294 */
int __cdecl call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x129C */
// local variable allocation has failed, the output may be wrong!
SmallPoint __fastcall ret_small_struct(int x, int y)
{
  return (SmallPoint)((unsigned int)x | (*(_QWORD *)&y << 32));
}


/* Function: call_ret_small_struct @ 0x12A8 */
int __cdecl call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x12B0 */
void *__usercall ret_large_struct@<X0>(int a1@<W0>, _OWORD *a2@<X8>)
{
  __int64 v2; // x1
  int v3; // w0
  __int128 v4; // q1
  __int128 v5; // q1
  LargeData d; // [xsp+18h] [xbp+18h] BYREF

  v2 = 1;
  v3 = a1 - 1;
  do
  {
    d.data[v2 - 1] = v3 + v2;
    ++v2;
  }
  while ( v2 != 17 );
  v4 = *(_OWORD *)&d.data[4];
  *a2 = *(_OWORD *)d.data;
  a2[1] = v4;
  v5 = *(_OWORD *)&d.data[12];
  a2[2] = *(_OWORD *)&d.data[8];
  a2[3] = v5;
  return &_stack_chk_guard;
}


/* Function: call_ret_large_struct @ 0x132C */
int __cdecl call_ret_large_struct()
{
  LargeData d; // [xsp+18h] [xbp+18h] BYREF

  ret_large_struct(100, &d);
  return d.data[0] + d.data[15];
}


/* Function: ret_func_ptr @ 0x1388 */
func_ptr_t __fastcall ret_func_ptr(int selector)
{
  if ( selector )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0x13A4 */
int __cdecl call_ret_func_ptr()
{
  return func_b(5);
}


/* Function: ret_opaque_handle @ 0x13BC */
void *__fastcall ret_opaque_handle(int type)
{
  if ( type )
    return &handle2_0;
  else
    return &handle1_1;
}


/* Function: call_ret_opaque @ 0x13E0 */
int __cdecl call_ret_opaque()
{
  return handle1_1;
}


/* Function: ret_complex_expr @ 0x13EC */
int __fastcall ret_complex_expr(int x, int y, int z)
{
  int v3; // w3
  int v4; // w2

  v3 = 2 * z;
  v4 = z + 10;
  if ( x > y )
    return v3;
  else
    return v4;
}


/* Function: call_ret_complex_expr @ 0x1400 */
int __cdecl call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1408 */
int __fastcall ret_multi_branch(int op)
{
  int result; // w0

  result = 20;
  if ( op != 1 )
  {
    result = 30;
    if ( op != 2 )
    {
      if ( op )
        return -1;
      else
        return 10;
    }
  }
  return result;
}


/* Function: call_ret_multi_branch @ 0x1434 */
int __cdecl call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x143C */
void __fastcall ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x1448 */
int __cdecl call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x1450 */
void __cdecl test_return_values()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0

  puts(asc_1870);
  __printf_chk(1, aRetL101D, 42);
  v0 = call_ret_pointer();
  __printf_chk(1, aRetL102D, v0);
  v1 = call_ret_small_struct();
  __printf_chk(1, aRetL103D, v1);
  v2 = call_ret_large_struct();
  __printf_chk(1, aRetL104D, v2);
  v3 = call_ret_func_ptr();
  __printf_chk(1, aRetL201D, v3);
  __printf_chk(1, aRetL202D, (unsigned int)handle1_1);
  __printf_chk(1, aRetL301D, 40);
  __printf_chk(1, aRetL302D, 60);
  __printf_chk(1, aRetL303D, 21);
}


/* Function: main @ 0x1534 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x1554 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x13090 */

/* FAILED to decompile: __libc_start_main @ 0x13098 */

/* FAILED to decompile: __cxa_finalize @ 0x130A0 */

/* FAILED to decompile: __printf_chk @ 0x130A8 */

/* FAILED to decompile: __stack_chk_fail @ 0x130B0 */

/* FAILED to decompile: abort @ 0x130C0 */

/* FAILED to decompile: puts @ 0x130C8 */

/* FAILED to decompile: __gmon_start__ @ 0x130D8 */

/* Total functions decompiled: 80, failed: 8 */
