/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/6/6_clang_O1_no_g
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
  char *v2; // x0

  v2 = strcpy(a1, a2);
  return strlen(v2);
}


/* Function: call_strcpy @ 0x186C */
size_t call_strcpy()
{
  char v1[32]; // [xsp+0h] [xbp-20h] BYREF

  strcpy(v1, "HelloLib");
  return strlen(v1);
}


/* Function: param_strcmp @ 0x18A0 */
__int64 __fastcall param_strcmp(const char *a1, const char *a2)
{
  int v2; // w0
  unsigned int v3; // w8

  v2 = strcmp(a1, a2);
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
__int64 call_strcmp()
{
  return 0;
}


/* Function: param_strlen @ 0x18CC */
size_t __fastcall param_strlen(const char *a1)
{
  return strlen(a1);
}


/* Function: call_strlen @ 0x18E0 */
__int64 call_strlen()
{
  return 12;
}


/* Function: param_memcpy @ 0x18E8 */
__int64 __fastcall param_memcpy(void *a1, const void *a2, size_t a3)
{
  unsigned int v3; // w19

  v3 = a3;
  memcpy(a1, a2, a3);
  return v3;
}


/* Function: call_memcpy @ 0x190C */
__int64 call_memcpy()
{
  return 90;
}


/* Function: param_memcmp @ 0x1914 */
__int64 __fastcall param_memcmp(const void *a1, const void *a2, size_t a3)
{
  int v3; // w0
  unsigned int v4; // w8

  v3 = memcmp(a1, a2, a3);
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
__int64 call_memcmp()
{
  return 0xFFFFFFFFLL;
}


/* Function: param_printf @ 0x1940 */
__int64 __fastcall param_printf(int a1, const char *a2)
{
  return printf("Value: %d, Name: %s\n", a1, a2);
}


/* Function: call_printf @ 0x1964 */
__int64 call_printf()
{
  return printf("Value: %d, Name: %s\n", 42, "Test");
}


/* Function: param_scanf @ 0x198C */
__int64 __fastcall param_scanf(__int64 a1)
{
  int v2; // [xsp+8h] [xbp-8h] BYREF
  int v3; // [xsp+Ch] [xbp-4h] BYREF

  if ( (unsigned int)__isoc99_sscanf(a1, "%d,%d", &v3, &v2) == 2 )
    return (unsigned int)(v2 + v3);
  else
    return 0xFFFFFFFFLL;
}


/* Function: call_scanf @ 0x19CC */
__int64 call_scanf()
{
  int v1; // [xsp+8h] [xbp-8h] BYREF
  int v2; // [xsp+Ch] [xbp-4h] BYREF

  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", &v2, &v1) == 2 )
    return (unsigned int)(v1 + v2);
  else
    return 0xFFFFFFFFLL;
}


/* Function: param_fopen_fclose @ 0x1A14 */
__int64 __fastcall param_fopen_fclose(const char *a1)
{
  FILE *v1; // x0
  FILE *v2; // x20
  unsigned int v3; // w19

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


/* Function: call_fopen_fclose @ 0x1A5C */
__int64 call_fopen_fclose()
{
  FILE *v0; // x0
  FILE *v1; // x19
  int v2; // w20

  v0 = fopen("/etc/passwd", "r");
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  v2 = fileno(v0);
  fclose(v1);
  if ( v2 < 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_fread_fwrite @ 0x1AB4 */
__int64 __fastcall param_fread_fwrite(const char *a1)
{
  FILE *v2; // x0
  FILE *v3; // x20
  size_t v4; // x22
  __int64 result; // x0
  __int64 v6; // [xsp+0h] [xbp-20h] BYREF
  _QWORD v7[3]; // [xsp+8h] [xbp-18h]

  v2 = fopen(a1, "w+");
  if ( !v2 )
    return 0xFFFFFFFFLL;
  v3 = v2;
  if ( fwrite("BinBench Test Data", 1u, 0x12u, v2) == 18 )
  {
    rewind(v3);
    v4 = fread(&v6, 1u, 0x12u, v3);
    *((_BYTE *)&v7[-1] + v4) = 0;
    fclose(v3);
    unlink(a1);
    result = 4294967293LL;
    if ( v4 == 18 )
    {
      if ( v6 ^ 0x68636E65426E6942LL | v7[0] ^ 0x6144207473655420LL | *(_QWORD *)((char *)v7 + 3) ^ 0x61746144207473LL )
        return 4294967293LL;
      else
        return 42;
    }
  }
  else
  {
    fclose(v3);
    return 4294967294LL;
  }
  return result;
}


/* Function: call_fread_fwrite @ 0x1BD4 */
__int64 call_fread_fwrite()
{
  return param_fread_fwrite("/tmp/binbench_test.tmp");
}


/* Function: param_malloc_free @ 0x1BF0 */
__int64 __fastcall param_malloc_free(__int64 a1)
{
  _DWORD *v2; // x0
  int v3; // w8
  _DWORD *v4; // x9
  __int64 v5; // x10
  unsigned int v6; // w19

  v2 = malloc(4 * a1);
  if ( v2 )
  {
    if ( a1 )
    {
      v3 = 0;
      v4 = v2;
      v5 = a1;
      do
      {
        *v4++ = v3;
        --v5;
        v3 += 10;
      }
      while ( v5 );
    }
    v6 = v2[a1 - 1] + *v2;
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v6;
}


/* Function: call_malloc_free @ 0x1C58 */
__int64 call_malloc_free()
{
  _DWORD *v0; // x0
  int v1; // w8
  __int64 i; // x9
  unsigned int v3; // w19

  v0 = malloc(0x28u);
  if ( v0 )
  {
    v1 = 0;
    for ( i = 0; i != 10; ++i )
    {
      v0[i] = v1;
      v1 += 10;
    }
    v3 = v0[9] + *v0;
    free(v0);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: param_memset @ 0x1CB4 */
__int64 __fastcall param_memset(unsigned __int8 *a1, size_t n)
{
  size_t v2; // x19
  unsigned __int8 *v3; // x20
  __int64 result; // x0
  int v5; // t1

  v2 = n;
  v3 = a1;
  memset(a1, 0, n);
  for ( result = 0; v2; result = (unsigned int)(result + v5) )
  {
    v5 = *v3++;
    --v2;
  }
  return result;
}


/* Function: call_memset @ 0x1CF8 */
__int64 call_memset()
{
  __int64 i; // x8
  _OWORD v2[2]; // [xsp+0h] [xbp-30h]

  for ( i = 0; i != 40; i += 4 )
    *(_DWORD *)((char *)v2 + i) = 255;
  return 0;
}


/* Function: param_strchr_strstr @ 0x1D34 */
__int64 __fastcall param_strchr_strstr(const char *a1, unsigned __int8 a2, const char *a3)
{
  char *v5; // x0
  int v6; // w21
  char *v7; // x0
  int v8; // w8

  v5 = strchr(a1, a2);
  if ( v5 )
    v6 = (_DWORD)v5 - (_DWORD)a1;
  else
    v6 = -1;
  v7 = strstr(a1, a3);
  v8 = (_DWORD)v7 - (_DWORD)a1;
  if ( !v7 )
    v8 = -1;
  return (unsigned int)(v8 + v6);
}


/* Function: call_strchr_strstr @ 0x1D8C */
__int64 call_strchr_strstr()
{
  return 15;
}


/* Function: test_standard_library_functions @ 0x1D94 */
__int64 test_standard_library_functions()
{
  size_t v0; // x0
  unsigned int v1; // w19
  unsigned int v2; // w0
  __int64 v3; // x1
  FILE *v4; // x0
  FILE *v5; // x20
  int v6; // w19
  unsigned int v7; // w0
  _DWORD *v8; // x0
  int v9; // w8
  __int64 i; // x9
  unsigned int v11; // w19
  __int64 j; // x8
  char v14[32]; // [xsp+0h] [xbp-30h] BYREF
  __int64 v15; // [xsp+20h] [xbp-10h]
  int v16; // [xsp+4Ch] [xbp+1Ch] BYREF

  puts(asc_36EC);
  strcpy(v14, "HelloLib");
  v0 = strlen(v14);
  printf(aLibL101D, v0);
  printf(aLibL102D, 0);
  printf(aLibL103D, 12);
  printf(aLibL104D, 90);
  v1 = -1;
  printf(aLibL105D, 0xFFFFFFFFLL);
  v2 = printf("Value: %d, Name: %s\n", 42, "Test");
  printf(aLibL106D, v2);
  if ( (unsigned int)__isoc99_sscanf("123,456", "%d,%d", v14, &v16) == 2 )
    v3 = (unsigned int)(v16 + *(_DWORD *)v14);
  else
    v3 = 0xFFFFFFFFLL;
  printf(aLibL107D, v3);
  v4 = fopen("/etc/passwd", "r");
  if ( v4 )
  {
    v5 = v4;
    v6 = fileno(v4);
    fclose(v5);
    if ( v6 < 0 )
      v1 = -1;
    else
      v1 = 42;
  }
  printf(aLibL108D, v1);
  v7 = param_fread_fwrite("/tmp/binbench_test.tmp");
  printf(aLibL109D, v7);
  v8 = malloc(0x28u);
  if ( v8 )
  {
    v9 = 0;
    for ( i = 0; i != 10; ++i )
    {
      v8[i] = v9;
      v9 += 10;
    }
    v11 = v8[9] + *v8;
    free(v8);
  }
  else
  {
    v11 = -1;
  }
  printf(aLibL110D, v11);
  for ( j = 0; j != 40; j += 4 )
    *(_DWORD *)&v14[j] = 255;
  v15 = 0;
  *(_OWORD *)v14 = 0u;
  printf(aLibL111D, 0);
  return printf(aLibL112D, 15);
}


/* Function: param_linux_syscall @ 0x1FA0 */
__int64 __fastcall param_linux_syscall(__int64 a1)
{
  unsigned int v1; // w19

  v1 = syscall(56, 4294967196LL, a1, 0);
  if ( (v1 & 0x80000000) != 0 )
    return (unsigned int)-*__errno_location();
  else
    syscall(57, v1);
  return v1;
}


/* Function: call_linux_syscall @ 0x1FF4 */
__int64 call_linux_syscall()
{
  int v0; // w19

  v0 = syscall(56, 4294967196LL, "/etc/passwd", 0);
  if ( v0 < 0 )
    v0 = -*__errno_location();
  else
    syscall(57, (unsigned int)v0);
  if ( v0 < 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_win32_api @ 0x2054 */
__int64 __fastcall param_win32_api(const char *a1)
{
  int v1; // w0
  unsigned int v2; // w8
  struct stat _0; // [xsp+0h] [xbp-80h] BYREF

  v1 = stat(a1, &_0);
  if ( _0.st_size <= 0 )
    v2 = -2;
  else
    v2 = 42;
  if ( v1 < 0 )
    return 0xFFFFFFFFLL;
  else
    return v2;
}


/* Function: call_win32_api @ 0x2090 */
__int64 call_win32_api()
{
  int v0; // w0
  unsigned int v1; // w8
  struct stat _0; // [xsp+0h] [xbp-80h] BYREF

  v0 = stat("/etc/passwd", &_0);
  if ( _0.st_size <= 0 )
    v1 = -2;
  else
    v1 = 42;
  if ( v0 < 0 )
    return 0xFFFFFFFFLL;
  else
    return v1;
}


/* Function: param_fork_exec @ 0x20D4 */
__int64 __fastcall param_fork_exec(const char *a1, __int64 a2)
{
  __pid_t v4; // w0
  int stat_loc; // [xsp+Ch] [xbp-4h] BYREF

  v4 = fork();
  if ( v4 < 0 )
    return 0xFFFFFFFFLL;
  if ( !v4 )
  {
    execl(a1, a1, a2, 0);
    _exit(127);
  }
  if ( waitpid(v4, &stat_loc, 0) < 0 )
    return 4294967294LL;
  if ( (stat_loc & 0x7F) != 0 )
    return 4294967293LL;
  return BYTE1(stat_loc);
}


/* Function: call_fork_exec @ 0x215C */
__int64 call_fork_exec()
{
  __pid_t v0; // w0
  int v1; // w8
  int stat_loc; // [xsp+Ch] [xbp-4h] BYREF

  v0 = fork();
  if ( v0 < 0 )
  {
    v1 = -1;
  }
  else
  {
    if ( !v0 )
    {
      execl("/bin/true", "/bin/true", 0, 0);
      _exit(127);
    }
    if ( waitpid(v0, &stat_loc, 0) < 0 )
    {
      v1 = -2;
    }
    else if ( (stat_loc & 0x7F) != 0 )
    {
      v1 = -3;
    }
    else
    {
      v1 = BYTE1(stat_loc);
    }
  }
  if ( v1 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_pipe_communication @ 0x21E4 */
__int64 param_pipe_communication()
{
  __pid_t v0; // w0
  ssize_t v1; // x19
  int v2; // w0
  __WAIT_STATUS v3; // x0
  _BYTE buf[32]; // [xsp+8h] [xbp-28h] BYREF
  int pipedes[2]; // [xsp+28h] [xbp-8h] BYREF

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
  v1 = read(pipedes[0], buf, 0x1Fu);
  v2 = pipedes[0];
  buf[v1] = 0;
  close(v2);
  v3.__uptr = 0;
  wait(v3);
  if ( v1 <= 0 )
    return 4294967293LL;
  else
    return 42;
}


/* Function: call_pipe_communication @ 0x229C */
__int64 call_pipe_communication()
{
  return param_pipe_communication();
}


/* Function: param_socket_create @ 0x22B0 */
__int64 param_socket_create()
{
  int v0; // w0
  int v1; // w19
  int v2; // w20
  sockaddr addr; // [xsp+8h] [xbp-18h] BYREF
  int optval; // [xsp+1Ch] [xbp-4h] BYREF

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
    *(_QWORD *)&addr.sa_family = 2;
    *(_QWORD *)&addr.sa_data[6] = 0;
    if ( bind(v1, &addr, 0x10u) < 0 )
    {
      close(v1);
      return 4294967293LL;
    }
    else
    {
      v2 = listen(v1, 5);
      close(v1);
      if ( v2 >= 0 )
        return 42;
      else
        return 4294967292LL;
    }
  }
}


/* Function: call_socket_create @ 0x2374 */
__int64 call_socket_create()
{
  return param_socket_create();
}


/* Function: param_shmget_shmat @ 0x2388 */
__int64 param_shmget_shmat()
{
  int v0; // w0
  key_t v1; // w0
  int v2; // w0
  int v3; // w19
  char *v4; // x0
  char *v5; // x21
  unsigned int v6; // w20

  v0 = open("/tmp/binbench_shm", 66, 438);
  if ( v0 < 0 )
    return (unsigned int)-1;
  close(v0);
  v1 = ftok("/tmp/binbench_shm", 42);
  if ( v1 < 0 )
  {
    return (unsigned int)-1;
  }
  else
  {
    v2 = shmget(v1, 0x1000u, 950);
    if ( v2 < 0 )
    {
      return (unsigned int)-2;
    }
    else
    {
      v3 = v2;
      v4 = (char *)shmat(v2, 0, 0);
      if ( v4 == (char *)-1LL )
      {
        return (unsigned int)-3;
      }
      else
      {
        v5 = v4;
        strcpy(v4, "SharedMemory");
        v6 = strlen(v4);
        shmdt(v5);
        shmctl(v3, 0, 0);
      }
    }
  }
  return v6;
}


/* Function: call_shmget_shmat @ 0x2458 */
__int64 call_shmget_shmat()
{
  if ( (int)param_shmget_shmat() <= 0 )
    return 0xFFFFFFFFLL;
  else
    return 42;
}


/* Function: param_signal_handling @ 0x2478 */
__int64 param_signal_handling()
{
  unsigned int v0; // w20
  bool v1; // cc
  unsigned int v2; // w21
  bool v3; // cc

  if ( signal(10, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return 0xFFFFFFFFLL;
  if ( signal(14, (__sighandler_t)signal_handler) == (__sighandler_t)-1LL )
    return 4294967294LL;
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
    return 4294967293LL;
  if ( signal_number != 10 )
    return 4294967292LL;
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
    return 4294967291LL;
  signal(10, 0);
  signal(14, 0);
  return 42;
}


/* Function: signal_handler @ 0x25AC */
__int64 __fastcall signal_handler(__int64 result)
{
  signal_received = 1;
  signal_number = result;
  return result;
}


/* Function: call_signal_handling @ 0x25C4 */
__int64 call_signal_handling()
{
  return param_signal_handling();
}


/* Function: test_system_calls @ 0x25D8 */
__int64 test_system_calls()
{
  int v0; // w19
  __int64 v1; // x1
  int v2; // w0
  unsigned int v3; // w8
  __int64 v4; // x1
  __pid_t v5; // w0
  int v6; // w8
  __int64 v7; // x1
  unsigned int v8; // w0
  unsigned int v9; // w0
  __int64 v10; // x1
  unsigned int v11; // w0
  struct stat v13; // [xsp+0h] [xbp-80h] BYREF

  puts(asc_3710);
  v0 = syscall(56, 4294967196LL, "/etc/passwd", 0);
  if ( v0 < 0 )
    v0 = -*__errno_location();
  else
    syscall(57, (unsigned int)v0);
  if ( v0 < 0 )
    v1 = 0xFFFFFFFFLL;
  else
    v1 = 42;
  printf(aSysL301D, v1);
  v2 = stat("/etc/passwd", &v13);
  if ( v13.st_size <= 0 )
    v3 = -2;
  else
    v3 = 42;
  if ( v2 < 0 )
    v4 = 0xFFFFFFFFLL;
  else
    v4 = v3;
  printf(aSysL302D, v4);
  v5 = fork();
  if ( v5 < 0 )
  {
    v6 = -1;
  }
  else
  {
    if ( !v5 )
    {
      execl("/bin/true", "/bin/true", 0, 0);
      _exit(127);
    }
    if ( waitpid(v5, (int *)&v13, 0) < 0 )
    {
      v6 = -2;
    }
    else if ( (v13.st_dev & 0x7F) != 0 )
    {
      v6 = -3;
    }
    else
    {
      v6 = BYTE1(v13.st_dev);
    }
  }
  if ( v6 )
    v7 = 0xFFFFFFFFLL;
  else
    v7 = 42;
  printf(aSysL303D, v7);
  v8 = param_pipe_communication();
  printf(aSysL304D, v8);
  v9 = param_socket_create();
  printf(aSysL305D, v9);
  if ( (int)param_shmget_shmat() <= 0 )
    v10 = 0xFFFFFFFFLL;
  else
    v10 = 42;
  printf(aSysL306D, v10);
  v11 = param_signal_handling();
  return printf(aSysL307D, v11);
}


/* Function: thread_compute @ 0x2758 */
_DWORD *__fastcall thread_compute(_DWORD *a1)
{
  int v1; // w19
  _DWORD *result; // x0

  v1 = *a1 * *a1;
  result = malloc(4u);
  *result = v1;
  return result;
}


/* Function: param_pthread_create @ 0x2784 */
__int64 __fastcall param_pthread_create(int a1)
{
  unsigned int v1; // w19
  void *ptr; // [xsp+0h] [xbp-10h] BYREF
  int arg; // [xsp+Ch] [xbp-4h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+18h] BYREF

  arg = a1;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    return (unsigned int)-1;
  }
  else
  {
    pthread_join(newthread, &ptr);
    v1 = *(_DWORD *)ptr;
    free(ptr);
  }
  return v1;
}


/* Function: call_pthread_create @ 0x27E8 */
__int64 call_pthread_create()
{
  unsigned int v0; // w19
  void *ptr; // [xsp+0h] [xbp-10h] BYREF
  int arg; // [xsp+Ch] [xbp-4h] BYREF
  pthread_t newthread; // [xsp+28h] [xbp+18h] BYREF

  arg = 7;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    return (unsigned int)-1;
  }
  else
  {
    pthread_join(newthread, &ptr);
    v0 = *(_DWORD *)ptr;
    free(ptr);
  }
  return v0;
}


/* Function: thread_sum @ 0x2850 */
__int64 __fastcall thread_sum(int *a1)
{
  int v1; // w8
  int v2; // w10

  v1 = *a1;
  v2 = a1[1];
  a1[2] = 0;
  if ( v2 >= v1 )
    a1[2] += v2 + (v2 - v1) * v1 + (((unsigned int)(v2 + ~v1) * (unsigned __int64)(unsigned int)(v2 - v1)) >> 1);
  return 0;
}


/* Function: param_pthread_join @ 0x2890 */
__int64 param_pthread_join()
{
  __int64 v0; // x21
  __int64 *v1; // x19
  __int64 v2; // x20
  unsigned int v3; // w19
  int *v4; // x21
  int v5; // t1
  __int64 v7; // [xsp+0h] [xbp-40h] BYREF
  _QWORD v8[3]; // [xsp+8h] [xbp-38h] BYREF
  int v9; // [xsp+20h] [xbp-20h]
  _BYTE v10[24]; // [xsp+28h] [xbp-18h] BYREF

  v0 = 0;
  v1 = &v7;
  v8[0] = 0xB00000000LL;
  v7 = 0xA00000001LL;
  v9 = 0;
  v8[1] = 20;
  v8[2] = 0x1E00000015LL;
  do
  {
    if ( pthread_create((pthread_t *)&v10[v0], 0, (void *(*)(void *))thread_sum, v1) )
      return (unsigned int)-1;
    v1 = (__int64 *)((char *)v1 + 12);
    v0 += 8;
  }
  while ( v0 != 24 );
  v2 = 0;
  v3 = 0;
  v4 = (int *)v8;
  while ( !pthread_join(*(_QWORD *)&v10[v2], 0) )
  {
    v5 = *v4;
    v4 += 3;
    v2 += 8;
    v3 += v5;
    if ( v2 == 24 )
      return v3;
  }
  return (unsigned int)-2;
}


/* Function: call_pthread_join @ 0x2970 */
__int64 call_pthread_join()
{
  __int64 v0; // x21
  __int64 *v1; // x19
  __int64 v2; // x20
  unsigned int v3; // w19
  int *v4; // x21
  int v5; // t1
  __int64 v7; // [xsp+0h] [xbp-40h] BYREF
  _QWORD v8[3]; // [xsp+8h] [xbp-38h] BYREF
  int v9; // [xsp+20h] [xbp-20h]
  _BYTE v10[24]; // [xsp+28h] [xbp-18h] BYREF

  v0 = 0;
  v1 = &v7;
  v8[0] = 0xB00000000LL;
  v7 = 0xA00000001LL;
  v9 = 0;
  v8[1] = 20;
  v8[2] = 0x1E00000015LL;
  do
  {
    if ( pthread_create((pthread_t *)&v10[v0], 0, (void *(*)(void *))thread_sum, v1) )
      return (unsigned int)-1;
    v0 += 8;
    v1 = (__int64 *)((char *)v1 + 12);
  }
  while ( v0 != 24 );
  v2 = 0;
  v3 = 0;
  v4 = (int *)v8;
  while ( !pthread_join(*(_QWORD *)&v10[v2], 0) )
  {
    v5 = *v4;
    v4 += 3;
    v2 += 8;
    v3 += v5;
    if ( v2 == 24 )
      return v3;
  }
  return (unsigned int)-2;
}


/* Function: thread_increment @ 0x2A50 */
__int64 __fastcall thread_increment(int *a1)
{
  int v1; // w20

  v1 = *a1;
  if ( *a1 >= 1 )
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


/* Function: param_mutex_lock @ 0x2AB8 */
__int64 __fastcall param_mutex_lock(int a1, int a2)
{
  pthread_t *v3; // x0
  pthread_t *v4; // x20
  __int64 v5; // x23
  __int64 v6; // x21
  pthread_t *v7; // x23
  pthread_t v8; // t1
  int arg; // [xsp+Ch] [xbp-4h] BYREF

  arg = a2;
  v3 = (pthread_t *)malloc(8LL * a1);
  if ( !v3 )
    return 0xFFFFFFFFLL;
  v4 = v3;
  shared_counter = 0;
  if ( a1 < 1 )
  {
LABEL_6:
    if ( a1 >= 1 )
    {
      v6 = (unsigned int)a1;
      v7 = v4;
      do
      {
        v8 = *v7++;
        pthread_join(v8, 0);
        --v6;
      }
      while ( v6 );
    }
    free(v4);
    if ( shared_counter == arg * a1 )
      return 42;
    else
      return 4294967293LL;
  }
  else
  {
    v5 = 0;
    while ( !pthread_create(&v4[v5], 0, (void *(*)(void *))thread_increment, &arg) )
    {
      if ( a1 == ++v5 )
        goto LABEL_6;
    }
    free(v4);
    return 4294967294LL;
  }
}


/* Function: call_mutex_lock @ 0x2BA8 */
__int64 call_mutex_lock()
{
  return param_mutex_lock(4, 1000);
}


/* Function: consumer_thread @ 0x2BC4 */
_DWORD *consumer_thread()
{
  int v0; // w19
  _DWORD *result; // x0

  pthread_mutex_lock(&cond_mutex);
  if ( (ready & 1) == 0 )
  {
    do
      pthread_cond_wait(&cond, &cond_mutex);
    while ( ready != 1 );
  }
  if ( data )
    v0 = 42;
  else
    v0 = 0;
  pthread_mutex_unlock(&cond_mutex);
  result = malloc(4u);
  *result = v0;
  return result;
}


/* Function: producer_thread @ 0x2C50 */
__int64 producer_thread()
{
  sleep(1u);
  pthread_mutex_lock(&cond_mutex);
  data = 1;
  ready = 1;
  pthread_cond_signal(&cond);
  pthread_mutex_unlock(&cond_mutex);
  return 0;
}


/* Function: param_condition_variable @ 0x2CAC */
__int64 param_condition_variable()
{
  unsigned int v0; // w19
  void *ptr; // [xsp+0h] [xbp-10h] BYREF
  pthread_t newthread; // [xsp+8h] [xbp-8h] BYREF
  pthread_t th; // [xsp+28h] [xbp+18h] BYREF

  ready = 0;
  data = 0;
  if ( pthread_create(&newthread, 0, (void *(*)(void *))consumer_thread, 0) )
  {
    return (unsigned int)-1;
  }
  else if ( pthread_create(&th, 0, (void *(*)(void *))producer_thread, 0) )
  {
    pthread_cancel(newthread);
    return (unsigned int)-2;
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


/* Function: call_condition_variable @ 0x2D54 */
__int64 call_condition_variable()
{
  return param_condition_variable();
}


/* Function: thread_atomic_increment @ 0x2D68 */
__int64 __fastcall thread_atomic_increment(int *a1)
{
  int v1; // w21
  unsigned int v2; // w19

  v1 = *a1;
  if ( *a1 >= 1 )
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


/* Function: thread_atomic_load_store @ 0x2DCC */
__int64 thread_atomic_load_store()
{
  __int64 result; // x0
  unsigned int v1; // w9

  result = 0;
  v1 = atomic_load((unsigned int *)&atomic_counter);
  atomic_store(v1 + 100, (unsigned int *)&atomic_counter);
  return result;
}


/* Function: param_atomic_ops @ 0x2DE8 */
__int64 __fastcall param_atomic_ops(int a1, int a2)
{
  __int64 v2; // x20
  pthread_t *v3; // x0
  pthread_t *v4; // x19
  __int64 v5; // x23
  pthread_t *v6; // x21
  pthread_t v7; // t1
  int v8; // w20
  pthread_t th; // [xsp+0h] [xbp-10h] BYREF
  int arg; // [xsp+Ch] [xbp-4h] BYREF

  LODWORD(v2) = a1;
  arg = a2;
  v3 = (pthread_t *)malloc(8LL * a1);
  if ( !v3 )
    return 0xFFFFFFFFLL;
  v4 = v3;
  atomic_store(0, (unsigned int *)&atomic_counter);
  if ( (int)v2 < 1 )
  {
LABEL_6:
    if ( !pthread_create(&th, 0, (void *(*)(void *))thread_atomic_load_store, 0) )
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
      return 4294967293LL;
    else
      return 42;
  }
  else
  {
    v5 = 0;
    while ( !pthread_create(&v4[v5], 0, (void *(*)(void *))thread_atomic_increment, &arg) )
    {
      if ( (unsigned int)v2 == ++v5 )
        goto LABEL_6;
    }
    free(v4);
    return 4294967294LL;
  }
}


/* Function: call_atomic_ops @ 0x2EFC */
__int64 call_atomic_ops()
{
  return param_atomic_ops(4, 500);
}


/* Function: thread_tls_test @ 0x2F18 */
_DWORD *__fastcall thread_tls_test(char *src)
{
  unsigned __int64 StatusReg; // x8
  int v2; // w19
  _DWORD *result; // x0

  StatusReg = _ReadStatusReg(TPIDR_EL0);
  v2 = *(_DWORD *)(StatusReg + 16);
  *(_DWORD *)(StatusReg + 16) = v2 + 50;
  strncpy((char *)(StatusReg + 20), src, 0x1Fu);
  result = malloc(8u);
  *result = v2;
  result[1] = v2 + 50;
  return result;
}


/* Function: param_thread_local_storage @ 0x2F68 */
__int64 __fastcall param_thread_local_storage(int a1)
{
  size_t v2; // x21
  pthread_t *v3; // x19
  void **v4; // x21
  __int64 result; // x0
  __int64 i; // x22
  char *v7; // x0
  __int64 v8; // x24
  pthread_t *v9; // x22
  int v11; // w23
  int v12; // w22
  __int64 v13; // x24
  pthread_t *v14; // x25
  void **v15; // x26
  pthread_t v16; // t1
  void *v17; // t1
  __int64 v18; // x20
  void *thread_return; // [xsp+8h] [xbp-8h] BYREF

  v2 = 8LL * a1;
  v3 = (pthread_t *)malloc(v2);
  v4 = (void **)malloc(v2);
  result = 0xFFFFFFFFLL;
  if ( v3 && v4 )
  {
    if ( a1 >= 1 )
    {
      for ( i = 0; i != a1; snprintf(v7, 0x10u, "Thread-%d", i++) )
      {
        v7 = (char *)malloc(0x10u);
        v4[i] = v7;
      }
    }
    if ( a1 < 1 )
    {
LABEL_10:
      if ( a1 < 1 )
      {
        v12 = 0;
        v11 = 0;
      }
      else
      {
        v11 = 0;
        v12 = 0;
        v13 = (unsigned int)a1;
        v14 = v3;
        v15 = v4;
        do
        {
          v16 = *v14++;
          pthread_join(v16, &thread_return);
          v12 += *(_DWORD *)thread_return;
          v11 += *((_DWORD *)thread_return + 1);
          free(thread_return);
          v17 = *v15++;
          free(v17);
          --v13;
        }
        while ( v13 );
      }
      free(v4);
      free(v3);
      if ( v11 == 150 * a1 && v12 == 100 * a1 )
        return 42;
      else
        return 4294967293LL;
    }
    else
    {
      v8 = 0;
      v9 = v3;
      while ( !pthread_create(v9, 0, (void *(*)(void *))thread_tls_test, v4[v8++]) )
      {
        ++v9;
        if ( a1 == v8 )
          goto LABEL_10;
      }
      v18 = 0;
      do
        free(v4[v18++]);
      while ( v8 != v18 );
      free(v4);
      free(v3);
      return 4294967294LL;
    }
  }
  return result;
}


/* Function: call_thread_local_storage @ 0x310C */
__int64 call_thread_local_storage()
{
  return param_thread_local_storage(4);
}


/* Function: test_thread_concurrency @ 0x3124 */
__int64 test_thread_concurrency()
{
  unsigned int v0; // w19
  __int64 v1; // x21
  pthread_t *v2; // x19
  __int64 v3; // x20
  unsigned int v4; // w19
  pthread_t *v5; // x21
  int v6; // t1
  unsigned int v7; // w0
  unsigned int v8; // w0
  unsigned int v9; // w0
  unsigned int v10; // w0
  int arg; // [xsp+Ch] [xbp-44h] BYREF
  pthread_t newthread[2]; // [xsp+10h] [xbp-40h] BYREF
  __int64 v14; // [xsp+20h] [xbp-30h]
  __int64 v15; // [xsp+28h] [xbp-28h]
  int v16; // [xsp+30h] [xbp-20h]
  void *thread_return[3]; // [xsp+38h] [xbp-18h] BYREF

  puts(asc_372B);
  arg = 7;
  if ( pthread_create(newthread, 0, (void *(*)(void *))thread_compute, &arg) )
  {
    v0 = -1;
  }
  else
  {
    pthread_join(newthread[0], thread_return);
    v0 = *(_DWORD *)thread_return[0];
    free(thread_return[0]);
  }
  printf(aThrL301D, v0);
  v1 = 0;
  v2 = newthread;
  newthread[1] = 0xB00000000LL;
  newthread[0] = 0xA00000001LL;
  v16 = 0;
  v14 = 20;
  v15 = 0x1E00000015LL;
  do
  {
    if ( pthread_create((pthread_t *)&thread_return[v1], 0, (void *(*)(void *))thread_sum, v2) )
    {
      v4 = -1;
      goto LABEL_13;
    }
    ++v1;
    v2 = (pthread_t *)((char *)v2 + 12);
  }
  while ( v1 != 3 );
  v3 = 0;
  v4 = 0;
  v5 = &newthread[1];
  while ( !pthread_join((pthread_t)thread_return[v3], 0) )
  {
    v6 = *(_DWORD *)v5;
    v5 = (pthread_t *)((char *)v5 + 12);
    ++v3;
    v4 += v6;
    if ( v3 == 3 )
      goto LABEL_13;
  }
  v4 = -2;
LABEL_13:
  printf(aThrL302D, v4);
  v7 = param_mutex_lock(4, 1000);
  printf(aThrL303D, v7);
  v8 = param_condition_variable();
  printf(aThrL304D, v8);
  v9 = param_atomic_ops(4, 500);
  printf(aThrL305D, v9);
  v10 = param_thread_local_storage(4);
  return printf(aThrL306D, v10);
}


/* Function: main @ 0x32D4 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_standard_library_functions();
  test_system_calls();
  test_thread_concurrency();
  return 0;
}


/* Function: __aarch64_cas4_acq_rel @ 0x3300 */
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


/* Function: __aarch64_ldadd4_acq_rel @ 0x3340 */
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


/* Function: .term_proc @ 0x3370 */
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

/* FAILED to decompile: rewind @ 0x15418 */

/* FAILED to decompile: close @ 0x15420 */

/* FAILED to decompile: stat @ 0x15428 */

/* FAILED to decompile: write @ 0x15430 */

/* FAILED to decompile: __getauxval @ 0x15438 */

/* FAILED to decompile: abort @ 0x15440 */

/* FAILED to decompile: puts @ 0x15448 */

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
