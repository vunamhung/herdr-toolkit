// Trackpad actions, in every app. It reads the trackpad's raw touches (the private MultitouchSupport framework, the one
// BetterTouchTool and Jitouch use: an NSEvent never carries a four-finger swipe or a touch's place on the pad) and:
//   four fingers swiping down      -> ⌘W   (close the tab / window)
//   four fingers swiping up        -> ⌘T   (new tab; in Herdr: a new tab running claude --dangerously-skip-permissions; in Antigravity: ⌘N, a new conversation)
//   four fingers tapping           -> ⌘R   (reload / refresh)
//   tiptap left (2 fingers fix)    -> ⌘⇧T  (hold 2 fingers, tap 3rd finger left of them: reopen the tab just closed)
//   Esc in Antigravity             -> closes the Overview popup (⌥⌘O) or right Side Panel (⇧⌘B) when open; untouched otherwise
//   ⌥Z in Antigravity              -> ⌘J (toggle integrated terminal)
//   ⌘↩ in Antigravity              -> toggles sidebar Group By between Project and Status
//   one finger sliding up / down along the right edge -> volume up / down
//   one finger sliding right / left along the top edge -> screen brightness up / down
// While a finger slides along an edge the pointer is held still (and freed the moment the finger leaves the edge or lifts).
// The keys go to whichever app is in front; the volume of the default output (CoreAudio) and the brightness of the main display
// (the private DisplayServices framework) follow the finger continuously, a slide of PAD_SLIDE of the pad's length being the whole range.
// Needs Accessibility (to post keys): macOS asks once, and again after a rebuild. Turn macOS's own four-finger vertical swipe off
// (System Settings > Trackpad > More Gestures > Mission Control / App Exposé), or it fires too.
// Environment (the LaunchAgent plist sets them, so a change needs no rebuild): PAD_DY how far a four-finger swipe must go, as a
// fraction of the pad (0.18); PAD_SWAP=1 swaps ⌘W and ⌘T; PAD_EDGE how wide the edge is (0.12); PAD_SLIDE how far a finger slides for
// the whole range of volume / brightness (0.8); PAD_TAP the longest a four-finger tap lasts, in seconds (0.3); PAD_LOG a log file.
// `PadActions --test volume 0.4` / `--test brightness 0.7` set that level (0 to 1) and exit; with no number, print the level;
// `--test lock` holds the pointer for 3 s.
#import <Cocoa/Cocoa.h>
#include <AudioToolbox/AudioServices.h>
#include <CoreAudio/CoreAudio.h>
#include <math.h>
#include <os/lock.h>
#include <stdarg.h>
#include <stdatomic.h>
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
extern int DisplayServicesGetBrightness(CGDirectDisplayID, float *);
extern int DisplayServicesSetBrightness(CGDirectDisplayID, float);

static const char *logPath;
static double needDY = 0.18, edge = 0.12, slide = 0.8, tapMax = 0.3;
static int swap = 0;

static os_unfair_lock logMu = OS_UNFAIR_LOCK_INIT;
static void logf_(const char *fmt, ...) {
  if (!logPath) return;
  os_unfair_lock_lock(&logMu);
  FILE *f = fopen(logPath, "a");
  if (f) {
    time_t t = time(NULL); struct tm tm; localtime_r(&t, &tm); char ts[32]; strftime(ts, sizeof ts, "%H:%M:%S", &tm);
    fprintf(f, "%s ", ts);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f); fclose(f);
  }
  os_unfair_lock_unlock(&logMu);
}

// ⌘ (and ⇧) + a key: 13 = W, 17 = T.
static void postKey(int code, CGEventFlags flags) {
  CGEventRef d = CGEventCreateKeyboardEvent(NULL, code, true), u = CGEventCreateKeyboardEvent(NULL, code, false);
  CGEventSetFlags(d, flags); CGEventSetFlags(u, flags);
  CGEventPost(kCGHIDEventTap, d); CGEventPost(kCGHIDEventTap, u);
  CFRelease(d); CFRelease(u);
}
// Post a key with isolated modifier flags (unaffected by physical keys held down, e.g. Option during ⌥Z).
static void postKeyToPid(pid_t pid, int code, CGEventFlags flags) {
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStatePrivate);
  CGEventRef d = CGEventCreateKeyboardEvent(src, code, true), u = CGEventCreateKeyboardEvent(src, code, false);
  CGEventSetFlags(d, flags); CGEventSetFlags(u, flags);
  CGEventPostToPid(pid, d); CGEventPostToPid(pid, u);
  CFRelease(d); CFRelease(u);
  if (src) CFRelease(src);
}

