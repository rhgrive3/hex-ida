/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_gcc_O1_g
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


/* Function: recursion_factorial @ 0xB14 */
int __fastcall recursion_factorial(int n)
{
  if ( n <= 1 )
    return 1;
  else
    return recursion_factorial(n - 1) * n;
}


/* Function: double_value @ 0xB4C */
int __fastcall double_value(int x)
{
  return 2 * x;
}


/* Function: triple_value @ 0xB54 */
int __fastcall triple_value(int x)
{
  return 3 * x;
}


/* Function: op_add @ 0xB5C */
int __fastcall op_add(int a, int b)
{
  return a + b;
}


/* Function: op_sub @ 0xB64 */
int __fastcall op_sub(int a, int b)
{
  return a - b;
}


/* Function: op_mul @ 0xB6C */
int __fastcall op_mul(int a, int b)
{
  return a * b;
}


/* Function: op_div @ 0xB74 */
int __fastcall op_div(int a, int b)
{
  int result; // w0

  result = b;
  if ( b )
    return a / b;
  return result;
}


/* Function: op_mod @ 0xB88 */
int __fastcall op_mod(int a, int b)
{
  int result; // w0

  result = b;
  if ( b )
    return a % b;
  return result;
}


/* Function: op_and @ 0xBA0 */
int __fastcall op_and(int a, int b)
{
  return a & b;
}


/* Function: op_or @ 0xBA8 */
int __fastcall op_or(int a, int b)
{
  return a | b;
}


/* Function: op_xor @ 0xBB0 */
int __fastcall op_xor(int a, int b)
{
  return a ^ b;
}


/* Function: op_shl @ 0xBB8 */
int __fastcall op_shl(int a, int b)
{
  return a << b;
}


/* Function: op_shr @ 0xBC0 */
int __fastcall op_shr(int a, int b)
{
  return a >> b;
}


/* Function: state_idle @ 0xBC8 */
int __fastcall state_idle(int event)
{
  return event == 1;
}


/* Function: state_processing @ 0xBD4 */
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


/* Function: state_done @ 0xBEC */
int __fastcall state_done(int event)
{
  return 2;
}


/* Function: state_error @ 0xBF4 */
int __fastcall state_error(int event)
{
  if ( event )
    return 3;
  else
    return 0;
}


/* Function: sequential_ops @ 0xC04 */
int __fastcall sequential_ops(int a, int b, int c)
{
  return 2 * (a + b) - c;
}


/* Function: single_if @ 0xC14 */
int __fastcall single_if(int x)
{
  if ( x > 0 )
    x *= 2;
  return x;
}


/* Function: if_else @ 0xC24 */
int __fastcall if_else(int x)
{
  return x > 0;
}


/* Function: nested_if_2 @ 0xC30 */
int __fastcall nested_if_2(int a, int b)
{
  if ( a <= 0 )
    return 0;
  if ( b > 0 )
    a += b;
  return a;
}


/* Function: nested_if_deep @ 0xC50 */
int __fastcall nested_if_deep(int a, int b, int c, int d, int e)
{
  int result; // w0

  if ( a <= 0 )
    return 0;
  result = 1;
  if ( b > 0 )
  {
    if ( c <= 0 )
    {
      return 2;
    }
    else if ( d <= 0 )
    {
      return 3;
    }
    else
    {
      return (e > 0) + 4;
    }
  }
  return result;
}


/* Function: if_elseif_chain @ 0xC9C */
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


/* Function: if_elseif_long @ 0xCC8 */
int __fastcall if_elseif_long(int x)
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


/* Function: switch_small @ 0xD14 */
int __fastcall switch_small(int op)
{
  int result; // w0

  if ( op == 2 )
    return 50;
  if ( op > 2 )
  {
    if ( op == 3 )
      return 2;
    else
      return -1;
  }
  else
  {
    result = 15;
    if ( op )
    {
      if ( op == 1 )
        return 5;
      else
        return -1;
    }
  }
  return result;
}


