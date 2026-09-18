/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_O1_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x848 */
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


/* Function: div_zero_handler @ 0xA94 */
void __fastcall __noreturn div_zero_handler(int sig)
{
  div_zero_caught = 1;
  __longjmp_chk(jmp_buffer);
}


/* Function: segv_handler @ 0xAB4 */
void __fastcall __noreturn segv_handler(int sig)
{
  segv_caught = 1;
  __longjmp_chk(segv_buffer);
}


/* Function: param_fake_branch @ 0xAD4 */
int __fastcall param_fake_branch(int x)
{
  return x;
}


/* Function: call_fake_branch @ 0xAD8 */
int __cdecl call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0xAE0 */
int __fastcall param_opaque_predicate(int x)
{
  int v1; // w1
  _BOOL4 v2; // w6
  int v3; // w2
  int v4; // w3

  v1 = x + 1;
  v2 = 2 * x + x * x + 1 == v1 * v1;
  if ( x == -1 )
    return 3 * x + 20;
  v3 = x;
  do
  {
    v4 = v1;
    v1 = v3 % v1;
    v3 = v4;
  }
  while ( v1 );
  if ( v2 && v4 == 1 )
    return 2 * x + 10;
  else
    return 3 * x + 20;
}


/* Function: call_opaque_predicate @ 0xB38 */
int __cdecl call_opaque_predicate()
{
  return param_opaque_predicate(5);
}


/* Function: param_instruction_substitution @ 0xB50 */
int __fastcall param_instruction_substitution(int x)
{
  return 6 * x + ((unsigned int)x >> 1) + (x & 0xF) + 15 * x;
}


/* Function: call_instruction_substitution @ 0xB74 */
int __cdecl call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0xB7C */
const char *__fastcall decrypt_string(const char *encrypted, char *buffer, size_t len, char key)
{
  char v7; // w2
  char *v8; // x3
  int v9; // t1

  strncpy(buffer, encrypted, len);
  buffer[len - 1] = 0;
  v7 = *buffer;
  if ( *buffer )
  {
    v8 = buffer;
    do
    {
      *v8 = key ^ v7;
      v9 = (unsigned __int8)*++v8;
      v7 = v9;
    }
    while ( v9 );
  }
  return buffer;
}


/* Function: param_string_encryption @ 0xBDC */
int __cdecl param_string_encryption()
{
  int v0; // w0
  char decrypted[32]; // [xsp+28h] [xbp+28h] BYREF

  decrypt_string(encrypted_0, decrypted, 0x20u, 90);
  v0 = strlen(decrypted);
  return (unsigned __int8)decrypted[0] + v0;
}


/* Function: call_string_encryption @ 0xC54 */
int __cdecl call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xC68 */
int __fastcall param_tail_call_optimized(int n, int acc)
{
  if ( n <= 0 )
    return acc;
  else
    return param_tail_call_optimized(n - 1, n + acc);
}


/* Function: call_tail_call_optimized @ 0xC94 */
int __cdecl call_tail_call_optimized()
{
  return param_tail_call_optimized(1000, 0);
}


/* Function: param_non_tail_call @ 0xCB0 */
int __fastcall param_non_tail_call(int n)
{
  if ( n <= 0 )
    return 0;
  else
    return param_non_tail_call(n - 1) + n;
}


/* Function: call_non_tail_call @ 0xCE8 */
int __cdecl call_non_tail_call()
{
  return param_non_tail_call(100);
}


/* Function: param_vectorized_loop @ 0xD00 */
int __fastcall param_vectorized_loop(int *a, int *b, int *c, int n)
{
  __int64 v4; // x4
  __int64 v5; // x1
  int result; // w0

  if ( n <= 0 )
    return 0;
  v4 = 0;
  do
  {
    c[v4] = a[v4] + b[v4];
    ++v4;
  }
  while ( n > (int)v4 );
  v5 = 0;
  result = 0;
  do
    result += c[v5++];
  while ( n > (int)v5 );
  return result;
}


/* Function: call_vectorized_loop @ 0xD50 */
int __cdecl call_vectorized_loop()
{
  int a[8]; // [xsp+18h] [xbp+18h] BYREF
  int b[8]; // [xsp+38h] [xbp+38h] BYREF
  int c[8]; // [xsp+58h] [xbp+58h] BYREF

  *(_OWORD *)a = xmmword_13B0;
  *(_OWORD *)&a[4] = xmmword_13C0;
  *(_OWORD *)b = xmmword_13D0;
  *(_OWORD *)&b[4] = xmmword_13E0;
  memset(c, 0, sizeof(c));
  return param_vectorized_loop(a, b, c, 8);
}


/* Function: param_link_time_optimization @ 0xDC8 */
int __fastcall param_link_time_optimization(int x)
{
  return 2 * (x + 5);
}


