# Claude Code CLI Installation and Version Management

## Specification Summary

**Last Updated**: 2026-01-29

**Key Decision**: Use enhanced `codemie install claude` command with optional version argument and `--supported` flag instead of a separate `--reinstall-claude` flag on setup command.

**Rationale**:
- Leverages existing `codemie install` command pattern (consistent with other agents)
- Provides flexible version management (latest, supported, specific)
- Clearer user experience (dedicated command for installation)
- Separation of concerns (setup vs install)
- Better discoverability (`codemie install` already lists available agents)

**User-Facing Changes**:
```bash
# Install latest supported version (recommended)
codemie install claude --supported

# Install specific version
codemie install claude 2.0.30

# Install latest available version
codemie install claude

# First-time setup automatically uses `codemie install claude --supported` internally
codemie setup
```

---

## Overview

Claude Code has deprecated npm installation and now requires native installation via platform-specific installers. This specification outlines the migration from npm-based installation to native installation management, along with a comprehensive version management system to ensure CodeMie CLI users run tested, supported versions of Claude Code.

### Business Value

- **Compatibility Assurance**: Ensures users run Claude versions tested with CodeMie's backend proxy
- **Smooth User Experience**: Automated detection and installation during setup
- **Version Control**: Prevents untested versions from causing proxy issues
- **Platform Support**: Maintains cross-platform compatibility (macOS, Windows, Linux)

### High-Level Technical Approach

1. **Native Installation Management**: Replace npm-based installation with native installer execution via enhanced `codemie install` command
2. **Version Tracking**: Store latest supported Claude version in codebase configuration (`ClaudePluginMetadata.supportedVersion`)
3. **Enhanced Install Command**: Add version argument and `--supported` flag to `codemie install claude` command
4. **Version Detection**: Compare user's installed version against supported version on command execution
5. **Automated Installation**: Install supported version during first-time CodeMie setup using `codemie install claude --supported`
6. **Warning System**: Alert users running newer (untested) versions with clear installation instructions

### Key Architectural Decisions

**Layers Affected**:
- **Plugin Layer**: Primary changes in `ClaudePlugin` adapter for installation logic
- **Utils Layer**: New utility functions for version management and native installer execution
- **CLI Layer**: Enhanced setup command to include Claude installation
- **Core Layer**: Optional extension to `AgentMetadata` interface for version configuration

**Rationale**: Keep version management logic in the Plugin layer where agent-specific behavior belongs, with utility functions in Utils layer for reusability.

### Integration Points

- **Agent Registry**: Plugin discovery and retrieval remains unchanged
- **Setup Command**: Extended to install Claude during first-time setup
- **BaseAgentAdapter**: Reuse existing version detection patterns (`getVersion()`)
- **Process Utilities**: Leverage existing `exec()` for installer execution

---

## Specification

### CLI Layer (User Interface)

**Responsibility**: Command handling and user interaction for setup and version warnings

| Component | Pattern | Implementation |
|-----------|---------|----------------|
| Setup command | Enhanced `codemie setup` | Install latest supported Claude version during setup |
| Version warning | Pre-execution check in agent run | Display warning if user's version > supported version |
| User prompts | Inquirer.js | Confirm automatic downgrade (optional feature) |
| Error display | formatErrorForUser() | Handle installation and version check failures |

**Command Specifications**:

1. **Enhanced Install Command** (`src/cli/commands/install.ts`):
   - Add optional version argument: `codemie install claude [version]`
   - Add `--supported` flag: `codemie install claude --supported`
   - Version argument behavior:
     - No argument: Install latest available version from native installer
     - With version: Install specific version (e.g., `codemie install claude 2.0.30`)
     - With `--supported` flag: Install version from `ClaudePluginMetadata.supportedVersion`
   - Before installation: Check if already installed with matching version
   - Progress feedback: Display spinner during installation
   - Verify installation success: Run `claude --version` after install
   - Error handling: Installation failures with platform-specific troubleshooting

2. **Setup Command Integration** (`src/cli/commands/setup.ts`):
   - After provider configuration, check if Claude is installed
   - If not installed: Prompt user to install, call `codemie install claude --supported` internally
   - If installed but version mismatch: Prompt user to upgrade/downgrade with recommendation
   - Display installation progress and success/error messages
   - Error handling: Installation failures with retry option

