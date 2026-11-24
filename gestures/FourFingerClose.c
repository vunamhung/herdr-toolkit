// Four fingers swiping down on the trackpad = ⌘W, in every app.
// Reads the trackpad's raw touches (the private MultitouchSupport framework, the one BetterTouchTool and Jitouch use: an
// NSEvent never carries a four-finger swipe) and, when exactly four fingers travel down together, posts ⌘W to whichever
// app is in front. Once per touch, at most every 0.8 s. Needs Accessibility (to post the key): macOS asks once.
// Turn macOS's own four-finger vertical swipe off (System Settings > Trackpad > More Gestures > Mission Control / App
// Exposé), or it fires too.
// Environment (the LaunchAgent plist sets them, so a change needs no rebuild): FFC_DY how far down, as a fraction of the
// pad's height (default 0.18); FFC_UP=1 swipes up instead of down; FFC_LOG a log file (every gesture, with its travel).
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdarg.h>

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

static const char *logPath;
static double needDY = 0.18;
static int swipeUp = 0;

static void logf_(const char *fmt, ...) {
  if (!logPath) return;
  FILE *f = fopen(logPath, "a"); if (!f) return;
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%H:%M:%S", localtime(&t));
  fprintf(f, "%s ", ts);
  va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
  fputc('\n', f); fclose(f);
}

static void closeWindow(void) {
  CGEventRef d = CGEventCreateKeyboardEvent(NULL, 13, true), u = CGEventCreateKeyboardEvent(NULL, 13, false);   // 13 = W
  CGEventSetFlags(d, kCGEventFlagMaskCommand); CGEventSetFlags(u, kCGEventFlagMaskCommand);
  CGEventPost(kCGHIDEventTap, d); CGEventPost(kCGHIDEventTap, u);
  CFRelease(d); CFRelease(u);
}

// One state for all pads: the touch that started with four fingers, where they started, whether it has fired.
static int active = 0, fired = 0, blocked = 0;
static double startX, startY, startT, lastFire = 0, peak = 0;

static int onFrame(MTDeviceRef dev, MTTouch *t, int n, double ts, int frame) {
  int cnt = 0; double sx = 0, sy = 0;
  for (int i = 0; i < n; i++) if (t[i].state == 3 || t[i].state == 4) { cnt++; sx += t[i].normalized.position.x; sy += t[i].normalized.position.y; }
  if (cnt == 0) {
    if (active && !fired) logf_("four fingers, no swipe (travel %.2f)", peak);
    active = fired = blocked = 0; peak = 0; return 0;
  }
  if (cnt > 4) { blocked = 1; active = 0; return 0; }          // five fingers: a pinch, not this
  if (cnt != 4 || blocked) { active = 0; return 0; }
  double x = sx / 4, y = sy / 4;
  if (!active) { active = 1; startX = x; startY = y; startT = ts; peak = 0; return 0; }
  double dy = (y - startY) * (swipeUp ? 1 : -1), dx = x - startX;     // the pad's y grows upward
  if (dy > peak) peak = dy;
  if (!fired && dy >= needDY && fabs(dx) <= dy * 0.8 && ts - startT < 1.5) {
    fired = 1;
    time_t wall = time(NULL);
    if (difftime(wall, (time_t)lastFire) >= 0.8) { lastFire = (double)wall; closeWindow(); logf_("swipe %s: dy %.2f dx %.2f -> cmd+w", swipeUp ? "up" : "down", dy, dx); }
  }
  return 0;
}

int main(void) {
  logPath = getenv("FFC_LOG");
  if (getenv("FFC_DY")) needDY = atof(getenv("FFC_DY"));
  swipeUp = getenv("FFC_UP") && getenv("FFC_UP")[0] == '1';
  const void *keys[] = { kAXTrustedCheckOptionPrompt }, *vals[] = { getenv("FFC_NOPROMPT") ? kCFBooleanFalse : kCFBooleanTrue };
  CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  logf_("accessibility trusted: %d", AXIsProcessTrustedWithOptions(opts));
  CFMutableArrayRef list = MTDeviceCreateList();
  CFIndex n = list ? CFArrayGetCount(list) : 0;
  for (CFIndex i = 0; i < n; i++) { MTDeviceRef d = (MTDeviceRef)CFArrayGetValueAtIndex(list, i); MTRegisterContactFrameCallback(d, onFrame); MTDeviceStart(d, 0); }
  logf_("multitouch devices: %ld, need %.2f of the pad's height %s", (long)n, needDY, swipeUp ? "up" : "down");
  if (n == 0) return 1;
  CFRunLoopRun();
  return 0;
}
