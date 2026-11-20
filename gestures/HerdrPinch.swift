// Trackpad pinch anywhere in Herdr (terminals included) runs git through the VNH mods:
// spreading out (zoom in) -> `herdr-app do vnh-tabs.git-pull`, pinching in (zoom out) ->
// `herdr-app do vnh-tabs.git-push`. Mods only see pinches over what they draw, and a terminal
// isn't a mod, hence this small agent. It reacts only while Herdr is the frontmost app, once per
// gesture, past a clear pinch (+0.35 / -0.3 of scale), at most every 3 s. Log: HERDR_PINCH_LOG.
import AppKit

let herdrBundle = "dev.herdr.app"
let herdrApp = ProcessInfo.processInfo.environment["HERDR_APP"] ?? "/usr/local/bin/herdr-app"
let logPath = ProcessInfo.processInfo.environment["HERDR_PINCH_LOG"]
var sum: CGFloat = 0
var last = Date.distantPast

func log(_ s: String) {
  guard let path = logPath, let data = "\(Date()) \(s)\n".data(using: .utf8) else { return }
  if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(data); h.closeFile() }
  else { FileManager.default.createFile(atPath: path, contents: data) }
}

func herdr(_ command: String) {
  last = Date()
  let p = Process()
  p.executableURL = URL(fileURLWithPath: herdrApp)
  p.arguments = ["do", command, "{}"]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run(); log("ran \(command)") } catch { log("failed \(command): \(error)") }
}

func ended() {
  defer { sum = 0 }
  log(String(format: "gesture %.2f", sum))
  guard Date().timeIntervalSince(last) > 3 else { return }
  if sum >= 0.35 { herdr("vnh-tabs.git-pull") } else if sum <= -0.3 { herdr("vnh-tabs.git-push") }
}

// Gestures of other apps reach a background agent only with Accessibility: ask for it (macOS
// shows its prompt once), then listen through a listen-only event tap, which never blocks or
// changes an event.
let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
log("accessibility trusted: \(trusted)")

func onMagnify(_ e: NSEvent) {
  guard e.type == .magnify else { return }
  guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == herdrBundle else { sum = 0; return }
  switch e.phase {
  case .began: sum = 0
  case .changed: sum += e.magnification
  case .ended: sum += e.magnification; ended()
  case .cancelled: sum = 0
  default: break
  }
}

// NSEvent types 29 (gesture) and 30 (magnify): CGEventMask has no names for them.
let mask: CGEventMask = (1 << 29) | (1 << 30)
let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
  callback: { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(event) }
    if let e = NSEvent(cgEvent: event) { onMagnify(e) }
    return Unmanaged.passUnretained(event)
  }, userInfo: nil)
if let tap = tap {
  let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  log("event tap on")
} else {
  log("event tap refused: grant Accessibility to \(CommandLine.arguments[0]) in System Settings > Privacy & Security, then restart the agent")
}
// The global monitor too, for systems that deliver gestures there.
NSEvent.addGlobalMonitorForEvents(matching: [.magnify], handler: onMagnify)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
log("started; herdr-app at \(herdrApp)")
app.run()
