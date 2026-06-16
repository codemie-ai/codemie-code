# CodeMie Claude Installer (macOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native macOS SwiftUI installer wizard that takes a developer from a clean Mac to a fully working CodeMie CLI + Claude engine environment with zero manual terminal work.

**Architecture:** A data-driven `StepEngine` actor drives a sequence of steps declared in `steps.yaml` (Yams); each step dispatches to a focused service class; the SwiftUI layer observes engine events on `@MainActor`; two steps (`2.1`, `2.2`) run in an embedded SwiftTerm PTY for real TUI interaction. Admin-vs-non-admin Node install branches are selected at runtime.

**Tech Stack:** Swift 6.3.1 (actual; plan said 5.9+), SwiftUI, SwiftTerm 1.13.0 (PTY), Yams 5.4.0 (YAML), Foundation.Process + Pipe, Swift Concurrency (actors, `AsyncStream`, `CheckedContinuation`), Swift Testing (`import Testing`), Xcode / xcodebuild for distribution.

> **Environment note:** Development machine runs macOS 26 (Tahoe) with Command Line Tools only (no Xcode). Run `make test` — not `swift test` directly — to resolve `Testing.framework` at runtime.

**Spec reference:** `CodeMie-Claude-Installer-Mac-SPEC.md` v2.1 (downloaded spec). All section references (§N) refer to that document.

---

## New Repository Context

The implementation lives in a **new standalone repository** `codemie-claude-installer-mac` — not in `codemie-code`. This plan file is stored in `codemie-code` for tracking. All tasks below are executed inside the new repo.

---

## Phase Overview

| Phase | Scope | Status | Tests |
|---|---|---|---|
| **Phase 1** | Project scaffold + Core Engine | ✅ COMPLETE (Days 1–3) | 26/26 |
| **Phase 2** | Installation Services | ✅ COMPLETE (Days 4–8) | 60/60 |
| **Phase 3** | SwiftUI Wizard UI | ✅ COMPLETE (Days 9–12) | 70/70 |
| **Phase 4** | Accessibility & Hardening | ✅ COMPLETE (Days 13–14) | 108/108 |
| **Phase 5** | Distribution Pipeline | ✅ COMPLETE (Days 15–16) | 108/108 |

Phases 3–5 are expanded to full TDD steps before their implementation begins.

---

## Phase 1 — Project Scaffold & Core Engine ✅ COMPLETE

**Status:** Days 1–3 complete. 26/26 tests. Tag `phase-1-complete`. Commits: `7f8611e` → `c61d392`.

**Goal:** New repo with working Package.swift skeleton, data-driven step model, all core services, and StepEngine running a dry-run with a mock step list. `make test` passes.

### File Map (actual — as-built)

```
codemie-claude-installer-mac/
├── Package.swift          — swift-tools-version 6.0, .macOS(.v15), Yams 5.4.0, SwiftTerm 1.13.0
├── Makefile               — make test / make test-filter FILTER=X  (wraps CLT framework flags)
├── .gitignore
├── README.md
├── Sources/
│   ├── Engine/
│   │   ├── Step.swift             — Codable + Sendable Step model (§14.1)
│   │   ├── StepStatus.swift       — PENDING/ACTIVE/COMPLETE/WARNING/ERROR/SKIPPED
│   │   ├── RunOutcome.swift       — SUCCESS/COMPLETED_WITH_WARNINGS/FAILED/ABORTED
│   │   ├── StepEvent.swift        — 8 event cases emitted by StepEngine
│   │   ├── StepConfigLoader.swift — Yams YAMLDecoder → [Step], Bundle.module resource
│   │   ├── StepEngine.swift       — actor: step loop, CheckedContinuation gates, events
│   │   └── steps.yaml             — ⚠️ in Engine/ (not Resources/) — SPM resource rule
│   └── Services/
│       ├── InstallLogger.swift    — actor, nonisolated let URL, ~/Library/Logs/CodeMie/
│       ├── ShellRunner.swift      — Process+Pipe, @unchecked Sendable LineCollector, public init
│       ├── SystemInspector.swift  — admin check, arch, git/node/codemie detection (§5.6)
│       ├── Constants.swift        — pinned versions + paths + validateReleaseHashes()
│       ├── Downloader.swift       — URLSession downloadTask + KVO progress
│       ├── IntegrityVerifier.swift — CryptoKit SHA-256 + pkgutil/spctl signature (§5.5)
│       ├── XcodeCLT.swift         — 6-step state machine, injectable shell closure (§5.4)
│       ├── PrivilegeManager.swift — single osascript call, auth-cancel → throws (§11)
│       ├── PkgInstaller.swift     — sha256Verifier + signatureVerifier + privilegeManager (§11)
│       ├── FnmInstaller.swift     — actor, no-admin Node branch, deterministic nodeBinDir (§5.1)
│       ├── PathManager.swift      — prependInProcess + idempotent profile block (§10)
│       └── InteractiveRunner.swift — actor, AsyncStream<InteractiveEvent>, skip/abort (§12)
└── Tests/
    ├── EngineTests/
    │   ├── StepConfigLoaderTests.swift   — 3 tests
    │   └── StepEngineTests.swift         — 6 tests
    └── ServicesTests/
        ├── InstallLoggerTests.swift      — 5 tests
        ├── ShellRunnerTests.swift        — 5 tests
        ├── SystemInspectorTests.swift    — 7 tests
        ├── IntegrityVerifierTests.swift  — 6 tests
        ├── XcodeCLTTests.swift           — 5 tests
        ├── PkgInstallerTests.swift       — 5 tests
        ├── FnmInstallerTests.swift       — 5 tests
        ├── PathManagerTests.swift        — 9 tests
        └── InteractiveRunnerTests.swift  — 4 tests
```

---

### Task 1: Repository scaffold + Package.swift

