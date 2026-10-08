import CoreGraphics
import Foundation

while let line = readLine() {
  guard let pid = Int32(line) else { continue }
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let matches = windows.compactMap { item -> [String: Any]? in
    guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
      let bounds = item[kCGWindowBounds as String] as? [String: NSNumber],
      let width = bounds["Width"]?.doubleValue,
      abs(width - 360) <= 2,
      let height = bounds["Height"]?.doubleValue,
      height > 60,
      let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
      alpha > 0 else { return nil }
    return ["x": bounds["X"]!.doubleValue, "y": bounds["Y"]!.doubleValue, "width": width, "height": height, "alpha": alpha]
  }
  let result: [String: Any] = ["at": Date().timeIntervalSince1970 * 1000, "visible": !matches.isEmpty, "panels": matches]
  let json = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  print(String(data: json, encoding: .utf8)!)
  fflush(stdout)
}