3. **Version Checking on Agent Execution**:
   - Before `claude.run()`: Check installed version vs supported version
   
   **Scenario 1: Newer Untested Version** (user version > supported version):
     ```
     ⚠️  WARNING: You are running Claude Code v2.0.45
     CodeMie has only tested and verified Claude Code v2.0.30

     Running a newer version may cause compatibility issues with the CodeMie backend proxy.

     To install the supported version, run:
       codemie install claude --supported

     Or install a specific version:
       codemie install claude 2.0.30

     Continue anyway? [y/N]:
     ```
   - Exit code 1 if user declines (non-zero exit)
   - Proceed if user confirms
   
   **Scenario 2: Update Available** (newer supported version exists, current version compatible):
     ```
     ℹ️  A new supported version of Claude Code is available!
        Current version: v2.1.20
        Latest version:  v2.1.22 (recommended)

        To update, run:
          codemie update claude

     Continue with current version? [Y/n]:
     ```
   - Exit code 1 if user declines (non-zero exit)
   - Proceed if user confirms (default: yes)

**User-Facing Output**:
- Success: "Claude Code v2.0.30 installed successfully ✓"
- Already installed with matching version: "Claude Code v2.0.30 is already installed"
- Already installed with different version: "Claude Code v2.0.45 is already installed (supported: 2.0.30). Use `codemie install claude --supported` to install the supported version."
- Warning: Version mismatch alert with clear instructions
- Error: "Failed to install Claude Code: [reason]" with troubleshooting steps

**Command Examples**:
```bash
# Install latest supported version (recommended)
codemie install claude --supported

# Install specific version
codemie install claude 2.0.30

# Install latest available version
codemie install claude

# First-time setup automatically installs supported version
codemie setup
```

---

### Registry Layer (Plugin Orchestration)

**Responsibility**: Plugin retrieval and lifecycle management (minimal changes)

| Component | Pattern | Current Behavior |
|-----------|---------|------------------|
| Plugin retrieval | `AgentRegistry.getAgent('claude')` | Returns ClaudePlugin instance (unchanged) |
| Installation routing | `adapter.install()` | Delegates to plugin's install method (unchanged) |
| Version check | `adapter.getVersion()` | Delegates to plugin's getVersion method (unchanged) |

**Specifications**:
- No changes to registry routing logic
- Existing `install()` and `getVersion()` methods remain the interface
- Plugin handles native installation internally

---

### Plugin Layer (Concrete Implementation)

**Responsibility**: Claude-specific installation, version detection, and native installer management

| Component | Pattern | Implementation |
|-----------|---------|----------------|
| Installation | `install()` override | Execute native installer for user's platform |
| Version detection | `getVersion()` override | Parse `claude --version` output |
| Version comparison | New method `checkVersionCompatibility()` | Compare installed vs supported version |
| Metadata | `ClaudePluginMetadata` | Add `supportedVersion` field |

**Adapter Methods** (`src/agents/plugins/claude/claude.plugin.ts`):

```typescript
export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  cliCommand: 'claude',

  // NEW: Supported version configuration
  supportedVersion: '2.1.25', // Latest tested version

  // KEEP: npmPackage for backward compatibility (will be ignored by new install logic)
  npmPackage: '@anthropic-ai/claude-code',

  // NEW: Lifecycle hooks for environment configuration
  lifecycle: {
    async beforeRun(env) {
      // CRITICAL: Disable Claude Code auto-updater to maintain version control
      // CodeMie manages Claude versions explicitly via installVersion()
      // Auto-updates could break version compatibility with CodeMie backend
      // See: https://code.claude.com/docs/en/settings
      if (!env.DISABLE_AUTOUPDATER) {
        env.DISABLE_AUTOUPDATER = '1';
      }

      // Disable experimental betas and telemetry for stability
      if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      }
      if (!env.CLAUDE_CODE_ENABLE_TELEMETRY) {
        env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
      }

      return env;
    }
  },

  // ... rest of existing metadata
};

export class ClaudePlugin extends BaseAgentAdapter {
  /**
   * Install Claude Code using native installer (override from BaseAgentAdapter)
   * Installs latest available version from native installer
   * For version-specific installs, use installVersion() method
   *
   * @throws {AgentInstallationError} If installation fails
   */
  async install(): Promise<void>

  /**
   * Install specific version of Claude Code
   * Uses native installer with version parameter
   * Special handling for version parameter:
   * - undefined/'latest': Install latest available version
   * - 'supported': Install version from metadata.supportedVersion
   * - Semantic version string (e.g., '2.0.30'): Install specific version
   *
   * @param version - Version string (e.g., '2.0.30', 'latest', 'supported')
   * @throws {AgentInstallationError} If installation fails
   */
  async installVersion(version?: string): Promise<void>

  /**
   * Check if installed version is compatible with CodeMie
   * Compares against metadata.supportedVersion
   *
   * @returns Version compatibility result with status and version info
   */
  async checkVersionCompatibility(): Promise<VersionCompatibilityResult>

  /**
   * Get installed Claude version (override from BaseAgentAdapter)
   * Parses output of `claude --version`
   *
   * @returns Version string or null if not installed
   */
  async getVersion(): Promise<string | null>
}

interface VersionCompatibilityResult {
  compatible: boolean;           // true if versions match or installed <= supported
  installedVersion: string | null; // null if not installed
  supportedVersion: string;        // from metadata
  isNewer: boolean;                // true if installed > supported (warning case)
  hasUpdate: boolean;              // true if newer supported version available (info prompt)
}
```