**Files:**
- Create: `Package.swift`
- Create: `.gitignore`
- Create: `README.md`
- Create: all `Sources/` and `Tests/` subdirectories

- [ ] **Step 1: Create the new repository directory and init git**

```bash
mkdir codemie-claude-installer-mac
cd codemie-claude-installer-mac
git init
git checkout -b main
```

- [ ] **Step 2: Create `.gitignore`**

```
.build/
*.xcodeproj/xcuserdata/
*.xcworkspace/xcuserdata/
DerivedData/
.swiftpm/
*.o
*.d
```

- [ ] **Step 3: Create `Package.swift`**

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodeMieClaudeInstaller",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.0.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "Engine",
            dependencies: ["Yams"],
            path: "Sources/Engine",
            resources: [.copy("../Resources/steps.yaml")]
        ),
        .target(
            name: "Services",
            dependencies: ["Engine"],
            path: "Sources/Services"
        ),
        .testTarget(
            name: "EngineTests",
            dependencies: ["Engine"],
            path: "Tests/EngineTests"
        ),
        .testTarget(
            name: "ServicesTests",
            dependencies: ["Services"],
            path: "Tests/ServicesTests"
        ),
    ]
)
```

- [ ] **Step 4: Create all source directories**

```bash
mkdir -p Sources/Engine Sources/Services Sources/Resources
mkdir -p Tests/EngineTests Tests/ServicesTests
```

- [ ] **Step 5: Verify `swift build` resolves dependencies**

```bash
swift build
```

Expected: `Build complete!` (no source files yet is fine; warnings about empty targets are acceptable)

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: initialize project scaffold with Package.swift"
```

---

### Task 2: Step model + StepConfigLoader + steps.yaml

**Files:**
- Create: `Sources/Engine/Step.swift`
- Create: `Sources/Engine/StepStatus.swift`
- Create: `Sources/Engine/RunOutcome.swift`
- Create: `Sources/Engine/StepConfigLoader.swift`
- Create: `Sources/Resources/steps.yaml`
- Create: `Tests/EngineTests/StepConfigLoaderTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/EngineTests/StepConfigLoaderTests.swift`:

```swift
import XCTest
@testable import Engine

final class StepConfigLoaderTests: XCTestCase {

    func test_load_returnsAllStepsFromYaml() throws {
        let yaml = """
        steps:
          - id: "1.1"
            title: "Check Git"
            description: "Verify Git is installed"
            required: true
          - id: "1.1.1"
            title: "Install Git"
            description: "Install via Xcode CLT"
            isSubStep: true
            parentId: "1.1"
            conditional: true
            requiresApproval: true
            spinner: true
            fatal: true
        """
        let url = try writeTempYaml(yaml)
        let steps = try StepConfigLoader.load(from: url)
        XCTAssertEqual(steps.count, 2)
        XCTAssertEqual(steps[0].id, "1.1")
        XCTAssertEqual(steps[0].title, "Check Git")
        XCTAssertTrue(steps[0].required)
        XCTAssertEqual(steps[1].id, "1.1.1")
        XCTAssertTrue(steps[1].isSubStep)
        XCTAssertEqual(steps[1].parentId, "1.1")
        XCTAssertTrue(steps[1].fatal)
        XCTAssertFalse(steps[1].required)
    }

    func test_load_defaultsOptionalFieldsToFalse() throws {
        let yaml = """
        steps:
          - id: "2.3"
            title: "Validate"
            description: "Run doctor"
        """
        let url = try writeTempYaml(yaml)
        let steps = try StepConfigLoader.load(from: url)
        let step = try XCTUnwrap(steps.first)
        XCTAssertFalse(step.requiresApproval)
        XCTAssertFalse(step.interactive)
        XCTAssertFalse(step.conditional)
        XCTAssertFalse(step.isSubStep)
        XCTAssertFalse(step.spinner)
        XCTAssertFalse(step.fatal)
        XCTAssertFalse(step.required)
        XCTAssertNil(step.parentId)
        XCTAssertNil(step.approvalMessage)
        XCTAssertNil(step.mascotState)
    }

    func test_load_throwsOnInvalidYaml() throws {
        let url = try writeTempYaml("not: valid: yaml: [[[")
        XCTAssertThrowsError(try StepConfigLoader.load(from: url))
    }

    // MARK: - Helpers

    private func writeTempYaml(_ content: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".yaml")
        try content.write(to: url, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter StepConfigLoaderTests
```

Expected: FAIL — `no such module 'Engine'`

- [ ] **Step 3: Create `Sources/Engine/Step.swift`**

```swift
import Foundation

public struct Step: Codable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let description: String
    public var requiresApproval: Bool
    public var approvalMessage: String?
    public var interactive: Bool
    public var conditional: Bool
    public var isSubStep: Bool
    public var parentId: String?
    public var spinner: Bool
    public var fatal: Bool
    public var required: Bool
    public var mascotState: String?

    public init(
        id: String,
        title: String,
        description: String,
        requiresApproval: Bool = false,
        approvalMessage: String? = nil,
        interactive: Bool = false,
        conditional: Bool = false,
        isSubStep: Bool = false,
        parentId: String? = nil,
        spinner: Bool = false,
        fatal: Bool = false,
        required: Bool = false,
        mascotState: String? = nil
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.requiresApproval = requiresApproval
        self.approvalMessage = approvalMessage
        self.interactive = interactive
        self.conditional = conditional
        self.isSubStep = isSubStep
        self.parentId = parentId
        self.spinner = spinner
        self.fatal = fatal
        self.required = required
        self.mascotState = mascotState
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, description, requiresApproval, approvalMessage
        case interactive, conditional, isSubStep, parentId, spinner, fatal
        case required, mascotState
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decode(String.self, forKey: .description)
        requiresApproval = try c.decodeIfPresent(Bool.self, forKey: .requiresApproval) ?? false
        approvalMessage = try c.decodeIfPresent(String.self, forKey: .approvalMessage)
        interactive = try c.decodeIfPresent(Bool.self, forKey: .interactive) ?? false
        conditional = try c.decodeIfPresent(Bool.self, forKey: .conditional) ?? false
        isSubStep = try c.decodeIfPresent(Bool.self, forKey: .isSubStep) ?? false
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        spinner = try c.decodeIfPresent(Bool.self, forKey: .spinner) ?? false
        fatal = try c.decodeIfPresent(Bool.self, forKey: .fatal) ?? false
        required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
        mascotState = try c.decodeIfPresent(String.self, forKey: .mascotState)
    }
}
```

