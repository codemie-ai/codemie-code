# CLAUDE.md

**Purpose**: AI-optimized execution guide for Claude Code agents working with the CodeMie Code codebase

---

## 📚 GUIDE IMPORTS

This document references detailed guides stored in `.codemie/guides/`. Key references:

### 🚨 MANDATORY RULE: Check Guides First

**BEFORE searching files or codebase for information, you MUST:**

1. **Always check** if the guides referenced below contain relevant information for the prompt or task
2. **Use the Task Classifier** in [Instant Start](#-instant-start-read-first) to identify which guides are relevant
3. **Load and review** the appropriate P0 (required) guides BEFORE performing direct file searches
4. **Only proceed** to codebase searches after confirming guides don't contain the needed patterns/information

**This rule is MANDATORY and must be followed without exceptions.**

**Why**: Guides contain curated patterns, best practices, and architectural decisions. Checking them first:
- Prevents reinventing existing patterns
- Ensures consistency with established conventions
- Saves time by providing direct answers to common questions
- Reduces risk of introducing anti-patterns

**Workflow**: Prompt → Task Classifier → Load Relevant Guides → Check Guide Content → Then Search Codebase (if needed)

---

### 📖 Guide References by Category

**Architecture**:
- [Project Structure]: .codemie/guides/architecture/project-structure.md
- [Layered Architecture]: .codemie/guides/architecture/layered-architecture.md

**Development Practices**:
- [Development Practices]: .codemie/guides/development/development-practices.md
- [Code Quality]: .codemie/guides/standards/code-quality.md

**Testing**:
- [Testing Patterns]: .codemie/guides/testing/testing-patterns.md

**Standards & Workflows**:
- [Git Workflow]: .codemie/guides/standards/git-workflow.md

**API & Integration**:
- [API Patterns]: .codemie/guides/api/api-patterns.md
- [External Integrations]: .codemie/guides/integration/external-integrations.md

**Security & Data**:
- [Security Practices]: .codemie/guides/security/security-practices.md
- [Database Patterns]: .codemie/guides/data/database-patterns.md

---

## ⚡ INSTANT START (Read First)

### 1. Critical Rules (MANDATORY - Always Check)

| Rule | Trigger | Action Required |
|------|---------|-----------------|
| 🚨 **Check Guides First** | ANY new prompt/task | ALWAYS check relevant guides BEFORE searching codebase → [Guide Imports](#-guide-imports) |
| 🚨 **Testing** | User says "write tests", "run tests" | ONLY then work on tests → [Testing Policy](#testing-policy) |
| 🚨 **Git Ops** | User says "commit", "push", "create PR" | ONLY then do git operations → [Git Policy](#git-operations-policy) |
| 🚨 **Node Environment** | ANY TypeScript/npm command | No activation needed (Node.js >=20.0.0) → [Env Policy](#environment-policy) |
| 🚨 **Shell** | ANY shell command | ONLY bash/Linux syntax → [Shell Policy](#shell-environment-policy) |

**Emergency Recovery**: If commands fail → Check [Troubleshooting](#-troubleshooting-quick-reference)

### 2. Task Classifier (What am I doing?)

**Scan user request for keywords → Load guides → Execute**

| Keywords | Complexity | Load Guide (P0=Required) | Also Load (P1=Optional) |
|----------|-----------|--------------------------|-------------------------|
| **plugin, registry, agent, adapter** | Medium-High | .codemie/guides/api/api-patterns.md | .codemie/guides/architecture/layered-architecture.md |
| **architecture, layer, structure** | Medium | .codemie/guides/architecture/layered-architecture.md | .codemie/guides/architecture/project-structure.md |
| **test, vitest, mock, coverage** | Medium | .codemie/guides/testing/testing-patterns.md | .codemie/guides/development/development-practices.md |
| **error, exception, validation** | Medium | .codemie/guides/development/development-practices.md | .codemie/guides/security/security-practices.md |
| **security, sanitize, credential** | High | .codemie/guides/security/security-practices.md | .codemie/guides/development/development-practices.md |
| **provider, sso, bedrock, litellm** | Medium-High | .codemie/guides/api/api-patterns.md | .codemie/guides/integration/external-integrations.md |
| **cli, command, commander** | Medium | .codemie/guides/architecture/layered-architecture.md | .codemie/guides/architecture/project-structure.md |
| **workflow, template, ci/cd** | Medium | .codemie/guides/integration/external-integrations.md | .codemie/guides/standards/git-workflow.md |
| **database, jsonl, metrics, analytics** | Medium | .codemie/guides/data/database-patterns.md | .codemie/guides/development/development-practices.md |
| **commit, branch, pr, git** | Medium | .codemie/guides/standards/git-workflow.md | - |

**Guide Path**: All guides in `.codemie/guides/<category>/`

**Complexity Guide**:
- **Simple**: 1 file, < 5 min, obvious pattern → Use direct tools (Grep/Glob/Read)
- **Medium**: 2-5 files, 5-15 min, standard patterns → Use direct tools + guide reference
- **High**: 6+ files, 15+ min, architectural decisions → Consider EnterPlanMode or Task tool

### 3. Self-Check Before Starting

Before any action:
- [ ] Did I check relevant guides FIRST (before searching codebase)?
- [ ] Which critical rules apply? (guides/testing/git/env/shell)
- [ ] What keywords did I identify?
- [ ] What's the complexity level?
- [ ] Which guides do I need to load (P0 first)?
- [ ] Am I 80%+ confident about approach?

**Decision Gates**:
- ❌ **NO to any above** → ASK USER or READ MORE before proceeding
- ❌ **Confidence < 80%** → Load P0 guides, then re-assess
- ✅ **YES to all + Confidence 80%+** → Proceed to execution

---

## 🔄 EXECUTION WORKFLOW (Step-by-Step)

Follow this sequence for every task:

```
START
  │
  ├─> STEP 1: Parse Request
  │   ├─ Identify task keywords (see Task Classifier above)
  │   ├─ Check which Critical Rules apply
  │   ├─ Assess complexity level
  │   └─ Gate: Can I identify 1+ relevant guides? NO → Ask user | YES → Continue
  │
  ├─> STEP 2: Confidence Check
  │   ├─ Am I 80%+ confident about approach?
  │   ├─ YES → Continue | NO → Load P0 guides
  │   └─ Gate: After reading, confidence 80%+? NO → Load P1 guides or ask user | YES → Continue
  │
  ├─> STEP 3: Load Documentation (Selective, Not Everything)
  │   ├─ Load P0 guides from Task Classifier (REQUIRED for Medium/High complexity)
  │   ├─ Scan P1 guides - load only if confidence still < 80% (OPTIONAL)
  │   └─ Gate: Do I have enough context? NO → Load more or ask user | YES → Continue
  │
  ├─> STEP 4: Pattern Match (Use Quick References)
  │   ├─ Check Pattern Tables below (error handling, logging, architecture)
  │   ├─ Check Common Pitfalls table
  │   └─ Gate: Do I know the correct pattern? NO → Read guide detail | YES → Continue
  │
  ├─> STEP 5: Execute (Apply Patterns)
  │   ├─ Apply patterns from loaded guides
  │   ├─ Follow Critical Rules (test/git/env/shell)
  │   ├─ Track progress with success indicators
  │   └─ Cross-check with Quick Validation (below)
  │
  └─> STEP 6: Validate (Before Delivery)
      ├─ Run through Quick Validation checklist
      ├─ Check Success Indicators
      ├─ Gate: All checks pass? NO → Fix issues | YES → Deliver
      └─ END
```

### Success Indicators (Am I on track?)

| Stage | Good Signs | Warning Signs |
|-------|-----------|---------------|
| **Parse Request** | Keywords match Task Classifier | No matching keywords → ask user |
| **Confidence Check** | 80%+ confident after reading | Still confused after P0 guides → need clarification |
| **Load Docs** | Patterns clear, examples match task | Multiple conflicting patterns → ask user preference |
| **Pattern Match** | Found exact pattern in quick ref | No matching pattern → read full guide |
| **Execute** | Code compiles, follows architecture | Errors, missing imports → check guide again |
| **Validate** | All checks pass, tests work | Any check fails → fix before delivery |

### Quick Validation (Run Before Delivery)

| Priority | Check | How to Verify | Fix If Failed |
|----------|-------|---------------|---------------|
| 🚨 | **Functionality** | Does it meet user request? | Re-read requirements |
| 🚨 | **Critical Rules** | Did I follow test/git/env/shell rules? | Review policies below |
| 🚨 | **Security** | No hardcoded secrets? Input validated? | See [Security Patterns](#security-patterns-mandatory) |
| 🚨 | **Error Handling** | Using proper exceptions? | See [Error Handling](#error-handling-use-these-patterns) |
| 🚨 | **Logging** | Following logging patterns? | See [Logging Patterns](#logging-patterns-mandatory) |
| ⚠️ | **Architecture** | Followed layered architecture? | See guides in .codemie/guides/architecture/ |
| ⚠️ | **Async/Concurrency** | Used appropriate patterns? | See [Common Pitfalls](#common-pitfalls-avoid-these) |
| ✅ | **Type Safety** | All functions typed? | See code quality guide |
| ✅ | **Code Quality** | No TODOs, unused imports? | Run linter |

---

## 📊 PATTERN QUICK REFERENCE

### Error Handling (Use These Patterns)

| When | Pattern/Exception | Import From | Related Patterns |
|------|-------------------|-------------|------------------|
| Configuration failed | `ConfigurationError` | `src/utils/errors.ts` | [Logging](#logging-patterns-mandatory) |
| Agent not found | `AgentNotFoundError` | `src/utils/errors.ts` | [API Patterns](#api-patterns) |
| Agent install failed | `AgentInstallationError` | `src/utils/errors.ts` | [Process Execution](#process-patterns) |
| Tool execution failed | `ToolExecutionError` | `src/utils/errors.ts` | [Security](#security-patterns-mandatory) |
| Path security issue | `PathSecurityError` | `src/utils/errors.ts` | [Security](#security-patterns-mandatory) |
| npm operation failed | `NpmError` | `src/utils/errors.ts` | [Process Execution](#process-patterns) |
| Generic CodeMie error | `CodeMieError` | `src/utils/errors.ts` | Base class for all errors |

**Error Context**:
```typescript
// Always provide context for errors
import { createErrorContext, formatErrorForUser } from 'src/utils/errors.js';

try {
  await riskyOperation();
} catch (error) {
  const context = createErrorContext(error, { sessionId, agent: 'claude' });
  logger.error('Operation failed', context);
  console.error(formatErrorForUser(context));
}
```

**Detail**: .codemie/guides/development/development-practices.md

### Logging Patterns (MANDATORY)

| ✅ DO | ❌ DON'T | Why | Related |
|-------|----------|-----|---------|
| Use logger.debug() for internal details | Use console.log() directly | Debug logs go to file, controlled by CODEMIE_DEBUG | [Error Handling](#error-handling-use-these-patterns) |
| Use logger.info() for non-console logs | Log sensitive data (tokens, keys) | Auto-sanitization prevents leaks | [Security](#security-patterns-mandatory) |
| Use logger.success() for user feedback | Skip session/agent context | Context required for debugging | [Session Management](#session-patterns) |
| Sanitize before logging | Log raw API responses | Prevents credential exposure | [Security](#security-patterns-mandatory) |

**Session Context**:
```typescript
// Set session context at agent startup
logger.setSessionId(sessionId);
logger.setAgentName('claude');
logger.setProfileName('work');

// All subsequent logs include context automatically
logger.debug('Processing request'); // [DEBUG] [claude] [session-id] [work] Processing request
```

**Detail**: .codemie/guides/development/development-practices.md

### Architecture Patterns (Core Rules)

| Layer | Responsibility | Example Path | Related Guide |
|-------|----------------|--------------|---------------|
| **CLI** | User interface, Commander.js commands | `src/cli/commands/` | .codemie/guides/architecture/layered-architecture.md |
| **Registry** | Plugin discovery, routing | `src/agents/registry.ts` | .codemie/guides/api/api-patterns.md |
| **Plugin** | Concrete implementations (agents, providers) | `src/agents/plugins/claude/` | .codemie/guides/api/api-patterns.md |
| **Core** | Base classes, interfaces, contracts | `src/agents/core/` | .codemie/guides/architecture/layered-architecture.md |
| **Utils** | Shared utilities (errors, logging, security) | `src/utils/` | .codemie/guides/development/development-practices.md |

**Flow**: `CLI → Registry → Plugin → Core → Utils` (Never skip layers)

**Detail**: .codemie/guides/architecture/layered-architecture.md

### Security Patterns (MANDATORY)

| Rule | Implementation | Related Guide |
|------|----------------|---------------|
| No hardcoded credentials | Use environment variables + CredentialStore | .codemie/guides/security/security-practices.md |
| Input validation | Validate all file paths with security utilities | .codemie/guides/security/security-practices.md |
| Data sanitization | Use sanitizeValue(), sanitizeLogArgs() before logging | .codemie/guides/security/security-practices.md |
| Credential storage | CredentialStore with keychain + encrypted fallback | .codemie/guides/security/security-practices.md |

**Security Utilities**:
```typescript
import { sanitizeValue, sanitizeLogArgs, CredentialStore } from 'src/utils/security.js';

// Sanitize before logging
logger.debug('Request data', ...sanitizeLogArgs(requestData));

// Store/retrieve credentials securely
const store = CredentialStore.getInstance();
await store.storeSSOCredentials(credentials, baseUrl);
const retrieved = await store.retrieveSSOCredentials(baseUrl);
```

**Detail**: .codemie/guides/security/security-practices.md

### Process Patterns (npm, git, exec)

| Operation | Function | Import From | Notes |
|-----------|----------|-------------|-------|
| Execute command | `exec(command, args, options)` | `src/utils/processes.ts` | Base execution, returns ExecResult |
| Check command exists | `commandExists(command)` | `src/utils/processes.ts` | Returns boolean |
| Get command path | `getCommandPath(command)` | `src/utils/processes.ts` | Returns absolute path or null |
| Install npm package | `installGlobal(packageName)` | `src/utils/processes.ts` | Handles npm install -g |
| Uninstall npm package | `uninstallGlobal(packageName)` | `src/utils/processes.ts` | Handles npm uninstall -g |
| Check npm package | `listGlobal(packageName)` | `src/utils/processes.ts` | Returns boolean |
| Get npm version | `getVersion()` | `src/utils/processes.ts` | Returns npm version |
| Run with npx | `npxRun(command, args)` | `src/utils/processes.ts` | Handles npx execution |
| Detect git branch | `detectGitBranch(cwd)` | `src/utils/processes.ts` | Returns current branch |

**Error Handling**:
```typescript
import { installGlobal, parseNpmError } from 'src/utils/processes.ts';

try {
  await installGlobal('package-name');
} catch (error) {
  const npmError = parseNpmError(error, 'Failed to install package');
  // npmError includes code (NETWORK_ERROR, PERMISSION_ERROR, etc.) and hints
}
```

**Detail**: .codemie/guides/development/development-practices.md

### Common Pitfalls (Avoid These)

| Category | 🚨 Never Do This | ✅ Do This Instead | Guide Reference |
|----------|------------------|---------------------|-----------------|
| **TypeScript** | Use `require()` or `__dirname` | Use ES modules: `import` and `getDirname(import.meta.url)` | .codemie/guides/development/development-practices.md |
| **Imports** | Import without `.js` extension | Always use `.js` extension: `import x from './file.js'` | .codemie/guides/standards/code-quality.md |
| **Testing** | Write tests unless requested | Only write tests when user explicitly asks | .codemie/guides/testing/testing-patterns.md |
| **Process Execution** | Use `child_process.exec` directly | Use `exec()` from `src/utils/processes.ts` | .codemie/guides/development/development-practices.md |
| **Logging** | Use `console.log()` for debug info | Use `logger.debug()` (file-only, controlled) | .codemie/guides/development/development-practices.md |
| **Security** | Log sensitive data (tokens, keys) | Use `sanitizeLogArgs()` before logging | .codemie/guides/security/security-practices.md |
| **Error Handling** | Throw generic Error | Throw specific error classes (ConfigurationError, etc.) | .codemie/guides/development/development-practices.md |
| **Paths** | Hardcode ~/.codemie/ paths | Use `getCodemiePath()` from `src/utils/paths.ts` | .codemie/guides/development/development-practices.md |
| **Architecture** | CLI directly calls plugin code | CLI → Registry → Plugin (never skip layers) | .codemie/guides/architecture/layered-architecture.md |
| **Async** | Use callbacks or Promise chaining | Use async/await consistently | .codemie/guides/standards/code-quality.md |

---

## 🛠️ DEVELOPMENT COMMANDS

**🚨 CRITICAL**: No virtual environment needed - Node.js >=20.0.0 required

### Common Commands

| Task | Command | Env? | Notes |
|------|---------|------|-------|
| **Setup** | `npm install` | N/A | First time setup, installs all dependencies |
| **Build** | `npm run build` | N/A | Compile TypeScript to dist/ |
| **Dev Watch** | `npm run dev` | N/A | Watch mode (tsc --watch) |
| **Lint** | `npm run lint` | N/A | ESLint check (zero warnings required) |
| **Lint Fix** | `npm run lint:fix` | N/A | Auto-fix ESLint issues |
| **Test** ⚠️ | `npm test` | N/A | Run all tests - ONLY if user requests |
| **Test Unit** ⚠️ | `npm run test:unit` | N/A | Unit tests only - ONLY if user requests |
| **Test Integration** ⚠️ | `npm run test:integration` | N/A | Integration tests only - ONLY if user requests |
| **CI Full** | `npm run ci` | N/A | Full CI pipeline (lint + build + tests) |
| **Doctor** | `codemie doctor` | N/A | System health check (after npm link) |
| **Link Global** | `npm link` | N/A | Link for local testing (after build) |

**Build + Link Workflow**:
```bash
npm run build && npm link
codemie doctor  # Verify installation
codemie-code health  # Test built-in agent
```

**Additional Info**:
- Package manager: npm (no yarn/pnpm)
- Test framework: Vitest
- Build output: `dist/` (gitignored)
- Entry points: `bin/codemie.js`, `bin/agent-executor.js`

---

## 🔧 TROUBLESHOOTING QUICK REFERENCE

### Common Issues & Fixes

| Symptom | Likely Cause | Fix | Prevention |
|---------|--------------|-----|------------|
| `command not found: codemie` | Not installed globally or not linked | Run `npm install -g @codemieai/code` or `npm link` | Use global install for CLI tools |
| `Cannot find module './file'` | Missing .js extension in import | Add `.js` extension to all imports | ESLint rule enforces this |
| `Module not found: @codemieai/code` | Dependencies not installed | Run `npm install` | Always run after clone/pull |
| Tests failing with dynamic imports | Static imports before spy setup | Use dynamic imports after beforeEach | See testing patterns guide |
| `CODEMIE_DEBUG=true` not working | Environment variable not set | Export in shell: `export CODEMIE_DEBUG=true` | Use .env file for persistent settings |
| ESLint warnings > 0 | Code quality issues | Run `npm run lint:fix` to auto-fix | Run lint before commit |
| TypeScript compilation errors | Type issues or missing declarations | Check `tsconfig.json` settings | Use strict mode, avoid `any` |
| `Permission denied` on global install | Insufficient permissions | Use `sudo npm install -g` (Unix) or run as admin (Windows) | Use nvm for user-local Node.js |
| Agent not found after install | Registry not updated or cache issue | Check `~/.codemie/agents/` directory | Verify installation with `codemie doctor` |

### Diagnostic Commands

| Need to Check | Command | What to Look For |
|---------------|---------|------------------|
| Node.js version | `node --version` | >=20.0.0 required |
| npm version | `npm --version` | Should be bundled with Node.js |
| Global packages | `npm list -g --depth=0` | Should show @codemieai/code if installed |
| CodeMie health | `codemie doctor` | All checks should pass |
| Build output | `ls -la dist/` | Should contain compiled .js files |
| TypeScript config | `cat tsconfig.json` | Verify ES2022 target, NodeNext module |

### Emergency Recovery

| Situation | Action |
|-----------|--------|
| **Commands failing** | 1. Verify Node.js >=20.0.0 (`node --version`)<br>2. Reinstall dependencies (`rm -rf node_modules && npm install`)<br>3. Rebuild project (`npm run build`)<br>4. Re-link global (`npm link`) |
| **Build errors** | 1. Clean dist directory (`rm -rf dist/`)<br>2. Check TypeScript errors (`npx tsc --noEmit`)<br>3. Fix import paths (.js extensions required)<br>4. Rebuild (`npm run build`) |
| **Pattern unclear** | 1. Search .codemie/guides/ for pattern<br>2. Check related patterns in Quick Reference<br>3. Ask user if ambiguous |
| **Tests failing** | 1. Check if using dynamic imports for mocking<br>2. Verify test isolation (no shared state)<br>3. Check if environment variables are set<br>4. Run single test file to isolate issue |

---

## 🏗️ PROJECT CONTEXT

### Technology Stack

| Component | Tool | Version | Purpose |
|-----------|------|---------|---------|
| Language | TypeScript | 5.3+ | Type-safe development |
| Runtime | Node.js | 20.0.0+ | JavaScript execution environment |
| Framework | LangGraph | 1.0.2+ | Agent orchestration and state management |
| Framework | LangChain | 1.0.4+ | LLM integration and tool calling |
| Testing | Vitest | 4.0.10+ | Fast unit testing framework |
| Linting | ESLint | 9.38.0+ | Code quality enforcement (flat config) |
| CLI | Commander.js | 11.1.0+ | Command-line argument parsing |
| UI | Inquirer | 9.2.12+ | Interactive CLI prompts |
| Package Manager | npm | - | Dependency management |

### Core Components

| Component | Path | Purpose | Guide |
|-----------|------|---------|-------|
| **CLI Commands** | `src/cli/commands/` | User interface (setup, doctor, install, etc.) | .codemie/guides/architecture/layered-architecture.md |
| **Agent System** | `src/agents/` | Plugin-based agent management (registry, core, plugins) | .codemie/guides/api/api-patterns.md |
| **Provider System** | `src/providers/` | LLM provider integrations (OpenAI, Bedrock, SSO, LiteLLM) | .codemie/guides/integration/external-integrations.md |
| **Analytics** | `src/analytics/` | Usage tracking and metrics (JSONL-based) | .codemie/guides/data/database-patterns.md |
| **Workflows** | `src/workflows/` | CI/CD workflow templates (GitHub, GitLab) | .codemie/guides/integration/external-integrations.md |
| **Utilities** | `src/utils/` | Shared utilities (errors, logging, security, processes) | .codemie/guides/development/development-practices.md |
| **Configuration** | `src/env/` | Environment and profile management | .codemie/guides/development/development-practices.md |

### Key Integrations

| Integration | Purpose | Guide |
|-------------|---------|-------|
| LangGraph | Agent orchestration, state machines, tool calling | .codemie/guides/integration/external-integrations.md |
| LangChain | LLM abstractions, provider integrations | .codemie/guides/integration/external-integrations.md |
| AWS Bedrock | Enterprise LLM access (Claude via AWS) | .codemie/guides/integration/external-integrations.md |
| Azure OpenAI | Enterprise OpenAI access | .codemie/guides/integration/external-integrations.md |
| LiteLLM | Unified LLM proxy (100+ providers) | .codemie/guides/integration/external-integrations.md |
| Ollama | Local LLM execution | .codemie/guides/integration/external-integrations.md |
| Enterprise SSO | Corporate authentication (SAML, OAuth) | .codemie/guides/security/security-practices.md |

### Architecture Overview

**Plugin-Based 5-Layer Architecture**:
- **CLI Layer**: User interface and command handling (Commander.js)
- **Registry Layer**: Plugin discovery, routing, and orchestration
- **Plugin Layer**: Concrete implementations (agents, providers, frameworks)
- **Core Layer**: Base classes, interfaces, contracts (abstract base classes)
- **Utils Layer**: Shared utilities and foundation code

**Key Characteristics**:
- Separation of concerns (each layer has distinct responsibility)
- Dependency inversion (plugins depend on core, not vice versa)
- Open/Closed principle (extend via plugins, no core modification)
- Testability (each layer tested independently)

**Detail**: .codemie/guides/architecture/layered-architecture.md

---

## 📝 CODING STANDARDS

### TypeScript Features (Use These)

| Feature | Use For | Guide Reference |
|---------|---------|-----------------|
| ES Modules | All imports/exports (no CommonJS) | .codemie/guides/standards/code-quality.md |
| async/await | All asynchronous operations | .codemie/guides/standards/code-quality.md |
| interface/type | Type definitions (prefer interface for objects) | .codemie/guides/standards/code-quality.md |
| Generics | Reusable type-safe functions/classes | .codemie/guides/standards/code-quality.md |
| Optional chaining | Safe property access (`obj?.prop`) | .codemie/guides/standards/code-quality.md |
| Nullish coalescing | Default values (`val ?? default`) | .codemie/guides/standards/code-quality.md |
| Destructuring | Clean parameter/return handling | .codemie/guides/standards/code-quality.md |

**Detail**: .codemie/guides/standards/code-quality.md

### Type Safety (REQUIRED)

- All exported functions must have explicit return types
- Prefer interfaces over types for object shapes
- Avoid `any` (use `unknown` if type truly unknown)
- Use strict TypeScript settings (see tsconfig.json)
- `@typescript-eslint/no-explicit-any` disabled project-wide (use `any` when needed, but document why)
- Unused variables should be prefixed with `_` if intentional

### Async/Concurrency Patterns (CRITICAL)

| ✅ DO | ❌ DON'T | Guide |
|-------|----------|-------|
| Use async/await for all async operations | Use callbacks or .then() chains | .codemie/guides/standards/code-quality.md |
| Handle errors with try/catch in async functions | Let errors bubble without context | .codemie/guides/development/development-practices.md |
| Use Promise.all() for parallel operations | Await in loops (sequential bottleneck) | .codemie/guides/standards/code-quality.md |
| Avoid blocking operations in CLI | Use synchronous fs operations in async contexts | .codemie/guides/development/development-practices.md |

---

## 📚 DETAILED POLICIES

### Testing Policy

**MANDATORY RULE**: Tests ONLY when user EXPLICITLY requests

**Triggers** (work on tests ONLY if user says):
- ✅ "write tests"
- ✅ "run the tests"
- ✅ "create unit tests"
- ✅ "add test coverage"
- ✅ "execute test suite"

**Never Do**:
- ❌ Proactively write tests
- ❌ Suggest running tests
- ❌ Run tests unless asked

**Framework**: Vitest with dynamic imports for mocking

**Test Commands**:
- `npm test` - All tests
- `npm run test:unit` - Unit tests only (src/)
- `npm run test:integration` - Integration tests only (tests/)
- `npm run test:watch` - Watch mode
- `npm run test:coverage` - Coverage report

**Rationale**: Testing requires time and context. Only implement when explicitly needed.

**If Unsure**: Ask user for clarification

**Testing Details**: .codemie/guides/testing/testing-patterns.md

### Git Operations Policy

**MANDATORY RULE**: Git operations ONLY when user EXPLICITLY requests

**Triggers** (do git ops ONLY if user says):
- ✅ "commit these changes"
- ✅ "create a commit"
- ✅ "push to remote"
- ✅ "create a branch"
- ✅ "create a pull request"

**Never Do**:
- ❌ Proactively commit/push/branch
- ❌ Suggest git operations

**Branch Pattern**: `<type>/<description>` (e.g., `feat/add-gemini-support`, `fix/npm-install-error`)

**Commit Message Format**: Conventional Commits (feat:, fix:, refactor:, test:, docs:, chore:)

**Rationale**: Git affects version control history. Only perform when explicitly requested.

**If Unsure**: Ask user for clarification

**Git Details**: .codemie/guides/standards/git-workflow.md

### Environment Policy

**MANDATORY RULE**: No activation needed (Node.js environment)

**Why**: CodeMie Code is a Node.js CLI tool that runs in the system Node.js environment

**Requirements**:
- Node.js >=20.0.0 installed
- npm bundled with Node.js
- No virtual environment or activation step

**How to Verify**: `node --version` should show >=20.0.0

**Alternative**: Use nvm (Node Version Manager) for managing Node.js versions

**Rule of Thumb**: If commands fail with "command not found", check Node.js installation and PATH

**Recovery**: See [Troubleshooting](#-troubleshooting-quick-reference)

**Detail**: .codemie/guides/development/development-practices.md

### Shell Environment Policy

**MANDATORY RULE**: Use bash/Linux commands ONLY

**Requirements**:
- ✅ Bash/shell syntax for all commands
- ✅ Linux-compatible commands
- ❌ No Windows commands (PowerShell, cmd.exe)

**Rationale**: Ensures consistency across development environments (macOS, Linux, Windows WSL)

---

## 🎯 REMEMBER

### Critical Workflow
1. ⚡ Read [Instant Start](#-instant-start-read-first)
2. ✅ Run [Self-Check](#3-self-check-before-starting) (check confidence level)
3. 🔄 Follow [Execution Workflow](#-execution-workflow-step-by-step) (step-by-step with gates)
4. 📊 Use [Pattern Quick Reference](#-pattern-quick-reference) (fast lookups)
5. 🔍 Track [Success Indicators](#success-indicators-am-i-on-track) (am I on track?)
6. ✅ [Validate before delivery](#quick-validation-run-before-delivery) (all checks must pass)

### Critical Rules (Check EVERY Time)
- 🚨 **Check Guides First**: ALWAYS check relevant guides BEFORE searching codebase
- 🚨 **Testing**: Only when explicitly requested
- 🚨 **Git**: Only when explicitly requested
- 🚨 **Environment**: No activation needed (Node.js >=20.0.0)
- 🚨 **Shell**: Bash/Linux only

### Decision Making Framework
1. **Parse**: Use Task Classifier to identify keywords → guides → complexity
2. **Confidence**: Am I 80%+ confident? NO → Load P0 guides
3. **Load**: P0 (required) first, then P1 (optional) only if needed
4. **Execute**: Apply patterns, follow critical rules, track success indicators
5. **Validate**: All checks must pass before delivery
6. **Stuck?**: Check [Troubleshooting](#-troubleshooting-quick-reference), load more guides, or ask user

### Quality Standards (Non-Negotiable)

- No hardcoded secrets (use environment variables or CredentialStore)
- No placeholders/TODOs in delivered code
- All imports must use .js extensions
- Security: sanitize logs, validate paths, encrypt credentials
- Architecture: follow 5-layer pattern (CLI → Registry → Plugin → Core → Utils)
- Error handling: use specific error classes with context
- Type safety on all exported functions (explicit return types)
- Specific exception handling (use try/catch with error context)

### When to Ask User
- **Ambiguous requirements**: Multiple valid approaches possible
- **Low confidence**: < 80% after reading P0+P1 guides
- **Missing information**: Need clarification on scope/approach
- **High complexity**: Task involves architectural decisions
- **Policy unclear**: Unsure if testing/git/other policy applies

### Confidence Calibration
- **90%+ confident**: Proceed with execution, minimal guide lookup
- **80-89% confident**: Review quick reference tables, proceed
- **70-79% confident**: Load P0 guides, then re-assess
- **< 70% confident**: Load P0+P1 guides, ask user if still unclear

**Production Ready**: Deliver complete, tested, secure solutions without shortcuts.

**Questions?** Always better to ask than assume - ask for clarification when unsure.