**Auto-Updater Configuration** (CRITICAL):

Claude Code includes a built-in auto-updater that can automatically update to newer versions. This **MUST be disabled** for CodeMie to maintain version control and compatibility:

- **Environment Variable**: `DISABLE_AUTOUPDATER=1` (set in `lifecycle.beforeRun` hook)
- **Platform Support**: Works on all platforms (macOS, Linux, Windows) - environment variables are cross-platform
- **Rationale**:
  - CodeMie manages Claude versions explicitly via `installVersion()` for compatibility
  - Auto-updates could break version compatibility with CodeMie backend
  - Version warnings would be bypassed, causing unexpected behavior
  - Users should control when to update via `codemie update claude`
- **Documentation**: https://code.claude.com/docs/en/settings
- **Implementation**: Set in `ClaudePluginMetadata.lifecycle.beforeRun()` hook (runs before every Claude execution)

**Version Update Notifications**:

When a newer supported version is available (installed < supported), users receive an informational prompt:
- **Message Type**: ℹ️ Info (cyan, non-threatening)
- **Default Action**: Continue with current version (Y is default)
- **Command**: `codemie update claude`
- **Behavior**: Non-blocking - allows user to proceed with current version or cancel to update
- **Purpose**: Keep users informed of newer tested versions without forcing immediate updates

**Installation Logic**:

1. **Version Resolution**:
   - If version is 'supported': Use `metadata.supportedVersion` value
   - If version is undefined/'latest': Pass no version to installer (latest)
   - Otherwise: Use provided version string
2. **Platform Detection**: Detect OS (macOS, Windows, Linux/WSL)
3. **Installer Selection**:
   - macOS/Linux/WSL: `curl -fsSL https://claude.ai/install.sh | bash -s [version]`
   - Windows PowerShell: `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) [version]`
   - Windows CMD: `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd [version] && del install.cmd`
4. **Execution**: Use `exec()` from `src/utils/processes.ts`
5. **Verification**: Run `claude --version` to confirm installation
6. **Error Handling**: Throw `AgentInstallationError` with platform-specific troubleshooting

**Version Comparison Logic**:
- Parse semantic versions: `1.0.58` → `[1, 0, 58]`
- Compare component-wise: major → minor → patch
- Special handling for `latest` and `stable` channels

**plugin.json Schema** (no changes needed):
```json
{
  "name": "codemie-claude-plugin",
  "version": "1.0.0",
  "description": "CodeMie integration for Claude Code"
}
```

---

### Core Layer (Base Classes & Interfaces)

**Responsibility**: Contracts for version management (optional extension)

| Component | Pattern | Implementation |
|-----------|---------|----------------|
| AgentMetadata interface | Optional field extension | Add `supportedVersion?: string` |
| VersionCompatibilityResult | New interface | Define version check result type |

**Interface Definitions** (`src/agents/core/types.ts`):

```typescript
/**
 * Agent metadata configuration
 * Extended to support version management
 */
export interface AgentMetadata {
  name: string;
  displayName: string;
  description: string;
  npmPackage?: string;         // Optional: for agents still using npm
  cliCommand?: string;

  // NEW: Version management
  supportedVersion?: string;   // Latest version tested with CodeMie backend

  // ... existing fields
}

/**
 * Result of version compatibility check
 */
export interface VersionCompatibilityResult {
  compatible: boolean;         // true if installed version is compatible
  installedVersion: string | null; // null if not installed
  supportedVersion: string;    // version from metadata
  isNewer: boolean;            // true if installed > supported (requires warning)
  hasUpdate: boolean;          // true if newer supported version available (info prompt)
}
```

**Method Signature Extension** (`src/agents/core/agent-adapter.ts`):

```typescript
export interface AgentAdapter {
  // ... existing methods

  /**
   * Install specific version of agent (optional, for version-managed agents)
   * @param version - Version string or channel ('latest', 'stable')
   */
  installVersion?(version: string): Promise<void>;

  /**
   * Check version compatibility (optional, for version-managed agents)
   * @returns Version compatibility result
   */
  checkVersionCompatibility?(): Promise<VersionCompatibilityResult>;
}
```

**Note**: These are optional extensions. Agents without version management (Gemini, Aider, etc.) don't need to implement them.

---

### Utils Layer (Shared Utilities)

**Responsibility**: Platform-specific installer execution and version comparison utilities

