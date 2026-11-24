// Trackpad actions for Herdr (only while Herdr is the frontmost app; the ones for every app are PadActions.m):
//   pinching the fingers together -> `herdr-app do vnh-tabs.git-pull`, spreading them apart -> `vnh-tabs.git-push`
//     (HERDR_PINCH_TOGETHER / HERDR_PINCH_APART name the commands, HERDR_PINCH_IN / HERDR_PINCH_OUT the thresholds)
//   one finger sliding left / right along the bottom edge -> `tab.prev` / `tab.next`: the tab bar scrolls along
//     (HERDR_PAD_EDGE how wide the edge is, 0.06 of the pad; HERDR_PAD_STEP how far a slide is for one tab, 0.07 of the pad)
// Mods only see gestures over what they draw, and a terminal isn't a mod, hence this small agent. The pinch reacts once per gesture,
// past a clear pinch (+0.35 / -0.3 of scale), at most every 3 s; the slide reads the pad's raw touches (the private MultitouchSupport
// framework). The plist sets the environment, so a change needs no rebuild, which would ask for Accessibility again.
// Log: HERDR_PINCH_LOG.
#import <Cocoa/Cocoa.h>
#include <math.h>
#include <stdarg.h>
#include <time.h>

typedef struct { float x, y; } MTPoint;
typedef struct { MTPoint position, velocity; } MTVector;
typedef struct {
  int frame; double timestamp; int identifier, state, fingerId, handId;
  MTVector normalized; float size; int zero1; float angle, majorAxis, minorAxis;
  MTVector absoluteVector; int zero2[2]; float zDensity;
} MTTouch;
typedef void *MTDeviceRef;
typedef int (*MTContactCallback)(MTDeviceRef, MTTouch *, int, double, int);
extern CFMutableArrayRef MTDeviceCreateList(void);
extern void MTRegisterContactFrameCallback(MTDeviceRef, MTContactCallback);
extern void MTDeviceStart(MTDeviceRef, int);

static NSString *herdrBundle = @"dev.herdr.app";
static NSString *herdrApp, *together, *apart;
static const char *logPath;
static double inThreshold = 0.3, outThreshold = 0.35, edge = 0.06, step = 0.07;
static CGFloat pinchSum = 0;
static NSDate *lastPinch;

static void logf_(const char *fmt, ...) {
  if (!logPath) return;
  FILE *f = fopen(logPath, "a"); if (!f) return;
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%H:%M:%S", localtime(&t));
  fprintf(f, "%s ", ts);
  va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
  fputc('\n', f); fclose(f);
}

static BOOL herdrFront(void) { return [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:herdrBundle]; }

static void herdr(NSString *command) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:herdrApp];
  t.arguments = @[@"do", command, @"{}"];
  t.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  t.standardError = NSFileHandle.fileHandleWithNullDevice;
  NSError *err = nil;
  if ([t launchAndReturnError:&err]) logf_("ran %s", command.UTF8String); else logf_("failed %s: %s", command.UTF8String, err.description.UTF8String);
}

// ---- pinch: git pull / push
static void pinchEnded(void) {
  logf_("gesture %.2f", pinchSum);
  CGFloat s = pinchSum; pinchSum = 0;
  if (lastPinch && -[lastPinch timeIntervalSinceNow] <= 3) return;
  if (s <= -inThreshold) { lastPinch = [NSDate date]; herdr(together); }
  else if (s >= outThreshold) { lastPinch = [NSDate date]; herdr(apart); }
}

static void onMagnify(NSEvent *e) {
  if (e.type != NSEventTypeMagnify) return;
  if (!herdrFront()) { pinchSum = 0; return; }
  switch (e.phase) {
    case NSEventPhaseBegan: pinchSum = 0; break;
    case NSEventPhaseChanged: pinchSum += e.magnification; break;
    case NSEventPhaseEnded: pinchSum += e.magnification; pinchEnded(); break;
    case NSEventPhaseCancelled: pinchSum = 0; break;
    default: break;
  }
}

