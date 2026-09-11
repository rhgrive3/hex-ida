// GNU Binutils 2.38 aarch64-linux-gnu-as/ld --eh-frame-hdr
// .cfi_b_key_frame -> CIE augmentation 'B' (PAC B-key), issue #4255.
	.arch armv8-a
	.text
	.globl	_bkey_fn
	.p2align 2
	.type	_bkey_fn,%function
_bkey_fn:
	.cfi_startproc
	.cfi_b_key_frame
	.cfi_def_cfa x29, 16
	.cfi_offset x30, -8
	stp	x29, x30, [sp, #-16]!
	mov	x29, sp
	mov	w0, wzr
	ldp	x29, x30, [sp], #16
	ret
	.cfi_endproc
	.size	_bkey_fn, .-_bkey_fn