| Component | Pattern | Implementation |
|-----------|---------|----------------|
| Native installer execution | New utility `installNativeAgent()` | Platform-specific installer execution |
| Version comparison | New utility `compareVersions()` | Semantic version comparison |
| Version parsing | New utility `parseSemanticVersion()` | Parse version strings into comparable format |

**Function Signatures** (`src/utils/native-installer.ts` - NEW FILE):

```typescript
/**
 * Install agent using native platform installer
 * Detects platform and executes appropriate installation script
 *
 * @param agentName - Agent name for logging (e.g., 'claude')
 * @param installerUrls - Platform-specific installer URLs
 * @param version - Version to install (e.g., '2.0.30', 'latest', 'stable')
 * @param options - Installation options (timeout, env, etc.)
 * @returns Installation result with success status and installed version
 * @throws {AgentInstallationError} If installation fails
 *
 * @example
 * await installNativeAgent('claude', {
 *   macOS: 'https://claude.ai/install.sh',
 *   windows: 'https://claude.ai/install.ps1',
 *   linux: 'https://claude.ai/install.sh'
 * }, '2.0.30');
 */
export async function installNativeAgent(
  agentName: string,
  installerUrls: PlatformInstallerUrls,
  version?: string,
  options?: NativeInstallOptions
): Promise<NativeInstallResult>

/**
 * Platform-specific installer URLs
 */
export interface PlatformInstallerUrls {
  macOS: string;        // Shell script URL
  windows: string;      // PowerShell script URL
  linux: string;        // Shell script URL
}

/**
 * Native installation options
 */
export interface NativeInstallOptions {
  timeout?: number;               // Installation timeout (ms)
  env?: Record<string, string>;   // Environment variables
  verifyCommand?: string;         // Command to verify installation (e.g., 'claude')
}

/**
 * Native installation result
 */
export interface NativeInstallResult {
  success: boolean;               // Installation succeeded
  installedVersion: string | null; // Installed version (null if verification failed)
  output: string;                  // Installation output
}
```

**Function Signatures** (`src/utils/version-utils.ts` - NEW FILE):

```typescript
/**
 * Compare two semantic versions
 *
 * @param version1 - First version string (e.g., '2.0.30')
 * @param version2 - Second version string (e.g., '2.0.45')
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 *
 * @example
 * compareVersions('2.0.30', '2.0.45') // Returns -1
 * compareVersions('2.0.45', '2.0.30') // Returns 1
 * compareVersions('2.0.30', '2.0.30') // Returns 0
 */
export function compareVersions(version1: string, version2: string): number

/**
 * Parse semantic version string into comparable components
 *
 * @param version - Version string (e.g., '2.0.30')
 * @returns Version components { major, minor, patch }
 * @throws {Error} If version string is invalid
 *
 * @example
 * parseSemanticVersion('2.0.30') // Returns { major: 2, minor: 0, patch: 30 }
 */
export function parseSemanticVersion(version: string): SemanticVersion

/**
 * Semantic version components
 */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string; // Original version string
}

/**
 * Check if version string is valid semantic version
 *
 * @param version - Version string to validate
 * @returns true if valid semantic version
 */
export function isValidSemanticVersion(version: string): boolean
```

**Implementation Notes**:
- `installNativeAgent()`: Detect platform using `process.platform`, execute appropriate installer script
- `compareVersions()`: Parse versions, compare component-wise (major → minor → patch)
- Handle special cases: `latest`, `stable` channels (treat as highest version for comparison)
- Error handling: Use `AgentInstallationError` from `src/utils/errors.ts`
- Logging: Use `logger.debug()` for installation progress

---

### Covered Functional Requirements

This specification addresses the following requirements:

- ✓ **Native Installation Migration**: Replace npm-based installation with platform-specific native installers (macOS, Windows, Linux)
- ✓ **Enhanced Install Command**: Add version argument and `--supported` flag to `codemie install claude` command
- ✓ **Latest Supported Version Configuration**: Store and maintain latest tested Claude version in codebase (`ClaudePluginMetadata.supportedVersion`)
- ✓ **Version Detection on Execution**: Detect user's installed Claude version before running agent
- ✓ **Version Comparison Logic**: Compare user's version against supported version (newer = warning)
- ✓ **Warning System**: Display clear warning when user runs newer (untested) version
- ✓ **Installation Instructions**: Provide actionable commands to install supported version (`codemie install claude --supported`)
- ✓ **First-Time Installation**: Automatically install latest supported version during `codemie setup` using enhanced install command
- ✓ **Flexible Version Management**: Support installing latest available, latest supported, or specific versions
- ✓ **Cross-Platform Support**: Handle installation differences across macOS, Windows, Linux/WSL
- ✓ **Error Handling**: Proper error handling with `AgentInstallationError` and user-friendly messages
- ✓ **Verification**: Verify installation success by running `claude --version`
- ✓ **Already Installed Check**: Detect if requested version is already installed and skip reinstallation

