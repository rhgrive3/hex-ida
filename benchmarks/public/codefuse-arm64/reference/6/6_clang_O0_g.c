/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_clang_O0_g
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
size_t __fastcall param_strcpy(char *dst, const char *src)
{
  strcpy(dst, src);
  return strlen(dst);
}


/* Function: call_strcpy @ 0x1888 */
int __cdecl call_strcpy()
{
  char dst[32]; // [xsp+10h] [xbp-20h] BYREF

  return param_strcpy(dst, "HelloLib");
}


/* Function: param_strcmp @ 0x18B8 */
__int64 __fastcall param_strcmp(const char *s1, const char *s2)
{
  int v5; // [xsp+Ch] [xbp-14h]

  v5 = strcmp(s1, s2);
  if ( v5 <= 0 )
  {
    if ( v5 < 0 )
      return (unsigned int)-1;
    else
      return 0;
  }
  else
  {
    return 1;
  }
}


/* Function: call_strcmp @ 0x1920 */
int __cdecl call_strcmp()
{
  int v1; // [xsp+8h] [xbp-8h]
  int r1; // [xsp+Ch] [xbp-4h]

  r1 = param_strcmp("abc", "def");
  v1 = param_strcmp("xyz", "xyz");
  return r1 + v1 + param_strcmp("bbb", "aaa");
}


/* Function: param_strlen @ 0x1990 */
__int64 __fastcall param_strlen(const char *str)
{
  return (unsigned int)strlen(str);
}


/* Function: call_strlen @ 0x19C0 */
int __cdecl call_strlen()
{
  return param_strlen("BinBench2025");
}


/* Function: param_memcpy @ 0x19EC */
__int64 __fastcall param_memcpy(void *dst, const void *src, size_t n)
{
  unsigned int na; // [xsp+8h] [xbp-18h]

  na = n;
  memcpy(dst, src, n);
  return na;
}


/* Function: call_memcpy @ 0x1A28 */
int __cdecl call_memcpy()
{
  __int64 dst; // [xsp+8h] [xbp-38h] BYREF
  __int64 v2; // [xsp+10h] [xbp-30h]
  int v3; // [xsp+18h] [xbp-28h]
  __int128 src; // [xsp+20h] [xbp-20h] BYREF
  int v5; // [xsp+30h] [xbp-10h]

  src = xmmword_3D04;
  v5 = 50;
  dst = 0;
  v2 = 0;
  v3 = 0;
  param_memcpy(&dst, &src, 0x14u);
  return dst + v2 + v3;
}


/* Function: param_memcmp @ 0x1A88 */
__int64 __fastcall param_memcmp(const void *p1, const void *p2, size_t n)
{
  int v6; // [xsp+4h] [xbp-1Ch]

  v6 = memcmp(p1, p2, n);
  if ( v6 <= 0 )
  {
    if ( v6 < 0 )
      return (unsigned int)-1;
    else
      return 0;
  }
  else
  {
    return 1;
  }
}


/* Function: call_memcmp @ 0x1AF8 */
int __cdecl call_memcmp()
{
  int v1; // [xsp+1Ch] [xbp-34h]
  __int64 v2; // [xsp+20h] [xbp-30h] BYREF
  int v3; // [xsp+28h] [xbp-28h]
  int arr2[3]; // [xsp+30h] [xbp-20h] BYREF
  int arr1[3]; // [xsp+40h] [xbp-10h] BYREF

  *(_QWORD *)arr1 = 0x200000001LL;
  arr1[2] = 3;
  *(_QWORD *)arr2 = 0x200000001LL;
  arr2[2] = 4;
  v2 = 0x200000001LL;
  v3 = 3;
  v1 = param_memcmp(arr1, arr2, 0xCu);
  return v1 + param_memcmp(arr1, &v2, 0xCu);
}


/* Function: param_printf @ 0x1BA0 */
__int64 __fastcall param_printf(int x, const char *name)
{
  return (unsigned int)printf("Value: %d, Name: %s\n", x, name);
}


/* Function: call_printf @ 0x1BDC */
int __cdecl call_printf()
{
  return param_printf(42, "Test");
}


