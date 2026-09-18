/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_gcc_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x918 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_930 @ 0x930 */
void sub_930()
{
  JUMPOUT(0);
}


/* Function: _start @ 0xA00 */
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


/* Function: call_weak_fn @ 0xA34 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xA50 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0xA80 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xAC0 */
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


/* Function: frame_dummy @ 0xB10 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: sequential_ops @ 0xB14 */
int __cdecl sequential_ops(int a, int b, int c)
{
  return 2 * (a + b) - c;
}


/* Function: single_if @ 0xB5C */
int __cdecl single_if(int x)
{
  int xa; // [xsp+0h] [xbp-4h]

  xa = x;
  if ( x > 0 )
    return 2 * x;
  return xa;
}


/* Function: if_else @ 0xB88 */
int __cdecl if_else(int x)
{
  return x > 0;
}


/* Function: nested_if_2 @ 0xBB0 */
int __cdecl nested_if_2(int a, int b)
{
  if ( a <= 0 )
    return 0;
  if ( b > 0 )
    a += b;
  return a;
}


/* Function: nested_if_deep @ 0xBF8 */
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


/* Function: if_elseif_chain @ 0xC80 */
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


/* Function: if_elseif_long @ 0xCD0 */
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


/* Function: switch_small @ 0xD48 */
int __cdecl switch_small(int op)
{
  if ( op == 3 )
    return 2;
  if ( op <= 3 )
  {
    switch ( op )
    {
      case 2:
        return 50;
      case 0:
        return 15;
      case 1:
        return 5;
    }
  }
  return -1;
}


/* Function: switch_large @ 0xDF8 */
int __cdecl switch_large(int op)
{
  if ( op == 9 )
    return 90;
  if ( op <= 9 )
  {
    switch ( op )
    {
      case 8:
        return 80;
      case 7:
        return 70;
      case 6:
        return 60;
      case 5:
        return 50;
      case 4:
        return 40;
      case 3:
        return 30;
      case 2:
        return 20;
      case 0:
        return 0;
      case 1:
        return 10;
    }
  }
  return -1;
}


/* Function: switch_default @ 0xF38 */
int __cdecl switch_default(int op)
{
  if ( op == 3 )
    return 300;
  if ( op > 3 )
    return 0;
  if ( op == 1 )
    return 100;
  if ( op == 2 )
    return 200;
  else
    return 0;
}


/* Function: switch_fallthrough @ 0xF98 */
int __cdecl switch_fallthrough(int op)
{
  int result; // [xsp+10h] [xbp-4h]

  result = 0;
  if ( op == 3 )
  {
    result = 12;
LABEL_7:
    result += 2 * op;
    return result + op;
  }
  if ( op > 3 )
    return -1;
  if ( op != 1 )
  {
    if ( op != 2 )
      return -1;
    goto LABEL_7;
  }
  return result + op;
}


/* Function: loop_for_fixed @ 0x1028 */
int __cdecl loop_for_fixed(int n)
{
  int sum; // [xsp+Ch] [xbp-8h]
  int i; // [xsp+10h] [xbp-4h]

  sum = 0;
  for ( i = 0; i < n; ++i )
    sum += i;
  return sum;
}


/* Function: loop_while @ 0x1074 */
int __cdecl loop_while(int x)
{
  int count; // [xsp+10h] [xbp-4h]

  count = 0;
  while ( x )
  {
    x /= 10;
    ++count;
  }
  if ( count <= 0 )
    return 1;
  else
    return count;
}


/* Function: loop_dowhile @ 0x10DC */
int __cdecl loop_dowhile(int x)
{
  int count; // [xsp+10h] [xbp-4h]

  count = 0;
  do
  {
    x /= 10;
    ++count;
  }
  while ( x );
  return count;
}


/* Function: loop_nested @ 0x1130 */
int __cdecl loop_nested(int m, int n)
{
  int total; // [xsp+Ch] [xbp-Ch]
  int i; // [xsp+10h] [xbp-8h]
  int j; // [xsp+14h] [xbp-4h]

  total = 0;
  for ( i = 0; i < m; ++i )
  {
    for ( j = 0; j < n; ++j )
      ++total;
  }
  return total;
}


