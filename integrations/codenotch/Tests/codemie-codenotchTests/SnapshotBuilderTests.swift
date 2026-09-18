import Foundation
import Testing
@testable import CodemieCodenotchCore

struct SnapshotBuilderTests {
    let config = CodemieConfig(
        activeProfile: "work",
        profiles: ["work": .init(baseUrl: "https://api.example.com", provider: "codemie-sso")],
        codeMieUrl: "https://codemie.example.com",
        userEmail: "you@example.com"
    )

    func fixtureRows() -> [BudgetRow] {
        let json = """
        [
          {"project_name": "you@example.com (cli)", "current_spending": 4.21, "max_budget": 50.0, "total": 8.42, "budget_reset_at": "2026-10-01T00:00:00Z"},
          {"project_name": "you@example.com", "current_spending": 12.5, "max_budget": 100.0, "total": 12.5, "budget_reset_at": "2026-10-01T00:00:00Z"}
        ]
        """
        let raw = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
        return raw.map(BudgetRow.init(raw:))
    }

    func decode(_ payload: [String: Any]) throws -> [String: Any] {
        // Round-trip through the printed JSON, exactly as Codenotch reads it.
        let data = try #require(SnapshotBuilder.jsonString(payload).data(using: .utf8))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func budgetPayloadShape() throws {
        let payload = try #require(SnapshotBuilder.budgetPayload(rows: fixtureRows(), config: config))
        let json = try decode(payload)

        #expect(json["fidelity"] as? String == "official")
        #expect(json["plan"] as? String == "codemie-sso")
        #expect(json["headlineID"] as? String == "budget-total")
        #expect(json["weeklyID"] is NSNull)

        let account = try #require(json["account"] as? [String: Any])
        #expect(account["label"] as? String == "you@example.com")
        #expect(account["plan"] as? String == "codemie-sso")
        #expect(account["source"] as? String == "CodeMie CLI")
        #expect(account["manageURL"] as? String == "https://codemie.example.com")

        let windows = try #require(json["windows"] as? [[String: Any]])
        #expect(windows.map { $0["id"] as? String } == ["budget-total", "bucket-cli", "bucket-web"])
        #expect(windows.map { $0["label"] as? String } == ["Total budget", "CLI spend", "Platform spend"])

        // Headline: the buckets summed — $16.71 of $150.00 funded.
        let total = windows[0]
        let usedFraction = try #require(total["usedFraction"] as? Double)
        #expect(abs(usedFraction - 16.71 / 150.0) < 1e-6)
        #expect(total["detail"] as? String == "$16.71 of $150.00")
        #expect(total["resetsAt"] as? String == "2026-10-01T00:00:00Z")
        #expect(total["usedText"] is NSNull)
        let money = try #require(total["money"] as? [String: Any])
        #expect(money["currency"] as? String == "USD")
        #expect(money["spent"] as? Double == 16.71)
        #expect(money["remaining"] as? Double == 133.29)

        // The buckets themselves, same as codemie-claude shows them.
        let cli = try #require(windows[1]["money"] as? [String: Any])
        #expect(cli["spent"] as? Double == 4.21)
        #expect(cli["remaining"] as? Double == 45.79)
        let web = try #require(windows[2]["money"] as? [String: Any])
        #expect(web["spent"] as? Double == 12.5)
        #expect(web["remaining"] as? Double == 87.5)
    }

    @Test func budgetSingleBucketGetsNoTotalWindow() throws {
        let rows = [BudgetRow(raw: [
            "project_name": "you@example.com (cli)",
            "current_spending": 4.21,
            "total": 42.1,
        ])]
        let payload = try #require(SnapshotBuilder.budgetPayload(rows: rows, config: config))
        let json = try decode(payload)
        #expect(json["headlineID"] as? String == "bucket-cli")
        let windows = try #require(json["windows"] as? [[String: Any]])
        #expect(windows.count == 1)
        let window = windows[0]
        #expect(window["id"] as? String == "bucket-cli")
        #expect(window["money"] is NSNull)
        #expect(window["usedText"] as? String == "$4.21 spent")
        let usedFraction = try #require(window["usedFraction"] as? Double)
        #expect(abs(usedFraction - 0.421) < 1e-9)
        #expect(window["detail"] is NSNull)
    }

