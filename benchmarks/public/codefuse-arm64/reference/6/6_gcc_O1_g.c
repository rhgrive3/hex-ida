/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_gcc_O1_g
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


/* Function: init_have_lse_atomics @ 0x17C0 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x1800 */
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


/* Function: call_weak_fn @ 0x1834 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x1850 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x1880 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x18C0 */
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


/* Function: frame_dummy @ 0x1910 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: signal_handler @ 0x1914 */
void __fastcall signal_handler(int sig)
{
  signal_received = 1;
  signal_number = sig;
}


/* Function: thread_sum @ 0x192C */
void *__fastcall thread_sum(void *arg)
{
  int v1; // w1
  int v2; // w3
  int v3; // w3
  int v4; // w2

  *((_DWORD *)arg + 2) = 0;
  v1 = *(_DWORD *)arg;
  v2 = *((_DWORD *)arg + 1);
  if ( *(_DWORD *)arg <= v2 )
  {
    v3 = v2 + 1;
    v4 = 0;
    do
      v4 += v1++;
    while ( v1 != v3 );
    *((_DWORD *)arg + 2) = v4;
  }
  return 0;
}


/* Function: thread_compute @ 0x1964 */
void *__fastcall thread_compute(void *arg)
{
  int v1; // w19
  void *result; // x0

  v1 = *(_DWORD *)arg;
  result = malloc(4u);
  *(_DWORD *)result = v1 * v1;
  return result;
}


/* Function: thread_increment @ 0x1990 */
void *__fastcall thread_increment(void *arg)
{
  int v1; // w22
  int v2; // w19

  v1 = *(_DWORD *)arg;
  if ( *(int *)arg > 0 )
  {
    v2 = 0;
    do
    {
      pthread_mutex_lock(&counter_mutex);
      ++shared_counter;
      pthread_mutex_unlock(&counter_mutex);
      usleep(0x3E8u);
      ++v2;
    }
    while ( v1 != v2 );
  }
  return 0;
}


/* Function: consumer_thread @ 0x1A0C */
void *__fastcall consumer_thread(void *arg)
{
  int v1; // w19
  void *result; // x0

  pthread_mutex_lock(&cond_mutex);
  while ( !ready )
    pthread_cond_wait(&cond, &cond_mutex);
  v1 = data;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *(_DWORD *)result = v1;
  return result;
}


/* Function: producer_thread @ 0x1A88 */
void *__fastcall producer_thread(void *arg)
{
  sleep(1u);
  pthread_mutex_lock(&cond_mutex);
  data = 42;
  ready = 1;
  pthread_cond_signal(&cond);
  pthread_mutex_unlock(&cond_mutex);
  return 0;
}


