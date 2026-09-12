// Native architectural observations. Compile with -mno-red-zone because the
// flag snapshots use PUSHF/POPF. This is not an entropy/security-quality test.
#include <cpuid.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

#define EXECUTE(BYTES) __asm__ volatile( \
  "pushfq\n\tpopq %%r11\n\tpushq %[wanted]\n\tpopfq\n\t" \
  "pushfq\n\tpopq %[before]\n\t" BYTES "\n\t" \
  "pushfq\n\tpopq %[after]\n\tpushq %%r11\n\tpopfq" \
  : "+a"(rax), "+r"(r8), [before] "=&r"(before), [after] "=&r"(after) \
  : [wanted] "r"(wanted) : "r11", "cc", "memory")

int main(void) {
  unsigned a,b,c,d;
  if (!__get_cpuid(1,&a,&b,&c,&d) || !(c & (1u<<30))) return 1;
  unsigned leaf1=c, signature=a;
  if (!__get_cpuid_count(7,0,&a,&b,&c,&d) || !(b & (1u<<18))) return 1;
  unsigned leaf7=b;
  __cpuid(0,a,b,c,d);
  char vendor[13];
  __builtin_memcpy(vendor,&b,4); __builtin_memcpy(vendor+4,&d,4); __builtin_memcpy(vendor+8,&c,4); vendor[12]=0;
  printf("{\"schema\":\"x86-random-native/v1\",\"vendor\":\"%s\",\"signature\":%u,\"leaf1Ecx\":%u,\"leaf7Ebx\":%u,\"compiler\":\"%s\"}\n",
    vendor,signature,leaf1,leaf7,__VERSION__);
  uint64_t baseline;
  __asm__ volatile("pushfq\n\tpopq %0" : "=r"(baseline));
  for (unsigned encoding=0;encoding<12;encoding++) for (unsigned iteration=0;iteration<128;iteration++) {
    uint64_t initial=iteration&1 ? UINT64_C(0xfedcba9876543210) : UINT64_C(0x0123456789abcdef);
    uint64_t wanted=baseline & ~UINT64_C(0xcd5);
    const unsigned positions[]={0,2,4,6,7,11};
    for (unsigned bit=0;bit<6;bit++) wanted |= (uint64_t)((iteration>>bit)&1) << positions[bit];
    wanted |= (uint64_t)(iteration&1) << 10;
    uint64_t rax=initial,before,after;
    register uint64_t r8 __asm__("r8")=initial;
    switch(encoding) {
      case 0: EXECUTE(".byte 0x66,0x0f,0xc7,0xf0"); break;
      case 1: EXECUTE(".byte 0x0f,0xc7,0xf0"); break;
      case 2: EXECUTE(".byte 0x48,0x0f,0xc7,0xf0"); break;
      case 3: EXECUTE(".byte 0x66,0x41,0x0f,0xc7,0xf0"); break;
      case 4: EXECUTE(".byte 0x41,0x0f,0xc7,0xf0"); break;
      case 5: EXECUTE(".byte 0x49,0x0f,0xc7,0xf0"); break;
      case 6: EXECUTE(".byte 0x66,0x0f,0xc7,0xf8"); break;
      case 7: EXECUTE(".byte 0x0f,0xc7,0xf8"); break;
      case 8: EXECUTE(".byte 0x48,0x0f,0xc7,0xf8"); break;
      case 9: EXECUTE(".byte 0x66,0x41,0x0f,0xc7,0xf8"); break;
      case 10: EXECUTE(".byte 0x41,0x0f,0xc7,0xf8"); break;
      case 11: EXECUTE(".byte 0x49,0x0f,0xc7,0xf8"); break;
      default: return 1;
    }
    printf("{\"encoding\":%u,\"iteration\":%u,\"initial\":\"0x%016" PRIx64
      "\",\"before\":\"0x%016" PRIx64 "\",\"rax\":\"0x%016" PRIx64
      "\",\"r8\":\"0x%016" PRIx64 "\",\"after\":\"0x%016" PRIx64 "\"}\n",
      encoding,iteration,initial,before,rax,r8,after);
  }
  return ferror(stdout) ? 1 : 0;
}
