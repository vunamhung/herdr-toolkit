// Trackpad actions, in every app. It reads the trackpad's raw touches (the private MultitouchSupport framework, the one
// BetterTouchTool and Jitouch use: an NSEvent never carries a four-finger swipe or a touch's place on the pad) and:
//   four fingers swiping down      -> ⌘W   (close the tab / window)
//   four fingers swiping up        -> ⌘T   (new tab; in Herdr: a new tab running claude --dangerously-skip-permissions; in Antigravity: ⌘N, a new conversation)
//   four fingers tapping           -> ⌘⇧T  (reopen the tab just closed)
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
extern int DisplayServicesGetBrightness(CGDirectDisplayID, float *);
extern int DisplayServicesSetBrightness(CGDirectDisplayID, float);

static const char *logPath;
static double needDY = 0.18, edge = 0.12, slide = 0.8, tapMax = 0.3;
static int swap = 0;

static void logf_(const char *fmt, ...) {
  if (!logPath) return;
  FILE *f = fopen(logPath, "a"); if (!f) return;
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%H:%M:%S", localtime(&t));
  fprintf(f, "%s ", ts);
  va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
  fputc('\n', f); fclose(f);
}

// ⌘ (and ⇧) + a key: 13 = W, 17 = T.
static void postKey(int code, CGEventFlags flags) {
  CGEventRef d = CGEventCreateKeyboardEvent(NULL, code, true), u = CGEventCreateKeyboardEvent(NULL, code, false);
  CGEventSetFlags(d, flags); CGEventSetFlags(u, flags);
  CGEventPost(kCGHIDEventTap, d); CGEventPost(kCGHIDEventTap, u);
  CFRelease(d); CFRelease(u);
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
static int cursorLocked = 0;
static CGPoint lockPt;
static CFMachPortRef moveTap;
static double lastEdgeFrame = 0;
// Held by an event tap: while locked, every pointer movement is dropped and the pointer is put back where it was.
// (CGAssociateMouseAndMouseCursorPosition did nothing for a background agent.)
static CGEventRef onMove(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(moveTap, true); return event; }
  if (cursorLocked) { CGWarpMouseCursorPosition(lockPt); return NULL; }
  return event;
}
static void installMoveTap(void) {
  CGSetLocalEventsSuppressionInterval(0);
  CGEventMask moves = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged);
  moveTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, moves, onMove, NULL);
  if (moveTap) { CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, moveTap, 0), kCFRunLoopCommonModes); CGEventTapEnable(moveTap, true); }
  else logf_("pointer tap refused (no Accessibility): the pointer cannot be held");
}
// ⌘ ` (the key under Esc; and ⌘ Esc while Herdr or Antigravity is in front): Herdr, then Antigravity, then Herdr again, and so on. From any other app it goes to Herdr first; in Herdr, to
// Antigravity; in Antigravity, to Herdr. The key is taken (the system's own "next window" for it is not run). Open or hidden, the app
// is brought to the front (launched if it is not running). PAD_SWITCH_A / PAD_SWITCH_B are the two bundle ids; PAD_SWITCH=0 turns it off.
static CFMachPortRef keyTap;
static NSString *swA = @"dev.herdr.app", *swB = @"com.google.antigravity";
static void bringFront(NSString *bundle) {
  // Running: the Accessibility API's "frontmost" (what System Events does; a background agent's own activate request, and `open`, are
  // not always honoured). Not running: `open -b` launches it.
  NSArray *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle];
  if (running.count) {
    NSRunningApplication *a = running.firstObject;
    AXUIElementRef app = AXUIElementCreateApplication(a.processIdentifier);
    AXError e = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(app);
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
static NSString *frontBundle(void) {
  NSArray *wins = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  for (NSDictionary *w in wins) {
    if ([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    CGRect r; if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(__bridge NSString *)kCGWindowBounds], &r) || r.size.width < 100 || r.size.height < 100) continue;
    NSRunningApplication *a = [NSRunningApplication runningApplicationWithProcessIdentifier:[w[(__bridge NSString *)kCGWindowOwnerPID] intValue]];
    if (a.bundleIdentifier) return a.bundleIdentifier;
  }
  return NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
}
static CGEventRef onKey(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) { CGEventTapEnable(keyTap, true); return event; }
  if (type != kCGEventKeyDown) return event;
  CGEventFlags f = CGEventGetFlags(event) & (kCGEventFlagMaskCommand | kCGEventFlagMaskShift | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl);
  int code = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if ((code != 50 && code != 53) || f != kCGEventFlagMaskCommand) return event;
  NSString *front = frontBundle();
  // ⌘ Esc does the same, but only while one of the two is in front (elsewhere Esc keeps its own meaning).
  if (code == 53 && !([front isEqualToString:swA] || [front isEqualToString:swB])) return event;
  if (CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat)) return NULL;
  NSString *to = [front isEqualToString:swA] ? swB : swA;
  dispatch_async(dispatch_get_main_queue(), ^{ bringFront(to); });
  logf_("cmd+` : %s -> %s", front.UTF8String ?: "?", to.UTF8String);
  return NULL;
}
static void installKeyTap(void) {
  // Real key presses reach a tap only with the Input Monitoring permission (a key a program posts does not need it).
  if (!CGPreflightListenEventAccess()) { logf_("input monitoring: not granted, asking (System Settings > Privacy & Security > Input Monitoring)"); CGRequestListenEventAccess(); }
  else logf_("input monitoring: granted");
  keyTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, CGEventMaskBit(kCGEventKeyDown), onKey, NULL);
  if (keyTap) { CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, keyTap, 0), kCFRunLoopCommonModes); CGEventTapEnable(keyTap, true); }
  else logf_("key tap refused (no Accessibility): cmd+` is not taken");
}
static void lockCursor(int on) {
  if (on == cursorLocked) return;
  if (on) { CGEventRef e = CGEventCreate(NULL); lockPt = CGEventGetLocation(e); CFRelease(e); }
  cursorLocked = on;
  logf_("pointer %s", on ? "held" : "freed");
}
static void freeCursor(int sig) { cursorLocked = 0; if (sig) _exit(0); }

