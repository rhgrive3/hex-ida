.text
.global _start
.type _start, @function
_start:
  nop
  inc %rax
  jmp _start
.size _start, .-_start

.data
.global probe_word
.type probe_word, @object
.p2align 3
probe_word:
  .quad 0x1020304050607080
.size probe_word, 8