---

## Implementation Tasks

Implementation order follows bottom-up approach (Utils → Core → Plugin → Registry → CLI):

- [ ] **Utils**: Create native installer utility functions
  - [ ] Create `src/utils/native-installer.ts` with `installNativeAgent()`, platform detection, installer execution
  - [ ] Create `src/utils/version-utils.ts` with `compareVersions()`, `parseSemanticVersion()`, `isValidSemanticVersion()`
  - [ ] Add unit tests for version comparison logic (edge cases: major/minor/patch differences)
  - [ ] Add unit tests for platform detection and installer selection

- [ ] **Core**: Extend AgentAdapter interface and types
  - [ ] Add `supportedVersion?: string` field to `AgentMetadata` interface in `src/agents/core/types.ts`
  - [ ] Add `VersionCompatibilityResult` interface to `src/agents/core/types.ts`
  - [ ] Add optional `installVersion?(version: string): Promise<void>` to `AgentAdapter` interface
  - [ ] Add optional `checkVersionCompatibility?(): Promise<VersionCompatibilityResult>` to `AgentAdapter` interface

- [ ] **Plugin**: Implement Claude-specific version management
  - [ ] Update `ClaudePluginMetadata` in `src/agents/plugins/claude/claude.plugin.ts`:
    - [ ] Add `supportedVersion: '2.0.30'` field (or latest tested version)
    - [ ] Keep `npmPackage` field for backward compatibility (will be ignored by new install logic)
  - [ ] Override `install()` method in `ClaudePlugin`:
    - [ ] Call `installNativeAgent()` with platform-specific installer URLs
    - [ ] Pass no version parameter (installs latest available)
    - [ ] Verify installation with `getVersion()` call
    - [ ] Throw `AgentInstallationError` on failure with platform-specific troubleshooting
  - [ ] Implement `installVersion(version?: string)` method:
    - [ ] Accept optional version parameter: undefined/'latest'/'supported'/semantic version
    - [ ] If version is 'supported': Resolve to `metadata.supportedVersion` value
    - [ ] If version is undefined/'latest': Pass no version to installer
    - [ ] Otherwise: Use provided version string
    - [ ] Validate version string format (if not 'latest'/'supported')
    - [ ] Call `installNativeAgent()` with resolved version
    - [ ] Verify installation with `getVersion()` call
  - [ ] Implement `checkVersionCompatibility()` method:
    - [ ] Call `getVersion()` to get installed version
    - [ ] Compare against `metadata.supportedVersion` using `compareVersions()`
    - [ ] Return `VersionCompatibilityResult` with compatibility status
  - [ ] Update `getVersion()` method if needed (existing implementation should work)

- [ ] **Registry**: No changes required
  - [ ] Verify existing `AgentRegistry.getAgent('claude')` works with updated plugin

- [ ] **CLI**: Add version checking and install command enhancement
  - [ ] Update `src/cli/commands/install.ts`:
    - [ ] Add optional version argument to install command: `.argument('[name]', '...').argument('[version]', 'Optional: specific version to install')`
    - [ ] Add `--supported` flag: `.option('--supported', 'Install the latest supported version tested with CodeMie')`
    - [ ] Update action handler to accept version parameter
    - [ ] If `--supported` flag: Call `adapter.installVersion('supported')`
    - [ ] If version argument provided: Call `adapter.installVersion(version)`
    - [ ] If neither: Call `adapter.install()` (latest available)
    - [ ] Before installation: Check if already installed with matching version
    - [ ] If version matches: Display "already installed" message and exit
    - [ ] If version differs: Prompt user to confirm reinstall
    - [ ] Display installation progress with spinner
    - [ ] Verify installation by calling `adapter.getVersion()`
  - [ ] Update `src/cli/commands/setup.ts`:
    - [ ] After provider setup, check if Claude is installed (`adapter.isInstalled()`)
    - [ ] If not installed: Prompt to install, internally call install command with `--supported` flag
    - [ ] If installed: Check version compatibility (`adapter.checkVersionCompatibility()`)
    - [ ] If version mismatch: Display recommendation to run `codemie install claude --supported`
    - [ ] Display installation progress and success/error messages
  - [ ] Add version check before agent execution:
    - [ ] In agent run command (likely in `BaseAgentAdapter.run()` or CLI layer)
    - [ ] Call `adapter.checkVersionCompatibility()` if method exists
    - [ ] If `isNewer === true`: Display warning with install instructions (use `codemie install claude --supported`)
    - [ ] Prompt user to continue (default: No)
    - [ ] Exit with code 1 if user declines

