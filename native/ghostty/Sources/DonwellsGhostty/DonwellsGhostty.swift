import AppKit
import GhosttyTerminal
import GhosttyTheme

private let callbackLock = NSLock()
nonisolated(unsafe) private var callback: (@convention(c) (UnsafePointer<CChar>) -> Void)?
@_cdecl("dw_emit") public func setCallback(_ next: (@convention(c) (UnsafePointer<CChar>) -> Void)?) {
    callbackLock.lock(); defer { callbackLock.unlock() }; callback = next
}
private func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    let text = String(decoding: data, as: UTF8.self)
    callbackLock.lock(); defer { callbackLock.unlock() }
    text.withCString { callback?($0) }
}

@MainActor private final class TerminalView: AppTerminalView {
    weak var owner: Surface?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if owner?.shortcut(event) == true { return true }
        if NSApp.mainMenu?.performKeyEquivalent(with: event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) {
        if owner?.shortcut(event) != true { super.keyDown(with: event) }
    }
}

@MainActor private final class Surface: NSView, NSSearchFieldDelegate, TerminalSurfaceSearchDelegate,
    TerminalSurfaceFocusDelegate, TerminalSurfaceOpenURLDelegate, TerminalSurfaceClipboardConfirmationDelegate {
    let id: String
    let terminal = TerminalView(frame: .zero)
    let session: InMemoryTerminalSession
    let controller: TerminalController
    let search = NSSearchField(frame: .zero)
    let results = NSTextField(labelWithString: "")
    let previous = NSButton(title: "↑", target: nil, action: nil)
    let next = NSButton(title: "↓", target: nil, action: nil)
    let close = NSButton(title: "×", target: nil, action: nil)
    var finding = false
    var total = -1
    var selected = -1
    var connected = false
    var shortcuts: [String: String] = [:]

    init(id: String, configuration: String) {
        self.id = id
        session = InMemoryTerminalSession(write: { emit(["id": id, "type": "input", "data": $0.base64EncodedString()]) },
            resize: { emit(["id": id, "type": "resize", "cols": $0.columns, "rows": $0.rows]) }, suppressesPixelOnlyResizes: true)
        controller = TerminalController(configSource: .generated(configuration), theme: TerminalTheme())
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor(srgbRed: 22/255, green: 22/255, blue: 29/255, alpha: 1).cgColor
        terminal.owner = self
        terminal.controller = controller
        terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        terminal.delegate = self
        addSubview(terminal)
        search.placeholderString = "Find in terminal"
        search.setAccessibilityLabel("Find in terminal")
        search.delegate = self
        search.sendsSearchStringImmediately = true
        search.target = self; search.action = #selector(searchChanged)
        previous.target = self; previous.action = #selector(previousResult)
        next.target = self; next.action = #selector(nextResult)
        close.target = self; close.action = #selector(closeFind)
        previous.setAccessibilityLabel("Previous result")
        next.setAccessibilityLabel("Next result")
        close.setAccessibilityLabel("Close terminal search")
        for view in [search, results, previous, next, close] { view.isHidden = true; addSubview(view) }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        let bar: CGFloat = finding ? 32 : 0
        terminal.frame = NSRect(x: 0, y: bar, width: bounds.width, height: max(0, bounds.height-bar))
        let inputWidth = max(60, bounds.width-180)
        search.frame = NSRect(x: 6, y: 4, width: inputWidth, height: 24)
        results.frame = NSRect(x: inputWidth+12, y: 8, width: 70, height: 20)
        previous.frame = NSRect(x: bounds.width-90, y: 3, width: 28, height: 26)
        next.frame = NSRect(x: bounds.width-60, y: 3, width: 28, height: 26)
        close.frame = NSRect(x: bounds.width-30, y: 3, width: 28, height: 26)
    }
    func shortcut(_ event: NSEvent) -> Bool {
        let special: [UInt16: String] = [36: "enter", 48: "tab", 49: "space", 51: "backspace", 53: "escape", 123: "arrowleft", 124: "arrowright", 125: "arrowdown", 126: "arrowup"]
        let rawKey = special[event.keyCode] ?? (event.charactersIgnoringModifiers ?? "").lowercased()
        let key = rawKey == "," ? "comma" : rawKey
        let flags = event.modifierFlags
        let modifiers = [(flags.contains(.command), "command"), (flags.contains(.control), "control"), (flags.contains(.option), "alt"), (flags.contains(.shift), "shift")].filter { $0.0 }.map { $0.1 }.sorted()
        guard let command = shortcuts[(modifiers + [key]).joined(separator: "+")] else { return false }
        if command == "find" { find() } else { emit(["id": id, "type": "shortcut", "command": command]) }
        return true
    }
    func find() {
        finding = true
        for view in [search, results, previous, next, close] { view.isHidden = false }
        needsLayout = true
        window?.makeFirstResponder(search)
    }
    @objc func closeFind() {
        finding = false; search.stringValue = ""; results.stringValue = ""
        terminal.performBindingAction("end_search")
        for view in [search, results, previous, next, close] { view.isHidden = true }
        needsLayout = true
        if connected { terminal.acquireProgrammaticFocus() }
    }
    @objc func searchChanged() { terminal.performBindingAction("search:" + search.stringValue) }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) { closeFind(); return true }
        if selector == #selector(NSResponder.insertNewline(_:)) {
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { previousResult() } else { nextResult() }
            return true
        }
        return false
    }
    @objc func previousResult() { terminal.performBindingAction("navigate_search:previous") }
    @objc func nextResult() { terminal.performBindingAction("navigate_search:next") }
    func terminalDidUpdateSearch(total: Int?, selected: Int?) {
        if let total { self.total = total }
        if let selected { self.selected = selected }
        results.stringValue = self.total < 0 ? "Searching…" : self.total == 0 ? "No results" : self.selected < 0 ? "\(self.total) matches" : "\(self.selected+1) of \(self.total)"
    }
    func terminalDidRequestSearch(_ needle: String?) { find(); if let needle { search.stringValue = needle; searchChanged() } }
    func terminalDidEndSearch() { if finding { finding = false; for view in [search, results, previous, next, close] { view.isHidden = true }; needsLayout = true } }
    func terminalDidChangeFocus(_ focused: Bool) { emit(["id": id, "type": "focus", "focused": focused]) }
    func terminalDidRequestOpenURL(_ url: String, kind: TerminalOpenURLKind) { emit(["id": id, "type": "url", "url": url]) }
    func terminalDidRequestClipboardConfirmation(_ request: TerminalClipboardConfirmationRequest) {
        request.respond(allow: request.kind == .paste && connected)
    }
}

