.section .text
.global _start
_start:
  mov x1, #5
  mov x2, #3
  adds x0, x1, x2
  mov x8, #93
  svc #0