// In Herdr, a new tab is a new Claude Code (with --dangerously-skip-permissions) instead of a shell: `herdr-app do tab.new {argv}`.
// PAD_HERDR_NEWTAB (a JSON argv, default the one above) changes it; "" keeps ⌘T there too.
static BOOL herdrFront(void) { return [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:@"dev.herdr.app"]; }
static NSString *newTabArgv = @"[\"claude\",\"--dangerously-skip-permissions\"]";
static BOOL herdrNewTab(void) {
  if (!newTabArgv.length || !herdrFront()) return NO;
  NSString *app = getenv("HERDR_APP") ? @(getenv("HERDR_APP")) : [NSHomeDirectory() stringByAppendingPathComponent:@".local/bin/herdr-app"];
  if (![NSFileManager.defaultManager isExecutableFileAtPath:app]) return NO;
  NSString *arg = [NSString stringWithFormat:@"{\"argv\":%@}", newTabArgv];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{      // the touch callback must not wait for it
    NSTask *t = [NSTask new];
    t.executableURL = [NSURL fileURLWithPath:app];
    t.arguments = @[@"do", @"tab.new", arg];
    t.standardOutput = NSFileHandle.fileHandleWithNullDevice; t.standardError = NSFileHandle.fileHandleWithNullDevice;
    NSError *err = nil; if ([t launchAndReturnError:&err]) [t waitUntilExit];
  });
  return YES;
}

// The volume of the default output device, 0 to 1 (and unmuted when it is raised); -1 when there is none.
static AudioObjectID outDevice(void) {
  AudioObjectID dev = 0; UInt32 size = sizeof dev;
  AudioObjectPropertyAddress a = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  return AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &dev) == noErr ? dev : 0;
}
static double getVolume(void) {
  AudioObjectID dev = outDevice(); Float32 v = 0; UInt32 size = sizeof v;
  AudioObjectPropertyAddress a = { kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain };
  return dev && AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, &v) == noErr ? v : -1;
}
static void setVolume(double v) {
  AudioObjectID dev = outDevice(); if (!dev) return;
  Float32 f = v < 0 ? 0 : v > 1 ? 1 : v;
  AudioObjectPropertyAddress a = { kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain };
  AudioObjectSetPropertyData(dev, &a, 0, NULL, sizeof f, &f);
  if (f > 0) { UInt32 off = 0; AudioObjectPropertyAddress m = { kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput, kAudioObjectPropertyElementMain };
    if (AudioObjectHasProperty(dev, &m)) AudioObjectSetPropertyData(dev, &m, 0, NULL, sizeof off, &off); }
}
static double getBrightness(void) { float b = -1; return DisplayServicesGetBrightness(CGMainDisplayID(), &b) == 0 ? b : -1; }
static void setBrightness(double v) { DisplayServicesSetBrightness(CGMainDisplayID(), v < 0 ? 0 : v > 1 ? 1 : (float)v); }

// The pointer held still while a finger slides along an edge. Freed when the slide ends, by a watchdog if the frames stop (a lost
// lift must never leave it stuck), and when this process ends.
static _Atomic int cursorLocked = 0;
static os_unfair_lock cursorMu = OS_UNFAIR_LOCK_INIT;
static CGPoint lockPt;
static CFMachPortRef moveTap;
static _Atomic double lastEdgeFrame = 0;
// Held by an event tap: while locked, every pointer movement is dropped and the pointer is put back where it was.
// (CGAssociateMouseAndMouseCursorPosition did nothing for a background agent.)
static CGEventRef onMove(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(moveTap, true); return event; }
  if (atomic_load_explicit(&cursorLocked, memory_order_acquire)) {
    CGPoint pt;
    os_unfair_lock_lock(&cursorMu); pt = lockPt; os_unfair_lock_unlock(&cursorMu);
    CGWarpMouseCursorPosition(pt);
    return NULL;
  }
  return event;
}
static void installMoveTap(void) {
  CGEventMask moves = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged);
  moveTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, moves, onMove, NULL);
  if (moveTap) {
    CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, moveTap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
    CFRelease(src);
    CGEventTapEnable(moveTap, true);
  }
  else logf_("pointer tap refused (no Accessibility): the pointer cannot be held");
}
// ⌘ ` (the key under Esc; and ⌘ Esc while Herdr or Antigravity is in front): Herdr, then Antigravity, then Herdr again, and so on. From any other app it goes to Herdr first; in Herdr, to
// Antigravity; in Antigravity, to Herdr. The key is taken (the system's own "next window" for it is not run). Open or hidden, the app
// is brought to the front (launched if it is not running). PAD_SWITCH_A / PAD_SWITCH_B are the two bundle ids; PAD_SWITCH=0 turns it off.
static CFMachPortRef keyTap;
static int switchOn = 1;
static NSString *swA = @"dev.herdr.app", *swB = @"com.google.antigravity";
static pid_t agyAxPid = 0;
static double lastOvClose = 0, lastSpClose = 0;
static BOOL escSwallowed = NO;