@MainActor private var surfaces: [String: Surface] = [:]
@_cdecl("dw_request") public func request(_ pointer: UnsafeMutableRawPointer?, _ json: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return strdup("{\"error\":\"Native terminal requires the main thread\"}") }
    let jsonText = String(cString: json), address = pointer.map { UInt(bitPattern: $0) }
    let response: String = MainActor.assumeIsolated {
        do {
            guard let req = try JSONSerialization.jsonObject(with: Data(jsonText.utf8)) as? [String: Any],
                let id = req["id"] as? String, !id.isEmpty, let op = req["op"] as? String else { return "{\"error\":\"Invalid native request\"}" }
            var result: [String: Any] = ["ok": true]
            if op == "create" {
                guard let address, let pointer = UnsafeMutableRawPointer(bitPattern: address), surfaces[id] == nil,
                    let configuration = req["configuration"] as? String else { return "{\"error\":\"Invalid native surface\"}" }
                let container = Unmanaged<NSView>.fromOpaque(pointer).takeUnretainedValue()
                let surface = Surface(id: id, configuration: configuration)
                surface.shortcuts = req["shortcuts"] as? [String: String] ?? [:]
                surface.isHidden = true
                container.addSubview(surface, positioned: .above, relativeTo: nil)
                surfaces[id] = surface
            } else if op == "themes" {
                // Ghostty's own theme collection, compiled into the vendored wrapper.
                result["themes"] = GhosttyThemeCatalog.allThemes.map { theme -> [String: Any] in
                    var palette: [String: String] = [:]
                    for (index, color) in theme.palette { palette[String(index)] = color }
                    var entry: [String: Any] = [
                        "name": theme.name, "background": theme.background, "foreground": theme.foreground, "palette": palette
                    ]
                    if let cursor = theme.cursorColor { entry["cursor"] = cursor }
                    if let text = theme.cursorText { entry["cursorText"] = text }
                    if let selection = theme.selectionBackground { entry["selectionBackground"] = selection }
                    if let selectionText = theme.selectionForeground { entry["selectionForeground"] = selectionText }
                    return entry
                }
            } else if let surface = surfaces[id] {
                switch op {
                case "write":
                    guard let data = req["data"] as? String else { return "{\"error\":\"Invalid terminal data\"}" }
                    surface.session.receive(data)
                case "reset": surface.session.receive("\u{1b}c")
                case "geometry":
                    if let size = surface.session.viewport { result["cols"] = size.columns; result["rows"] = size.rows }
                case "snapshot":
                    guard let chunks = req["chunks"] as? [[String: Any]],
                        let columns = req["cols"] as? UInt16, let rows = req["rows"] as? UInt16 else { return "{\"error\":\"Invalid replay grid\"}" }
                    surface.session.waitForPendingOutput()
                    var first = true
                    for chunk in chunks {
                        guard let data = chunk["data"] as? String, let cols = chunk["cols"] as? UInt16, let rows = chunk["rows"] as? UInt16,
                            surface.session.replay((first ? "\u{1b}c" : "") + data, columns: cols, rows: rows) else { return "{\"error\":\"Replay surface is not ready\"}" }
                        first = false
                    }
                    guard surface.session.replay(first ? "\u{1b}c" : "", columns: columns, rows: rows) else { return "{\"error\":\"Replay surface is not ready\"}" }
                    surface.session.waitForPendingOutput()
                case "connected": surface.connected = req["value"] as? Bool == true
                case "focus": result["ok"] = surface.connected && surface.terminal.acquireProgrammaticFocus()
                case "find": surface.find()
                case "configuration":
                    surface.shortcuts = req["shortcuts"] as? [String: String] ?? surface.shortcuts
                    if let configuration = req["configuration"] as? String { result["ok"] = surface.controller.updateConfigSource(.generated(configuration)) }
                case "bounds":
                    if let parent = surface.superview, let x = req["x"] as? Double, let y = req["y"] as? Double,
                        let width = req["width"] as? Double, let height = req["height"] as? Double,
                        [x,y,width,height].allSatisfy({ $0.isFinite }), width > 0, height > 0 {
                        surface.frame = NSRect(x: x, y: parent.isFlipped ? y : parent.bounds.height-y-height, width: width, height: height)
                        surface.layoutSubtreeIfNeeded()
                        surface.isHidden = false; surface.terminal.setSurfaceVisible(true)
                    } else {
                        result["focused"] = surface.window?.firstResponder === surface.terminal || surface.window?.firstResponder === surface.search.currentEditor()
                        surface.isHidden = true; surface.terminal.setSurfaceVisible(false)
                    }
                case "destroy": surface.removeFromSuperview(); surfaces.removeValue(forKey: id)
                case "read":
                    result["text"] = surface.session.readViewportText() ?? ""
                    result["searchTotal"] = surface.total; result["searchSelected"] = surface.selected
                    result["visible"] = !surface.isHidden; result["finding"] = surface.finding
                default: result = ["error": "Unknown native terminal operation"]
                }
            } else if op != "destroy" { result = ["error": "Native terminal is no longer attached"] }
            return String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        } catch { return "{\"error\":\"Invalid native terminal JSON\"}" }
    }
    return strdup(response)
}
