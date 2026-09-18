/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x840 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_860 @ 0x860 */
void sub_860()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x980 */
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


/* Function: call_weak_fn @ 0x9B4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x9D0 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xA00 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xA40 */
__int64 _do_global_dtors_aux()
{
  __int64 result; // x0

  result = (unsigned __int8)completed_0;
  if ( !completed_0 )
  {
    if ( &_cxa_finalize )
      __cxa_finalize(_dso_handle);
    deregister_tm_clones();
    result = 1;
    completed_0 = 1;
  }
  return result;
}


/* Function: frame_dummy @ 0xA90 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_fake_branch @ 0xA94 */
int __cdecl param_fake_branch(int x)
{
  return x;
}


/* Function: call_fake_branch @ 0xABC */
int __cdecl call_fake_branch()
{
  return param_fake_branch(10);
}


/* Function: param_opaque_predicate @ 0xAD4 */
int __cdecl param_opaque_predicate(int x)
{
  int a; // [xsp+Ch] [xbp-18h]
  int b; // [xsp+10h] [xbp-14h]
  int temp; // [xsp+20h] [xbp-4h]

  a = x;
  b = x + 1;
  while ( b )
  {
    temp = b;
    b = a % b;
    a = temp;
  }
  if ( x * x + 2 * x + 1 == (x + 1) * (x + 1) && a == 1 )
    return 2 * (x + 5);
  else
    return 3 * x + 20;
}


/* Function: call_opaque_predicate @ 0xBD4 */
int __cdecl call_opaque_predicate()
{
  return param_opaque_predicate(5);
}


/* Function: param_instruction_substitution @ 0xBEC */
int __cdecl param_instruction_substitution(int x)
{
  return 6 * x + ((unsigned int)x >> 1) + (x & 0xF) + 15 * x;
}


/* Function: call_instruction_substitution @ 0xC6C */
int __cdecl call_instruction_substitution()
{
  return param_instruction_substitution(10);
}


/* Function: decrypt_string @ 0xC84 */
const char *__cdecl decrypt_string(const char *encrypted, char *buffer, size_t len, char key)
{
  char *p; // [xsp+38h] [xbp+38h]

  strncpy(buffer, encrypted, len);
  buffer[len - 1] = 0;
  for ( p = buffer; *p; ++p )
    *p ^= key;
  return buffer;
}


/* Function: param_string_encryption @ 0xD10 */
int __cdecl param_string_encryption()
{
  int v0; // w0
  char decrypted[32]; // [xsp+18h] [xbp+18h] BYREF

  decrypt_string(encrypted_0, decrypted, 0x20u, 90);
  v0 = strlen(decrypted);
  return v0 + (unsigned __int8)decrypted[0];
}


/* Function: call_string_encryption @ 0xD8C */
int __cdecl call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xDA0 */
int __cdecl param_tail_call_optimized(int n, int acc)
{
  if ( n > 0 )
    return param_tail_call_optimized(n - 1, acc + n);
  else
    return acc;
}


/* Function: call_tail_call_optimized @ 0xDEC */
int __cdecl call_tail_call_optimized()
{
  return param_tail_call_optimized(1000, 0);
}


/* Function: param_non_tail_call @ 0xE08 */
int __cdecl param_non_tail_call(int n)
{
  if ( n > 0 )
    return param_non_tail_call(n - 1) + n;
  else
    return 0;
}


/* Function: call_non_tail_call @ 0xE48 */
int __cdecl call_non_tail_call()
{
  return param_non_tail_call(100);
}


/* Function: param_vectorized_loop @ 0xE60 */
int __cdecl param_vectorized_loop(int *a, int *b, int *c, int n)
{
  int i; // [xsp+20h] [xbp-Ch]
  int sum; // [xsp+24h] [xbp-8h]
  int i_0; // [xsp+28h] [xbp-4h]

  for ( i = 0; i < n; ++i )
    c[i] = a[i] + b[i];
  sum = 0;
  for ( i_0 = 0; i_0 < n; ++i_0 )
    sum += c[i_0];
  return sum;
}


/* Function: call_vectorized_loop @ 0xF2C */
int __cdecl call_vectorized_loop()
{
  int a[8]; // [xsp+18h] [xbp+18h] BYREF
  int b[8]; // [xsp+38h] [xbp+38h] BYREF
  int c[8]; // [xsp+58h] [xbp+58h] BYREF

  *(_OWORD *)a = xmmword_1678;
  *(_OWORD *)&a[4] = xmmword_1688;
  *(_OWORD *)b = xmmword_1698;
  *(_OWORD *)&b[4] = xmmword_16A8;
  memset(c, 0, sizeof(c));
  return param_vectorized_loop(a, b, c, 8);
}


/* Function: lto_target_func @ 0xFBC */
int __cdecl lto_target_func(int x)
{
  return 2 * (x + 5);
}


/* Function: param_link_time_optimization @ 0xFD8 */
int __cdecl param_link_time_optimization(int x)
{
  return lto_target_func(x);
}


/* Function: call_link_time_optimization @ 0xFF4 */
int __cdecl call_link_time_optimization()
{
  return param_link_time_optimization(5);
}


