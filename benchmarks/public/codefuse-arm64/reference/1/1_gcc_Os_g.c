/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_gcc_Os_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x928 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_940 @ 0x940 */
void sub_940()
{
  JUMPOUT(0);
}


/* Function: main @ 0xA00 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: _start @ 0xA40 */
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


/* Function: call_weak_fn @ 0xA74 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xA90 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0xAC0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xB00 */
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


/* Function: frame_dummy @ 0xB50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: recursion_factorial @ 0xB54 */
int __fastcall recursion_factorial(int n)
{
  int result; // w0

  result = 1;
  while ( n > 1 )
    result *= n--;
  return result;
}


/* Function: double_value @ 0xB74 */
int __fastcall double_value(int x)
{
  return 2 * x;
}


/* Function: triple_value @ 0xB7C */
int __fastcall triple_value(int x)
{
  return 3 * x;
}


/* Function: op_add @ 0xB84 */
int __fastcall op_add(int a, int b)
{
  return a + b;
}


/* Function: op_sub @ 0xB8C */
int __fastcall op_sub(int a, int b)
{
  return a - b;
}


/* Function: op_mul @ 0xB94 */
int __fastcall op_mul(int a, int b)
{
  return a * b;
}


/* Function: op_div @ 0xB9C */
int __fastcall op_div(int a, int b)
{
  int result; // w0

  result = b;
  if ( b )
    return a / b;
  return result;
}


/* Function: op_mod @ 0xBB0 */
int __fastcall op_mod(int a, int b)
{
  int result; // w0

  result = b;
  if ( b )
    return a % b;
  return result;
}


/* Function: op_and @ 0xBC8 */
int __fastcall op_and(int a, int b)
{
  return a & b;
}


/* Function: op_or @ 0xBD0 */
int __fastcall op_or(int a, int b)
{
  return a | b;
}


/* Function: op_xor @ 0xBD8 */
int __fastcall op_xor(int a, int b)
{
  return a ^ b;
}


/* Function: op_shl @ 0xBE0 */
int __fastcall op_shl(int a, int b)
{
  return a << b;
}


/* Function: op_shr @ 0xBE8 */
int __fastcall op_shr(int a, int b)
{
  return a >> b;
}


/* Function: state_idle @ 0xBF0 */
int __fastcall state_idle(int event)
{
  return event == 1;
}


/* Function: state_processing @ 0xBFC */
int __fastcall state_processing(int event)
{
  if ( event != 2 )
  {
    if ( event == 99 )
      return 3;
    else
      return 1;
  }
  return event;
}


/* Function: state_done @ 0xC14 */
int __fastcall state_done(int event)
{
  return 2;
}


/* Function: state_error @ 0xC1C */
int __fastcall state_error(int event)
{
  if ( event )
    return 3;
  else
    return 0;
}


/* Function: sequential_ops @ 0xC2C */
int __fastcall sequential_ops(int a, int b, int c)
{
  return 2 * (a + b) - c;
}


/* Function: single_if @ 0xC3C */
int __fastcall single_if(int x)
{
  if ( x > 0 )
    x *= 2;
  return x;
}


/* Function: if_else @ 0xC4C */
int __fastcall if_else(int x)
{
  return x > 0;
}


/* Function: nested_if_2 @ 0xC58 */
int __fastcall nested_if_2(int a, int b)
{
  if ( a <= 0 )
    return 0;
  if ( b > 0 )
    a += b;
  return a;
}


/* Function: nested_if_deep @ 0xC78 */
int __fastcall nested_if_deep(int a, int b, int c, int d, int e)
{
  if ( a <= 0 )
    return 0;
  if ( b <= 0 )
    return 1;
  if ( c <= 0 )
    return 2;
  if ( d <= 0 )
    return 3;
  return (e > 0) + 4;
}


/* Function: if_elseif_chain @ 0xCC8 */
int __fastcall if_elseif_chain(int x)
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


/* Function: if_elseif_long @ 0xCF4 */
int __fastcall if_elseif_long(int x)
{
  if ( (unsigned int)x >= 5 )
    return -1;
  else
    return 100 * x + 100;
}


