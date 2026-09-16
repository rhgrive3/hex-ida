#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import <ptrauth.h>
#import <sys/utsname.h>

#ifndef HEX_F47_BUILD_SHA
#define HEX_F47_BUILD_SHA "unknown"
#endif

static NSString *machineIdentifier(void) {
  struct utsname u;
  if (uname(&u) != 0) return @"unknown";
  return [NSString stringWithUTF8String:u.machine] ?: @"unknown";
}

static NSDictionary *runPACProbe(void) {
#if defined(__arm64e__) && __has_feature(ptrauth_calls)
  static uint64_t payload = 0x484558463437ULL;
  void *raw = &payload;
  const uintptr_t discriminator = 0x5846323437ULL;
  void *signedPtr = ptrauth_sign_unauthenticated(raw, ptrauth_key_process_independent_data, discriminator);
  void *authenticated = ptrauth_auth_data(signedPtr, ptrauth_key_process_independent_data, discriminator);
  void *stripped = ptrauth_strip(signedPtr, ptrauth_key_process_independent_data);

  NSUInteger rejected = 0;
  for (uintptr_t delta = 1; delta <= 8; delta++) {
    void *wrongAuth = ptrauth_auth_data(signedPtr, ptrauth_key_process_independent_data, discriminator ^ delta);
    if (wrongAuth != raw) rejected++;
  }

  const BOOL signedDiffers = signedPtr != raw;
  const BOOL stripRestores = stripped == raw;
  const BOOL authRestores = authenticated == raw;
  const BOOL wrongDiscriminatorsRejected = rejected == 8;
  const BOOL pass = stripRestores && authRestores && wrongDiscriminatorsRejected;

  NSDateFormatter *formatter = [NSDateFormatter new];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss'Z'";

  return @{
    @"schema": @"hex-x02-f47-pac-runtime/v1",
    @"buildCommit": @HEX_F47_BUILD_SHA,
    @"capturedAtUtc": [formatter stringFromDate:[NSDate date]],
    @"architecture": @"arm64e",
    @"deviceMachine": machineIdentifier(),
    @"osVersion": UIDevice.currentDevice.systemVersion ?: @"unknown",
    @"ptrauthCompileSupport": @YES,
    @"signedPointerChanged": @(signedDiffers),
    @"stripRestoredOriginal": @(stripRestores),
    @"correctAuthenticationRestoredOriginal": @(authRestores),
    @"wrongDiscriminatorTrials": @8,
    @"wrongDiscriminatorsRejected": @(rejected),
    @"classification": pass ? @"pass" : @"fail"
  };
#else
  return @{
    @"schema": @"hex-x02-f47-pac-runtime/v1",
    @"buildCommit": @HEX_F47_BUILD_SHA,
    @"architecture": @"not-arm64e",
    @"deviceMachine": machineIdentifier(),
    @"osVersion": UIDevice.currentDevice.systemVersion ?: @"unknown",
    @"ptrauthCompileSupport": @NO,
    @"classification": @"fail"
  };
#endif
}

@interface F47ViewController : UIViewController
@property(nonatomic, strong) UITextView *textView;
@end

@implementation F47ViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemBackgroundColor;
  self.title = @"HEX F47 PAC Probe";

  UILabel *heading = [UILabel new];
  heading.translatesAutoresizingMaskIntoConstraints = NO;
  heading.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  heading.numberOfLines = 0;
  heading.text = @"X-02 F47 / iPad real-device PAC check";

  self.textView = [UITextView new];
  self.textView.translatesAutoresizingMaskIntoConstraints = NO;
  self.textView.editable = NO;
  self.textView.selectable = YES;
  self.textView.font = [UIFont monospacedSystemFontOfSize:13 weight:UIFontWeightRegular];

  UIButton *run = [UIButton buttonWithType:UIButtonTypeSystem];
  run.translatesAutoresizingMaskIntoConstraints = NO;
  [run setTitle:@"Run PAC test" forState:UIControlStateNormal];
  [run addTarget:self action:@selector(runProbe) forControlEvents:UIControlEventTouchUpInside];

  UIButton *copy = [UIButton buttonWithType:UIButtonTypeSystem];
  copy.translatesAutoresizingMaskIntoConstraints = NO;
  [copy setTitle:@"Copy JSON" forState:UIControlStateNormal];
  [copy addTarget:self action:@selector(copyResult) forControlEvents:UIControlEventTouchUpInside];

  UIStackView *buttons = [[UIStackView alloc] initWithArrangedSubviews:@[run, copy]];
  buttons.translatesAutoresizingMaskIntoConstraints = NO;
  buttons.axis = UILayoutConstraintAxisHorizontal;
  buttons.spacing = 16;
  buttons.distribution = UIStackViewDistributionFillEqually;

  [self.view addSubview:heading];
  [self.view addSubview:self.textView];
  [self.view addSubview:buttons];

  [NSLayoutConstraint activateConstraints:@[
    [heading.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:20],
    [heading.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
    [heading.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
    [buttons.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
    [buttons.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
    [buttons.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor constant:-20],
    [buttons.heightAnchor constraintEqualToConstant:48],
    [self.textView.topAnchor constraintEqualToAnchor:heading.bottomAnchor constant:16],
    [self.textView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
    [self.textView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
    [self.textView.bottomAnchor constraintEqualToAnchor:buttons.topAnchor constant:-16]
  ]];

  [self runProbe];
}

- (void)runProbe {
  NSDictionary *result = runPACProbe();
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:&error];
  if (!data || error) {
    self.textView.text = [NSString stringWithFormat:@"JSON error: %@", error.localizedDescription ?: @"unknown"];
    return;
  }
  self.textView.text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

- (void)copyResult {
  UIPasteboard.generalPasteboard.string = self.textView.text ?: @"";
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Copied" message:@"Paste this JSON back into the PR/chat as the F47 device result." preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:alert animated:YES completion:nil];
}

@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  F47ViewController *vc = [F47ViewController new];
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  self.window.rootViewController = nav;
  [self.window makeKeyAndVisible];
  return YES;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
