package scopedmicro
//go:noinline
func ClosureCapture(value uint64) func() uint64 { return func() uint64 { return value } }