/* Function: switch_large @ 0xD54 */
int __fastcall switch_large(int op)
{
  int v1; // w1

  v1 = op;
  if ( op == 5 )
    return 50;
  if ( op > 5 )
  {
    op = 80;
    if ( v1 != 8 )
    {
      if ( v1 <= 8 )
      {
        op = 60;
        if ( v1 != 6 )
        {
          if ( v1 == 7 )
            return 70;
          else
            return -1;
        }
      }
      else if ( v1 == 9 )
      {
        return 90;
      }
      else
      {
        return -1;
      }
    }
  }
  else if ( op == 2 )
  {
    return 20;
  }
  else if ( op <= 2 )
  {
    if ( op )
    {
      if ( op == 1 )
        return 10;
      else
        return -1;
    }
  }
  else if ( op == 3 )
  {
    return 30;
  }
  else
  {
    return 40;
  }
  return op;
}


/* Function: switch_default @ 0xDE4 */
int __fastcall switch_default(int op)
{
  int result; // w0

  result = 200;
  if ( op != 2 )
  {
    result = 300;
    if ( op != 3 )
    {
      if ( op == 1 )
        return 100;
      else
        return 0;
    }
  }
  return result;
}


/* Function: switch_fallthrough @ 0xE10 */
int __fastcall switch_fallthrough(int op)
{
  int v2; // w1
  int v3; // w1

  if ( op == 2 )
  {
    v2 = 0;
LABEL_7:
    v3 = v2 + 2 * op;
    return v3 + op;
  }
  if ( op == 3 )
  {
    v2 = 12;
    goto LABEL_7;
  }
  if ( op != 1 )
    return -1;
  v3 = 0;
  return v3 + op;
}


/* Function: loop_for_fixed @ 0xE50 */
int __fastcall loop_for_fixed(int n)
{
  int v2; // w1
  int result; // w0

  if ( n <= 0 )
    return 0;
  v2 = 0;
  result = 0;
  do
    result += v2++;
  while ( n != v2 );
  return result;
}


/* Function: loop_while @ 0xE80 */
int __fastcall loop_while(int x)
{
  int v1; // w2

  if ( x )
  {
    v1 = 0;
    do
    {
      ++v1;
      x /= 10;
    }
    while ( x );
  }
  else
  {
    v1 = 0;
  }
  if ( v1 <= 0 )
    return 1;
  else
    return v1;
}


/* Function: loop_dowhile @ 0xEB8 */
int __fastcall loop_dowhile(int x)
{
  int result; // w0

  result = 0;
  do
  {
    ++result;
    x /= 10;
  }
  while ( x );
  return result;
}


/* Function: loop_nested @ 0xEE0 */
int __fastcall loop_nested(int m, int n)
{
  int v3; // w3
  int result; // w0
  int v5; // w2

  v3 = 0;
  result = 0;
  if ( m > 0 )
  {
    do
    {
      v5 = 0;
      if ( n > 0 )
      {
        do
          ++v5;
        while ( n != v5 );
        result += v5;
      }
      ++v3;
    }
    while ( m != v3 );
  }
  return result;
}


/* Function: loop_break @ 0xF24 */
int __fastcall loop_break(int target)
{
  int *v2; // x1
  int result; // w0
  int arr[5]; // [xsp+10h] [xbp+10h] BYREF

  v2 = arr;
  *(_QWORD *)arr = *(_QWORD *)"\n";
  *(_QWORD *)&arr[2] = 0x280000001ELL;
  arr[4] = 50;
  result = 0;
  while ( *v2 != target )
  {
    ++result;
    ++v2;
    if ( result == 5 )
      return -1;
  }
  return result;
}


/* Function: loop_continue @ 0xFAC */
int __fastcall loop_continue(int n)
{
  int v1; // w3
  int v2; // w1
  int result; // w0

  if ( n <= 0 )
    return 0;
  v1 = n + 1;
  v2 = 1;
  result = 0;
  do
  {
    if ( (v2 & 1) != 0 )
      result += v2;
    ++v2;
  }
  while ( v2 != v1 );
  return result;
}


/* Function: goto_forward @ 0xFE4 */
int __fastcall goto_forward(int x)
{
  if ( x > 0 )
    x *= x;
  return 2 * x;
}


/* Function: goto_backward @ 0xFF8 */
int __fastcall goto_backward(int x)
{
  int v1; // w2
  int v2; // w1
  int result; // w0

  if ( x <= 0 )
    return 1;
  v1 = x + 1;
  v2 = 1;
  result = 1;
  do
    result *= v2++;
  while ( v2 != v1 );
  return result;
}


