/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_clang_O1_g
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
int __fastcall sequential_ops(int a, int b, int c)
{
  return 2 * (b + a) - c;
}


/* Function: single_if @ 0xA64 */
int __fastcall single_if(int x)
{
  return x << (x > 0);
}


/* Function: if_else @ 0xA74 */
int __fastcall if_else(int x)
{
  return x > 0;
}


/* Function: nested_if_2 @ 0xA80 */
int __fastcall nested_if_2(int a, int b)
{
  if ( a <= 0 )
    return 0;
  else
    return (b & ~(b >> 31)) + a;
}


/* Function: nested_if_deep @ 0xA94 */
int __fastcall nested_if_deep(int a, int b, int c, int d, int e)
{
  if ( a < 1 )
    return 0;
  if ( b < 1 )
    return 1;
  if ( c < 1 )
    return 2;
  if ( d < 1 )
    return 3;
  if ( e <= 0 )
    return 4;
  return 5;
}


/* Function: if_elseif_chain @ 0xAE4 */
int __fastcall if_elseif_chain(int x)
{
  if ( (unsigned int)x >= 3 )
    return -1;
  else
    return 10 * x + 10;
}


/* Function: if_elseif_long @ 0xAFC */
int __fastcall if_elseif_long(int x)
{
  if ( (unsigned int)x >= 5 )
    return -1;
  else
    return 100 * x + 100;
}


/* Function: switch_small @ 0xB14 */
int __fastcall switch_small(int op)
{
  if ( (unsigned int)op > 3 )
    return -1;
  else
    return dword_1EE0[op];
}


/* Function: switch_large @ 0xB34 */
int __fastcall switch_large(int op)
{
  if ( (unsigned int)op >= 0xA )
    return -1;
  else
    return 10 * op;
}


/* Function: switch_default @ 0xB48 */
int __fastcall switch_default(int op)
{
  if ( (unsigned int)(op - 1) >= 3 )
    return 0;
  else
    return 100 * (op - 1) + 100;
}


/* Function: switch_fallthrough @ 0xB64 */
int __fastcall switch_fallthrough(int op)
{
  int v1; // w8

  v1 = 0;
  switch ( op )
  {
    case 1:
      return v1 + op;
    case 2:
LABEL_5:
      v1 += 2 * op;
      return v1 + op;
    case 3:
      v1 = 12;
      goto LABEL_5;
  }
  return -1;
}


/* Function: loop_for_fixed @ 0xB98 */
int __fastcall loop_for_fixed(int n)
{
  if ( n < 1 )
    return 0;
  else
    return (((unsigned int)(n - 1) * (unsigned __int64)(unsigned int)(n - 2)) >> 1) + n - 1;
}


/* Function: loop_while @ 0xBC0 */
int __fastcall loop_while(int x)
{
  int v1; // w8
  unsigned int v2; // w11

  v1 = 0;
  if ( x )
  {
    do
    {
      ++v1;
      v2 = x + 9;
      x /= 10;
    }
    while ( v2 > 0x12 );
  }
  if ( v1 )
    return v1;
  else
    return 1;
}


/* Function: loop_dowhile @ 0xC00 */
int __fastcall loop_dowhile(int x)
{
  int result; // w0
  unsigned int v3; // w11

  result = 0;
  do
  {
    ++result;
    v3 = x + 9;
    x /= 10;
  }
  while ( v3 > 0x12 );
  return result;
}


/* Function: loop_nested @ 0xC38 */
int __fastcall loop_nested(int m, int n)
{
  int v2; // w8
  int v3; // w8

  if ( n <= 0 )
    v2 = 0;
  else
    v2 = n;
  v3 = v2 * m;
  if ( m <= 0 )
    return 0;
  else
    return v3;
}


/* Function: loop_break @ 0xC50 */
int __fastcall loop_break(int target)
{
  __int64 v2; // x0

  v2 = 0;
  while ( dword_18D8[v2] != target )
  {
    if ( ++v2 == 5 )
    {
      LODWORD(v2) = -1;
      return v2;
    }
  }
  return v2;
}


