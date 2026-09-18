/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_clang_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x860 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_880 @ 0x880 */
void sub_880()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x940 */
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


/* Function: call_weak_fn @ 0x974 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x990 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x9C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xA00 */
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


/* Function: frame_dummy @ 0xA50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: sequential_ops @ 0xA54 */
int __cdecl sequential_ops(int a, int b, int c)
{
  return 2 * (a + b) - c;
}


/* Function: single_if @ 0xA9C */
int __cdecl single_if(int x)
{
  int v2; // [xsp+Ch] [xbp-4h]

  v2 = x;
  if ( x > 0 )
    return 2 * x;
  return v2;
}


/* Function: if_else @ 0xAD0 */
int __cdecl if_else(int x)
{
  return x > 0;
}


/* Function: nested_if_2 @ 0xB08 */
int __cdecl nested_if_2(int a, int b)
{
  if ( a <= 0 )
    return 0;
  if ( b <= 0 )
    return a;
  return a + b;
}


/* Function: nested_if_deep @ 0xB68 */
int __cdecl nested_if_deep(int a, int b, int c, int d, int e)
{
  if ( a <= 0 )
    return 0;
  if ( b <= 0 )
    return 1;
  if ( c <= 0 )
    return 2;
  if ( d <= 0 )
    return 3;
  if ( e <= 0 )
    return 4;
  return 5;
}


/* Function: if_elseif_chain @ 0xC20 */
int __cdecl if_elseif_chain(int x)
{
  switch ( x )
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


/* Function: if_elseif_long @ 0xC90 */
int __cdecl if_elseif_long(int x)
{
  switch ( x )
  {
    case 0:
      return 100;
    case 1:
      return 200;
    case 2:
      return 300;
    case 3:
      return 400;
    case 4:
      return 500;
  }
  return -1;
}


/* Function: switch_small @ 0xD38 */
int __cdecl switch_small(int op)
{
  int v2; // [xsp+1Ch] [xbp-4h]

  switch ( op )
  {
    case 0:
      v2 = 15;
      break;
    case 1:
      v2 = 5;
      break;
    case 2:
      v2 = 50;
      break;
    case 3:
      v2 = 2;
      break;
    default:
      v2 = -1;
      break;
  }
  return v2;
}


/* Function: switch_large @ 0xDE8 */
int __cdecl switch_large(int op)
{
  int v2; // [xsp+Ch] [xbp-4h]

  switch ( op )
  {
    case 0:
      v2 = 0;
      break;
    case 1:
      v2 = 10;
      break;
    case 2:
      v2 = 20;
      break;
    case 3:
      v2 = 30;
      break;
    case 4:
      v2 = 40;
      break;
    case 5:
      v2 = 50;
      break;
    case 6:
      v2 = 60;
      break;
    case 7:
      v2 = 70;
      break;
    case 8:
      v2 = 80;
      break;
    case 9:
      v2 = 90;
      break;
    default:
      v2 = -1;
      break;
  }
  return v2;
}


/* Function: switch_default @ 0xEAC */
int __cdecl switch_default(int op)
{
  switch ( op )
  {
    case 1:
      return 100;
    case 2:
      return 200;
    case 3:
      return 300;
  }
  return 0;
}


/* Function: switch_fallthrough @ 0xF20 */
int __cdecl switch_fallthrough(int op)
{
  int v2; // [xsp+8h] [xbp-8h]

  v2 = 0;
  if ( op != 1 )
  {
    if ( op != 2 )
    {
      if ( op != 3 )
        return -1;
      v2 = 12;
    }
    v2 += 2 * op;
  }
  return v2 + op;
}


/* Function: loop_for_fixed @ 0xFB4 */
int __cdecl loop_for_fixed(int n)
{
  int i; // [xsp+4h] [xbp-Ch]
  int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < n; ++i )
    v3 += i;
  return v3;
}


/* Function: loop_while @ 0x100C */
int __cdecl loop_while(int x)
{
  int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  while ( x )
  {
    x /= 10;
    ++v3;
  }
  if ( v3 <= 0 )
    return 1;
  else
    return v3;
}


