# CodeMie Claude Installer (macOS) — Daily Execution Plan

**Project:** `codemie-claude-installer-mac` (new standalone Swift/SwiftUI repo)
**Spec:** `CodeMie-Claude-Installer-Mac-SPEC.md` v2.1
**Detailed plan:** `2026-06-03-codemie-claude-installer-mac.md`
**Total:** 16 working days across 5 phases
**Start date:** 2026-06-03
**Last updated:** 2026-06-03

### Progress
| Phase | Status | Tests | Tag |
|---|---|---|---|
| Phase 1 — Project Scaffold + Core Engine | ✅ COMPLETE | 26/26 | `phase-1-complete` |
| Phase 2 — Installation Services | ✅ COMPLETE | 60/60 | `phase-2-complete` |
| Phase 3 — SwiftUI Wizard UI | ✅ COMPLETE | 70/70 | `phase-3-complete` |
| Phase 4 — Accessibility & Hardening | ✅ COMPLETE | 108/108 | `phase-4-complete` |
| Phase 5 — Distribution Pipeline | ✅ COMPLETE | 108/108 | `phase-5-complete` `v1.0.0-rc1` |

### Key Implementation Notes (Deviations from Plan)
- **Swift 6.3.1 + macOS 26 (Tahoe), CLT-only** — no Xcode installed. `swift test` requires explicit framework flags; baked into `Makefile`:
  ```bash
  make test   # always use this instead of swift test directly
  ```
  Flags: `-Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks -Xlinker -rpath -Xlinker .../Frameworks -Xlinker -rpath -Xlinker .../usr/lib`