/* Function: div_zero_handler @ 0x100C */
void __cdecl __noreturn div_zero_handler(int sig)
{
  div_zero_caught = 1;
  longjmp(jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0x1038 */
int __cdecl param_division_by_zero(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(jmp_buffer) )
    return -1;
  else
    return 10 / x;
}


/* Function: call_division_by_zero @ 0x108C */
int __cdecl call_division_by_zero()
{
  int r1; // [xsp+18h] [xbp+18h]
  int r2; // [xsp+1Ch] [xbp+1Ch]

  r1 = param_division_by_zero(5);
  r2 = param_division_by_zero(0);
  signal(8, 0);
  return r1 + r2;
}


/* Function: segv_handler @ 0x10CC */
void __cdecl __noreturn segv_handler(int sig)
{
  segv_caught = 1;
  longjmp(segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0x10F8 */
int __cdecl param_null_pointer_deref(int *p)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(segv_buffer) )
    return -1;
  else
    return *p;
}


/* Function: call_null_pointer_deref @ 0x1148 */
int __cdecl call_null_pointer_deref()
{
  int valid; // [xsp+1Ch] [xbp+1Ch] BYREF
  int r1; // [xsp+20h] [xbp+20h]
  int r2; // [xsp+24h] [xbp+24h]

  valid = 42;
  r1 = param_null_pointer_deref(&valid);
  r2 = param_null_pointer_deref(0);
  signal(11, 0);
  return r1 + r2;
}


/* Function: param_buffer_overflow_stack @ 0x11CC */
int __cdecl param_buffer_overflow_stack(int x)
{
  int i; // [xsp+28h] [xbp+28h]
  char buffer[8]; // [xsp+30h] [xbp+30h]

  for ( i = 0; i <= 16; ++i )
    buffer[i] = 65;
  return x;
}


/* Function: param_buffer_overflow_heap @ 0x1278 */
int __cdecl param_buffer_overflow_heap(int x)
{
  int i; // [xsp+24h] [xbp+24h]
  char *heap_buffer; // [xsp+28h] [xbp+28h]

  heap_buffer = (char *)malloc(0x10u);
  if ( !heap_buffer )
    return -2;
  for ( i = 0; i <= 32; ++i )
    heap_buffer[i] = 66;
  free(heap_buffer);
  return x;
}


/* Function: call_buffer_overflow @ 0x12EC */
int __cdecl call_buffer_overflow()
{
  int r1; // [xsp+18h] [xbp+18h]

  r1 = param_buffer_overflow_stack(10);
  return r1 + param_buffer_overflow_heap(20);
}


/* Function: param_integer_overflow @ 0x1320 */
int __cdecl param_integer_overflow(int a, int b)
{
  int signed_sum; // [xsp+8h] [xbp-10h]

  signed_sum = a + b;
  if ( a > 0 && b > 0 && signed_sum < 0 )
    return -1;
  if ( a >= 0 || b >= 0 || signed_sum <= 0 )
    return a + b;
  return -2;
}


/* Function: call_integer_overflow @ 0x13C0 */
int __cdecl call_integer_overflow()
{
  int r1; // [xsp+18h] [xbp+18h]

  r1 = param_integer_overflow(1000000000, 1000000000);
  return r1 + param_integer_overflow(-1, 1);
}


/* Function: param_undefined_behavior @ 0x1404 */
int __cdecl param_undefined_behavior(int i)
{
  return 2 * i;
}


/* Function: call_undefined_behavior @ 0x1424 */
int __cdecl call_undefined_behavior()
{
  return param_undefined_behavior(5);
}


/* Function: param_implementation_defined @ 0x1444 */
int __cdecl param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0x14EC */
int __cdecl call_implementation_defined()
{
  return param_implementation_defined();
}


/* Function: test_obf_opt_edge @ 0x1500 */
void __cdecl test_obf_opt_edge()
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
  unsigned int v9; // w0
  unsigned int v10; // w0
  unsigned int v11; // w0
  unsigned int v12; // w0
  unsigned int v13; // w0

  puts(asc_16B8);
  v0 = call_fake_branch();
  printf(aObfL402D, v0);
  v1 = call_opaque_predicate();
  printf(aObfL403D, v1);
  v2 = call_instruction_substitution();
  printf(aObfL404D, v2);
  v3 = call_string_encryption();
  printf(aObfL405D, v3);
  v4 = call_tail_call_optimized();
  printf(aOptL401, v4);
  v5 = call_non_tail_call();
  printf(aOptL401_0, v5);
  v6 = call_vectorized_loop();
  printf(aOptL402, v6);
  v7 = call_link_time_optimization();
  printf(aOptL501LtoD, v7);
  v8 = call_division_by_zero();
  printf(aEdgeL301D, v8);
  v9 = call_null_pointer_deref();
  printf(aEdgeL302D, v9);
  v10 = call_buffer_overflow();
  printf(aEdgeL303D, v10);
  v11 = call_integer_overflow();
  printf(aEdgeL304D, v11);
  v12 = call_undefined_behavior();
  printf(aEdgeL401D, v12);
  v13 = call_implementation_defined();
  printf(aEdgeL402D, v13);
}


/* Function: main @ 0x1638 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0x1650 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x132F0 */

/* FAILED to decompile: _setjmp @ 0x132F8 */

/* FAILED to decompile: __libc_start_main @ 0x13300 */

/* FAILED to decompile: __cxa_finalize @ 0x13308 */

/* FAILED to decompile: signal @ 0x13310 */

/* FAILED to decompile: malloc @ 0x13318 */

/* FAILED to decompile: __stack_chk_fail @ 0x13320 */

/* FAILED to decompile: abort @ 0x13330 */

/* FAILED to decompile: puts @ 0x13338 */

/* FAILED to decompile: free @ 0x13340 */

/* FAILED to decompile: longjmp @ 0x13348 */

/* FAILED to decompile: strncpy @ 0x13350 */

/* FAILED to decompile: printf @ 0x13358 */

/* FAILED to decompile: __gmon_start__ @ 0x13368 */

/* Total functions decompiled: 44, failed: 14 */
