// Independent native observations, not a C reimplementation of the lifter.
// Build with -mno-red-zone: PUSHF/POPF below must not overwrite compiler spills.
// Never run without checking CPUID; missing hardware support is a hard failure.
#include <cpuid.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

#define EXECUTE(BYTES) __asm__ volatile( \
    "pushfq\n\tpopq %%r11\n\tpushq %[wanted]\n\tpopfq\n\t" \
    "pushfq\n\tpopq %[before]\n\t" BYTES "\n\t" \
    "pushfq\n\tpopq %[after]\n\tpushq %%r11\n\tpopfq" \
    : "+a"(rax), [before] "=&r"(before), [after] "=&r"(after) \
    : [wanted] "r"(wanted) : "r11", "cc", "memory")
#define PREFIX_CASES(OP) \
    case 0: EXECUTE(".byte " OP); break; \
    case 0x26: EXECUTE(".byte 0x26," OP); break; \
    case 0x2e: EXECUTE(".byte 0x2e," OP); break; \
    case 0x36: EXECUTE(".byte 0x36," OP); break; \
    case 0x3e: EXECUTE(".byte 0x3e," OP); break; \
    case 0x40: EXECUTE(".byte 0x40," OP); break; \
    case 0x41: EXECUTE(".byte 0x41," OP); break; \
    case 0x42: EXECUTE(".byte 0x42," OP); break; \
    case 0x43: EXECUTE(".byte 0x43," OP); break; \
    case 0x44: EXECUTE(".byte 0x44," OP); break; \
    case 0x45: EXECUTE(".byte 0x45," OP); break; \
    case 0x46: EXECUTE(".byte 0x46," OP); break; \
    case 0x47: EXECUTE(".byte 0x47," OP); break; \
    case 0x48: EXECUTE(".byte 0x48," OP); break; \
    case 0x49: EXECUTE(".byte 0x49," OP); break; \
    case 0x4a: EXECUTE(".byte 0x4a," OP); break; \
    case 0x4b: EXECUTE(".byte 0x4b," OP); break; \
    case 0x4c: EXECUTE(".byte 0x4c," OP); break; \
    case 0x4d: EXECUTE(".byte 0x4d," OP); break; \
    case 0x4e: EXECUTE(".byte 0x4e," OP); break; \
    case 0x4f: EXECUTE(".byte 0x4f," OP); break

static void observe(unsigned store, unsigned prefix, uint64_t initial, uint64_t wanted) {
    uint64_t rax = initial, before, after;
    if (store) {
        switch (prefix) { PREFIX_CASES("0x9e"); default: return; }
    } else {
        switch (prefix) { PREFIX_CASES("0x9f"); default: return; }
    }
    printf("{\"family\":\"%s\",\"prefix\":%u,\"initial\":\"0x%016" PRIx64
           "\",\"before\":\"0x%016" PRIx64 "\",\"rax\":\"0x%016" PRIx64
           "\",\"after\":\"0x%016" PRIx64 "\"}\n",
           store ? "sahf" : "lahf", prefix, initial, before, rax, after);
}

int main(void) {
    unsigned eax, ebx, ecx, edx;
    if (!__get_cpuid(0x80000001, &eax, &ebx, &ecx, &edx) || !(ecx & 1)) {
        fprintf(stderr, "native LAHF/SAHF in long mode unavailable\n");
        return 1;
    }
    unsigned feature = ecx;
    __cpuid(0, eax, ebx, ecx, edx);
    char vendor[13];
    __builtin_memcpy(vendor, &ebx, 4);
    __builtin_memcpy(vendor + 4, &edx, 4);
    __builtin_memcpy(vendor + 8, &ecx, 4);
    vendor[12] = 0;
    __cpuid(1, eax, ebx, ecx, edx);
    printf("{\"schema\":\"x86-lahf-sahf-native/v2\",\"vendor\":\"%s\",\"signature\":%u,\"hypervisor\":%s,\"extendedEcx\":%u,\"compiler\":\"%s\"}\n",
           vendor, eax, (ecx >> 31) ? "true" : "false", feature, __VERSION__);
    uint64_t baseline;
    __asm__ volatile("pushfq\n\tpopq %0" : "=r"(baseline));
    const uint64_t seeds[] = { UINT64_C(0x0123456789abcdef), UINT64_C(0xfedcba9876543210) };
    const unsigned prefixes[] = { 0, 0x26, 0x2e, 0x36, 0x3e,
        0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
        0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f };
    for (unsigned store = 0; store < 2; store++)
    for (unsigned p = 0; p < sizeof(prefixes) / sizeof(prefixes[0]); p++)
    for (unsigned seed = 0; seed < 2; seed++)
    for (unsigned byte = 0; byte < (store ? 256u : 32u); byte++)
    for (unsigned extra = 0; extra < 4; extra++)
    for (unsigned prior = 0; prior < (store ? 2u : 1u); prior++) {
        uint64_t low = store ? (prior ? 0xd5u : 0u)
            : ((byte & 1u) | ((byte & 2u) << 1) | ((byte & 4u) << 2)
               | ((byte & 8u) << 3) | ((byte & 16u) << 3));
        uint64_t wanted = (baseline & ~UINT64_C(0xcd5)) | low | ((uint64_t)extra << 10);
        uint64_t initial = store ? ((seeds[seed] & ~UINT64_C(0xff00)) | ((uint64_t)byte << 8)) : seeds[seed];
        observe(store, prefixes[p], initial, wanted);
    }
    return ferror(stdout) ? 1 : 0;
}