/* Function: loop_break @ 0x11A0 */
int __cdecl loop_break(int target)
{
  int i; // [xsp+28h] [xbp+28h]
  int arr[5]; // [xsp+30h] [xbp+30h]

  *(_QWORD *)arr = 0x140000000ALL;
  *(_QWORD *)&arr[2] = 0x280000001ELL;
  arr[4] = 50;
  for ( i = 0; i < 5; ++i )
  {
    if ( target == arr[i] )
      return i;
  }
  return -1;
}


/* Function: loop_continue @ 0x1264 */
int __cdecl loop_continue(int n)
{
  int sum; // [xsp+Ch] [xbp-8h]
  int i; // [xsp+10h] [xbp-4h]

  sum = 0;
  for ( i = 1; i <= n; ++i )
  {
    if ( (i & 1) != 0 )
      sum += i;
  }
  return sum;
}


/* Function: goto_forward @ 0x12CC */
int __cdecl goto_forward(int x)
{
  int result; // [xsp+10h] [xbp-4h]

  if ( x <= 0 )
    result = x;
  else
    result = x * x;
  return 2 * result;
}


/* Function: goto_backward @ 0x1310 */
int __cdecl goto_backward(int x)
{
  int result; // [xsp+Ch] [xbp-8h]
  int i; // [xsp+10h] [xbp-4h]

  if ( x <= 0 )
    return 1;
  result = 1;
  for ( i = 1; i <= x; ++i )
    result *= i;
  return result;
}


/* Function: ternary_op @ 0x137C */
int __cdecl ternary_op(int a, int b)
{
  if ( b >= a )
    return b;
  return a;
}


/* Function: test_control_flow_l1 @ 0x13A4 */
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

  puts(asc_29E8);
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


/* Function: loop_multi_exit @ 0x167C */
int __cdecl loop_multi_exit(int target)
{
  int i; // [xsp+20h] [xbp+20h]
  int j; // [xsp+24h] [xbp+24h]
  int matrix[3][4]; // [xsp+28h] [xbp+28h]

  *(_OWORD *)&matrix[0][0] = xmmword_2C90;
  *(_OWORD *)&matrix[1][0] = xmmword_2CA0;
  *(_OWORD *)&matrix[2][0] = xmmword_2CB0;
  for ( i = 0; i <= 2; ++i )
  {
    for ( j = 0; j <= 3; ++j )
    {
      if ( target == matrix[i][j] )
        return 10 * i + j;
    }
  }
  return -1;
}


/* Function: infinite_loop @ 0x1778 */
int __cdecl infinite_loop(volatile int *flag)
{
  int count; // [xsp+14h] [xbp-4h]

  count = 0;
  while ( *flag != 1 )
  {
    if ( ++count > 1000 )
    {
      *flag = 1;
      return count;
    }
  }
  return count;
}


/* Function: multi_return @ 0x17CC */
int __cdecl multi_return(int x)
{
  if ( x < 0 )
    return -1;
  if ( 2 * x > 100 )
    return -2;
  if ( (x & 1) != 0 )
    return x + 1;
  return 2 * x;
}


/* Function: conditional_return @ 0x1830 */
int __cdecl conditional_return(int x)
{
  if ( x > 0 )
    return 2 * x;
  if ( x >= 0 )
    return 0;
  return -x;
}


/* Function: duffs_device @ 0x1874 */
int __cdecl duffs_device(int *dst, int *src, int n)
{
  int v4; // w0
  int v5; // w0
  int *v6; // x1
  int *v7; // x0
  int *v8; // x1
  int *v9; // x0
  int *v10; // x1
  int *v11; // x0
  int *v12; // x1
  int *v13; // x0
  int *v14; // x1
  int *v15; // x0
  int *v16; // x1
  int *v17; // x0
  int *v18; // x1
  int *v19; // x0
  int *v20; // x1
  int *v21; // x0
  int count; // [xsp+20h] [xbp-4h]

  if ( n <= 0 )
    return -1;
  v4 = n + 7;
  if ( n + 7 < 0 )
    v4 = n + 14;
  count = v4 >> 3;
  v5 = n & 7;
  switch ( v5 )
  {
    case 7:
      goto LABEL_13;
    case 6:
      goto LABEL_14;
    case 5:
      goto LABEL_15;
    case 4:
      goto LABEL_16;
    case 3:
      goto LABEL_17;
    case 2:
      goto LABEL_18;
  }
  if ( (n & 7) != 0 )
    goto LABEL_19;
  do
  {
    v6 = src++;
    v7 = dst++;
    *v7 = *v6;
LABEL_13:
    v8 = src++;
    v9 = dst++;
    *v9 = *v8;
LABEL_14:
    v10 = src++;
    v11 = dst++;
    *v11 = *v10;
LABEL_15:
    v12 = src++;
    v13 = dst++;
    *v13 = *v12;
LABEL_16:
    v14 = src++;
    v15 = dst++;
    *v15 = *v14;
LABEL_17:
    v16 = src++;
    v17 = dst++;
    *v17 = *v16;
LABEL_18:
    v18 = src++;
    v19 = dst++;
    *v19 = *v18;
LABEL_19:
    v20 = src++;
    v21 = dst++;
    *v21 = *v20;
    --count;
  }
  while ( count > 0 );
  return n;
}