static id axAttr(AXUIElementRef el, CFStringRef attr) {
  CFTypeRef v = NULL;
  return AXUIElementCopyAttributeValue(el, attr, &v) == kAXErrorSuccess && v ? CFBridgingRelease(v) : nil;
}
static void warmAgyAX(pid_t pid) {
  if (!pid || pid == agyAxPid) return;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 0.08f);
  if (AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue) == kAXErrorSuccess) agyAxPid = pid;
  CFRelease(app);
}
static AXUIElementRef findWebArea(AXUIElementRef el, int depth) {
  if (depth > 10) return NULL;
  NSArray *kids = axAttr(el, kAXChildrenAttribute);
  if (!kids.count) return NULL;
  if ([axAttr(el, kAXRoleAttribute) isEqualToString:@"AXWebArea"]) {
    return [(NSString *)axAttr(el, kAXTitleAttribute) containsString:@"Antigravity"] ? (AXUIElementRef)CFRetain(el) : NULL;
  }
  for (id k in kids) {
    AXUIElementRef r = findWebArea((__bridge AXUIElementRef)k, depth + 1);
    if (r) return r;
  }
  return NULL;
}
static AXUIElementRef findAgyControl(AXUIElementRef web, NSString *desc) {
  NSDictionary *pred = @{ @"AXDirection": @"AXDirectionNext", @"AXResultsLimit": @5, @"AXSearchKey": @"AXControlSearchKey", @"AXSearchText": desc };
  CFTypeRef res = NULL;
  if (AXUIElementCopyParameterizedAttributeValue(web, CFSTR("AXUIElementsForSearchPredicate"), (__bridge CFDictionaryRef)pred, &res) != kAXErrorSuccess || !res) return NULL;
  for (id item in (NSArray *)CFBridgingRelease(res)) {
    AXUIElementRef el = (__bridge AXUIElementRef)item;
    if ([axAttr(el, kAXDescriptionAttribute) isEqualToString:desc]) return (AXUIElementRef)CFRetain(el);
  }
  return NULL;
}
static BOOL agyControlOpen(AXUIElementRef btn, CFStringRef attr) {
  id v = btn ? axAttr(btn, attr) : nil;
  return [v respondsToSelector:@selector(intValue)] && [v intValue] == 1;
}
static BOOL agyOverviewPopupOpen(AXUIElementRef web) {
  for (id k in (NSArray *)axAttr(web, kAXChildrenAttribute)) {
    AXUIElementRef el = (__bridge AXUIElementRef)k;
    if ([axAttr(el, kAXSubroleAttribute) isEqualToString:@"AXApplicationDialog"]
        && [axAttr(el, kAXDescriptionAttribute) isEqualToString:@"Overview"]) return YES;
  }
  return NO;
}
// Esc in Antigravity closes the Overview popup/panel first, then the right Side Panel; passes through when neither is open.
static BOOL closeAgyPanel(pid_t pid) {
  if (!pid) return NO;
  if (pid != agyAxPid) warmAgyAX(pid);
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, 0.04f);
  id winObj = axAttr(app, kAXFocusedWindowAttribute) ?: axAttr(app, kAXMainWindowAttribute) ?: [(NSArray *)axAttr(app, kAXWindowsAttribute) firstObject];
  AXUIElementRef web = winObj ? findWebArea((__bridge AXUIElementRef)winObj, 0) : NULL;
  BOOL handled = NO;
  if (web) {
    double now = CFAbsoluteTimeGetCurrent();
    if (agyOverviewPopupOpen(web)) {
      if (now - lastOvClose >= 0.25) {
        lastOvClose = now;
        dispatch_async(dispatch_get_main_queue(), ^{ postKey(31, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate); });
        logf_("esc in Antigravity -> close overview popup");
      }
      handled = YES;
    } else {
      AXUIElementRef ov = findAgyControl(web, @"Toggle Overview Panel");
      BOOL ovOpen = agyControlOpen(ov, kAXValueAttribute);
      if (ovOpen && now - lastOvClose >= 0.25) {
        lastOvClose = now;
        dispatch_async(dispatch_get_main_queue(), ^{ AXUIElementPerformAction(ov, kAXPressAction); CFRelease(ov); });
        logf_("esc in Antigravity -> close overview panel");
        handled = YES;
      } else {
        if (ov) CFRelease(ov);
        AXUIElementRef sp = findAgyControl(web, @"Toggle Side Panel");
        BOOL spOpen = agyControlOpen(sp, kAXExpandedAttribute);
        if (spOpen && now - lastSpClose >= 0.25) {
          lastSpClose = now;
          dispatch_async(dispatch_get_main_queue(), ^{ AXUIElementPerformAction(sp, kAXPressAction); CFRelease(sp); });
          logf_("esc in Antigravity -> close side panel");
          handled = YES;
        } else {
          if (sp) CFRelease(sp);
          if ((ovOpen && now - lastOvClose < 0.25) || (spOpen && now - lastSpClose < 0.25)) handled = YES;
        }
      }
    }
    CFRelease(web);
  }
  CFRelease(app);
  return handled;
}

