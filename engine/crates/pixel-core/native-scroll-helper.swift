import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let scale = NSScreen.main?.backingScaleFactor ?? 2.0
print("scale \(scale)")
fflush(stdout)

NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { event in
    let precise = event.hasPreciseScrollingDeltas ? 1 : 0
    print("s \(event.scrollingDeltaY) \(event.phase.rawValue) \(event.momentumPhase.rawValue) \(precise)")
    fflush(stdout)
}

DispatchQueue.global().async {
    while readLine() != nil {}
    
    exit(0)
}

app.run()
