import Foundation

public enum Provider: String, Sendable, CaseIterable {
    case budget = "codemie-budget"
    case claude = "codemie-claude"
}

/// Builds the wire payload dictionaries of `docs/design/plugin-protocol.md`.
/// Optional window fields are emitted as explicit nulls, mirroring the
/// documented example payload.
public enum SnapshotBuilder {
    /// Money amounts as exact Decimals: JSONSerialization prints Doubles at
    /// full precision (45.789999999999999), Decimals at face value (45.79).
    static func cents(_ value: Double) -> Decimal {
        Decimal((value * 100).rounded()) / 100
    }

    /// percent → fraction, clamped below at 0, allowed past 1 (overspend),
    /// rounded to 6 decimal places for clean wire output.
    static func fraction(_ percent: Double) -> Decimal {
        Decimal((max(0, percent) * 10_000).rounded()) / 1_000_000
    }

    static func dollars(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// One window for a budget row. `money` + `detail` when the limit is
    /// known, otherwise `usedText`; `usedFraction` from the percentage either
    /// way, clamped below at 0 but allowed past 1 (overspend).
    public static func window(id: String, label: String, row: BudgetRow) -> [String: Any] {
        var money: Any = NSNull()
        var usedText: Any = NSNull()
        var detail: Any = NSNull()
        if let spent = row.spent, let limit = row.limit {
            money = [
                "currency": "USD",
                "spent": cents(spent),
                "remaining": cents(max(0, limit - spent)),
            ]
            detail = "\(dollars(spent)) of \(dollars(limit))"
        } else if let spent = row.spent {
            usedText = "\(dollars(spent)) spent"
        }
        var usedFraction: Any = NSNull()
        if let percent = row.percent {
            usedFraction = fraction(percent)
        }
        var resetsAt: Any = NSNull()
        if let date = row.resetsAt {
            resetsAt = iso(date)
        }
        return [
            "id": id,
            "label": label,
            "usedFraction": usedFraction,
            "group": NSNull(),
            "remaining": NSNull(),
            "used": NSNull(),
            "usedText": usedText,
            "detail": detail,
            "money": money,
            "resetsAt": resetsAt,
        ]
    }

    /// Payload for `codemie-budget`: every budget bucket on the account, led
    /// by a synthesized "Total budget" headline window that sums them. The
    /// budget card answers "how much is left overall"; `codemie-claude` leads
    /// with the CLI bucket its sessions spend from instead.
    /// Returns nil when no rows match the account (the exit-5 path).
    public static func budgetPayload(rows: [BudgetRow], config: CodemieConfig) -> [String: Any]? {
        guard let email = config.userEmail else { return nil }
        let buckets = BudgetRows.buckets(in: rows, email: email)
        guard !buckets.isEmpty else { return nil }
        var windows: [[String: Any]] = []
        let headlineID: String
        if buckets.count > 1 {
            // A total over one bucket is that bucket repeated — only worth a
            // window of its own when it actually adds up.
            windows.append(totalWindow(rows: buckets.map(\.row)))
            headlineID = "budget-total"
        } else {
            headlineID = buckets[0].id
        }
        windows.append(contentsOf: buckets.map { window(id: $0.id, label: $0.label, row: $0.row) })
        return envelope(headlineID: headlineID, windows: windows, config: config)
    }

    /// The headline window: spend and remaining summed across every bucket.
    /// Rows without a stated limit contribute their spend but no remaining —
    /// inventing a denominator for them would dress a guess up as a quota.
    static func totalWindow(rows: [BudgetRow]) -> [String: Any] {
        let spent = rows.reduce(0.0) { $0 + ($1.spent ?? 0) }
        let limited = rows.filter { $0.limit != nil }
        var money: Any = NSNull()
        var usedText: Any = NSNull()
        var detail: Any = NSNull()
        var usedFraction: Any = NSNull()
        if !limited.isEmpty {
            let remaining = limited.reduce(0.0) { $0 + max(0, ($1.limit ?? 0) - ($1.spent ?? 0)) }
            let funded = spent + remaining
            money = ["currency": "USD", "spent": cents(spent), "remaining": cents(remaining)]
            detail = "\(dollars(spent)) of \(dollars(funded))"
            if funded > 0 { usedFraction = fraction(spent / funded * 100) }
        } else {
            usedText = "\(dollars(spent)) spent"
        }
        var resetsAt: Any = NSNull()
        if let earliest = rows.compactMap(\.resetsAt).min() {
            resetsAt = iso(earliest)
        }
        return [
            "id": "budget-total",
            "label": "Total budget",
            "usedFraction": usedFraction,
            "group": NSNull(),
            "remaining": NSNull(),
            "used": NSNull(),
            "usedText": usedText,
            "detail": detail,
            "money": money,
            "resetsAt": resetsAt,
        ]
    }

    /// Payload for `codemie-claude`: one window per account bucket.
    /// Returns nil when no rows match the account (the exit-5 path).
    public static func claudePayload(rows: [BudgetRow], config: CodemieConfig) -> [String: Any]? {
        guard let email = config.userEmail else { return nil }
        let buckets = BudgetRows.buckets(in: rows, email: email)
        guard !buckets.isEmpty else { return nil }
        let windows = buckets.map { window(id: $0.id, label: $0.label, row: $0.row) }
        let headlineID = buckets.contains { $0.suffix == "cli" } ? "bucket-cli" : buckets[0].id
        return envelope(headlineID: headlineID, windows: windows, config: config)
    }

    static func envelope(headlineID: String, windows: [[String: Any]], config: CodemieConfig) -> [String: Any] {
        let plan: Any = config.provider ?? NSNull()
        let label: Any = config.userEmail ?? NSNull()
        let manageURL: Any = config.codeMieUrl ?? NSNull()
        return [
            "fidelity": "official",
            "plan": plan,
            "headlineID": headlineID,
            "weeklyID": NSNull(),
            "account": [
                "label": label,
                "plan": plan,
                "source": "CodeMie CLI",
                "manageURL": manageURL,
            ],
            "windows": windows,
        ]
    }

    /// Deterministic pretty JSON, matching the protocol document's shape.
    public static func jsonString(_ payload: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: payload,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        ) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