static AXUIElementRef findAgyByRolePrefix(AXUIElementRef web, NSString *role, NSString *prefix) {
  NSDictionary *pred = @{ @"AXDirection": @"AXDirectionNext", @"AXResultsLimit": @10, @"AXSearchText": prefix };
  CFTypeRef res = NULL;
  if (AXUIElementCopyParameterizedAttributeValue(web, CFSTR("AXUIElementsForSearchPredicate"), (__bridge CFDictionaryRef)pred, &res) != kAXErrorSuccess || !res) return NULL;
  for (id item in (NSArray *)CFBridgingRelease(res)) {
    AXUIElementRef el = (__bridge AXUIElementRef)item;
    if ([axAttr(el, kAXRoleAttribute) isEqualToString:role] && [(NSString *)axAttr(el, kAXTitleAttribute) hasPrefix:prefix]) return (AXUIElementRef)CFRetain(el);
  }
  return NULL;
}
static AXUIElementRef findMenuItem(AXUIElementRef el, NSString *title, int depth) {
  if (depth > 4) return NULL;
  if ([axAttr(el, kAXRoleAttribute) isEqualToString:@"AXMenuItem"] && [axAttr(el, kAXTitleAttribute) isEqualToString:title]) return (AXUIElementRef)CFRetain(el);
  for (id k in (NSArray *)axAttr(el, kAXChildrenAttribute)) {
    AXUIElementRef r = findMenuItem((__bridge AXUIElementRef)k, title, depth + 1);
    if (r) return r;
  }
  return NULL;
}
// ⌘↩ in Antigravity toggles sidebar Group By between Project and Status via Display Options -> Group By.
static volatile int groupBusy = 0;
static void toggleAgyGroupBy(pid_t pid) {
  if (!pid || !__sync_bool_compare_and_swap(&groupBusy, 0, 1)) return;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      warmAgyAX(pid);
      AXUIElementRef app = AXUIElementCreateApplication(pid);
      AXUIElementSetMessagingTimeout(app, 0.25f);
      AXUIElementRef prevFocus = NULL;
      AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, (CFTypeRef *)&prevFocus);
      id winObj = axAttr(app, kAXFocusedWindowAttribute) ?: axAttr(app, kAXMainWindowAttribute) ?: [(NSArray *)axAttr(app, kAXWindowsAttribute) firstObject];
      AXUIElementRef web = winObj ? findWebArea((__bridge AXUIElementRef)winObj, 0) : NULL;
      if (web) {
        AXUIElementRef gb = findAgyByRolePrefix(web, @"AXMenuItem", @"Group By");
        BOOL openedMenu = NO;
        if (!gb) {
          AXUIElementRef btn = findAgyControl(web, @"Display Options");
          if (btn) {
            AXError be = AXUIElementPerformAction(btn, kAXPressAction);
            CFRelease(btn);
            openedMenu = YES;
            for (int i = 0; i < 15 && !gb; i++) { usleep(15000); gb = findAgyByRolePrefix(web, @"AXMenuItem", @"Group By"); }
            if (!gb) logf_("cmd+enter: pressed Display Options (err=%d) but no Group By", (int)be);
          } else logf_("cmd+enter: no Display Options button");
        }
        if (gb) {
          NSString *gbTitle = axAttr(gb, kAXTitleAttribute);
          NSString *target = [gbTitle containsString:@"Status"] ? @"Project" : @"Status";
          AXUIElementRef sub = NULL;
          for (int attempt = 0; attempt < 3 && !sub; attempt++) {
            AXUIElementSetAttributeValue(gb, kAXFocusedAttribute, kCFBooleanTrue);
            usleep(25000);
            postKeyToPid(pid, 124, 0);
            for (int i = 0; i < 6 && !sub; i++) { usleep(15000); sub = findAgyByRolePrefix(web, @"AXMenu", @"Group By"); }
          }
          CFRelease(gb);
          AXUIElementRef it = sub ? findMenuItem(sub, target, 0) : NULL;
          if (sub) CFRelease(sub);
          if (it) {
            AXUIElementPerformAction(it, kAXPressAction);
            CFRelease(it);
            logf_("cmd+enter in Antigravity -> group by %s", target.UTF8String);
            for (int i = 0; i < 3; i++) {
              usleep(35000);
              AXUIElementRef still = findAgyByRolePrefix(web, @"AXMenuItem", @"Group By");
              if (!still) break;
              AXUIElementSetAttributeValue(still, kAXFocusedAttribute, kCFBooleanTrue);
              CFRelease(still);
              usleep(10000);
              postKeyToPid(pid, 53, 0);
            }
          } else { logf_("cmd+enter: no item '%s' (gb='%s', sub=%d)", target.UTF8String, gbTitle.UTF8String ?: "", sub != NULL); postKeyToPid(pid, 53, 0); usleep(40000); postKeyToPid(pid, 53, 0); }
          if (openedMenu && prevFocus) {
            NSString *pr = axAttr(prevFocus, kAXRoleAttribute);
            if ([pr isEqualToString:@"AXTextArea"] || [pr isEqualToString:@"AXTextField"]) { usleep(30000); AXUIElementSetAttributeValue(prevFocus, kAXFocusedAttribute, kCFBooleanTrue); }
          }
        } else if (openedMenu) postKeyToPid(pid, 53, 0);
        CFRelease(web);
      }
      if (prevFocus) CFRelease(prevFocus);
      CFRelease(app);
      __sync_lock_release(&groupBusy);
    }
  });
}