/* Function: ternary_op @ 0x1028 */
int __fastcall ternary_op(int a, int b)
{
  if ( b >= a )
    return b;
  return a;
}


/* Function: test_control_flow_l1 @ 0x1034 */
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

  puts(asc_1E40);
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
  v7 = goto_backward(5);
  __printf_chk(1, "CF-L1-19 (goto_backward): %d\n", v7);
  __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 10);
  __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 8);
}


/* Function: loop_multi_exit @ 0x12B4 */
int __fastcall loop_multi_exit(int target)
{
  int *v1; // x2
  int v2; // w4
  __int64 i; // x1
  int matrix[3][4]; // [xsp+18h] [xbp+18h] BYREF

  v1 = matrix[0];
  *(_OWORD *)&matrix[0][0] = xmmword_24A0;
  *(_OWORD *)&matrix[1][0] = xmmword_24B0;
  *(_OWORD *)&matrix[2][0] = xmmword_24C0;
  v2 = 0;
  while ( 2 )
  {
    for ( i = 0; i != 4; ++i )
    {
      if ( v1[i] == target )
        return i + 10 * v2;
    }
    ++v2;
    v1 += 4;
    if ( v2 != 3 )
      continue;
    break;
  }
  return -1;
}


/* Function: infinite_loop @ 0x1358 */
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


/* Function: multi_return @ 0x1384 */
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


/* Function: conditional_return @ 0x13B4 */
int __fastcall conditional_return(int x)
{
  if ( x > 0 )
    return 2 * x;
  if ( x < 0 )
    return -x;
  return 0;
}


/* Function: duffs_device @ 0x13CC */
int __fastcall duffs_device(int *dst, int *src, int n)
{
  int result; // w0
  int v5; // w2
  int v6; // w2
  int v7; // w4
  int v8; // t1
  int v9; // t1
  int v10; // t1
  int v11; // t1
  int v12; // t1
  int v13; // t1
  int v14; // t1

  result = n;
  if ( n <= 0 )
    return -1;
  v5 = n + 14;
  if ( result + 7 >= 0 )
    v5 = result + 7;
  v6 = v5 >> 3;
  if ( result <= 0 )
    v7 = -(-result & 7);
  else
    v7 = result & 7;
  if ( v7 == 4 )
    goto LABEL_24;
  if ( v7 > 4 )
  {
    switch ( v7 )
    {
      case 6:
        goto LABEL_21;
      case 7:
        goto LABEL_20;
      case 5:
        goto LABEL_23;
    }
  }
  else
  {
    if ( v7 == 2 )
      goto LABEL_12;
    if ( v7 <= 2 )
    {
      if ( (result & 7) == 0 )
        goto LABEL_17;
      if ( v7 == 1 )
        goto LABEL_15;
    }
    else
    {
      while ( 1 )
      {
        v8 = *src++;
        *dst++ = v8;
LABEL_12:
        v9 = *src++;
        *dst++ = v9;
LABEL_15:
        *dst = *src;
        if ( --v6 <= 0 )
          break;
        ++src;
        ++dst;
LABEL_17:
        v10 = *src++;
        *dst++ = v10;
LABEL_20:
        v11 = *src++;
        *dst++ = v11;
LABEL_21:
        v12 = *src++;
        *dst++ = v12;
LABEL_23:
        v13 = *src++;
        *dst++ = v13;
LABEL_24:
        v14 = *src++;
        *dst++ = v14;
      }
    }
  }
  return result;
}


/* Function: loop_complex_cond @ 0x14B0 */
int __fastcall loop_complex_cond(int x)
{
  int v1; // w2
  int v2; // w1

  if ( x <= 0 )
  {
    v1 = 0;
    v2 = 0;
  }
  else
  {
    v1 = 0;
    v2 = 0;
    do
    {
      v2 += 2;
      --x;
      ++v1;
    }
    while ( v2 < x && v1 <= 9 && x > 0 );
  }
  return v2 + x + v1;
}


/* Function: loop_modify_var @ 0x14F4 */
int __fastcall loop_modify_var(int n)
{
  int result; // w0
  int v3; // w1
  int v4; // w2

  result = 0;
  v3 = 0;
  if ( n > 0 )
  {
    while ( 1 )
    {
      v4 = v3 + 1;
      if ( n <= v3 + 1 )
        break;
      result += v4;
      v3 += 3;
      if ( v4 <= 5 )
        v3 = v4;
    }
  }
  return result;
}