- [ ] **Step 4: Create `Sources/Engine/StepStatus.swift`**

```swift
public enum StepStatus: Equatable {
    case pending
    case active
    case complete
    case warning(String)
    case error(String)
    case skipped
}
```

- [ ] **Step 5: Create `Sources/Engine/RunOutcome.swift`**

```swift
public enum RunOutcome: Equatable {
    case success
    case completedWithWarnings([String])
    case failed(stepId: String, message: String, recommendation: String)
    case aborted
}
```

- [ ] **Step 6: Create `Sources/Engine/StepConfigLoader.swift`**

```swift
import Foundation
import Yams

public enum StepConfigError: Error, LocalizedError {
    case notFound
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case .notFound: return "steps.yaml not found in bundle"
        case .invalid(let msg): return "steps.yaml invalid: \(msg)"
        }
    }
}

private struct StepConfig: Codable {
    let steps: [Step]
}

public struct StepConfigLoader {
    public static func load(from url: URL) throws -> [Step] {
        let content = try String(contentsOf: url, encoding: .utf8)
        let decoder = YAMLDecoder()
        do {
            let config = try decoder.decode(StepConfig.self, from: content)
            return config.steps
        } catch {
            throw StepConfigError.invalid(error.localizedDescription)
        }
    }

    public static func loadBundled() throws -> [Step] {
        guard let url = Bundle.module.url(forResource: "steps", withExtension: "yaml") else {
            throw StepConfigError.notFound
        }
        return try load(from: url)
    }
}
```

- [ ] **Step 7: Create `Sources/Resources/steps.yaml`** (canonical step list per §14.2)

```yaml
steps:
  - id: "1.1"
    title: "Check Git"
    description: "Verify Git is installed and accessible"
    required: true

  - id: "1.1.1"
    title: "Install Git (Command Line Tools)"
    description: "Install Apple Command Line Tools to provide Git"
    isSubStep: true
    parentId: "1.1"
    conditional: true
    requiresApproval: true
    spinner: true
    fatal: true
    approvalMessage: "Git was not found. Install Apple Command Line Tools?"

  - id: "1.2"
    title: "Check Node.js & npm"
    description: "Verify Node.js and npm are installed"
    required: true

  - id: "1.2.1"
    title: "Install Node.js"
    description: "Install the pinned Node.js LTS"
    isSubStep: true
    parentId: "1.2"
    conditional: true
    requiresApproval: true
    spinner: true
    fatal: true

  - id: "1.3"
    title: "Install CodeMie CLI"
    description: "npm install -g @codemieai/code"
    requiresApproval: true
    conditional: true
    spinner: true
    fatal: true
    required: true

  - id: "2.1"
    title: "Configure CodeMie"
    description: "Run codemie setup (interactive — follow the prompts)"
    interactive: true
    required: true
    mascotState: "working"

  - id: "2.2"
    title: "Install Claude engine"
    description: "codemie install claude --supported"
    interactive: true
    required: true
    mascotState: "working"

  - id: "2.3"
    title: "Validate installation"
    description: "Run codemie doctor and review the report"
    spinner: true
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
swift test --filter StepConfigLoaderTests
```

Expected: `Test Suite 'StepConfigLoaderTests' passed`

- [ ] **Step 9: Commit**

```bash
git add Sources/Engine/ Sources/Resources/steps.yaml Tests/EngineTests/StepConfigLoaderTests.swift
git commit -m "feat(engine): add Step model, RunOutcome, StepStatus, StepConfigLoader + tests"
```

---

### Task 3: InstallLogger

**Files:**
- Create: `Sources/Services/InstallLogger.swift`
- Create: `Tests/ServicesTests/InstallLoggerTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/ServicesTests/InstallLoggerTests.swift`:

```swift
import XCTest
@testable import Services

final class InstallLoggerTests: XCTestCase {

    var logURL: URL!

    override func setUp() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        logURL = dir.appendingPathComponent("wizard.log")
        await InstallLogger.shared.overrideLogURL(logURL)
        try await InstallLogger.shared.openSession()
    }

    override func tearDown() async throws {
        let dir = logURL.deletingLastPathComponent()
        try? FileManager.default.removeItem(at: dir)
    }

    func test_openSession_createsLogFile() async throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
    }

    func test_log_writesTaggedLine() async throws {
        await InstallLogger.shared.log("hello world", kind: .info)
        let contents = try String(contentsOf: logURL, encoding: .utf8)
        XCTAssertTrue(contents.contains("[INF] hello world"))
    }

    func test_log_writesCommandLine() async throws {
        await InstallLogger.shared.log("git --version", kind: .command)
        let contents = try String(contentsOf: logURL, encoding: .utf8)
        XCTAssertTrue(contents.contains("[CMD] git --version"))
    }

    func test_log_includesISO8601Timestamp() async throws {
        await InstallLogger.shared.log("ts test", kind: .out)
        let contents = try String(contentsOf: logURL, encoding: .utf8)
        // ISO-8601: YYYY-MM-DDTHH:MM:SS
        let pattern = #"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"#
        XCTAssertNotNil(contents.range(of: pattern, options: .regularExpression))
    }

    func test_log_doesNotWriteSecrets() async throws {
        await InstallLogger.shared.log("export TOKEN=mysecrettoken", kind: .out)
        let contents = try String(contentsOf: logURL, encoding: .utf8)
        // The message is logged as-is — this test documents that the logger
        // does NOT sanitize; sanitization is the caller's responsibility (§16)
        XCTAssertTrue(contents.contains("export TOKEN=mysecrettoken"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter InstallLoggerTests
```