static void bringFront(NSString *bundle) {
  // Running: the Accessibility API's "frontmost" (what System Events does; a background agent's own activate request, and `open`, are
  // not always honoured). Not running: `open -b` launches it.
  NSArray *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle];
  if (running.count) {
    NSRunningApplication *a = running.firstObject;
    AXUIElementRef app = AXUIElementCreateApplication(a.processIdentifier);
    AXError e = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(app);
    if ([bundle isEqualToString:@"com.google.antigravity"]) warmAgyAX(a.processIdentifier);
    if (a.hidden) [a unhide];
    if (e == kAXErrorSuccess) return;
    logf_("switch: accessibility refused (%d), using open", (int)e);
  }
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
  t.arguments = @[@"-b", bundle];
  NSError *err = nil; [t launchAndReturnError:&err];
}
// The app in front, read from the windows on screen (front to back): a background agent's NSWorkspace.frontmostApplication goes stale.
static NSString *frontApp(pid_t *outPid) {
  NSArray *wins = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  for (NSDictionary *w in wins) {
    if ([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    CGRect r; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &r) || r.size.width < 100 || r.size.height < 100) continue;
    pid_t pid = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    NSRunningApplication *a = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (a.bundleIdentifier) { if (outPid) *outPid = pid; return a.bundleIdentifier; }
  }
  NSRunningApplication *a = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (outPid) *outPid = a.processIdentifier;
  return a.bundleIdentifier;
}
static NSString *frontBundle(void) { return frontApp(NULL); }
static CGEventRef onKey(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(keyTap, true); return event; }
  if (type != kCGEventKeyDown) return event;
  CGEventFlags f = CGEventGetFlags(event) & (kCGEventFlagMaskCommand | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl);
  int code = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if (code == 53 && f == 0) {
    @autoreleasepool {
      pid_t pid = 0;
      if ([frontApp(&pid) isEqualToString:@"com.google.antigravity"]) {
        if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return escSwallowed ? NULL : event;
        escSwallowed = closeAgyPanel(pid);
        return escSwallowed ? NULL : event;
      }
      escSwallowed = NO;
    }
    return event;
  }
  if (code == 6 && f == kCGEventFlagMaskAlternate) {
    @autoreleasepool {
      pid_t pid = 0;
      if ([frontApp(&pid) isEqualToString:@"com.google.antigravity"]) {
        if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return NULL;
        dispatch_async(dispatch_get_main_queue(), ^{ postKeyToPid(pid, 38, kCGEventFlagMaskCommand); });
        logf_("opt+z in Antigravity -> cmd+j (terminal)");
        return NULL;
      }
    }
    return event;
  }
  if ((code == 36 || code == 76) && f == kCGEventFlagMaskCommand) {
    @autoreleasepool {
      pid_t pid = 0;
      if ([frontApp(&pid) isEqualToString:@"com.google.antigravity"]) {
        if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return NULL;
        toggleAgyGroupBy(pid);
        return NULL;
      }
    }
    return event;
  }
  if (!switchOn || (code != 50 && code != 53) || f != kCGEventFlagMaskCommand) return event;
  @autoreleasepool {
    NSString *front = frontBundle();
    // ⌘ Esc does the same, but only while one of the two is in front (elsewhere Esc keeps its own meaning).
    if (code == 53 && !([front isEqualToString:swA] || [front isEqualToString:swB])) return event;
    if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return NULL;
    NSString *to = [front isEqualToString:swA] ? swB : swA;
    dispatch_async(dispatch_get_main_queue(), ^{ @autoreleasepool { bringFront(to); } });
    logf_("cmd+` : %s -> %s", front.UTF8String ?: "?", to.UTF8String);
    return NULL;
  }
}
static void installKeyTap(void) {
  // Real key presses reach a tap only with the Input Monitoring permission (a key a program posts does not need it).
  if (!CGPreflightListenEventAccess()) { logf_("input monitoring: not granted, asking (System Settings > Privacy & Security > Input Monitoring)"); CGRequestListenEventAccess(); }
  else logf_("input monitoring: granted");
  keyTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, CGEventMaskBit(kCGEventKeyDown), onKey, NULL);
  if (keyTap) {
    CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, keyTap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
    CFRelease(src);
    CGEventTapEnable(keyTap, true);
  }
  else logf_("key tap refused (no Accessibility): cmd+` is not taken");
}
static void lockCursor(int on) {
  if (on == atomic_load_explicit(&cursorLocked, memory_order_relaxed)) return;
  os_unfair_lock_lock(&cursorMu);
  if (on) { CGEventRef e = CGEventCreate(NULL); lockPt = CGEventGetLocation(e); CFRelease(e); }
  atomic_store_explicit(&cursorLocked, on, memory_order_release);
  os_unfair_lock_unlock(&cursorMu);
  logf_("pointer %s", on ? "held" : "freed");
}
static void freeCursor(int sig) { atomic_store_explicit(&cursorLocked, 0, memory_order_relaxed); if (sig) _exit(0); }

