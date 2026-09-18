/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_clang_O0_no_g
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
size_t __fastcall param_strcpy(char *a1, const char *a2)
{
  strcpy(a1, a2);
  return strlen(a1);
}


/* Function: call_strcpy @ 0x1888 */
__int64 call_strcpy()
{
  char v1[32]; // [xsp+10h] [xbp-20h] BYREF

  return (unsigned int)param_strcpy(v1, "HelloLib");
}


/* Function: param_strcmp @ 0x18B8 */
__int64 __fastcall param_strcmp(const char *a1, const char *a2)
{
  int v5; // [xsp+Ch] [xbp-14h]

  v5 = strcmp(a1, a2);
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
__int64 call_strcmp()
{
  int v1; // [xsp+8h] [xbp-8h]
  int v2; // [xsp+Ch] [xbp-4h]

  v2 = param_strcmp("abc", "def");
  v1 = param_strcmp("xyz", "xyz");
  return v2 + v1 + (unsigned int)param_strcmp("bbb", "aaa");
}


/* Function: param_strlen @ 0x1990 */
__int64 __fastcall param_strlen(const char *a1)
{
  return (unsigned int)strlen(a1);
}


/* Function: call_strlen @ 0x19C0 */
__int64 call_strlen()
{
  return param_strlen("BinBench2025");
}


/* Function: param_memcpy @ 0x19EC */
__int64 __fastcall param_memcpy(void *a1, const void *a2, size_t a3)
{
  unsigned int n; // [xsp+8h] [xbp-18h]

  n = a3;
  memcpy(a1, a2, a3);
  return n;
}


/* Function: call_memcpy @ 0x1A28 */
__int64 call_memcpy()
{
  __int64 v1; // [xsp+8h] [xbp-38h] BYREF
  __int64 v2; // [xsp+10h] [xbp-30h]
  int v3; // [xsp+18h] [xbp-28h]
  __int128 v4; // [xsp+20h] [xbp-20h] BYREF
  int v5; // [xsp+30h] [xbp-10h]

  v4 = xmmword_3D04;
  v5 = 50;
  v1 = 0;
  v2 = 0;
  v3 = 0;
  param_memcpy(&v1, &v4, 0x14u);
  return (unsigned int)(v1 + v2 + v3);
}


/* Function: param_memcmp @ 0x1A88 */
__int64 __fastcall param_memcmp(const void *a1, const void *a2, size_t a3)
{
  int v6; // [xsp+4h] [xbp-1Ch]

  v6 = memcmp(a1, a2, a3);
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
__int64 call_memcmp()
{
  int v1; // [xsp+1Ch] [xbp-34h]
  __int64 v2; // [xsp+20h] [xbp-30h] BYREF
  int v3; // [xsp+28h] [xbp-28h]
  __int64 v4; // [xsp+30h] [xbp-20h] BYREF
  int v5; // [xsp+38h] [xbp-18h]
  __int64 v6; // [xsp+40h] [xbp-10h] BYREF
  int v7; // [xsp+48h] [xbp-8h]

  v6 = 0x200000001LL;
  v7 = 3;
  v4 = 0x200000001LL;
  v5 = 4;
  v2 = 0x200000001LL;
  v3 = 3;
  v1 = param_memcmp(&v6, &v4, 0xCu);
  return v1 + (unsigned int)param_memcmp(&v6, &v2, 0xCu);
}


/* Function: param_printf @ 0x1BA0 */
__int64 __fastcall param_printf(int a1, const char *a2)
{
  return (unsigned int)printf("Value: %d, Name: %s\n", a1, a2);
}


/* Function: call_printf @ 0x1BDC */
__int64 call_printf()
{
  return (unsigned int)param_printf(42, "Test");
}


/* Function: param_scanf @ 0x1C0C */
__int64 __fastcall param_scanf(__int64 a1)
{
  int v2; // [xsp+8h] [xbp-18h] BYREF
  int v3; // [xsp+Ch] [xbp-14h] BYREF
  __int64 v4; // [xsp+10h] [xbp-10h]

  v4 = a1;
  if ( (unsigned int)__isoc99_sscanf(a1, "%d,%d", &v3, &v2) == 2 )
    return (unsigned int)(v3 + v2);
  else
    return (unsigned int)-1;
}


/* Function: call_scanf @ 0x1C78 */
__int64 call_scanf()
{
  return param_scanf((__int64)"123,456");
}


/* Function: param_fopen_fclose @ 0x1C94 */
__int64 __fastcall param_fopen_fclose(const char *a1)
{
  unsigned int v2; // [xsp+4h] [xbp-1Ch]
  FILE *stream; // [xsp+8h] [xbp-18h]

  stream = fopen(a1, "r");
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
__int64 call_fopen_fclose()
{
  if ( (int)param_fopen_fclose("/etc/passwd") < 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1D38 */
__int64 __fastcall param_fread_fwrite(const char *a1)
{
  size_t v1; // x0
  bool v4; // [xsp+Ch] [xbp-64h]
  size_t v5; // [xsp+20h] [xbp-50h]
  size_t n; // [xsp+28h] [xbp-48h]
  FILE *s; // [xsp+30h] [xbp-40h]
  char s1[32]; // [xsp+38h] [xbp-38h] BYREF
  const char *v9; // [xsp+58h] [xbp-18h]
  const char *v10; // [xsp+60h] [xbp-10h]

  v10 = a1;
  v9 = "BinBench Test Data";
  s = fopen(a1, "w+");
  if ( s )
  {
    v1 = strlen(v9);
    n = fwrite(v9, 1u, v1, s);
    if ( n == strlen(v9) )
    {
      rewind(s);
      v5 = fread(s1, 1u, n, s);
      s1[v5] = 0;
      fclose(s);
      unlink(v10);
      v4 = 0;
      if ( v5 == n )
        v4 = strcmp(s1, v9) == 0;
      if ( v4 )
        return 42;
      else
        return (unsigned int)-3;
    }
    else
    {
      fclose(s);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_fread_fwrite @ 0x1E84 */
__int64 call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x1EA0 */
__int64 __fastcall param_malloc_free(unsigned __int64 a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-24h]
  unsigned __int64 i; // [xsp+10h] [xbp-20h]
  _DWORD *ptr; // [xsp+18h] [xbp-18h]

  ptr = malloc(4 * a1);
  if ( ptr )
  {
    for ( i = 0; i < a1; ++i )
      ptr[i] = 10 * i;
    v2 = *ptr + ptr[a1 - 1];
    free(ptr);
    return v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_malloc_free @ 0x1F68 */
__int64 call_malloc_free()
{
  return param_malloc_free(0xAu);
}


/* Function: param_memset @ 0x1F80 */
__int64 __fastcall param_memset(unsigned __int8 *a1, size_t a2)
{
  size_t i; // [xsp+8h] [xbp-28h]
  unsigned int v4; // [xsp+14h] [xbp-1Ch]

  memset(a1, 0, a2);
  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += a1[i];
  return v4;
}


/* Function: call_memset @ 0x2008 */
__int64 call_memset()
{
  int i; // [xsp+4h] [xbp-2Ch]
  _DWORD v2[10]; // [xsp+8h] [xbp-28h] BYREF

  for ( i = 0; i < 10; ++i )
    v2[i] = 255;
  param_memset((unsigned __int8 *)v2, 0x28u);
  return (unsigned int)(v2[0] + v2[9]);
}


/* Function: param_strchr_strstr @ 0x2074 */
__int64 __fastcall param_strchr_strstr(const char *a1, unsigned __int8 a2, const char *a3)
{
  int v4; // [xsp+8h] [xbp-48h]
  int v5; // [xsp+10h] [xbp-40h]
  char *v6; // [xsp+20h] [xbp-30h]
  char *v7; // [xsp+30h] [xbp-20h]

  v7 = strchr(a1, a2);
  if ( v7 )
    v5 = (_DWORD)v7 - (_DWORD)a1;
  else
    v5 = -1;
  v6 = strstr(a1, a3);
  if ( v6 )
    v4 = (_DWORD)v6 - (_DWORD)a1;
  else
    v4 = -1;
  return (unsigned int)(v5 + v4);
}


/* Function: call_strchr_strstr @ 0x212C */
__int64 call_strchr_strstr()
{
  return (unsigned int)param_strchr_strstr("Hello BinBench Test", 0x42u, "Bench");
}


/* Function: test_standard_library_functions @ 0x216C */
__int64 test_standard_library_functions()
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
  return printf(aLibL112D, v11);
}


/* Function: param_linux_syscall @ 0x2278 */
__int64 __fastcall param_linux_syscall(__int64 a1)
{
  int v2; // [xsp+Ch] [xbp-14h]

  v2 = syscall(56, 4294967196LL, a1, 0);
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
__int64 call_linux_syscall()
{
  if ( (int)param_linux_syscall((__int64)"/etc/passwd") < 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_win32_api @ 0x232C */
__int64 __fastcall param_win32_api(const char *a1)
{
  int v1; // w8
  struct stat v3; // [xsp+0h] [xbp-90h] BYREF

  v3.__unused[1] = (__syscall_slong_t)a1;
  if ( stat(a1, &v3) >= 0 )
  {
    if ( v3.st_size <= 0 )
      v1 = -2;
    else
      v1 = 42;
    HIDWORD(v3.__unused[2]) = v1;
  }
  else
  {
    HIDWORD(v3.__unused[2]) = -1;
  }
  return HIDWORD(v3.__unused[2]);
}


/* Function: call_win32_api @ 0x238C */
__int64 call_win32_api()
{
  return param_win32_api("/etc/passwd");
}


/* Function: param_fork_exec @ 0x23A8 */
__int64 __fastcall param_fork_exec(const char *a1, __int64 a2)
{
  int stat_loc; // [xsp+10h] [xbp-20h] BYREF
  __pid_t pid; // [xsp+14h] [xbp-1Ch]
  __int64 v5; // [xsp+18h] [xbp-18h]
  const char *v6; // [xsp+20h] [xbp-10h]

  v6 = a1;
  v5 = a2;
  pid = fork();
  if ( pid >= 0 )
  {
    if ( !pid )
    {
      execl(v6, v6, v5, 0);
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
__int64 call_fork_exec()
{
  if ( (unsigned int)param_fork_exec("/bin/true", 0) )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x24B4 */
__int64 param_pipe_communication()
{
  size_t v0; // x0
  __WAIT_STATUS v1; // x0
  int fd; // [xsp+1Ch] [xbp-44h]
  ssize_t v5; // [xsp+20h] [xbp-40h]
  __pid_t v6; // [xsp+30h] [xbp-30h]
  _BYTE v7[32]; // [xsp+34h] [xbp-2Ch] BYREF
  int pipedes[2]; // [xsp+54h] [xbp-Ch] BYREF

  if ( pipe(pipedes) >= 0 )
  {
    v6 = fork();
    if ( v6 >= 0 )
    {
      if ( !v6 )
      {
        close(pipedes[0]);
        fd = pipedes[1];
        v0 = strlen("HelloPipe");
        write(fd, "HelloPipe", v0);
        close(pipedes[1]);
        _exit(0);
      }
      close(pipedes[1]);
      v5 = read(pipedes[0], v7, 0x1Fu);
      v7[v5] = 0;
      close(pipedes[0]);
      v1.__uptr = 0;
      wait(v1);
      if ( v5 <= 0 )
        return (unsigned int)-3;
      else
        return 42;
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


/* Function: call_pipe_communication @ 0x25C8 */
__int64 call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x25DC */
__int64 param_socket_create()
{
  struct sockaddr v1; // [xsp+10h] [xbp-20h] BYREF
  int optval; // [xsp+24h] [xbp-Ch] BYREF
  int v3; // [xsp+28h] [xbp-8h]

  v3 = socket(2, 1, 0);
  if ( v3 >= 0 )
  {
    optval = 1;
    if ( setsockopt(v3, 1, 2, &optval, 4u) >= 0 )
    {
      *(_QWORD *)&v1.sa_data[6] = 0;
      *(_QWORD *)&v1.sa_family = 2;
      *(_WORD *)v1.sa_data = htons(0);
      *(_DWORD *)&v1.sa_data[2] = 0;
      if ( bind(v3, &v1, 0x10u) >= 0 )
      {
        if ( listen(v3, 5) >= 0 )
        {
          close(v3);
          return 42;
        }
        else
        {
          close(v3);
          return (unsigned int)-4;
        }
      }
      else
      {
        close(v3);
        return (unsigned int)-3;
      }
    }
    else
    {
      close(v3);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_socket_create @ 0x26FC */
__int64 call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x2710 */
__int64 param_shmget_shmat()
{
  unsigned int v1; // [xsp+4h] [xbp-2Ch]
  char *dest; // [xsp+8h] [xbp-28h]
  int shmid; // [xsp+14h] [xbp-1Ch]
  int key; // [xsp+18h] [xbp-18h]
  int v5; // [xsp+1Ch] [xbp-14h]

  v5 = open("/tmp/binbench_shm", 66, 438);
  if ( v5 >= 0 )
  {
    close(v5);
    key = ftok("/tmp/binbench_shm", 42);
    if ( key >= 0 )
    {
      shmid = shmget(key, 0x1000u, 950);
      if ( shmid >= 0 )
      {
        dest = (char *)shmat(shmid, 0, 0);
        if ( dest == (char *)-1LL )
        {
          return (unsigned int)-3;
        }
        else
        {
          strcpy(dest, "SharedMemory");
          v1 = strlen(dest);
          shmdt(dest);
          shmctl(shmid, 0, 0);
          return v1;
        }
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
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_shmget_shmat @ 0x2844 */
__int64 call_shmget_shmat()
{
  if ( (int)param_shmget_shmat() <= 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x2874 */
__int64 param_signal_handling()
{
  int v0; // w8
  int v1; // w8
  bool v3; // [xsp+10h] [xbp-10h]
  bool v4; // [xsp+14h] [xbp-Ch]
  int v5; // [xsp+18h] [xbp-8h]
  int v6; // [xsp+18h] [xbp-8h]

  if ( signal(10, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
  {
    return (unsigned int)-1;
  }
  else if ( signal(14, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
  {
    return (unsigned int)-2;
  }
  else
  {
    signal_received = 0;
    raise(10);
    v5 = 1000;
    while ( 1 )
    {
      v4 = 0;
      if ( !signal_received )
      {
        v0 = v5--;
        v4 = v0 > 0;
      }
      if ( !v4 )
        break;
      usleep(0x3E8u);
    }
    if ( signal_received )
    {
      if ( signal_number == 10 )
      {
        signal_received = 0;
        alarm(1u);
        v6 = 2000;
        while ( 1 )
        {
          v3 = 0;
          if ( !signal_received )
          {
            v1 = v6--;
            v3 = v1 > 0;
          }
          if ( !v3 )
            break;
          usleep(0x3E8u);
        }
        if ( signal_received && signal_number == 14 )
        {
          signal(10, 0);
          signal(14, 0);
          return 42;
        }
        else
        {
          return (unsigned int)-5;
        }
      }
      else
      {
        return (unsigned int)-4;
      }
    }
    else
    {
      return (unsigned int)-3;
    }
  }
}


/* Function: signal_handler @ 0x2A44 */
__int64 __fastcall signal_handler(__int64 result)
{
  signal_received = 1;
  signal_number = result;
  return result;
}


/* Function: call_signal_handling @ 0x2A6C */
__int64 call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x2A80 */
__int64 test_system_calls()
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
  return printf(aSysL307D, v6);
}


/* Function: thread_compute @ 0x2B28 */
_DWORD *__fastcall thread_compute(_DWORD *a1)
{
  _DWORD *result; // x0
  int v2; // [xsp+8h] [xbp-18h]

  v2 = *a1 * *a1;
  result = malloc(4u);
  *result = v2;
  return result;
}


/* Function: param_pthread_create @ 0x2B84 */
__int64 __fastcall param_pthread_create(int a1)
{
  unsigned int v2; // [xsp+8h] [xbp-28h]
  void *thread_return; // [xsp+10h] [xbp-20h] BYREF
  int arg; // [xsp+1Ch] [xbp-14h] BYREF
  pthread_t newthread; // [xsp+20h] [xbp-10h] BYREF
  int v6; // [xsp+28h] [xbp-8h]

  v6 = a1;
  arg = a1;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    return (unsigned int)-1;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    v2 = *(_DWORD *)thread_return;
    free(thread_return);
    return v2;
  }
}


/* Function: call_pthread_create @ 0x2C0C */
__int64 call_pthread_create()
{
  return param_pthread_create(7);
}


/* Function: thread_sum @ 0x2C24 */
__int64 __fastcall thread_sum(int *a1)
{
  int i; // [xsp+Ch] [xbp-14h]

  a1[2] = 0;
  for ( i = *a1; i <= a1[1]; ++i )
    a1[2] += i;
  return 0;
}


/* Function: param_pthread_join @ 0x2C98 */
__int64 param_pthread_join()
{
  int j; // [xsp+0h] [xbp-50h]
  unsigned int v2; // [xsp+4h] [xbp-4Ch]
  int i; // [xsp+8h] [xbp-48h]
  _DWORD s[16]; // [xsp+Ch] [xbp-44h] BYREF

  memset(s, 0, 0x24u);
  s[0] = 1;
  s[1] = 10;
  s[3] = 11;
  s[4] = 20;
  s[6] = 21;
  s[7] = 30;
  for ( i = 0; i < 3; ++i )
  {
    if ( pthread_create((pthread_t *)&s[2 * i + 9], 0, (void *(*)(void *))thread_sum, &s[3 * i]) )
      return (unsigned int)-1;
  }
  v2 = 0;
  for ( j = 0; j < 3; ++j )
  {
    if ( pthread_join(*(_QWORD *)&s[2 * j + 9], 0) )
      return (unsigned int)-2;
    v2 += s[3 * j + 2];
  }
  return v2;
}


/* Function: call_pthread_join @ 0x2DEC */
__int64 call_pthread_join()
{
  return param_pthread_join();
}


/* Function: thread_increment @ 0x2E00 */
__int64 __fastcall thread_increment(int *a1)
{
  int i; // [xsp+10h] [xbp-10h]
  int v3; // [xsp+14h] [xbp-Ch]

  v3 = *a1;
  for ( i = 0; i < v3; ++i )
  {
    pthread_mutex_lock(&counter_mutex);
    ++shared_counter;
    pthread_mutex_unlock(&counter_mutex);
    usleep(0x3E8u);
  }
  return 0;
}


/* Function: param_mutex_lock @ 0x2E8C */
__int64 __fastcall param_mutex_lock(int a1, int a2)
{
  int j; // [xsp+10h] [xbp-20h]
  int i; // [xsp+14h] [xbp-1Ch]
  void *ptr; // [xsp+18h] [xbp-18h]
  int arg; // [xsp+24h] [xbp-Ch] BYREF
  int v8; // [xsp+28h] [xbp-8h]

  v8 = a1;
  arg = a2;
  ptr = malloc(8LL * a1);
  if ( ptr )
  {
    shared_counter = 0;
    for ( i = 0; i < v8; ++i )
    {
      if ( pthread_create((pthread_t *)ptr + i, 0, (void *(*)(void *))thread_increment, &arg) )
      {
        free(ptr);
        return (unsigned int)-2;
      }
    }
    for ( j = 0; j < v8; ++j )
      pthread_join(*((_QWORD *)ptr + j), 0);
    free(ptr);
    if ( shared_counter == v8 * arg )
      return 42;
    else
      return (unsigned int)-3;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_mutex_lock @ 0x2FCC */
__int64 call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: consumer_thread @ 0x2FE8 */
_DWORD *consumer_thread()
{
  _DWORD *result; // x0
  int v1; // [xsp+14h] [xbp-Ch]

  pthread_mutex_lock(&cond_mutex);
  while ( !ready )
    pthread_cond_wait(&cond, &cond_mutex);
  v1 = data;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *result = v1;
  return result;
}


/* Function: producer_thread @ 0x3070 */
__int64 producer_thread()
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
__int64 param_condition_variable()
{
  unsigned int v1; // [xsp+Ch] [xbp-24h]
  void *thread_return; // [xsp+10h] [xbp-20h] BYREF
  pthread_t newthread; // [xsp+18h] [xbp-18h] BYREF
  pthread_t v4; // [xsp+20h] [xbp-10h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))consumer_thread, 0) )
  {
    return (unsigned int)-1;
  }
  else if ( pthread_create(&v4, 0, (void *(*)(void *))producer_thread, 0) )
  {
    pthread_cancel(newthread);
    return (unsigned int)-2;
  }
  else
  {
    pthread_join(newthread, &thread_return);
    pthread_join(v4, 0);
    v1 = *(_DWORD *)thread_return;
    free(thread_return);
    return v1;
  }
}


/* Function: call_condition_variable @ 0x319C */
__int64 call_condition_variable()
{
  return param_condition_variable();
}


/* Function: thread_atomic_increment @ 0x31B0 */
__int64 __fastcall thread_atomic_increment(int *a1)
{
  int i; // [xsp+30h] [xbp-10h]
  int v3; // [xsp+34h] [xbp-Ch]

  v3 = *a1;
  for ( i = 0; i < v3; ++i )
  {
    _aarch64_ldadd4_acq_rel(1);
    _aarch64_cas4_acq_rel();
  }
  return 0;
}


/* Function: thread_atomic_load_store @ 0x3298 */
__int64 thread_atomic_load_store()
{
  unsigned int v0; // w8

  v0 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v0 + 100, (unsigned int *)&atomic_counter);
  return 0;
}


/* Function: param_atomic_ops @ 0x32D8 */
__int64 __fastcall param_atomic_ops(int a1, int a2)
{
  unsigned int v2; // w8
  int v5; // [xsp+10h] [xbp-30h]
  int j; // [xsp+14h] [xbp-2Ch]
  pthread_t newthread; // [xsp+18h] [xbp-28h] BYREF
  int i; // [xsp+20h] [xbp-20h]
  int v9; // [xsp+24h] [xbp-1Ch]
  void *v10; // [xsp+28h] [xbp-18h]
  int arg; // [xsp+34h] [xbp-Ch] BYREF
  int v12; // [xsp+38h] [xbp-8h]

  v12 = a1;
  arg = a2;
  v10 = malloc(8LL * a1);
  if ( v10 )
  {
    v9 = 0;
    atomic_store(0, (unsigned int *)&atomic_counter);
    for ( i = 0; i < v12; ++i )
    {
      if ( pthread_create((pthread_t *)v10 + i, 0, (void *(*)(void *))thread_atomic_increment, &arg) )
      {
        free(v10);
        return (unsigned int)-2;
      }
    }
    if ( !pthread_create(&newthread, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
      pthread_join(newthread, 0);
    for ( j = 0; j < v12; ++j )
      pthread_join(*((_QWORD *)v10 + j), 0);
    v2 = atomic_load((unsigned int *)&atomic_counter);
    v5 = v2;
    free(v10);
    if ( v5 <= 0 )
      return (unsigned int)-3;
    else
      return 42;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_atomic_ops @ 0x3458 */
__int64 call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: thread_tls_test @ 0x3474 */
_DWORD *__fastcall thread_tls_test(const char *a1)
{
  unsigned __int64 StatusReg; // x8
  _DWORD *result; // x0
  _DWORD *v3; // [xsp+8h] [xbp-28h]
  int v4; // [xsp+1Ch] [xbp-14h]

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v3 = (_DWORD *)(StatusReg + 16);
  v4 = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = v4 + 50;
  strncpy((char *)(StatusReg + 20), a1, 0x1Fu);
  result = malloc(8u);
  *result = v4;
  result[1] = *v3;
  return result;
}


/* Function: param_thread_local_storage @ 0x3504 */
__int64 __fastcall param_thread_local_storage(int a1)
{
  bool v3; // [xsp+Ch] [xbp-54h]
  void *thread_return; // [xsp+28h] [xbp-38h] BYREF
  int m; // [xsp+30h] [xbp-30h]
  int v6; // [xsp+34h] [xbp-2Ch]
  int v7; // [xsp+38h] [xbp-28h]
  int k; // [xsp+3Ch] [xbp-24h]
  int j; // [xsp+40h] [xbp-20h]
  int i; // [xsp+44h] [xbp-1Ch]
  _QWORD *v11; // [xsp+48h] [xbp-18h]
  void *v12; // [xsp+50h] [xbp-10h]
  int v13; // [xsp+58h] [xbp-8h]

  v13 = a1;
  v12 = malloc(8LL * a1);
  v11 = malloc(8LL * v13);
  if ( v12 && v11 )
  {
    for ( i = 0; i < v13; ++i )
    {
      v11[i] = malloc(0x10u);
      snprintf((char *)v11[i], 0x10u, "Thread-%d", i);
    }
    for ( j = 0; j < v13; ++j )
    {
      if ( pthread_create((pthread_t *)v12 + j, 0, (void *(*)(void *))thread_tls_test, (void *)v11[j]) )
      {
        for ( k = 0; k <= j; ++k )
          free((void *)v11[k]);
        free(v11);
        free(v12);
        return (unsigned int)-2;
      }
    }
    v7 = 0;
    v6 = 0;
    for ( m = 0; m < v13; ++m )
    {
      pthread_join(*((_QWORD *)v12 + m), &thread_return);
      v7 += *(_DWORD *)thread_return;
      v6 += *((_DWORD *)thread_return + 1);
      free(thread_return);
      free((void *)v11[m]);
    }
    free(v11);
    free(v12);
    v3 = 0;
    if ( v7 == 100 * v13 )
      v3 = v6 == 150 * v13;
    if ( v3 )
      return 42;
    else
      return (unsigned int)-3;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_thread_local_storage @ 0x37A0 */
__int64 call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x37B8 */
__int64 test_thread_concurrency()
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
  return printf(aThrL306D, v5);
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

/* FAILED to decompile: stat @ 0x15430 */

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