/* Function: thread_atomic_increment @ 0x1AE0 */
void *__fastcall thread_atomic_increment(void *arg)
{
  int v1; // w21
  unsigned int v2; // w19

  v1 = *(_DWORD *)arg;
  if ( *(int *)arg > 0 )
  {
    v2 = 0;
    do
    {
      _aarch64_ldadd4_acq_rel(1, &atomic_counter);
      _aarch64_cas4_acq_rel(v2, v2 + 1000, &atomic_counter);
      ++v2;
    }
    while ( v1 != v2 );
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x1B4C */
void *__fastcall thread_atomic_load_store(void *arg)
{
  unsigned int v1; // w1

  v1 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v1 + 100, (unsigned int *)&atomic_counter);
  return 0;
}


/* Function: thread_tls_test @ 0x1B6C */
void *__fastcall thread_tls_test(void *arg)
{
  unsigned __int64 StatusReg; // x3
  int v2; // w20
  void *result; // x0

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v2 = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = v2 + 50;
  strncpy((char *)(StatusReg + 24), (const char *)arg, 0x1Fu);
  result = malloc(8u);
  *(_DWORD *)result = v2;
  *((_DWORD *)result + 1) = v2 + 50;
  return result;
}


/* Function: param_strcpy @ 0x1BC0 */
int __fastcall param_strcpy(char *dst, const char *src)
{
  strcpy(dst, src);
  return strlen(dst);
}


/* Function: call_strcpy @ 0x1BE8 */
int __cdecl call_strcpy()
{
  char buffer[32]; // [xsp+18h] [xbp+18h] BYREF

  return param_strcpy(buffer, "HelloLib");
}


/* Function: param_strcmp @ 0x1C3C */
int __fastcall param_strcmp(const char *s1, const char *s2)
{
  int v2; // w0

  v2 = strcmp(s1, s2);
  if ( v2 > 0 )
    return 1;
  else
    return v2 >> 31;
}


/* Function: call_strcmp @ 0x1C5C */
int __cdecl call_strcmp()
{
  int v0; // w19
  int v1; // w20

  v0 = param_strcmp("abc", "def");
  v1 = param_strcmp("xyz", "xyz");
  return v0 + v1 + param_strcmp("bbb", "aaa");
}


/* Function: param_strlen @ 0x1CBC */
int __fastcall param_strlen(const char *str)
{
  return strlen(str);
}


/* Function: call_strlen @ 0x1CD0 */
int __cdecl call_strlen()
{
  return 12;
}


/* Function: param_memcpy @ 0x1CD8 */
int __fastcall param_memcpy(void *dst, const void *src, size_t n)
{
  int v3; // w19

  v3 = n;
  memcpy(dst, src, n);
  return v3;
}


/* Function: call_memcpy @ 0x1CFC */
int __cdecl call_memcpy()
{
  int src[5]; // [xsp+18h] [xbp+18h] BYREF
  int dst[6]; // [xsp+30h] [xbp+30h] BYREF

  *(_QWORD *)src = 0x140000000ALL;
  *(_QWORD *)&src[2] = 0x280000001ELL;
  src[4] = 50;
  memset(dst, 0, 20);
  param_memcpy(dst, src, 0x14u);
  return dst[0] + dst[2] + dst[4];
}


/* Function: param_memcmp @ 0x1D84 */
int __fastcall param_memcmp(const void *p1, const void *p2, size_t n)
{
  int v3; // w0

  v3 = memcmp(p1, p2, n);
  if ( v3 > 0 )
    return 1;
  else
    return v3 >> 31;
}


/* Function: call_memcmp @ 0x1DA4 */
int __cdecl call_memcmp()
{
  int v0; // w20
  int arr1[3]; // [xsp+38h] [xbp+38h] BYREF
  int arr2[3]; // [xsp+48h] [xbp+48h] BYREF
  int arr3[3]; // [xsp+58h] [xbp+58h] BYREF

  *(_QWORD *)arr1 = 0x200000001LL;
  arr1[2] = 3;
  *(_QWORD *)arr2 = 0x200000001LL;
  arr2[2] = 4;
  *(_QWORD *)arr3 = 0x200000001LL;
  arr3[2] = 3;
  v0 = param_memcmp(arr1, arr2, 0xCu);
  return v0 + param_memcmp(arr1, arr3, 0xCu);
}


/* Function: param_printf @ 0x1E58 */
int __fastcall param_printf(int x, const char *name)
{
  return __printf_chk(1, "Value: %d, Name: %s\n", x, name);
}


/* Function: call_printf @ 0x1E80 */
int __cdecl call_printf()
{
  return param_printf(42, "Test");
}


/* Function: param_scanf @ 0x1EA0 */
int __fastcall param_scanf(const char *input_str)
{
  int a; // [xsp+10h] [xbp+10h] BYREF
  int b; // [xsp+14h] [xbp+14h] BYREF

  if ( (unsigned int)__isoc99_sscanf(input_str, "%d,%d", &a, &b) == 2 )
    return a + b;
  else
    return -1;
}


/* Function: call_scanf @ 0x1F14 */
int __cdecl call_scanf()
{
  return param_scanf("123,456");
}


/* Function: param_fopen_fclose @ 0x1F30 */
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


/* Function: call_fopen_fclose @ 0x1F78 */
int __cdecl call_fopen_fclose()
{
  if ( param_fopen_fclose("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1FA0 */
int __fastcall param_fread_fwrite(const char *tmpfile)
{
  FILE *v2; // x0
  FILE *v3; // x19
  size_t v4; // x20
  char read_buffer[32]; // [xsp+38h] [xbp+38h] BYREF

  v2 = fopen(tmpfile, "w+");
  if ( !v2 )
    return -1;
  v3 = v2;
  if ( fwrite("BinBench Test Data", 1u, 0x12u, v2) == 18 )
  {
    rewind(v3);
    v4 = fread(read_buffer, 1u, 0x12u, v3);
    read_buffer[v4] = 0;
    fclose(v3);
    unlink(tmpfile);
    if ( v4 == 18 )
    {
      if ( !strcmp(read_buffer, "BinBench Test Data") )
        return 42;
      else
        return -3;
    }
    else
    {
      return -3;
    }
  }
  else
  {
    fclose(v3);
    return -2;
  }
}


/* Function: call_fread_fwrite @ 0x20B8 */
int __cdecl call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x20D4 */
int __fastcall param_malloc_free(size_t size)
{
  size_t v2; // x19
  _DWORD *v3; // x0
  _DWORD *v4; // x2
  int v5; // w1
  int v6; // w19

  v2 = size;
  v3 = malloc(4 * size);
  if ( !v3 )
    return -1;
  if ( size )
  {
    v4 = v3;
    v5 = 0;
    do
    {
      *v4++ = v5;
      v5 += 10;
    }
    while ( v4 != &v3[v2] );
  }
  v6 = v3[v2 - 1] + *v3;
  free(v3);
  return v6;
}


/* Function: call_malloc_free @ 0x2140 */
int __cdecl call_malloc_free()
{
  return param_malloc_free(0xAu);
}


/* Function: param_memset @ 0x2158 */
int __fastcall param_memset(void *buffer, size_t size)
{
  unsigned __int8 *v4; // x3
  int result; // w0
  int v6; // t1

  memset(buffer, 0, size);
  if ( !size )
    return 0;
  v4 = (unsigned __int8 *)buffer;
  result = 0;
  do
  {
    v6 = *v4++;
    result += v6;
  }
  while ( v4 != (unsigned __int8 *)((char *)buffer + size) );
  return result;
}


/* Function: call_memset @ 0x21AC */
int __cdecl call_memset()
{
  int *v0; // x0
  int buffer[10]; // [xsp+10h] [xbp+10h] BYREF
  __int64 v3; // [xsp+38h] [xbp+38h] BYREF

  v0 = buffer;
  do
    *v0++ = 255;
  while ( v0 != (int *)&v3 );
  param_memset(buffer, 0x28u);
  return buffer[0] + buffer[9];
}


/* Function: param_strchr_strstr @ 0x2220 */
int __fastcall param_strchr_strstr(const char *str, char ch, const char *substr)
{
  char *v5; // x0
  int v6; // w20
  char *v7; // x0
  int v8; // w19
  int v9; // w0

  v5 = strchr(str, (unsigned __int8)ch);
  v6 = (_DWORD)v5 - (_DWORD)str;
  if ( !v5 )
    v6 = -1;
  v7 = strstr(str, substr);
  v8 = (_DWORD)v7 - (_DWORD)str;
  if ( v7 )
    v9 = v8;
  else
    v9 = -1;
  return v6 + v9;
}


/* Function: call_strchr_strstr @ 0x2278 */
int __cdecl call_strchr_strstr()
{
  return param_strchr_strstr("Hello BinBench Test", 66, "Bench");
}


/* Function: test_standard_library_functions @ 0x22A0 */
void __cdecl test_standard_library_functions()
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

  puts(asc_34C8);
  v0 = call_strcpy();
  __printf_chk(1, aLibL101D, v0);
  v1 = call_strcmp();
  __printf_chk(1, aLibL102D, v1);
  v2 = call_strlen();
  __printf_chk(1, aLibL103D, v2);
  v3 = call_memcpy();
  __printf_chk(1, aLibL104D, v3);
  v4 = call_memcmp();
  __printf_chk(1, aLibL105D, v4);
  v5 = call_printf();
  __printf_chk(1, aLibL106D, v5);
  v6 = call_scanf();
  __printf_chk(1, aLibL107D, v6);
  v7 = call_fopen_fclose();
  __printf_chk(1, aLibL108D, v7);
  v8 = call_fread_fwrite();
  __printf_chk(1, aLibL109D, v8);
  v9 = call_malloc_free();
  __printf_chk(1, aLibL110D, v9);
  v10 = call_memset();
  __printf_chk(1, aLibL111D, v10);
  v11 = call_strchr_strstr();
  __printf_chk(1, aLibL112D, v11);
}


/* Function: param_linux_syscall @ 0x23DC */
int __fastcall param_linux_syscall(const char *pathname)
{
  unsigned int v1; // w0
  int v2; // w19

  v1 = syscall(56, 4294967196LL, pathname, 0);
  if ( (v1 & 0x80000000) != 0 )
    return -*__errno_location();
  v2 = v1;
  syscall(57, v1);
  return v2;
}


/* Function: call_linux_syscall @ 0x2430 */
int __cdecl call_linux_syscall()
{
  if ( param_linux_syscall("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_win32_api @ 0x2458 */
int __fastcall param_win32_api(const char *filename)
{
  stat st; // [xsp+18h] [xbp+18h] BYREF

  if ( stat(filename, &st) < 0 )
    return -1;
  if ( st.st_size <= 0 )
    return -2;
  return 42;
}


/* Function: call_win32_api @ 0x24C4 */
int __cdecl call_win32_api()
{
  return param_win32_api("/etc/passwd");
}


/* Function: param_fork_exec @ 0x24E0 */
int __fastcall param_fork_exec(const char *prog, const char *arg)
{
  __pid_t v4; // w0
  __pid_t v5; // w1
  int result; // w0
  int status; // [xsp+24h] [xbp+24h] BYREF

  v4 = fork();
  if ( v4 < 0 )
    return -1;
  if ( !v4 )
  {
    execl(prog, prog, arg, 0);
    _exit(127);
  }
  v5 = waitpid(v4, &status, 0);
  result = -2;
  if ( (v5 & 0x80000000) == 0 )
  {
    result = BYTE1(status);
    if ( (status & 0x7F) != 0 )
      return -3;
  }
  return result;
}


/* Function: call_fork_exec @ 0x2590 */
int __cdecl call_fork_exec()
{
  if ( param_fork_exec("/bin/true", 0) )
    return -1;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x25BC */
int __cdecl param_pipe_communication()
{
  __pid_t v0; // w0
  ssize_t v1; // x19
  __WAIT_STATUS v2; // x0
  int pipefd[2]; // [xsp+20h] [xbp+20h] BYREF
  char buffer[32]; // [xsp+28h] [xbp+28h] BYREF

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
  v1 = read(pipefd[0], buffer, 0x1Fu);
  buffer[v1] = 0;
  close(pipefd[0]);
  v2.__uptr = 0;
  wait(v2);
  if ( v1 <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x26A4 */
int __cdecl call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x26B8 */
int __cdecl param_socket_create()
{
  int v0; // w0
  int v1; // w19
  int opt; // [xsp+24h] [xbp+24h] BYREF
  sockaddr_in addr; // [xsp+28h] [xbp+28h] BYREF

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
    *(_QWORD *)addr.sin_zero = 0;
    *(_QWORD *)&addr.sin_family = 2;
    if ( bind(v1, (const struct sockaddr *)&addr, 0x10u) < 0 )
    {
      close(v1);
      return -3;
    }
    else if ( listen(v1, 5) < 0 )
    {
      close(v1);
      return -4;
    }
    else
    {
      close(v1);
      return 42;
    }
  }
}


/* Function: call_socket_create @ 0x27BC */
int __cdecl call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x27D0 */
int __cdecl param_shmget_shmat()
{
  int v0; // w0
  key_t v1; // w0
  int v2; // w0
  int v3; // w20
  char *v4; // x0
  char *v5; // x19
  int v6; // w21

  v0 = open("/tmp/binbench_shm", 66, 438);
  if ( v0 < 0 )
    return -1;
  close(v0);
  v1 = ftok("/tmp/binbench_shm", 42);
  if ( v1 < 0 )
    return -1;
  v2 = shmget(v1, 0x1000u, 950);
  v3 = v2;
  if ( v2 < 0 )
    return -2;
  v4 = (char *)shmat(v2, 0, 0);
  v5 = v4;
  if ( v4 == (char *)-1LL )
    return -3;
  strcpy(v4, "SharedMemory");
  v6 = strlen(v4);
  shmdt(v5);
  shmctl(v3, 0, 0);
  return v6;
}


/* Function: call_shmget_shmat @ 0x28B4 */
int __cdecl call_shmget_shmat()
{
  if ( param_shmget_shmat() <= 0 )
    return -1;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x28D4 */
int __cdecl param_signal_handling()
{
  int v0; // w19
  int v1; // w19

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
        break;
      --v0;
    }
    while ( v0 );
  }
  if ( !signal_received )
    return -3;
  if ( signal_number != 10 )
    return -4;
  signal_received = 0;
  alarm(1u);
  if ( !signal_received )
  {
    v1 = 2000;
    do
    {
      usleep(0x3E8u);
      if ( signal_received )
        break;
      --v1;
    }
    while ( v1 );
  }
  if ( !signal_received )
    return -5;
  if ( signal_number != 14 )
    return -5;
  signal(10, 0);
  signal(14, 0);
  return 42;
}


/* Function: call_signal_handling @ 0x2A48 */
int __cdecl call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x2A5C */
void __cdecl test_system_calls()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0

  puts(asc_36B8);
  v0 = call_linux_syscall();
  __printf_chk(1, aSysL301D, v0);
  v1 = call_win32_api();
  __printf_chk(1, aSysL302D, v1);
  v2 = call_fork_exec();
  __printf_chk(1, aSysL303D, v2);
  v3 = param_pipe_communication();
  __printf_chk(1, aSysL304D, v3);
  v4 = param_socket_create();
  __printf_chk(1, aSysL305D, v4);
  v5 = call_shmget_shmat();
  __printf_chk(1, aSysL306D, v5);
  v6 = param_signal_handling();
  __printf_chk(1, aSysL307D, v6);
}


/* Function: param_pthread_create @ 0x2B20 */
int __fastcall param_pthread_create(int x)
{
  int v1; // w19
  int input; // [xsp+24h] [xbp+24h] BYREF
  pthread_t tid; // [xsp+28h] [xbp+28h] BYREF
  void *thread_ret; // [xsp+30h] [xbp+30h] BYREF

  input = x;
  if ( pthread_create(&tid, 0, thread_compute, &input) )
    return -1;
  pthread_join(tid, &thread_ret);
  v1 = *(_DWORD *)thread_ret;
  free(thread_ret);
  return v1;
}


/* Function: call_pthread_create @ 0x2BB0 */
int __cdecl call_pthread_create()
{
  return param_pthread_create(7);
}


/* Function: param_pthread_join @ 0x2BC8 */
int __cdecl param_pthread_join()
{
  ThreadData *v0; // x20
  pthread_t *v1; // x24
  pthread_t *v2; // x21
  int v3; // w22
  int v4; // w19
  __int64 v5; // x20
  pthread_t tids[3]; // [xsp+48h] [xbp+48h] BYREF
  ThreadData data[3]; // [xsp+60h] [xbp+60h] BYREF

  v0 = data;
  *(_OWORD *)&data[0].start = xmmword_38E0;
  *(_OWORD *)&data[1].end = xmmword_38F0;
  data[2].result = 0;
  v1 = tids;
  v2 = tids;
  v3 = 3;
  do
  {
    v4 = pthread_create(v2, 0, thread_sum, v0);
    if ( v4 )
      return -1;
    ++v2;
    ++v0;
    --v3;
  }
  while ( v3 );
  v5 = 0;
  while ( !pthread_join(*v1, 0) )
  {
    v4 += data[v5].result;
    ++v1;
    if ( ++v5 == 3 )
      return v4;
  }
  return -2;
}


/* Function: call_pthread_join @ 0x2CCC */
int __cdecl call_pthread_join()
{
  return param_pthread_join();
}


/* Function: param_mutex_lock @ 0x2CE0 */
int __fastcall param_mutex_lock(int thread_count, int iterations_per_thread)
{
  char *v3; // x0
  void *v4; // x24
  pthread_t *v5; // x21
  pthread_t *v6; // x20
  pthread_t *v7; // x19
  pthread_t v8; // t1
  int arg; // [xsp+5Ch] [xbp+5Ch] BYREF

  arg = iterations_per_thread;
  v3 = (char *)malloc(8LL * thread_count);
  if ( !v3 )
    return -1;
  v4 = v3;
  shared_counter = 0;
  if ( thread_count > 0 )
  {
    v5 = (pthread_t *)v3;
    v6 = (pthread_t *)&v3[8 * thread_count];
    v7 = (pthread_t *)v3;
    do
    {
      if ( pthread_create(v7, 0, thread_increment, &arg) )
      {
        free(v4);
        return -2;
      }
      ++v7;
    }
    while ( v7 != v6 );
    do
    {
      v8 = *v5++;
      pthread_join(v8, 0);
    }
    while ( v5 != v6 );
  }
  free(v4);
  if ( shared_counter == thread_count * arg )
    return 42;
  else
    return -3;
}


/* Function: call_mutex_lock @ 0x2DDC */
int __cdecl call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: param_condition_variable @ 0x2DF8 */
int __cdecl param_condition_variable()
{
  int v0; // w19
  pthread_t producer; // [xsp+20h] [xbp+20h] BYREF
  pthread_t consumer; // [xsp+28h] [xbp+28h] BYREF
  void *consumer_ret; // [xsp+30h] [xbp+30h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&consumer, 0, consumer_thread, 0) )
    return -1;
  if ( pthread_create(&producer, 0, producer_thread, 0) )
  {
    pthread_cancel(consumer);
    return -2;
  }
  else
  {
    pthread_join(consumer, &consumer_ret);
    pthread_join(producer, 0);
    v0 = *(_DWORD *)consumer_ret;
    free(consumer_ret);
  }
  return v0;
}


/* Function: call_condition_variable @ 0x2EC8 */
int __cdecl call_condition_variable()
{
  return param_condition_variable();
}


/* Function: param_atomic_ops @ 0x2EDC */
int __fastcall param_atomic_ops(int thread_count, int iterations)
{
  pthread_t *v3; // x0
  pthread_t *v4; // x21
  pthread_t *v5; // x19
  __int64 v6; // x19
  int v7; // w19
  int iterationsa; // [xsp+4Ch] [xbp+4Ch] BYREF
  pthread_t load_store_tid; // [xsp+50h] [xbp+50h] BYREF

  iterationsa = iterations;
  v3 = (pthread_t *)malloc(8LL * thread_count);
  if ( !v3 )
    return -1;
  v4 = v3;
  atomic_store(0, (unsigned int *)&atomic_counter);
  if ( thread_count <= 0 )
  {
    if ( !pthread_create(&load_store_tid, 0, thread_atomic_load_store, 0) )
      pthread_join(load_store_tid, 0);
  }
  else
  {
    v5 = v3;
    do
    {
      if ( pthread_create(v5, 0, thread_atomic_increment, &iterationsa) )
      {
        free(v4);
        return -2;
      }
      ++v5;
    }
    while ( v5 != &v4[thread_count] );
    if ( !pthread_create(&load_store_tid, 0, thread_atomic_load_store, 0) )
      pthread_join(load_store_tid, 0);
    v6 = 0;
    do
      pthread_join(v4[v6++], 0);
    while ( thread_count > (int)v6 );
  }
  v7 = atomic_load((unsigned int *)&atomic_counter);
  free(v4);
  if ( v7 <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_atomic_ops @ 0x3064 */
int __cdecl call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: param_thread_local_storage @ 0x3080 */
int __fastcall param_thread_local_storage(int thread_count)
{
  size_t v2; // x19
  char *v3; // x24
  char *v4; // x0
  bool v5; // zf
  char *v6; // x22
  __int64 v7; // x19
  pthread_t *v8; // x21
  __int64 v9; // x19
  int v10; // w20
  int v11; // w21
  __int64 v12; // x19
  int v13; // w0
  int v14; // w25
  void **v17; // x20
  __int64 v18; // x19
  void *v19; // t1
  void *ret; // [xsp+60h] [xbp+60h] BYREF

  v2 = 8LL * thread_count;
  v3 = (char *)malloc(v2);
  v4 = (char *)malloc(v2);
  if ( v3 )
    v5 = v4 == 0;
  else
    v5 = 1;
  if ( v5 )
    return -1;
  v6 = v4;
  if ( thread_count <= 0 )
  {
    v11 = 0;
    v10 = 0;
LABEL_13:
    free(v6);
    free(v3);
    v13 = 100 * thread_count;
    v14 = 150 * thread_count;
    if ( v13 == v10 && v14 == v11 )
      return 42;
    else
      return -3;
  }
  else
  {
    v7 = 0;
    do
    {
      *(_QWORD *)&v6[8 * v7] = malloc(0x10u);
      __snprintf_chk();
      ++v7;
    }
    while ( v7 != thread_count );
    v8 = (pthread_t *)v3;
    v9 = 0;
    while ( 1 )
    {
      v10 = pthread_create(v8, 0, thread_tls_test, *(void **)&v6[8 * v9]);
      if ( v10 )
        break;
      ++v9;
      ++v8;
      if ( v9 == thread_count )
      {
        v11 = 0;
        v12 = 0;
        do
        {
          pthread_join(*(_QWORD *)&v3[v12], &ret);
          v10 += *(_DWORD *)ret;
          v11 += *((_DWORD *)ret + 1);
          free(ret);
          free(*(void **)&v6[v12]);
          v12 += 8;
        }
        while ( v12 != 8LL * (unsigned int)thread_count );
        goto LABEL_13;
      }
    }
    if ( (v9 & 0x80000000) == 0 )
    {
      v17 = (void **)v6;
      v18 = (__int64)&v6[8 * (unsigned int)v9 + 8];
      do
      {
        v19 = *v17++;
        free(v19);
      }
      while ( v17 != (void **)v18 );
    }
    free(v6);
    free(v3);
    return -2;
  }
}


/* Function: call_thread_local_storage @ 0x327C */
int __cdecl call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x3294 */
void __cdecl test_thread_concurrency()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  puts(asc_37C8);
  v0 = call_pthread_create();
  __printf_chk(1, aThrL301D, v0);
  v1 = param_pthread_join();
  __printf_chk(1, aThrL302D, v1);
  v2 = call_mutex_lock();
  __printf_chk(1, aThrL303D, v2);
  v3 = param_condition_variable();
  __printf_chk(1, aThrL304D, v3);
  v4 = call_atomic_ops();
  __printf_chk(1, aThrL305D, v4);
  v5 = call_thread_local_storage();
  __printf_chk(1, aThrL306D, v5);
}


/* Function: main @ 0x3340 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_standard_library_functions();
  test_system_calls();
  test_thread_concurrency();
  return 0;
}


/* Function: __aarch64_cas4_acq_rel @ 0x3360 */
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


/* Function: __aarch64_ldadd4_acq_rel @ 0x33A0 */
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


/* Function: .term_proc @ 0x33D0 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x15170 */

/* FAILED to decompile: _exit @ 0x15178 */

/* FAILED to decompile: strlen @ 0x15180 */

/* FAILED to decompile: raise @ 0x15188 */

/* FAILED to decompile: __libc_start_main @ 0x15190 */

/* FAILED to decompile: execl @ 0x15198 */

/* FAILED to decompile: listen @ 0x151A0 */

/* FAILED to decompile: shmdt @ 0x151A8 */

/* FAILED to decompile: bind @ 0x151B0 */

/* FAILED to decompile: __cxa_finalize @ 0x151B8 */

/* FAILED to decompile: pipe @ 0x151C0 */

/* FAILED to decompile: fork @ 0x151C8 */

/* FAILED to decompile: fileno @ 0x151D0 */

/* FAILED to decompile: signal @ 0x151D8 */

/* FAILED to decompile: __snprintf_chk @ 0x151E0 */

/* FAILED to decompile: fclose @ 0x151E8 */

/* FAILED to decompile: fopen @ 0x151F0 */

/* FAILED to decompile: malloc @ 0x151F8 */

/* FAILED to decompile: setsockopt @ 0x15200 */

/* FAILED to decompile: open @ 0x15208 */

/* FAILED to decompile: pthread_cond_signal @ 0x15210 */

/* FAILED to decompile: __printf_chk @ 0x15218 */

/* FAILED to decompile: memset @ 0x15220 */

/* FAILED to decompile: shmat @ 0x15228 */

/* FAILED to decompile: sleep @ 0x15230 */

/* FAILED to decompile: rewind @ 0x15238 */

/* FAILED to decompile: __stack_chk_fail @ 0x15240 */

/* FAILED to decompile: close @ 0x15248 */

/* FAILED to decompile: stat_0 @ 0x15250 */

/* FAILED to decompile: write @ 0x15260 */

/* FAILED to decompile: __getauxval @ 0x15268 */

/* FAILED to decompile: abort @ 0x15270 */

/* FAILED to decompile: puts @ 0x15278 */

/* FAILED to decompile: memcmp @ 0x15280 */

/* FAILED to decompile: strcmp @ 0x15288 */

/* FAILED to decompile: shmctl @ 0x15290 */

/* FAILED to decompile: fread @ 0x15298 */

/* FAILED to decompile: ftok @ 0x152A0 */

/* FAILED to decompile: free @ 0x152A8 */

/* FAILED to decompile: shmget @ 0x152B0 */

/* FAILED to decompile: pthread_cond_wait @ 0x152B8 */

/* FAILED to decompile: strchr @ 0x152C0 */

/* FAILED to decompile: fwrite @ 0x152C8 */

/* FAILED to decompile: pthread_create @ 0x152D0 */

/* FAILED to decompile: wait @ 0x152D8 */

/* FAILED to decompile: socket @ 0x152E0 */

/* FAILED to decompile: strcpy @ 0x152E8 */

/* FAILED to decompile: read @ 0x152F0 */

/* FAILED to decompile: strstr @ 0x152F8 */

/* FAILED to decompile: usleep @ 0x15300 */

/* FAILED to decompile: __isoc99_sscanf @ 0x15308 */

/* FAILED to decompile: strncpy @ 0x15310 */

/* FAILED to decompile: __errno_location @ 0x15318 */

/* FAILED to decompile: pthread_join @ 0x15320 */

/* FAILED to decompile: alarm @ 0x15328 */

/* FAILED to decompile: pthread_cancel @ 0x15330 */

/* FAILED to decompile: pthread_mutex_lock @ 0x15338 */

/* FAILED to decompile: syscall @ 0x15340 */

/* FAILED to decompile: pthread_mutex_unlock @ 0x15348 */

/* FAILED to decompile: waitpid @ 0x15350 */

/* FAILED to decompile: unlink @ 0x15358 */

/* FAILED to decompile: __gmon_start__ @ 0x15368 */

/* Total functions decompiled: 75, failed: 62 */