/* Function: loop_dowhile @ 0x107C */
int __cdecl loop_dowhile(int x)
{
  int v2; // [xsp+8h] [xbp-8h]

  v2 = 0;
  do
  {
    x /= 10;
    ++v2;
  }
  while ( x );
  return v2;
}


/* Function: loop_nested @ 0x10C4 */
int __cdecl loop_nested(int m, int n)
{
  int j; // [xsp+Ch] [xbp-14h]
  int i; // [xsp+10h] [xbp-10h]
  int v5; // [xsp+14h] [xbp-Ch]

  v5 = 0;
  for ( i = 0; i < m; ++i )
  {
    for ( j = 0; j < n; ++j )
      ++v5;
  }
  return v5;
}


/* Function: loop_break @ 0x114C */
int __cdecl loop_break(int target)
{
  int i; // [xsp+8h] [xbp-28h]
  __int128 v3; // [xsp+10h] [xbp-20h]
  int v4; // [xsp+20h] [xbp-10h]
  int v5; // [xsp+28h] [xbp-8h]

  v5 = target;
  v3 = xmmword_2B04;
  v4 = 50;
  for ( i = 0; i < 5; ++i )
  {
    if ( *((_DWORD *)&v3 + i) == v5 )
      return i;
  }
  return -1;
}


/* Function: loop_continue @ 0x11E4 */
int __cdecl loop_continue(int n)
{
  int i; // [xsp+4h] [xbp-Ch]
  int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 1; i <= n; ++i )
  {
    if ( i % 2 )
      v3 += i;
  }
  return v3;
}


/* Function: goto_forward @ 0x1260 */
int __cdecl goto_forward(int x)
{
  int v2; // [xsp+8h] [xbp-8h]

  if ( x <= 0 )
    v2 = x;
  else
    v2 = x * x;
  return 2 * v2;
}


/* Function: goto_backward @ 0x12B4 */
int __cdecl goto_backward(int x)
{
  int i; // [xsp+0h] [xbp-10h]
  int v3; // [xsp+4h] [xbp-Ch]

  if ( x <= 0 )
    return 1;
  v3 = 1;
  for ( i = 1; i <= x; ++i )
    v3 *= i;
  return v3;
}


/* Function: ternary_op @ 0x1338 */
int __cdecl ternary_op(int a, int b)
{
  if ( a <= b )
    return b;
  else
    return a;
}


/* Function: test_control_flow_l1 @ 0x137C */
void __cdecl test_control_flow_l1()
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
  int v11; // w0
  int v12; // w0
  int v13; // w0
  int v14; // w0
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int v18; // w0
  int v19; // w0
  int v20; // w0
  int v21; // w0
  int v22; // w0
  int v23; // w0
  int v24; // w0
  int v25; // w0
  int v26; // w0

  printf(asc_2B5C);
  v0 = sequential_ops(5, 7, 3);
  printf("CF-L1-01 (sequential_ops): %d\n", v0);
  v1 = single_if(10);
  printf("CF-L1-02 (single_if): %d\n", v1);
  v2 = single_if(-5);
  printf("CF-L1-02 (single_if): %d\n", v2);
  v3 = if_else(5);
  printf("CF-L1-03 (if_else): %d\n", v3);
  v4 = if_else(-3);
  printf("CF-L1-03 (if_else): %d\n", v4);
  v5 = nested_if_2(10, 5);
  printf("CF-L1-04 (nested_if_2): %d\n", v5);
  v6 = nested_if_2(10, -5);
  printf("CF-L1-04 (nested_if_2): %d\n", v6);
  v7 = nested_if_2(-10, 5);
  printf("CF-L1-04 (nested_if_2): %d\n", v7);
  v8 = nested_if_deep(1, 1, 1, 1, 1);
  printf("CF-L1-05 (nested_if_deep): %d\n", v8);
  v9 = if_elseif_chain(1);
  printf("CF-L1-06 (if_elseif_chain): %d\n", v9);
  v10 = if_elseif_long(3);
  printf("CF-L1-07 (if_elseif_long): %d\n", v10);
  v11 = switch_small(2);
  printf("CF-L1-08 (switch_small): %d\n", v11);
  v12 = switch_large(7);
  printf("CF-L1-09 (switch_large): %d\n", v12);
  v13 = switch_default(5);
  printf("CF-L1-10 (switch_default): %d\n", v13);
  v14 = switch_fallthrough(3);
  printf("CF-L1-11 (switch_fallthrough): %d\n", v14);
  v15 = loop_for_fixed(10);
  printf("CF-L1-12 (loop_for_fixed): %d\n", v15);
  v16 = loop_while(12345);
  printf("CF-L1-13 (loop_while): %d\n", v16);
  v17 = loop_dowhile(9876);
  printf("CF-L1-14 (loop_dowhile): %d\n", v17);
  v18 = loop_nested(3, 4);
  printf("CF-L1-15 (loop_nested): %d\n", v18);
  v19 = loop_break(30);
  printf("CF-L1-16 (loop_break): %d\n", v19);
  v20 = loop_break(99);
  printf("CF-L1-16 (loop_break): %d\n", v20);
  v21 = loop_continue(10);
  printf("CF-L1-17 (loop_continue): %d\n", v21);
  v22 = goto_forward(5);
  printf("CF-L1-18 (goto_forward): %d\n", v22);
  v23 = goto_forward(-3);
  printf("CF-L1-18 (goto_forward): %d\n", v23);
  v24 = goto_backward(5);
  printf("CF-L1-19 (goto_backward): %d\n", v24);
  v25 = ternary_op(10, 5);
  printf("CF-L1-20 (ternary_op): %d\n", v25);
  v26 = ternary_op(3, 8);
  printf("CF-L1-20 (ternary_op): %d\n", v26);
}


