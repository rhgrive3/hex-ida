/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x730 */
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


/* Function: cdecl_func @ 0x914 */
int __cdecl cdecl_func(int a, int b)
{
  return a + b;
}


/* Function: call_cdecl @ 0x934 */
int __cdecl call_cdecl()
{
  return cdecl_func(5, 10);
}


/* Function: stdcall_func @ 0x950 */
int __cdecl stdcall_func(int a, int b)
{
  return a * b;
}


/* Function: call_stdcall @ 0x970 */
int __cdecl call_stdcall()
{
  return stdcall_func(5, 10);
}


/* Function: fastcall_func @ 0x98C */
int __cdecl fastcall_func(int a, int b, int c)
{
  return a + b + c;
}


/* Function: call_fastcall @ 0x9B8 */
int __cdecl call_fastcall()
{
  return fastcall_func(1, 2, 3);
}


/* Function: call_thiscall @ 0x9D8 */
int __cdecl call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x9E0 */
int __cdecl arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_arm_aapcs @ 0xA24 */
int __cdecl call_arm_aapcs()
{
  return arm_aapcs_func(1, 2, 3, 4, 5);
}


/* Function: mips_func @ 0xA4C */
int __cdecl mips_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_mips @ 0xA84 */
int __cdecl call_mips()
{
  return mips_func(10, 20, 30, 40);
}


/* Function: amd64_sysv_func @ 0xAA8 */
int __cdecl amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return a + b + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0xAF8 */
int __cdecl call_amd64_sysv()
{
  return amd64_sysv_func(1, 2, 3, 4, 5, 6);
}


/* Function: ms_x64_func @ 0xB24 */
int __cdecl ms_x64_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_ms_x64 @ 0xB68 */
int __cdecl call_ms_x64()
{
  return ms_x64_func(1, 2, 3, 4, 5);
}


/* Function: vectorcall_func @ 0xB90 */
int __cdecl vectorcall_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_vectorcall @ 0xBC8 */
int __cdecl call_vectorcall()
{
  return vectorcall_func(1, 2, 3, 4);
}


/* Function: mixed_conventions_test @ 0xBEC */
int __cdecl mixed_conventions_test()
{
  int sum; // [xsp+1Ch] [xbp+1Ch]
  int suma; // [xsp+1Ch] [xbp+1Ch]

  sum = cdecl_func(1, 2);
  suma = sum + stdcall_func(3, 4);
  return suma + fastcall_func(5, 6, 7);
}