/* Function: param_scanf @ 0x1C0C */
__int64 __fastcall param_scanf(const char *input_str)
{
  int v2; // [xsp+8h] [xbp-18h] BYREF
  int v3; // [xsp+Ch] [xbp-14h] BYREF
  const char *v4; // [xsp+10h] [xbp-10h]

  v4 = input_str;
  if ( (unsigned int)__isoc99_sscanf(input_str, "%d,%d", &v3, &v2) == 2 )
    return (unsigned int)(v3 + v2);
  else
    return (unsigned int)-1;
}


/* Function: call_scanf @ 0x1C78 */
int __cdecl call_scanf()
{
  return param_scanf("123,456");
}


/* Function: param_fopen_fclose @ 0x1C94 */
__int64 __fastcall param_fopen_fclose(const char *filename)
{
  unsigned int v2; // [xsp+4h] [xbp-1Ch]
  FILE *stream; // [xsp+8h] [xbp-18h]

  stream = fopen(filename, "r");
  if ( stream )
  {
    v2 = fileno(stream);
    fclose(stream);
    return v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_fopen_fclose @ 0x1D00 */
int __cdecl call_fopen_fclose()
{
  if ( (int)param_fopen_fclose("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1D38 */
int __cdecl param_fread_fwrite(const char *tmpfile)
{
  size_t v1; // x0
  bool v4; // [xsp+Ch] [xbp-64h]
  size_t v5; // [xsp+20h] [xbp-50h]
  size_t n; // [xsp+28h] [xbp-48h]
  FILE *s; // [xsp+30h] [xbp-40h]
  char s1[32]; // [xsp+38h] [xbp-38h] BYREF
  const char *write_data; // [xsp+58h] [xbp-18h]
  const char *tmpfilea; // [xsp+60h] [xbp-10h]

  tmpfilea = tmpfile;
  write_data = "BinBench Test Data";
  s = fopen(tmpfile, "w+");
  if ( !s )
    return -1;
  v1 = strlen(write_data);
  n = fwrite(write_data, 1u, v1, s);
  if ( n == strlen(write_data) )
  {
    rewind(s);
    v5 = fread(s1, 1u, n, s);
    s1[v5] = 0;
    fclose(s);
    unlink(tmpfilea);
    v4 = 0;
    if ( v5 == n )
      v4 = strcmp(s1, write_data) == 0;
    if ( v4 )
      return 42;
    else
      return -3;
  }
  else
  {
    fclose(s);
    return -2;
  }
}


/* Function: call_fread_fwrite @ 0x1E84 */
int __cdecl call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x1EA0 */
int __cdecl param_malloc_free(size_t size)
{
  int v2; // [xsp+Ch] [xbp-24h]
  size_t i; // [xsp+10h] [xbp-20h]
  _DWORD *ptr; // [xsp+18h] [xbp-18h]

  ptr = malloc(4 * size);
  if ( !ptr )
    return -1;
  for ( i = 0; i < size; ++i )
    ptr[i] = 10 * i;
  v2 = *ptr + ptr[size - 1];
  free(ptr);
  return v2;
}


/* Function: call_malloc_free @ 0x1F68 */
int __cdecl call_malloc_free()
{
  return param_malloc_free(0xAu);
}


/* Function: param_memset @ 0x1F80 */
int __cdecl param_memset(void *buffer, size_t size)
{
  size_t i; // [xsp+8h] [xbp-28h]
  int v4; // [xsp+14h] [xbp-1Ch]

  memset(buffer, 0, size);
  v4 = 0;
  for ( i = 0; i < size; ++i )
    v4 += *((unsigned __int8 *)buffer + i);
  return v4;
}


/* Function: call_memset @ 0x2008 */
int __cdecl call_memset()
{
  int i; // [xsp+4h] [xbp-2Ch]
  _DWORD buffer[10]; // [xsp+8h] [xbp-28h] BYREF

  for ( i = 0; i < 10; ++i )
    buffer[i] = 255;
  param_memset(buffer, 0x28u);
  return buffer[0] + buffer[9];
}


/* Function: param_strchr_strstr @ 0x2074 */
int __cdecl param_strchr_strstr(const char *str, char ch, const char *substr)
{
  int v4; // [xsp+8h] [xbp-48h]
  int v5; // [xsp+10h] [xbp-40h]
  char *v6; // [xsp+20h] [xbp-30h]
  char *pos1; // [xsp+30h] [xbp-20h]

  pos1 = strchr(str, (unsigned __int8)ch);
  if ( pos1 )
    v5 = (_DWORD)pos1 - (_DWORD)str;
  else
    v5 = -1;
  v6 = strstr(str, substr);
  if ( v6 )
    v4 = (_DWORD)v6 - (_DWORD)str;
  else
    v4 = -1;
  return v5 + v4;
}


/* Function: call_strchr_strstr @ 0x212C */
int __cdecl call_strchr_strstr()
{
  return param_strchr_strstr("Hello BinBench Test", 66, "Bench");
}


/* Function: test_standard_library_functions @ 0x216C */
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

  printf(asc_39AA);
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


/* Function: param_linux_syscall @ 0x2278 */
__int64 __fastcall param_linux_syscall(const char *pathname)
{
  int v2; // [xsp+Ch] [xbp-14h]

  v2 = syscall(56, 4294967196LL, pathname, 0);
  if ( v2 >= 0 )
  {
    syscall(57, (unsigned int)v2);
    return (unsigned int)v2;
  }
  else
  {
    return (unsigned int)-*__errno_location();
  }
}


/* Function: call_linux_syscall @ 0x22F4 */
int __cdecl call_linux_syscall()
{
  if ( (int)param_linux_syscall("/etc/passwd") < 0 )
    return -1;
  else
    return 42;
}


/* Function: param_win32_api @ 0x232C */
int __cdecl param_win32_api(const char *filename)
{
  struct stat v3; // [xsp+0h] [xbp-90h] BYREF
  const char *filenamea; // [xsp+80h] [xbp-10h]

  filenamea = filename;
  if ( stat(filename, &v3) < 0 )
    return -1;
  if ( v3.st_size <= 0 )
    return -2;
  else
    return 42;
}


/* Function: call_win32_api @ 0x238C */
int __cdecl call_win32_api()
{
  return param_win32_api("/etc/passwd");
}


/* Function: param_fork_exec @ 0x23A8 */
__int64 __fastcall param_fork_exec(const char *prog, const char *arg)
{
  int stat_loc; // [xsp+10h] [xbp-20h] BYREF
  __pid_t pid; // [xsp+14h] [xbp-1Ch]
  const char *v5; // [xsp+18h] [xbp-18h]
  const char *proga; // [xsp+20h] [xbp-10h]

  proga = prog;
  v5 = arg;
  pid = fork();
  if ( pid >= 0 )
  {
    if ( !pid )
    {
      execl(proga, proga, v5, 0);
      _exit(127);
    }
    if ( waitpid(pid, &stat_loc, 0) >= 0 )
    {
      if ( (stat_loc & 0x7F) != 0 )
        return (unsigned int)-3;
      else
        return (stat_loc & 0xFF00) >> 8;
    }
    else
    {
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_fork_exec @ 0x2478 */
int __cdecl call_fork_exec()
{
  if ( (unsigned int)param_fork_exec("/bin/true", 0) )
    return -1;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x24B4 */
int __cdecl param_pipe_communication()
{
  size_t v0; // x0
  __WAIT_STATUS v1; // x0
  int fd; // [xsp+1Ch] [xbp-44h]
  ssize_t v5; // [xsp+20h] [xbp-40h]
  __pid_t v6; // [xsp+30h] [xbp-30h]
  char buffer[32]; // [xsp+34h] [xbp-2Ch] BYREF
  int pipefd[2]; // [xsp+54h] [xbp-Ch] BYREF

  if ( pipe(pipefd) < 0 )
    return -1;
  v6 = fork();
  if ( v6 < 0 )
    return -2;
  if ( !v6 )
  {
    close(pipefd[0]);
    fd = pipefd[1];
    v0 = strlen("HelloPipe");
    write(fd, "HelloPipe", v0);
    close(pipefd[1]);
    _exit(0);
  }
  close(pipefd[1]);
  v5 = read(pipefd[0], buffer, 0x1Fu);
  buffer[v5] = 0;
  close(pipefd[0]);
  v1.__uptr = 0;
  wait(v1);
  if ( v5 <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x25C8 */
int __cdecl call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x25DC */
int __cdecl param_socket_create()
{
  struct sockaddr v1; // [xsp+10h] [xbp-20h] BYREF
  int opt; // [xsp+24h] [xbp-Ch] BYREF
  int sock; // [xsp+28h] [xbp-8h]

  sock = socket(2, 1, 0);
  if ( sock < 0 )
    return -1;
  opt = 1;
  if ( setsockopt(sock, 1, 2, &opt, 4u) >= 0 )
  {
    *(_QWORD *)&v1.sa_data[6] = 0;
    *(_QWORD *)&v1.sa_family = 2;
    *(_WORD *)v1.sa_data = htons(0);
    *(_DWORD *)&v1.sa_data[2] = 0;
    if ( bind(sock, &v1, 0x10u) >= 0 )
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


/* Function: call_socket_create @ 0x26FC */
int __cdecl call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x2710 */
int __cdecl param_shmget_shmat()
{
  int v1; // [xsp+4h] [xbp-2Ch]
  char *dest; // [xsp+8h] [xbp-28h]
  int shmid; // [xsp+14h] [xbp-1Ch]
  int key; // [xsp+18h] [xbp-18h]
  int fd; // [xsp+1Ch] [xbp-14h]

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
  dest = (char *)shmat(shmid, 0, 0);
  if ( dest == (char *)-1LL )
    return -3;
  strcpy(dest, "SharedMemory");
  v1 = strlen(dest);
  shmdt(dest);
  shmctl(shmid, 0, 0);
  return v1;
}


/* Function: call_shmget_shmat @ 0x2844 */
int __cdecl call_shmget_shmat()
{
  if ( param_shmget_shmat() <= 0 )
    return -1;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x2874 */
int __cdecl param_signal_handling()
{
  int v0; // w8
  int v1; // w8
  bool v3; // [xsp+10h] [xbp-10h]
  bool v4; // [xsp+14h] [xbp-Ch]
  int attempts; // [xsp+18h] [xbp-8h]
  int attemptsa; // [xsp+18h] [xbp-8h]

  if ( signal(10, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return -1;
  if ( signal(14, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return -2;
  signal_received = 0;
  raise(10);
  attempts = 1000;
  while ( 1 )
  {
    v4 = 0;
    if ( !signal_received )
    {
      v0 = attempts--;
      v4 = v0 > 0;
    }
    if ( !v4 )
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
  while ( 1 )
  {
    v3 = 0;
    if ( !signal_received )
    {
      v1 = attemptsa--;
      v3 = v1 > 0;
    }
    if ( !v3 )
      break;
    usleep(0x3E8u);
  }
  if ( !signal_received || signal_number != 14 )
    return -5;
  signal(10, 0);
  signal(14, 0);
  return 42;
}


/* Function: signal_handler @ 0x2A44 */
void __cdecl signal_handler(int sig)
{
  signal_received = 1;
  signal_number = sig;
}


/* Function: call_signal_handling @ 0x2A6C */
int __cdecl call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x2A80 */
void __cdecl test_system_calls()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0

  printf(asc_3B50);
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


/* Function: thread_compute @ 0x2B28 */
void *__cdecl thread_compute(void *arg)
{
  void *result; // x0
  int v2; // [xsp+8h] [xbp-18h]

  v2 = *(_DWORD *)arg * *(_DWORD *)arg;
  result = malloc(4u);
  *(_DWORD *)result = v2;
  return result;
}


/* Function: param_pthread_create @ 0x2B84 */
int __cdecl param_pthread_create(int x)
{
  int v2; // [xsp+8h] [xbp-28h]
  void *thread_return; // [xsp+10h] [xbp-20h] BYREF
  int input; // [xsp+1Ch] [xbp-14h] BYREF
  pthread_t tid; // [xsp+20h] [xbp-10h] BYREF
  int xa; // [xsp+28h] [xbp-8h]

  xa = x;
  input = x;
  if ( pthread_create(&tid, 0, (void *(*)(void *))thread_compute, &input) )
    return -1;
  pthread_join(tid, &thread_return);
  v2 = *(_DWORD *)thread_return;
  free(thread_return);
  return v2;
}


/* Function: call_pthread_create @ 0x2C0C */
int __cdecl call_pthread_create()
{
  return param_pthread_create(7);
}


/* Function: thread_sum @ 0x2C24 */
void *__cdecl thread_sum(void *arg)
{
  int i; // [xsp+Ch] [xbp-14h]

  *((_DWORD *)arg + 2) = 0;
  for ( i = *(_DWORD *)arg; i <= *((_DWORD *)arg + 1); ++i )
    *((_DWORD *)arg + 2) += i;
  return 0;
}


/* Function: param_pthread_join @ 0x2C98 */
int __cdecl param_pthread_join()
{
  int j; // [xsp+0h] [xbp-50h]
  int v2; // [xsp+4h] [xbp-4Ch]
  int i; // [xsp+8h] [xbp-48h]
  _DWORD s[9]; // [xsp+Ch] [xbp-44h] BYREF
  pthread_t tids[3]; // [xsp+30h] [xbp-20h] BYREF

  memset(s, 0, sizeof(s));
  s[0] = 1;
  s[1] = 10;
  s[3] = 11;
  s[4] = 20;
  s[6] = 21;
  s[7] = 30;
  for ( i = 0; i < 3; ++i )
  {
    if ( pthread_create(&tids[i], 0, (void *(*)(void *))thread_sum, &s[3 * i]) )
      return -1;
  }
  v2 = 0;
  for ( j = 0; j < 3; ++j )
  {
    if ( pthread_join(tids[j], 0) )
      return -2;
    v2 += s[3 * j + 2];
  }
  return v2;
}


/* Function: call_pthread_join @ 0x2DEC */
int __cdecl call_pthread_join()
{
  return param_pthread_join();
}


/* Function: thread_increment @ 0x2E00 */
void *__cdecl thread_increment(void *arg)
{
  int i; // [xsp+10h] [xbp-10h]
  int iterations; // [xsp+14h] [xbp-Ch]

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


/* Function: param_mutex_lock @ 0x2E8C */
int __cdecl param_mutex_lock(int thread_count, int iterations_per_thread)
{
  int j; // [xsp+10h] [xbp-20h]
  int i; // [xsp+14h] [xbp-1Ch]
  void *ptr; // [xsp+18h] [xbp-18h]
  int iterations_per_threada; // [xsp+24h] [xbp-Ch] BYREF
  int thread_counta; // [xsp+28h] [xbp-8h]

  thread_counta = thread_count;
  iterations_per_threada = iterations_per_thread;
  ptr = malloc(8LL * thread_count);
  if ( !ptr )
    return -1;
  shared_counter = 0;
  for ( i = 0; i < thread_counta; ++i )
  {
    if ( pthread_create((pthread_t *)ptr + i, 0, (void *(*)(void *))thread_increment, &iterations_per_threada) )
    {
      free(ptr);
      return -2;
    }
  }
  for ( j = 0; j < thread_counta; ++j )
    pthread_join(*((_QWORD *)ptr + j), 0);
  free(ptr);
  if ( shared_counter == thread_counta * iterations_per_threada )
    return 42;
  else
    return -3;
}


/* Function: call_mutex_lock @ 0x2FCC */
int __cdecl call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: consumer_thread @ 0x2FE8 */
void *__cdecl consumer_thread(void *arg)
{
  void *result; // x0
  int received; // [xsp+14h] [xbp-Ch]

  pthread_mutex_lock(&cond_mutex);
  while ( !ready )
    pthread_cond_wait(&cond, &cond_mutex);
  received = data;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *(_DWORD *)result = received;
  return result;
}


/* Function: producer_thread @ 0x3070 */
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


/* Function: param_condition_variable @ 0x30D8 */
int __cdecl param_condition_variable()
{
  int v1; // [xsp+Ch] [xbp-24h]
  void *thread_return; // [xsp+10h] [xbp-20h] BYREF
  pthread_t newthread; // [xsp+18h] [xbp-18h] BYREF
  pthread_t producer; // [xsp+20h] [xbp-10h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))consumer_thread, 0) )
    return -1;
  if ( pthread_create(&producer, 0, (void *(*)(void *))producer_thread, 0) )
  {
    pthread_cancel(newthread);
    return -2;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    pthread_join(producer, 0);
    v1 = *(_DWORD *)thread_return;
    free(thread_return);
    return v1;
  }
}


/* Function: call_condition_variable @ 0x319C */
int __cdecl call_condition_variable()
{
  return param_condition_variable();
}


/* Function: thread_atomic_increment @ 0x31B0 */
void *__cdecl thread_atomic_increment(void *arg)
{
  int i; // [xsp+30h] [xbp-10h]
  int iterations; // [xsp+34h] [xbp-Ch]

  iterations = *(_DWORD *)arg;
  for ( i = 0; i < iterations; ++i )
  {
    _aarch64_ldadd4_acq_rel(1);
    _aarch64_cas4_acq_rel();
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x3298 */
void *__cdecl thread_atomic_load_store(void *arg)
{
  unsigned int v1; // w8

  v1 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v1 + 100, (unsigned int *)&atomic_counter);
  return 0;
}


/* Function: param_atomic_ops @ 0x32D8 */
int __cdecl param_atomic_ops(int thread_count, int iterations)
{
  unsigned int v2; // w8
  int v5; // [xsp+10h] [xbp-30h]
  int j; // [xsp+14h] [xbp-2Ch]
  pthread_t newthread; // [xsp+18h] [xbp-28h] BYREF
  int i; // [xsp+20h] [xbp-20h]
  int v9; // [xsp+24h] [xbp-1Ch]
  pthread_t *tids; // [xsp+28h] [xbp-18h]
  int iterationsa; // [xsp+34h] [xbp-Ch] BYREF
  int thread_counta; // [xsp+38h] [xbp-8h]

  thread_counta = thread_count;
  iterationsa = iterations;
  tids = (pthread_t *)malloc(8LL * thread_count);
  if ( !tids )
    return -1;
  v9 = 0;
  atomic_store(0, (unsigned int *)&atomic_counter);
  for ( i = 0; i < thread_counta; ++i )
  {
    if ( pthread_create(&tids[i], 0, (void *(*)(void *))thread_atomic_increment, &iterationsa) )
    {
      free(tids);
      return -2;
    }
  }
  if ( !pthread_create(&newthread, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
    pthread_join(newthread, 0);
  for ( j = 0; j < thread_counta; ++j )
    pthread_join(tids[j], 0);
  v2 = atomic_load((unsigned int *)&atomic_counter);
  v5 = v2;
  free(tids);
  if ( v5 <= 0 )
    return -3;
  else
    return 42;
}


/* Function: call_atomic_ops @ 0x3458 */
int __cdecl call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: thread_tls_test @ 0x3474 */
void *__cdecl thread_tls_test(void *arg)
{
  unsigned __int64 StatusReg; // x8
  void *result; // x0
  _DWORD *v3; // [xsp+8h] [xbp-28h]
  int initial; // [xsp+1Ch] [xbp-14h]

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v3 = (_DWORD *)(StatusReg + 16);
  initial = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = initial + 50;
  strncpy((char *)(StatusReg + 20), (const char *)arg, 0x1Fu);
  result = malloc(8u);
  *(_DWORD *)result = initial;
  *((_DWORD *)result + 1) = *v3;
  return result;
}


/* Function: param_thread_local_storage @ 0x3504 */
int __cdecl param_thread_local_storage(int thread_count)
{
  bool v3; // [xsp+Ch] [xbp-54h]
  void *thread_return; // [xsp+28h] [xbp-38h] BYREF
  int k; // [xsp+30h] [xbp-30h]
  int total_final; // [xsp+34h] [xbp-2Ch]
  int total_initial; // [xsp+38h] [xbp-28h]
  int j; // [xsp+3Ch] [xbp-24h]
  int i_0; // [xsp+40h] [xbp-20h]
  int i; // [xsp+44h] [xbp-1Ch]
  char **names; // [xsp+48h] [xbp-18h]
  pthread_t *tids; // [xsp+50h] [xbp-10h]
  int thread_counta; // [xsp+58h] [xbp-8h]

  thread_counta = thread_count;
  tids = (pthread_t *)malloc(8LL * thread_count);
  names = (char **)malloc(8LL * thread_counta);
  if ( !tids || !names )
    return -1;
  for ( i = 0; i < thread_counta; ++i )
  {
    names[i] = (char *)malloc(0x10u);
    snprintf(names[i], 0x10u, "Thread-%d", i);
  }
  for ( i_0 = 0; i_0 < thread_counta; ++i_0 )
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
  for ( k = 0; k < thread_counta; ++k )
  {
    pthread_join(tids[k], &thread_return);
    total_initial += *(_DWORD *)thread_return;
    total_final += *((_DWORD *)thread_return + 1);
    free(thread_return);
    free(names[k]);
  }
  free(names);
  free(tids);
  v3 = 0;
  if ( total_initial == 100 * thread_counta )
    v3 = total_final == 150 * thread_counta;
  if ( v3 )
    return 42;
  else
    return -3;
}


/* Function: call_thread_local_storage @ 0x37A0 */
int __cdecl call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x37B8 */
void __cdecl test_thread_concurrency()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  printf(asc_3C3A);
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


/* Function: main @ 0x384C */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_standard_library_functions();
  test_system_calls();
  test_thread_concurrency();
  return 0;
}


/* Function: __aarch64_cas4_acq_rel @ 0x3880 */
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


/* Function: __aarch64_ldadd4_acq_rel @ 0x38C0 */
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


/* Function: .term_proc @ 0x38F0 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x15358 */

/* FAILED to decompile: _exit @ 0x15360 */

/* FAILED to decompile: strlen @ 0x15368 */

/* FAILED to decompile: raise @ 0x15370 */

/* FAILED to decompile: __libc_start_main @ 0x15378 */

/* FAILED to decompile: execl @ 0x15380 */

/* FAILED to decompile: listen @ 0x15388 */

/* FAILED to decompile: shmdt @ 0x15390 */

/* FAILED to decompile: bind @ 0x15398 */

/* FAILED to decompile: __cxa_finalize @ 0x153A0 */

/* FAILED to decompile: pipe @ 0x153A8 */

/* FAILED to decompile: fork @ 0x153B0 */

/* FAILED to decompile: snprintf @ 0x153B8 */

/* FAILED to decompile: fileno @ 0x153C0 */

/* FAILED to decompile: signal @ 0x153C8 */

/* FAILED to decompile: fclose @ 0x153D0 */

/* FAILED to decompile: fopen @ 0x153D8 */

/* FAILED to decompile: malloc @ 0x153E0 */

/* FAILED to decompile: setsockopt @ 0x153E8 */

/* FAILED to decompile: open @ 0x153F0 */

/* FAILED to decompile: pthread_cond_signal @ 0x153F8 */

/* FAILED to decompile: memset @ 0x15400 */

/* FAILED to decompile: shmat @ 0x15408 */

/* FAILED to decompile: sleep @ 0x15410 */

/* FAILED to decompile: htons @ 0x15418 */

/* FAILED to decompile: rewind @ 0x15420 */

/* FAILED to decompile: close @ 0x15428 */

/* FAILED to decompile: stat_0 @ 0x15430 */

/* FAILED to decompile: write @ 0x15438 */

/* FAILED to decompile: __getauxval @ 0x15440 */

/* FAILED to decompile: abort @ 0x15448 */

/* FAILED to decompile: memcmp @ 0x15450 */

/* FAILED to decompile: strcmp @ 0x15458 */

/* FAILED to decompile: shmctl @ 0x15460 */

/* FAILED to decompile: fread @ 0x15468 */

/* FAILED to decompile: ftok @ 0x15470 */

/* FAILED to decompile: free @ 0x15478 */

/* FAILED to decompile: shmget @ 0x15480 */

/* FAILED to decompile: pthread_cond_wait @ 0x15488 */

/* FAILED to decompile: strchr @ 0x15490 */

/* FAILED to decompile: fwrite @ 0x15498 */

/* FAILED to decompile: pthread_create @ 0x154A0 */

/* FAILED to decompile: wait @ 0x154A8 */

/* FAILED to decompile: socket @ 0x154B0 */

/* FAILED to decompile: strcpy @ 0x154B8 */

/* FAILED to decompile: read @ 0x154C0 */

/* FAILED to decompile: strstr @ 0x154C8 */

/* FAILED to decompile: usleep @ 0x154D0 */

/* FAILED to decompile: __isoc99_sscanf @ 0x154D8 */

/* FAILED to decompile: strncpy @ 0x154E0 */

/* FAILED to decompile: printf @ 0x154E8 */

/* FAILED to decompile: __errno_location @ 0x154F0 */

/* FAILED to decompile: pthread_join @ 0x154F8 */

/* FAILED to decompile: alarm @ 0x15500 */

/* FAILED to decompile: pthread_cancel @ 0x15508 */

/* FAILED to decompile: pthread_mutex_lock @ 0x15510 */

/* FAILED to decompile: syscall @ 0x15518 */

/* FAILED to decompile: pthread_mutex_unlock @ 0x15520 */

/* FAILED to decompile: waitpid @ 0x15528 */

/* FAILED to decompile: unlink @ 0x15530 */

/* FAILED to decompile: __gmon_start__ @ 0x15540 */

/* Total functions decompiled: 75, failed: 61 */
