.text
.globl entry
.type entry,@function
entry:
 mov x9, #0x1ff0
 add x9, x9, #0x10
 str x9, [sp]
 ret
.size entry, .-entry
.globl callee
.type callee,@function
callee:
 add x0, x0, #1
 ret
.size callee, .-callee
