.text
.globl entry
.type entry,@function
entry:
 stp x29, x30, [sp, #-16]!
 mov x9, #0x1080
 and x10, x0, #1
 lsl x10, x10, #3
 add x9, x9, x10
 ldr x11, [x9]
 blr x11
 ldp x29, x30, [sp], #16
 ret
.size entry, .-entry
.p2align 4
.globl callee
.type callee,@function
callee:
 add x0, x0, #1
 ret
.size callee, .-callee
.globl copy_word
.type copy_word,@function
copy_word:
 sub x0, x0, #1
 ret
.size copy_word, .-copy_word
.org 0x80
 .quad 0x1030
 .quad 0x1038