/* Function: switch_small @ 0xD08 */
int __fastcall switch_small(int op)
{
  if ( (unsigned int)op > 3 )
    return -1;
  else
    return CSWTCH_55[op];
}


/* Function: switch_large @ 0xD28 */
int __fastcall switch_large(int op)
{
  if ( (unsigned int)op >= 0xA )
    return -1;
  else
    return 10 * op;
}


/* Function: switch_default @ 0xD3C */
int __fastcall switch_default(int op)
{
  unsigned int v1; // w1
  int result; // w0

  v1 = op - 1;
  result = 100 * op;
  if ( v1 >= 3 )
    return 0;
  return result;
}


/* Function: switch_fallthrough @ 0xD54 */
int __fastcall switch_fallthrough(int op)
{
  int v2; // w1
  int v3; // w1

  if ( op == 2 )
  {
    v2 = 0;
LABEL_6:
    v3 = v2 + 2 * op;
    return v3 + op;
  }
  if ( op == 3 )
  {
    v2 = 12;
    goto LABEL_6;
  }
  if ( op != 1 )
    return -1;
  v3 = 0;
  return v3 + op;
}


/* Function: loop_for_fixed @ 0xD94 */
int __fastcall loop_for_fixed(int n)
{
  int v2; // w1
  int result; // w0

  v2 = 0;
  result = 0;
  while ( v2 < n )
    result += v2++;
  return result;
}


/* Function: loop_while @ 0xDB8 */
int __fastcall loop_while(int x)
{
  int v1; // w1

  v1 = 0;
  while ( x )
  {
    x /= 10;
    ++v1;
  }
  if ( v1 <= 0 )
    return 1;
  else
    return v1;
}


/* Function: loop_dowhile @ 0xDDC */
int __fastcall loop_dowhile(int x)
{
  int result; // w0

  result = 0;
  do
  {
    x /= 10;
    ++result;
  }
  while ( x );
  return result;
}


/* Function: loop_nested @ 0xDF8 */
int __fastcall loop_nested(int m, int n)
{
  int v3; // w3
  int result; // w0
  int v5; // w4

  v3 = 0;
  result = 0;
  while ( v3 < m )
  {
    ++v3;
    if ( n < 0 )
      v5 = 0;
    else
      v5 = n;
    result += v5;
  }
  return result;
}


/* Function: loop_break @ 0xE24 */
int __fastcall loop_break(int target)
{
  __int64 v2; // x1
  int result; // w0
  int arr[5]; // [xsp+10h] [xbp+10h]

  v2 = 0;
  *(_QWORD *)arr = 0x140000000ALL;
  *(_QWORD *)&arr[2] = 0x280000001ELL;
  arr[4] = 50;
  while ( 1 )
  {
    result = v2;
    if ( arr[v2] == target )
      break;
    if ( ++v2 == 5 )
      return -1;
  }
  return result;
}


/* Function: loop_continue @ 0xEB0 */
int __fastcall loop_continue(int n)
{
  int v2; // w1
  int result; // w0

  v2 = 1;
  result = 0;
  while ( v2 <= n )
  {
    if ( (v2 & 1) != 0 )
      result += v2;
    ++v2;
  }
  return result;
}


/* Function: goto_forward @ 0xED8 */
int __fastcall goto_forward(int x)
{
  if ( x > 0 )
    x *= x;
  return 2 * x;
}


/* Function: goto_backward @ 0xEEC */
int __fastcall goto_backward(int x)
{
  int result; // w0
  int i; // w1

  result = 1;
  if ( x > 0 )
  {
    for ( i = 1; i <= x; ++i )
      result *= i;
  }
  return result;
}


/* Function: ternary_op @ 0xF14 */
int __fastcall ternary_op(int a, int b)
{
  if ( b >= a )
    return b;
  return a;
}


