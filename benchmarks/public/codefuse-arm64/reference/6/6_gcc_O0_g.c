/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_gcc_O0_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x13B0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_13D0 @ 0x13D0 */
void sub_13D0()
{
  JUMPOUT(0);
}


/* Function: init_have_lse_atomics @ 0x1800 */
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


/* Function: param_strcpy @ 0x1954 */
int __cdecl param_strcpy(char *dst, const char *src)
{
  strcpy(dst, src);
  return strlen(dst);
}


/* Function: call_strcpy @ 0x1980 */
int __cdecl call_strcpy()
{
  char buffer[32]; // [xsp+18h] [xbp+18h] BYREF

  return param_strcpy(buffer, "HelloLib");
}


/* Function: param_strcmp @ 0x19E8 */
int __cdecl param_strcmp(const char *s1, const char *s2)
{
  int ret; // [xsp+2Ch] [xbp+2Ch]

  ret = strcmp(s1, s2);
  if ( ret > 0 )
    return 1;
  if ( ret >= 0 )
    return 0;
  return -1;
}


/* Function: call_strcmp @ 0x1A3C */
int __cdecl call_strcmp()
{
  int r1; // [xsp+14h] [xbp+14h]
  int r2; // [xsp+18h] [xbp+18h]

  r1 = param_strcmp("abc", "def");
  r2 = param_strcmp("xyz", "xyz");
  return r1 + r2 + param_strcmp("bbb", "aaa");
}


/* Function: param_strlen @ 0x1AA8 */
int __cdecl param_strlen(const char *str)
{
  return strlen(str);
}


/* Function: call_strlen @ 0x1ACC */
int __cdecl call_strlen()
{
  return param_strlen("BinBench2025");
}


/* Function: param_memcpy @ 0x1AF0 */
int __cdecl param_memcpy(void *dst, const void *src, size_t n)
{
  int na; // [xsp+18h] [xbp+18h]

  na = n;
  memcpy(dst, src, n);
  return na;
}


/* Function: call_memcpy @ 0x1B20 */
int __cdecl call_memcpy()
{
  int src[5]; // [xsp+18h] [xbp+18h] BYREF
  int dst[6]; // [xsp+30h] [xbp+30h] BYREF

  *(_QWORD *)src = *(_QWORD *)"\n";
  *(_QWORD *)&src[2] = 0x280000001ELL;
  src[4] = 50;
  memset(dst, 0, 20);
  param_memcpy(dst, src, 0x14u);
  return dst[0] + dst[2] + dst[4];
}


/* Function: param_memcmp @ 0x1BB8 */
int __cdecl param_memcmp(const void *p1, const void *p2, size_t n)
{
  int ret; // [xsp+3Ch] [xbp+3Ch]

  ret = memcmp(p1, p2, n);
  if ( ret > 0 )
    return 1;
  if ( ret >= 0 )
    return 0;
  return -1;
}


/* Function: call_memcmp @ 0x1C14 */
int __cdecl call_memcmp()
{
  int r1; // [xsp+10h] [xbp+10h]
  int arr1[3]; // [xsp+18h] [xbp+18h] BYREF
  int arr2[3]; // [xsp+28h] [xbp+28h] BYREF
  int arr3[3]; // [xsp+38h] [xbp+38h] BYREF

  *(_QWORD *)arr1 = 0x200000001LL;
  arr1[2] = 3;
  *(_QWORD *)arr2 = 0x200000001LL;
  arr2[2] = 4;
  *(_QWORD *)arr3 = 0x200000001LL;
  arr3[2] = 3;
  r1 = param_memcmp(arr1, arr2, 0xCu);
  return r1 + param_memcmp(arr1, arr3, 0xCu);
}


/* Function: param_printf @ 0x1CE8 */
int __cdecl param_printf(int x, const char *name)
{
  return printf("Value: %d, Name: %s\n", x, name);
}


/* Function: call_printf @ 0x1D1C */
int __cdecl call_printf()
{
  return param_printf(42, "Test");
}


