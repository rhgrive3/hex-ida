.text
.globl entry
.type entry,@function
entry:
 stp x29, x30, [sp, #-32]!
 mov x29, sp
 mov x9, #0x1ff0
 add x9, x9, #0x10
 str x9, [sp, #16]
 ldr x0, [sp, #16]
 bl .Lcallee
 str x0, [sp, #16]
 ldr x0, [sp, #16]
 ldp x29, x30, [sp], #32
 ret
.size entry, .-entry
.globl callee
.type callee,@function
callee:
.Lcallee:
 add x0, x0, #1
 ret
.size callee, .-callee
.globl copy_word
.type copy_word,@function
copy_word:
 ldr x9, [x0]
 str x9, [x1]
 ret
.size copy_word, .-copy_word