/* Function: test_control_flow_l1 @ 0xF20 */
void __cdecl test_control_flow_l1()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0

  puts(asc_1C70);
  __printf_chk(1, "CF-L1-01 (sequential_ops): %d\n", 21);
  __printf_chk(1, "CF-L1-02 (single_if): %d\n", 20);
  __printf_chk(1, "CF-L1-02 (single_if): %d\n", -5);
  __printf_chk(1, "CF-L1-03 (if_else): %d\n", 1);
  __printf_chk(1, "CF-L1-03 (if_else): %d\n", 0);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 15);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 10);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 0);
  __printf_chk(1, "CF-L1-05 (nested_if_deep): %d\n", 5);
  __printf_chk(1, "CF-L1-06 (if_elseif_chain): %d\n", 20);
  __printf_chk(1, "CF-L1-07 (if_elseif_long): %d\n", 400);
  __printf_chk(1, "CF-L1-08 (switch_small): %d\n", 50);
  __printf_chk(1, "CF-L1-09 (switch_large): %d\n", 70);
  __printf_chk(1, "CF-L1-10 (switch_default): %d\n", 0);
  __printf_chk(1, "CF-L1-11 (switch_fallthrough): %d\n", 21);
  v0 = loop_for_fixed(10);
  __printf_chk(1, "CF-L1-12 (loop_for_fixed): %d\n", v0);
  v1 = loop_while(12345);
  __printf_chk(1, "CF-L1-13 (loop_while): %d\n", v1);
  v2 = loop_dowhile(9876);
  __printf_chk(1, "CF-L1-14 (loop_dowhile): %d\n", v2);
  v3 = loop_nested(3, 4);
  __printf_chk(1, "CF-L1-15 (loop_nested): %d\n", v3);
  v4 = loop_break(30);
  __printf_chk(1, "CF-L1-16 (loop_break): %d\n", v4);
  v5 = loop_break(99);
  __printf_chk(1, "CF-L1-16 (loop_break): %d\n", v5);
  v6 = loop_continue(10);
  __printf_chk(1, "CF-L1-17 (loop_continue): %d\n", v6);
  __printf_chk(1, "CF-L1-18 (goto_forward): %d\n", 50);
  __printf_chk(1, "CF-L1-18 (goto_forward): %d\n", -6);
  __printf_chk(1, "CF-L1-19 (goto_backward): %d\n", 120);
  __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 10);
  __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 8);
}


/* Function: loop_multi_exit @ 0x1194 */
int __fastcall loop_multi_exit(int target)
{
  int *v1; // x1
  int v2; // w2
  __int64 i; // x3
  int matrix[3][4]; // [xsp+18h] [xbp+18h] BYREF

  v1 = matrix[0];
  *(_OWORD *)&matrix[0][0] = xmmword_2258;
  *(_OWORD *)&matrix[1][0] = xmmword_2268;
  v2 = 0;
  *(_OWORD *)&matrix[2][0] = xmmword_2278;
  do
  {
    for ( i = 0; i != 4; ++i )
    {
      if ( v1[i] == target )
        return i + 10 * v2;
    }
    ++v2;
    v1 += 4;
  }
  while ( v2 != 3 );
  return -1;
}


/* Function: infinite_loop @ 0x1238 */
int __fastcall infinite_loop(volatile int *flag)
{
  int result; // w0

  result = 0;
  while ( *flag != 1 )
  {
    if ( ++result == 1001 )
    {
      *flag = 1;
      return result;
    }
  }
  return result;
}


/* Function: multi_return @ 0x1264 */
int __fastcall multi_return(int x)
{
  int result; // w0

  if ( x < 0 )
    return -1;
  result = 2 * x;
  if ( result > 100 )
    return -2;
  if ( (x & 1) != 0 )
    return x + 1;
  return result;
}


/* Function: conditional_return @ 0x1294 */
int __fastcall conditional_return(int x)
{
  bool v1; // cc
  int v2; // w1
  int result; // w0

  v1 = x <= 0;
  v2 = 2 * x;
  if ( x )
    result = -x;
  else
    result = 0;
  if ( !v1 )
    return v2;
  return result;
}


