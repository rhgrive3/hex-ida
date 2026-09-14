.text
.global _start
.type _start, %function
_start:
  nop
  add x0, x0, #1
  b _start
.size _start, .-_start

.data
.global probe_word
.type probe_word, %object
.p2align 3
probe_word:
  .xword 0x1020304050607080
.size probe_word, 8
