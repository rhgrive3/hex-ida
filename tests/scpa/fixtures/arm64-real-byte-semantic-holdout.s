.text
.p2align 2
.globl arithmetic_wrap
.type arithmetic_wrap,@function
arithmetic_wrap:
  mov w0, #-1
  add w0, w0, #1
  ret
.size arithmetic_wrap, .-arithmetic_wrap

.p2align 2
.globl conditional_value
.type conditional_value,@function
conditional_value:
  cmp x0, #0
  b.eq .Lcond_zero
  add x0, x0, #1
  b .Lcond_done
.Lcond_zero:
  sub x0, x0, #1
.Lcond_done:
  ret
.size conditional_value, .-conditional_value

.p2align 2
.globl memory_forward
.type memory_forward,@function
memory_forward:
  sub sp, sp, #16
  str x0, [sp]
  ldr x1, [sp]
  add x0, x1, #2
  add sp, sp, #16
  ret
.size memory_forward, .-memory_forward

.p2align 2
.globl direct_call
.type direct_call,@function
direct_call:
  stp x29, x30, [sp, #-16]!
  mov x29, sp
  mov x0, x1
  mov x1, x2
  bl add_pair
  add x0, x0, #1
  ldp x29, x30, [sp], #16
  ret
.size direct_call, .-direct_call

.p2align 2
.globl add_pair
.type add_pair,@function
add_pair:
  add x0, x0, x1
  ret
.size add_pair, .-add_pair

.p2align 2
.globl unsupported_pair_exclusive
.type unsupported_pair_exclusive,@function
unsupported_pair_exclusive:
  ldaxp x0, x1, [x2]
  ret
.size unsupported_pair_exclusive, .-unsupported_pair_exclusive