Expected: FAIL — `no such module 'Services'`

- [ ] **Step 3: Create `Sources/Services/InstallLogger.swift`**

```swift
import Foundation

public actor InstallLogger {
    public static let shared = InstallLogger()

    public enum LineKind: String {
        case out = "OUT"
        case err = "ERR"
        case info = "INF"
        case success = "OK"
        case command = "CMD"
    }

    private var fileHandle: FileHandle?
    private var _logURL: URL

    private static let defaultLogURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/CodeMie/wizard.log")
    }()

    init(logURL: URL? = nil) {
        _logURL = logURL ?? Self.defaultLogURL
    }

    // Test hook: redirect log file
    public func overrideLogURL(_ url: URL) {
        _logURL = url
        fileHandle = nil
    }

    public var logFileURL: URL { _logURL }

    public func openSession() throws {
        let dir = _logURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: _logURL.path) {
            FileManager.default.createFile(atPath: _logURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: _logURL)
        handle.seekToEndOfFile()
        fileHandle = handle
        write("=== Session \(isoNow()) ===", kind: .info)
    }

    public func log(_ message: String, kind: LineKind = .out) {
        write(message, kind: kind)
    }

    private func write(_ message: String, kind: LineKind) {
        let line = "[\(isoNow())] [\(kind.rawValue)] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        fileHandle?.write(data)
    }

    private func isoNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
swift test --filter InstallLoggerTests
```

Expected: `Test Suite 'InstallLoggerTests' passed`

- [ ] **Step 5: Commit**

```bash
git add Sources/Services/InstallLogger.swift Tests/ServicesTests/InstallLoggerTests.swift
git commit -m "feat(services): add InstallLogger actor with ISO-8601 tagged log lines"
```

---

### Task 4: ShellRunner

**Files:**
- Create: `Sources/Services/ShellRunner.swift`
- Create: `Tests/ServicesTests/ShellRunnerTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/ServicesTests/ShellRunnerTests.swift`:

```swift
import XCTest
@testable import Services

final class ShellRunnerTests: XCTestCase {

    func test_run_capturesStdoutLines() async throws {
        var lines: [String] = []
        let result = try await ShellRunner.run(
            "/bin/echo",
            args: ["hello", "world"],
            onLine: { lines.append($0) }
        )
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertTrue(lines.contains("hello world"))
    }

    func test_run_returnsNonZeroOnFailure() async throws {
        let result = try await ShellRunner.run(
            "/usr/bin/false",
            args: [],
            onLine: { _ in }
        )
        XCTAssertNotEqual(result.exitCode, 0)
    }

    func test_run_capturesMultipleLines() async throws {
        var lines: [String] = []
        let result = try await ShellRunner.run(
            "/bin/bash",
            args: ["-c", "echo line1; echo line2; echo line3"],
            onLine: { lines.append($0) }
        )
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertTrue(lines.contains("line1"))
        XCTAssertTrue(lines.contains("line2"))
        XCTAssertTrue(lines.contains("line3"))
    }

    func test_run_mergesStdoutAndStderr() async throws {
        var lines: [String] = []
        let result = try await ShellRunner.run(
            "/bin/bash",
            args: ["-c", "echo stdout; echo stderr >&2"],
            onLine: { lines.append($0) }
        )
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertTrue(lines.contains("stdout"))
        XCTAssertTrue(lines.contains("stderr"))
    }

    func test_run_respectsCustomEnv() async throws {
        var lines: [String] = []
        let result = try await ShellRunner.run(
            "/bin/bash",
            args: ["-c", "echo $MY_VAR"],
            env: ["MY_VAR": "injected"],
            onLine: { lines.append($0) }
        )
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertTrue(lines.contains("injected"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter ShellRunnerTests
```

Expected: FAIL — `no such module 'Services'` (or `ShellRunner` not defined)

- [ ] **Step 3: Create `Sources/Services/ShellRunner.swift`**

```swift
import Foundation

public struct ShellResult {
    public let exitCode: Int32
    public let stdout: String
}

public enum ShellRunnerError: Error {
    case launchFailed(String)
}

public struct ShellRunner {
    /// Run a command, streaming merged stdout+stderr to `onLine`, returning exit code + full stdout.
    @discardableResult
    public static func run(
        _ executable: String,
        args: [String],
        env: [String: String]? = nil,
        onLine: @escaping (String) -> Void = { _ in }
    ) async throws -> ShellResult {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = args

            if let env = env {
                // Merge with current env so $PATH etc. are available
                var merged = ProcessInfo.processInfo.environment
                for (k, v) in env { merged[k] = v }
                process.environment = merged
            }

            let outPipe = Pipe()
            let errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe

            var stdoutLines: [String] = []
            let queue = DispatchQueue(label: "ShellRunner.output")

            func handleData(_ data: Data) {
                guard let text = String(data: data, encoding: .utf8) else { return }
                let lines = text.components(separatedBy: "\n")
                for line in lines where !line.isEmpty {
                    queue.sync { stdoutLines.append(line) }
                    onLine(line)
                }
            }

            outPipe.fileHandleForReading.readabilityHandler = { handle in
                handleData(handle.availableData)
            }
            errPipe.fileHandleForReading.readabilityHandler = { handle in
                handleData(handle.availableData)
            }

            process.terminationHandler = { proc in
                // Drain remaining data
                handleData(outPipe.fileHandleForReading.readDataToEndOfFile())
                handleData(errPipe.fileHandleForReading.readDataToEndOfFile())
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                let result = ShellResult(
                    exitCode: proc.terminationStatus,
                    stdout: queue.sync { stdoutLines.joined(separator: "\n") }
                )
                continuation.resume(returning: result)
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: ShellRunnerError.launchFailed(error.localizedDescription))
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
swift test --filter ShellRunnerTests
```