/* Function: loop_complex_cond @ 0x1A64 */
int __cdecl loop_complex_cond(int x)
{
  int a; // [xsp+8h] [xbp-Ch]
  int c; // [xsp+10h] [xbp-4h]

  a = 0;
  for ( c = 0; a < x && c <= 9 && x > 0; ++c )
  {
    a += 2;
    --x;
  }
  return a + x + c;
}


/* Function: loop_modify_var @ 0x1AE8 */
int __cdecl loop_modify_var(int n)
{
  int sum; // [xsp+Ch] [xbp-8h]
  int i; // [xsp+10h] [xbp-4h]

  sum = 0;
  for ( i = 0; i < n; ++i )
  {
    sum += i;
    if ( i > 5 )
      i += 2;
  }
  return sum;
}


/* Function: loop_external_state @ 0x1B4C */
int __cdecl loop_external_state(volatile int *flag)
{
  int count; // [xsp+14h] [xbp-4h]

  for ( count = 0; count <= 100; ++count )
  {
    if ( *flag )
      break;
  }
  return count;
}


/* Function: recursion_factorial @ 0x1B98 */
int __cdecl recursion_factorial(int n)
{
  if ( n > 1 )
    return recursion_factorial(n - 1) * n;
  else
    return 1;
}


/* Function: tail_recursion @ 0x1BD8 */
int __cdecl tail_recursion(int n, int acc)
{
  if ( n > 1 )
    return tail_recursion(n - 1, n * acc);
  else
    return acc;
}


/* Function: indirect_recursion_a @ 0x1C24 */
int __cdecl indirect_recursion_a(int n, int depth)
{
  if ( depth > 0 )
  {
    if ( (n & 1) != 0 )
      return indirect_recursion_b(3 * n + 1, depth - 1);
    else
      return indirect_recursion_b(n / 2, depth - 1);
  }
  return n;
}


/* Function: indirect_recursion_b @ 0x1CB4 */
int __cdecl indirect_recursion_b(int n, int depth)
{
  if ( depth > 0 )
    return indirect_recursion_a(n + 1, depth - 1);
  return n;
}


/* Function: call_func_ptr @ 0x1CFC */
int __cdecl call_func_ptr(int (*f)(int), int x)
{
  return f(x);
}


/* Function: double_value @ 0x1D20 */
int __cdecl double_value(int x)
{
  return 2 * x;
}


/* Function: triple_value @ 0x1D38 */
int __cdecl triple_value(int x)
{
  return 3 * x;
}


/* Function: call_func_ptr_array @ 0x1D58 */
int __cdecl call_func_ptr_array(int idx, int x)
{
  int (*funcs[3])(int); // [xsp+20h] [xbp+20h]

  funcs[0] = (int (*)(int))off_14010[0];
  funcs[1] = (int (*)(int))off_14018[0];
  funcs[2] = (int (*)(int))off_14020[0];
  if ( (unsigned int)idx <= 2 )
    return funcs[idx](x);
  else
    return -1;
}


/* Function: call_virtual_func @ 0x1E04 */
int __cdecl call_virtual_func(void *obj, int x)
{
  return 2 * x;
}


