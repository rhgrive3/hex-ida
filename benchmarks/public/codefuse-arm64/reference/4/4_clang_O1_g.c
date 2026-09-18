/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_O1_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x628 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_640 @ 0x640 */
void sub_640()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x700 */
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


/* Function: call_weak_fn @ 0x734 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x750 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x780 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x7C0 */
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


/* Function: frame_dummy @ 0x810 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: cdecl_func @ 0x814 */
int __fastcall cdecl_func(int a, int b)
{
  return b + a;
}


/* Function: call_cdecl @ 0x81C */
int __cdecl call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x824 */
int __fastcall stdcall_func(int a, int b)
{
  return b * a;
}


/* Function: call_stdcall @ 0x82C */
int __cdecl call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x834 */
int __fastcall fastcall_func(int a, int b, int c)
{
  return b + a + c;
}


/* Function: call_fastcall @ 0x840 */
int __cdecl call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x848 */
int __cdecl call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x850 */
int __fastcall arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return b + a + c + d + e;
}


/* Function: call_arm_aapcs @ 0x864 */
int __cdecl call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x86C */
int __fastcall mips_func(int a, int b, int c, int d)
{
  return b + a + c + d;
}


/* Function: call_mips @ 0x87C */
int __cdecl call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x884 */
int __fastcall amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return b + a + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0x89C */
int __cdecl call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x8A4 */
int __fastcall ms_x64_func(int a, int b, int c, int d, int e)
{
  return b + a + c + d + e;
}


/* Function: call_ms_x64 @ 0x8B8 */
int __cdecl call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0x8C0 */
int __fastcall vectorcall_func(int a, int b, int c, int d)
{
  return b + a + c + d;
}


/* Function: call_vectorcall @ 0x8D0 */
int __cdecl call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0x8D8 */
int __cdecl mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0x8E0 */
int varargs_func(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v2; // w8
  _DWORD *v3; // x10
  __int64 v4; // x10
  _QWORD v6[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v7; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v8; // [xsp+C8h] [xbp-18h]
  _QWORD *v9; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v10; // [xsp+D8h] [xbp-8h]

  va_start(va, count);
  v6[1] = va_arg(va, _QWORD);
  v6[2] = va_arg(va, _QWORD);
  v6[3] = va_arg(va, _QWORD);
  v6[4] = va_arg(va, _QWORD);
  v6[5] = va_arg(va, _QWORD);
  v6[6] = va_arg(va, _QWORD);
  v6[7] = va_arg(va, _QWORD);
  va_end(va);
  v9 = v6;
  v10 = 0xFFFFFF80FFFFFFC8LL;
  v2 = 0;
  v8 = &v7;
  if ( count >= 1 )
  {
    do
    {
      v4 = (int)v10;
      if ( (v10 & 0x80000000) != 0 && (LODWORD(v10) = v10 + 8, (int)v4 + 8 <= 0) )
      {
        v3 = (_DWORD *)((char *)v8 + v4);
      }
      else
      {
        v3 = v7;
        v7 += 2;
      }
      --count;
      v2 += *v3;
    }
    while ( count );
  }
  return v2;
}


/* Function: func_no_args @ 0x984 */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0x98C */
int __fastcall func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return b + a + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0x9AC */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + x) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xA04 */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  __int64 v1; // x9
  unsigned int v2; // w8
  __int64 v3; // x10

  v1 = 0;
  v2 = 0;
  do
  {
    v3 = s->data[v1++];
    v2 += v3;
  }
  while ( v1 != 16 );
  return v2;
}


/* Function: func_struct_byptr @ 0xA28 */
int __fastcall func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->y * p->x;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xA40 */
void __cdecl test_calling_conventions()
{
  unsigned int v0; // w0
  __int64 v1; // x8
  bool v2; // zf
  __int64 v3; // x8
  __int64 v4; // x1
  __int64 v5; // x10
  _OWORD v6[8]; // [xsp+0h] [xbp-100h]
  _OWORD v7[8]; // [xsp+80h] [xbp-80h]

  puts(asc_14BE);
  printf("CALL-L1-01: %d\n", 15);
  printf("CALL-L1-02: %d\n", 50);
  printf("CALL-L1-03: %d\n", 6);
  printf("CALL-L1-04: %d\n", 15);
  printf("CALL-L1-05: %d\n", 15);
  printf("CALL-L1-06: %d\n", 100);
  printf("CALL-L1-07: %d\n", 21);
  printf("CALL-L1-08: %d\n", 15);
  printf("CALL-L1-09: %d\n", 10);
  printf("CALL-L1-10: %d\n", 33);
  v0 = varargs_func(5, 1, 2, 3, 4, 5);
  printf(aCallL206, v0);
  printf(aCallL207, 42);
  printf(aCallL208, 36);
  printf(aCallL209, 117);
  v1 = 0;
  do
  {
    v2 = v1 == 15;
    *((_QWORD *)v7 + v1) = v1 + 1;
    ++v1;
  }
  while ( !v2 );
  v3 = 0;
  v4 = 0;
  v6[4] = v7[4];
  v6[5] = v7[5];
  v6[6] = v7[6];
  v6[7] = v7[7];
  v6[0] = v7[0];
  v6[1] = v7[1];
  v6[2] = v7[2];
  v6[3] = v7[3];
  do
  {
    v5 = *(_QWORD *)((char *)v6 + v3);
    v3 += 8;
    v4 += v5;
  }
  while ( v3 != 128 );
  printf(aCallL210, v4);
  printf(aCallL211, 50);
}