/* Function: duffs_device @ 0x12A8 */
int __fastcall duffs_device(int *dst, int *src, int n)
{
  int result; // w0
  int v5; // w2
  int v6; // t1
  int v7; // t1
  int v8; // t1
  int v9; // t1
  int v10; // t1
  int v11; // t1
  int v12; // t1

  result = n;
  if ( n <= 0 )
    return -1;
  v5 = (n + 7) >> 3;
  switch ( result & 7 )
  {
    case 1:
      goto LABEL_10;
    case 2:
      goto LABEL_9;
    case 3:
      goto LABEL_8;
    case 4:
      goto LABEL_7;
    case 5:
      goto LABEL_6;
    case 6:
      goto LABEL_5;
    case 7:
      goto LABEL_4;
    default:
      while ( 1 )
      {
        v6 = *src++;
        *dst++ = v6;
LABEL_4:
        v7 = *src++;
        *dst++ = v7;
LABEL_5:
        v8 = *src++;
        *dst++ = v8;
LABEL_6:
        v9 = *src++;
        *dst++ = v9;
LABEL_7:
        v10 = *src++;
        *dst++ = v10;
LABEL_8:
        v11 = *src++;
        *dst++ = v11;
LABEL_9:
        v12 = *src++;
        *dst++ = v12;
LABEL_10:
        --v5;
        *dst = *src;
        if ( !v5 )
          break;
        ++src;
        ++dst;
      }
      break;
  }
  return result;
}


/* Function: loop_complex_cond @ 0x1344 */
int __fastcall loop_complex_cond(int x)
{
  int i; // w1

  for ( i = 0; 2 * i < x - i && i <= 9; ++i )
    ;
  return 2 * i + x;
}


/* Function: loop_modify_var @ 0x1370 */
int __fastcall loop_modify_var(int n)
{
  int v2; // w1
  int result; // w0

  v2 = 0;
  result = 0;
  while ( v2 < n )
  {
    result += v2;
    if ( v2 > 5 )
      v2 += 2;
    ++v2;
  }
  return result;
}


/* Function: loop_external_state @ 0x13A0 */
int __fastcall loop_external_state(volatile int *flag)
{
  int result; // w0

  for ( result = 0; result != 101; ++result )
  {
    if ( *flag )
      break;
  }
  return result;
}


/* Function: tail_recursion @ 0x13C0 */
int __fastcall tail_recursion(int n, int acc)
{
  int result; // w0

  result = acc;
  while ( n > 1 )
    result *= n--;
  return result;
}


/* Function: indirect_recursion_a @ 0x13E0 */
int __fastcall indirect_recursion_a(int n, int depth)
{
  int v2; // w0

  while ( depth > 0 )
  {
    if ( (n & 1) != 0 )
    {
      v2 = 3 * n;
      if ( depth == 1 )
        return v2 + 1;
      n = v2 + 2;
    }
    else
    {
      n /= 2;
      if ( depth == 1 )
        return n;
      ++n;
    }
    depth -= 2;
  }
  return n;
}


/* Function: call_func_ptr @ 0x1424 */
int __fastcall call_func_ptr(int (*f)(int), int x)
{
  return f(x);
}


/* Function: call_func_ptr_array @ 0x1430 */
int __fastcall call_func_ptr_array(int idx, int x)
{
  int (*funcs[3])(int); // [xsp+10h] [xbp+10h]

  funcs[0] = (int (*)(int))off_13010[0];
  funcs[1] = (int (*)(int))off_13018[0];
  funcs[2] = (int (*)(int))off_13020[0];
  if ( (unsigned int)idx > 2 )
    return -1;
  else
    return funcs[idx](x);
}


/* Function: call_virtual_func @ 0x14C8 */
int __fastcall call_virtual_func(void *obj, int x)
{
  return 2 * x;
}


/* Function: process_with_callback @ 0x14D0 */
int __fastcall process_with_callback(int *arr, int n, int (*cb)(int))
{
  __int64 v6; // x19
  int v7; // w20
  __int64 v9; // x0

  v6 = 0;
  v7 = 0;
  while ( n > (int)v6 )
  {
    v9 = (unsigned int)arr[v6++];
    v7 += cb(v9);
  }
  return v7;
}