/* Function: loop_continue @ 0xC80 */
int __fastcall loop_continue(int n)
{
  int v1; // w9
  int v2; // w8

  if ( n < 1 )
    return 0;
  v1 = 0;
  v2 = 0;
  do
  {
    ++v1;
    v2 += (v1 << 31 >> 31) & v1;
  }
  while ( n != v1 );
  return v2;
}


/* Function: goto_forward @ 0xCBC */
int __fastcall goto_forward(int x)
{
  int v1; // w8

  if ( x <= 1 )
    v1 = 1;
  else
    v1 = x;
  return 2 * x * v1;
}


/* Function: goto_backward @ 0xCD0 */
int __fastcall goto_backward(int x)
{
  int v2; // w9
  int result; // w0

  if ( x < 1 )
    return 1;
  v2 = 0;
  result = 1;
  do
    result *= ++v2;
  while ( x != v2 );
  return result;
}


/* Function: ternary_op @ 0xD00 */
int __fastcall ternary_op(int a, int b)
{
  if ( a <= b )
    return b;
  return a;
}


/* Function: test_control_flow_l1 @ 0xD0C */
void __cdecl test_control_flow_l1()
{
  puts(asc_1E71);
  printf("CF-L1-01 (sequential_ops): %d\n", 21);
  printf("CF-L1-02 (single_if): %d\n", 20);
  printf("CF-L1-02 (single_if): %d\n", -5);
  printf("CF-L1-03 (if_else): %d\n", 1);
  printf("CF-L1-03 (if_else): %d\n", 0);
  printf("CF-L1-04 (nested_if_2): %d\n", 15);
  printf("CF-L1-04 (nested_if_2): %d\n", 10);
  printf("CF-L1-04 (nested_if_2): %d\n", 0);
  printf("CF-L1-05 (nested_if_deep): %d\n", 5);
  printf("CF-L1-06 (if_elseif_chain): %d\n", 20);
  printf("CF-L1-07 (if_elseif_long): %d\n", 400);
  printf("CF-L1-08 (switch_small): %d\n", 50);
  printf("CF-L1-09 (switch_large): %d\n", 70);
  printf("CF-L1-10 (switch_default): %d\n", 0);
  printf("CF-L1-11 (switch_fallthrough): %d\n", 21);
  printf("CF-L1-12 (loop_for_fixed): %d\n", 45);
  printf("CF-L1-13 (loop_while): %d\n", 5);
  printf("CF-L1-14 (loop_dowhile): %d\n", 4);
  printf("CF-L1-15 (loop_nested): %d\n", 12);
  printf("CF-L1-16 (loop_break): %d\n", 2);
  printf("CF-L1-16 (loop_break): %d\n", -1);
  printf("CF-L1-17 (loop_continue): %d\n", 25);
  printf("CF-L1-18 (goto_forward): %d\n", 50);
  printf("CF-L1-18 (goto_forward): %d\n", -6);
  printf("CF-L1-19 (goto_backward): %d\n", 120);
  printf("CF-L1-20 (ternary_op): %d\n", 10);
  printf("CF-L1-20 (ternary_op): %d\n", 8);
}


/* Function: loop_multi_exit @ 0xEDC */
int __fastcall loop_multi_exit(int target)
{
  int v1; // w12
  __int64 v2; // x8
  _DWORD *v3; // x10
  __int64 v4; // x14
  _BOOL4 v5; // w13
  int v6; // w13
  int v7; // w14

  v2 = 0;
  v3 = &unk_18F0;
  do
  {
    if ( *((_DWORD *)&unk_18EC + 4 * v2) == target )
    {
      LODWORD(v4) = 0;
      v5 = 1;
LABEL_8:
      v1 = v4 + 10 * v2;
      v7 = 1;
      if ( v5 )
        goto LABEL_11;
    }
    else
    {
      v4 = 0;
      while ( v4 != 3 )
      {
        v6 = v3[v4++];
        if ( v6 == target )
        {
          v5 = (unsigned __int64)(v4 - 1) < 3;
          goto LABEL_8;
        }
      }
    }
    ++v2;
    v3 += 4;
  }
  while ( v2 != 3 );
  v7 = 2;
LABEL_11:
  if ( v7 == 2 )
    return -1;
  else
    return v1;
}


