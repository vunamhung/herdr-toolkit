// Trackpad actions for Herdr (only while Herdr is the frontmost app; the ones for every app are PadActions.m):
//   pinching the fingers together -> `herdr-app do vnh-tabs.git-pull`, spreading them apart -> `vnh-tabs.git-push`
//     (HERDR_PINCH_TOGETHER / HERDR_PINCH_APART name the commands, HERDR_PINCH_IN / HERDR_PINCH_OUT the thresholds)
//   two fingers scrolling sideways -> the tab switcher: a popup of the tabs of the space you are in (the repo); the scroll moves the
//     highlight, one tab per HERDR_PAD_STEP points of scroll (55), and where the fingers lift (or stop for HERDR_PAD_IDLE seconds,
//     0.6) that tab is selected. Fingers moving left go to the next tab (HERDR_PAD_FLIP=1 reverses it). The popup is vnh-tabswitch,
//     driven through `vnh-tabs.switch-open`, `switch-step-<n>`, `switch-commit`.
// Mods only see gestures over what they draw, and a terminal isn't a mod, hence this small agent. The pinch reacts once per gesture,
// past a clear pinch (+0.35 / -0.3 of scale), at most every 3 s. While the switcher is on, the sideways scroll is not passed on to the
// terminal underneath. The plist sets the environment, so a change needs no rebuild, which would ask for Accessibility again.
// Log: HERDR_PINCH_LOG.
#import <Cocoa/Cocoa.h>
#include <math.h>
#include <stdarg.h>
#include <time.h>

static NSString *herdrBundle = @"dev.herdr.app";
static NSString *herdrApp, *together, *apart;
static const char *logPath;
static double inThreshold = 0.3, outThreshold = 0.35, stepPx = 55, idleSec = 0.6;
static int flip = 0;
static CGFloat pinchSum = 0;
static NSDate *lastPinch;
static dispatch_queue_t commands;                      // one command at a time, in order

static void logf_(const char *fmt, ...) {
  if (!logPath) return;
  FILE *f = fopen(logPath, "a"); if (!f) return;
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%H:%M:%S", localtime(&t));
  fprintf(f, "%s ", ts);
  va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
  fputc('\n', f); fclose(f);
}

static BOOL herdrFront(void) { return [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:herdrBundle]; }