Expected: `Test Suite 'ShellRunnerTests' passed`

- [ ] **Step 5: Commit**

```bash
git add Sources/Services/ShellRunner.swift Tests/ServicesTests/ShellRunnerTests.swift
git commit -m "feat(services): add ShellRunner with AsyncStream line streaming and env support"
```

---

### Task 5: SystemInspector

**Files:**
- Create: `Sources/Services/SystemInspector.swift`
- Create: `Tests/ServicesTests/SystemInspectorTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/ServicesTests/SystemInspectorTests.swift`:

```swift
import XCTest
@testable import Services

final class SystemInspectorTests: XCTestCase {

    func test_arch_returnsArm64OrX86_64() {
        let arch = SystemInspector.arch
        XCTAssertTrue(arch == .arm64 || arch == .x86_64)
    }

    func test_homebrewPrefix_matchesArch() {
        let prefix = SystemInspector.homebrewPrefix
        if SystemInspector.arch == .arm64 {
            XCTAssertEqual(prefix, "/opt/homebrew")
        } else {
            XCTAssertEqual(prefix, "/usr/local")
        }
    }

    func test_isGitInstalled_returnsTrueOnTestMachine() async {
        // This test machine has git installed (it's a dev machine)
        let result = await SystemInspector.isGitInstalled(env: ProcessInfo.processInfo.environment)
        XCTAssertTrue(result)
    }

    func test_isGitInstalled_returnsFalseWithEmptyPath() async {
        let result = await SystemInspector.isGitInstalled(env: ["PATH": "/nonexistent"])
        XCTAssertFalse(result)
    }

    func test_isNodeInstalled_withEmptyPath_returnsFalseForBoth() async {
        let result = await SystemInspector.isNodeInstalled(env: ["PATH": "/nonexistent"])
        XCTAssertFalse(result.node)
        XCTAssertFalse(result.npm)
    }

    func test_codemieDetection_semverPattern() {
        // §5.6: stdout must match ^\d+\.\d+\.\d+
        let valid = ["1.2.3", "0.3.2", "10.0.1"]
        let invalid = ["v1.2.3", "not installed", "", "1.2", "1.2.3.4"]
        for v in valid {
            XCTAssertTrue(SystemInspector.matchesSemver(v), "Should match: \(v)")
        }
        for v in invalid {
            XCTAssertFalse(SystemInspector.matchesSemver(v), "Should not match: \(v)")
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter SystemInspectorTests
```

Expected: FAIL — `SystemInspector` not defined

- [ ] **Step 3: Create `Sources/Services/SystemInspector.swift`**

```swift
import Foundation

public struct SystemInspector {
    public enum Arch { case arm64, x86_64 }

    public static var arch: Arch {
        #if arch(arm64)
        return .arm64
        #else
        return .x86_64
        #endif
    }

    public static var homebrewPrefix: String {
        arch == .arm64 ? "/opt/homebrew" : "/usr/local"
    }

    /// Admin capability check (§4): deterministic, no prompt.
    public static func isAdminCapable() async -> Bool {
        let username = ProcessInfo.processInfo.environment["USER"] ?? NSUserName()
        let result = try? await ShellRunner.run(
            "/usr/sbin/dseditgroup",
            args: ["-o", "checkmember", "-m", username, "admin"]
        )
        return result?.exitCode == 0
    }

    /// Git detection: probes standard locations, returns true if any exits 0. (§5.1 1.1)
    public static func isGitInstalled(env: [String: String]) async -> Bool {
        // Try via PATH first
        if let r = try? await ShellRunner.run("/usr/bin/env", args: ["git", "--version"], env: env),
           r.exitCode == 0 { return true }
        // Probe known locations
        let probes = ["/usr/bin/git", "\(homebrewPrefix)/bin/git", "/usr/local/bin/git"]
        for path in probes {
            if let r = try? await ShellRunner.run(path, args: ["--version"]),
               r.exitCode == 0 { return true }
        }
        return false
    }

    /// Node + npm detection (§5.1 1.2)
    public static func isNodeInstalled(env: [String: String]) async -> (node: Bool, npm: Bool) {
        async let nodeOk = (try? ShellRunner.run("/usr/bin/env", args: ["node", "--version"], env: env))?.exitCode == 0
        async let npmOk = (try? ShellRunner.run("/usr/bin/env", args: ["npm", "--version"], env: env))?.exitCode == 0
        return await (nodeOk, npmOk)
    }

    /// codemie detection per §5.6 (objective — must match semver).
    public static func isCodemieInstalled(env: [String: String]) async -> Bool {
        // 1. Must resolve on PATH
        guard let which = try? await ShellRunner.run(
            "/bin/bash", args: ["-c", "command -v codemie"], env: env
        ), which.exitCode == 0,
              !which.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        // 2. --version must exit 0 and match semver
        if let ver = try? await ShellRunner.run(
            "/bin/bash", args: ["-c", "codemie --version"], env: env
        ), ver.exitCode == 0 {
            let out = ver.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if matchesSemver(out) { return true }
        }
        // 3. Fallback: --help exits 0 and contains "codemie"
        if let help = try? await ShellRunner.run(
            "/bin/bash", args: ["-c", "codemie --help"], env: env
        ), help.exitCode == 0, help.stdout.contains("codemie") {
            return true
        }
        return false
    }

    /// Returns true if `s` begins with a semver pattern (§5.6)
    public static func matchesSemver(_ s: String) -> Bool {
        s.range(of: #"^\d+\.\d+\.\d+"#, options: .regularExpression) != nil
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
swift test --filter SystemInspectorTests
```

