.text
.global _start
.type _start, @function
_start:
  nop
  addi a0, a0, 1
  j _start
.size _start, .-_start

.data
.global probe_word
.type probe_word, @object
.p2align 3
probe_word:
  .dword 0x1020304050607080
.size probe_word, 8
