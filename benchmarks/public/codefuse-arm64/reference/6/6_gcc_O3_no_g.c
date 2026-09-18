/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_gcc_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x1388 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_13A0 @ 0x13A0 */
void sub_13A0()
{
  JUMPOUT(0);
}


/* Function: main @ 0x17C0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0
  __int64 v4; // x0

  v3 = test_standard_library_functions(argc, argv, envp);
  v4 = test_system_calls(v3);
  test_thread_concurrency(v4);
  return 0;
}


/* Function: init_have_lse_atomics @ 0x17E0 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x1840 */
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


/* Function: call_weak_fn @ 0x1874 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1890 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x18C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1900 */
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


/* Function: frame_dummy @ 0x1950 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: signal_handler @ 0x1960 */
__int64 __fastcall signal_handler(__int64 result)
{
  signal_received = 1;
  signal_number = result;
  return result;
}


/* Function: thread_sum @ 0x1980 */
__int64 __fastcall thread_sum(signed int *a1)
{
  signed int v1; // w2
  signed int v2; // w3
  unsigned int v3; // w5
  int32x4_t v4; // q0
  int v5; // w1
  int32x4_t v6; // q3
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int v9; // w1
  int v10; // w2
  bool v11; // cc
  int v12; // w2

  v1 = *a1;
  v2 = a1[1];
  a1[2] = 0;
  if ( v1 <= v2 )
  {
    v3 = v2 - v1 + 1;
    if ( (unsigned int)(v2 - v1) <= 7 )
    {
      v9 = 0;
    }
    else
    {
      v4 = 0u;
      v5 = 0;
      v6.n128_u64[0] = 0x400000004LL;
      v6.n128_u64[1] = 0x400000004LL;
      v7 = vaddq_s32(vdupq_n_s32(v1), (int32x4_t)xmmword_42A0);
      do
      {
        v8 = v7;
        ++v5;
        v7 = vaddq_s32(v7, v6);
        v4 = vaddq_s32(v4, v8);
      }
      while ( v3 >> 2 != v5 );
      v1 += v3 & 0xFFFFFFFC;
      v9 = vaddvq_s32(v4);
      if ( v3 == (v3 & 0xFFFFFFFC) )
      {
LABEL_14:
        a1[2] = v9;
        return 0;
      }
    }
    v9 += v1;
    if ( v2 >= v1 + 1 )
    {
      v9 += v1 + 1;
      if ( v2 >= v1 + 2 )
      {
        v9 += v1 + 2;
        if ( v2 >= v1 + 3 )
        {
          v9 += v1 + 3;
          if ( v2 >= v1 + 4 )
          {
            v9 += v1 + 4;
            if ( v2 >= v1 + 5 )
            {
              v9 += v1 + 5;
              if ( v2 >= v1 + 6 )
              {
                v9 += v1 + 6;
                v10 = v1 + 7;
                v11 = v2 < v10;
                v12 = v9 + v10;
                if ( !v11 )
                  v9 = v12;
              }
            }
          }
        }
      }
    }
    goto LABEL_14;
  }
  return 0;
}


/* Function: thread_compute @ 0x1A80 */
_DWORD *__fastcall thread_compute(int *a1)
{
  int v1; // w19
  _DWORD *result; // x0

  v1 = *a1;
  result = malloc(4u);
  *result = v1 * v1;
  return result;
}


/* Function: thread_increment @ 0x1AB0 */
__int64 __fastcall thread_increment(int *a1)
{
  int v1; // w22
  int v2; // w19

  v1 = *a1;
  if ( *a1 > 0 )
  {
    v2 = 0;
    do
    {
      pthread_mutex_lock(&counter_mutex);
      ++v2;
      ++shared_counter;
      pthread_mutex_unlock(&counter_mutex);
      usleep(0x3E8u);
    }
    while ( v1 != v2 );
  }
  return 0;
}


/* Function: consumer_thread @ 0x1B24 */
_DWORD *consumer_thread()
{
  int v0; // w19
  _DWORD *result; // x0

  pthread_mutex_lock(&cond_mutex);
  while ( !ready )
    pthread_cond_wait(&cond, &cond_mutex);
  v0 = data;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *result = v0;
  return result;
}


/* Function: producer_thread @ 0x1BA0 */
__int64 producer_thread()
{
  sleep(1u);
  pthread_mutex_lock(&cond_mutex);
  ready = 1;
  data = 42;
  pthread_cond_signal(&cond);
  pthread_mutex_unlock(&cond_mutex);
  return 0;
}


