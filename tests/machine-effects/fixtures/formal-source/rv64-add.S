.section .text
.globl _start
_start:
  addi x1, x0, 5
  addi x2, x0, 3
  add x5, x1, x2
  addi a0, x5, 0
  addi a7, x0, 93
  ecall