/* Function: loop_external_state @ 0x152C */
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


/* Function: tail_recursion @ 0x154C */
int __fastcall tail_recursion(int n, int acc)
{
  if ( n <= 1 )
    return acc;
  else
    return tail_recursion(n - 1, n * acc);
}


/* Function: indirect_recursion_a @ 0x1578 */
int __fastcall indirect_recursion_a(int n, int depth)
{
  int v2; // w0

  if ( depth > 0 )
  {
    if ( (n & 1) != 0 )
    {
      v2 = 3 * n;
      if ( depth <= 1 )
        return v2 + 1;
      else
        return indirect_recursion_a(v2 + 2, depth - 2);
    }
    else
    {
      n /= 2;
      if ( depth > 1 )
        return indirect_recursion_a(n + 1, depth - 2);
    }
  }
  return n;
}


/* Function: call_func_ptr @ 0x15D8 */
int __fastcall call_func_ptr(int (*f)(int), int x)
{
  return f(x);
}


/* Function: call_func_ptr_array @ 0x15F4 */
int __fastcall call_func_ptr_array(int idx, int x)
{
  int (*funcs[3])(int); // [xsp+10h] [xbp+10h]

  funcs[0] = (int (*)(int))off_14010[0];
  funcs[1] = (int (*)(int))off_14018[0];
  funcs[2] = (int (*)(int))off_14020[0];
  if ( (unsigned int)idx > 2 )
    return -1;
  else
    return funcs[idx](x);
}


/* Function: call_virtual_func @ 0x1674 */
int __fastcall call_virtual_func(void *obj, int x)
{
  return 2 * x;
}


/* Function: process_with_callback @ 0x167C */
int __fastcall process_with_callback(int *arr, int n, int (*cb)(int))
{
  int *v4; // x19
  int *v5; // x21
  int v6; // w20
  int v7; // t1

  if ( n <= 0 )
    return 0;
  v4 = arr;
  v5 = &arr[n - 1 + 1];
  v6 = 0;
  do
  {
    v7 = *v4++;
    v6 += cb(v7);
  }
  while ( v4 != v5 );
  return v6;
}


/* Function: test_control_flow_l2 @ 0x16DC */
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
  int flag; // [xsp+38h] [xbp+38h] BYREF
  int ext_flag; // [xsp+3Ch] [xbp+3Ch] BYREF
  int arr[5]; // [xsp+40h] [xbp+40h] BYREF
  int src[8]; // [xsp+58h] [xbp+58h] BYREF
  int dst[8]; // [xsp+78h] [xbp+78h] BYREF

  puts(asc_20E8);
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
  *(_OWORD *)src = xmmword_24D0;
  *(_OWORD *)&src[4] = xmmword_24E0;
  memset(dst, 0, sizeof(dst));
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
  v7 = tail_recursion(5, 1);
  __printf_chk(1, "CF-L2-10 (tail_recursion): %d\n", v7);
  v8 = indirect_recursion_a(10, 3);
  __printf_chk(1, "CF-L2-11 (indirect_recursion): %d\n", v8);
  v9 = call_func_ptr(double_value, 5);
  __printf_chk(1, "CF-L2-12 (call_func_ptr): %d\n", v9);
  v10 = call_func_ptr_array(0, 5);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v10);
  v11 = call_func_ptr_array(2, 5);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v11);
  *(_QWORD *)arr = 0x200000001LL;
  *(_QWORD *)&arr[2] = 0x400000003LL;
  arr[4] = 5;
  v12 = process_with_callback(arr, 5, double_value);
  __printf_chk(1, "CF-L2-15 (process_with_callback): %d\n", v12);
}


/* Function: non_local_jump @ 0x1968 */
int __fastcall non_local_jump(int x)
{
  int result; // w0

  if ( _setjmp(jump_buffer) )
    return -1;
  if ( x < 0 )
    __longjmp_chk(jump_buffer, 1);
  result = 2 * x;
  if ( x > 100 )
    __longjmp_chk(jump_buffer, 2);
  return result;
}