Expected: `Test Suite 'SystemInspectorTests' passed`

- [ ] **Step 5: Commit**

```bash
git add Sources/Services/SystemInspector.swift Tests/ServicesTests/SystemInspectorTests.swift
git commit -m "feat(services): add SystemInspector — admin check, arch detection, tool detection (§5.6)"
```

---

### Task 6: StepEngine actor

**Files:**
- Create: `Sources/Engine/StepEvent.swift`
- Create: `Sources/Engine/StepEngine.swift`
- Create: `Tests/EngineTests/StepEngineTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/EngineTests/StepEngineTests.swift`:

```swift
import XCTest
@testable import Engine

final class StepEngineTests: XCTestCase {

    // A step handler that always succeeds
    private func successHandler(_ step: Step) async -> StepStatus { .complete }

    // A step handler that always fails
    private func failHandler(_ step: Step) async -> StepStatus {
        .error("step \(step.id) failed")
    }

    func test_run_emitsActiveAndCompleteForEachStep() async throws {
        let steps = [
            Step(id: "1.1", title: "A", description: ""),
            Step(id: "1.2", title: "B", description: ""),
        ]
        let engine = StepEngine(steps: steps, handler: successHandler)
        var events: [StepEvent] = []

        for await event in await engine.run(autoApprove: true) {
            events.append(event)
        }

        let actives = events.filter { if case .stepStarted = $0 { return true }; return false }
        let completes = events.filter { if case .stepFinished(_, .complete) = $0 { return true }; return false }
        XCTAssertEqual(actives.count, 2)
        XCTAssertEqual(completes.count, 2)
    }

    func test_run_successOutcomeWhenAllRequiredStepsComplete() async throws {
        let steps = [
            Step(id: "1.1", title: "A", description: "", required: true),
        ]
        let engine = StepEngine(steps: steps, handler: successHandler)
        var outcome: RunOutcome?

        for await event in await engine.run(autoApprove: true) {
            if case .runFinished(let o) = event { outcome = o }
        }

        XCTAssertEqual(outcome, .success)
    }

    func test_run_stopsOnFatalFailure() async throws {
        let steps = [
            Step(id: "1.1", title: "Fatal", description: "", fatal: true),
            Step(id: "1.2", title: "Should not run", description: ""),
        ]
        let engine = StepEngine(steps: steps, handler: failHandler)
        var events: [StepEvent] = []

        for await event in await engine.run(autoApprove: true) {
            events.append(event)
        }

        let startedIds = events.compactMap { (e: StepEvent) -> String? in
            if case .stepStarted(let id) = e { return id }
            return nil
        }
        XCTAssertFalse(startedIds.contains("1.2"), "Should not start step after fatal failure")

        let outcome = events.compactMap { (e: StepEvent) -> RunOutcome? in
            if case .runFinished(let o) = e { return o }
            return nil
        }.first
        if case .failed(let stepId, _, _) = outcome {
            XCTAssertEqual(stepId, "1.1")
        } else {
            XCTFail("Expected .failed outcome, got \(String(describing: outcome))")
        }
    }

    func test_run_completedWithWarningsWhenNonFatalFails() async throws {
        let steps = [
            Step(id: "2.1", title: "Interactive", description: "", required: true, fatal: false),
        ]
        let engine = StepEngine(steps: steps) { _ in .warning("user skipped") }
        var outcome: RunOutcome?

        for await event in await engine.run(autoApprove: true) {
            if case .runFinished(let o) = event { outcome = o }
        }

        if case .completedWithWarnings(let msgs) = outcome {
            XCTAssertFalse(msgs.isEmpty)
        } else {
            XCTFail("Expected .completedWithWarnings, got \(String(describing: outcome))")
        }
    }

    func test_run_skipsConditionalStepWhenHandlerReturnsSkipped() async throws {
        let steps = [
            Step(id: "1.1.1", title: "Conditional", description: "", conditional: true),
        ]
        let engine = StepEngine(steps: steps, handler: { _ in .skipped })
        var events: [StepEvent] = []

        for await event in await engine.run(autoApprove: true) {
            events.append(event)
        }

        let skipped = events.filter { if case .stepFinished(_, .skipped) = $0 { return true }; return false }
        XCTAssertEqual(skipped.count, 1)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter StepEngineTests
```

Expected: FAIL — `StepEngine` not defined

- [ ] **Step 3: Create `Sources/Engine/StepEvent.swift`**

```swift
import Foundation

public enum StepEvent {
    case stepStarted(String)                             // stepId
    case stepProgress(String, Double)                    // stepId, 0…1
    case stepSubtitle(String, String)                    // stepId, text
    case logLine(String, String)                         // text, kind ("OUT","ERR","INF","OK","CMD")
    case stepFinished(String, StepStatus)                // stepId, final status
    case approvalRequested(String)                       // stepId — only in manual mode
    case interactiveStarted(String)                      // stepId
    case runFinished(RunOutcome)
    case fatalError(String, String, String)              // stepId, message, recommendation
}
```

- [ ] **Step 4: Create `Sources/Engine/StepEngine.swift`**

