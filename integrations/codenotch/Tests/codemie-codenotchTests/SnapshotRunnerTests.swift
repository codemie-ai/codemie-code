import CryptoKit
import Foundation
import Testing
@testable import CodemieCodenotchCore

/// A scripted, counting HTTP stub.
final class StubHTTP: HTTPClient, @unchecked Sendable {
    var responses: [Result<HTTPResponse, URLError>] = []
    private(set) var calls = 0
    private(set) var lastRequest: URLRequest?

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        calls += 1
        lastRequest = request
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        let next = responses.removeFirst()
        return try next.get()
    }
}

/// Sendable-safe mutable flag for asserting the log closure fired.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }

    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}

final class SnapshotRunnerTests {
    let key = CredentialStore.deriveKey() // machine key, as on this host
    let home: TemporaryHome
    let http: StubHTTP

    init() throws {
        home = try TemporaryHome()
        http = StubHTTP()
        try writeConfig()
        try writeCredential()
    }

    func runner(now: Date = Date()) -> SnapshotRunner {
        SnapshotRunner(home: home.url, http: http, now: { now })
    }

    let budgetJSON = """
    {"data": {"rows": [
      {"project_name": "you@example.com (cli)", "current_spending": 4.21, "max_budget": 50.0, "total": 8.42, "budget_reset_at": "2026-10-01T00:00:00Z"},
      {"project_name": "you@example.com", "current_spending": 12.5, "max_budget": 100.0, "total": 12.5}
    ]}}
    """

    // MARK: happy path + caching

    @Test func successFetchesAndWritesCache() async throws {
        http.responses = [.success(HTTPResponse(statusCode: 200, body: Data(budgetJSON.utf8)))]
        let outcome = await runner().run(.budget)
        guard case let .success(payload) = outcome else {
            Issue.record("expected success, got \(outcome)")
            return
        }
        #expect(http.calls == 1)
        #expect(payload.contains("\"headlineID\" : \"budget-total\""))

        // The request went to the configured baseUrl with the auth cookie.
        let request = try #require(http.lastRequest)
        #expect(request.url?.absoluteString == "https://api.example.com/v1/analytics/budget_usage")
        #expect(request.value(forHTTPHeaderField: "X-CodeMie-Client") == "codemie-cli")
        #expect(request.value(forHTTPHeaderField: "cookie") == "session=abc")

        // Cache file was written with schema/ts/rows.
        let cache = BudgetCache(home: home.url)
        #expect(cache.loadFresh()?.count == 2)
    }

    @Test func freshCacheShortCircuitsHTTP() async throws {
        // First run populates the cache.
        http.responses = [.success(HTTPResponse(statusCode: 200, body: Data(budgetJSON.utf8)))]
        _ = await runner().run(.budget)
        #expect(http.calls == 1)

        // Second run within the TTL: no HTTP, same payload.
        let outcome = await runner().run(.budget)
        guard case .success = outcome else {
            Issue.record("expected success, got \(outcome)")
            return
        }
        #expect(http.calls == 1)
    }

    @Test func expiredCacheRefreshesOverHTTP() async throws {
        let staleTime = Date(timeIntervalSinceNow: -120)
        BudgetCache(home: home.url).save(rows: [["project_name": "you@example.com (cli)", "current_spending": 1.0]], now: staleTime)
        http.responses = [.success(HTTPResponse(statusCode: 200, body: Data(budgetJSON.utf8)))]
        let outcome = await runner().run(.budget)
        guard case let .success(payload) = outcome else {
            Issue.record("expected success, got \(outcome)")
            return
        }
        #expect(http.calls == 1)
        #expect(payload.contains("$4.21"))
    }

    @Test func networkFailureServesStaleCache() async throws {
        BudgetCache(home: home.url).save(
            rows: [["project_name": "you@example.com (cli)", "current_spending": 9.0, "max_budget": 10.0, "total": 90.0]],
            now: Date(timeIntervalSinceNow: -3600)
        )
        http.responses = [.failure(URLError(.notConnectedToInternet))]
        let logged = LockedFlag()
        let runner = SnapshotRunner(home: home.url, http: http)
        let outcome = await runner.run(.budget, log: { _ in logged.set() })
        guard case let .success(payload) = outcome else {
            Issue.record("expected stale success, got \(outcome)")
            return
        }
        #expect(payload.contains("$9.00"))
        #expect(logged.value)
    }

