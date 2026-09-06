import AppKit

// Disposable acceptance target: never opens a user document or writes outside its supplied receipt.
final class Fixture: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    let receipt = URL(fileURLWithPath: CommandLine.arguments[1])
    var actions: [[String: String]] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        for name in ["A", "B"] {
            let window = NSWindow(contentRect: NSRect(x: name == "A" ? 160 : 620, y: 200, width: 400, height: 180),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Donwells Control Fixture " + name
            window.isReleasedWhenClosed = false
            let button = NSButton(title: "Record " + name, target: self, action: #selector(record(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(name)
            button.frame = NSRect(x: 80, y: 70, width: 240, height: 40)
            window.contentView!.addSubview(button)
            window.makeKeyAndOrderFront(nil)
            windows.append(window)
        }
        NSApp.activate(ignoringOtherApps: true)
        Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { _ in NSApp.terminate(nil) }
    }

    @objc func record(_ sender: NSButton) {
        actions.append(["target": sender.identifier!.rawValue,
                        "frontmostPid": String(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)])
        do { try JSONSerialization.data(withJSONObject: actions).write(to: receipt, options: .atomic) }
        catch { fputs("Receipt failed: \(error)\n", stderr); NSApp.terminate(nil) }
        sender.title = "Recorded " + sender.identifier!.rawValue
    }
}

guard CommandLine.arguments.count == 2 else { fatalError("Expected disposable receipt path") }
let app = NSApplication.shared
let fixture = Fixture()
app.setActivationPolicy(.regular)
app.delegate = fixture
app.run()