- [ ] **Validation**: Input validation and error handling
  - [ ] Validate version string format in `installVersion()` method
  - [ ] Handle network failures during installer download (retry logic or clear error)
  - [ ] Handle installer execution failures (permissions, missing dependencies)
  - [ ] Validate installed version after installation (verify command works)
  - [ ] Handle edge cases: detached HEAD, invalid version strings, network timeouts

- [ ] **Security**: Apply security patterns
  - [ ] Sanitize installer output before logging (no credentials exposed)
  - [ ] Validate installer URLs (prevent injection attacks)
  - [ ] Use secure HTTPS URLs for all installer downloads
  - [ ] Handle shell command injection risks (use `exec()` with argument arrays)

- [ ] **Documentation**: Update CLAUDE.md and guides
  - [ ] Update CLAUDE.md troubleshooting section with native installation issues
  - [ ] Update architecture guide with version management patterns
  - [ ] Add version management example to development practices guide
  - [ ] Update setup command documentation with Claude installation steps

---

## CLI Install Command Enhancement

### Command Structure

The `codemie install` command will be enhanced to support version management for Claude Code:

**Current behavior** (existing):
```bash
codemie install claude  # Installs Claude via npm (deprecated method)
```

**New behavior** (enhanced):
```bash
# Install latest supported version (recommended)
codemie install claude --supported

# Install specific version
codemie install claude 2.0.30

# Install latest available version (not necessarily supported)
codemie install claude
```

### Flag Recommendation: `--supported`

**Recommended Flag**: `--supported`

**Rationale**:
1. **Clarity**: Clearly indicates that this is the version supported/tested by CodeMie
2. **Intent**: Communicates the purpose better than `--recommended` or `--latest-supported`
3. **Brevity**: Shorter and easier to type than `--latest-supported`
4. **Consistency**: Aligns with terminology used in version warnings ("supported version")
5. **Discoverability**: Intuitive flag name that users can understand without documentation

**Alternative flags considered**:

| Flag | Pros | Cons | Decision |
|------|------|------|----------|
| `--recommended` | Generic, could apply to other contexts | Doesn't convey "tested by CodeMie" aspect | ❌ Less precise |
| `--latest-supported` | Very explicit | Too verbose, harder to type | ❌ Too long |
| `--verified` | Conveys testing | Less common terminology | ❌ Ambiguous |
| **`--supported`** | **Clear, concise, matches warning terminology** | **None** | ✅ **Selected** |

### Integration with Existing Command

The enhancement will extend the existing `install.ts` command:

**Current signature**:
```typescript
.argument('[name]', 'Agent or framework name to install')
```

**Enhanced signature**:
```typescript
.argument('[name]', 'Agent or framework name to install')
.argument('[version]', 'Optional: specific version to install')
.option('--supported', 'Install the latest supported version tested with CodeMie')
```

**Flow**:
1. Parse `name` argument (e.g., 'claude')
2. Check for `--supported` flag → If present, install supported version
3. Check for `version` argument → If present, install specific version
4. Otherwise → Install latest available version

**Priority**: `--supported` flag takes precedence over version argument if both provided

### User Experience Examples

**First-time setup**:
```bash
$ codemie setup
✓ Provider configured successfully
○ Claude Code not installed

Would you like to install Claude Code now? [Y/n] y
Installing Claude Code v2.0.30 (supported version)...
✓ Claude Code v2.0.30 installed successfully

💡 Next steps:
   Interactive mode: codemie-claude
   Single task: codemie-claude --task "your task"
```

**Manual install with supported version**:
```bash
$ codemie install claude --supported
Installing Claude Code v2.0.30...
✓ Claude Code v2.0.30 installed successfully
```

**Manual install with specific version**:
```bash
$ codemie install claude 2.0.45
Installing Claude Code v2.0.45...
✓ Claude Code v2.0.45 installed successfully

⚠️  Note: This version (2.0.45) is newer than the supported version (2.0.30).
   You may encounter compatibility issues with the CodeMie backend.
   To install the supported version, run: codemie install claude --supported
```

**Already installed check**:
```bash
$ codemie install claude --supported
Claude Code v2.0.30 is already installed

$ codemie install claude 2.0.45
Claude Code v2.0.30 is already installed (requested: 2.0.45)
Would you like to reinstall with version 2.0.45? [y/N]
```

---

## Configuration Design

### Recommended Location for Version Config

**Primary Location**: `AgentMetadata` object in plugin file (`src/agents/plugins/claude/claude.plugin.ts`)

**Rationale**:
1. **Co-location**: Version lives next to agent-specific code (single source of truth)
2. **Type Safety**: TypeScript interface enforces structure
3. **Easy Updates**: Single file to update when testing new versions
4. **No Build Step**: Direct TypeScript constant (no JSON parsing)
5. **Discoverability**: Obvious location for developers