/* Function: cpp_exception @ 0x19CC */
int __fastcall cpp_exception(int x)
{
  if ( x < 0 )
    return -1;
  if ( x > 100 )
    return -2;
  return 2 * x;
}


/* Function: large_jump_table @ 0x19F0 */
int __fastcall large_jump_table(int op, int a, int b)
{
  int (*ops[10])(int, int); // [xsp+18h] [xbp+18h]

  *(_OWORD *)ops = *(_OWORD *)off_14028;
  *(_OWORD *)&ops[2] = *(_OWORD *)off_14038;
  *(_OWORD *)&ops[4] = *(_OWORD *)off_14048;
  *(_OWORD *)&ops[6] = *(_OWORD *)off_14058;
  *(_OWORD *)&ops[8] = *(_OWORD *)off_14068;
  if ( (unsigned int)op > 9 )
    return -1;
  else
    return ops[op](a, b);
}


/* Function: conditional_func_ptr @ 0x1A80 */
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


/* Function: state_machine @ 0x1AC4 */
int __fastcall state_machine(int event, int state)
{
  if ( state == 2 )
    return 2;
  if ( state > 2 )
  {
    if ( event )
      event = state;
    else
      event = 0;
    if ( state != 3 )
      return 3;
  }
  else if ( state )
  {
    if ( state == 1 )
    {
      if ( event != 2 )
      {
        if ( event == 99 )
          return 3;
        else
          return 1;
      }
    }
    else
    {
      return 3;
    }
  }
  else
  {
    return event == 1;
  }
  return event;
}


/* Function: fsm_func_table @ 0x1B28 */
int __fastcall fsm_func_table(int event, int state)
{
  int result; // w0
  int (*state_handlers[4])(int); // [xsp+18h] [xbp+18h]

  *(_OWORD *)state_handlers = *(_OWORD *)off_14078;
  *(_OWORD *)&state_handlers[2] = *(_OWORD *)off_14088;
  result = 3;
  if ( (unsigned int)state <= 3 )
    return state_handlers[state](event);
  return result;
}


/* Function: computed_goto @ 0x1BA4 */
int __fastcall computed_goto(int *labels, int idx)
{
  void *targets[4]; // [xsp+18h] [xbp+18h]

  *(_OWORD *)targets = *(_OWORD *)&off_14098;
  *(_OWORD *)&targets[2] = *(_OWORD *)&off_140A8;
  if ( (unsigned int)idx <= 3 )
    __asm { BR              X0 }
  return -1;
}


/* Function: obfuscated_cf @ 0x1C34 */
int __fastcall obfuscated_cf(int x)
{
  return 2 * x;
}


/* Function: opaque_predicate @ 0x1C3C */
int __fastcall opaque_predicate(int x)
{
  return 2 * x;
}


/* Function: overlapped_code @ 0x1C44 */
int __fastcall overlapped_code(int x)
{
  if ( (x & 1) != 0 )
    return 3 * x + 1;
  else
    return x / 2;
}


/* Function: test_control_flow_l3 @ 0x1C5C */
void __cdecl test_control_flow_l3()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int labels[4]; // [xsp+28h] [xbp+28h] BYREF

  puts(asc_2308);
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
  labels[0] = 0;
  labels[1] = 1;
  labels[2] = 2;
  labels[3] = 3;
  v5 = computed_goto(labels, 2);
  __printf_chk(1, "CF-L3-07 (computed_goto): %d\n", v5);
  __printf_chk(1, "CF-L3-08 (obfuscated_cf): %d\n", 10);
  __printf_chk(1, "CF-L3-09 (opaque_predicate): %d\n", 10);
  __printf_chk(1, "CF-L3-10 (overlapped_code): %d\n", 16);
}


/* Function: main @ 0x1E00 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x1E20 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x14248 */

/* FAILED to decompile: __libc_start_main @ 0x14250 */

/* FAILED to decompile: __cxa_finalize @ 0x14258 */

/* FAILED to decompile: __printf_chk @ 0x14260 */

/* FAILED to decompile: __stack_chk_fail @ 0x14268 */

/* FAILED to decompile: abort @ 0x14278 */

/* FAILED to decompile: puts @ 0x14280 */

/* FAILED to decompile: __longjmp_chk @ 0x14288 */

/* FAILED to decompile: __gmon_start__ @ 0x14298 */

/* Total functions decompiled: 74, failed: 9 */
