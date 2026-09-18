/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_clang_Os_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x12C8 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_12E0 @ 0x12E0 */
void sub_12E0()
{
  JUMPOUT(0);
}


/* Function: init_have_lse_atomics @ 0x1700 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x1740 */
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


/* Function: call_weak_fn @ 0x1774 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1790 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x17C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x1800 */
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


/* Function: frame_dummy @ 0x1850 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_strcpy @ 0x1854 */
int __fastcall param_strcpy(char *dst, const char *src)
{
  char *v2; // x0

  v2 = strcpy(dst, src);
  return strlen(v2);
}


/* Function: call_strcpy @ 0x186C */
int __cdecl call_strcpy()
{
  char v1[32]; // [xsp+0h] [xbp-20h] BYREF

  strcpy(v1, "HelloLib");
  return strlen(v1);
}


/* Function: param_strcmp @ 0x18A0 */
int __fastcall param_strcmp(const char *s1, const char *s2)
{
  int v2; // w0
  int v3; // w8

  v2 = strcmp(s1, s2);
  if ( v2 )
    v3 = -1;
  else
    v3 = 0;
  if ( v2 >= 1 )
    return 1;
  else
    return v3;
}


/* Function: call_strcmp @ 0x18C4 */
int __cdecl call_strcmp()
{
  return 0;
}


/* Function: param_strlen @ 0x18CC */
int __fastcall param_strlen(const char *str)
{
  return strlen(str);
}


/* Function: call_strlen @ 0x18E0 */
int __cdecl call_strlen()
{
  return 12;
}


/* Function: param_memcpy @ 0x18E8 */
int __fastcall param_memcpy(void *dst, const void *src, size_t n)
{
  int v3; // w19

  v3 = n;
  memcpy(dst, src, n);
  return v3;
}


/* Function: call_memcpy @ 0x190C */
int __cdecl call_memcpy()
{
  return 90;
}


/* Function: param_memcmp @ 0x1914 */
int __fastcall param_memcmp(const void *p1, const void *p2, size_t n)
{
  int v3; // w0
  int v4; // w8

  v3 = memcmp(p1, p2, n);
  if ( v3 )
    v4 = -1;
  else
    v4 = 0;
  if ( v3 >= 1 )
    return 1;
  else
    return v4;
}


/* Function: call_memcmp @ 0x1938 */
int __cdecl call_memcmp()
{
  return -1;
}


/* Function: param_printf @ 0x1940 */
int __fastcall param_printf(int x, const char *name)
{
  return printf("Value: %d, Name: %s\n", x, name);
}


/* Function: call_printf @ 0x1954 */
int __cdecl call_printf()
{
  return printf("Value: %d, Name: %s\n", 42, "Test");
}


/* Function: param_scanf @ 0x196C */
int __fastcall param_scanf(const char *input_str)
{
  int v2; // [xsp+8h] [xbp-8h] BYREF
  int a; // [xsp+Ch] [xbp-4h] BYREF

  if ( (unsigned int)__isoc99_sscanf(input_str, "%d,%d", &a, &v2) == 2 )
    return v2 + a;
  else
    return -1;
}


/* Function: call_scanf @ 0x19AC */
int __cdecl call_scanf()
{
  int v1; // [xsp+8h] [xbp-8h] BYREF
  int v2; // [xsp+Ch] [xbp-4h] BYREF

  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", &v2, &v1) == 2 )
    return v1 + v2;
  else
    return -1;
}


/* Function: param_fopen_fclose @ 0x19F4 */
int __fastcall param_fopen_fclose(const char *filename)
{
  FILE *v1; // x0
  FILE *v2; // x19
  int v3; // w20

  v1 = fopen(filename, "r");
  if ( !v1 )
    return -1;
  v2 = v1;
  v3 = fileno(v1);
  fclose(v2);
  return v3;
}