/* Function: infinite_loop @ 0xF74 */
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


/* Function: multi_return @ 0xFA0 */
int __fastcall multi_return(int x)
{
  int v1; // w9

  if ( x < 0 )
    return -1;
  v1 = 2 * x;
  if ( (x & 1) != 0 )
    v1 = x + 1;
  if ( x <= 50 )
    return v1;
  else
    return -2;
}


/* Function: conditional_return @ 0xFC8 */
int __fastcall conditional_return(int x)
{
  if ( x <= 0 )
    return -x;
  else
    return 2 * x;
}


/* Function: duffs_device @ 0xFD8 */
int __fastcall duffs_device(int *dst, int *src, int n)
{
  int v3; // w8
  int v4; // w9
  int v5; // w8
  int v6; // t1
  int v7; // t1
  int v8; // t1
  int v9; // t1
  int v10; // t1
  int v11; // t1
  int v12; // t1
  int v13; // t1
  bool v14; // vf

  v3 = -1;
  if ( n >= 1 )
  {
    v4 = n + 14;
    if ( n + 7 >= 0 )
      v4 = n + 7;
    v5 = v4 >> 3;
    switch ( n - (n & 0x7FFFFFF8) )
    {
      case 0:
        goto LABEL_5;
      case 1:
        goto LABEL_12;
      case 2:
        goto LABEL_11;
      case 3:
        goto LABEL_10;
      case 4:
        goto LABEL_9;
      case 5:
        goto LABEL_8;
      case 6:
        goto LABEL_7;
      case 7:
        while ( 1 )
        {
          v7 = *src++;
          *dst++ = v7;
LABEL_7:
          v8 = *src++;
          *dst++ = v8;
LABEL_8:
          v9 = *src++;
          *dst++ = v9;
LABEL_9:
          v10 = *src++;
          *dst++ = v10;
LABEL_10:
          v11 = *src++;
          *dst++ = v11;
LABEL_11:
          v12 = *src++;
          *dst++ = v12;
LABEL_12:
          v13 = *src++;
          v14 = __OFSUB__(v5--, 1);
          *dst++ = v13;
          if ( (v5 < 0) ^ v14 | (v5 == 0) )
            break;
LABEL_5:
          v6 = *src++;
          *dst++ = v6;
        }
        break;
      default:
        return n;
    }
    return n;
  }
  return v3;
}


/* Function: loop_complex_cond @ 0x107C */
int __fastcall loop_complex_cond(int x)
{
  unsigned int v1; // w10
  int v2; // w8
  int v3; // w11
  unsigned int v4; // w9

  if ( x < 1 )
  {
    v2 = 0;
    v4 = 0;
  }
  else
  {
    v1 = 0;
    v2 = 0;
    do
    {
      v3 = x;
      v2 += 2;
      --x;
      v4 = v1 + 1;
      if ( v3 < 2 )
        break;
      if ( v2 >= x )
        break;
    }
    while ( v1++ < 9 );
  }
  return x + v2 + v4;
}


/* Function: loop_modify_var @ 0x10D0 */
int __fastcall loop_modify_var(int n)
{
  int v1; // w9
  int v2; // w8
  int v3; // w10

  if ( n < 1 )
    return 0;
  v1 = 0;
  v2 = 0;
  do
  {
    v3 = v1 + 2;
    if ( v1 <= 5 )
      v3 = v1;
    v2 += v1;
    v1 = v3 + 1;
  }
  while ( v3 + 1 < n );
  return v2;
}


/* Function: loop_external_state @ 0x1110 */
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


/* Function: recursion_factorial @ 0x1130 */
int __fastcall recursion_factorial(int n)
{
  if ( n >= 2 )
    return recursion_factorial(n - 1) * n;
  else
    return 1;
}


/* Function: tail_recursion @ 0x1168 */
int __fastcall tail_recursion(int n, int acc)
{
  if ( n >= 2 )
    return tail_recursion(n - 1, acc * n);
  return acc;
}