/* Function: param_by_value_int @ 0xBE0 */
int __fastcall param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0xBE8 */
int __cdecl call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xBF0 */
int __fastcall param_by_value_ptr(int *p)
{
  int result; // w0

  result = 1;
  *p *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xC08 */
int __cdecl call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xC10 */
__int64 __fastcall param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0xC18 */
int __cdecl call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xC20 */
int __fastcall param_string(const char *str)
{
  return *((unsigned __int8 *)str + 1) + *(unsigned __int8 *)str;
}


/* Function: call_string_param @ 0xC30 */
int __cdecl call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xC38 */
int __fastcall param_ptr_array(char **arr, int n)
{
  int result; // w0
  __int64 v4; // x9
  unsigned __int8 *v5; // t1

  if ( n < 1 )
    return 0;
  result = 0;
  v4 = (unsigned int)n;
  do
  {
    v5 = (unsigned __int8 *)*arr++;
    --v4;
    result += *v5;
  }
  while ( v4 );
  return result;
}


/* Function: call_ptr_array @ 0xC6C */
int __cdecl call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xC74 */
int param_varargs(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v2; // w8
  _DWORD *v3; // x10
  __int64 v4; // x10
  _QWORD v6[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v7; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v8; // [xsp+C8h] [xbp-18h]
  _QWORD *v9; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v10; // [xsp+D8h] [xbp-8h]

  va_start(va, count);
  v6[1] = va_arg(va, _QWORD);
  v6[2] = va_arg(va, _QWORD);
  v6[3] = va_arg(va, _QWORD);
  v6[4] = va_arg(va, _QWORD);
  v6[5] = va_arg(va, _QWORD);
  v6[6] = va_arg(va, _QWORD);
  v6[7] = va_arg(va, _QWORD);
  va_end(va);
  v9 = v6;
  v10 = 0xFFFFFF80FFFFFFC8LL;
  v2 = 0;
  v8 = &v7;
  if ( count >= 1 )
  {
    do
    {
      v4 = (int)v10;
      if ( (v10 & 0x80000000) != 0 && (LODWORD(v10) = v10 + 8, (int)v4 + 8 <= 0) )
      {
        v3 = (_DWORD *)((char *)v8 + v4);
      }
      else
      {
        v3 = v7;
        v7 += 2;
      }
      --count;
      v2 += *v3;
    }
    while ( count );
  }
  return v2;
}


/* Function: call_varargs_param @ 0xD18 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0xD40 */
int __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: call_func_ptr_param @ 0xD60 */
int __cdecl call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0xD68 */
int __fastcall param_double_ptr(int **pp, int new_val)
{
  int *v3; // x9
  int result; // w0

  if ( !pp )
    return -1;
  v3 = *pp;
  if ( !*pp )
    return -1;
  result = 1;
  *v3 = new_val;
  *pp = 0;
  return result;
}


/* Function: call_double_ptr @ 0xD90 */
int __cdecl call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0xD98 */
int __fastcall param_complex_cast(void *p, int type)
{
  if ( type == 1 )
    return *((_DWORD *)p + 1) + *(_DWORD *)p;
  if ( type )
    return -1;
  return *(_DWORD *)p;
}


/* Function: call_complex_cast @ 0xDC0 */
int __cdecl call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0xDCC */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[15] + s->data[0]);
}


/* Function: call_struct_byval @ 0xDDC */
int __cdecl call_struct_byval()
{
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  for ( i = 0; i != 16; ++i )
    v2[i] = i;
  return v2[15] + v2[0];
}


/* Function: param_order_dep @ 0xE0C */
int __fastcall param_order_dep(int a, int b)
{
  return b + a;
}