    @Test func networkFailureWithoutCacheFails() async {
        http.responses = [.failure(URLError(.timedOut))]
        let outcome = await runner().run(.budget)
        guard case let .failure(reason) = outcome else {
            Issue.record("expected failure, got \(outcome)")
            return
        }
        #expect(reason.contains("cannot reach"))
        #expect(outcome.exitCode == 1)
    }

    // MARK: protocol exit codes

    @Test func missingConfigIsNeedsAuth() async throws {
        try FileManager.default.removeItem(at: home.url.appendingPathComponent("codemie-cli.config.json"))
        let outcome = await runner().run(.budget)
        #expect(outcome == .needsAuth("no CodeMie profile configured — run `codemie setup`"))
        #expect(outcome.exitCode == 3)
    }

    @Test func missingCredentialsIsNeedsAuth() async throws {
        try FileManager.default.removeItem(at: home.url.appendingPathComponent("credentials"))
        let outcome = await runner().run(.budget)
        #expect(outcome == .needsAuth("CodeMie credentials missing or unreadable — run `codemie profile login`"))
        #expect(outcome.exitCode == 3)
    }

    @Test func http401IsNeedsAuth() async {
        http.responses = [.success(HTTPResponse(statusCode: 401))]
        let outcome = await runner().run(.budget)
        guard case .needsAuth = outcome else {
            Issue.record("expected needsAuth, got \(outcome)")
            return
        }
        #expect(outcome.exitCode == 3)
    }

    @Test func http429IsRateLimitedWithRetryAfter() async {
        http.responses = [.success(HTTPResponse(statusCode: 429, headers: ["Retry-After": "120"]))]
        let outcome = await runner().run(.budget)
        #expect(outcome == .rateLimited(120))
        #expect(outcome.exitCode == 4)
        #expect(outcome.stdout == #"{"retryAfterSeconds": 120}"#)
    }

    @Test func http429DefaultsRetryAfterTo60() async {
        http.responses = [.success(HTTPResponse(statusCode: 429))]
        let outcome = await runner().run(.budget)
        #expect(outcome == .rateLimited(60))
    }

    @Test func http500IsGenericFailure() async {
        http.responses = [.success(HTTPResponse(statusCode: 500, body: Data("boom".utf8)))]
        let outcome = await runner().run(.budget)
        guard case let .failure(reason) = outcome else {
            Issue.record("expected failure, got \(outcome)")
            return
        }
        #expect(reason.contains("500"))
        #expect(outcome.exitCode == 1)
    }

    @Test func noAccountRowsIsNothingMetered() async {
        let json = #"{"data": {"rows": [{"project_name": "someone-else@example.com (cli)", "current_spending": 1.0}]}}"#
        http.responses = [.success(HTTPResponse(statusCode: 200, body: Data(json.utf8)))]
        let outcome = await runner().run(.budget)
        #expect(outcome == .nothingMetered("no budget rows for you@example.com"))
        #expect(outcome.exitCode == 5)
    }

    @Test func claudeProviderSucceedsWithBuckets() async throws {
        http.responses = [.success(HTTPResponse(statusCode: 200, body: Data(budgetJSON.utf8)))]
        let outcome = await runner().run(.claude)
        guard case let .success(payload) = outcome else {
            Issue.record("expected success, got \(outcome)")
            return
        }
        #expect(payload.contains("\"headlineID\" : \"bucket-cli\""))
        #expect(payload.contains("bucket-web"))
    }

    // MARK: fixture helpers

    private func writeConfig() throws {
        let json = """
        {
          "activeProfile": "work",
          "profiles": { "work": { "baseUrl": "https://api.example.com", "provider": "codemie-sso" } },
          "workspace": { "codeMieUrl": "https://codemie.example.com" },
          "userEmail": "you@example.com"
        }
        """
        try Data(json.utf8).write(to: home.url.appendingPathComponent("codemie-cli.config.json"))
    }

    private func writeCredential() throws {
        let hash = CredentialStore.credentialHash(codeMieUrl: "https://codemie.example.com")
        let credentials = home.url.appendingPathComponent("credentials")
        try FileManager.default.createDirectory(at: credentials, withIntermediateDirectories: true)
        let sealed = try AES.GCM.seal(Data(#"{"cookies": {"session": "abc"}}"#.utf8), using: SymmetricKey(data: key))
        let encoded = [SHA.hex(Data(sealed.nonce)), SHA.hex(sealed.tag), SHA.hex(sealed.ciphertext)]
            .joined(separator: ":")
        try Data(encoded.utf8).write(to: credentials.appendingPathComponent("sso-\(hash).enc"))
    }
}