/* Function: param_scanf @ 0x1D44 */
int __cdecl param_scanf(const char *input_str)
{
  int a; // [xsp+2Ch] [xbp+2Ch] BYREF
  int b; // [xsp+30h] [xbp+30h] BYREF
  int ret; // [xsp+34h] [xbp+34h]

  ret = __isoc99_sscanf(input_str, "%d,%d", &a, &b);
  if ( ret == 2 )
    return a + b;
  else
    return -1;
}


/* Function: call_scanf @ 0x1DD8 */
int __cdecl call_scanf()
{
  return param_scanf("123,456");
}


/* Function: param_fopen_fclose @ 0x1DF4 */
int __cdecl param_fopen_fclose(const char *filename)
{
  int fd; // [xsp+24h] [xbp+24h]
  FILE *fp; // [xsp+28h] [xbp+28h]

  fp = fopen(filename, "r");
  if ( !fp )
    return -1;
  fd = fileno(fp);
  fclose(fp);
  return fd;
}


/* Function: call_fopen_fclose @ 0x1E48 */
int __cdecl call_fopen_fclose()
{
  if ( param_fopen_fclose("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1E80 */
int __cdecl param_fread_fwrite(const char *tmpfile)
{
  size_t v2; // x0
  FILE *fp; // [xsp+30h] [xbp+30h]
  size_t written; // [xsp+38h] [xbp+38h]
  size_t read; // [xsp+40h] [xbp+40h]
  char read_buffer[32]; // [xsp+48h] [xbp+48h] BYREF

  fp = fopen(tmpfile, "w+");
  if ( !fp )
    return -1;
  v2 = strlen("BinBench Test Data");
  written = fwrite("BinBench Test Data", 1u, v2, fp);
  if ( written == strlen("BinBench Test Data") )
  {
    rewind(fp);
    read = fread(read_buffer, 1u, written, fp);
    read_buffer[read] = 0;
    fclose(fp);
    unlink(tmpfile);
    if ( read == written && !strcmp(read_buffer, "BinBench Test Data") )
      return 42;
    else
      return -3;
  }
  else
  {
    fclose(fp);
    return -2;
  }
}


/* Function: call_fread_fwrite @ 0x1FB8 */
int __cdecl call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x1FD4 */
int __cdecl param_malloc_free(size_t size)
{
  int sum; // [xsp+2Ch] [xbp+2Ch]
  size_t i; // [xsp+30h] [xbp+30h]
  int *ptr; // [xsp+38h] [xbp+38h]

  ptr = (int *)malloc(4 * size);
  if ( !ptr )
    return -1;
  for ( i = 0; i < size; ++i )
    ptr[i] = 10 * i;
  sum = *ptr + ptr[size - 1];
  free(ptr);
  return sum;
}


/* Function: call_malloc_free @ 0x209C */
int __cdecl call_malloc_free()
{
  return param_malloc_free(0xAu);
}


/* Function: param_memset @ 0x20B4 */
int __cdecl param_memset(void *buffer, size_t size)
{
  int sum; // [xsp+2Ch] [xbp+2Ch]
  size_t i; // [xsp+30h] [xbp+30h]

  memset(buffer, 0, size);
  sum = 0;
  for ( i = 0; i < size; ++i )
    sum += *((unsigned __int8 *)buffer + i);
  return sum;
}


/* Function: call_memset @ 0x2130 */
int __cdecl call_memset()
{
  int i; // [xsp+1Ch] [xbp+1Ch]
  int buffer[10]; // [xsp+20h] [xbp+20h] BYREF

  for ( i = 0; i <= 9; ++i )
    buffer[i] = 255;
  param_memset(buffer, 0x28u);
  return buffer[0] + buffer[9];
}


/* Function: param_strchr_strstr @ 0x21C8 */
int __cdecl param_strchr_strstr(const char *str, char ch, const char *substr)
{
  int v3; // w0
  int v4; // w0
  int index1; // [xsp+38h] [xbp+38h]
  char *pos1; // [xsp+40h] [xbp+40h]
  char *pos2; // [xsp+48h] [xbp+48h]

  pos1 = strchr(str, (unsigned __int8)ch);
  if ( pos1 )
    v3 = (_DWORD)pos1 - (_DWORD)str;
  else
    v3 = -1;
  index1 = v3;
  pos2 = strstr(str, substr);
  if ( pos2 )
    v4 = (_DWORD)pos2 - (_DWORD)str;
  else
    v4 = -1;
  return index1 + v4;
}


/* Function: call_strchr_strstr @ 0x225C */
int __cdecl call_strchr_strstr()
{
  return param_strchr_strstr("Hello BinBench Test", 66, "Bench");
}


/* Function: test_standard_library_functions @ 0x2294 */
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

  puts(asc_3B80);
  v0 = call_strcpy();
  printf(aLibL101D, v0);
  v1 = call_strcmp();
  printf(aLibL102D, v1);
  v2 = call_strlen();
  printf(aLibL103D, v2);
  v3 = call_memcpy();
  printf(aLibL104D, v3);
  v4 = call_memcmp();
  printf(aLibL105D, v4);
  v5 = call_printf();
  printf(aLibL106D, v5);
  v6 = call_scanf();
  printf(aLibL107D, v6);
  v7 = call_fopen_fclose();
  printf(aLibL108D, v7);
  v8 = call_fread_fwrite();
  printf(aLibL109D, v8);
  v9 = call_malloc_free();
  printf(aLibL110D, v9);
  v10 = call_memset();
  printf(aLibL111D, v10);
  v11 = call_strchr_strstr();
  printf(aLibL112D, v11);
}


/* Function: param_linux_syscall @ 0x23A4 */
int __cdecl param_linux_syscall(const char *pathname)
{
  int fd; // [xsp+2Ch] [xbp+2Ch]

  fd = syscall(56, 4294967196LL, pathname, 0);
  if ( fd < 0 )
    return -*__errno_location();
  syscall(57, (unsigned int)fd);
  return fd;
}


/* Function: call_linux_syscall @ 0x23FC */
int __cdecl call_linux_syscall()
{
  if ( param_linux_syscall("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_win32_api @ 0x2434 */
int __cdecl param_win32_api(const char *filename)
{
  stat st; // [xsp+28h] [xbp+28h] BYREF

  if ( stat(filename, &st) < 0 )
    return -1;
  if ( st.st_size <= 0 )
    return -2;
  return 42;
}


/* Function: call_win32_api @ 0x24BC */
int __cdecl call_win32_api()
{
  return param_win32_api("/etc/passwd");
}


/* Function: param_fork_exec @ 0x24D8 */
int __cdecl param_fork_exec(const char *prog, const char *arg)
{
  int status; // [xsp+2Ch] [xbp+2Ch] BYREF
  pid_t pid; // [xsp+30h] [xbp+30h]
  pid_t wpid; // [xsp+34h] [xbp+34h]

  pid = fork();
  if ( pid < 0 )
    return -1;
  if ( !pid )
  {
    execl(prog, prog, arg, 0);
    _exit(127);
  }
  wpid = waitpid(pid, &status, 0);
  if ( wpid < 0 )
    return -2;
  if ( (status & 0x7F) != 0 )
    return -3;
  return BYTE1(status);
}


/* Function: call_fork_exec @ 0x25C0 */
int __cdecl call_fork_exec()
{
  if ( param_fork_exec("/bin/true", 0) )
    return -1;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x25FC */
int __cdecl param_pipe_communication()
{
  int v1; // w19
  size_t v2; // x0
  __WAIT_STATUS v3; // x0
  pid_t pid; // [xsp+2Ch] [xbp+2Ch]
  __int64 bytes; // [xsp+30h] [xbp+30h]
  int pipefd[2]; // [xsp+40h] [xbp+40h] BYREF
  char buffer[32]; // [xsp+48h] [xbp+48h] BYREF

  if ( pipe(pipefd) < 0 )
    return -1;
  pid = fork();
  if ( pid < 0 )
    return -2;
  if ( !pid )
  {
    close(pipefd[0]);
    v1 = pipefd[1];
    v2 = strlen("HelloPipe");
    write(v1, "HelloPipe", v2);
    close(pipefd[1]);
    _exit(0);
  }
  close(pipefd[1]);
  bytes = read(pipefd[0], buffer, 0x1Fu);
  buffer[bytes] = 0;
  close(pipefd[0]);
  v3.__uptr = 0;
  wait(v3);
  if ( bytes <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x2720 */
int __cdecl call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x2734 */
int __cdecl param_socket_create()
{
  int opt; // [xsp+10h] [xbp+10h] BYREF
  int sock; // [xsp+14h] [xbp+14h]
  sockaddr_in addr; // [xsp+18h] [xbp+18h] BYREF

  sock = socket(2, 1, 0);
  if ( sock < 0 )
    return -1;
  opt = 1;
  if ( setsockopt(sock, 1, 2, &opt, 4u) >= 0 )
  {
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = 2;
    addr.sin_port = htons(0);
    addr.sin_addr.s_addr = 0;
    if ( bind(sock, (const struct sockaddr *)&addr, 0x10u) >= 0 )
    {
      if ( listen(sock, 5) >= 0 )
      {
        close(sock);
        return 42;
      }
      else
      {
        close(sock);
        return -4;
      }
    }
    else
    {
      close(sock);
      return -3;
    }
  }
  else
  {
    close(sock);
    return -2;
  }
}


/* Function: call_socket_create @ 0x286C */
int __cdecl call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x2880 */
int __cdecl param_shmget_shmat()
{
  int fd; // [xsp+10h] [xbp+10h]
  int key; // [xsp+14h] [xbp+14h]
  int shmid; // [xsp+18h] [xbp+18h]
  int len; // [xsp+1Ch] [xbp+1Ch]
  char *shm; // [xsp+28h] [xbp+28h]

  fd = open("/tmp/binbench_shm", 66, 438);
  if ( fd < 0 )
    return -1;
  close(fd);
  key = ftok("/tmp/binbench_shm", 42);
  if ( key < 0 )
    return -1;
  shmid = shmget(key, 0x1000u, 950);
  if ( shmid < 0 )
    return -2;
  shm = (char *)shmat(shmid, 0, 0);
  if ( shm == (char *)-1LL )
    return -3;
  strcpy(shm, "SharedMemory");
  len = strlen(shm);
  shmdt(shm);
  shmctl(shmid, 0, 0);
  return len;
}


/* Function: call_shmget_shmat @ 0x298C */
int __cdecl call_shmget_shmat()
{
  if ( param_shmget_shmat() <= 0 )
    return -1;
  else
    return 42;
}


/* Function: signal_handler @ 0x29BC */
void __cdecl signal_handler(int sig)
{
  signal_received = 1;
  signal_number = sig;
}


/* Function: param_signal_handling @ 0x29F0 */
int __cdecl param_signal_handling()
{
  int v1; // w0
  int v2; // w0
  int attempts; // [xsp+1Ch] [xbp+1Ch]
  int attemptsa; // [xsp+1Ch] [xbp+1Ch]

  if ( signal(10, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return -1;
  if ( signal(14, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return -2;
  signal_received = 0;
  raise(10);
  attempts = 1000;
  while ( !signal_received )
  {
    v1 = attempts--;
    if ( v1 <= 0 )
      break;
    usleep(0x3E8u);
  }
  if ( !signal_received )
    return -3;
  if ( signal_number != 10 )
    return -4;
  signal_received = 0;
  alarm(1u);
  attemptsa = 2000;
  while ( !signal_received )
  {
    v2 = attemptsa--;
    if ( v2 <= 0 )
      break;
    usleep(0x3E8u);
  }
  if ( !signal_received || signal_number != 14 )
    return -5;
  signal(10, 0);
  signal(14, 0);
  return 42;
}


/* Function: call_signal_handling @ 0x2B64 */
int __cdecl call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x2B78 */
void __cdecl test_system_calls()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0

  puts(asc_3D70);
  v0 = call_linux_syscall();
  printf(aSysL301D, v0);
  v1 = call_win32_api();
  printf(aSysL302D, v1);
  v2 = call_fork_exec();
  printf(aSysL303D, v2);
  v3 = call_pipe_communication();
  printf(aSysL304D, v3);
  v4 = call_socket_create();
  printf(aSysL305D, v4);
  v5 = call_shmget_shmat();
  printf(aSysL306D, v5);
  v6 = call_signal_handling();
  printf(aSysL307D, v6);
}


/* Function: thread_compute @ 0x2C24 */
void *__cdecl thread_compute(void *arg)
{
  void *v1; // x0
  int result; // [xsp+2Ch] [xbp+2Ch]

  result = *(_DWORD *)arg * *(_DWORD *)arg;
  v1 = malloc(4u);
  *(_DWORD *)v1 = result;
  return v1;
}


/* Function: param_pthread_create @ 0x2C74 */
int __cdecl param_pthread_create(int x)
{
  int input; // [xsp+2Ch] [xbp+2Ch] BYREF
  int result; // [xsp+34h] [xbp+34h]
  pthread_t tid; // [xsp+38h] [xbp+38h] BYREF
  void *thread_ret; // [xsp+40h] [xbp+40h] BYREF

  input = x;
  if ( pthread_create(&tid, 0, (void *(*)(void *))thread_compute, &input) )
    return -1;
  pthread_join(tid, &thread_ret);
  result = *(_DWORD *)thread_ret;
  free(thread_ret);
  return result;
}


/* Function: call_pthread_create @ 0x2D28 */
int __cdecl call_pthread_create()
{
  return param_pthread_create(7);
}


/* Function: thread_sum @ 0x2D40 */
void *__cdecl thread_sum(void *arg)
{
  int i; // [xsp+Ch] [xbp-Ch]

  *((_DWORD *)arg + 2) = 0;
  for ( i = *(_DWORD *)arg; i <= *((_DWORD *)arg + 1); ++i )
    *((_DWORD *)arg + 2) += i;
  return 0;
}


/* Function: param_pthread_join @ 0x2DAC */
int __cdecl param_pthread_join()
{
  int i; // [xsp+1Ch] [xbp+1Ch]
  int total; // [xsp+20h] [xbp+20h]
  int i_0; // [xsp+24h] [xbp+24h]
  pthread_t tids[3]; // [xsp+28h] [xbp+28h] BYREF
  ThreadData data[3]; // [xsp+40h] [xbp+40h] BYREF

  *(_OWORD *)&data[0].start = xmmword_3E70;
  *(_OWORD *)&data[1].end = xmmword_3E80;
  data[2].result = 0;
  for ( i = 0; i <= 2; ++i )
  {
    if ( pthread_create(&tids[i], 0, (void *(*)(void *))thread_sum, &data[i]) )
      return -1;
  }
  total = 0;
  for ( i_0 = 0; i_0 <= 2; ++i_0 )
  {
    if ( pthread_join(tids[i_0], 0) )
      return -2;
    total += data[i_0].result;
  }
  return total;
}


/* Function: call_pthread_join @ 0x2F00 */
int __cdecl call_pthread_join()
{
  return param_pthread_join();
}


/* Function: thread_increment @ 0x2F14 */
void *__cdecl thread_increment(void *arg)
{
  int i; // [xsp+28h] [xbp+28h]
  int iterations; // [xsp+2Ch] [xbp+2Ch]

  iterations = *(_DWORD *)arg;
  for ( i = 0; i < iterations; ++i )
  {
    pthread_mutex_lock(&counter_mutex);
    ++shared_counter;
    pthread_mutex_unlock(&counter_mutex);
    usleep(0x3E8u);
  }
  return 0;
}


/* Function: param_mutex_lock @ 0x2F98 */
int __cdecl param_mutex_lock(int thread_count, int iterations_per_thread)
{
  int iterations_per_threada; // [xsp+18h] [xbp+18h] BYREF
  int thread_counta; // [xsp+1Ch] [xbp+1Ch]
  int i; // [xsp+2Ch] [xbp+2Ch]
  int i_0; // [xsp+30h] [xbp+30h]
  int expected; // [xsp+34h] [xbp+34h]
  pthread_t *tids; // [xsp+38h] [xbp+38h]

  thread_counta = thread_count;
  iterations_per_threada = iterations_per_thread;
  tids = (pthread_t *)malloc(8LL * thread_count);
  if ( !tids )
    return -1;
  shared_counter = 0;
  for ( i = 0; i < thread_counta; ++i )
  {
    if ( pthread_create(&tids[i], 0, (void *(*)(void *))thread_increment, &iterations_per_threada) )
    {
      free(tids);
      return -2;
    }
  }
  for ( i_0 = 0; i_0 < thread_counta; ++i_0 )
    pthread_join(tids[i_0], 0);
  free(tids);
  expected = thread_counta * iterations_per_threada;
  if ( thread_counta * iterations_per_threada == shared_counter )
    return 42;
  else
    return -3;
}


/* Function: call_mutex_lock @ 0x30C4 */
int __cdecl call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: consumer_thread @ 0x30E0 */
void *__cdecl consumer_thread(void *arg)
{
  void *result; // x0
  int received; // [xsp+24h] [xbp+24h]

  pthread_mutex_lock(&cond_mutex);
  while ( !ready )
    pthread_cond_wait(&cond, &cond_mutex);
  received = data;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *(_DWORD *)result = received;
  return result;
}


/* Function: producer_thread @ 0x3164 */
void *__cdecl producer_thread(void *arg)
{
  sleep(1u);
  pthread_mutex_lock(&cond_mutex);
  data = 42;
  ready = 1;
  pthread_cond_signal(&cond);
  pthread_mutex_unlock(&cond_mutex);
  return 0;
}


/* Function: param_condition_variable @ 0x31C8 */
int __cdecl param_condition_variable()
{
  int result; // [xsp+1Ch] [xbp+1Ch]
  pthread_t producer; // [xsp+20h] [xbp+20h] BYREF
  pthread_t consumer; // [xsp+28h] [xbp+28h] BYREF
  void *consumer_ret; // [xsp+30h] [xbp+30h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&consumer, 0, (void *(*)(void *))consumer_thread, 0) )
    return -1;
  if ( pthread_create(&producer, 0, (void *(*)(void *))producer_thread, 0) )
  {
    pthread_cancel(consumer);
    return -2;
  }
  else
  {
    pthread_join(consumer, &consumer_ret);
    pthread_join(producer, 0);
    result = *(_DWORD *)consumer_ret;
    free(consumer_ret);
    return result;
  }
}


/* Function: call_condition_variable @ 0x32BC */
int __cdecl call_condition_variable()
{
  return param_condition_variable();
}


/* Function: thread_atomic_increment @ 0x32D0 */
void *__cdecl thread_atomic_increment(void *arg)
{
  int i; // [xsp+3Ch] [xbp+3Ch]
  int iterations; // [xsp+40h] [xbp+40h]

  iterations = *(_DWORD *)arg;
  for ( i = 0; i < iterations; ++i )
  {
    _aarch64_ldadd4_acq_rel(1, &atomic_counter);
    _aarch64_cas4_acq_rel((unsigned int)i, (unsigned int)(i + 1000), &atomic_counter);
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x33BC */
void *__cdecl thread_atomic_load_store(void *arg)
{
  unsigned int v1; // w0

  v1 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v1 + 100, (unsigned int *)&atomic_counter);
  return 0;
}


/* Function: param_atomic_ops @ 0x33F8 */
int __cdecl param_atomic_ops(int thread_count, int iterations)
{
  int v3; // w0
  int iterationsa; // [xsp+18h] [xbp+18h] BYREF
  int thread_counta; // [xsp+1Ch] [xbp+1Ch]
  int i; // [xsp+2Ch] [xbp+2Ch]
  int i_0; // [xsp+30h] [xbp+30h]
  int final_value; // [xsp+34h] [xbp+34h]
  pthread_t load_store_tid; // [xsp+38h] [xbp+38h] BYREF
  pthread_t *tids; // [xsp+40h] [xbp+40h]

  thread_counta = thread_count;
  iterationsa = iterations;
  tids = (pthread_t *)malloc(8LL * thread_count);
  if ( !tids )
    return -1;
  atomic_store(0, (unsigned int *)&atomic_counter);
  for ( i = 0; i < thread_counta; ++i )
  {
    if ( pthread_create(&tids[i], 0, (void *(*)(void *))thread_atomic_increment, &iterationsa) )
    {
      free(tids);
      return -2;
    }
  }
  if ( !pthread_create(&load_store_tid, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
    pthread_join(load_store_tid, 0);
  for ( i_0 = 0; i_0 < thread_counta; ++i_0 )
    pthread_join(tids[i_0], 0);
  v3 = atomic_load((unsigned int *)&atomic_counter);
  final_value = v3;
  free(tids);
  if ( final_value <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_atomic_ops @ 0x3584 */
int __cdecl call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: thread_tls_test @ 0x35A0 */
void *__cdecl thread_tls_test(void *arg)
{
  int v1; // w1
  void *result; // x0
  int initial; // [xsp+2Ch] [xbp+2Ch]

  initial = *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16);
  v1 = *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16) + 50;
  *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16) = v1;
  strncpy((char *)(_ReadStatusReg(TPIDR_EL0) + 24), (const char *)arg, 0x1Fu);
  result = malloc(8u);
  *(_DWORD *)result = initial;
  *((_DWORD *)result + 1) = *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16);
  return result;
}


/* Function: param_thread_local_storage @ 0x3644 */
int __cdecl param_thread_local_storage(int thread_count)
{
  int i; // [xsp+38h] [xbp+38h]
  int i_0; // [xsp+3Ch] [xbp+3Ch]
  int j; // [xsp+40h] [xbp+40h]
  int total_initial; // [xsp+44h] [xbp+44h]
  int total_final; // [xsp+48h] [xbp+48h]
  int i_1; // [xsp+4Ch] [xbp+4Ch]
  void *ret; // [xsp+58h] [xbp+58h] BYREF
  pthread_t *tids; // [xsp+60h] [xbp+60h]
  char **names; // [xsp+68h] [xbp+68h]
  int *values; // [xsp+70h] [xbp+70h]

  tids = (pthread_t *)malloc(8LL * thread_count);
  names = (char **)malloc(8LL * thread_count);
  if ( !tids || !names )
    return -1;
  for ( i = 0; i < thread_count; ++i )
  {
    names[i] = (char *)malloc(0x10u);
    snprintf(names[i], 0x10u, "Thread-%d", i);
  }
  for ( i_0 = 0; i_0 < thread_count; ++i_0 )
  {
    if ( pthread_create(&tids[i_0], 0, (void *(*)(void *))thread_tls_test, names[i_0]) )
    {
      for ( j = 0; j <= i_0; ++j )
        free(names[j]);
      free(names);
      free(tids);
      return -2;
    }
  }
  total_initial = 0;
  total_final = 0;
  for ( i_1 = 0; i_1 < thread_count; ++i_1 )
  {
    pthread_join(tids[i_1], &ret);
    values = (int *)ret;
    total_initial += *(_DWORD *)ret;
    total_final += *((_DWORD *)ret + 1);
    free(ret);
    free(names[i_1]);
  }
  free(names);
  free(tids);
  if ( total_initial == 100 * thread_count && total_final == 150 * thread_count )
    return 42;
  else
    return -3;
}


/* Function: call_thread_local_storage @ 0x38FC */
int __cdecl call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x3914 */
void __cdecl test_thread_concurrency()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  puts(asc_3EA8);
  v0 = call_pthread_create();
  printf(aThrL301D, v0);
  v1 = call_pthread_join();
  printf(aThrL302D, v1);
  v2 = call_mutex_lock();
  printf(aThrL303D, v2);
  v3 = call_condition_variable();
  printf(aThrL304D, v3);
  v4 = call_atomic_ops();
  printf(aThrL305D, v4);
  v5 = call_thread_local_storage();
  printf(aThrL306D, v5);
}


/* Function: main @ 0x39AC */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_standard_library_functions();
  test_system_calls();
  test_thread_concurrency();
  return 0;
}


/* Function: __aarch64_cas4_acq_rel @ 0x39D0 */
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


/* Function: __aarch64_ldadd4_acq_rel @ 0x3A10 */
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


/* Function: .term_proc @ 0x3A40 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x15168 */

/* FAILED to decompile: _exit @ 0x15170 */

/* FAILED to decompile: strlen @ 0x15178 */

/* FAILED to decompile: raise @ 0x15180 */

/* FAILED to decompile: __libc_start_main @ 0x15188 */

/* FAILED to decompile: execl @ 0x15190 */

/* FAILED to decompile: listen @ 0x15198 */

/* FAILED to decompile: shmdt @ 0x151A0 */

/* FAILED to decompile: bind @ 0x151A8 */

/* FAILED to decompile: __cxa_finalize @ 0x151B0 */

/* FAILED to decompile: pipe @ 0x151B8 */

/* FAILED to decompile: fork @ 0x151C0 */

/* FAILED to decompile: snprintf @ 0x151C8 */

/* FAILED to decompile: fileno @ 0x151D0 */

/* FAILED to decompile: signal @ 0x151D8 */

/* FAILED to decompile: fclose @ 0x151E0 */

/* FAILED to decompile: fopen @ 0x151E8 */

/* FAILED to decompile: malloc @ 0x151F0 */

/* FAILED to decompile: setsockopt @ 0x151F8 */

/* FAILED to decompile: open @ 0x15200 */

/* FAILED to decompile: pthread_cond_signal @ 0x15208 */

/* FAILED to decompile: memset @ 0x15210 */

/* FAILED to decompile: shmat @ 0x15218 */

/* FAILED to decompile: sleep @ 0x15220 */

/* FAILED to decompile: htons @ 0x15228 */

/* FAILED to decompile: rewind @ 0x15230 */

/* FAILED to decompile: __stack_chk_fail @ 0x15238 */

/* FAILED to decompile: close @ 0x15240 */

/* FAILED to decompile: stat_0 @ 0x15248 */

/* FAILED to decompile: write @ 0x15258 */

/* FAILED to decompile: __getauxval @ 0x15260 */

/* FAILED to decompile: abort @ 0x15268 */

/* FAILED to decompile: puts @ 0x15270 */

/* FAILED to decompile: memcmp @ 0x15278 */

/* FAILED to decompile: strcmp @ 0x15280 */

/* FAILED to decompile: shmctl @ 0x15288 */

/* FAILED to decompile: fread @ 0x15290 */

/* FAILED to decompile: ftok @ 0x15298 */

/* FAILED to decompile: free @ 0x152A0 */

/* FAILED to decompile: shmget @ 0x152A8 */

/* FAILED to decompile: pthread_cond_wait @ 0x152B0 */

/* FAILED to decompile: strchr @ 0x152B8 */

/* FAILED to decompile: fwrite @ 0x152C0 */

/* FAILED to decompile: pthread_create @ 0x152C8 */

/* FAILED to decompile: wait @ 0x152D0 */

/* FAILED to decompile: socket @ 0x152D8 */

/* FAILED to decompile: strcpy @ 0x152E0 */

/* FAILED to decompile: read @ 0x152E8 */

/* FAILED to decompile: strstr @ 0x152F0 */

/* FAILED to decompile: usleep @ 0x152F8 */

/* FAILED to decompile: __isoc99_sscanf @ 0x15300 */

/* FAILED to decompile: strncpy @ 0x15308 */

/* FAILED to decompile: printf @ 0x15310 */

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

/* Total functions decompiled: 75, failed: 63 */