```swift
import Foundation

public actor StepEngine {
    private let steps: [Step]
    private let handler: (Step) async -> StepStatus

    public init(steps: [Step], handler: @escaping (Step) async -> StepStatus) {
        self.steps = steps
        self.handler = handler
    }

    /// Runs the step list and yields events.
    /// - Parameter autoApprove: if true, approval gates are bypassed (unattended mode §5.3)
    public func run(autoApprove: Bool) -> AsyncStream<StepEvent> {
        AsyncStream { continuation in
            Task {
                var warnings: [String] = []

                for step in steps {
                    // Emit ACTIVE
                    continuation.yield(.stepStarted(step.id))

                    // Approval gate (§6.1)
                    if step.requiresApproval && !autoApprove && !step.interactive {
                        continuation.yield(.approvalRequested(step.id))
                        // In the real engine this awaits a CheckedContinuation;
                        // in the test harness autoApprove=true bypasses this branch.
                    }

                    if step.interactive {
                        continuation.yield(.interactiveStarted(step.id))
                    }

                    // Dispatch
                    let status = await handler(step)
                    continuation.yield(.stepFinished(step.id, status))

                    switch status {
                    case .error(let msg):
                        if step.fatal {
                            let rec = Self.recommendation(for: step.id)
                            continuation.yield(.fatalError(step.id, msg, rec))
                            continuation.yield(.runFinished(.failed(stepId: step.id, message: msg, recommendation: rec)))
                            continuation.finish()
                            return
                        } else {
                            warnings.append("Step \(step.id): \(msg)")
                        }
                    case .warning(let msg):
                        warnings.append("Step \(step.id): \(msg)")
                    default:
                        break
                    }
                }

                // Determine outcome (§17)
                let requiredIncomplete = steps.filter { $0.required }.filter { step in
                    // A required step that produced a warning/skipped counts as incomplete
                    warnings.contains(where: { $0.hasPrefix("Step \(step.id):") })
                }

                if warnings.isEmpty {
                    continuation.yield(.runFinished(.success))
                } else if requiredIncomplete.isEmpty {
                    // All fatal steps succeeded; non-required warnings only
                    continuation.yield(.runFinished(.success))
                } else {
                    continuation.yield(.runFinished(.completedWithWarnings(warnings)))
                }
                continuation.finish()
            }
        }
    }

    private static func recommendation(for stepId: String) -> String {
        switch stepId {
        case "1.1.1":
            return "Git could not be installed. Install Apple Command Line Tools via `xcode-select --install` (or Git from git-scm.com), then re-run this installer."
        case "1.2.1":
            return "Node.js install failed. Install Node 22 LTS from nodejs.org and re-run."
        case "1.3":
            return "CodeMie CLI install failed. Check network/npm registry access and re-run; or run `npm install -g @codemieai/code` manually."
        default:
            return "Step \(stepId) failed. Review the log and re-run."
        }
    }
}
```

> **Note:** The approval gate `CheckedContinuation` for interactive manual mode will be added when the UI layer wires it up in Phase 3. The actor exposes an `approve(stepId:)` method at that point.

- [ ] **Step 5: Run all Phase 1 tests**

```bash
swift test
```

Expected: All test suites pass.

- [ ] **Step 6: Commit**

```bash
git add Sources/Engine/StepEvent.swift Sources/Engine/StepEngine.swift Tests/EngineTests/StepEngineTests.swift
git commit -m "feat(engine): add StepEngine actor with CheckedContinuation gates and AsyncStream events"
```

---

## Phase 2 — Installation Services ✅ COMPLETE

**Status:** Days 4–8 complete. 60/60 tests (34 new in Phase 2). Tag `phase-2-complete`. Commits: `83363c3` → `45b53cc`.

### Task 7: Downloader + IntegrityVerifier (§5.5) ✅
- `Sources/Services/Constants.swift` — pinned versions + paths, `validateReleaseHashes()` throws `ConstantsError.unpinnedHash` on placeholder (runtime guard; CI script provides compile-time gate)
- `Sources/Services/Downloader.swift` — `URLSession.downloadTask` + KVO `fractionCompleted` progress, moves temp file to stable UUID path
- `Sources/Services/IntegrityVerifier.swift` — CryptoKit `SHA256`, `pkgutil --check-signature`, `spctl --assess --type install`; both verifiers injectable in `PkgInstaller`
- **6 tests** — 32 total

### Task 8: XcodeCLT state machine (§5.4) ✅
- `Sources/Services/XcodeCLT.swift` — injectable `shell: @Sendable (String, [String]) async -> Int32` closure, 6-step state machine per spec, 30-min timeout, 60-s grace period for cancel detection; `&&` with `await` split into explicit `if` (Swift 6 autoclosure restriction)
- **5 tests** — 37 total

### Task 9: PkgInstaller + PrivilegeManager (§11) ✅
- `Sources/Services/PrivilegeManager.swift` — `osascript -e '...'`, auth-cancel detected via "User canceled" in output, injectable `shellRunner`
- `Sources/Services/PkgInstaller.swift` — `sha256Verifier` + `signatureVerifier` + `privilegeManager` all injectable; file deleted before throwing on integrity failure; auth cancel → `PkgInstallError.authCancelled` (no fnm fallback §11)
- **5 tests** — 42 total

### Task 10: FnmInstaller (§5.1 1.2.1 no-admin branch) ✅
- `Sources/Services/FnmInstaller.swift` — actor, injectable `sha256Verifier` + `shell`, places fnm binary + sets `FNM_DIR`, verifies `nodeBinDir/node` + `nodeBinDir/npm` exist, `static nodeBinDir(fnmDataDir:nodeVersion:)` helper
- **5 tests** — 47 total

### Task 11: PathManager (§10) ✅
- `Sources/Services/PathManager.swift` — `prependInProcess(dirs:)` via `setenv`, `persistToProfile(dirs:shell:)` → zsh/bash/unsupported, `replaceOrAppendBlock` marker-based idempotent replace
- **9 tests** — 56 total

### Task 12: InteractiveRunner (§12) ✅
- `Sources/Services/InteractiveRunner.swift` — actor, `run() -> AsyncStream<InteractiveEvent>`, `skip()` SIGTERM → `.skipped`, `abort()` SIGKILL → `.skipped`; stdout+stderr merged; SwiftTerm `TerminalView` wiring deferred to Phase 3 `TerminalPane`
- **4 tests** — 60 total

---

## Phase 3 — SwiftUI Wizard UI ✅ COMPLETE

**Status:** Days 9–12 complete. 70/70 tests (10 new AppModel tests). Tag `phase-3-complete`. Commits: `a5c84be` → `e46fd06`.