/* Function: indirect_recursion_a @ 0x1194 */
int __fastcall indirect_recursion_a(int n, int depth)
{
  int v2; // w8
  int v3; // w0
  int v4; // w8

  if ( depth >= 1 )
  {
    if ( (n & 1) != 0 )
    {
      v4 = 3 * n;
      if ( depth < 2 )
        return v4 + 1;
      v3 = v4 + 2;
      return indirect_recursion_a(v3, depth - 2);
    }
    if ( n >= 0 )
      v2 = n;
    else
      v2 = n + 1;
    n = v2 >> 1;
    if ( depth >= 2 )
    {
      v3 = n + 1;
      return indirect_recursion_a(v3, depth - 2);
    }
  }
  return n;
}


/* Function: call_func_ptr @ 0x11EC */
int __fastcall call_func_ptr(int (*f)(int), int x)
{
  return f(x);
}


/* Function: call_func_ptr_array @ 0x1208 */
int __fastcall call_func_ptr_array(int idx, int x)
{
  if ( (unsigned int)idx <= 2 )
    return ((__int64 (__fastcall *)(_QWORD))off_12D30[idx])((unsigned int)x);
  else
    return -1;
}


/* Function: double_value @ 0x123C */
int __fastcall double_value(int x)
{
  return 2 * x;
}


/* Function: triple_value @ 0x1244 */
int __fastcall triple_value(int x)
{
  return 3 * x;
}


/* Function: call_virtual_func @ 0x124C */
int __fastcall call_virtual_func(void *obj, int x)
{
  return 2 * x;
}


/* Function: process_with_callback @ 0x1254 */
int __fastcall process_with_callback(int *arr, int n, int (*cb)(int))
{
  int v5; // w20
  __int64 v6; // x22
  int v7; // t1

  if ( n < 1 )
    return 0;
  v5 = 0;
  v6 = (unsigned int)n;
  do
  {
    v7 = *arr++;
    --v6;
    v5 += cb(v7);
  }
  while ( v6 );
  return v5;
}


/* Function: test_control_flow_l2 @ 0x12AC */
void __cdecl test_control_flow_l2()
{
  int v0; // w11
  int v1; // w8
  __int64 v2; // x9
  _DWORD *v3; // x10
  __int64 v4; // x12
  int v5; // w13
  _BOOL4 v6; // w13
  int v7; // w12
  int v8; // w1
  int i; // w1
  unsigned int v10; // w21
  int v11; // w19
  int v12; // w8
  unsigned int v13; // w9
  int j; // w1
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int v18; // w0

  puts(asc_1E95);
  v1 = 0;
  v2 = 0;
  v3 = &unk_18F0;
  do
  {
    v4 = 0;
    while ( v4 != 3 )
    {
      v5 = v3[v4++];
      if ( v5 == 7 )
      {
        v0 = v4 - v1;
        v6 = (unsigned __int64)(v4 - 1) < 3;
        v7 = 1;
        if ( v6 )
          goto LABEL_8;
        break;
      }
    }
    ++v2;
    v1 -= 10;
    v3 += 4;
  }
  while ( v2 != 3 );
  v7 = 2;
LABEL_8:
  if ( v7 == 2 )
    v8 = -1;
  else
    v8 = v0;
  printf("CF-L2-01 (loop_multi_exit): %d\n", v8);
  for ( i = 0; i != 1001; ++i )
    ;
  printf("CF-L2-02 (infinite_loop): %d\n", 1001);
  v10 = -1;
  printf("CF-L2-03 (multi_return): %d\n", -1);
  printf("CF-L2-03 (multi_return): %d\n", -2);
  printf("CF-L2-03 (multi_return): %d\n", 4);
  v11 = 10;
  printf("CF-L2-04 (conditional_return): %d\n", 10);
  printf("CF-L2-04 (conditional_return): %d\n", 5);
  printf("CF-L2-05 (duffs_device): %d\n", 8);
  v12 = 11;
  do
  {
    v13 = v11 - 8;
    v11 += 2;
    if ( v13 >= v12 - 2 )
      break;
    ++v10;
    --v12;
  }
  while ( v10 < 9 );
  printf("CF-L2-06 (loop_complex_cond): %d\n", v11);
  printf("CF-L2-07 (loop_modify_var): %d\n", 30);
  for ( j = 0; j != 101; ++j )
    ;
  printf("CF-L2-08 (loop_external_state): %d\n", 101);
  v15 = recursion_factorial(5);
  printf("CF-L2-09 (recursion_factorial): %d\n", v15);
  v16 = tail_recursion(5, 1);
  printf("CF-L2-10 (tail_recursion): %d\n", v16);
  v17 = indirect_recursion_a(10, 3);
  printf("CF-L2-11 (indirect_recursion): %d\n", v17);
  printf("CF-L2-12 (call_func_ptr): %d\n", 10);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", 10);
  v18 = recursion_factorial(5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v18);
  printf("CF-L2-15 (process_with_callback): %d\n", 30);
}