**Alternative Locations Considered**:

| Location | Pros | Cons | Decision |
|----------|------|------|----------|
| `package.json` | Standard npm convention | Not agent-specific, requires JSON parsing | ❌ Rejected |
| `src/agents/core/constants.ts` | Centralized constants | Separates config from plugin | ❌ Rejected |
| `config/claude-version.json` | Easy to update without code | Adds I/O, parsing overhead | ❌ Rejected |
| **`ClaudePluginMetadata` object** | **Co-located, type-safe, no I/O** | **None** | ✅ **Selected** |

### Configuration Schema

```typescript
// src/agents/plugins/claude/claude.plugin.ts

export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  cliCommand: 'claude',

  // Version management configuration
  supportedVersion: '2.1.25', // SINGLE SOURCE OF TRUTH

  // Native installer URLs (used by installNativeAgent utility)
  installerUrls: {
    macOS: 'https://claude.ai/install.sh',
    windows: 'https://claude.ai/install.ps1',
    linux: 'https://claude.ai/install.sh'
  },

  // ... rest of existing metadata
};
```

**Type Definition** (`src/agents/core/types.ts`):

```typescript
export interface AgentMetadata {
  // ... existing fields

  /**
   * Latest supported version tested with CodeMie backend
   * Used for version compatibility checks
   *
   * Format: Semantic version string (e.g., '2.0.30')
   * Special values: 'latest', 'stable' (channels)
   */
  supportedVersion?: string;

  /**
   * Native installer URLs for platform-specific installation
   * Optional: Only needed for agents using native installers (not npm)
   */
  installerUrls?: {
    macOS: string;
    windows: string;
    linux: string;
  };
}
```

### Update/Maintenance Procedures

**When to Update `supportedVersion`**:
1. New Claude Code version released
2. CodeMie team tests new version with backend proxy
3. All critical features verified (SSO, metrics, session tracking)
4. Update `supportedVersion` field in `ClaudePluginMetadata`
5. Commit with message: `feat(claude): update supported version to 2.0.45`

**Testing Checklist Before Version Update**:
- [ ] Install new Claude version: `claude install 2.0.45`
- [ ] Test SSO authentication flow with CodeMie backend
- [ ] Verify proxy intercepts API calls correctly
- [ ] Test metrics collection and session sync
- [ ] Verify plugin hooks execute properly
- [ ] Test on all platforms (macOS, Windows, Linux)
- [ ] Update `supportedVersion` in metadata
- [ ] Deploy and monitor for issues

**Maintenance**:
- Check for new Claude releases monthly: https://code.claude.com/docs/en/setup
- Monitor Claude changelog: https://code.claude.com/docs/en/changelog
- Test new versions in staging environment before updating production
- Keep installer URLs up-to-date (verify HTTPS endpoints)

---

## Testing Strategy

### Unit Tests

**Version Comparison** (`src/utils/__tests__/version-utils.test.ts`):
- Compare equal versions: `2.0.30` vs `2.0.30` → 0
- Compare major version differences: `1.0.30` vs `2.0.30` → -1
- Compare minor version differences: `2.0.30` vs `2.1.30` → -1
- Compare patch version differences: `2.0.30` vs `2.0.45` → -1
- Handle invalid version strings: `invalid` → Error
- Handle special channels: `latest`, `stable`

**Native Installer** (`src/utils/__tests__/native-installer.test.ts`):
- Mock `exec()` to test installer execution
- Test platform detection (macOS, Windows, Linux)
- Test installer URL selection
- Test version parameter passing
- Test error handling (network failures, permissions)
- Test installation verification

**Plugin** (`src/agents/plugins/claude/__tests__/claude.plugin.test.ts`):
- Mock `installNativeAgent()` to test `install()` method
- Mock `getVersion()` to test `checkVersionCompatibility()` method
- Test version comparison logic (newer, equal, older)
- Test `installVersion()` with different version strings

### Integration Tests

**Setup Command** (`tests/integration/cli/setup.test.ts`):
- Full setup flow with Claude installation
- Test installation skip if already installed
- Test version mismatch detection and user prompt
- Test error handling during installation

**Version Warning** (`tests/integration/agents/version-check.test.ts`):
- Mock installed version as newer than supported
- Verify warning message displays
- Test user prompt flow (accept/decline)
- Verify exit code 1 on decline

### Manual Testing

**Cross-Platform Installation**:
1. Test on macOS: `codemie setup` → Verify Claude installed
2. Test on Windows: PowerShell and CMD installer execution
3. Test on Linux/WSL: Shell script execution
4. Verify version detection: `claude --version` parsed correctly

**Version Compatibility**:
1. Install newer Claude version: `claude install latest`
2. Run CodeMie agent: `codemie-claude`
3. Verify warning displays with downgrade instructions
4. Test downgrade: `claude install 2.0.30`
5. Verify no warning after downgrade