// The state of the touch on the pad (one state for all pads).
static int prev = 0, active = 0, fired = 0, blocked = 0;     // four fingers: down / its action done / a fifth finger came
static double startX, startY, startT, lastFire = 0, peak = 0;
static int edgeMode = 0;                                       // one finger: 0 none, 1 right edge (volume), 2 top edge (brightness)
static double edgeRef = 0, edgeLevel = 0, edgeSet = 0, edgeFrom = 0;      // where the finger was, the level it holds, the level last set

static int onFrame(MTDeviceRef dev, MTTouch *t, int n, double ts, int frame) {
  int cnt = 0; double sx = 0, sy = 0;
  for (int i = 0; i < n; i++) if (t[i].state == 3 || t[i].state == 4) { cnt++; sx += t[i].normalized.position.x; sy += t[i].normalized.position.y; }
  int was = prev; prev = cnt;

  // ---- one finger along an edge
  if (cnt == 1) {
    double x = sx, y = sy;
    if (was == 0) {
      edgeMode = x >= 1 - edge ? 1 : (y >= 1 - edge ? 2 : 0);
      if (x >= 0.8 || y >= 0.8) logf_("touch near an edge: x %.2f y %.2f -> %s", x, y, edgeMode == 1 ? "volume" : edgeMode == 2 ? "brightness" : "not on the edge");
      edgeRef = edgeFrom = edgeMode == 1 ? y : x;
      edgeLevel = edgeSet = edgeMode == 1 ? getVolume() : getBrightness();
      if (edgeLevel < 0) edgeMode = 0;
    } else if (edgeMode) {
      if ((edgeMode == 1 && x < 1 - edge - 0.1) || (edgeMode == 2 && y < 1 - edge - 0.1)) { edgeMode = 0; lockCursor(0); }   // left the edge: a pointer again
      else {
        double pos = edgeMode == 1 ? y : x;
        lastEdgeFrame = CFAbsoluteTimeGetCurrent();
        if (fabs(pos - edgeFrom) >= 0.015) lockCursor(1);                  // it slides: hold the pointer
        edgeLevel += (pos - edgeRef) / slide; edgeRef = pos;               // the pad's y grows upward, x to the right
        if (edgeLevel < 0) edgeLevel = 0; if (edgeLevel > 1) edgeLevel = 1;
        if (fabs(edgeLevel - edgeSet) >= 0.01) { edgeSet = edgeLevel; if (edgeMode == 1) setVolume(edgeLevel); else setBrightness(edgeLevel); }
      }
    }
  } else { edgeMode = 0; lockCursor(0); }

  // ---- four fingers
  if (cnt == 0) { active = fired = blocked = 0; peak = 0; return 0; }
  if (cnt > 4) { blocked = 1; active = 0; return 0; }          // five fingers: a pinch, not this
  if (cnt < 4) {
    if (was == 4 && active && !fired && !blocked && peak < 0.03 && ts - startT < tapMax) {   // lifted at once, hardly moved: a tap
      fired = 1;
      time_t wall = time(NULL);
      if (difftime(wall, (time_t)lastFire) >= 0.5) { lastFire = (double)wall; postKey(17, kCGEventFlagMaskCommand | kCGEventFlagMaskShift); logf_("four-finger tap (%.2fs) -> cmd+shift+t", ts - startT); }
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
    time_t wall = time(NULL);
    if (difftime(wall, (time_t)lastFire) >= 0.8) { lastFire = (double)wall; if (key == 17 && herdrNewTab()) logf_("swipe up in Herdr -> new tab with claude");
      else if (key == 17 && [frontBundle() isEqualToString:@"com.google.antigravity"]) { postKey(45, kCGEventFlagMaskCommand); logf_("swipe up in Antigravity -> cmd+n (new conversation)"); }   // there, a new tab is ⌘N
      else { postKey(key, kCGEventFlagMaskCommand); } logf_("swipe %s: dy %.2f dx %.2f -> cmd+%c", down ? "down" : "up", mag, dx, key == 13 ? 'w' : 't'); }
  }
  return 0;
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
      if (cursorLocked && CFAbsoluteTimeGetCurrent() - lastEdgeFrame > 0.4) lockCursor(0);
    });
    CFRunLoopAddTimer(CFRunLoopGetMain(), dog, kCFRunLoopCommonModes);
    logPath = getenv("PAD_LOG");
    if (!(getenv("PAD_SWITCH") && getenv("PAD_SWITCH")[0] == '0')) {
      if (getenv("PAD_SWITCH_A")) swA = @(getenv("PAD_SWITCH_A"));
      if (getenv("PAD_SWITCH_B")) swB = @(getenv("PAD_SWITCH_B"));
      installKeyTap();
    }
    if (getenv("PAD_DY")) needDY = atof(getenv("PAD_DY"));
    if (getenv("PAD_EDGE")) edge = atof(getenv("PAD_EDGE"));
    if (getenv("PAD_SLIDE")) slide = atof(getenv("PAD_SLIDE"));
    if (getenv("PAD_TAP")) tapMax = atof(getenv("PAD_TAP"));
    if (getenv("PAD_HERDR_NEWTAB")) newTabArgv = @(getenv("PAD_HERDR_NEWTAB"));
    swap = getenv("PAD_SWAP") && getenv("PAD_SWAP")[0] == '1';
    const void *keys[] = { kAXTrustedCheckOptionPrompt }, *vals[] = { getenv("PAD_NOPROMPT") ? kCFBooleanFalse : kCFBooleanTrue };
    CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    logf_("accessibility trusted: %d", AXIsProcessTrustedWithOptions(opts));
    CFMutableArrayRef list = MTDeviceCreateList();
    CFIndex n = list ? CFArrayGetCount(list) : 0;
    for (CFIndex i = 0; i < n; i++) { MTDeviceRef d = (MTDeviceRef)CFArrayGetValueAtIndex(list, i); MTRegisterContactFrameCallback(d, onFrame); MTDeviceStart(d, 0); }
    logf_("multitouch devices: %ld; four fingers: swipe down cmd+%c, up cmd+%c (%.2f of the pad), tap cmd+shift+t; edges (%.2f wide, a slide of %.2f is the whole range): right volume, top brightness",
      (long)n, swap ? 't' : 'w', swap ? 'w' : 't', needDY, edge, slide);
    if (n == 0) return 1;
    CFRunLoopRun();
  }
  return 0;
}