// `herdr-app do <command> {}`, queued: the commands of one gesture reach Herdr in the order they were given.
static void herdr(NSString *command) {
  dispatch_async(commands, ^{
    NSTask *t = [NSTask new];
    t.executableURL = [NSURL fileURLWithPath:herdrApp];
    t.arguments = @[@"do", command, @"{}"];
    t.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    t.standardError = NSFileHandle.fileHandleWithNullDevice;
    NSError *err = nil;
    if ([t launchAndReturnError:&err]) { [t waitUntilExit]; logf_("ran %s", command.UTF8String); }
    else logf_("failed %s: %s", command.UTF8String, err.description.UTF8String);
  });
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

// ---- two fingers scrolling sideways: the tab switcher
// A gesture starts undecided; once it has gone a few points and is clearly sideways (twice as much across as down) the switcher
// opens, and from then on the gesture is ours (its events are not passed on) until the fingers lift.
enum { Idle, Deciding, Sideways, Vertical };
static int swipe = Idle;
static double accX = 0, accY = 0, carry = 0, lastScroll = 0, endedAt = 0;
static CFMachPortRef scrollTap;

static void switcherEnd(const char *why) {
  if (swipe != Sideways) { swipe = Idle; return; }
  swipe = Idle; endedAt = CFAbsoluteTimeGetCurrent();
  logf_("switcher: %s", why);
  herdr(@"vnh-tabs.switch-commit");
}

static CGEventRef onScroll(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(scrollTap, true); return event; }
  if (type != kCGEventScrollWheel) return event;
  if (!herdrFront()) { if (swipe == Sideways) switcherEnd("Herdr left the front"); swipe = Idle; return event; }
  NSEvent *e = [NSEvent eventWithCGEvent:event];
  if (!e || !e.hasPreciseScrollingDeltas) return event;                // a mouse wheel is not this
  double now = CFAbsoluteTimeGetCurrent();
  if (e.momentumPhase != NSEventPhaseNone) return now - endedAt < 1.5 ? NULL : event;   // the glide after our gesture is not passed on either
  NSEventPhase ph = e.phase;
  if (ph == NSEventPhaseBegan || ph == NSEventPhaseMayBegin) { swipe = Deciding; accX = accY = carry = 0; }
  if (swipe == Idle || swipe == Vertical) { if (ph == NSEventPhaseEnded || ph == NSEventPhaseCancelled) swipe = Idle; return event; }
  double dx = e.scrollingDeltaX, dy = e.scrollingDeltaY;
  lastScroll = now;
  if (swipe == Deciding) {
    accX += dx; accY += dy;
    if (fabs(accX) + fabs(accY) < 10) return event;
    if (fabs(accX) > 2 * fabs(accY)) { swipe = Sideways; carry = 0; logf_("switcher: open"); herdr(@"vnh-tabs.switch-open"); }
    else { swipe = Vertical; return event; }
    dx = accX;                                                          // what was held back counts
  }
  if (swipe == Sideways) {
    carry += (flip ? dx : -dx);                                         // fingers to the left: the next tab
    int n = 0;
    while (carry >= stepPx) { n++; carry -= stepPx; }
    while (carry <= -stepPx) { n--; carry += stepPx; }
    if (n) herdr([NSString stringWithFormat:@"vnh-tabs.switch-step-%d", n]);
    if (ph == NSEventPhaseEnded || ph == NSEventPhaseCancelled) switcherEnd("fingers lifted");
    else {                                                              // no phases at all (some devices): stopped moving
      double mark = lastScroll;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(idleSec * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (swipe == Sideways && lastScroll == mark && ph == NSEventPhaseNone) switcherEnd("stopped");
      });
    }
    return NULL;
  }
  return event;
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
    if (env[@"HERDR_PAD_STEP"]) stepPx = [env[@"HERDR_PAD_STEP"] doubleValue];
    if (env[@"HERDR_PAD_IDLE"]) idleSec = [env[@"HERDR_PAD_IDLE"] doubleValue];
    flip = [env[@"HERDR_PAD_FLIP"] isEqualToString:@"1"];
    if (env[@"HERDR_PINCH_LOG"]) logPath = strdup([env[@"HERDR_PINCH_LOG"] UTF8String]);
    commands = dispatch_queue_create("herdr-pad.commands", DISPATCH_QUEUE_SERIAL);

    // Gestures of other apps reach a background agent only with Accessibility: ask for it (macOS shows its prompt once).
    NSDictionary *opts = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
    logf_("accessibility trusted: %d", AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts));
    // The pinch: a listen-only tap, which never blocks or changes an event. NSEvent types 29 (gesture) and 30 (magnify): CGEventMask
    // has no names for them.
    CGEventMask mask = (1 << 29) | (1 << 30);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, onTap, NULL);
    if (tap) {
      CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
      CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      logf_("pinch tap on");
    } else logf_("pinch tap refused: grant Accessibility to this app in System Settings > Privacy & Security, then restart the agent");
    // The global monitor too, for systems that deliver gestures there.
    [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMagnify handler:^(NSEvent *e) { onMagnify(e); }];
    // The sideways scroll: a tap that may drop the events of a gesture the switcher has taken (it acts only in Herdr).
    scrollTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, CGEventMaskBit(kCGEventScrollWheel), onScroll, NULL);
    if (scrollTap) {
      CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, scrollTap, 0);
      CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
      CGEventTapEnable(scrollTap, true);
      logf_("scroll tap on: %.0f points a tab%s", stepPx, flip ? ", flipped" : "");
    } else logf_("scroll tap refused: grant Accessibility to this app, then restart the agent");

    NSApplication *app = NSApplication.sharedApplication;
    app.activationPolicy = NSApplicationActivationPolicyProhibited;
    logf_("started; herdr-app at %s", herdrApp.UTF8String);
    [app run];
  }
  return 0;
}