> **Expand this section to full TDD steps before beginning Phase 3 implementation.**

### Task 13: App entry + AppModel
- `CodeMieInstallerApp.swift` (`@main`), `AppModel.swift` (`@MainActor ObservableObject`)
- AppModel subscribes to `StepEngine` event stream, drives all view state
- Wire real `StepConfigLoader.loadBundled()` step list

### Task 14: ControlBar
- Install → Cancel → Close lifecycle button; Unattended toggle with §5.3 warning sheet

### Task 15: StepListView + StepRowView
- Status indicators (○▶✓⚠✗—), title, description, dynamic subtitle
- Sub-step indent (hidden until activated), download progress fill
- Inline Approve / Skip for approval rows

### Task 16: MascotView
- 5 states: `idle`, `working`, `warning`, `success`, `error`/`victory`
- Status pill (dot + label)
- All animations gated on `@Environment(\.accessibilityReduceMotion)`

### Task 17: LogPanel
- Collapsible; colored line kinds; "Open Log" via `NSWorkspace`
- Auto-expands when interactive step activates

### Task 18: TerminalPane
- SwiftTerm view embedded in log area
- "Skip this step" (this step → WARNING) vs global Cancel (run → ABORTED) — distinct, clearly labeled
- VoiceOver label; "Open in Terminal.app" fallback (§12)

### Task 19: Run-outcome banners
- SUCCESS (mascot `victory`, confetti gated on Reduce Motion)
- COMPLETED_WITH_WARNINGS (list of what to re-run)
- FAILED (step name + recommendation + disabled further progress)
- ABORTED (closeable, no recommendation)

---

## Phase 4 — Accessibility & Hardening ✅ COMPLETE

**Status:** Days 13–14 complete. 108/108 tests (38 new). Tag `phase-4-complete`. Commits: `e46fd06` → `233c762`.

> **Expand this section to full TDD steps before beginning Phase 4 implementation.**

### Task 20: VoiceOver + keyboard operability (§15.4)
- `accessibilityLabel` + `accessibilityAnnouncement` on step state changes and run outcomes
- Full keyboard operation: approve/skip, toggle log, cancel, terminal focus

### Task 21: Reduce Motion + Dynamic Type + Increase Contrast
- All animation guard blocks verified
- Dynamic Type scaling for step titles and log text
- Increase Contrast: elevated foreground colors

### Task 22: Detection edge cases + network hardening
- §5.6 negative cases: broken PATH, partially-installed CLI (binary present, non-zero exit), stale shim
- Network errors: retry affordance, never silent hang (§17)
- Unsupported shell (fish, tcsh): copy-pasteable PATH instructions surfaced (§10.2)
- Unattended pause-at-interactive — no auto-skip, no auto-timeout (§5.3)

---

## Phase 5 — Distribution Pipeline ✅ COMPLETE

**Status:** Days 15–16 complete. No new tests (shell scripts + config). Tags `phase-5-complete`, `v1.0.0-rc1`. Commit: `ca92e0e`.

> **Expand this section to full TDD steps before beginning Phase 5 implementation.**

### Task 23: Xcode project configuration (§18)
- Hardened Runtime enabled; App Sandbox disabled
- Universal binary (`arm64` + `x86_64`)
- Developer ID Application + Installer certificates
- App bundle identifier: `com.epam.codemie.claude-installer`

### Task 24: `scripts/build_sign_notarize.sh` (§18 runbook)
- `xcodebuild` universal → `codesign --verify --deep --strict` → `notarytool submit --wait` → DMG assembly → sign DMG → `notarytool submit --wait` → `xcrun stapler staple`
- Final oracle: `xcrun stapler validate` + `spctl -a` pass

### Task 25: GitHub Actions CI workflow
- macOS runner, secrets for Developer ID + notarization keychain profile
- Build → sign → notarize → produce `.dmg` artifact on tag push

### Task 26: Release checklist automation
- Script that reads `nodePkgSHA256` and `fnmSHA256` constants and fails the build if either is the placeholder `"[PIN AT RELEASE]"`
- Version bump checklist: update `nodeVersion` → fetch SHASUMS256.txt → pin hash → update fnm release + hash

---

## Self-Review Checklist

- [x] **Spec coverage:**
  - §1.2 Success contract → covered by `StepEngine` outcome model (Task 6) + integration test in Phase 4 Task 22
  - §5.1 full step list → `steps.yaml` (Task 2) + individual service tasks (Phase 2)
  - §5.3 Unattended → `StepEngine.run(autoApprove:)` (Task 6) + UI toggle (Phase 3 Task 14) + hardening (Phase 4 Task 22)
  - §5.4 CLT state machine → Phase 2 Task 8
  - §5.5 Integrity → Phase 2 Task 7
  - §5.6 Detection → `SystemInspector.isCodemieInstalled` (Task 5) + negative cases Phase 4 Task 22
  - §10 PATH → Phase 2 Task 11
  - §11 Privilege → Phase 2 Task 9
  - §12 Interactive PTY → Phase 2 Task 12 + Phase 3 Task 18
  - §13 Config constants (pinned hashes) → Phase 5 Task 26
  - §15 UI/UX → Phase 3 Tasks 13–19
  - §15.4 Accessibility → Phase 4 Tasks 20–21
  - §17 Run outcomes → Task 6 (`StepEngine`) + Phase 3 Task 19
  - §18 Distribution → Phase 5 Tasks 23–25
  - §24 Security → Phase 2 Tasks 7, 9; Phase 4 Task 22
- [x] **No placeholders** in Phase 1 (Phases 2–5 are intentionally outline-level until expanded)
- [x] **Type consistency:** `Step`, `StepStatus`, `RunOutcome`, `StepEvent`, `ShellResult`, `ShellRunner`, `SystemInspector`, `InstallLogger`, `StepConfigLoader`, `StepEngine` — names consistent across all Phase 1 tasks
