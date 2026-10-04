import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision

struct Node: Codable {
    let role: String
    let text: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let actions: [String]
}

// Read-only focus probe. Native App automation currently requires foreground
// controls; never redirect input to whatever unrelated app the user selected.
func nativeIsForeground() -> Bool {
    NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.xingin.discover"
}

func requireNativeForeground() {
    guard nativeIsForeground() else {
        FileHandle.standardError.write(Data("native_app_not_frontmost\n".utf8))
        exit(78)
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as AnyObject?
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    return String(describing: value).replacingOccurrences(of: "\n", with: " ")
}

func frame(_ element: AXUIElement) -> CGRect {
    var point = CGPoint.zero
    var size = CGSize.zero
    if let rawValue = attribute(element, kAXPositionAttribute) {
        AXValueGetValue(rawValue as! AXValue, .cgPoint, &point)
    }
    if let rawValue = attribute(element, kAXSizeAttribute) {
        AXValueGetValue(rawValue as! AXValue, .cgSize, &size)
    }
    return CGRect(origin: point, size: size)
}

func textOf(_ element: AXUIElement) -> String {
    for key in [kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute] {
        let value = stringAttribute(element, key).trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { return value }
    }
    return ""
}

func application() -> AXUIElement {
    guard CommandLine.arguments.count > 2, let pid = pid_t(CommandLine.arguments[2]) else { exit(2) }
    return AXUIElementCreateApplication(pid)
}

func walk(_ element: AXUIElement, depth: Int = 0, _ body: (AXUIElement) -> Bool) -> Bool {
    if depth > 16 { return false }
    if body(element) { return true }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children where walk(child, depth: depth + 1, body) { return true }
    }
    return false
}

func snapshot(_ root: AXUIElement) -> [Node] {
    var output: [Node] = []
    _ = walk(root) { element in
        let role = stringAttribute(element, kAXRoleAttribute)
        guard ["AXStaticText", "AXButton", "AXGenericElement", "AXTextField", "AXTextArea"].contains(role) else { return false }
        let rect = frame(element)
        guard rect.width > 1, rect.height > 1 else { return false }
        var names: CFArray?
        AXUIElementCopyActionNames(element, &names)
        output.append(Node(
            role: role,
            text: textOf(element),
            x: Int(rect.origin.x), y: Int(rect.origin.y),
            width: Int(rect.width), height: Int(rect.height),
            actions: names as? [String] ?? []
        ))
        return false
    }
    return output
}

func jsonPrint<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(value) else { exit(3) }
    print(String(data: data, encoding: .utf8) ?? "{}")
}

func pressText(_ root: AXUIElement, wanted: String) -> Bool {
    var pressed = false
    _ = walk(root) { element in
        guard textOf(element).trimmingCharacters(in: .whitespacesAndNewlines) == wanted else { return false }
        pressed = AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
        return pressed
    }
    return pressed
}

func visibleTextArea(_ root: AXUIElement) -> AXUIElement? {
    var matches: [(AXUIElement, CGRect)] = []
    _ = walk(root) { element in
        guard stringAttribute(element, kAXRoleAttribute) == "AXTextArea" else { return false }
        let rect = frame(element)
        if rect.width > 100, rect.height > 15 { matches.append((element, rect)) }
        return false
    }
    return matches.sorted { $0.1.origin.y > $1.1.origin.y }.first?.0
}

func click(point: CGPoint) {
    requireNativeForeground()
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(100_000)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func scroll(point: CGPoint, delta: Int32) {
    requireNativeForeground()
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func pressImageButton(_ root: AXUIElement) -> Bool {
    guard let area = visibleTextArea(root) else { return false }
    let areaFrame = frame(area)
    var candidates: [(AXUIElement, CGRect)] = []
    _ = walk(root) { element in
        guard stringAttribute(element, kAXRoleAttribute) == "AXButton", textOf(element).isEmpty else { return false }
        let rect = frame(element)
        let y = rect.midY
        if rect.width >= 14, rect.width <= 32,
           y > areaFrame.maxY + 4, y < areaFrame.maxY + 70,
           rect.origin.x >= areaFrame.origin.x - 15, rect.origin.x < areaFrame.origin.x + 180 {
            candidates.append((element, rect))
        }
        return false
    }
    guard let target = candidates.sorted(by: { $0.1.origin.x < $1.1.origin.x }).first else { return false }
    if AXUIElementPerformAction(target.0, kAXPressAction as CFString) == .success { return true }
    click(point: CGPoint(x: target.1.midX, y: target.1.midY))
    return true
}

func windowInfo() -> [String: Int]? {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let row = rows.first(where: { String(describing: $0[kCGWindowOwnerName as String] ?? "").lowercased() == "rednote" }),
          let bounds = row[kCGWindowBounds as String] as? [String: CGFloat],
          let number = row[kCGWindowNumber as String] as? Int else { return nil }
    return [
        "id": number, "x": Int(bounds["X"] ?? 0), "y": Int(bounds["Y"] ?? 0),
        "width": Int(bounds["Width"] ?? 0), "height": Int(bounds["Height"] ?? 0)
    ]
}

struct OCRRow: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Float
}

func ocr(path: String) throws -> [OCRRow] {
    let url = URL(fileURLWithPath: path)
    guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return OCRRow(text: candidate.string, x: box.origin.x, y: box.origin.y, width: box.width, height: box.height, confidence: candidate.confidence)
    }
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
switch command {
case "foreground":
    struct ForegroundState: Encodable { let ok: Bool; let frontmost: Bool; let bundleId: String }
    jsonPrint(ForegroundState(ok: true, frontmost: nativeIsForeground(), bundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""))
case "window":
    if let value = windowInfo() { jsonPrint(value) } else { exit(4) }
case "snapshot":
    jsonPrint(snapshot(application()))
case "press":
    requireNativeForeground()
    guard CommandLine.arguments.count > 3 else { exit(2) }
    print(pressText(application(), wanted: CommandLine.arguments[3]) ? "ok" : "not_found")
case "set-comment":
    requireNativeForeground()
    guard CommandLine.arguments.count > 3, let area = visibleTextArea(application()) else { exit(5) }
    let ok = AXUIElementSetAttributeValue(area, kAXValueAttribute as CFString, CommandLine.arguments[3] as CFTypeRef) == .success
    print(ok ? "ok" : "failed")
case "image-button":
    requireNativeForeground()
    print(pressImageButton(application()) ? "ok" : "not_found")
case "clipboard-image":
    requireNativeForeground()
    guard CommandLine.arguments.count > 2 else { exit(2) }
    let url = URL(fileURLWithPath: CommandLine.arguments[2])
    guard let image = NSImage(contentsOf: url) else { exit(6) }
    let board = NSPasteboard.general
    board.clearContents()
    print(board.writeObjects([image]) ? "ok" : "failed")
case "click":
    guard CommandLine.arguments.count > 3 else { exit(2) }
    let parts = CommandLine.arguments[3].split(separator: ",").compactMap { Double($0) }
    guard parts.count == 2 else { exit(2) }
    click(point: CGPoint(x: parts[0], y: parts[1])); print("ok")
case "scroll":
    guard CommandLine.arguments.count > 3 else { exit(2) }
    let parts = CommandLine.arguments[3].split(separator: ",").compactMap { Double($0) }
    guard parts.count == 3 else { exit(2) }
    scroll(point: CGPoint(x: parts[0], y: parts[1]), delta: Int32(parts[2])); print("ok")
case "ocr":
    guard CommandLine.arguments.count > 2 else { exit(2) }
    jsonPrint(try ocr(path: CommandLine.arguments[2]))
default:
    exit(2)
}