/* Function: loop_multi_exit @ 0x1670 */
int __cdecl loop_multi_exit(int target)
{
  int j; // [xsp+0h] [xbp-40h]
  int i; // [xsp+4h] [xbp-3Ch]
  _OWORD dest[3]; // [xsp+8h] [xbp-38h] BYREF
  int targeta; // [xsp+38h] [xbp-8h]

  targeta = target;
  memcpy(dest, &unk_2B18, sizeof(dest));
  for ( i = 0; i < 3; ++i )
  {
    for ( j = 0; j < 4; ++j )
    {
      if ( *((_DWORD *)&dest[i] + j) == targeta )
        return 10 * i + j;
    }
  }
  return -1;
}


/* Function: infinite_loop @ 0x1748 */
int __cdecl infinite_loop(volatile int *flag)
{
  int v2; // [xsp+4h] [xbp-Ch]

  v2 = 0;
  while ( *flag != 1 )
  {
    if ( ++v2 > 1000 )
    {
      *flag = 1;
      return v2;
    }
  }
  return v2;
}


/* Function: multi_return @ 0x17AC */
int __cdecl multi_return(int x)
{
  if ( x < 0 )
    return -1;
  if ( 2 * x > 100 )
    return -2;
  if ( x % 2 )
    return x + 1;
  return 2 * x;
}


/* Function: conditional_return @ 0x183C */
int __cdecl conditional_return(int x)
{
  if ( x > 0 )
    return 2 * x;
  if ( x >= 0 )
    return 0;
  else
    return -x;
}