/* Function: thread_atomic_increment @ 0x1C00 */
__int64 __fastcall thread_atomic_increment(int *a1)
{
  int v1; // w21
  unsigned int v2; // w19
  __int64 v3; // x1
  __int64 v4; // x0

  v1 = *a1;
  if ( *a1 > 0 )
  {
    v2 = 0;
    do
    {
      _aarch64_ldadd4_acq_rel(1, &atomic_counter);
      v3 = v2 + 1000;
      v4 = v2++;
      _aarch64_cas4_acq_rel(v4, v3, &atomic_counter);
    }
    while ( v1 != v2 );
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x1C70 */
__int64 thread_atomic_load_store()
{
  unsigned int v0; // w1

  v0 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v0 + 100, (unsigned int *)&atomic_counter);
  return 0;
}


/* Function: thread_tls_test @ 0x1C90 */
_DWORD *__fastcall thread_tls_test(char *src)
{
  unsigned __int64 StatusReg; // x3
  int v2; // w20
  _DWORD *result; // x0

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v2 = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = v2 + 50;
  strncpy((char *)(StatusReg + 32), src, 0x1Fu);
  result = malloc(8u);
  *result = v2;
  result[1] = v2 + 50;
  return result;
}


/* Function: param_fork_exec.part.0 @ 0x1CE0 */
void __fastcall __noreturn param_fork_exec_part_0(char *arg, __int64 a2)
{
  execl(arg, arg, a2, 0);
  _exit(127);
}


/* Function: param_thread_local_storage.constprop.0 @ 0x1D00 */
__int64 param_thread_local_storage_constprop_0()
{
  pthread_t *v0; // x23
  _QWORD *v1; // x0
  bool v2; // zf
  _QWORD *v3; // x21
  __int64 i; // x19
  pthread_t *v5; // x22
  __int64 v6; // x20
  int v7; // w19
  int v8; // w22
  __int64 j; // x20
  void *v10; // x0
  __int64 v13; // x19
  void *v14; // x0
  void *thread_return; // [xsp+50h] [xbp+50h] BYREF

  v0 = (pthread_t *)malloc(0x20u);
  v1 = malloc(0x20u);
  if ( v0 )
    v2 = v1 == 0;
  else
    v2 = 1;
  if ( v2 )
    return 0xFFFFFFFFLL;
  v3 = v1;
  for ( i = 0; i != 4; ++i )
  {
    v3[i] = malloc(0x10u);
    __snprintf_chk();
  }
  v5 = v0;
  v6 = 0;
  while ( 1 )
  {
    v7 = pthread_create(v5, 0, (void *(*)(void *))thread_tls_test, (void *)v3[v6]);
    if ( v7 )
      break;
    ++v6;
    ++v5;
    if ( v6 == 4 )
    {
      v8 = 0;
      for ( j = 0; j != 4; ++j )
      {
        pthread_join(v0[j], &thread_return);
        v7 += *(_DWORD *)thread_return;
        v8 += *((_DWORD *)thread_return + 1);
        free(thread_return);
        v10 = (void *)v3[j];
        free(v10);
      }
      free(v3);
      free(v0);
      if ( v7 == 400 && v8 == 600 )
        return 42;
      else
        return 4294967293LL;
    }
  }
  v13 = 0;
  do
  {
    v14 = (void *)v3[v13++];
    free(v14);
  }
  while ( (int)v6 >= (int)v13 );
  free(v3);
  free(v0);
  return 4294967294LL;
}


/* Function: param_atomic_ops.constprop.0 @ 0x1ED0 */
__int64 param_atomic_ops_constprop_0()
{
  pthread_t *v0; // x0
  pthread_t *v1; // x21
  pthread_t *v2; // x19
  pthread_t *v3; // x23
  __int64 i; // x19
  pthread_t v5; // x0
  int v6; // w19
  int arg; // [xsp+4Ch] [xbp+4Ch] BYREF
  pthread_t newthread; // [xsp+50h] [xbp+50h] BYREF

  arg = 500;
  v0 = (pthread_t *)malloc(0x20u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  atomic_store(0, (unsigned int *)&atomic_counter);
  v2 = v0;
  v3 = v0 + 4;
  do
  {
    if ( pthread_create(v2, 0, (void *(*)(void *))thread_atomic_increment, &arg) )
    {
      free(v1);
      return 4294967294LL;
    }
    ++v2;
  }
  while ( v3 != v2 );
  if ( !pthread_create(&newthread, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
    pthread_join(newthread, 0);
  for ( i = 0; i != 4; ++i )
  {
    v5 = v1[i];
    pthread_join(v5, 0);
  }
  v6 = atomic_load((unsigned int *)&atomic_counter);
  free(v1);
  if ( v6 <= 0 )
    return 4294967293LL;
  else
    return 42;
}


/* Function: param_mutex_lock.constprop.0 @ 0x2030 */
__int64 param_mutex_lock_constprop_0()
{
  pthread_t *v0; // x0
  pthread_t *v1; // x21
  pthread_t *v2; // x23
  pthread_t *v3; // x19
  __int64 i; // x19
  pthread_t v5; // x0
  int arg; // [xsp+44h] [xbp+44h] BYREF

  arg = 1000;
  v0 = (pthread_t *)malloc(0x20u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  v2 = v0 + 4;
  v3 = v0;
  shared_counter = 0;
  do
  {
    if ( pthread_create(v3, 0, (void *(*)(void *))thread_increment, &arg) )
    {
      free(v1);
      return 4294967294LL;
    }
    ++v3;
  }
  while ( v2 != v3 );
  for ( i = 0; i != 4; ++i )
  {
    v5 = v1[i];
    pthread_join(v5, 0);
  }
  free(v1);
  if ( shared_counter == 4 * arg )
    return 42;
  else
    return 4294967293LL;
}


/* Function: param_strcpy @ 0x2160 */
__int64 __fastcall param_strcpy(char *a1, const char *a2)
{
  return (unsigned int)stpcpy(a1, a2) - (unsigned int)a1;
}


/* Function: call_strcpy @ 0x2184 */
__int64 call_strcpy()
{
  return 8;
}


/* Function: param_strcmp @ 0x2190 */
__int64 __fastcall param_strcmp(const char *a1, const char *a2)
{
  int v2; // w0
  bool v3; // zf
  bool v4; // nf
  __int64 result; // x0

  v2 = strcmp(a1, a2);
  v3 = v2 == 0;
  v4 = v2 < 0;
  if ( v2 )
    LODWORD(result) = -1;
  else
    LODWORD(result) = 0;
  if ( v4 || v3 )
    return (unsigned int)result;
  else
    return 1;
}


/* Function: call_strcmp @ 0x21B0 */
__int64 call_strcmp()
{
  return 0;
}


/* Function: param_strlen @ 0x21C0 */
size_t __fastcall param_strlen(const char *a1)
{
  return strlen(a1);
}


/* Function: call_strlen @ 0x21D4 */
__int64 call_strlen()
{
  return 12;
}


/* Function: param_memcpy @ 0x21E0 */
__int64 __fastcall param_memcpy(void *a1, const void *a2, size_t a3)
{
  unsigned int v3; // w19

  v3 = a3;
  memcpy(a1, a2, a3);
  return v3;
}


/* Function: call_memcpy @ 0x2204 */
__int64 call_memcpy()
{
  return 90;
}


/* Function: param_memcmp @ 0x2210 */
__int64 __fastcall param_memcmp(const void *a1, const void *a2, size_t a3)
{
  int v3; // w0
  bool v4; // zf
  bool v5; // nf
  __int64 result; // x0

  v3 = memcmp(a1, a2, a3);
  v4 = v3 == 0;
  v5 = v3 < 0;
  if ( v3 )
    LODWORD(result) = -1;
  else
    LODWORD(result) = 0;
  if ( v5 || v4 )
    return (unsigned int)result;
  else
    return 1;
}


/* Function: call_memcmp @ 0x2230 */
__int64 call_memcmp()
{
  int v0; // w0
  int v1; // w19
  int v2; // w0
  bool v3; // cc
  int v4; // w0
  __int64 s1; // [xsp+38h] [xbp+38h] BYREF
  int v7; // [xsp+40h] [xbp+40h]
  __int64 s2; // [xsp+48h] [xbp+48h] BYREF
  int v9; // [xsp+50h] [xbp+50h]
  __int64 v10; // [xsp+58h] [xbp+58h] BYREF
  int v11; // [xsp+60h] [xbp+60h]

  s1 = 0x200000001LL;
  v9 = 4;
  v7 = 3;
  s2 = 0x200000001LL;
  v10 = 0x200000001LL;
  v11 = 3;
  v0 = memcmp(&s1, &s2, 0xCu);
  if ( v0 )
    v1 = -1;
  else
    v1 = 0;
  if ( v0 > 0 )
    v1 = 1;
  v2 = memcmp(&s1, &v10, 0xCu);
  v3 = v2 <= 0;
  if ( v2 )
    v4 = -1;
  else
    v4 = 0;
  if ( !v3 )
    v4 = 1;
  return (unsigned int)(v4 + v1);
}


/* Function: param_printf @ 0x2300 */
__int64 __fastcall param_printf(int a1, const char *a2)
{
  return __printf_chk(1, "Value: %d, Name: %s\n", a1, a2);
}


/* Function: call_printf @ 0x2320 */
__int64 call_printf()
{
  return __printf_chk(1, "Value: %d, Name: %s\n", 42, "Test");
}


/* Function: param_scanf @ 0x2340 */
__int64 __fastcall param_scanf(__int64 a1)
{
  int v2; // [xsp+10h] [xbp+10h] BYREF
  int v3; // [xsp+14h] [xbp+14h] BYREF

  if ( (unsigned int)__isoc99_sscanf(a1, "%d,%d", &v2, &v3) == 2 )
    return (unsigned int)(v2 + v3);
  else
    return 0xFFFFFFFFLL;
}


/* Function: call_scanf @ 0x23B0 */
__int64 call_scanf()
{
  int v1; // [xsp+10h] [xbp+10h] BYREF
  int v2; // [xsp+14h] [xbp+14h] BYREF

  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", &v1, &v2) == 2 )
    return (unsigned int)(v1 + v2);
  else
    return 0xFFFFFFFFLL;
}


/* Function: param_fopen_fclose @ 0x2430 */
__int64 __fastcall param_fopen_fclose(const char *a1)
{
  FILE *v1; // x0
  FILE *v2; // x19
  unsigned int v3; // w20

  v1 = fopen(a1, "r");
  if ( v1 )
  {
    v2 = v1;
    v3 = fileno(v1);
    fclose(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: call_fopen_fclose @ 0x2480 */
__int64 call_fopen_fclose()
{
  FILE *v0; // x0
  FILE *v1; // x19
  int v2; // w20
  __int64 result; // x0

  v0 = fopen("/etc/passwd", "r");
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  v2 = fileno(v0);
  fclose(v1);
  result = 42;
  if ( v2 < 0 )
    return 0xFFFFFFFFLL;
  return result;
}


/* Function: param_fread_fwrite @ 0x24E0 */
__int64 __fastcall param_fread_fwrite(const char *a1)
{
  FILE *v2; // x0
  FILE *v3; // x19
  size_t v4; // x20
  _QWORD ptr[2]; // [xsp+38h] [xbp+38h] BYREF
  __int16 v7; // [xsp+48h] [xbp+48h]
  char v8; // [xsp+4Ah] [xbp+4Ah]

  v2 = fopen(a1, "w+");
  if ( !v2 )
    return 0xFFFFFFFFLL;
  v3 = v2;
  if ( fwrite("BinBench Test Data", 1u, 0x12u, v2) == 18 )
  {
    rewind(v3);
    v4 = fread(ptr, 1u, 0x12u, v3);
    *((_BYTE *)ptr + v4) = 0;
    fclose(v3);
    unlink(a1);
    if ( v4 == 18 && ptr[0] == 0x68636E65426E6942LL && ptr[1] == 0x6144207473655420LL && v7 == 24948 && !v8 )
      return 42;
    else
      return 4294967293LL;
  }
  else
  {
    fclose(v3);
    return 4294967294LL;
  }
}


/* Function: call_fread_fwrite @ 0x2630 */
__int64 call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x2640 */
__int64 __fastcall param_malloc_free(unsigned __int64 a1)
{
  __int64 v1; // x20
  int32x4_t *v3; // x0
  int32x4_t v4; // q4
  int32x4_t *v5; // x1
  int64x2_t v6; // q1
  int64x2_t v7; // q2
  unsigned __int64 v8; // x1
  int v9; // w2
  __int64 v10; // x4
  unsigned __int64 v11; // x1
  unsigned int v12; // w19

  v1 = a1;
  v3 = (int32x4_t *)malloc(4 * a1);
  if ( !v3 )
    return (unsigned int)-1;
  if ( a1 )
  {
    if ( a1 - 1 <= 2 )
    {
      v8 = 0;
      goto LABEL_7;
    }
    v4.n128_u64[0] = 0xA0000000ALL;
    v4.n128_u64[1] = 0xA0000000ALL;
    v5 = v3;
    v6 = (int64x2_t)xmmword_42B0;
    do
    {
      v7 = v6;
      v6 = vaddq_s64(v6, (int64x2_t)xmmword_42C0);
      *v5++ = vmulq_s32(vmovn_hight_s64(vmovn_s64(v7), vaddq_s64(v7, (int64x2_t)xmmword_42D0)), v4);
    }
    while ( &v3[a1 >> 2] != v5 );
    v8 = a1 & 0xFFFFFFFFFFFFFFFCLL;
    if ( (a1 & 3) != 0 )
    {
LABEL_7:
      v9 = v8 + 1;
      v10 = v8;
      v3->n128_u32[v8] = 10 * v8;
      if ( a1 > v8 + 1 )
      {
        v11 = v8 + 2;
        v3->n128_u32[v10 + 1] = 10 * v9;
        if ( a1 > v11 )
          v3->n128_u32[v10 + 2] = 10 * v11;
      }
    }
  }
  v12 = v3->n128_u32[v1 - 1] + v3->n128_u32[0];
  free(v3);
  return v12;
}


/* Function: call_malloc_free @ 0x2740 */
__int64 call_malloc_free()
{
  void *v0; // x0

  v0 = malloc(0x28u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  free(v0);
  return 90;
}


/* Function: param_memset @ 0x2770 */
__int64 __fastcall param_memset(uint8x16_t *a1, size_t n)
{
  uint8x16_t *v4; // x3
  int32x4_t v5; // q0
  uint8x16_t v6; // t1
  uint16x8_t v7; // q2
  uint16x8_t v8; // q1
  size_t v9; // x1
  __int64 result; // x0
  size_t v11; // x2
  size_t v12; // x1

  memset(a1, 0, n);
  if ( !n )
    return 0;
  if ( n - 1 <= 0xE )
  {
    v9 = 0;
    LODWORD(result) = 0;
  }
  else
  {
    v4 = a1;
    v5 = 0u;
    do
    {
      v6 = *v4++;
      v7 = vmovl_u8((uint8x8_t)v6.n128_u64[0]);
      v8 = vmovl_high_u8(v6);
      v5 = vaddw_high_u16(
             vaddw_u16(vaddw_high_u16(vaddw_u16(v5, (uint16x4_t)v7.n128_u64[0]), v7), (uint16x4_t)v8.n128_u64[0]),
             v8);
    }
    while ( v4 != (uint8x16_t *)((char *)a1 + (n & 0xFFFFFFFFFFFFFFF0LL)) );
    v9 = n & 0xFFFFFFFFFFFFFFF0LL;
    result = (unsigned int)vaddvq_s32(v5);
    if ( (n & 0xF) == 0 )
      return result;
  }
  result = (unsigned int)result + a1->n128_u8[v9];
  if ( n > v9 + 1 )
  {
    result = (unsigned int)result + a1->n128_u8[v9 + 1];
    if ( n > v9 + 2 )
    {
      result = (unsigned int)result + a1->n128_u8[v9 + 2];
      if ( n > v9 + 3 )
      {
        result = (unsigned int)result + a1->n128_u8[v9 + 3];
        if ( n > v9 + 4 )
        {
          result = (unsigned int)result + a1->n128_u8[v9 + 4];
          if ( n > v9 + 5 )
          {
            result = (unsigned int)result + a1->n128_u8[v9 + 5];
            if ( n > v9 + 6 )
            {
              result = (unsigned int)result + a1->n128_u8[v9 + 6];
              if ( n > v9 + 7 )
              {
                result = (unsigned int)result + a1->n128_u8[v9 + 7];
                if ( n > v9 + 8 )
                {
                  result = (unsigned int)result + a1->n128_u8[v9 + 8];
                  if ( n > v9 + 9 )
                  {
                    result = (unsigned int)result + a1->n128_u8[v9 + 9];
                    if ( n > v9 + 10 )
                    {
                      result = (unsigned int)result + a1->n128_u8[v9 + 10];
                      if ( n > v9 + 11 )
                      {
                        result = (unsigned int)result + a1->n128_u8[v9 + 11];
                        if ( n > v9 + 12 )
                        {
                          v11 = v9 + 13;
                          result = (unsigned int)result + a1->n128_u8[v9 + 12];
                          if ( n > v9 + 13 )
                          {
                            v12 = v9 + 14;
                            result = (unsigned int)result + a1->n128_u8[v11];
                            if ( n > v12 )
                              return (unsigned int)result + a1->n128_u8[v12];
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return result;
}


/* Function: call_memset @ 0x2930 */
__int64 call_memset()
{
  return 0;
}


/* Function: param_strchr_strstr @ 0x2940 */
__int64 __fastcall param_strchr_strstr(const char *a1, unsigned __int8 a2, const char *a3)
{
  char *v5; // x0
  const char *v6; // x1
  int v7; // w19
  char *v8; // x0
  int v9; // w20
  int v10; // w0

  v5 = strchr(a1, a2);
  v6 = a3;
  v7 = (_DWORD)v5 - (_DWORD)a1;
  if ( !v5 )
    v7 = -1;
  v8 = strstr(a1, v6);
  v9 = (_DWORD)v8 - (_DWORD)a1;
  if ( v8 )
    v10 = v9;
  else
    v10 = -1;
  return (unsigned int)(v7 + v10);
}


/* Function: call_strchr_strstr @ 0x29A0 */
__int64 call_strchr_strstr()
{
  return 15;
}


/* Function: test_standard_library_functions @ 0x29B0 */
__int64 test_standard_library_functions()
{
  int v0; // w0
  int v1; // w20
  int v2; // w0
  int v3; // w2
  unsigned int v4; // w0
  __int64 v5; // x2
  FILE *v6; // x0
  FILE *v7; // x19
  int v8; // w20
  __int64 v9; // x2
  unsigned int v10; // w0
  void *v11; // x0
  __int64 v12; // x2
  int v14; // [xsp+30h] [xbp+30h] BYREF
  int v15; // [xsp+34h] [xbp+34h] BYREF
  __int64 v16; // [xsp+38h] [xbp+38h] BYREF
  int v17; // [xsp+40h] [xbp+40h]
  __int64 s2; // [xsp+48h] [xbp+48h] BYREF
  int v19; // [xsp+50h] [xbp+50h]
  __int64 v20; // [xsp+58h] [xbp+58h] BYREF
  int v21; // [xsp+60h] [xbp+60h]

  puts(asc_3EC8);
  __printf_chk(1, aLibL101D, 8);
  __printf_chk(1, aLibL102D, 0);
  __printf_chk(1, aLibL103D, 12);
  __printf_chk(1, aLibL104D, 90);
  v16 = 0x200000001LL;
  v19 = 4;
  v17 = 3;
  s2 = 0x200000001LL;
  v20 = 0x200000001LL;
  v21 = 3;
  v0 = memcmp(&v16, &s2, 0xCu);
  if ( v0 )
    v1 = -1;
  else
    v1 = 0;
  if ( v0 > 0 )
    v1 = 1;
  v2 = memcmp(&v16, &v20, 0xCu);
  if ( v2 )
    v3 = -1;
  else
    v3 = 0;
  if ( v2 > 0 )
    v3 = 1;
  __printf_chk(1, aLibL105D, (unsigned int)(v3 + v1));
  v4 = __printf_chk(1, "Value: %d, Name: %s\n", 42, "Test");
  __printf_chk(1, aLibL106D, v4);
  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", &v14, &v15) == 2 )
    v5 = (unsigned int)(v14 + v15);
  else
    v5 = 0xFFFFFFFFLL;
  __printf_chk(1, aLibL107D, v5);
  v6 = fopen("/etc/passwd", "r");
  v7 = v6;
  if ( !v6 || (v8 = fileno(v6), fclose(v7), v9 = 42, v8 < 0) )
    v9 = 0xFFFFFFFFLL;
  __printf_chk(1, aLibL108D, v9);
  v10 = param_fread_fwrite("/tmp/binbench_test.tmp");
  __printf_chk(1, aLibL109D, v10);
  v11 = malloc(0x28u);
  if ( v11 )
  {
    free(v11);
    v12 = 90;
  }
  else
  {
    v12 = 0xFFFFFFFFLL;
  }
  __printf_chk(1, aLibL110D, v12);
  __printf_chk(1, aLibL111D, 0);
  return __printf_chk(1, aLibL112D, 15);
}


/* Function: param_linux_syscall @ 0x2C20 */
__int64 __fastcall param_linux_syscall(__int64 a1)
{
  unsigned int v1; // w0
  unsigned int v2; // w19

  v1 = syscall(56, 4294967196LL, a1, 0);
  if ( (v1 & 0x80000000) != 0 )
    return (unsigned int)-*__errno_location();
  v2 = v1;
  syscall(57, v1);
  return v2;
}


/* Function: call_linux_syscall @ 0x2C80 */
__int64 call_linux_syscall()
{
  unsigned int v0; // w0

  v0 = syscall(56, 4294967196LL, "/etc/passwd", 0);
  if ( (v0 & 0x80000000) != 0 )
  {
    if ( *__errno_location() > 0 )
      return 0xFFFFFFFFLL;
    else
      return 42;
  }
  else
  {
    syscall(57, v0);
    return 42;
  }
}


/* Function: param_win32_api @ 0x2CE0 */
__int64 __fastcall param_win32_api(const char *a1)
{
  _BYTE v2[136]; // [xsp+18h] [xbp+18h] BYREF

  if ( stat(a1, (struct stat *)v2) < 0 )
    return 0xFFFFFFFFLL;
  if ( *(__int64 *)&v2[48] <= 0 )
    return 4294967294LL;
  return 42;
}


/* Function: call_win32_api @ 0x2D50 */
__int64 call_win32_api()
{
  _BYTE v1[136]; // [xsp+18h] [xbp+18h] BYREF

  if ( stat("/etc/passwd", (struct stat *)v1) < 0 )
    return 0xFFFFFFFFLL;
  if ( *(__int64 *)&v1[48] <= 0 )
    return 4294967294LL;
  return 42;
}


/* Function: param_fork_exec @ 0x2DC4 */
__int64 __fastcall param_fork_exec(char *a1, __int64 a2)
{
  int v4; // w0
  __pid_t v5; // w1
  __int64 result; // x0
  int stat_loc; // [xsp+24h] [xbp+24h] BYREF

  v4 = fork();
  if ( v4 < 0 )
    return 0xFFFFFFFFLL;
  if ( !v4 )
    param_fork_exec_part_0(a1, a2);
  v5 = waitpid(v4, &stat_loc, 0);
  result = 4294967294LL;
  if ( (v5 & 0x80000000) == 0 )
  {
    if ( (stat_loc & 0x7F) != 0 )
      return 4294967293LL;
    else
      return BYTE1(stat_loc);
  }
  return result;
}


/* Function: call_fork_exec @ 0x2E70 */
__int64 call_fork_exec()
{
  int v0; // w0
  __int64 result; // x0
  int stat_loc; // [xsp+14h] [xbp+14h] BYREF

  v0 = fork();
  if ( v0 < 0 )
    return 0xFFFFFFFFLL;
  if ( !v0 )
    param_fork_exec_part_0("/bin/true", 0);
  if ( waitpid(v0, &stat_loc, 0) < 0 )
    return 0xFFFFFFFFLL;
  if ( (stat_loc & 0x7F) != 0 )
    return 0xFFFFFFFFLL;
  result = 42;
  if ( (stat_loc & 0xFF00) != 0 )
    return 0xFFFFFFFFLL;
  return result;
}


/* Function: param_pipe_communication @ 0x2F04 */
__int64 param_pipe_communication()
{
  __pid_t v0; // w0
  ssize_t v1; // x19
  __WAIT_STATUS v2; // x0
  int pipedes[2]; // [xsp+20h] [xbp+20h] BYREF
  _BYTE v5[32]; // [xsp+28h] [xbp+28h] BYREF

  if ( pipe(pipedes) < 0 )
    return 0xFFFFFFFFLL;
  v0 = fork();
  if ( v0 < 0 )
    return 4294967294LL;
  if ( !v0 )
  {
    close(pipedes[0]);
    write(pipedes[1], "HelloPipe", 9u);
    close(pipedes[1]);
    _exit(0);
  }
  close(pipedes[1]);
  v1 = read(pipedes[0], v5, 0x1Fu);
  v5[v1] = 0;
  close(pipedes[0]);
  v2.__uptr = 0;
  wait(v2);
  if ( v1 <= 0 )
    return 4294967293LL;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x2FF0 */
// attributes: thunk
__int64 call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x2FF4 */
__int64 param_socket_create()
{
  int v0; // w0
  int v1; // w19
  int optval; // [xsp+24h] [xbp+24h] BYREF
  sockaddr addr; // [xsp+28h] [xbp+28h] BYREF

  v0 = socket(2, 1, 0);
  if ( v0 < 0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  optval = 1;
  if ( setsockopt(v0, 1, 2, &optval, 4u) < 0 )
  {
    close(v1);
    return 4294967294LL;
  }
  else
  {
    *(_QWORD *)&addr.sa_data[6] = 0;
    *(_QWORD *)&addr.sa_family = 2;
    if ( bind(v1, &addr, 0x10u) < 0 )
    {
      close(v1);
      return 4294967293LL;
    }
    else if ( listen(v1, 5) < 0 )
    {
      close(v1);
      return 4294967292LL;
    }
    else
    {
      close(v1);
      return 42;
    }
  }
}


/* Function: call_socket_create @ 0x3100 */
// attributes: thunk
__int64 call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x3104 */
__int64 param_shmget_shmat()
{
  int v0; // w0
  key_t v1; // w0
  int v2; // w0
  int v3; // w19
  char *v4; // x0

  v0 = open("/tmp/binbench_shm", 66, 438);
  if ( v0 < 0 )
    return 0xFFFFFFFFLL;
  close(v0);
  v1 = ftok("/tmp/binbench_shm", 42);
  if ( v1 < 0 )
    return 0xFFFFFFFFLL;
  v2 = shmget(v1, 0x1000u, 950);
  v3 = v2;
  if ( v2 < 0 )
    return 4294967294LL;
  v4 = (char *)shmat(v2, 0, 0);
  if ( v4 == (char *)-1LL )
    return 4294967293LL;
  strcpy(v4, "SharedMemory");
  shmdt(v4);
  shmctl(v3, 0, 0);
  return 12;
}


/* Function: call_shmget_shmat @ 0x31C0 */
__int64 call_shmget_shmat()
{
  if ( (int)param_shmget_shmat() <= 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x31E0 */
__int64 param_signal_handling()
{
  __int64 result; // x0
  int v1; // w19
  int v2; // w19

  result = (__int64)signal(10, (__sighandler_t)signal_handler);
  if ( result != -1 )
  {
    if ( signal(14, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    {
      return 4294967294LL;
    }
    else
    {
      signal_received = 0;
      raise(10);
      if ( !signal_received )
      {
        v1 = 1000;
        do
        {
          usleep(0x3E8u);
          --v1;
        }
        while ( !signal_received && v1 );
      }
      if ( signal_received )
      {
        if ( signal_number == 10 )
        {
          signal_received = 0;
          alarm(1u);
          if ( !signal_received )
          {
            v2 = 2000;
            do
            {
              usleep(0x3E8u);
              --v2;
            }
            while ( !signal_received && v2 );
          }
          if ( signal_received && signal_number == 14 )
          {
            signal(10, 0);
            signal(14, 0);
            return 42;
          }
          else
          {
            return 4294967291LL;
          }
        }
        else
        {
          return 4294967292LL;
        }
      }
      else
      {
        return 4294967293LL;
      }
    }
  }
  return result;
}


/* Function: call_signal_handling @ 0x3300 */
// attributes: thunk
__int64 call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x3304 */
__int64 test_system_calls()
{
  unsigned int v0; // w0
  __int64 v1; // x2
  __int64 v2; // x2
  int v3; // w0
  __int64 v4; // x2
  unsigned int v5; // w0
  unsigned int v6; // w0
  __int64 v7; // x2
  __int64 v8; // x2
  int stat_loc; // [xsp+24h] [xbp+24h] BYREF
  _BYTE v11[136]; // [xsp+28h] [xbp+28h] BYREF

  puts(asc_40B8);
  v0 = syscall(56, 4294967196LL, "/etc/passwd", 0);
  if ( (v0 & 0x80000000) != 0 )
  {
    if ( *__errno_location() > 0 )
      v1 = 0xFFFFFFFFLL;
    else
      v1 = 42;
  }
  else
  {
    syscall(57, v0);
    v1 = 42;
  }
  __printf_chk(1, aSysL301D, v1);
  if ( stat("/etc/passwd", (struct stat *)v11) < 0 )
  {
    v2 = 0xFFFFFFFFLL;
  }
  else if ( *(__int64 *)&v11[48] <= 0 )
  {
    v2 = 4294967294LL;
  }
  else
  {
    v2 = 42;
  }
  __printf_chk(1, aSysL302D, v2);
  v3 = fork();
  if ( v3 < 0 )
    goto LABEL_11;
  if ( !v3 )
    param_fork_exec_part_0("/bin/true", 0);
  if ( waitpid(v3, &stat_loc, 0) < 0 || (stat_loc & 0x7F) != 0 || (v4 = 42, (stat_loc & 0xFF00) != 0) )
LABEL_11:
    v4 = 0xFFFFFFFFLL;
  __printf_chk(1, aSysL303D, v4);
  v5 = param_pipe_communication();
  __printf_chk(1, aSysL304D, v5);
  v6 = param_socket_create();
  __printf_chk(1, aSysL305D, v6);
  if ( (int)param_shmget_shmat() <= 0 )
    v7 = 0xFFFFFFFFLL;
  else
    v7 = 42;
  __printf_chk(1, aSysL306D, v7);
  v8 = (unsigned int)param_signal_handling();
  return __printf_chk(1, aSysL307D, v8, 0);
}


/* Function: param_pthread_create @ 0x34B0 */
__int64 __fastcall param_pthread_create(int a1)
{
  unsigned int v1; // w19
  int arg; // [xsp+24h] [xbp+24h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+28h] BYREF
  void *thread_return; // [xsp+30h] [xbp+30h] BYREF

  arg = a1;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    return (unsigned int)-1;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    v1 = *(_DWORD *)thread_return;
    free(thread_return);
  }
  return v1;
}


/* Function: call_pthread_create @ 0x3544 */
__int64 call_pthread_create()
{
  unsigned int v0; // w19
  int arg; // [xsp+24h] [xbp+24h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+28h] BYREF
  void *thread_return; // [xsp+30h] [xbp+30h] BYREF

  arg = 7;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    return (unsigned int)-1;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    v0 = *(_DWORD *)thread_return;
    free(thread_return);
  }
  return v0;
}


/* Function: param_pthread_join @ 0x35E0 */
__int64 param_pthread_join()
{
  int v0; // w23
  pthread_t *v1; // x22
  _OWORD *v2; // x21
  pthread_t *v3; // x20
  unsigned int v4; // w19
  __int64 v5; // x20
  char *v6; // x0
  pthread_t newthread[3]; // [xsp+58h] [xbp+58h] BYREF
  _OWORD arg[2]; // [xsp+70h] [xbp+70h] BYREF
  int v10; // [xsp+90h] [xbp+90h]

  v0 = 3;
  v1 = newthread;
  v2 = arg;
  v3 = newthread;
  v10 = 0;
  arg[0] = xmmword_4300;
  arg[1] = xmmword_4310;
  do
  {
    v4 = pthread_create(v3, 0, (void *(*)(void *))thread_sum, v2);
    if ( v4 )
      return (unsigned int)-1;
    ++v3;
    v2 = (_OWORD *)((char *)v2 + 12);
    --v0;
  }
  while ( v0 );
  v5 = 0;
  while ( !pthread_join(*v1, 0) )
  {
    v6 = (char *)arg + v5;
    v5 += 12;
    ++v1;
    v4 += *((_DWORD *)v6 + 2);
    if ( v5 == 36 )
      return v4;
  }
  return (unsigned int)-2;
}


/* Function: call_pthread_join @ 0x36F0 */
// attributes: thunk
__int64 call_pthread_join()
{
  return param_pthread_join();
}


/* Function: param_mutex_lock @ 0x36F4 */
__int64 __fastcall param_mutex_lock(int a1, int a2)
{
  char *v3; // x0
  void *v4; // x24
  pthread_t *v5; // x20
  pthread_t *v6; // x19
  pthread_t *v7; // x21
  pthread_t *v8; // x0
  pthread_t v10; // t1
  int arg; // [xsp+5Ch] [xbp+5Ch] BYREF

  arg = a2;
  v3 = (char *)malloc(8LL * a1);
  if ( !v3 )
    return 0xFFFFFFFFLL;
  v4 = v3;
  shared_counter = 0;
  if ( a1 > 0 )
  {
    v5 = (pthread_t *)&v3[8 * a1];
    v6 = (pthread_t *)v3;
    v7 = (pthread_t *)v3;
    do
    {
      v8 = v6++;
      if ( pthread_create(v8, 0, (void *(*)(void *))thread_increment, &arg) )
      {
        free(v4);
        return 4294967294LL;
      }
    }
    while ( v6 != v5 );
    do
    {
      v10 = *v7++;
      pthread_join(v10, 0);
    }
    while ( v7 != v5 );
  }
  free(v4);
  if ( shared_counter == a1 * arg )
    return 42;
  else
    return 4294967293LL;
}


/* Function: call_mutex_lock @ 0x3800 */
// attributes: thunk
__int64 call_mutex_lock()
{
  return param_mutex_lock_constprop_0();
}


/* Function: param_condition_variable @ 0x3804 */
__int64 param_condition_variable()
{
  unsigned int v0; // w19
  pthread_t th; // [xsp+20h] [xbp+20h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+28h] BYREF
  void *thread_return; // [xsp+30h] [xbp+30h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))consumer_thread, 0) )
  {
    return (unsigned int)-1;
  }
  else if ( pthread_create(&th, 0, (void *(*)(void *))producer_thread, 0) )
  {
    v0 = -2;
    pthread_cancel(newthread);
  }
  else
  {
    pthread_join(newthread, &thread_return);
    pthread_join(th, 0);
    v0 = *(_DWORD *)thread_return;
    free(thread_return);
  }
  return v0;
}


/* Function: call_condition_variable @ 0x38E0 */
// attributes: thunk
__int64 call_condition_variable()
{
  return param_condition_variable();
}


/* Function: param_atomic_ops @ 0x38E4 */
__int64 __fastcall param_atomic_ops(int a1, int a2)
{
  pthread_t *v3; // x0
  pthread_t *v4; // x21
  pthread_t *v5; // x19
  __int64 v7; // x19
  pthread_t v8; // x0
  int v9; // w19
  int arg; // [xsp+5Ch] [xbp+5Ch] BYREF
  pthread_t newthread; // [xsp+60h] [xbp+60h] BYREF

  arg = a2;
  v3 = (pthread_t *)malloc(8LL * a1);
  if ( !v3 )
    return 0xFFFFFFFFLL;
  v4 = v3;
  atomic_store(0, (unsigned int *)&atomic_counter);
  if ( a1 <= 0 )
  {
    if ( !pthread_create(&newthread, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
      pthread_join(newthread, 0);
  }
  else
  {
    v5 = v3;
    do
    {
      if ( pthread_create(v5, 0, (void *(*)(void *))thread_atomic_increment, &arg) )
      {
        free(v4);
        return 4294967294LL;
      }
      ++v5;
    }
    while ( v5 != &v4[a1] );
    if ( !pthread_create(&newthread, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
      pthread_join(newthread, 0);
    v7 = 0;
    do
    {
      v8 = v4[v7++];
      pthread_join(v8, 0);
    }
    while ( a1 > (int)v7 );
  }
  v9 = atomic_load((unsigned int *)&atomic_counter);
  free(v4);
  if ( v9 <= 0 )
    return 4294967293LL;
  else
    return 42;
}


/* Function: call_atomic_ops @ 0x3A80 */
// attributes: thunk
__int64 call_atomic_ops()
{
  return param_atomic_ops_constprop_0();
}


/* Function: param_thread_local_storage @ 0x3A84 */
__int64 __fastcall param_thread_local_storage(int a1)
{
  __int64 v1; // x25
  size_t v2; // x19
  pthread_t *v3; // x23
  void **v4; // x0
  bool v5; // zf
  int v6; // w24
  void **v7; // x21
  __int64 i; // x19
  pthread_t *v9; // x22
  __int64 j; // x20
  int v11; // w19
  void **v12; // x19
  __int64 v13; // x20
  void *v14; // t1
  __int64 v16; // x20
  int v17; // w25
  unsigned __int64 v18; // x22
  void *v19; // x0
  int v20; // w1
  int v21; // w24
  void *thread_return; // [xsp+50h] [xbp+50h] BYREF

  v1 = a1;
  v2 = 8LL * a1;
  v3 = (pthread_t *)malloc(v2);
  v4 = (void **)malloc(v2);
  if ( v3 )
    v5 = v4 == 0;
  else
    v5 = 1;
  if ( v5 )
    return 0xFFFFFFFFLL;
  v6 = v1;
  v7 = v4;
  if ( (int)v1 <= 0 )
  {
    v17 = 0;
    v11 = 0;
  }
  else
  {
    for ( i = 0; i != v1; ++i )
    {
      v7[i] = malloc(0x10u);
      __snprintf_chk();
    }
    v9 = v3;
    for ( j = 0; j != v1; ++j )
    {
      v11 = pthread_create(v9, 0, (void *(*)(void *))thread_tls_test, v7[j]);
      if ( v11 )
      {
        v12 = v7;
        v13 = (__int64)&v7[j + 1];
        do
        {
          v14 = *v12++;
          free(v14);
        }
        while ( (void **)v13 != v12 );
        free(v7);
        free(v3);
        return 4294967294LL;
      }
      ++v9;
    }
    v16 = 8 * j;
    v17 = 0;
    v18 = 0;
    do
    {
      pthread_join(v3[v18 / 8], &thread_return);
      v11 += *(_DWORD *)thread_return;
      v17 += *((_DWORD *)thread_return + 1);
      free(thread_return);
      v19 = v7[v18 / 8];
      v18 += 8LL;
      free(v19);
    }
    while ( v16 != v18 );
  }
  free(v7);
  free(v3);
  v20 = 100 * v6;
  v21 = 150 * v6;
  if ( v20 == v11 && v21 == v17 )
    return 42;
  else
    return 4294967293LL;
}


/* Function: call_thread_local_storage @ 0x3C70 */
// attributes: thunk
__int64 call_thread_local_storage()
{
  return param_thread_local_storage_constprop_0();
}


/* Function: test_thread_concurrency @ 0x3C74 */
__int64 test_thread_concurrency()
{
  unsigned int v0; // w19
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  __int64 v5; // x2
  int arg; // [xsp+24h] [xbp+24h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+28h] BYREF
  void *thread_return; // [xsp+30h] [xbp+30h] BYREF

  puts(asc_41B8);
  arg = 7;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    v0 = -1;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    v0 = *(_DWORD *)thread_return;
    free(thread_return);
  }
  __printf_chk(1, aThrL301D, v0);
  v1 = param_pthread_join();
  __printf_chk(1, aThrL302D, v1);
  v2 = param_mutex_lock_constprop_0();
  __printf_chk(1, aThrL303D, v2);
  v3 = param_condition_variable();
  __printf_chk(1, aThrL304D, v3);
  v4 = param_atomic_ops_constprop_0();
  __printf_chk(1, aThrL305D, v4);
  v5 = (unsigned int)param_thread_local_storage_constprop_0();
  return __printf_chk(1, aThrL306D, v5, 0);
}


/* Function: __aarch64_cas4_acq_rel @ 0x3DA0 */
unsigned int __fastcall _aarch64_cas4_acq_rel(unsigned int result, unsigned int a2, atomic_uint *a3)
{
  unsigned int v4; // w16

  if ( _aarch64_have_lse_atomics )
  {
    atomic_compare_exchange_strong(a3, &result, a2);
  }
  else
  {
    v4 = result;
    do
      result = __ldaxr((unsigned int *)a3);
    while ( result == v4 && __stlxr(a2, (unsigned int *)a3) );
  }
  return result;
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x3DE0 */
__int64 __fastcall _aarch64_ldadd4_acq_rel(unsigned int a1, atomic_uint *a2)
{
  __int64 result; // x0

  if ( _aarch64_have_lse_atomics )
    return atomic_fetch_add(a2, a1);
  do
    result = __ldaxr((unsigned int *)a2);
  while ( __stlxr(result + a1, (unsigned int *)a2) );
  return result;
}


/* Function: .term_proc @ 0x3E10 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x16180 */

/* FAILED to decompile: _exit @ 0x16188 */

/* FAILED to decompile: strlen @ 0x16190 */

/* FAILED to decompile: raise @ 0x16198 */

/* FAILED to decompile: __libc_start_main @ 0x161A0 */

/* FAILED to decompile: execl @ 0x161A8 */

/* FAILED to decompile: listen @ 0x161B0 */

/* FAILED to decompile: shmdt @ 0x161B8 */

/* FAILED to decompile: bind @ 0x161C0 */

/* FAILED to decompile: __cxa_finalize @ 0x161C8 */

/* FAILED to decompile: pipe @ 0x161D0 */

/* FAILED to decompile: fork @ 0x161D8 */

/* FAILED to decompile: stpcpy @ 0x161E0 */

/* FAILED to decompile: fileno @ 0x161E8 */

/* FAILED to decompile: signal @ 0x161F0 */

/* FAILED to decompile: __snprintf_chk @ 0x161F8 */

/* FAILED to decompile: fclose @ 0x16200 */

/* FAILED to decompile: fopen @ 0x16208 */

/* FAILED to decompile: malloc @ 0x16210 */

/* FAILED to decompile: setsockopt @ 0x16218 */

/* FAILED to decompile: open @ 0x16220 */

/* FAILED to decompile: pthread_cond_signal @ 0x16228 */

/* FAILED to decompile: __printf_chk @ 0x16230 */

/* FAILED to decompile: memset @ 0x16238 */

/* FAILED to decompile: shmat @ 0x16240 */

/* FAILED to decompile: sleep @ 0x16248 */

/* FAILED to decompile: rewind @ 0x16250 */

/* FAILED to decompile: __stack_chk_fail @ 0x16258 */

/* FAILED to decompile: close @ 0x16260 */

/* FAILED to decompile: stat @ 0x16268 */

/* FAILED to decompile: write @ 0x16278 */

/* FAILED to decompile: __getauxval @ 0x16280 */

/* FAILED to decompile: abort @ 0x16288 */

/* FAILED to decompile: puts @ 0x16290 */

/* FAILED to decompile: memcmp @ 0x16298 */

/* FAILED to decompile: strcmp @ 0x162A0 */

/* FAILED to decompile: shmctl @ 0x162A8 */

/* FAILED to decompile: fread @ 0x162B0 */

/* FAILED to decompile: ftok @ 0x162B8 */

/* FAILED to decompile: free @ 0x162C0 */

/* FAILED to decompile: shmget @ 0x162C8 */

/* FAILED to decompile: pthread_cond_wait @ 0x162D0 */

/* FAILED to decompile: strchr @ 0x162D8 */

/* FAILED to decompile: fwrite @ 0x162E0 */

/* FAILED to decompile: pthread_create @ 0x162E8 */

/* FAILED to decompile: wait @ 0x162F0 */

/* FAILED to decompile: socket @ 0x162F8 */

/* FAILED to decompile: read @ 0x16300 */

/* FAILED to decompile: strstr @ 0x16308 */

/* FAILED to decompile: usleep @ 0x16310 */

/* FAILED to decompile: __isoc99_sscanf @ 0x16318 */

/* FAILED to decompile: strncpy @ 0x16320 */

/* FAILED to decompile: __errno_location @ 0x16328 */

/* FAILED to decompile: pthread_join @ 0x16330 */

/* FAILED to decompile: alarm @ 0x16338 */

/* FAILED to decompile: pthread_cancel @ 0x16340 */

/* FAILED to decompile: pthread_mutex_lock @ 0x16348 */

/* FAILED to decompile: syscall @ 0x16350 */

/* FAILED to decompile: pthread_mutex_unlock @ 0x16358 */

/* FAILED to decompile: waitpid @ 0x16360 */

/* FAILED to decompile: unlink @ 0x16368 */

/* FAILED to decompile: __gmon_start__ @ 0x16378 */

/* Total functions decompiled: 79, failed: 62 */