// The state of the touch on the pad (one state for all pads).
static int prev = 0, active = 0, fired = 0, blocked = 0;     // four fingers: down / its action done / a fifth finger came
static double startX, startY, startT, lastFire = 0, peak = 0;
static int edgeMode = 0;                                       // one finger: 0 none, 1 right edge (volume), 2 top edge (brightness)
static double edgeRef = 0, edgeLevel = 0, edgeSet = 0, edgeFrom = 0;      // where the finger was, the level it holds, the level last set
// TipTap left (2 fingers fix): 2 fingers resting (anchors), 3rd finger taps to their left and lifts while both anchors stay down.
static int ttState = 0, ttA0 = -1, ttA1 = -1, ttTapId = -1;    // 0 idle, 1 two anchors down, 2 3rd finger tapping left, 3 confirming anchors stayed
static double ttAnchorDownT = 0, ttTapStartT = 0, ttPreHold = 0, ttLiftT = 0, ttTapDur = 0, lastTipTap = 0;
static double ttA0X = 0, ttA0Y = 0, ttA1X = 0, ttA1Y = 0, ttTapStartX = 0, ttTapStartY = 0, ttAnchPeak = 0, ttTapPeak = 0;

static void fireTipTapLeft(double ts, double dur) {
  if (ts - lastTipTap < 0.35) return;
  lastTipTap = ts;
  postKey(17, kCGEventFlagMaskCommand | kCGEventFlagMaskShift);
  logf_("tiptap left (2-finger fix, %.2fs) -> cmd+shift+t", dur);
}
static int findTouchId(const int *ids, int cnt, int id) {
  for (int i = 0; i < cnt; i++) if (ids[i] == id) return i;
  return -1;
}