/* Function: duffs_device @ 0x18AC */
int __cdecl duffs_device(int *dst, int *src, int n)
{
  int *v3; // x8
  int *v4; // x9
  int *v5; // x8
  int *v6; // x9
  int *v7; // x8
  int *v8; // x9
  int *v9; // x8
  int *v10; // x9
  int *v11; // x8
  int *v12; // x9
  int *v13; // x8
  int *v14; // x9
  int *v15; // x8
  int *v16; // x9
  int *v17; // x8
  int *v18; // x9
  int v20; // [xsp+10h] [xbp-20h]

  if ( n <= 0 )
    return -1;
  v20 = (n + 7) / 8;
  switch ( n % 8 )
  {
    case 0:
      goto LABEL_4;
    case 1:
      goto LABEL_11;
    case 2:
      goto LABEL_10;
    case 3:
      goto LABEL_9;
    case 4:
      goto LABEL_8;
    case 5:
      goto LABEL_7;
    case 6:
      goto LABEL_6;
    case 7:
      while ( 1 )
      {
        v5 = src++;
        v6 = dst++;
        *v6 = *v5;
LABEL_6:
        v7 = src++;
        v8 = dst++;
        *v8 = *v7;
LABEL_7:
        v9 = src++;
        v10 = dst++;
        *v10 = *v9;
LABEL_8:
        v11 = src++;
        v12 = dst++;
        *v12 = *v11;
LABEL_9:
        v13 = src++;
        v14 = dst++;
        *v14 = *v13;
LABEL_10:
        v15 = src++;
        v16 = dst++;
        *v16 = *v15;
LABEL_11:
        v17 = src++;
        v18 = dst++;
        *v18 = *v17;
        if ( --v20 <= 0 )
          break;
LABEL_4:
        v3 = src++;
        v4 = dst++;
        *v4 = *v3;
      }
      break;
    default:
      return n;
  }
  return n;
}


/* Function: loop_complex_cond @ 0x1A80 */
int __cdecl loop_complex_cond(int x)
{
  bool v2; // [xsp+Ch] [xbp-14h]
  int i; // [xsp+10h] [xbp-10h]
  int v5; // [xsp+18h] [xbp-8h]

  v5 = 0;
  for ( i = 0; ; ++i )
  {
    v2 = 0;
    if ( v5 < x )
    {
      v2 = 0;
      if ( i < 10 )
        v2 = x > 0;
    }
    if ( !v2 )
      break;
    v5 += 2;
    --x;
  }
  return v5 + x + i;
}


/* Function: loop_modify_var @ 0x1B34 */
int __cdecl loop_modify_var(int n)
{
  int i; // [xsp+4h] [xbp-Ch]
  int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < n; ++i )
  {
    v3 += i;
    if ( i > 5 )
      i += 2;
  }
  return v3;
}


/* Function: loop_external_state @ 0x1BAC */
int __cdecl loop_external_state(volatile int *flag)
{
  int i; // [xsp+4h] [xbp-Ch]

  for ( i = 0; i <= 100; ++i )
  {
    if ( *flag )
      break;
  }
  return i;
}


/* Function: recursion_factorial @ 0x1BFC */
__int64 __fastcall recursion_factorial(int n)
{
  if ( n > 1 )
    return (unsigned int)(n * recursion_factorial(n - 1));
  else
    return 1;
}


/* Function: tail_recursion @ 0x1C5C */
__int64 __fastcall tail_recursion(int n, unsigned int acc)
{
  if ( n > 1 )
    return (unsigned int)tail_recursion(n - 1, n * acc);
  else
    return acc;
}


/* Function: indirect_recursion_a @ 0x1CBC */
__int64 __fastcall indirect_recursion_a(int n, int depth)
{
  if ( depth > 0 )
  {
    if ( n % 2 )
      return (unsigned int)indirect_recursion_b(3 * n + 1, depth - 1);
    else
      return (unsigned int)indirect_recursion_b(n / 2, depth - 1);
  }
  else
  {
    return (unsigned int)n;
  }
}


/* Function: indirect_recursion_b @ 0x1D5C */
__int64 __fastcall indirect_recursion_b(unsigned int n, int depth)
{
  if ( depth > 0 )
    return (unsigned int)indirect_recursion_a(n + 1, depth - 1);
  else
    return n;
}


/* Function: call_func_ptr @ 0x1DB8 */
__int64 __fastcall call_func_ptr(int (*f)(int), unsigned int x)
{
  return ((__int64 (__fastcall *)(_QWORD))f)(x);
}


/* Function: call_func_ptr_array @ 0x1DE4 */
int __cdecl call_func_ptr_array(int idx, int x)
{
  __int128 v3; // [xsp+0h] [xbp-30h]
  __int64 (__fastcall *v4)(int); // [xsp+10h] [xbp-20h]
  int xa; // [xsp+24h] [xbp-Ch]
  int idxa; // [xsp+28h] [xbp-8h]

  idxa = idx;
  xa = x;
  v3 = *(_OWORD *)off_13D30;
  v4 = recursion_factorial;
  if ( idx < 0 || idxa >= 3 )
    return -1;
  else
    return (*((__int64 (__fastcall **)(_QWORD))&v3 + idxa))((unsigned int)xa);
}