/* Function: non_local_jump @ 0x14F8 */
int __fastcall non_local_jump(int x)
{
  if ( _setjmp(&jump_buffer) )
    return -1;
  if ( x < 0 )
    longjmp(&jump_buffer, 1);
  if ( x >= 101 )
    longjmp(&jump_buffer, 2);
  return 2 * x;
}


/* Function: cpp_exception @ 0x155C */
int __fastcall cpp_exception(int x)
{
  int v1; // w8

  if ( x <= 100 )
    v1 = 2 * x;
  else
    v1 = -2;
  if ( x < 0 )
    return -1;
  else
    return v1;
}


/* Function: large_jump_table @ 0x1578 */
int __fastcall large_jump_table(int op, int a, int b)
{
  if ( (unsigned int)op <= 9 )
    return ((__int64 (__fastcall *)(_QWORD, _QWORD))off_12D48[op])((unsigned int)a, (unsigned int)b);
  else
    return -1;
}


/* Function: op_add @ 0x15B0 */
int __fastcall op_add(int a, int b)
{
  return b + a;
}


/* Function: op_sub @ 0x15B8 */
int __fastcall op_sub(int a, int b)
{
  return a - b;
}


/* Function: op_mul @ 0x15C0 */
int __fastcall op_mul(int a, int b)
{
  return b * a;
}


/* Function: op_div @ 0x15C8 */
int __fastcall op_div(int a, int b)
{
  if ( b )
    return a / b;
  else
    return 0;
}


/* Function: op_mod @ 0x15DC */
int __fastcall op_mod(int a, int b)
{
  if ( b )
    return a % b;
  else
    return 0;
}


/* Function: op_and @ 0x15F4 */
int __fastcall op_and(int a, int b)
{
  return b & a;
}


/* Function: op_or @ 0x15FC */
int __fastcall op_or(int a, int b)
{
  return b | a;
}


/* Function: op_xor @ 0x1604 */
int __fastcall op_xor(int a, int b)
{
  return b ^ a;
}


/* Function: op_shl @ 0x160C */
int __fastcall op_shl(int a, int b)
{
  return a << b;
}


/* Function: op_shr @ 0x1614 */
int __fastcall op_shr(int a, int b)
{
  return a >> b;
}


/* Function: conditional_func_ptr @ 0x161C */
int __fastcall conditional_func_ptr(int mode, int x)
{
  int (__fastcall *v2)(int); // x8

  v2 = recursion_factorial;
  if ( mode == 1 )
    v2 = triple_value;
  if ( !mode )
    v2 = double_value;
  return v2(x);
}


/* Function: state_machine @ 0x165C */
int __fastcall state_machine(int event, int state)
{
  int result; // w0
  int v3; // w8

  switch ( state )
  {
    case 0:
      result = event == 1;
      break;
    case 1:
      if ( event == 99 )
        v3 = 3;
      else
        v3 = 1;
      if ( event == 2 )
        result = 2;
      else
        result = v3;
      break;
    case 2:
      goto LABEL_4;
    case 3:
      if ( event )
        result = 3;
      else
        result = 0;
      break;
    default:
      state = 3;
LABEL_4:
      result = state;
      break;
  }
  return result;
}