/* Function: process_with_callback @ 0x1E20 */
int __cdecl process_with_callback(int *arr, int n, int (*cb)(int))
{
  int sum; // [xsp+38h] [xbp+38h]
  int i; // [xsp+3Ch] [xbp+3Ch]

  sum = 0;
  for ( i = 0; i < n; ++i )
    sum += cb(arr[i]);
  return sum;
}


/* Function: test_control_flow_l2 @ 0x1E94 */
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
  int flag; // [xsp+18h] [xbp+18h] BYREF
  int ext_flag; // [xsp+1Ch] [xbp+1Ch] BYREF
  int arr[5]; // [xsp+20h] [xbp+20h] BYREF
  int src[8]; // [xsp+38h] [xbp+38h] BYREF
  int dst[8]; // [xsp+58h] [xbp+58h] BYREF

  puts(asc_2CC0);
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
  *(_OWORD *)src = xmmword_2EE0;
  *(_OWORD *)&src[4] = xmmword_2EF0;
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
  v12 = tail_recursion(5, 1);
  printf("CF-L2-10 (tail_recursion): %d\n", v12);
  v13 = indirect_recursion_a(10, 3);
  printf("CF-L2-11 (indirect_recursion): %d\n", v13);
  v14 = call_func_ptr((int (*)(int))double_value, 5);
  printf("CF-L2-12 (call_func_ptr): %d\n", v14);
  v15 = call_func_ptr_array(0, 5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v15);
  v16 = call_func_ptr_array(2, 5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v16);
  *(_QWORD *)arr = 0x200000001LL;
  *(_QWORD *)&arr[2] = 0x400000003LL;
  arr[4] = 5;
  v17 = process_with_callback(arr, 5, (int (*)(int))double_value);
  printf("CF-L2-15 (process_with_callback): %d\n", v17);
}


/* Function: non_local_jump @ 0x210C */
int __cdecl non_local_jump(int x)
{
  if ( _setjmp(jump_buffer) )
    return -1;
  if ( x < 0 )
    longjmp(jump_buffer, 1);
  if ( x > 100 )
    longjmp(jump_buffer, 2);
  return 2 * x;
}


/* Function: cpp_exception @ 0x217C */
int __cdecl cpp_exception(int x)
{
  if ( x < 0 )
    return -1;
  if ( x <= 100 )
    return 2 * x;
  return -2;
}


/* Function: op_add @ 0x21BC */
int __cdecl op_add(int a, int b)
{
  return a + b;
}


/* Function: op_sub @ 0x21DC */
int __cdecl op_sub(int a, int b)
{
  return a - b;
}


/* Function: op_mul @ 0x21FC */
int __cdecl op_mul(int a, int b)
{
  return a * b;
}


/* Function: op_div @ 0x221C */
int __cdecl op_div(int a, int b)
{
  if ( b )
    return a / b;
  else
    return 0;
}


/* Function: op_mod @ 0x2250 */
int __cdecl op_mod(int a, int b)
{
  if ( b )
    return a % b;
  else
    return 0;
}


/* Function: op_and @ 0x2290 */
int __cdecl op_and(int a, int b)
{
  return a & b;
}


/* Function: op_or @ 0x22B0 */
int __cdecl op_or(int a, int b)
{
  return a | b;
}


/* Function: op_xor @ 0x22D0 */
int __cdecl op_xor(int a, int b)
{
  return a ^ b;
}


/* Function: op_shl @ 0x22F0 */
int __cdecl op_shl(int a, int b)
{
  return a << b;
}


/* Function: op_shr @ 0x2310 */
int __cdecl op_shr(int a, int b)
{
  return a >> b;
}


/* Function: large_jump_table @ 0x2330 */
int __cdecl large_jump_table(int op, int a, int b)
{
  int (*ops[10])(int, int); // [xsp+28h] [xbp+28h]

  *(_OWORD *)ops = *(_OWORD *)off_14028;
  *(_OWORD *)&ops[2] = *(_OWORD *)off_14038;
  *(_OWORD *)&ops[4] = *(_OWORD *)off_14048;
  *(_OWORD *)&ops[6] = *(_OWORD *)off_14058;
  *(_OWORD *)&ops[8] = *(_OWORD *)off_14068;
  if ( (unsigned int)op < 0xA )
    return ops[op](a, b);
  else
    return -1;
}