/* Function: double_value @ 0x1E64 */
int __cdecl double_value(int x)
{
  return 2 * x;
}


/* Function: triple_value @ 0x1E7C */
int __cdecl triple_value(int x)
{
  return 3 * x;
}


/* Function: call_virtual_func @ 0x1E98 */
int __cdecl call_virtual_func(void *obj, int x)
{
  return 2 * x;
}


/* Function: process_with_callback @ 0x1EB4 */
__int64 __fastcall process_with_callback(int *arr, int n, int (*cb)(int))
{
  int i; // [xsp+0h] [xbp-20h]
  unsigned int v5; // [xsp+4h] [xbp-1Ch]

  v5 = 0;
  for ( i = 0; i < n; ++i )
    v5 += cb(arr[i]);
  return v5;
}


/* Function: test_control_flow_l2 @ 0x1F30 */
void __cdecl test_control_flow_l2()
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
  int v11; // w0
  int v12; // w0
  int v13; // w0
  int v14; // w0
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int arr[4]; // [xsp+40h] [xbp-70h] BYREF
  int v19; // [xsp+50h] [xbp-60h]
  int ext_flag; // [xsp+5Ch] [xbp-54h] BYREF
  int dst[8]; // [xsp+60h] [xbp-50h] BYREF
  int src[8]; // [xsp+80h] [xbp-30h] BYREF
  int flag; // [xsp+ACh] [xbp-4h] BYREF

  printf(asc_2DCA);
  v0 = loop_multi_exit(7);
  printf("CF-L2-01 (loop_multi_exit): %d\n", v0);
  flag = 0;
  v1 = infinite_loop(&flag);
  printf("CF-L2-02 (infinite_loop): %d\n", v1);
  v2 = multi_return(-5);
  printf("CF-L2-03 (multi_return): %d\n", v2);
  v3 = multi_return(100);
  printf("CF-L2-03 (multi_return): %d\n", v3);
  v4 = multi_return(3);
  printf("CF-L2-03 (multi_return): %d\n", v4);
  v5 = conditional_return(5);
  printf("CF-L2-04 (conditional_return): %d\n", v5);
  v6 = conditional_return(-5);
  printf("CF-L2-04 (conditional_return): %d\n", v6);
  *(_OWORD *)src = xmmword_3120;
  *(_OWORD *)&src[4] = xmmword_3130;
  memset(dst, 0, sizeof(dst));
  v7 = duffs_device(dst, src, 8);
  printf("CF-L2-05 (duffs_device): %d\n", v7);
  v8 = loop_complex_cond(10);
  printf("CF-L2-06 (loop_complex_cond): %d\n", v8);
  v9 = loop_modify_var(10);
  printf("CF-L2-07 (loop_modify_var): %d\n", v9);
  ext_flag = 0;
  v10 = loop_external_state(&ext_flag);
  printf("CF-L2-08 (loop_external_state): %d\n", v10);
  v11 = recursion_factorial(5);
  printf("CF-L2-09 (recursion_factorial): %d\n", v11);
  v12 = tail_recursion(5, 1u);
  printf("CF-L2-10 (tail_recursion): %d\n", v12);
  v13 = indirect_recursion_a(10, 3);
  printf("CF-L2-11 (indirect_recursion): %d\n", v13);
  v14 = call_func_ptr((int (*)(int))double_value, 5u);
  printf("CF-L2-12 (call_func_ptr): %d\n", v14);
  v15 = call_func_ptr_array(0, 5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v15);
  v16 = call_func_ptr_array(2, 5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v16);
  *(_OWORD *)arr = xmmword_2B48;
  v19 = 5;
  v17 = process_with_callback(arr, 5, (int (*)(int))double_value);
  printf("CF-L2-15 (process_with_callback): %d\n", v17);
}


