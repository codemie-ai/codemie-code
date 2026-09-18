import Foundation

/// One row of the `budget_usage` response, read tolerantly: the CodeMie
/// backend has shipped more than one spelling of the same fields.
public struct BudgetRow: @unchecked Sendable { // immutable after JSON parsing
    public let raw: [String: Any]

    public init(raw: [String: Any]) {
        self.raw = raw
    }

    public var projectName: String? {
        raw["project_name"] as? String
    }

    public var spent: Double? {
        number("current_spending") ?? number("spend")
    }

    public var limit: Double? {
        number("max_budget") ?? number("budget_limit") ?? number("limit")
    }

    public var percent: Double? {
        if let total = number("total") { return total }
        guard let spent, let limit, limit > 0 else { return nil }
        return spent / limit * 100
    }

    public var resetsAt: Date? {
        guard let value = raw["budget_reset_at"] as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.parse(value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.parse(value)
    }

    private func number(_ key: String) -> Double? {
        guard let value = raw[key] else { return nil }
        switch value {
        case let number as NSNumber:
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            return number.doubleValue
        case let string as String:
            return Double(string)
        default:
            return nil
        }
    }
}

private extension ISO8601DateFormatter {
    func parse(_ value: String) -> Date? { date(from: value) }
}

public enum BudgetRows {
    /// Parses the `{"data": {"rows": [...]}}` envelope; tolerates the rows
    /// array sitting at the top level as well.
    public static func parse(_ data: Data) -> [BudgetRow]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var rawRows = (root["data"] as? [String: Any])?["rows"] as? [[String: Any]]
        if rawRows == nil { rawRows = root["rows"] as? [[String: Any]] }
        guard let rawRows else { return nil }
        return rawRows.map(BudgetRow.init(raw:))
    }

    static func normalized(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// The `"<email> (cli)"` row carrying CLI agent spend.
    public static func cliRow(in rows: [BudgetRow], email: String) -> BudgetRow? {
        let target = "\(normalized(email)) (cli)"
        return rows.first { $0.projectName.map(normalized) == target }
    }

    public struct Bucket: Sendable {
        public var suffix: String?
        public var row: BudgetRow

        /// `bucket-cli` / `bucket-web` / `bucket-<suffix>`.
        public var id: String {
            guard let suffix else { return "bucket-web" }
            return "bucket-\(suffix)"
        }

        public var label: String {
            switch suffix {
            case "cli": return "CLI spend"
            case nil: return "Platform spend"
            case "premium": return "Premium spend"
            case let suffix?: return "\(suffix.prefix(1).uppercased())\(suffix.dropFirst()) spend"
            }
        }
    }

    /// Every row bucketed to this account: the bare `"<email>"` row plus all
    /// `"<email> (<bucket>)"` rows. Ordered cli first, then the bare-email
    /// (web) row, then the rest alphabetically by suffix.
    public static func buckets(in rows: [BudgetRow], email: String) -> [Bucket] {
        let account = normalized(email)
        let prefix = "\(account) ("
        var matched: [Bucket] = []
        for row in rows {
            guard let name = row.projectName.map(normalized) else { continue }
            if name == account {
                matched.append(Bucket(suffix: nil, row: row))
            } else if name.hasPrefix(prefix), name.hasSuffix(")") {
                let suffix = String(name.dropFirst(prefix.count).dropLast())
                matched.append(Bucket(suffix: suffix, row: row))
            }
        }
        return matched.sorted { lhs, rhs in
            rank(lhs) < rank(rhs) || (rank(lhs) == rank(rhs) && (lhs.suffix ?? "") < (rhs.suffix ?? ""))
        }
    }

    private static func rank(_ bucket: Bucket) -> Int {
        switch bucket.suffix {
        case "cli": return 0
        case nil: return 1
        default: return 2
        }
    }
}