---

## Rollout Considerations

### Phase 1: Core Implementation (Week 1)
- Implement version utilities and native installer
- Update `AgentMetadata` interface with `supportedVersion` field
- Extend `ClaudePlugin` with version management methods
- Unit tests for all new utilities

### Phase 2: CLI Integration (Week 2)
- Add version checking to agent run flow
- Enhance setup command with Claude installation
- Display warning messages with downgrade instructions
- Integration tests for setup and version warnings

### Phase 3: Testing & Validation (Week 3)
- Cross-platform testing (macOS, Windows, Linux)
- User acceptance testing with different version scenarios
- Documentation updates (CLAUDE.md, guides)
- Bug fixes and refinements

### Phase 4: Production Rollout (Week 4)
- Deploy to production with latest supported version
- Monitor for installation failures and version warnings
- Gather user feedback on warning clarity
- Iterate on messaging and user experience

### Migration Path for Existing Users

**Users with npm-installed Claude**:
1. On next `codemie-claude` execution: Detect npm installation
2. Display migration prompt:
   ```
   Claude Code is now installed via native installer (not npm).
   Would you like to migrate to the native installation? [Y/n]
   ```
3. If yes: Uninstall npm package, install native version
4. If no: Continue with npm version (show warning about deprecated installation)

**Users with native-installed Claude**:
- Version check runs automatically on execution
- If version > supported: Show warning with downgrade instructions
- If version <= supported: No action needed

### Backward Compatibility

- Existing `install()` and `getVersion()` methods remain functional
- New methods (`installVersion()`, `checkVersionCompatibility()`) are optional
- Agents without version management (Gemini, Aider) unaffected
- No breaking changes to public API

### Monitoring & Metrics

**Track**:
- Installation success rate (native vs npm)
- Version mismatch frequency (how many users run newer versions?)
- Downgrade adoption (how many users downgrade after warning?)
- Installation failures by platform (which platforms have issues?)

**Alerts**:
- High installation failure rate (> 5%)
- Spike in version warnings (indicates new Claude release)
- Downgrade command failures (installer issues?)

---

## Security Considerations

1. **Installer URL Validation**: Always use HTTPS URLs from official Claude documentation
2. **Shell Injection Prevention**: Use `exec()` with argument arrays (not string concatenation)
3. **Output Sanitization**: Sanitize installer output before logging (prevent credential exposure)
4. **Version String Validation**: Validate version format to prevent command injection
5. **Permissions**: Handle installer failures due to insufficient permissions (clear error messages)

---

## Error Handling

**Installation Failures**:
- Network timeout: Retry with backoff, suggest manual installation
- Permission denied: Suggest running with appropriate permissions (sudo on Unix, admin on Windows)
- Installer script error: Show installer output, link to troubleshooting guide
- Verification failed: Show installed version, suggest reinstallation

**Version Check Failures**:
- `claude` command not found: Prompt to install
- Invalid version string: Log error, skip version check (don't block execution)
- Version comparison error: Log warning, allow execution (fail-safe)

**Error Messages**:
```typescript
// Installation failure
throw new AgentInstallationError(
  'Failed to install Claude Code',
  {
    platform: process.platform,
    error: error.message,
    troubleshooting: 'https://code.claude.com/docs/en/troubleshooting'
  }
);

// Version check failure (non-blocking)
logger.warn('Failed to check Claude version compatibility', {
  error: error.message,
  installedVersion,
  supportedVersion
});
```

---

## Future Enhancements

**Auto-Update Support** (Phase 2):
- Detect when new supported version is available
- Prompt user to upgrade: "Claude Code v2.0.45 is now supported. Upgrade? [Y/n]"
- Automatic upgrade on user confirmation

**Version History** (Phase 3):
- Track tested versions in `versions.json` config
- Allow users to select from tested versions
- Display release notes for each version

**Rollback Support** (Phase 4):
- If proxy issues detected after upgrade: Automatic rollback to previous version
- Track last known good version in user config
- One-command rollback: `codemie-claude --rollback`

---

## References

- **Claude Code Setup Documentation**: https://code.claude.com/docs/en/setup
- **Native Installer Scripts**:
  - macOS/Linux: https://claude.ai/install.sh
  - Windows PowerShell: https://claude.ai/install.ps1
  - Windows CMD: https://claude.ai/install.cmd
- **BaseAgentAdapter**: `src/agents/core/BaseAgentAdapter.ts`
- **Process Utilities**: `src/utils/processes.ts`
- **Error Handling**: `src/utils/errors.ts`
- **Agent Registry**: `src/agents/registry.ts`
- **Setup Command**: `src/cli/commands/setup.ts`