/* Function: non_local_jump @ 0x2188 */
__int64 __fastcall non_local_jump(int x)
{
  if ( _setjmp(&jump_buffer) )
  {
    return (unsigned int)-1;
  }
  else
  {
    if ( x < 0 )
      longjmp(&jump_buffer, 1);
    if ( x > 100 )
      longjmp(&jump_buffer, 2);
    return (unsigned int)(2 * x);
  }
}


/* Function: cpp_exception @ 0x2218 */
int __cdecl cpp_exception(int x)
{
  if ( x < 0 )
    return -1;
  if ( x <= 100 )
    return 2 * x;
  return -2;
}


/* Function: large_jump_table @ 0x2274 */
int __cdecl large_jump_table(int op, int a, int b)
{
  _QWORD v4[10]; // [xsp+0h] [xbp-60h] BYREF
  int ba; // [xsp+50h] [xbp-10h]
  int aa; // [xsp+54h] [xbp-Ch]
  int opa; // [xsp+58h] [xbp-8h]

  opa = op;
  aa = a;
  ba = b;
  memcpy(v4, off_13D48, sizeof(v4));
  if ( opa < 0 || opa >= 10 )
    return -1;
  else
    return ((__int64 (__fastcall *)(_QWORD, _QWORD))v4[opa])((unsigned int)aa, (unsigned int)ba);
}


/* Function: op_add @ 0x22F8 */
int __cdecl op_add(int a, int b)
{
  return a + b;
}


/* Function: op_sub @ 0x2318 */
int __cdecl op_sub(int a, int b)
{
  return a - b;
}


/* Function: op_mul @ 0x2338 */
int __cdecl op_mul(int a, int b)
{
  return a * b;
}


/* Function: op_div @ 0x2358 */
int __cdecl op_div(int a, int b)
{
  if ( b )
    return a / b;
  else
    return 0;
}


/* Function: op_mod @ 0x239C */
int __cdecl op_mod(int a, int b)
{
  if ( b )
    return a % b;
  else
    return 0;
}


/* Function: op_and @ 0x23E8 */
int __cdecl op_and(int a, int b)
{
  return a & b;
}


/* Function: op_or @ 0x2408 */
int __cdecl op_or(int a, int b)
{
  return a | b;
}


/* Function: op_xor @ 0x2428 */
int __cdecl op_xor(int a, int b)
{
  return a ^ b;
}


/* Function: op_shl @ 0x2448 */
int __cdecl op_shl(int a, int b)
{
  return a << b;
}


/* Function: op_shr @ 0x2468 */
int __cdecl op_shr(int a, int b)
{
  return a >> b;
}


/* Function: conditional_func_ptr @ 0x2488 */
__int64 __fastcall conditional_func_ptr(int mode, int x)
{
  if ( !mode )
    return ((__int64 (__fastcall *)(int))double_value)(x);
  if ( mode == 1 )
    return ((__int64 (__fastcall *)(int))triple_value)(x);
  return recursion_factorial(x);
}


/* Function: state_machine @ 0x2504 */
int __cdecl state_machine(int event, int state)
{
  int v3; // [xsp+1Ch] [xbp-4h]

  switch ( state )
  {
    case 0:
      v3 = event == 1;
      break;
    case 1:
      if ( event == 2 )
      {
        v3 = 2;
      }
      else if ( event == 99 )
      {
        v3 = 3;
      }
      else
      {
        v3 = 1;
      }
      break;
    case 2:
      v3 = 2;
      break;
    case 3:
      if ( event )
        v3 = 3;
      else
        v3 = 0;
      break;
    default:
      v3 = 3;
      break;
  }
  return v3;
}


/* Function: fsm_func_table @ 0x25EC */
int __cdecl fsm_func_table(int event, int state)
{
  _OWORD v3[2]; // [xsp+0h] [xbp-30h]
  int statea; // [xsp+24h] [xbp-Ch]
  int eventa; // [xsp+28h] [xbp-8h]

  eventa = event;
  statea = state;
  v3[0] = *(_OWORD *)off_13D98;
  v3[1] = *(_OWORD *)off_13DA8;
  if ( state < 0 || statea >= 4 )
    return 3;
  else
    return (*((__int64 (__fastcall **)(_QWORD))v3 + statea))((unsigned int)eventa);
}