// ---- one finger along the bottom edge: tab.prev / tab.next
static int prevCount = 0, bottomOn = 0;
static double bottomRef = 0;

static int onFrame(MTDeviceRef dev, MTTouch *t, int n, double ts, int frame) {
  int cnt = 0; double x = 0, y = 0;
  for (int i = 0; i < n; i++) if (t[i].state == 3 || t[i].state == 4) { cnt++; x = t[i].normalized.position.x; y = t[i].normalized.position.y; }
  int was = prevCount; prevCount = cnt;
  if (cnt != 1) { bottomOn = 0; return 0; }
  if (was == 0) { bottomOn = y <= edge && herdrFront(); bottomRef = x; return 0; }     // a touch that starts on the bottom edge, in Herdr
  if (!bottomOn) return 0;
  if (y > edge + 0.1) { bottomOn = 0; return 0; }                                        // left the edge: a pointer again
  while (fabs(x - bottomRef) >= step) {
    int right = x > bottomRef;                                                           // the pad's x grows to the right
    herdr(right ? @"tab.next" : @"tab.prev");
    bottomRef += right ? step : -step;
  }
  return 0;
}

static CGEventRef onTap(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) return event;
  NSEvent *e = [NSEvent eventWithCGEvent:event];
  if (e) onMagnify(e);
  return event;
}

int main(void) {
  @autoreleasepool {
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    herdrApp = env[@"HERDR_APP"] ?: @"/usr/local/bin/herdr-app";
    together = env[@"HERDR_PINCH_TOGETHER"] ?: @"vnh-tabs.git-pull";
    apart = env[@"HERDR_PINCH_APART"] ?: @"vnh-tabs.git-push";
    if (env[@"HERDR_PINCH_IN"]) inThreshold = [env[@"HERDR_PINCH_IN"] doubleValue];
    if (env[@"HERDR_PINCH_OUT"]) outThreshold = [env[@"HERDR_PINCH_OUT"] doubleValue];
    if (env[@"HERDR_PAD_EDGE"]) edge = [env[@"HERDR_PAD_EDGE"] doubleValue];
    if (env[@"HERDR_PAD_STEP"]) step = [env[@"HERDR_PAD_STEP"] doubleValue];
    if (env[@"HERDR_PINCH_LOG"]) logPath = strdup([env[@"HERDR_PINCH_LOG"] UTF8String]);

    // Gestures of other apps reach a background agent only with Accessibility: ask for it (macOS shows its prompt once), then
    // listen through a listen-only event tap, which never blocks or changes an event.
    NSDictionary *opts = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
    logf_("accessibility trusted: %d", AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts));
    // NSEvent types 29 (gesture) and 30 (magnify): CGEventMask has no names for them.
    CGEventMask mask = (1 << 29) | (1 << 30);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, onTap, NULL);
    if (tap) {
      CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
      CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      logf_("event tap on");
    } else logf_("event tap refused: grant Accessibility to this app in System Settings > Privacy & Security, then restart the agent");
    // The global monitor too, for systems that deliver gestures there.
    [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMagnify handler:^(NSEvent *e) { onMagnify(e); }];

    CFMutableArrayRef list = MTDeviceCreateList();
    CFIndex n = list ? CFArrayGetCount(list) : 0;
    for (CFIndex i = 0; i < n; i++) { MTDeviceRef d = (MTDeviceRef)CFArrayGetValueAtIndex(list, i); MTRegisterContactFrameCallback(d, onFrame); MTDeviceStart(d, 0); }
    logf_("multitouch devices: %ld; bottom edge %.2f wide, %.2f a tab", (long)n, edge, step);

    NSApplication *app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyProhibited;
    logf_("started; herdr-app at %s", herdrApp.UTF8String);
    [app run];
  }
  return 0;
}
