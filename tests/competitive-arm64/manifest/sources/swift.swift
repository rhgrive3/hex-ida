public protocol ScopedValue { func read() -> UInt64 }
@inline(never) public func witnessOpen<T: ScopedValue>(_ receiver: T) -> UInt64 { receiver.read() }