/* Function: call_link_time_optimization @ 0xDD4 */
int __cdecl call_link_time_optimization()
{
  return 20;
}


/* Function: param_division_by_zero @ 0xDDC */
int __fastcall param_division_by_zero(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(jmp_buffer) )
    return -1;
  else
    return 10 / x;
}


/* Function: call_division_by_zero @ 0xE28 */
int __cdecl call_division_by_zero()
{
  int v0; // w20
  int v1; // w19

  v0 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return v0 + v1;
}


/* Function: param_null_pointer_deref @ 0xE68 */
int __fastcall param_null_pointer_deref(int *p)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(segv_buffer) )
    return -1;
  else
    return *p;
}


/* Function: call_null_pointer_deref @ 0xEB0 */
int __cdecl call_null_pointer_deref()
{
  int v0; // w19
  int v1; // w20
  int valid; // [xsp+24h] [xbp+24h] BYREF

  valid = 42;
  v0 = param_null_pointer_deref(&valid);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return v0 + v1;
}


/* Function: param_buffer_overflow_stack @ 0xF2C */
int __fastcall param_buffer_overflow_stack(int x)
{
  return x;
}


/* Function: param_buffer_overflow_heap @ 0xF30 */
int __fastcall param_buffer_overflow_heap(int x)
{
  void *v2; // x0
  int v3; // w1

  v2 = malloc(0x10u);
  if ( !v2 )
    return -2;
  v3 = 33;
  do
    --v3;
  while ( v3 );
  free(v2);
  return x;
}


/* Function: call_buffer_overflow @ 0xF74 */
int __cdecl call_buffer_overflow()
{
  return param_buffer_overflow_heap(20) + 10;
}


/* Function: param_integer_overflow @ 0xF90 */
int __fastcall param_integer_overflow(int a, int b)
{
  int result; // w0
  bool v4; // zf
  bool v5; // nf
  bool v7; // zf
  bool v8; // nf

  result = a + b;
  if ( a > 0 )
  {
    v4 = b == 0;
    v5 = b < 0;
  }
  else
  {
    v4 = 1;
    v5 = 0;
  }
  if ( !v5 && !v4 && result < 0 )
    return -1;
  if ( (a & b) < 0 )
  {
    v7 = result == 0;
    v8 = result < 0;
  }
  else
  {
    v7 = 1;
    v8 = 0;
  }
  if ( !v8 && !v7 )
    return -2;
  return result;
}


/* Function: call_integer_overflow @ 0xFC4 */
int __cdecl call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0xFD0 */
int __fastcall param_undefined_behavior(int i)
{
  return 2 * i;
}


/* Function: call_undefined_behavior @ 0xFD8 */
int __cdecl call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0xFE0 */
int __cdecl param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0xFE8 */
int __cdecl call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0xFF0 */
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

  puts(asc_1180);
  __printf_chk(1, &unk_11B0, 10);
  v0 = call_opaque_predicate();
  __printf_chk(1, &unk_11D0, v0);
  __printf_chk(1, &unk_11F0, 225);
  v1 = param_string_encryption();
  __printf_chk(1, &unk_1210, v1);
  v2 = call_tail_call_optimized();
  __printf_chk(1, &unk_1230, v2);
  v3 = call_non_tail_call();
  __printf_chk(1, &unk_1260, v3);
  v4 = call_vectorized_loop();
  __printf_chk(1, &unk_1288, v4);
  __printf_chk(1, &unk_12B0, 20);
  v5 = call_division_by_zero();
  __printf_chk(1, &unk_12D0, v5);
  v6 = call_null_pointer_deref();
  __printf_chk(1, &unk_12F0, v6);
  v7 = call_buffer_overflow();
  __printf_chk(1, &unk_1310, v7);
  __printf_chk(1, &unk_1330, 2000000000);
  __printf_chk(1, &unk_1368, 10);
  __printf_chk(1, &unk_1388, 48);
}


/* Function: main @ 0x1148 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0x1160 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x122F0 */

/* FAILED to decompile: _setjmp @ 0x122F8 */

/* FAILED to decompile: __libc_start_main @ 0x12300 */

/* FAILED to decompile: __cxa_finalize @ 0x12308 */

/* FAILED to decompile: signal @ 0x12310 */

/* FAILED to decompile: malloc @ 0x12318 */

/* FAILED to decompile: __printf_chk @ 0x12320 */

/* FAILED to decompile: __stack_chk_fail @ 0x12328 */

/* FAILED to decompile: abort @ 0x12338 */

/* FAILED to decompile: puts @ 0x12340 */

/* FAILED to decompile: free @ 0x12348 */

/* FAILED to decompile: __longjmp_chk @ 0x12350 */

/* FAILED to decompile: strncpy @ 0x12358 */

/* FAILED to decompile: __gmon_start__ @ 0x12368 */

/* Total functions decompiled: 43, failed: 14 */