/* Function: conditional_func_ptr @ 0x23E8 */
int __cdecl conditional_func_ptr(int mode, int x)
{
  if ( !mode )
    return double_value(x);
  if ( mode == 1 )
    return triple_value(x);
  return recursion_factorial(x);
}


/* Function: state_machine @ 0x2450 */
int __cdecl state_machine(int event, int state)
{
  if ( state == 3 )
  {
    if ( event )
      return 3;
    else
      return 0;
  }
  else
  {
    if ( state > 3 )
      return 3;
    switch ( state )
    {
      case 2:
        return 2;
      case 0:
        return event == 1;
      case 1:
        if ( event == 2 )
        {
          return 2;
        }
        else if ( event == 99 )
        {
          return 3;
        }
        else
        {
          return 1;
        }
      default:
        return 3;
    }
  }
}


/* Function: state_idle @ 0x2524 */
int __cdecl state_idle(int event)
{
  return event == 1;
}


/* Function: state_processing @ 0x2544 */
int __cdecl state_processing(int event)
{
  if ( event == 2 )
    return 2;
  if ( event == 99 )
    return 3;
  return 1;
}


/* Function: state_done @ 0x2580 */
int __cdecl state_done(int event)
{
  return 2;
}


/* Function: state_error @ 0x2594 */
int __cdecl state_error(int event)
{
  if ( event )
    return 3;
  else
    return 0;
}


/* Function: fsm_func_table @ 0x25BC */
int __cdecl fsm_func_table(int event, int state)
{
  int (*state_handlers[4])(int); // [xsp+28h] [xbp+28h]

  *(_OWORD *)state_handlers = *(_OWORD *)off_14078;
  *(_OWORD *)&state_handlers[2] = *(_OWORD *)off_14088;
  if ( (unsigned int)state < 4 )
    return state_handlers[state](event);
  else
    return 3;
}


/* Function: computed_goto @ 0x2660 */
int __cdecl computed_goto(int *labels, int idx)
{
  void *targets[4]; // [xsp+28h] [xbp+28h]

  *(_OWORD *)targets = *(_OWORD *)&off_14098;
  *(_OWORD *)&targets[2] = *(_OWORD *)&off_140A8;
  if ( (unsigned int)idx < 4 )
    __asm { BR              X0 }
  return -1;
}


/* Function: obfuscated_cf @ 0x2720 */
int __cdecl obfuscated_cf(int x)
{
  int result; // [xsp+10h] [xbp-4h]

  result = x;
  if ( x * x < -1 )
    result = 2 * x + 1;
  return 2 * result;
}


/* Function: opaque_predicate @ 0x2768 */
int __cdecl opaque_predicate(int x)
{
  return 2 * x;
}


/* Function: overlapped_code @ 0x27A4 */
int __cdecl overlapped_code(int x)
{
  if ( (x & 1) != 0 )
    return 3 * x + 1;
  else
    return x / 2;
}


/* Function: test_control_flow_l3 @ 0x27EC */
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
  int labels[4]; // [xsp+18h] [xbp+18h] BYREF

  puts(asc_2F18);
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
  labels[0] = 0;
  labels[1] = 1;
  labels[2] = 2;
  labels[3] = 3;
  v8 = computed_goto(labels, 2);
  printf("CF-L3-07 (computed_goto): %d\n", v8);
  v9 = obfuscated_cf(5);
  printf("CF-L3-08 (obfuscated_cf): %d\n", v9);
  v10 = opaque_predicate(5);
  printf("CF-L3-09 (opaque_predicate): %d\n", v10);
  v11 = overlapped_code(5);
  printf("CF-L3-10 (overlapped_code): %d\n", v11);
}


/* Function: main @ 0x2994 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x29B4 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x14248 */

/* FAILED to decompile: __libc_start_main @ 0x14250 */

/* FAILED to decompile: __cxa_finalize @ 0x14258 */

/* FAILED to decompile: __stack_chk_fail @ 0x14260 */

/* FAILED to decompile: abort @ 0x14270 */

/* FAILED to decompile: puts @ 0x14278 */

/* FAILED to decompile: longjmp @ 0x14280 */

/* FAILED to decompile: printf @ 0x14288 */

/* FAILED to decompile: __gmon_start__ @ 0x14298 */

/* Total functions decompiled: 75, failed: 9 */