/* Function: test_control_flow_l2 @ 0x152C */
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
  int flag; // [xsp+38h] [xbp+38h] BYREF
  int ext_flag; // [xsp+3Ch] [xbp+3Ch] BYREF
  int arr[5]; // [xsp+40h] [xbp+40h] BYREF
  int src[8]; // [xsp+58h] [xbp+58h] BYREF
  int dst[8]; // [xsp+78h] [xbp+78h] BYREF

  puts(asc_1EDD);
  v0 = loop_multi_exit(7);
  __printf_chk(1, "CF-L2-01 (loop_multi_exit): %d\n", v0);
  flag = 0;
  v1 = infinite_loop(&flag);
  __printf_chk(1, "CF-L2-02 (infinite_loop): %d\n", v1);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", -1);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", -2);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", 4);
  __printf_chk(1, "CF-L2-04 (conditional_return): %d\n", 10);
  __printf_chk(1, "CF-L2-04 (conditional_return): %d\n", 5);
  memset(dst, 0, sizeof(dst));
  *(_OWORD *)src = xmmword_2288;
  *(_OWORD *)&src[4] = xmmword_2298;
  v2 = duffs_device(dst, src, 8);
  __printf_chk(1, "CF-L2-05 (duffs_device): %d\n", v2);
  v3 = loop_complex_cond(10);
  __printf_chk(1, "CF-L2-06 (loop_complex_cond): %d\n", v3);
  v4 = loop_modify_var(10);
  __printf_chk(1, "CF-L2-07 (loop_modify_var): %d\n", v4);
  ext_flag = 0;
  v5 = loop_external_state(&ext_flag);
  __printf_chk(1, "CF-L2-08 (loop_external_state): %d\n", v5);
  v6 = recursion_factorial(5);
  __printf_chk(1, "CF-L2-09 (recursion_factorial): %d\n", v6);
  __printf_chk(1, "CF-L2-10 (tail_recursion): %d\n", 120);
  v7 = indirect_recursion_a(6, 1);
  __printf_chk(1, "CF-L2-11 (indirect_recursion): %d\n", v7);
  v8 = call_func_ptr(double_value, 5);
  __printf_chk(1, "CF-L2-12 (call_func_ptr): %d\n", v8);
  v9 = call_func_ptr_array(0, 5);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v9);
  v10 = call_func_ptr_array(2, 5);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v10);
  *(_QWORD *)arr = 0x200000001LL;
  *(_QWORD *)&arr[2] = 0x400000003LL;
  arr[4] = 5;
  v11 = process_with_callback(arr, 5, double_value);
  __printf_chk(1, "CF-L2-15 (process_with_callback): %d\n", v11);
}


/* Function: non_local_jump @ 0x17AC */
int __fastcall non_local_jump(int x)
{
  __int64 v1; // x1
  int result; // w0

  if ( _setjmp(jump_buffer) )
    return -1;
  if ( x < 0 )
  {
    v1 = 1;
    goto LABEL_4;
  }
  result = 2 * x;
  if ( x > 100 )
  {
    v1 = 2;
LABEL_4:
    __longjmp_chk(jump_buffer, v1);
  }
  return result;
}


/* Function: cpp_exception @ 0x1808 */
int __fastcall cpp_exception(int x)
{
  if ( x < 0 )
    return -1;
  if ( x >= 101 )
    return -2;
  return 2 * x;
}


/* Function: large_jump_table @ 0x1828 */
int __fastcall large_jump_table(int op, int a, int b)
{
  int (*ops[10])(int, int); // [xsp+18h] [xbp+18h]

  *(_OWORD *)ops = *(_OWORD *)off_13028;
  *(_OWORD *)&ops[2] = *(_OWORD *)off_13038;
  *(_OWORD *)&ops[4] = *(_OWORD *)off_13048;
  *(_OWORD *)&ops[6] = *(_OWORD *)off_13058;
  *(_OWORD *)&ops[8] = *(_OWORD *)off_13068;
  if ( (unsigned int)op > 9 )
    return -1;
  else
    return ops[op](a, b);
}


/* Function: conditional_func_ptr @ 0x18D0 */
int __fastcall conditional_func_ptr(int mode, int x)
{
  int (__fastcall *v2)(int); // x2

  if ( !mode )
    return double_value(x);
  v2 = triple_value;
  if ( mode != 1 )
    v2 = recursion_factorial;
  return v2(x);
}