    @Test func budgetTotalIgnoresLimitlessRowsForRemaining() throws {
        let json = """
        [
          {"project_name": "you@example.com (cli)", "current_spending": 4.21, "max_budget": 50.0},
          {"project_name": "you@example.com (premium)", "current_spending": 2.0}
        ]
        """
        let raw = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
        let rows = raw.map(BudgetRow.init(raw:))
        let payload = try #require(SnapshotBuilder.budgetPayload(rows: rows, config: config))
        let decoded = try decode(payload)
        let total = try #require((decoded["windows"] as? [[String: Any]])?.first)
        // $4.21 + $2.00 spent; remaining only from the limited cli bucket.
        let money = try #require(total["money"] as? [String: Any])
        #expect(money["spent"] as? Double == 6.21)
        #expect(money["remaining"] as? Double == 45.79)
        #expect(total["detail"] as? String == "$6.21 of $52.00")
    }

    @Test func budgetPayloadWithNoAccountRowsIsNil() {
        let rows = [BudgetRow(raw: ["project_name": "other@example.com (cli)"])]
        #expect(SnapshotBuilder.budgetPayload(rows: rows, config: config) == nil)
    }

    @Test func budgetWebOnlyAccountStillReports() throws {
        let rows = [BudgetRow(raw: ["project_name": "you@example.com", "current_spending": 3.0, "max_budget": 10.0])]
        let payload = try #require(SnapshotBuilder.budgetPayload(rows: rows, config: config))
        let json = try decode(payload)
        #expect(json["headlineID"] as? String == "bucket-web")
        let windows = try #require(json["windows"] as? [[String: Any]])
        #expect(windows.map { $0["id"] as? String } == ["bucket-web"])
    }

    @Test func claudePayloadShapeAndHeadline() throws {
        let payload = try #require(SnapshotBuilder.claudePayload(rows: fixtureRows(), config: config))
        let json = try decode(payload)
        #expect(json["headlineID"] as? String == "bucket-cli")

        let windows = try #require(json["windows"] as? [[String: Any]])
        #expect(windows.map { $0["id"] as? String } == ["bucket-cli", "bucket-web"])
        #expect(windows.map { $0["label"] as? String } == ["CLI spend", "Platform spend"])
        let web = windows[1]
        #expect(web["detail"] as? String == "$12.50 of $100.00")
        let fraction = try #require(web["usedFraction"] as? Double)
        #expect(abs(fraction - 0.125) < 1e-9)
    }

    @Test func claudeHeadlineFallsBackToFirstWindow() throws {
        let rows = [BudgetRow(raw: ["project_name": "you@example.com", "current_spending": 1.0, "max_budget": 2.0])]
        let payload = try #require(SnapshotBuilder.claudePayload(rows: rows, config: config))
        let json = try decode(payload)
        #expect(json["headlineID"] as? String == "bucket-web")
    }

    @Test func claudePayloadWithNoAccountRowsIsNil() {
        let rows = [BudgetRow(raw: ["project_name": "other@example.com (cli)"])]
        #expect(SnapshotBuilder.claudePayload(rows: rows, config: config) == nil)
    }

    @Test func overspendFractionIsNotClampedAbove() throws {
        let rows = [BudgetRow(raw: [
            "project_name": "you@example.com (cli)",
            "current_spending": 75.0, "max_budget": 50.0, "total": 150.0,
        ])]
        let payload = try #require(SnapshotBuilder.budgetPayload(rows: rows, config: config))
        let json = try decode(payload)
        let window = try #require((json["windows"] as? [[String: Any]])?.first)
        let usedFraction = try #require(window["usedFraction"] as? Double)
        #expect(abs(usedFraction - 1.5) < 1e-9)
        let money = try #require(window["money"] as? [String: Any])
        #expect(money["remaining"] as? Double == 0)
    }
}