/* Function: varargs_func @ 0xC5C */
int varargs_func(int count, ...)
{
  __int64 v1; // x1
  __int64 v2; // x2
  __int64 v3; // x3
  __int64 v4; // x4
  __int64 v5; // x5
  __int64 v6; // x6
  __int64 v7; // x7
  __int128 v8; // q0
  __int128 v9; // q1
  __int128 v10; // q2
  __int128 v11; // q3
  __int128 v12; // q4
  __int128 v13; // q5
  __int128 v14; // q6
  __int128 v15; // q7
  int v16; // w1
  char *v17; // x0
  int sum; // [xsp+20h] [xbp+20h]
  int i; // [xsp+24h] [xbp+24h]
  char *args; // [xsp+28h] [xbp+28h]
  int args_24; // [xsp+40h] [xbp+40h]
  __int128 vars0; // [xsp+50h] [xbp+50h]
  __int128 vars10; // [xsp+60h] [xbp+60h]
  __int128 vars20; // [xsp+70h] [xbp+70h]
  __int128 vars30; // [xsp+80h] [xbp+80h]
  __int128 vars40; // [xsp+90h] [xbp+90h]
  __int128 vars50; // [xsp+A0h] [xbp+A0h]
  __int128 vars60; // [xsp+B0h] [xbp+B0h]
  __int128 vars70; // [xsp+C0h] [xbp+C0h]
  __int64 vars88; // [xsp+D8h] [xbp+D8h]
  __int64 vars90; // [xsp+E0h] [xbp+E0h]
  __int64 vars98; // [xsp+E8h] [xbp+E8h]
  __int64 varsA0; // [xsp+F0h] [xbp+F0h]
  __int64 varsA8; // [xsp+F8h] [xbp+F8h]
  __int64 varsB0; // [xsp+100h] [xbp+100h]
  __int64 varsB8; // [xsp+108h] [xbp+108h]
  char v39; // [xsp+110h] [xbp+110h] BYREF

  vars88 = v1;
  vars90 = v2;
  vars98 = v3;
  varsA0 = v4;
  varsA8 = v5;
  varsB0 = v6;
  varsB8 = v7;
  vars0 = v8;
  vars10 = v9;
  vars20 = v10;
  vars30 = v11;
  vars40 = v12;
  vars50 = v13;
  vars60 = v14;
  vars70 = v15;
  sum = 0;
  args = &v39;
  args_24 = -56;
  for ( i = 0; i < count; ++i )
  {
    v16 = args_24;
    v17 = args;
    if ( args_24 < 0 )
    {
      args_24 += 8;
      if ( v16 + 8 <= 0 )
        v17 = &v39 + v16;
      else
        args = (char *)((unsigned __int64)(args + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    else
    {
      args = (char *)((unsigned __int64)(args + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    sum += *(_DWORD *)v17;
  }
  return sum;
}


/* Function: func_no_args @ 0xD9C */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xDA4 */
int __cdecl func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return a + b + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0xE0C */
int __cdecl func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v4; // w0

  if ( s )
    v4 = strlen(s);
  else
    v4 = 0;
  return (int)((double)(x + v4) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xE74 */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  int i; // [xsp+14h] [xbp-Ch]
  __int64 sum; // [xsp+18h] [xbp-8h]

  sum = 0;
  for ( i = 0; i <= 15; ++i )
    sum += s->data[i];
  return sum;
}


/* Function: func_struct_byptr @ 0xEC0 */
int __cdecl func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->x * p->y;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xEF8 */
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
  LargeStruct v10; // [xsp+10h] [xbp+10h] BYREF
  int i; // [xsp+9Ch] [xbp+9Ch]
  int sum; // [xsp+A0h] [xbp+A0h]
  int no_args; // [xsp+A4h] [xbp+A4h]
  int many; // [xsp+A8h] [xbp+A8h]
  int mixed; // [xsp+ACh] [xbp+ACh]
  int struct_val; // [xsp+B0h] [xbp+B0h]
  int struct_ptr; // [xsp+B4h] [xbp+B4h]
  SmallStruct s; // [xsp+B8h] [xbp+B8h] BYREF
  char *test_str; // [xsp+C0h] [xbp+C0h]
  LargeStruct large; // [xsp+C8h] [xbp+C8h]

  puts(asc_1FB0);
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
  sum = varargs_func(5, 1, 2, 3, 4, 5);
  printf(aCallL206, (unsigned int)sum);
  no_args = func_no_args();
  printf(aCallL207, (unsigned int)no_args);
  many = func_many_args(1, 2, 3, 4, 5, 6, 7, 8);
  printf(aCallL208, (unsigned int)many);
  test_str = "test";
  mixed = func_mixed_args(10, "test", 3.14, 100);
  printf(aCallL209, (unsigned int)mixed);
  for ( i = 0; i <= 15; ++i )
    large.data[i] = i + 1;
  v10 = large;
  struct_val = func_struct_byval(&v10);
  printf(aCallL210, (unsigned int)struct_val);
  s.x = 5;
  s.y = 10;
  struct_ptr = func_struct_byptr(&s);
  printf(aCallL211, (unsigned int)struct_ptr);
}


/* Function: param_by_value_int @ 0x1178 */
int __cdecl param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0x1198 */
int __cdecl call_by_value_int()
{
  return param_by_value_int(5) + 5;
}


/* Function: param_by_value_ptr @ 0x11C8 */
int __cdecl param_by_value_ptr(int *p)
{
  *p *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0x1200 */
int __cdecl call_by_value_ptr()
{
  int val; // [xsp+18h] [xbp+18h] BYREF
  int result; // [xsp+1Ch] [xbp+1Ch]
  int *ptr; // [xsp+20h] [xbp+20h]

  val = 5;
  ptr = &val;
  result = param_by_value_ptr(&val);
  return val + result;
}


/* Function: param_array_decay @ 0x1274 */
int __cdecl param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0x128C */
int __cdecl call_array_decay()
{
  int array[10]; // [xsp+10h] [xbp+10h] BYREF

  memset(array, 0, sizeof(array));
  return param_array_decay(array, 10);
}


/* Function: param_string @ 0x12F0 */
int __cdecl param_string(const char *str)
{
  return *(unsigned __int8 *)str + *((unsigned __int8 *)str + 1);
}


/* Function: call_string_param @ 0x131C */
int __cdecl call_string_param()
{
  return param_string("Hello");
}


/* Function: param_ptr_array @ 0x1338 */
int __cdecl param_ptr_array(char **arr, int n)
{
  int sum; // [xsp+14h] [xbp-8h]
  int i; // [xsp+18h] [xbp-4h]

  sum = 0;
  for ( i = 0; i < n; ++i )
    sum += (unsigned __int8)*arr[i];
  return sum;
}


/* Function: call_ptr_array @ 0x13A0 */
int __cdecl call_ptr_array()
{
  char *strs[3]; // [xsp+10h] [xbp+10h] BYREF

  strs[0] = off_14010[0];
  strs[1] = off_14018[0];
  strs[2] = off_14020;
  return param_ptr_array(strs, 3);
}


/* Function: param_varargs @ 0x1418 */
int param_varargs(int count, ...)
{
  __int64 v1; // x1
  __int64 v2; // x2
  __int64 v3; // x3
  __int64 v4; // x4
  __int64 v5; // x5
  __int64 v6; // x6
  __int64 v7; // x7
  __int128 v8; // q0
  __int128 v9; // q1
  __int128 v10; // q2
  __int128 v11; // q3
  __int128 v12; // q4
  __int128 v13; // q5
  __int128 v14; // q6
  __int128 v15; // q7
  int v16; // w1
  char *v17; // x0
  int sum; // [xsp+20h] [xbp+20h]
  int i; // [xsp+24h] [xbp+24h]
  char *args; // [xsp+28h] [xbp+28h]
  int args_24; // [xsp+40h] [xbp+40h]
  __int128 vars0; // [xsp+50h] [xbp+50h]
  __int128 vars10; // [xsp+60h] [xbp+60h]
  __int128 vars20; // [xsp+70h] [xbp+70h]
  __int128 vars30; // [xsp+80h] [xbp+80h]
  __int128 vars40; // [xsp+90h] [xbp+90h]
  __int128 vars50; // [xsp+A0h] [xbp+A0h]
  __int128 vars60; // [xsp+B0h] [xbp+B0h]
  __int128 vars70; // [xsp+C0h] [xbp+C0h]
  __int64 vars88; // [xsp+D8h] [xbp+D8h]
  __int64 vars90; // [xsp+E0h] [xbp+E0h]
  __int64 vars98; // [xsp+E8h] [xbp+E8h]
  __int64 varsA0; // [xsp+F0h] [xbp+F0h]
  __int64 varsA8; // [xsp+F8h] [xbp+F8h]
  __int64 varsB0; // [xsp+100h] [xbp+100h]
  __int64 varsB8; // [xsp+108h] [xbp+108h]
  char v39; // [xsp+110h] [xbp+110h] BYREF

  vars88 = v1;
  vars90 = v2;
  vars98 = v3;
  varsA0 = v4;
  varsA8 = v5;
  varsB0 = v6;
  varsB8 = v7;
  vars0 = v8;
  vars10 = v9;
  vars20 = v10;
  vars30 = v11;
  vars40 = v12;
  vars50 = v13;
  vars60 = v14;
  vars70 = v15;
  args = &v39;
  args_24 = -56;
  sum = 0;
  for ( i = 0; i < count; ++i )
  {
    v16 = args_24;
    v17 = args;
    if ( args_24 < 0 )
    {
      args_24 += 8;
      if ( v16 + 8 <= 0 )
        v17 = &v39 + v16;
      else
        args = (char *)((unsigned __int64)(args + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    else
    {
      args = (char *)((unsigned __int64)(args + 11) & 0xFFFFFFFFFFFFFFF8LL);
    }
    sum += *(_DWORD *)v17;
  }
  return sum;
}


/* Function: call_varargs_param @ 0x1558 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0x1580 */
int __cdecl param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: callback_func @ 0x15A8 */
int __cdecl callback_func(int x)
{
  return 2 * x;
}


/* Function: call_func_ptr_param @ 0x15C0 */
int __cdecl call_func_ptr_param()
{
  return param_func_ptr((int (*)(int))callback_func, 5);
}


/* Function: param_double_ptr @ 0x15E0 */
int __cdecl param_double_ptr(int **pp, int new_val)
{
  if ( !pp || !*pp )
    return -1;
  **pp = new_val;
  *pp = 0;
  return 1;
}


/* Function: call_double_ptr @ 0x1634 */
int __cdecl call_double_ptr()
{
  int val; // [xsp+18h] [xbp+18h] BYREF
  int *ptr; // [xsp+20h] [xbp+20h] BYREF

  val = 10;
  ptr = &val;
  param_double_ptr(&ptr, 20);
  return (ptr == 0) + val;
}


/* Function: param_complex_cast @ 0x16BC */
int __cdecl param_complex_cast(void *p, int type)
{
  if ( !type )
    return *(_DWORD *)p;
  if ( type == 1 )
    return *(_DWORD *)p + *((_DWORD *)p + 1);
  return -1;
}


/* Function: call_complex_cast @ 0x1730 */
int __cdecl call_complex_cast()
{
  int val; // [xsp+1Ch] [xbp+1Ch] BYREF
  TestIntPair pair; // [xsp+20h] [xbp+20h] BYREF

  val = 305419896;
  pair.a = 100;
  pair.b = 200;
  param_complex_cast(&pair, 1);
  return param_complex_cast(&val, 0);
}


/* Function: param_struct_byval @ 0x17B0 */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[0] + s->data[15]);
}


/* Function: call_struct_byval @ 0x17CC */
int __cdecl call_struct_byval()
{
  BigStruct v1; // [xsp+10h] [xbp+10h] BYREF
  int i; // [xsp+54h] [xbp+54h]
  BigStruct s; // [xsp+58h] [xbp+58h]

  for ( i = 0; i <= 15; ++i )
    s.data[i] = i;
  v1 = s;
  return param_struct_byval(&v1);
}


/* Function: param_order_dep @ 0x186C */
int __cdecl param_order_dep(int a, int b)
{
  return a + b;
}


/* Function: call_order_dep @ 0x188C */
int __cdecl call_order_dep()
{
  return param_order_dep(2, 2);
}


/* Function: test_parameter_passing @ 0x18C4 */
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

  puts(asc_21A0);
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


/* Function: ret_basic_type @ 0x19C0 */
int __cdecl ret_basic_type(int x)
{
  return 2 * x;
}


/* Function: call_ret_basic @ 0x19D8 */
int __cdecl call_ret_basic()
{
  return ret_basic_type(21);
}


/* Function: ret_pointer @ 0x1A00 */
int *__cdecl ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0x1A18 */
int __cdecl call_ret_pointer()
{
  int arr[4]; // [xsp+18h] [xbp+18h] BYREF

  *(_QWORD *)arr = *(_QWORD *)"\n";
  arr[2] = 30;
  return *ret_pointer(arr);
}


/* Function: ret_small_struct @ 0x1A94 */
SmallPoint __cdecl ret_small_struct(int x, int y)
{
  return (SmallPoint)__PAIR64__(y, x);
}


/* Function: call_ret_small_struct @ 0x1ABC */
int __cdecl call_ret_small_struct()
{
  SmallPoint p; // [xsp+18h] [xbp+18h]

  p = ret_small_struct(3, 4);
  return p.x + p.y;
}


/* Function: ret_large_struct @ 0x1AE8 */
LargeData *__cdecl ret_large_struct(LargeData *__return_ptr retstr, int seed)
{
  __int128 v2; // q1
  __int128 v3; // q1
  int i; // [xsp+24h] [xbp+24h]
  LargeData d; // [xsp+28h] [xbp+28h]

  for ( i = 0; i <= 15; ++i )
    d.data[i] = seed + i;
  v2 = *(_OWORD *)&d.data[4];
  *(_OWORD *)retstr->data = *(_OWORD *)d.data;
  *(_OWORD *)&retstr->data[4] = v2;
  v3 = *(_OWORD *)&d.data[12];
  *(_OWORD *)&retstr->data[8] = *(_OWORD *)&d.data[8];
  *(_OWORD *)&retstr->data[12] = v3;
  return (LargeData *)&_stack_chk_guard;
}


/* Function: call_ret_large_struct @ 0x1B88 */
int __cdecl call_ret_large_struct()
{
  LargeData d; // [xsp+18h] [xbp+18h] BYREF

  ret_large_struct(&d, 100);
  return d.data[0] + d.data[15];
}


/* Function: func_a @ 0x1BF0 */
int __cdecl func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0x1C08 */
int __cdecl func_b(int x)
{
  return 2 * x;
}


/* Function: ret_func_ptr @ 0x1C20 */
func_ptr_t __cdecl ret_func_ptr(int selector)
{
  if ( selector )
    return (func_ptr_t)func_b;
  else
    return (func_ptr_t)func_a;
}


/* Function: call_ret_func_ptr @ 0x1C50 */
int __cdecl call_ret_func_ptr()
{
  func_ptr_t f; // [xsp+18h] [xbp+18h]

  f = ret_func_ptr(1);
  return f(5);
}


/* Function: ret_opaque_handle @ 0x1C78 */
void *__cdecl ret_opaque_handle(int type)
{
  if ( type )
    return &handle2_0;
  else
    return &handle1_1;
}


/* Function: call_ret_opaque @ 0x1CA8 */
int __cdecl call_ret_opaque()
{
  return *(_DWORD *)ret_opaque_handle(0);
}


/* Function: ret_complex_expr @ 0x1CCC */
int __cdecl ret_complex_expr(int x, int y, int z)
{
  if ( x <= y )
    return z + 10;
  else
    return 2 * z;
}


/* Function: call_ret_complex_expr @ 0x1D08 */
int __cdecl call_ret_complex_expr()
{
  int r1; // [xsp+18h] [xbp+18h]

  r1 = ret_complex_expr(5, 3, 10);
  return r1 + ret_complex_expr(3, 5, 10);
}


/* Function: ret_multi_branch @ 0x1D4C */
int __cdecl ret_multi_branch(int op)
{
  if ( op == 2 )
    return 30;
  if ( op > 2 )
    return -1;
  if ( !op )
    return 10;
  if ( op == 1 )
    return 20;
  else
    return -1;
}


/* Function: call_ret_multi_branch @ 0x1DAC */
int __cdecl call_ret_multi_branch()
{
  int sum; // [xsp+1Ch] [xbp+1Ch]
  int suma; // [xsp+1Ch] [xbp+1Ch]

  sum = ret_multi_branch(0);
  suma = sum + ret_multi_branch(1);
  return suma + ret_multi_branch(2);
}


/* Function: ret_void @ 0x1E0C */
void __cdecl ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x1E3C */
int __cdecl call_ret_void()
{
  int result; // [xsp+14h] [xbp+14h] BYREF

  ret_void(7, &result);
  return result;
}


/* Function: test_return_values @ 0x1E9C */
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

  puts(asc_22E0);
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


/* Function: main @ 0x1F70 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x1F90 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x14090 */

/* FAILED to decompile: __libc_start_main @ 0x14098 */

/* FAILED to decompile: __cxa_finalize @ 0x140A0 */

/* FAILED to decompile: __stack_chk_fail @ 0x140A8 */

/* FAILED to decompile: abort @ 0x140B8 */

/* FAILED to decompile: puts @ 0x140C0 */

/* FAILED to decompile: printf @ 0x140C8 */

/* FAILED to decompile: __gmon_start__ @ 0x140D8 */

/* Total functions decompiled: 80, failed: 8 */