/* Function: state_machine @ 0x1908 */
int __fastcall state_machine(int event, int state)
{
  int result; // w0

  result = state;
  switch ( state )
  {
    case 0:
      result = event == 1;
      break;
    case 1:
      if ( event == 2 )
      {
        result = 2;
      }
      else if ( event == 99 )
      {
        result = 3;
      }
      break;
    case 2:
      return result;
    case 3:
      if ( !event )
        result = 0;
      break;
    default:
      result = 3;
      break;
  }
  return result;
}


/* Function: fsm_func_table @ 0x1970 */
int __fastcall fsm_func_table(int event, int state)
{
  int (*state_handlers[4])(int); // [xsp+18h] [xbp+18h]

  *(_OWORD *)state_handlers = *(_OWORD *)off_13078;
  *(_OWORD *)&state_handlers[2] = *(_OWORD *)off_13088;
  if ( (unsigned int)state > 3 )
    return 3;
  else
    return state_handlers[state](event);
}


/* Function: computed_goto @ 0x19FC */
int __fastcall computed_goto(int *labels, int idx)
{
  void *targets[4]; // [xsp+18h] [xbp+18h]

  *(_OWORD *)targets = *(_OWORD *)&off_13098;
  *(_OWORD *)&targets[2] = *(_OWORD *)&off_130A8;
  if ( (unsigned int)idx <= 3 )
    __asm { BR              X0 }
  return -1;
}


/* Function: obfuscated_cf @ 0x1A8C */
__int64 __fastcall obfuscated_cf(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: opaque_predicate @ 0x1A94 */
__int64 __fastcall opaque_predicate(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: overlapped_code @ 0x1A9C */
int __fastcall overlapped_code(int x)
{
  if ( (x & 1) != 0 )
    return 3 * x + 1;
  else
    return x / 2;
}


/* Function: test_control_flow_l3 @ 0x1AB8 */
void __cdecl test_control_flow_l3()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int labels[4]; // [xsp+28h] [xbp+28h] BYREF

  puts(asc_20D0);
  v0 = non_local_jump(5);
  __printf_chk(1, "CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  __printf_chk(1, "CF-L3-01 (non_local_jump): %d\n", v1);
  __printf_chk(1, "CF-L3-02 (cpp_exception): %d\n", 10);
  __printf_chk(1, "CF-L3-02 (cpp_exception): %d\n", -1);
  v2 = large_jump_table(0, 10, 5);
  __printf_chk(1, "CF-L3-03 (large_jump_table): %d\n", v2);
  v3 = conditional_func_ptr(0, 5);
  __printf_chk(1, "CF-L3-04 (conditional_func_ptr): %d\n", v3);
  __printf_chk(1, "CF-L3-05 (state_machine): %d\n", 1);
  v4 = fsm_func_table(2, 1);
  __printf_chk(1, "CF-L3-06 (fsm_func_table): %d\n", v4);
  *(_QWORD *)labels = 0x100000000LL;
  *(_QWORD *)&labels[2] = 0x300000002LL;
  v5 = computed_goto(labels, 2);
  __printf_chk(1, "CF-L3-07 (computed_goto): %d\n", v5);
  __printf_chk(1, "CF-L3-08 (obfuscated_cf): %d\n", 10);
  __printf_chk(1, "CF-L3-09 (opaque_predicate): %d\n", 10);
  __printf_chk(1, "CF-L3-10 (overlapped_code): %d\n", 16);
}


/* Function: .term_proc @ 0x1C58 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x13248 */

/* FAILED to decompile: __libc_start_main @ 0x13250 */

/* FAILED to decompile: __cxa_finalize @ 0x13258 */

/* FAILED to decompile: __printf_chk @ 0x13260 */

/* FAILED to decompile: __stack_chk_fail @ 0x13268 */

/* FAILED to decompile: abort @ 0x13278 */

/* FAILED to decompile: puts @ 0x13280 */

/* FAILED to decompile: __longjmp_chk @ 0x13288 */

/* FAILED to decompile: __gmon_start__ @ 0x13298 */

/* Total functions decompiled: 74, failed: 9 */