static int onFrame(MTDeviceRef dev, MTTouch *t, int n, double ts, int frame) {
  @autoreleasepool {
  int cnt = 0, ids[3] = {-1, -1, -1}; double sx = 0, sy = 0, tx[3] = {0, 0, 0}, ty[3] = {0, 0, 0};
  for (int i = 0; i < n; i++) if (t[i].state == 3 || t[i].state == 4) {
    double px = t[i].normalized.position.x, py = t[i].normalized.position.y;
    if (cnt < 3) { ids[cnt] = t[i].identifier; tx[cnt] = px; ty[cnt] = py; }
    cnt++; sx += px; sy += py;
  }
  int was = prev; prev = cnt;

  // ---- one finger along an edge
  if (cnt == 1) {
    double x = sx, y = sy;
    if (was == 0) {
      edgeMode = x >= 1 - edge ? 1 : (y >= 1 - edge ? 2 : 0);
      if (edgeMode) {
        logf_("touch on edge: x %.2f y %.2f -> %s", x, y, edgeMode == 1 ? "volume" : "brightness");
        edgeRef = edgeFrom = edgeMode == 1 ? y : x;
        edgeLevel = edgeSet = edgeMode == 1 ? getVolume() : getBrightness();
        if (edgeLevel < 0) edgeMode = 0;
      }
    } else if (edgeMode) {
      if ((edgeMode == 1 && x < 1 - edge - 0.1) || (edgeMode == 2 && y < 1 - edge - 0.1)) { edgeMode = 0; lockCursor(0); }   // left the edge: a pointer again
      else {
        double pos = edgeMode == 1 ? y : x;
        atomic_store_explicit(&lastEdgeFrame, CFAbsoluteTimeGetCurrent(), memory_order_relaxed);
        if (fabs(pos - edgeFrom) >= 0.015) lockCursor(1);                  // it slides: hold the pointer
        edgeLevel += (pos - edgeRef) / slide; edgeRef = pos;               // the pad's y grows upward, x to the right
        if (edgeLevel < 0) edgeLevel = 0; if (edgeLevel > 1) edgeLevel = 1;
        if (fabs(edgeLevel - edgeSet) >= 0.01) { edgeSet = edgeLevel; if (edgeMode == 1) setVolume(edgeLevel); else setBrightness(edgeLevel); }
      }
    }
  } else { edgeMode = 0; lockCursor(0); }

  // ---- tiptap left with 2 fingers fix (reopen closed tab: ⌘⇧T)
  if (cnt == 2) {
    int same = findTouchId(ids, 2, ttA0) >= 0 && findTouchId(ids, 2, ttA1) >= 0;
    if (ttState == 2 && same) {
      double dur = ts - ttTapStartT;
      if (dur < tapMax && ttAnchPeak < 0.035 && ttTapPeak < 0.05) {
        if (ttPreHold >= 0.08) { fireTipTapLeft(ts, dur); ttState = 1; ttAnchorDownT = ts; }
        else { ttState = 3; ttLiftT = ts; ttTapDur = dur; }        // brief anchors: wait 50ms to rule out a 3-finger tap
      } else { ttState = 1; ttAnchorDownT = ts; }
    } else if (ttState == 3 && same) {
      if (ts - ttLiftT >= 0.05) { fireTipTapLeft(ts, ttTapDur); ttState = 1; ttAnchorDownT = ts; }
    } else if (!(ttState == 1 && same)) {
      ttState = 1; ttA0 = ids[0]; ttA1 = ids[1]; ttAnchorDownT = ts;
    }
  } else if (cnt == 3) {
    if (ttState == 1) {
      int i0 = findTouchId(ids, 3, ttA0), i1 = findTouchId(ids, 3, ttA1);
      if (i0 >= 0 && i1 >= 0) {
        int ti = 3 - i0 - i1;
        if (tx[ti] < fmin(tx[i0], tx[i1]) - 0.02) {                // 3rd finger landed to the left of both resting anchors
          ttState = 2; ttTapId = ids[ti]; ttTapStartT = ts; ttPreHold = ts - ttAnchorDownT;
          ttA0X = tx[i0]; ttA0Y = ty[i0]; ttA1X = tx[i1]; ttA1Y = ty[i1]; ttTapStartX = tx[ti]; ttTapStartY = ty[ti];
          ttAnchPeak = ttTapPeak = 0;
        } else ttState = 0;
      } else ttState = 0;
    } else if (ttState == 2) {
      int i0 = findTouchId(ids, 3, ttA0), i1 = findTouchId(ids, 3, ttA1), ti = findTouchId(ids, 3, ttTapId);
      if (i0 < 0 || i1 < 0 || ti < 0) ttState = 0;
      else {
        double am = fmax(hypot(tx[i0] - ttA0X, ty[i0] - ttA0Y), hypot(tx[i1] - ttA1X, ty[i1] - ttA1Y));
        double tm = hypot(tx[ti] - ttTapStartX, ty[ti] - ttTapStartY);
        if (am > ttAnchPeak) ttAnchPeak = am;
        if (tm > ttTapPeak) ttTapPeak = tm;
        if (ttAnchPeak > 0.035 || ttTapPeak > 0.05 || ts - ttTapStartT > tapMax) ttState = 0;
      }
    } else ttState = 0;
  } else ttState = 0;

  // ---- four fingers
  if (cnt == 0) { active = fired = blocked = 0; peak = 0; return 0; }
  if (cnt > 4) { blocked = 1; active = 0; return 0; }          // five fingers: a pinch, not this
  if (cnt < 4) {
    if (was == 4 && active && !fired && !blocked && peak < 0.03 && ts - startT < tapMax) {   // lifted at once, hardly moved: a tap
      fired = 1;
      if (ts - lastFire >= 0.5) { lastFire = ts; postKey(15, kCGEventFlagMaskCommand); logf_("four-finger tap (%.2fs) -> cmd+r", ts - startT); }
    }
    active = 0; return 0;
  }
  if (blocked) return 0;
  double x = sx / 4, y = sy / 4;
  if (!active) { active = 1; startX = x; startY = y; startT = ts; peak = 0; return 0; }
  double dy = y - startY, dx = x - startX, mag = fabs(dy);          // the pad's y grows upward
  if (mag > peak) peak = mag;
  if (!fired && mag >= needDY && fabs(dx) <= mag * 0.8 && ts - startT < 1.5) {
    fired = 1;
    int down = dy < 0, key = (down != swap) ? 13 : 17;
    if (ts - lastFire >= 0.8) { lastFire = ts; if (key == 17 && herdrNewTab()) logf_("swipe up in Herdr -> new tab with claude");
      else if (key == 17 && [frontBundle() isEqualToString:@"com.google.antigravity"]) { postKey(45, kCGEventFlagMaskCommand); logf_("swipe up in Antigravity -> cmd+n (new conversation)"); }   // there, a new tab is ⌘N
      else { postKey(key, kCGEventFlagMaskCommand); } logf_("swipe %s: dy %.2f dx %.2f -> cmd+%c", down ? "down" : "up", mag, dx, key == 13 ? 'w' : 't'); }
  }
  return 0;
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc == 3 && !strcmp(argv[1], "--test") && !strcmp(argv[2], "lock")) {      // holds the pointer for 2 s, then frees it
      installMoveTap(); lockCursor(1);
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 3, false);         // 3 s with the tap on: move the pointer, it stays
      lockCursor(0); return 0;
    }
    if (argc >= 3 && !strcmp(argv[1], "--test")) {
      int vol = !strcmp(argv[2], "volume");
      if (argc == 4) { if (vol) setVolume(atof(argv[3])); else setBrightness(atof(argv[3])); }
      printf("%s %.3f\n", argv[2], vol ? getVolume() : getBrightness());
      return 0;
    }
    installMoveTap();
    signal(SIGTERM, freeCursor); signal(SIGINT, freeCursor); signal(SIGHUP, freeCursor); atexit_b(^{ freeCursor(0); });
    CFRunLoopTimerRef dog = CFRunLoopTimerCreateWithHandler(NULL, CFAbsoluteTimeGetCurrent() + 0.25, 0.25, 0, 0, ^(CFRunLoopTimerRef tm) {
      if (atomic_load_explicit(&cursorLocked, memory_order_relaxed) && CFAbsoluteTimeGetCurrent() - atomic_load_explicit(&lastEdgeFrame, memory_order_relaxed) > 0.4) lockCursor(0);
    });
    CFRunLoopAddTimer(CFRunLoopGetMain(), dog, kCFRunLoopCommonModes);
    logPath = getenv("PAD_LOG");
    if (getenv("PAD_SWITCH") && getenv("PAD_SWITCH")[0] == '0') switchOn = 0;
    if (getenv("PAD_SWITCH_A")) swA = @(getenv("PAD_SWITCH_A"));
    if (getenv("PAD_SWITCH_B")) swB = @(getenv("PAD_SWITCH_B"));
    installKeyTap();
    NSRunningApplication *agy = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.google.antigravity"].firstObject;
    if (agy) warmAgyAX(agy.processIdentifier);
    if (getenv("PAD_DY")) needDY = atof(getenv("PAD_DY"));
    if (getenv("PAD_EDGE")) edge = atof(getenv("PAD_EDGE"));
    if (getenv("PAD_SLIDE")) slide = atof(getenv("PAD_SLIDE"));
    if (getenv("PAD_TAP")) tapMax = atof(getenv("PAD_TAP"));
    if (getenv("PAD_HERDR_NEWTAB")) newTabArgv = @(getenv("PAD_HERDR_NEWTAB"));
    swap = getenv("PAD_SWAP") && getenv("PAD_SWAP")[0] == '1';
    const void *keys[] = { kAXTrustedCheckOptionPrompt }, *vals[] = { getenv("PAD_NOPROMPT") ? kCFBooleanFalse : kCFBooleanTrue };
    CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    logf_("accessibility trusted: %d", AXIsProcessTrustedWithOptions(opts));
    CFRelease(opts);
    CFMutableArrayRef list = MTDeviceCreateList();
    CFIndex n = list ? CFArrayGetCount(list) : 0;
    for (CFIndex i = 0; i < n; i++) { MTDeviceRef d = (MTDeviceRef)CFArrayGetValueAtIndex(list, i); MTRegisterContactFrameCallback(d, onFrame); MTDeviceStart(d, 0); }
    logf_("multitouch devices: %ld; four fingers: swipe down cmd+%c, up cmd+%c (%.2f of the pad), tap cmd+r; tiptap left (2-finger fix): cmd+shift+t; edges (%.2f wide, a slide of %.2f is the whole range): right volume, top brightness",
      (long)n, swap ? 't' : 'w', swap ? 'w' : 't', needDY, edge, slide);
    if (n == 0) logf_("no multitouch devices; keeping keyboard shortcuts active");
    CFRunLoopRun();
  }
  return 0;
}