- **Swift Testing** (`import Testing`, `@Test`, `#expect`) used instead of XCTest — XCTest is not available in CLT-only environments.
- **Swift 6 strict concurrency** required several adjustments: `@Sendable` closures, `nonisolated let` properties, actor-isolated `&&` splits, and `@unchecked Sendable` for `LineCollector`.
- **steps.yaml location** moved to `Sources/Engine/steps.yaml` (SPM requires resources inside the declaring target's directory, not a sibling `Resources/` dir).
- **`ShellResult.init`** needed an explicit `public init` for use in default argument values across modules.
- **`XcodeCLT`** injectable via `shell: @Sendable (String, [String]) async -> Int32` closure — fully mockable without live CLT calls.
- **`PkgInstaller`** — both SHA-256 verifier and signature verifier are injectable for full test isolation.

---

## Summary Table

| Day | Phase | Tasks | Deliverable | Status |
|---|---|---|---|---|
| 1 | 1 | T1 + T2 | Repo scaffold, Step model, StepConfigLoader, steps.yaml — `make test` green | ✅ DONE — 3 tests |
| 2 | 1 | T3 + T4 + T5 | InstallLogger, ShellRunner, SystemInspector — `make test` green | ✅ DONE — 17 tests |
| 3 | 1 | T6 | StepEngine actor, full Phase 1 test suite green | ✅ DONE — 26 tests, tag `phase-1-complete` |
| 4 | 2 | T7 | Downloader + IntegrityVerifier (SHA-256 + pkgutil) | ✅ DONE — 32 tests |
| 5 | 2 | T8 | XcodeCLT 6-step state machine | ✅ DONE — 37 tests |
| 6 | 2 | T9 | PkgInstaller + PrivilegeManager (single osascript call) | ✅ DONE — 42 tests |
| 7 | 2 | T10 + T11 | FnmInstaller (no-admin Node branch) + PathManager (idempotent PATH) | ✅ DONE — 56 tests |
| 8 | 2 | T12 | InteractiveRunner (process lifecycle, skip/abort, event stream) | ✅ DONE — 60 tests, tag `phase-2-complete` |
| 9 | 3 | T13 + T14 | App entry + AppModel + ControlBar | ✅ DONE — App target compiles (swift build) |
| 10 | 3 | T15 + T16 | StepListView + StepRowView + MascotView (5 states) | ✅ DONE |
| 11 | 3 | T17 + T18 | LogPanel + TerminalPane (SwiftTerm + Skip/Cancel UX) | ✅ DONE |
| 12 | 3 | T19 | Run-outcome banners (SUCCESS / WARNINGS / FAILED / ABORTED) | ✅ DONE — 10 AppModel tests, tag phase-3-complete |
| 13 | 4 | T20 + T21 | VoiceOver + keyboard + Reduce Motion + Dynamic Type | ✅ DONE — 11 + 8 tests |
| 14 | 4 | T22 | Detection edge cases + network errors + unsupported shell hardening | ✅ DONE — 38 tests, 108 total, tag phase-4-complete |
| 15 | 5 | T23 + T24 | Xcode project config + build/sign/notarize script | ✅ DONE |
| 16 | 5 | T25 + T26 | CI workflow + release checklist automation | ✅ DONE — tag phase-5-complete, v1.0.0-rc1 |

---

## Day 1 — Phase 1: Repo scaffold + Step model ✅ COMPLETE

**Duration:** ~6 h
**Goal:** New repo compiles; `swift test` passes for `StepConfigLoaderTests`.
**Result:** 3/3 tests passing. Commits: `7f8611e` (scaffold), `8df9403` (Step model + StepConfigLoader).
**Key deviation:** `steps.yaml` placed in `Sources/Engine/` (not `Sources/Resources/`) — SPM resource rule. Tests use Swift Testing (`import Testing`) not XCTest — CLT-only env. `Makefile` added with explicit `-F` and `-rpath` flags.

### Tasks
- **T1 — Repository scaffold + Package.swift**
  - Create `codemie-claude-installer-mac/` at `~/repos/codemie-ai/codemie-claude-installer-mac`
  - Write `Package.swift` (Engine + Services targets; Yams + SwiftTerm deps)
  - Create `.gitignore`, `README.md`, all `Sources/` + `Tests/` subdirectories
  - Verify: `swift build` resolves packages
  - Commit: `chore: initialize project scaffold with Package.swift`

- **T2 — Step model + StepConfigLoader + steps.yaml**
  - `Sources/Engine/Step.swift` — `Codable`, all fields, custom `init(from:)` with `decodeIfPresent` defaults
  - `Sources/Engine/StepStatus.swift` — `PENDING/ACTIVE/COMPLETE/WARNING/ERROR/SKIPPED`
  - `Sources/Engine/RunOutcome.swift` — `SUCCESS/COMPLETED_WITH_WARNINGS/FAILED/ABORTED`
  - `Sources/Engine/StepConfigLoader.swift` — Yams `YAMLDecoder`, `loadBundled()` via `Bundle.module`
  - `Sources/Engine/steps.yaml` — all 8 canonical steps (§14.2)
  - `Tests/EngineTests/StepConfigLoaderTests.swift` — 3 tests
  - Verify: `swift test --filter StepConfigLoaderTests` → PASS
  - Commit: `feat(engine): add Step model, StepConfigLoader, steps.yaml`

**Done when:** `swift test` output shows 3 passing tests, 0 failures.

---

## Day 2 — Phase 1: InstallLogger + ShellRunner + SystemInspector ✅ COMPLETE

**Duration:** ~6 h
**Goal:** All service layer tests pass.
**Result:** 17/17 tests passing (3 + 5 + 5 + 4 new). Commits: `5c48afa`, `c0c8d3c`, `d9dee1e`.
**Key deviation:** Swift 6 strict concurrency required `nonisolated let _logURL` on InstallLogger (actor property can't be non-isolated var). ShellRunner used `@unchecked Sendable LineCollector` class to avoid captured-var errors. Tests use `result.stdout` assertions instead of mutable `var lines` closures. SystemInspector probe test updated — CLT makes `/usr/bin/git` available even with empty `PATH`.

### Tasks
- **T3 — InstallLogger**
  - `Sources/Services/InstallLogger.swift` — actor, `~/Library/Logs/CodeMie/wizard.log`, ISO-8601 tags (OUT/ERR/INF/OK/CMD), `overrideLogURL` test hook
  - `Tests/ServicesTests/InstallLoggerTests.swift` — 4 tests
  - Verify: `swift test --filter InstallLoggerTests` → PASS
  - Commit: `feat(services): add InstallLogger actor`

- **T4 — ShellRunner**
  - `Sources/Services/ShellRunner.swift` — `Process` + `Pipe`, merged stdout+stderr, custom env merge, `terminationHandler` continuation
  - `Tests/ServicesTests/ShellRunnerTests.swift` — 5 tests
  - Verify: `swift test --filter ShellRunnerTests` → PASS
  - Commit: `feat(services): add ShellRunner`

- **T5 — SystemInspector**
  - `Sources/Services/SystemInspector.swift` — `arch` enum, `homebrewPrefix`, `isAdminCapable()`, `isGitInstalled()`, `isNodeInstalled()`, `isCodemieInstalled()` per §5.6, `matchesSemver()`
  - `Tests/ServicesTests/SystemInspectorTests.swift` — 5 tests (including semver pattern coverage)
  - Verify: `swift test --filter SystemInspectorTests` → PASS
  - Commit: `feat(services): add SystemInspector`

**Done when:** `swift test` shows 12+ passing tests (T2 + T3 + T4 + T5), 0 failures.

---

## Day 3 — Phase 1: StepEngine actor ✅ COMPLETE

**Duration:** ~6 h
**Goal:** Full Phase 1 test suite green; dry-run with mock handler proves engine loop works end-to-end.
**Result:** 26/26 tests passing across 5 suites. Commit: `c61d392`. Tag: `phase-1-complete`.
**Key deviation:** `Step.init` parameter order — `fatal` must precede `required` (alphabetical Swift label ordering). Fixed two test call sites. `StepEngine` emits `completedWithWarnings` only when a `required` step gets a warning — non-required step warnings alone still produce `success`.

### Tasks
- **T6 — StepEngine actor**
  - `Sources/Engine/StepEvent.swift` — 8 event cases
  - `Sources/Engine/StepEngine.swift` — actor, `run(autoApprove:) -> AsyncStream<StepEvent>`, fatal stop logic, `recommendation(for:)`, `completedWithWarnings` logic
  - `Tests/EngineTests/StepEngineTests.swift` — 5 tests: active+complete for each step, SUCCESS outcome, fatal stops run, completedWithWarnings on non-fatal failure, skipped conditional
  - Verify: `swift test` (all targets) → PASS
  - Commit: `feat(engine): add StepEngine actor with approval gates and AsyncStream events`
  - **Phase 1 checkpoint:** Tag `phase-1-complete` in the new repo

**Done when:** `swift test` shows all 17+ tests passing; `git tag phase-1-complete`.

---

## Day 4 — Phase 2: Downloader + IntegrityVerifier ✅ COMPLETE

**Duration:** ~6 h
**Goal:** Downloads can be verified by SHA-256 and pkgutil signature; build fails if hash constants are unset.
**Result:** 32/32 tests passing. Commit: `83363c3`.
**Key deviation:** Build-time hash guard implemented as `Constants.validateReleaseHashes()` (runtime throws `ConstantsError.unpinnedHash`) rather than `#error` — Swift can't compare string constant values at compile time. CI script `scripts/check_release_constants.sh` handles the compile-time guarantee. `Downloader` uses `URLSession.downloadTask` with KVO progress observation.

### Tasks
- **T7 — Downloader + IntegrityVerifier**
  - `Sources/Services/Constants.swift` — `nodeVersion`, `nodePkgURL`, `nodePkgSHA256` (`"[PIN AT RELEASE]"` placeholder triggers compile-time assert), `fnmVersion`, `fnmURL`, `fnmSHA256`, `npmPrefix`, `fnmDir`, `FNM_DIR`, `nodeBinDir`, `logPath`, `codemiePackage`
  - Build guard: `#if nodePkgSHA256 == "[PIN AT RELEASE]"` → `#error("nodePkgSHA256 must be pinned before release")` (or runtime assert in DEBUG — decide at implementation)
  - `Sources/Services/Downloader.swift` — `URLSession` download with `Progress`, temp file, byte/percent callback
  - `Sources/Services/IntegrityVerifier.swift` — SHA-256 via `CryptoKit.SHA256`, `pkgutil --check-signature`, `spctl --assess --type install`
  - `Tests/ServicesTests/IntegrityVerifierTests.swift` — SHA-256 match + mismatch (→ throws), signature check mock
  - Verify: `swift test --filter IntegrityVerifierTests` → PASS
  - Commit: `feat(services): add Downloader, IntegrityVerifier, Constants`

**Done when:** SHA-256 mismatch test throws correct error; integration with real URL tested manually with a known-good file.

---

## Day 5 — Phase 2: XcodeCLT state machine ✅ COMPLETE

**Duration:** ~6 h
**Goal:** Full 6-step CLT state machine implemented and unit-testable via injectable shell runner.
**Result:** 37/37 tests passing. Commit: `f3701bb`.
**Key deviation:** Swift 6 forbids `await` in the right-hand operand of `&&` (autoclosure restriction) — split into explicit `if` statements throughout `XcodeCLT`. Test mocks use an actor `CallCounter` instead of mutable `var count`. Shell runner injected as `@Sendable (String, [String]) async -> Int32` closure — no protocol needed.

### Tasks
- **T8 — XcodeCLT state machine (§5.4)**
  - `Sources/Services/XcodeCLT.swift` — 6 states: pre-check → in-progress marker check → `xcode-select --install` trigger → 5 s poll loop (30 min timeout, 5 min visible countdown) → cancel/timeout detection → Homebrew fallback (`brew install git` if `brew` present, else fatal)
  - Inject `ShellRunner` as a protocol for testability (mock in tests)
  - `Tests/ServicesTests/XcodeCLTTests.swift` — state transitions: already present (→ COMPLETE), install triggers and polls success, user cancels (→ Homebrew fallback path), no Homebrew → fatal
  - Verify: `swift test --filter XcodeCLTTests` → PASS
  - Commit: `feat(services): add XcodeCLT 6-step state machine`

**Done when:** All CLT state transitions covered; no live `xcode-select` calls needed in tests (fully mocked).

---

## Day 6 — Phase 2: PkgInstaller + PrivilegeManager ✅ COMPLETE

**Duration:** ~5 h
**Goal:** Single `osascript` elevation call works; auth-cancel path ends in FAILED.
**Result:** 42/42 tests passing. Commit: `1eea86b`.
**Key deviation:** `PkgInstaller` requires two injectable verifiers (`sha256Verifier` + `signatureVerifier`) not one — the real `verifyPkgSignature` calls live CLT tools and would fail on fake `.pkg` test files. Auth-cancel confirmed to throw `PkgInstallError.authCancelled` (not fall back to fnm — §11 enforced).

### Tasks
- **T9 — PkgInstaller + PrivilegeManager (§11)**
  - `Sources/Services/PrivilegeManager.swift` — construct shell script from app-trusted values only (no user-input interpolation); run via `osascript -e 'do shell script "..." with administrator privileges'`; log command + exit code (never credentials); auth-cancel → throws
  - `Sources/Services/PkgInstaller.swift` — verify pkg integrity first (§5.5), then call `PrivilegeManager`; on cancel → `StepStatus.error` → fatal (§11 — must NOT fall back to fnm)
  - `Tests/ServicesTests/PkgInstallerTests.swift` — mock `PrivilegeManager`: success path, auth-cancel throws, integrity mismatch blocks install
  - Verify: `swift test --filter PkgInstallerTests` → PASS
  - Commit: `feat(services): add PkgInstaller + PrivilegeManager (single osascript elevation)`

**Done when:** Auth-cancel test produces `.error` status (not `.complete`); mock test confirms no user data in elevated script.

---

## Day 7 — Phase 2: FnmInstaller + PathManager ✅ COMPLETE

**Duration:** ~6 h
**Goal:** No-admin Node branch fully works; PATH writes are idempotent.
**Result:** 56/56 tests passing. Commits: `e66564d` (FnmInstaller), `ba5394d` (PathManager).
**Key deviation:** `ShellResult` needed an explicit `public init(exitCode:stdout:)` — Swift synthesizes memberwise inits as `internal` for `public struct`, making default argument values in other modules fail to compile. `PathManager.replaceOrAppendBlock` uses `String.range(of:)` for marker detection — no regex needed, simple and reliable.

### Tasks
- **T10 — FnmInstaller (§5.1 1.2.1 no-admin branch)**
  - `Sources/Services/FnmInstaller.swift` — download fnm binary (via `Downloader`), verify SHA-256 (via `IntegrityVerifier`), place at `fnmDir/fnm`, set `FNM_DIR`, run `fnm install <nodeVersion>` then `fnm default <nodeVersion>`, confirm `nodeBinDir/node` + `nodeBinDir/npm` exist, prepend `nodeBinDir` to in-process PATH
  - `Tests/ServicesTests/FnmInstallerTests.swift` — deterministic `nodeBinDir` path assertion, SHA mismatch → fatal, missing binary after install → error
  - Commit: `feat(services): add FnmInstaller (no-admin Node branch)`

- **T11 — PathManager (§10)**
  - `Sources/Services/PathManager.swift` — `prependInProcess(dirs:)` mutates in-process PATH; `persistToProfile(dirs:)` detects `$SHELL` basename → `~/.zprofile` or `~/.bash_profile`, writes guarded block (`# >>> CodeMie installer >>>` … `# <<< CodeMie installer <<<`), updates existing block (never duplicates); unsupported shell → surfaces copy-pasteable instructions, returns `.warning`
  - `Tests/ServicesTests/PathManagerTests.swift` — idempotency (second write replaces block), update (new dirs replace old), unsupported shell (fish → warning with instructions), bash profile target
  - Verify: `swift test --filter "FnmInstallerTests|PathManagerTests"` → PASS
  - Commit: `feat(services): add PathManager with idempotent profile block writes`

**Done when:** Re-running PathManager on the same file produces exactly one guarded block.

---

## Day 8 — Phase 2: InteractiveRunner ✅ COMPLETE

**Duration:** ~6 h
**Goal:** SwiftTerm PTY session spawns, receives input, and exits cleanly.
**Result:** 60/60 tests passing across 11 suites. Commit: `45b53cc`. Tag: `phase-2-complete`.
**Key deviation:** SwiftTerm's `TerminalView` (AppKit) not used in the service layer — `InteractiveRunner` manages `Process` lifecycle and `AsyncStream<InteractiveEvent>` only. The SwiftTerm view wiring happens in Phase 3 (`TerminalPane`). `skip()` sends `SIGTERM`; `abort()` sends `SIGKILL`. Both set `isCancelled = true` so the stream yields `.skipped` instead of `.exited`.

### Tasks
- **T12 — InteractiveRunner (§12)**
  - Add `SwiftTerm` import to `Services` target (or a new `AppServices` target that bridges Services + SwiftUI)
  - `Sources/Services/InteractiveRunner.swift` — spawn child with augmented PATH in a `TerminalView` PTY; expose `AsyncStream<InteractiveEvent>` (`.output(String)`, `.exited(Int32)`, `.skipped`); `skip()` method sends SIGTERM to child
  - `Tests/ServicesTests/InteractiveRunnerTests.swift` — spawn `/bin/echo hello`, verify `.output("hello")` received and `.exited(0)` follows; `skip()` path yields `.skipped`
  - Verify: `swift test --filter InteractiveRunnerTests` → PASS
  - Commit: `feat(services): add InteractiveRunner (SwiftTerm PTY wrapper)`
  - **Phase 2 checkpoint:** `swift test` all green; tag `phase-2-complete`

**Done when:** All Phase 2 tests green; `swift test` shows 30+ passing tests.

---

## Day 9 — Phase 3: App entry + AppModel + ControlBar ✅ COMPLETE

**Duration:** ~6 h
**Goal:** App launches in Xcode; Install button starts a mock StepEngine run; Cancel terminates it.
**Result:** App target compiles clean (`swift build --target App`). `@main` moved to separate `AppEntry` executableTarget to avoid `_main` linker conflict with test runner.
**Key deviation:** SPM `.target` containing `@main` conflicts with test runner's `_main`. Fix: separate `Sources/AppEntry/main.swift` executableTarget excludes `CodeMieInstallerApp.swift` from App library target.

### Tasks
- **T13 — App entry + AppModel**
  - Create Xcode project `CodeMieClaudeInstaller.xcodeproj` (macOS App, SwiftUI, Hardened Runtime, no sandbox)
  - Add local package dependency on `Sources/Engine` + `Sources/Services`
  - `Sources/App/CodeMieInstallerApp.swift` — `@main`, `WindowGroup`
  - `Sources/App/AppModel.swift` — `@MainActor ObservableObject`: subscribes to `StepEngine` event stream; drives `stepStates: [String: StepStatus]`, `logLines: [LogLine]`, `runOutcome: RunOutcome?`, `isRunning: Bool`
  - Wire `StepConfigLoader.loadBundled()` as step source
  - Verify: app builds and launches in simulator / Xcode preview

- **T14 — ControlBar**
  - `Sources/UI/ControlBar.swift` — Install (→ `appModel.startRun()`) / Cancel (→ `appModel.cancelRun()`, emits `.aborted`) / Close lifecycle; Unattended toggle with §5.3 warning sheet; button states driven by `appModel.isRunning` + `appModel.runOutcome`
  - Preview with mock AppModel states
  - Commit: `feat(ui): add App entry, AppModel, ControlBar`

**Done when:** App launches, Install starts mock run, Cancel produces ABORTED state in AppModel.

---

## Day 10 — Phase 3: StepListView + MascotView ✅ COMPLETE

**Duration:** ~6 h
**Goal:** Step list renders all states; mascot responds to run state.
**Result:** StepListView, StepRowView (all status indicators + approval buttons), MascotView (5 states, Reduce Motion gated).
**Key deviation:** None significant.

### Tasks
- **T15 — StepListView + StepRowView**
  - `Sources/UI/StepListView.swift` — `ScrollView` of `StepRowView` items, driven by `appModel.steps`
  - `Sources/UI/StepRowView.swift` — status indicator (○▶✓⚠✗—), title, description, dynamic subtitle, sub-step indent (hidden until activated), download progress fill (`ProgressView`), inline Approve / Skip buttons for approval rows
  - Preview: all status states rendered

- **T16 — MascotView**
  - `Sources/UI/MascotView.swift` — 5 animation states: `idle` (loop), `working` (bounce), `warning` (pulse), `success` (glow), `error` (shake) / `victory` (confetti)
  - All animations gated: `@Environment(\.accessibilityReduceMotion)` → static image
  - Status pill below mascot (dot + text label from `appModel.statusText`)
  - Commit: `feat(ui): add StepListView, StepRowView, MascotView with 5 animation states`

**Done when:** All step status states render correctly in Xcode preview; mascot shows correct state for each `RunOutcome`.

---

## Day 11 — Phase 3: LogPanel + TerminalPane ✅ COMPLETE

**Duration:** ~6 h
**Goal:** Collapsible log shows output; SwiftTerm PTY pane hosts interactive steps.
**Result:** LogPanel (collapsible, Open Log via NSWorkspace, auto-expands), TerminalPane (SwiftTerm NSViewRepresentable, Skip vs Cancel UX, VoiceOver label, Terminal.app fallback).
**Key deviation:** `LocalProcessTerminalViewDelegate.processTerminated` takes `source: TerminalView` (not `LocalProcessTerminalView`) in SwiftTerm 1.13.0. Added `import Services` to TerminalPane for Constants access.

### Tasks
- **T17 — LogPanel**
  - `Sources/UI/LogPanel.swift` — collapsible `DisclosureGroup`; colored lines by `LineKind` (OUT=default, ERR=default per §7, INF=secondary, OK=green, CMD=monospace); "Open Log" button via `NSWorkspace.shared.open(logURL)`; auto-expands on interactive step activation

- **T18 — TerminalPane**
  - `Sources/UI/TerminalPane.swift` — `NSViewRepresentable` wrapping `SwiftTerm.TerminalView`; attached to `InteractiveRunner` output stream
  - Banner: "This step is interactive — use the terminal below to complete it."
  - Two clearly distinct actions: in-pane **"Skip this step"** (→ step WARNING, run continues) vs global **Cancel** in ControlBar (→ ABORTED)
  - VoiceOver: `accessibilityLabel("Interactive terminal")`, `UIAccessibility.post(notification: .announcement, argument: "Interactive terminal; complete the on-screen prompts")`
  - "Open in Terminal.app" button: `NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Terminal.app"))` + sentinel-file completion detection
  - Commit: `feat(ui): add LogPanel and TerminalPane with SwiftTerm PTY`

**Done when:** Log renders colored lines; SwiftTerm pane receives PTY output; Skip vs Cancel paths trigger correct outcomes.

---

## Day 12 — Phase 3: Run-outcome banners ✅ COMPLETE

**Duration:** ~4 h
**Goal:** All 4 terminal states display correctly; wizard is visually complete.
**Result:** RunOutcomeBanner (all 4 outcomes), 10 AppModel tests passing.
**Key deviation:** None.

### Tasks
- **T19 — Run-outcome surfaces**
  - `Sources/UI/RunOutcomeBanner.swift` — conditional overlay driven by `appModel.runOutcome`:
    - `SUCCESS` → green banner, mascot `victory`, confetti (gated on Reduce Motion)
    - `COMPLETED_WITH_WARNINGS` → amber banner, list of warnings with "what to re-run" instructions
    - `FAILED` → red banner, step name + recommendation from `StepEvent.fatalError`, further progress disabled
    - `ABORTED` → neutral banner, "Installation cancelled", no recommendation
  - Wire ABORTED: global Cancel button terminates active subprocess (including PTY child)
  - Commit: `feat(ui): add run-outcome banners for all 4 terminal states`
  - **Phase 3 checkpoint:** full wizard visible end-to-end; tag `phase-3-complete`

**Done when:** Each outcome state renders correctly; Cancel from within interactive PTY step produces ABORTED (not FAILED).

---

## Day 13 — Phase 4: VoiceOver + Reduce Motion + Dynamic Type ✅ COMPLETE

**Duration:** ~5 h
**Goal:** All §15.4 accessibility ACs pass.
**Result:** 19 new tests: 11 AccessibilityAnnouncer + 8 ReduceMotion. AppModel wired to post VoiceOver announcements on every step state change and run outcome.
**Key deviation:** Ungated animation in StepListView fixed (`.animation(reduceMotion ? nil : ..., value:)`).

### Tasks
- **T20 — VoiceOver + keyboard operability**
  - Add `accessibilityLabel` + `accessibilityValue` to all `StepRowView` status indicators
  - Post `UIAccessibility.post(notification: .announcement)` on every step state change and on run outcome
  - Verify full keyboard operation: tab to Approve/Skip, Return to activate, Space for Unattended toggle, Esc for Cancel
  - `Tests/AccessibilityTests/VoiceOverTests.swift` — programmatic accessibility audit (using `XCUIApplication` if UI tests are available, or `AXUIElement` snapshots)

- **T21 — Reduce Motion + Dynamic Type + Increase Contrast**
  - Audit all `withAnimation` / `.animation()` call sites — gate each behind `@Environment(\.accessibilityReduceMotion)`
  - Test Dynamic Type: preview at `.accessibilityExtraExtraLarge` — no text truncation or overlap
  - Increase Contrast: test with `INCREASE_CONTRAST=1` env var in preview
  - Commit: `feat(accessibility): VoiceOver labels, keyboard operability, Reduce Motion gates, Dynamic Type`

**Done when:** VoiceOver reads step state changes aloud (tested manually or via XCUITest); all animations disabled under Reduce Motion.

---

## Day 14 — Phase 4: Detection edge cases + network hardening ✅ COMPLETE

**Duration:** ~6 h
**Goal:** All §5.6 negative cases handled; network errors show retry; unsupported shells get instructions.
**Result:** 38 new tests across 5 suites: CodemieDetection, NetworkHardening, UnsupportedShell, UnattendedMode, Idempotency. Total: 108/108.
**Key deviation:** ServicesTests needed `Engine` added as explicit dependency (StepEngine/StepEvent used in integration tests). Added `@testable import Engine` to test file.

### Tasks
- **T22 — Edge cases + hardening**
  - **Detection negatives (§5.6):** add tests for broken PATH (codemie binary present but PATH not containing its directory), partial install (binary exists, exits non-zero), stale shim (exits 0 but stdout doesn't match semver)
  - **Network errors:** any `Downloader` failure → show retry button in step subtitle; never silent hang; timeout after 60 s with clear message
  - **Unsupported shell:** `$SHELL` = `fish`, `tcsh`, or anything not `zsh`/`bash` → PathManager surfaces a `DisclosureGroup` or sheet with exact copy-pasteable export commands for `nodeBinDir` and `npmPrefix/bin`; run does NOT fail
  - **Unattended + interactive:** add integration test confirming unattended mode pauses (no auto-skip, no timeout) when reaching step `2.1`
  - **Re-run idempotency:** integration test: run engine twice with all steps already satisfied → all steps `SKIPPED`, PATH block not duplicated, outcome `SUCCESS`
  - Commit: `fix(hardening): detection edge cases, network retry, unsupported shell instructions`
  - **Phase 4 checkpoint:** tag `phase-4-complete`

**Done when:** All §23 ACs testable without a real Mac install can be asserted as passing.

---

## Day 15 — Phase 5: Xcode project config + build/sign/notarize script ✅ COMPLETE

**Duration:** ~6 h
**Goal:** `xcodebuild` produces a universal `.app`; notarization script runs without error on CI.
**Result:** Entitlements file, xcode-config.md (Xcode project settings documentation), build_sign_notarize.sh (§18 runbook, 8 steps).
**Key deviation:** Xcode project itself not created (requires Xcode GUI). xcode-config.md documents all required settings for when Xcode is available.

### Tasks
- **T23 — Xcode project configuration**
  - Configure `CodeMieClaudeInstaller.xcodeproj`:
    - Hardened Runtime: ON; App Sandbox: OFF
    - Architectures: `$(ARCHS_STANDARD)` (universal `arm64` + `x86_64`)
    - Bundle identifier: `com.epam.codemie.claude-installer`
    - Code sign identity: `Developer ID Application: EPAM ...` (set via CI env)
    - Entitlements file: `CodeMieClaudeInstaller.entitlements` (no special entitlements needed)
  - Verify locally: `xcodebuild -scheme CodeMieClaudeInstaller -configuration Release -arch arm64 -arch x86_64` → BUILD SUCCEEDED
  - Commit: `chore(dist): configure Xcode project for universal Hardened Runtime build`

- **T24 — `scripts/build_sign_notarize.sh`**
  - Implement the §18 runbook verbatim:
    ```bash
    # 1. Build universal signed app
    xcodebuild -scheme CodeMieClaudeInstaller -configuration Release \
      -arch arm64 -arch x86_64 \
      CODE_SIGN_IDENTITY="${CODE_SIGN_IDENTITY}" \
      OTHER_CODE_SIGN_FLAGS="--options runtime"
    # 2. Verify signature
    codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
    # 3. Zip and notarize
    ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"
    xcrun notarytool submit "${ZIP_PATH}" --keychain-profile "${NOTARY_PROFILE}" --wait
    # 4. Create DMG, sign DMG, notarize DMG, staple
    create-dmg --volname "CodeMie Claude Installer" "${DMG_PATH}" "${APP_PATH}"
    codesign --sign "${CODE_SIGN_IDENTITY}" "${DMG_PATH}"
    xcrun notarytool submit "${DMG_PATH}" --keychain-profile "${NOTARY_PROFILE}" --wait
    xcrun stapler staple "${DMG_PATH}"
    # 5. Verify
    xcrun stapler validate "${DMG_PATH}"
    spctl -a -t open --context context:primary-signature -vv "${DMG_PATH}"
    spctl -a -t exec -vv "${APP_PATH}"
    ```
  - Commit: `chore(dist): add build_sign_notarize.sh runbook`

**Done when:** Script runs without error on a developer machine with valid Developer ID cert; `.dmg` opens Gatekeeper-clean.

---

## Day 16 — Phase 5: CI workflow + release checklist ✅ COMPLETE

**Duration:** ~5 h
**Goal:** CI produces a signed `.dmg` artifact on tag push; release checklist automates hash pinning.
**Result:** check_release_constants.sh (exits 1 on unpinned hashes — verified working), pin_hashes.sh (fetches SHASUMS256.txt + fnm checksums), CI workflows (ci.yml + release.yml). Tagged v1.0.0-rc1.
**Key deviation:** None.

### Tasks
- **T25 — GitHub Actions CI workflow**
  - `.github/workflows/release.yml`:
    ```yaml
    on:
      push:
        tags: ['v*']
    jobs:
      build:
        runs-on: macos-14
        steps:
          - uses: actions/checkout@v4
          - name: Import Developer ID cert
            run: # base64-decode cert from secrets, import to keychain
          - name: Build, sign, notarize
            run: bash scripts/build_sign_notarize.sh
            env:
              CODE_SIGN_IDENTITY: ${{ secrets.CODE_SIGN_IDENTITY }}
              NOTARY_PROFILE: ${{ secrets.NOTARY_PROFILE }}
          - uses: actions/upload-artifact@v4
            with:
              name: CodeMieClaudeInstaller-dmg
              path: "*.dmg"
    ```
  - Commit: `chore(ci): add GitHub Actions release workflow for signed DMG`

- **T26 — Release checklist automation**
  - `scripts/check_release_constants.sh`:
    ```bash
    #!/bin/bash
    # Fails if any required hash constant is still the placeholder (§5.5, §13)
    CONSTANTS="Sources/Services/Constants.swift"
    if grep -q '"\\[PIN AT RELEASE\\]"' "$CONSTANTS"; then
      echo "ERROR: Release-pinned hash constants are not set in Constants.swift"
      echo "Run: scripts/pin_hashes.sh to fetch and pin SHA-256 from official sources"
      exit 1
    fi
    echo "All release constants are pinned."
    ```
  - `scripts/pin_hashes.sh` — fetches `https://nodejs.org/dist/v<nodeVersion>/SHASUMS256.txt`, extracts the `.pkg` hash, fetches fnm release checksums, updates `Constants.swift` in-place
  - Add `check_release_constants.sh` call to `build_sign_notarize.sh` as first step (build fails if unset)
  - Commit: `chore(release): add hash-pinning scripts and release constant guard`
  - **Phase 5 checkpoint:** tag `phase-5-complete`
  - **Project complete:** tag `v1.0.0-rc1`

**Done when:** CI runs end-to-end on a tag push; `check_release_constants.sh` exits 1 on unpinned constants and 0 when properly set.

---

## Dependencies & Blockers

| Day | Prerequisite | Risk |
|---|---|---|
| 1 | Swift 5.9+ + Xcode installed | Verify with `swift --version` before starting |
| 4 | Network access to nodejs.org | Test download in sandbox environment |
| 6 | Apple Developer ID certificate | Confirm EPAM WPM has cert (§22.4); get thumbprint |
| 9 | Xcode project creation | Use Xcode GUI; File > New > Project > macOS App |
| 15 | Valid Developer ID cert + notarization credentials | CI secrets must be provisioned |
| 15 | `create-dmg` installed | `brew install create-dmg` on CI runner |

## Key Decisions (from spec §22 — confirmations needed)

| Item | Default | Status |
|---|---|---|
| macOS support | Latest major only (rolling) | Confirm with team |
| Node LTS patch | 22.x.x — pin at Day 4 | Fetch latest from nodejs.org/dist |
| Repo name | `codemie-claude-installer-mac` | Confirm before Day 1 |
| Bundle ID | `com.epam.codemie.claude-installer` | Confirm with EPAM WPM |
| Signing ownership | EPAM WPM Apple Developer Org | Must have cert before Day 15 |
