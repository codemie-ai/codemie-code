import Foundation

public enum SnapshotOutcome: Equatable {
    /// Exit 0 — payload for stdout.
    case success(String)
    /// Exit 3 — not authenticated; reason for stderr.
    case needsAuth(String)
    /// Exit 4 — rate limited; `{"retryAfterSeconds": N}` for stdout.
    case rateLimited(Int)
    /// Exit 5 — nothing metered; reason for stderr.
    case nothingMetered(String)
    /// Any other exit code — failure; reason for stderr.
    case failure(String)

    public var exitCode: Int32 {
        switch self {
        case .success: return 0
        case .needsAuth: return 3
        case .rateLimited: return 4
        case .nothingMetered: return 5
        case .failure: return 1
        }
    }

    public var stdout: String? {
        switch self {
        case let .success(payload): return payload
        case let .rateLimited(seconds): return #"{"retryAfterSeconds": \#(seconds)}"#
        default: return nil
        }
    }

    public var stderr: String? {
        switch self {
        case let .needsAuth(reason), let .nothingMetered(reason), let .failure(reason): return reason
        default: return nil
        }
    }
}

public struct SnapshotRunner: Sendable {
    public var home: URL
    public var http: HTTPClient
    public var now: @Sendable () -> Date

    public init(home: URL, http: HTTPClient, now: @escaping @Sendable () -> Date = Date.init) {
        self.home = home
        self.http = http
        self.now = now
    }

    public func run(_ provider: Provider, log: @Sendable (String) -> Void = { _ in }) async -> SnapshotOutcome {
        guard let config = CodemieConfig.load(from: home), config.isComplete else {
            return .needsAuth("no CodeMie profile configured — run `codemie setup`")
        }
        guard let baseUrl = config.baseUrl,
              let email = config.userEmail,
              let base = URL(string: baseUrl) else {
            return .needsAuth("no CodeMie profile configured — run `codemie setup`")
        }
        let credential: AuthCredential
        do {
            credential = try CredentialStore.load(home: home, codeMieUrl: config.codeMieUrl ?? "")
        } catch {
            return .needsAuth("CodeMie credentials missing or unreadable — run `codemie profile login`")
        }

        let cache = BudgetCache(home: home)
        let rows: [BudgetRow]
        if let fresh = cache.loadFresh(now: now()) {
            rows = fresh.map(BudgetRow.init(raw:))
        } else {
            switch await fetchRows(base: base, credential: credential) {
            case let .rows(rawRows):
                cache.save(rows: rawRows, now: now())
                rows = rawRows.map(BudgetRow.init(raw:))
            case let .failed(outcome):
                return outcome
            case .networkDown:
                guard let stale = cache.loadStale() else {
                    return .failure("cannot reach \(baseUrl) and no cached budget data exists")
                }
                log("network unreachable — serving stale cache from \(cache.url.path)")
                rows = stale.map(BudgetRow.init(raw:))
            }
        }

        let payload: [String: Any]?
        switch provider {
        case .budget:
            payload = SnapshotBuilder.budgetPayload(rows: rows, config: config)
            if payload == nil {
                return .nothingMetered("no budget rows for \(email)")
            }
        case .claude:
            payload = SnapshotBuilder.claudePayload(rows: rows, config: config)
            if payload == nil {
                return .nothingMetered("no budget rows for \(email)")
            }
        }
        guard let payload else { return .failure("internal error building payload") }
        return .success(SnapshotBuilder.jsonString(payload))
    }

    private enum FetchResult {
        case rows([[String: Any]])
        case failed(SnapshotOutcome)
        case networkDown
    }

    private func fetchRows(base: URL, credential: AuthCredential) async -> FetchResult {
        let url = base.appendingPathComponent("v1/analytics/budget_usage")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("codemie-cli", forHTTPHeaderField: "X-CodeMie-Client")
        let auth = credential.header
        request.setValue(auth.value, forHTTPHeaderField: auth.name)

        let response: HTTPResponse
        do {
            response = try await http.send(request)
        } catch {
            return .networkDown
        }
        switch response.statusCode {
        case 200:
            guard let parsed = BudgetRows.parse(response.body) else {
                return .failed(.failure("budget_usage response did not contain a rows array"))
            }
            return .rows(parsed.map(\.raw))
        case 401, 403:
            return .failed(.needsAuth("CodeMie credentials rejected (HTTP \(response.statusCode)) — run `codemie profile login`"))
        case 429:
            let retryAfter = response.header("Retry-After").flatMap(Int.init) ?? 60
            return .failed(.rateLimited(retryAfter))
        default:
            return .failed(.failure("budget_usage returned HTTP \(response.statusCode)"))
        }
    }
}
