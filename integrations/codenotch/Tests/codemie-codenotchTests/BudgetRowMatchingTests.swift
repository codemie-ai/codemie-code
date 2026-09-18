import Foundation
import Testing
@testable import CodemieCodenotchCore

struct BudgetRowMatchingTests {
    let email = "you@example.com"

    func rowsFixture() -> [BudgetRow] {
        let json = """
        [
          {"project_name": "you@example.com (premium)", "current_spending": 1.0, "max_budget": 10.0, "total": 10.0},
          {"project_name": "  You@Example.com (CLI) ", "current_spending": 4.21, "max_budget": 50.0, "total": 8.42, "budget_reset_at": "2026-10-01T00:00:00Z"},
          {"project_name": "you@example.com", "current_spending": 12.5, "max_budget": 100.0, "total": 12.5},
          {"project_name": "someone-else@example.com (cli)", "current_spending": 9.99, "max_budget": 10.0, "total": 99.9},
          {"project_name": "you@example.com (alpha)", "current_spending": 2.0, "max_budget": 20.0, "total": 10.0}
        ]
        """
        let raw = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
        return raw.map(BudgetRow.init(raw:))
    }

    @Test func cliRowMatchesCaseInsensitiveAndTrimmed() {
        let row = BudgetRows.cliRow(in: rowsFixture(), email: email)
        #expect(row != nil)
        #expect(row?.spent == 4.21)
    }

    @Test func cliRowMissingReturnsNil() {
        let rows = rowsFixture().filter { $0.projectName?.contains("CLI") != true }
        #expect(BudgetRows.cliRow(in: rows, email: email) == nil)
    }

    @Test func bucketsEnumerateInOrderWithLabels() {
        let buckets = BudgetRows.buckets(in: rowsFixture(), email: email)
        #expect(buckets.map(\.id) == ["bucket-cli", "bucket-web", "bucket-alpha", "bucket-premium"])
        #expect(buckets.map(\.label) == ["CLI spend", "Platform spend", "Alpha spend", "Premium spend"])
    }

    @Test func bucketsExcludeOtherAccounts() {
        let buckets = BudgetRows.buckets(in: rowsFixture(), email: email)
        #expect(!buckets.contains { $0.row.projectName?.contains("someone-else") == true })
    }

    @Test func rowFieldFallbacks() {
        let row = BudgetRow(raw: ["spend": 3.5, "budget_limit": 7.0, "budget_reset_at": "2026-10-01T00:00:00.000Z"])
        #expect(row.spent == 3.5)
        #expect(row.limit == 7.0)
        #expect(row.percent == 50.0) // derived from spend/limit when total is absent
        #expect(row.resetsAt != nil) // fractional-seconds fallback

        let limited = BudgetRow(raw: ["current_spending": 4.21, "max_budget": 50.0, "total": 8.42])
        #expect(limited.percent == 8.42)
        #expect(limited.resetsAt == nil)

        let bare = BudgetRow(raw: [:])
        #expect(bare.spent == nil)
        #expect(bare.limit == nil)
        #expect(bare.percent == nil)
    }

    @Test func parseEnvelope() {
        let envelope = Data(#"{"data": {"rows": [{"project_name": "a"}]}, "meta": 1}"#.utf8)
        #expect(BudgetRows.parse(envelope)?.count == 1)
        let flat = Data(#"{"rows": [{"project_name": "a"}]}"#.utf8)
        #expect(BudgetRows.parse(flat)?.count == 1)
        #expect(BudgetRows.parse(Data(#"{"data": {}}"#.utf8)) == nil)
        #expect(BudgetRows.parse(Data("nope".utf8)) == nil)
    }
}
