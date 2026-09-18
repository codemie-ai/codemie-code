import Foundation

/// A short-lived copy of the parsed `rows` array at
/// `$CODEMIE_HOME/codenotch-budget-cache.json`, so Codenotch polling every few
/// seconds doesn't hit the CodeMie backend each time. Never touches CodeMie's
/// own `budget-cache.json`.
public struct BudgetCache: Sendable {
    public static let ttl: TimeInterval = 60

    public let url: URL

    public init(home: URL) {
        url = home.appendingPathComponent("codenotch-budget-cache.json")
    }

    init(url: URL) {
        self.url = url
    }

    /// Rows younger than the TTL; nil when missing, malformed or expired.
    public func loadFresh(now: Date = Date()) -> [[String: Any]]? {
        guard let entry = load() else { return nil }
        let age = now.timeIntervalSince1970 - entry.timestamp
        return age >= 0 && age < Self.ttl ? entry.rows : nil
    }

    /// Rows regardless of age, for serving when the network is down.
    public func loadStale() -> [[String: Any]]? {
        load()?.rows
    }

    public func save(rows: [[String: Any]], now: Date = Date()) {
        let payload: [String: Any] = [
            "schema": 1,
            "ts": Int64(now.timeIntervalSince1970 * 1000),
            "rows": rows,
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        try? data.write(to: url, options: .atomic)
    }

    private func load() -> (timestamp: TimeInterval, rows: [[String: Any]])? {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["schema"] as? Int) == 1,
              let millis = (root["ts"] as? NSNumber)?.int64Value,
              let rows = root["rows"] as? [[String: Any]] else { return nil }
        return (TimeInterval(millis) / 1000, rows)
    }
}
