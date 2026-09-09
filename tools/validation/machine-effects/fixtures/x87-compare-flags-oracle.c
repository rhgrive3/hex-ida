/* Bounded native oracle: finite negative operands, normal execution only.
 * GCC x86-64: -O2 -Wall -Wextra -Werror -mno-red-zone
 * PUSHFQ/POPFQ need no-red-zone because this is inline assembly.
 * No claim covers NaNs, exceptions, or numerical x87 arithmetic results.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

struct observation { uint64_t flags; uint16_t before, after; };

#define COMPARISON(name, instruction) \
static struct observation name(double left, double right) { \
    struct observation result; \
    __asm__ volatile ( \
        "fninit\n\t" \
        "fldl %[right]\n\t" \
        "fldl %[left]\n\t" \
        "fxam\n\t" \
        "fnstsw %[before]\n\t" \
        "pushfq\n\tpopq %%rax\n\t" \
        "orq $0x8d5, %%rax\n\t" \
        "pushq %%rax\n\tpopfq\n\t" \
        instruction " %%st(1), %%st(0)\n\t" \
        "pushfq\n\tpopq %[flags]\n\t" \
        "fnstsw %[after]\n\t" \
        "fninit\n\t" \
        : [flags] "=r" (result.flags), [before] "=m" (result.before), \
          [after] "=m" (result.after) \
        : [left] "m" (left), [right] "m" (right) \
        : "rax", "cc", "memory", "st", "st(1)", "st(2)", "st(3)", \
          "st(4)", "st(5)", "st(6)", "st(7)"); \
    return result; \
}

COMPARISON(compare_fcomi, "fcomi")
COMPARISON(compare_fcomip, "fcomip")
COMPARISON(compare_fucomi, "fucomi")
COMPARISON(compare_fucomip, "fucomip")

/* Ordinary FCOM has implicit ST(0). Preserve the same seeding/capture
 * sequence as the FCOMI probes, but independently test C1 clearing.
 */
static struct observation compare_fcom_control(double left, double right) {
    struct observation result;
    __asm__ volatile (
        "fninit\n\tfldl %[right]\n\tfldl %[left]\n\t"
        "fxam\n\tfnstsw %[before]\n\t"
        "pushfq\n\tpopq %%rax\n\torq $0x8d5, %%rax\n\tpushq %%rax\n\tpopfq\n\t"
        "fcom %%st(1)\n\t"
        "pushfq\n\tpopq %[flags]\n\tfnstsw %[after]\n\tfninit\n\t"
        : [flags] "=r" (result.flags), [before] "=m" (result.before),
          [after] "=m" (result.after)
        : [left] "m" (left), [right] "m" (right)
        : "rax", "cc", "memory", "st", "st(1)", "st(2)", "st(3)",
          "st(4)", "st(5)", "st(6)", "st(7)");
    return result;
}

int main(int argc, char **argv) {
    /* Do not silently switch a failed SDM oracle to a hardware reference.
     * Both invocations must be recorded; this preserves the discrepancy.
     * Independent corroboration for hardware C1 preservation:
     * https://www.mail-archive.com/qemu-devel@nongnu.org/msg1222232.html
     */
    if (argc != 2 || (strcmp(argv[1], "--reference=intel-sdm") != 0
        && strcmp(argv[1], "--reference=observed-hardware") != 0)) {
        fprintf(stderr, "choose --reference=intel-sdm or --reference=observed-hardware\n");
        return 2;
    }
    const int sdm_reference = strcmp(argv[1], "--reference=intel-sdm") == 0;
    const double pairs[][2] = {{-1.0, -2.0}, {-2.0, -1.0}, {-1.0, -1.0}};
    struct observation (*const comparisons[])(double, double) = {
        compare_fcomi, compare_fcomip, compare_fucomi, compare_fucomip,
    };
    unsigned cases = 0, failures = 0;
    for (unsigned op = 0; op < 4; ++op) {
        for (unsigned pair = 0; pair < 3; ++pair) {
            const double left = pairs[pair][0], right = pairs[pair][1];
            const uint64_t expected = left < right ? 1 : left == right ? 0x40 : 0;
            const struct observation actual = comparisons[op](left, right);
            /* FXAM on negative ST(0) supplies C1=1 before the comparison.
             * C0/C2/C3 must be preserved; all arithmetic flags started set.
             */
            if ((actual.flags & 0x8d5) != expected || !(actual.before & 0x200)
                || (actual.after & 0x200) != (sdm_reference ? 0 : 0x200)
                || (actual.before & 0x4500) != (actual.after & 0x4500)) {
                fprintf(stderr, "x87 compare oracle: FAIL op=%u pair=%u flags=%llx expected=%llx before=%x after=%x\n",
                    op, pair, (unsigned long long)actual.flags, (unsigned long long)expected,
                    actual.before, actual.after);
                ++failures;
            }
            ++cases;
        }
    }
    for (unsigned pair = 0; pair < 3; ++pair) {
        const double left = pairs[pair][0], right = pairs[pair][1];
        const unsigned expected = left < right ? 0x100 : left == right ? 0x4000 : 0;
        const struct observation actual = compare_fcom_control(left, right);
        if ((actual.flags & 0x8d5) != 0x8d5 || !(actual.before & 0x200)
            || (actual.after & 0x4700) != expected) {
            fprintf(stderr, "FCOM control: FAIL pair=%u flags=%llx before=%x after=%x\n",
                pair, (unsigned long long)actual.flags, actual.before, actual.after);
            ++failures;
        }
        ++cases;
    }
    printf("x87 compare flags oracle: %s (%s, %u finite cases including 3 FCOM controls, %u divergences)\n",
        failures ? "FAIL" : "PASS", argv[1], cases, failures);
    return failures ? 1 : 0;
}