/* Function: state_idle @ 0x266C */
int __cdecl state_idle(int event)
{
  return event == 1;
}


/* Function: state_processing @ 0x268C */
int __cdecl state_processing(int event)
{
  if ( event == 2 )
    return 2;
  if ( event == 99 )
    return 3;
  return 1;
}


/* Function: state_done @ 0x26E4 */
int __cdecl state_done(int event)
{
  return 2;
}


/* Function: state_error @ 0x26F8 */
int __cdecl state_error(int event)
{
  if ( event )
    return 3;
  else
    return 0;
}


/* Function: computed_goto @ 0x271C */
int __cdecl computed_goto(int *labels, int idx)
{
  _OWORD v3[2]; // [xsp+10h] [xbp-40h]
  int v4; // [xsp+3Ch] [xbp-14h]
  int *v5; // [xsp+40h] [xbp-10h]

  v5 = labels;
  v4 = idx;
  v3[0] = *(_OWORD *)&off_13DB8;
  v3[1] = *(_OWORD *)&off_13DC8;
  if ( (idx & 0x80000000) == 0 && v4 <= 3 )
    __asm { BR              X8 }
  return -1;
}


/* Function: obfuscated_cf @ 0x27BC */
int __cdecl obfuscated_cf(int x)
{
  int v2; // [xsp+8h] [xbp-8h]

  v2 = x;
  if ( x * x + 1 < 0 )
    v2 = 2 * x + 1;
  return 2 * v2;
}


/* Function: opaque_predicate @ 0x2814 */
int __cdecl opaque_predicate(int x)
{
  if ( 305419896 * x % 2u )
    return 3 * x;
  else
    return 2 * x;
}


/* Function: overlapped_code @ 0x2884 */
int __cdecl overlapped_code(int x)
{
  if ( (x & 1) != 0 )
    return 3 * x + 1;
  else
    return x / 2;
}


/* Function: test_control_flow_l3 @ 0x28D0 */
void __cdecl test_control_flow_l3()
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
  int v11; // w0
  int labels[4]; // [xsp+30h] [xbp-10h] BYREF

  printf(asc_2FBE);
  v0 = non_local_jump(5);
  printf("CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  printf("CF-L3-01 (non_local_jump): %d\n", v1);
  v2 = cpp_exception(5);
  printf("CF-L3-02 (cpp_exception): %d\n", v2);
  v3 = cpp_exception(-5);
  printf("CF-L3-02 (cpp_exception): %d\n", v3);
  v4 = large_jump_table(0, 10, 5);
  printf("CF-L3-03 (large_jump_table): %d\n", v4);
  v5 = conditional_func_ptr(0, 5);
  printf("CF-L3-04 (conditional_func_ptr): %d\n", v5);
  v6 = state_machine(1, 0);
  printf("CF-L3-05 (state_machine): %d\n", v6);
  v7 = fsm_func_table(2, 1);
  printf("CF-L3-06 (fsm_func_table): %d\n", v7);
  *(_OWORD *)labels = xmmword_3140;
  v8 = computed_goto(labels, 2);
  printf("CF-L3-07 (computed_goto): %d\n", v8);
  v9 = obfuscated_cf(5);
  printf("CF-L3-08 (obfuscated_cf): %d\n", v9);
  v10 = opaque_predicate(5);
  printf("CF-L3-09 (opaque_predicate): %d\n", v10);
  v11 = overlapped_code(5);
  printf("CF-L3-10 (overlapped_code): %d\n", v11);
}


/* Function: main @ 0x2A50 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x2A84 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x141E0 */

/* FAILED to decompile: _setjmp @ 0x141E8 */

/* FAILED to decompile: __libc_start_main @ 0x141F0 */

/* FAILED to decompile: __cxa_finalize @ 0x141F8 */

/* FAILED to decompile: abort @ 0x14200 */

/* FAILED to decompile: longjmp @ 0x14208 */

/* FAILED to decompile: printf @ 0x14210 */

/* FAILED to decompile: __gmon_start__ @ 0x14220 */

/* Total functions decompiled: 75, failed: 8 */