/* Function: fsm_func_table @ 0x16C0 */
int __fastcall fsm_func_table(int event, int state)
{
  if ( (unsigned int)state <= 3 )
    return ((__int64 (__fastcall *)(int))off_12D98[state])(event);
  else
    return 3;
}


/* Function: state_idle @ 0x16F0 */
int __fastcall state_idle(int event)
{
  return event == 1;
}


/* Function: state_processing @ 0x16FC */
int __fastcall state_processing(int event)
{
  int v1; // w8

  if ( event == 99 )
    v1 = 3;
  else
    v1 = 1;
  if ( event == 2 )
    return 2;
  else
    return v1;
}


/* Function: state_done @ 0x1714 */
int __fastcall state_done(int event)
{
  return 2;
}


/* Function: state_error @ 0x171C */
int __fastcall state_error(int event)
{
  if ( event )
    return 3;
  else
    return 0;
}


/* Function: computed_goto @ 0x172C */
__int64 __fastcall computed_goto(int *labels, unsigned int idx)
{
  if ( idx <= 3 )
    return ((__int64 (__fastcall *)(int *))off_12DB8[idx])(labels);
  else
    return 0xFFFFFFFFLL;
}


/* Function: sub_174C @ 0x174C */
__int64 sub_174C()
{
  return 0;
}


/* Function: sub_1754 @ 0x1754 */
__int64 sub_1754()
{
  return 20;
}


/* Function: sub_175C @ 0x175C */
__int64 sub_175C()
{
  return 30;
}


/* Function: sub_1764 @ 0x1764 */
__int64 sub_1764()
{
  return 10;
}


/* Function: obfuscated_cf @ 0x176C */
int __fastcall obfuscated_cf(int x)
{
  return 2 * x;
}


/* Function: opaque_predicate @ 0x1774 */
int __fastcall opaque_predicate(int x)
{
  return 2 * x;
}


/* Function: overlapped_code @ 0x177C */
int __fastcall overlapped_code(int x)
{
  int v1; // w8
  int v2; // w8

  if ( x >= 0 )
    v1 = x;
  else
    v1 = x + 1;
  v2 = v1 >> 1;
  if ( (x & 1) != 0 )
    return 3 * x + 1;
  else
    return v2;
}


/* Function: test_control_flow_l3 @ 0x1798 */
void __cdecl test_control_flow_l3()
{
  int v0; // w0
  int v1; // w0
  int *v2; // x0
  int v3; // w0

  puts(asc_1EB9);
  v0 = non_local_jump(5);
  printf("CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  printf("CF-L3-01 (non_local_jump): %d\n", v1);
  printf("CF-L3-02 (cpp_exception): %d\n", 10);
  printf("CF-L3-02 (cpp_exception): %d\n", -1);
  printf("CF-L3-03 (large_jump_table): %d\n", 15);
  printf("CF-L3-04 (conditional_func_ptr): %d\n", 10);
  printf("CF-L3-05 (state_machine): %d\n", 1);
  v2 = (int *)printf("CF-L3-06 (fsm_func_table): %d\n", 2);
  v3 = computed_goto(v2, 2u);
  printf("CF-L3-07 (computed_goto): %d\n", v3);
  printf("CF-L3-08 (obfuscated_cf): %d\n", 10);
  printf("CF-L3-09 (opaque_predicate): %d\n", 10);
  printf("CF-L3-10 (overlapped_code): %d\n", 16);
}


/* Function: main @ 0x1894 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x18B4 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x131E0 */

/* FAILED to decompile: __libc_start_main @ 0x131E8 */

/* FAILED to decompile: __cxa_finalize @ 0x131F0 */

/* FAILED to decompile: abort @ 0x131F8 */

/* FAILED to decompile: puts @ 0x13200 */

/* FAILED to decompile: longjmp @ 0x13208 */

/* FAILED to decompile: printf @ 0x13210 */

/* FAILED to decompile: __gmon_start__ @ 0x13220 */

/* Total functions decompiled: 78, failed: 8 */