/* Function: call_fopen_fclose @ 0x1A3C */
int __cdecl call_fopen_fclose()
{
  if ( param_fopen_fclose("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1A64 */
int __fastcall param_fread_fwrite(const char *tmpfile)
{
  FILE *v2; // x0
  FILE *v3; // x20
  size_t v4; // x21
  int result; // w0
  __int64 v6; // [xsp+0h] [xbp-20h] BYREF
  _QWORD v7[3]; // [xsp+8h] [xbp-18h]

  v2 = fopen(tmpfile, "w+");
  if ( !v2 )
    return -1;
  v3 = v2;
  if ( fwrite("BinBench Test Data", 1u, 0x12u, v2) == 18 )
  {
    rewind(v3);
    v4 = fread(&v6, 1u, 0x12u, v3);
    *((_BYTE *)&v7[-1] + v4) = 0;
    fclose(v3);
    unlink(tmpfile);
    result = -3;
    if ( v4 == 18 )
    {
      if ( v6 ^ 0x68636E65426E6942LL | v7[0] ^ 0x6144207473655420LL | *(_QWORD *)((char *)v7 + 3) ^ 0x61746144207473LL )
        return -3;
      else
        return 42;
    }
  }
  else
  {
    fclose(v3);
    return -2;
  }
  return result;
}


/* Function: call_fread_fwrite @ 0x1B78 */
int __cdecl call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x1B84 */
int __fastcall param_malloc_free(size_t size)
{
  int *v2; // x0
  int v3; // w8
  int v4; // w8
  size_t v5; // x9
  int64x2_t v6; // q0
  _DWORD *v7; // x10
  uint64x2_t v8; // q1
  int64x2_t v9; // q2
  unsigned __int64 v10; // d3
  int v11; // w19

  v2 = (int *)malloc(4 * size);
  if ( !v2 )
    return -1;
  if ( size )
  {
    v4 = 0;
    v5 = (size + 1) & 0xFFFFFFFFFFFFFFFELL;
    v6 = (int64x2_t)xmmword_2E70;
    v7 = v2 + 1;
    v8 = vdupq_n_s64(size - 1);
    v9 = vdupq_n_s64(2u);
    do
    {
      v10 = vmovn_s64(vcgeq_u64(v8, v6)).n64_u64[0];
      if ( (v10 & 1) != 0 )
        *(v7 - 1) = v4;
      if ( (v10 & 0x100000000LL) != 0 )
        *v7 = v4 + 10;
      v6 = vaddq_s64(v6, v9);
      v7 += 2;
      v5 -= 2LL;
      v4 += 20;
    }
    while ( v5 );
    v3 = *v2;
  }
  v11 = v2[size - 1] + v3;
  free(v2);
  return v11;
}


/* Function: call_malloc_free @ 0x1C34 */
int __cdecl call_malloc_free()
{
  return param_malloc_free(0xAu);
}


/* Function: param_memset @ 0x1C3C */
int __fastcall param_memset(void *buffer, size_t size)
{
  size_t v2; // x19
  unsigned __int8 *v3; // x20
  int result; // w0
  int v5; // t1

  v2 = size;
  v3 = (unsigned __int8 *)buffer;
  memset(buffer, 0, size);
  for ( result = 0; v2; result += v5 )
  {
    v5 = *v3++;
    --v2;
  }
  return result;
}


/* Function: call_memset @ 0x1C80 */
int __cdecl call_memset()
{
  return 0;
}


/* Function: param_strchr_strstr @ 0x1C88 */
int __fastcall param_strchr_strstr(const char *str, char ch, const char *substr)
{
  char *v5; // x0
  int v6; // w21
  char *v7; // x0
  int v8; // w8

  v5 = strchr(str, (unsigned __int8)ch);
  if ( v5 )
    v6 = (_DWORD)v5 - (_DWORD)str;
  else
    v6 = -1;
  v7 = strstr(str, substr);
  v8 = (_DWORD)v7 - (_DWORD)str;
  if ( !v7 )
    v8 = -1;
  return v8 + v6;
}


/* Function: call_strchr_strstr @ 0x1CE0 */
int __cdecl call_strchr_strstr()
{
  return 15;
}


/* Function: test_standard_library_functions @ 0x1CE8 */
void __cdecl test_standard_library_functions()
{
  size_t v0; // x0
  unsigned int v1; // w0
  unsigned int v2; // w0
  __int64 v3; // x1
  __int64 v4; // x1
  unsigned int v5; // w0
  unsigned int v6; // w0
  char v7[32]; // [xsp+0h] [xbp-20h] BYREF
  int v8; // [xsp+3Ch] [xbp+1Ch] BYREF

  puts(asc_31FC);
  strcpy(v7, "HelloLib");
  v0 = strlen(v7);
  printf(aLibL101D, v0);
  printf(aLibL102D, 0);
  printf(aLibL103D, 12);
  printf(aLibL104D, 90);
  v1 = call_memcmp();
  printf(aLibL105D, v1);
  v2 = printf("Value: %d, Name: %s\n", 42, "Test");
  printf(aLibL106D, v2);
  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", v7, &v8) == 2 )
    v3 = (unsigned int)(v8 + *(_DWORD *)v7);
  else
    v3 = 0xFFFFFFFFLL;
  printf(aLibL107D, v3);
  if ( param_fopen_fclose("/etc/passwd") < 0 )
    v4 = 0xFFFFFFFFLL;
  else
    v4 = 42;
  printf(aLibL108D, v4);
  v5 = param_fread_fwrite("/tmp/binbench_test.tmp");
  printf(aLibL109D, v5);
  v6 = param_malloc_free(0xAu);
  printf(aLibL110D, v6);
  printf(aLibL111D, 0);
  printf(aLibL112D, 15);
}


/* Function: param_linux_syscall @ 0x1E60 */
int __fastcall param_linux_syscall(const char *pathname)
{
  unsigned int v1; // w19

  v1 = syscall(56, 4294967196LL, pathname, 0);
  if ( (v1 & 0x80000000) != 0 )
    return -*__errno_location();
  syscall(57, v1);
  return v1;
}


/* Function: call_linux_syscall @ 0x1EB4 */
int __cdecl call_linux_syscall()
{
  if ( param_linux_syscall("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_win32_api @ 0x1EDC */
int __fastcall param_win32_api(const char *filename)
{
  int v1; // w0
  int v2; // w8
  struct stat v4; // [xsp+0h] [xbp-80h] BYREF

  v1 = stat(filename, &v4);
  if ( v4.st_size <= 0 )
    v2 = -2;
  else
    v2 = 42;
  if ( v1 < 0 )
    return -1;
  else
    return v2;
}


/* Function: call_win32_api @ 0x1F18 */
int __cdecl call_win32_api()
{
  int v0; // w0
  int v1; // w8
  struct stat v3; // [xsp+0h] [xbp-80h] BYREF

  v0 = stat("/etc/passwd", &v3);
  if ( v3.st_size <= 0 )
    v1 = -2;
  else
    v1 = 42;
  if ( v0 < 0 )
    return -1;
  else
    return v1;
}


/* Function: param_fork_exec @ 0x1F5C */
int __fastcall param_fork_exec(const char *prog, const char *arg)
{
  __pid_t v4; // w0
  int status; // [xsp+Ch] [xbp-4h] BYREF

  v4 = fork();
  if ( v4 < 0 )
    return -1;
  if ( !v4 )
  {
    execl(prog, prog, arg, 0);
    _exit(127);
  }
  if ( waitpid(v4, &status, 0) < 0 )
    return -2;
  if ( (status & 0x7F) != 0 )
    return -3;
  return BYTE1(status);
}


/* Function: call_fork_exec @ 0x1FE4 */
int __cdecl call_fork_exec()
{
  if ( param_fork_exec("/bin/true", 0) )
    return -1;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x2010 */
int __cdecl param_pipe_communication()
{
  __pid_t v0; // w0
  ssize_t v1; // x19
  int v2; // w0
  __WAIT_STATUS v3; // x0
  _BYTE buf[32]; // [xsp+8h] [xbp-28h] BYREF
  int pipefd[2]; // [xsp+28h] [xbp-8h] BYREF

  if ( pipe(pipefd) < 0 )
    return -1;
  v0 = fork();
  if ( v0 < 0 )
    return -2;
  if ( !v0 )
  {
    close(pipefd[0]);
    write(pipefd[1], "HelloPipe", 9u);
    close(pipefd[1]);
    _exit(0);
  }
  close(pipefd[1]);
  v1 = read(pipefd[0], buf, 0x1Fu);
  v2 = pipefd[0];
  buf[v1] = 0;
  close(v2);
  v3.__uptr = 0;
  wait(v3);
  if ( v1 <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x20C8 */
// attributes: thunk
int __cdecl call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x20CC */
int __cdecl param_socket_create()
{
  int v0; // w0
  int v1; // w19
  int v2; // w20
  struct sockaddr addr; // [xsp+8h] [xbp-18h] BYREF
  int opt; // [xsp+1Ch] [xbp-4h] BYREF

  v0 = socket(2, 1, 0);
  if ( v0 < 0 )
    return -1;
  v1 = v0;
  opt = 1;
  if ( setsockopt(v0, 1, 2, &opt, 4u) < 0 )
  {
    close(v1);
    return -2;
  }
  else
  {
    *(_QWORD *)&addr.sa_family = 2;
    *(_QWORD *)&addr.sa_data[6] = 0;
    if ( bind(v1, &addr, 0x10u) < 0 )
    {
      close(v1);
      return -3;
    }
    else
    {
      v2 = listen(v1, 5);
      close(v1);
      if ( v2 >= 0 )
        return 42;
      else
        return -4;
    }
  }
}


/* Function: call_socket_create @ 0x2190 */
// attributes: thunk
int __cdecl call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x2194 */
int __cdecl param_shmget_shmat()
{
  int v0; // w0
  key_t v1; // w0
  int v2; // w0
  int v3; // w19
  char *v4; // x0
  char *v5; // x21
  int v6; // w20

  v0 = open("/tmp/binbench_shm", 66, 438);
  if ( v0 < 0 )
    return -1;
  close(v0);
  v1 = ftok("/tmp/binbench_shm", 42);
  if ( v1 < 0 )
    return -1;
  v2 = shmget(v1, 0x1000u, 950);
  if ( v2 < 0 )
    return -2;
  v3 = v2;
  v4 = (char *)shmat(v2, 0, 0);
  if ( v4 == (char *)-1LL )
    return -3;
  v5 = v4;
  strcpy(v4, "SharedMemory");
  v6 = strlen(v4);
  shmdt(v5);
  shmctl(v3, 0, 0);
  return v6;
}


/* Function: call_shmget_shmat @ 0x2264 */
int __cdecl call_shmget_shmat()
{
  if ( param_shmget_shmat() <= 0 )
    return -1;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x2284 */
int __cdecl param_signal_handling()
{
  unsigned int v0; // w20
  bool v1; // cc
  unsigned int v2; // w21
  bool v3; // cc

  if ( signal(10, signal_handler) == (__sighandler_t)-1LL )
    return -1;
  if ( signal(14, signal_handler) == (__sighandler_t)-1LL )
    return -2;
  signal_received = 0;
  raise(10);
  if ( !signal_received )
  {
    v0 = 1000;
    do
    {
      usleep(0x3E8u);
      if ( signal_received )
        v1 = 0;
      else
        v1 = v0 > 1;
      --v0;
    }
    while ( v1 );
  }
  if ( !signal_received )
    return -3;
  if ( signal_number != 10 )
    return -4;
  signal_received = 0;
  alarm(1u);
  if ( !signal_received )
  {
    v2 = 2000;
    do
    {
      usleep(0x3E8u);
      if ( signal_received )
        v3 = 0;
      else
        v3 = v2 > 1;
      --v2;
    }
    while ( v3 );
  }
  if ( !signal_received || signal_number != 14 )
    return -5;
  signal(10, 0);
  signal(14, 0);
  return 42;
}


/* Function: signal_handler @ 0x23B8 */
void __fastcall signal_handler(int sig)
{
  signal_received = 1;
  signal_number = sig;
}


/* Function: call_signal_handling @ 0x23D0 */
// attributes: thunk
int __cdecl call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x23D4 */
void __cdecl test_system_calls()
{
  __int64 v0; // x1
  int v1; // w0
  unsigned int v2; // w8
  __int64 v3; // x1
  __int64 v4; // x1
  unsigned int v5; // w0
  unsigned int v6; // w0
  __int64 v7; // x1
  unsigned int v8; // w0
  struct stat v9; // [xsp+0h] [xbp-80h] BYREF

  puts(asc_3220);
  if ( param_linux_syscall("/etc/passwd") < 0 )
    v0 = 0xFFFFFFFFLL;
  else
    v0 = 42;
  printf(aSysL301D, v0);
  v1 = stat("/etc/passwd", &v9);
  if ( v9.st_size <= 0 )
    v2 = -2;
  else
    v2 = 42;
  if ( v1 < 0 )
    v3 = 0xFFFFFFFFLL;
  else
    v3 = v2;
  printf(aSysL302D, v3);
  if ( param_fork_exec("/bin/true", 0) )
    v4 = 0xFFFFFFFFLL;
  else
    v4 = 42;
  printf(aSysL303D, v4);
  v5 = param_pipe_communication();
  printf(aSysL304D, v5);
  v6 = param_socket_create();
  printf(aSysL305D, v6);
  if ( param_shmget_shmat() <= 0 )
    v7 = 0xFFFFFFFFLL;
  else
    v7 = 42;
  printf(aSysL306D, v7);
  v8 = param_signal_handling();
  printf(aSysL307D, v8);
}


/* Function: thread_compute @ 0x24CC */
void *__fastcall thread_compute(void *arg)
{
  int v1; // w19
  void *result; // x0

  v1 = *(_DWORD *)arg * *(_DWORD *)arg;
  result = malloc(4u);
  *(_DWORD *)result = v1;
  return result;
}


/* Function: param_pthread_create @ 0x24F8 */
int __fastcall param_pthread_create(int x)
{
  int v1; // w19
  void *ptr; // [xsp+0h] [xbp-10h] BYREF
  int arg; // [xsp+Ch] [xbp-4h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+18h] BYREF

  arg = x;
  if ( pthread_create(&newthread, 0, thread_compute, &arg) )
    return -1;
  pthread_join(newthread, &ptr);
  v1 = *(_DWORD *)ptr;
  free(ptr);
  return v1;
}


/* Function: call_pthread_create @ 0x255C */
int __cdecl call_pthread_create()
{
  return param_pthread_create(7);
}


/* Function: thread_sum @ 0x2564 */
void *__fastcall thread_sum(void *arg)
{
  int v1; // w8
  int v2; // w9

  v1 = *(_DWORD *)arg;
  v2 = *((_DWORD *)arg + 1);
  *((_DWORD *)arg + 2) = 0;
  if ( v2 >= v1 )
    *((_DWORD *)arg + 2) = v2
                         + (v2 - v1) * v1
                         + (((unsigned int)(v2 + ~v1) * (unsigned __int64)(unsigned int)(v2 - v1)) >> 1);
  return 0;
}


/* Function: param_pthread_join @ 0x2598 */
int __cdecl param_pthread_join()
{
  __int64 v0; // x21
  __int64 *v1; // x19
  __int64 v2; // x20
  int v3; // w19
  int *v4; // x21
  int v5; // t1
  __int64 v7; // [xsp+0h] [xbp-40h] BYREF
  int v8; // [xsp+8h] [xbp-38h] BYREF
  __int64 v9; // [xsp+Ch] [xbp-34h]
  int v10; // [xsp+14h] [xbp-2Ch]
  __int64 v11; // [xsp+18h] [xbp-28h]
  int v12; // [xsp+20h] [xbp-20h]
  pthread_t tids[3]; // [xsp+28h] [xbp-18h] BYREF

  v0 = 0;
  v8 = 0;
  v10 = 0;
  v1 = &v7;
  v12 = 0;
  v7 = 0xA00000001LL;
  v9 = 0x140000000BLL;
  v11 = 0x1E00000015LL;
  do
  {
    if ( pthread_create(&tids[v0], 0, thread_sum, v1) )
      return -1;
    v1 = (__int64 *)((char *)v1 + 12);
    ++v0;
  }
  while ( v0 != 3 );
  v2 = 0;
  v3 = 0;
  v4 = &v8;
  while ( !pthread_join(tids[v2], 0) )
  {
    v5 = *v4;
    v4 += 3;
    ++v2;
    v3 += v5;
    if ( v2 == 3 )
      return v3;
  }
  return -2;
}


/* Function: call_pthread_join @ 0x2674 */
// attributes: thunk
int __cdecl call_pthread_join()
{
  return param_pthread_join();
}


/* Function: thread_increment @ 0x2678 */
void *__fastcall thread_increment(void *arg)
{
  int v1; // w20

  v1 = *(_DWORD *)arg;
  if ( *(int *)arg >= 1 )
  {
    do
    {
      pthread_mutex_lock(&counter_mutex);
      ++shared_counter;
      pthread_mutex_unlock(&counter_mutex);
      usleep(0x3E8u);
      --v1;
    }
    while ( v1 );
  }
  return 0;
}


/* Function: param_mutex_lock @ 0x26E0 */
int __fastcall param_mutex_lock(int thread_count, int iterations_per_thread)
{
  char *v3; // x0
  char *v4; // x20
  __int64 v5; // x23
  __int64 v6; // x24
  pthread_t *v7; // x21
  pthread_t v8; // t1
  int arg; // [xsp+1Ch] [xbp+1Ch] BYREF

  arg = iterations_per_thread;
  v3 = (char *)malloc(8LL * thread_count);
  if ( !v3 )
    return -1;
  v4 = v3;
  shared_counter = 0;
  if ( thread_count >= 1 )
  {
    v5 = (unsigned int)thread_count;
    v6 = 0;
    do
    {
      if ( pthread_create((pthread_t *)&v4[v6], 0, thread_increment, &arg) )
      {
        free(v4);
        return -2;
      }
      v6 += 8;
    }
    while ( 8LL * (unsigned int)thread_count != v6 );
    v7 = (pthread_t *)v4;
    do
    {
      v8 = *v7++;
      pthread_join(v8, 0);
      --v5;
    }
    while ( v5 );
  }
  free(v4);
  if ( shared_counter == arg * thread_count )
    return 42;
  else
    return -3;
}


/* Function: call_mutex_lock @ 0x27CC */
int __cdecl call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: consumer_thread @ 0x27D8 */
_DWORD *__fastcall consumer_thread(void *arg)
{
  int v1; // w19
  _DWORD *result; // x0

  pthread_mutex_lock(&cond_mutex);
  if ( (ready & 1) == 0 )
  {
    do
      pthread_cond_wait(&cond, &cond_mutex);
    while ( ready != 1 );
  }
  if ( data )
    v1 = 42;
  else
    v1 = 0;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *result = v1;
  return result;
}


/* Function: producer_thread @ 0x2864 */
void *__fastcall producer_thread(void *arg)
{
  sleep(1u);
  pthread_mutex_lock(&cond_mutex);
  data = 1;
  ready = 1;
  pthread_cond_signal(&cond);
  pthread_mutex_unlock(&cond_mutex);
  return 0;
}


/* Function: param_condition_variable @ 0x28C0 */
int __cdecl param_condition_variable()
{
  int v0; // w19
  void *ptr; // [xsp+0h] [xbp-10h] BYREF
  pthread_t newthread; // [xsp+8h] [xbp-8h] BYREF
  pthread_t th; // [xsp+28h] [xbp+18h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))consumer_thread, 0) )
    return -1;
  if ( pthread_create(&th, 0, producer_thread, 0) )
  {
    pthread_cancel(newthread);
    return -2;
  }
  else
  {
    pthread_join(newthread, &ptr);
    pthread_join(th, 0);
    v0 = *(_DWORD *)ptr;
    free(ptr);
  }
  return v0;
}


/* Function: call_condition_variable @ 0x2968 */
// attributes: thunk
int __cdecl call_condition_variable()
{
  return param_condition_variable();
}


/* Function: thread_atomic_increment @ 0x296C */
void *__fastcall thread_atomic_increment(void *arg)
{
  int v1; // w21
  unsigned int v2; // w19

  v1 = *(_DWORD *)arg;
  if ( *(int *)arg >= 1 )
  {
    v2 = 0;
    do
    {
      _aarch64_ldadd4_acq_rel(1, &atomic_counter);
      _aarch64_cas4_acq_rel(v2, v2 + 1000, &atomic_counter);
      ++v2;
    }
    while ( v2 != v1 );
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x29D0 */
void *__fastcall thread_atomic_load_store(void *arg)
{
  void *result; // x0
  unsigned int v2; // w9

  result = 0;
  v2 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v2 + 100, (unsigned int *)&atomic_counter);
  return result;
}


/* Function: param_atomic_ops @ 0x29EC */
int __fastcall param_atomic_ops(int thread_count, int iterations)
{
  __int64 v2; // x20
  pthread_t *v3; // x0
  pthread_t *v4; // x19
  __int64 v5; // x23
  pthread_t *v6; // x21
  pthread_t v7; // t1
  int v8; // w20
  pthread_t th; // [xsp+0h] [xbp-10h] BYREF
  int iterationsa; // [xsp+Ch] [xbp-4h] BYREF

  LODWORD(v2) = thread_count;
  iterationsa = iterations;
  v3 = (pthread_t *)malloc(8LL * thread_count);
  if ( !v3 )
    return -1;
  v4 = v3;
  atomic_store(0, (unsigned int *)&atomic_counter);
  if ( (int)v2 < 1 )
  {
LABEL_6:
    if ( !pthread_create(&th, 0, thread_atomic_load_store, 0) )
      pthread_join(th, 0);
    if ( (int)v2 >= 1 )
    {
      v2 = (unsigned int)v2;
      v6 = v4;
      do
      {
        v7 = *v6++;
        pthread_join(v7, 0);
        --v2;
      }
      while ( v2 );
    }
    v8 = atomic_load((unsigned int *)&atomic_counter);
    free(v4);
    if ( v8 <= 0 )
      return -3;
    else
      return 42;
  }
  else
  {
    v5 = 0;
    while ( !pthread_create(&v4[v5], 0, thread_atomic_increment, &iterationsa) )
    {
      if ( (unsigned int)v2 == ++v5 )
        goto LABEL_6;
    }
    free(v4);
    return -2;
  }
}


/* Function: call_atomic_ops @ 0x2B00 */
int __cdecl call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: thread_tls_test @ 0x2B0C */
void *__fastcall thread_tls_test(void *arg)
{
  unsigned __int64 StatusReg; // x8
  int v2; // w19
  void *result; // x0

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v2 = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = v2 + 50;
  strncpy((char *)(StatusReg + 20), (const char *)arg, 0x1Fu);
  result = malloc(8u);
  *(_DWORD *)result = v2;
  *((_DWORD *)result + 1) = v2 + 50;
  return result;
}


/* Function: param_thread_local_storage @ 0x2B5C */
int __fastcall param_thread_local_storage(int thread_count)
{
  size_t v2; // x21
  void *v3; // x19
  void *v4; // x21
  int result; // w0
  __int64 v6; // x22
  __int64 v7; // x24
  char *v8; // x0
  __int64 v9; // x25
  pthread_t *v10; // x22
  int v12; // w23
  int v13; // w22
  pthread_t *v14; // x25
  void **v15; // x26
  pthread_t v16; // t1
  void *v17; // t1
  __int64 v19; // x20
  void *thread_return; // [xsp+8h] [xbp-8h] BYREF

  v2 = 8LL * thread_count;
  v3 = malloc(v2);
  v4 = malloc(v2);
  result = -1;
  if ( v3 && v4 )
  {
    if ( thread_count < 1 )
    {
      v13 = 0;
      v12 = 0;
LABEL_13:
      free(v4);
      free(v3);
      if ( v12 == 150 * thread_count && v13 == 100 * thread_count )
        return 42;
      else
        return -3;
    }
    else
    {
      v6 = 0;
      v7 = (unsigned int)thread_count;
      do
      {
        v8 = (char *)malloc(0x10u);
        *((_QWORD *)v4 + v6) = v8;
        snprintf(v8, 0x10u, "Thread-%d", v6++);
      }
      while ( thread_count != v6 );
      v9 = 0;
      v10 = (pthread_t *)v3;
      while ( !pthread_create(v10, 0, thread_tls_test, *((void **)v4 + v9++)) )
      {
        ++v10;
        if ( thread_count == v9 )
        {
          v12 = 0;
          v13 = 0;
          v14 = (pthread_t *)v3;
          v15 = (void **)v4;
          do
          {
            v16 = *v14++;
            pthread_join(v16, &thread_return);
            v13 += *(_DWORD *)thread_return;
            v12 += *((_DWORD *)thread_return + 1);
            free(thread_return);
            v17 = *v15++;
            free(v17);
            --v7;
          }
          while ( v7 );
          goto LABEL_13;
        }
      }
      v19 = 0;
      do
        free(*((void **)v4 + v19++));
      while ( v9 != v19 );
      free(v4);
      free(v3);
      return -2;
    }
  }
  return result;
}


/* Function: call_thread_local_storage @ 0x2CF8 */
int __cdecl call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x2D00 */
void __cdecl test_thread_concurrency()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  puts(asc_323B);
  v0 = param_pthread_create(7);
  printf(aThrL301D, v0);
  v1 = param_pthread_join();
  printf(aThrL302D, v1);
  v2 = param_mutex_lock(4, 1000);
  printf(aThrL303D, v2);
  v3 = param_condition_variable();
  printf(aThrL304D, v3);
  v4 = param_atomic_ops(4, 500);
  printf(aThrL305D, v4);
  v5 = param_thread_local_storage(4);
  printf(aThrL306D, v5);
}


/* Function: main @ 0x2DA8 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_standard_library_functions();
  test_system_calls();
  test_thread_concurrency();
  return 0;
}


/* Function: __aarch64_cas4_acq_rel @ 0x2DD0 */
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


/* Function: __aarch64_ldadd4_acq_rel @ 0x2E10 */
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


/* Function: .term_proc @ 0x2E40 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x14358 */

/* FAILED to decompile: _exit @ 0x14360 */

/* FAILED to decompile: strlen @ 0x14368 */

/* FAILED to decompile: raise @ 0x14370 */

/* FAILED to decompile: __libc_start_main @ 0x14378 */

/* FAILED to decompile: execl @ 0x14380 */

/* FAILED to decompile: listen @ 0x14388 */

/* FAILED to decompile: shmdt @ 0x14390 */

/* FAILED to decompile: bind @ 0x14398 */

/* FAILED to decompile: __cxa_finalize @ 0x143A0 */

/* FAILED to decompile: pipe @ 0x143A8 */

/* FAILED to decompile: fork @ 0x143B0 */

/* FAILED to decompile: snprintf @ 0x143B8 */

/* FAILED to decompile: fileno @ 0x143C0 */

/* FAILED to decompile: signal @ 0x143C8 */

/* FAILED to decompile: fclose @ 0x143D0 */

/* FAILED to decompile: fopen @ 0x143D8 */

/* FAILED to decompile: malloc @ 0x143E0 */

/* FAILED to decompile: setsockopt @ 0x143E8 */

/* FAILED to decompile: open @ 0x143F0 */

/* FAILED to decompile: pthread_cond_signal @ 0x143F8 */

/* FAILED to decompile: memset @ 0x14400 */

/* FAILED to decompile: shmat @ 0x14408 */

/* FAILED to decompile: sleep @ 0x14410 */

/* FAILED to decompile: rewind @ 0x14418 */

/* FAILED to decompile: close @ 0x14420 */

/* FAILED to decompile: stat_0 @ 0x14428 */

/* FAILED to decompile: write @ 0x14430 */

/* FAILED to decompile: __getauxval @ 0x14438 */

/* FAILED to decompile: abort @ 0x14440 */

/* FAILED to decompile: puts @ 0x14448 */

/* FAILED to decompile: memcmp @ 0x14450 */

/* FAILED to decompile: strcmp @ 0x14458 */

/* FAILED to decompile: shmctl @ 0x14460 */

/* FAILED to decompile: fread @ 0x14468 */

/* FAILED to decompile: ftok @ 0x14470 */

/* FAILED to decompile: free @ 0x14478 */

/* FAILED to decompile: shmget @ 0x14480 */

/* FAILED to decompile: pthread_cond_wait @ 0x14488 */

/* FAILED to decompile: strchr @ 0x14490 */

/* FAILED to decompile: fwrite @ 0x14498 */

/* FAILED to decompile: pthread_create @ 0x144A0 */

/* FAILED to decompile: wait @ 0x144A8 */

/* FAILED to decompile: socket @ 0x144B0 */

/* FAILED to decompile: strcpy @ 0x144B8 */

/* FAILED to decompile: read @ 0x144C0 */

/* FAILED to decompile: strstr @ 0x144C8 */

/* FAILED to decompile: usleep @ 0x144D0 */

/* FAILED to decompile: __isoc99_sscanf @ 0x144D8 */

/* FAILED to decompile: strncpy @ 0x144E0 */

/* FAILED to decompile: printf @ 0x144E8 */

/* FAILED to decompile: __errno_location @ 0x144F0 */

/* FAILED to decompile: pthread_join @ 0x144F8 */

/* FAILED to decompile: alarm @ 0x14500 */

/* FAILED to decompile: pthread_cancel @ 0x14508 */

/* FAILED to decompile: pthread_mutex_lock @ 0x14510 */

/* FAILED to decompile: syscall @ 0x14518 */

/* FAILED to decompile: pthread_mutex_unlock @ 0x14520 */

/* FAILED to decompile: waitpid @ 0x14528 */

/* FAILED to decompile: unlink @ 0x14530 */

/* FAILED to decompile: __gmon_start__ @ 0x14540 */

/* Total functions decompiled: 75, failed: 61 */
