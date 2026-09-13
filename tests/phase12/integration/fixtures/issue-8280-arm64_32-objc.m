__attribute__((objc_root_class))
@interface Foo { @public int _count; }
@property(nonatomic) int count;
- (int)value;
@end
@implementation Foo
@synthesize count = _count;
- (int)value { return 42; }
@end
@protocol Proto
@property(nonatomic, readonly) int p;
- (int)p;
@end
@interface Foo (Cat) <Proto>
@end
@implementation Foo (Cat)
- (int)p { return 7; }
@end