/* Function: call_order_dep @ 0xE14 */
int __cdecl call_order_dep()
{
  return 3;
}


/* Function: test_parameter_passing @ 0xE1C */
void __cdecl test_parameter_passing()
{
  int v0; // w0
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  puts(asc_14DF);
  printf("PARAM-L1-01: %d\n", 15);
  printf("PARAM-L1-02: %d\n", 11);
  printf("PARAM-L2-01: %d\n", 8);
  printf("PARAM-L2-02: %d\n", 173);
  printf("PARAM-L2-03: %d\n", 300);
  v0 = param_varargs(4, 10, 20, 30, 40);
  printf("PARAM-L2-04: %d\n", v0);
  printf("PARAM-L3-01: %d\n", 20);
  printf("PARAM-L3-02: %d\n", 21);
  printf("PARAM-L3-03: %d\n", 305419896);
  for ( i = 0; i != 16; ++i )
    v2[i] = i;
  printf("PARAM-L3-04: %d\n", v2[15] + v2[0]);
  printf("PARAM-L3-05: %d\n", 3);
}


/* Function: ret_basic_type @ 0xF2C */
int __fastcall ret_basic_type(int x)
{
  return 2 * x;
}


/* Function: call_ret_basic @ 0xF34 */
int __cdecl call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0xF3C */
int *__fastcall ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0xF44 */
int __cdecl call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0xF4C */
SmallPoint __fastcall ret_small_struct(int x, int y)
{
  return (SmallPoint)((unsigned int)x | ((unsigned __int64)(unsigned int)y << 32));
}


/* Function: call_ret_small_struct @ 0xF58 */
int __cdecl call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0xF60 */
__int64 __usercall ret_large_struct@<X0>(__int64 result@<X0>, __int64 a2@<X8>)
{
  __int64 i; // x9

  for ( i = 0; i != 16; ++i )
    *(_DWORD *)(a2 + 4 * i) = result + i;
  return result;
}


/* Function: call_ret_large_struct @ 0xF80 */
int __cdecl call_ret_large_struct()
{
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  for ( i = 0; i != 16; ++i )
    v2[i] = i + 100;
  return v2[15] + v2[0];
}


/* Function: func_a @ 0xFB4 */
int __fastcall func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0xFBC */
int __fastcall func_b(int x)
{
  return 2 * x;
}


/* Function: ret_func_ptr @ 0xFC4 */
func_ptr_t __fastcall ret_func_ptr(int selector)
{
  if ( selector )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0xFE0 */
int __cdecl call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0xFE8 */
void *__fastcall ret_opaque_handle(int type)
{
  if ( type )
    return &ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1004 */
int __cdecl call_ret_opaque()
{
  return ret_opaque_handle_handle1;
}


/* Function: ret_complex_expr @ 0x1010 */
int __fastcall ret_complex_expr(int x, int y, int z)
{
  if ( x <= y )
    return z + 10;
  else
    return 2 * z;
}


/* Function: call_ret_complex_expr @ 0x1024 */
int __cdecl call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x102C */
int __fastcall ret_multi_branch(int op)
{
  if ( (unsigned int)op >= 3 )
    return -1;
  else
    return 10 * op + 10;
}


/* Function: call_ret_multi_branch @ 0x1044 */
int __cdecl call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x104C */
void __fastcall ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x1058 */
int __cdecl call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x1060 */
void __cdecl test_return_values()
{
  __int64 i; // x8
  _DWORD v1[16]; // [xsp+0h] [xbp-40h]

  puts(asc_1500);
  printf(aRetL101D, 42);
  printf(aRetL102D, 20);
  printf(aRetL103D, 7);
  for ( i = 0; i != 16; ++i )
    v1[i] = i + 100;
  printf(aRetL104D, (unsigned int)(v1[15] + v1[0]));
  printf(aRetL201D, 10);
  printf(aRetL202D, (unsigned int)ret_opaque_handle_handle1);
  printf(aRetL301D, 40);
  printf(aRetL302D, 60);
  printf(aRetL303D, 21);
}


/* Function: main @ 0x113C */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x115C */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x130B0 */

/* FAILED to decompile: __libc_start_main @ 0x130B8 */

/* FAILED to decompile: __cxa_finalize @ 0x130C0 */

/* FAILED to decompile: abort @ 0x130C8 */

/* FAILED to decompile: puts @ 0x130D0 */

/* FAILED to decompile: printf @ 0x130D8 */

/* FAILED to decompile: __gmon_start__ @ 0x130E8 */

/* Total functions decompiled: 79, failed: 7 */
