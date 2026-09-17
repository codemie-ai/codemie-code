# EPMCDME-13925: Agent Tests Gate in Release Skill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent tests validation gate to `scripts/release.sh` that blocks the release if agent tests fail, and requires explicit user confirmation before proceeding if tests cannot run automatically.

**Architecture:** Single bash script modification. The gate runs `npm run test:integration:agent` with a JSON reporter to capture structured results, then branches on three outcomes: (1) exit non-zero → block release; (2) exit 0 + tests passed → continue; (3) exit 0 + 0 tests executed → prompt user for manual confirmation. The `SSO_AVAILABLE` env var is set inside the vitest child process and cannot be read by the parent shell, so test-execution detection relies on parsing the JSON reporter output (`numPassedTests`).

**Tech Stack:** bash, vitest 4.x (`--reporter=json --outputFile`), Node.js (for JSON parse in bash), npm scripts

## Global Constraints

- Do NOT use `set -e` — script is intentionally non-aborting for resumability.
- Exit codes must be captured explicitly with `exit_code=$?`.
- All user prompts use `read -p "... (y/N): " -n 1 -r` + `[[ ! $REPLY =~ ^[Yy]$ ]]` pattern — match existing style.
- Warning/non-blocking messages use `echo "⚠️ ..."` prefix.
- Gate failures that block the release use `echo "❌ ..."` + `exit 1`.
- Success confirmations use `echo "✅ ..."`.

---

### Task 1: Add agent tests gate to `scripts/release.sh`

**Files:**
- Modify: `scripts/release.sh`

**Interfaces:**
- Consumes: `npm run test:integration:agent` (defined in `package.json` → `vitest run --project agent`)
- Consumes: vitest JSON reporter output (`numPassedTests`, `numFailedTests`, `numSkippedTests`)
- Produces: nothing externally; exits 1 on block, continues on pass

Test-first: no — `scripts/release.sh` is a bash orchestration script not covered by Vitest; verification is manual (see verification steps below)

- [ ] **Step 1: Read the current release.sh and identify the two insertion points**

  Confirm before editing:
  1. **Insertion A** — the "Actions that will be performed" section (around line 145, where `echo "$STEP. Push commit and tag to origin"` is). This is where agent tests step description goes.
  2. **Insertion B** — the execution section, between the version-bump commit block (ends around line 195) and the tag creation block (starts around line 197). This is where the actual test gate logic goes.

- [ ] **Step 2: Add agent tests to the "Actions" pre-flight display**

  In the "Actions that will be performed" section (around line 145), add a line showing agent tests as a step. Find this block:

  ```bash
  if [[ "$VERSION_UPDATED" == "false" ]]; then
      echo "$STEP. Update package.json version to $VERSION"
      STEP=$((STEP + 1))
  fi
  if [[ "$VERSION_COMMITTED" == "false" ]]; then
      echo "$STEP. Commit version bump"
      STEP=$((STEP + 1))
  fi
  if [[ "$TAG_EXISTS" == "false" ]]; then
      echo "$STEP. Create git tag v$VERSION"
      STEP=$((STEP + 1))
  fi
  echo "$STEP. Push commit and tag to origin"
  ```

  Insert BEFORE `echo "$STEP. Push commit and tag to origin"`:

  ```bash
  echo "$STEP. Run agent tests (or confirm manual run if credentials unavailable)"
  STEP=$((STEP + 1))
  ```

- [ ] **Step 3: Add the agent test gate in the execution section**

  Find this comment and block (around line 197):

  ```bash
  # Create tag (skip if exists)
  if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
  ```

  Insert the complete gate block IMMEDIATELY BEFORE it:

  ```bash
  # Run agent tests before tagging — gate the release on test outcome
  echo ""
  echo "🧪 Running agent tests..."
  AGENT_TEST_JSON=$(mktemp /tmp/agent-test-XXXXX.json)
  npm run test:integration:agent -- --reporter=verbose --reporter=json --outputFile="$AGENT_TEST_JSON"
  AGENT_EXIT_CODE=$?

  AGENT_PASSED=0
  if [[ -f "$AGENT_TEST_JSON" ]]; then
      AGENT_PASSED=$(node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync('$AGENT_TEST_JSON','utf8'));console.log(r.numPassedTests||0)}catch{console.log(0)}")
  fi
  rm -f "$AGENT_TEST_JSON"

  if [[ $AGENT_EXIT_CODE -ne 0 ]]; then
      echo ""
      echo "❌ Agent tests FAILED (exit code $AGENT_EXIT_CODE). Release cannot proceed."
      echo "   Fix the failing agent tests before releasing."
      exit 1
  elif [[ "$AGENT_PASSED" -gt 0 ]]; then
      echo "✅ Agent tests passed ($AGENT_PASSED tests)"
  else
      echo ""
      echo "⚠️  Agent tests could not run automatically (0 tests executed)."
      echo "   This usually means SSO credentials or network access are unavailable."
      echo ""
      echo "   Why agent tests are required:"
      echo "   Agent tests validate the full codemie-code integration against a live"
      echo "   CodeMie server. Skipping them risks releasing broken agent behavior."
      echo ""
      echo "   To run agent tests automatically:"
      echo "   • Local: ensure your active profile uses provider 'ai-run-sso'"
      echo "     (check: cat ~/.codemie/codemie-cli.config.json)"
      echo "   • CI:    set CI_IS_LOCAL_RUN=false and provide tests/.env.test.local"
      echo ""
      echo "   To run manually: npm run test:integration:agent"
      echo ""
      read -p "❓ Have you manually run agent tests and confirmed they pass? (y/N): " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
          echo "❌ Release aborted — agent tests must pass before releasing."
          exit 1
      fi
      echo "✅ Agent tests manually confirmed by user"
  fi
  ```

- [ ] **Step 4: Manually verify — scenario A (tests pass automatically)**

  In a local environment with a valid SSO profile (`provider: "ai-run-sso"`):

  ```bash
  # Run the release script in dry-run mode first
  bash scripts/release.sh --dry-run
  # Expected: actions list includes "N. Run agent tests (or confirm manual run...)"

  # Then verify the gate block in a non-release context by running only the gate logic:
  # Temporarily extract and run the block standalone, or do a controlled release against a test version
  ```

  Expected behavior when tests pass:
  - vitest runs, exits 0
  - `AGENT_PASSED > 0` is true
  - Output: `✅ Agent tests passed (N tests)`
  - Release continues to tag creation

- [ ] **Step 5: Manually verify — scenario B (tests fail)**

  Simulate a test failure by temporarily introducing a failing test or running in an environment where tests are expected to fail:

  Expected behavior when tests fail:
  - vitest exits with non-zero code
  - Output: `❌ Agent tests FAILED (exit code N). Release cannot proceed.`
  - Script exits 1 — release does NOT continue

- [ ] **Step 6: Manually verify — scenario C (credentials unavailable)**

  Switch your active profile to a non-SSO provider (or temporarily rename `tests/.env.test.local`), then run a release:

  Expected behavior when credentials are unavailable:
  - vitest exits 0 but `AGENT_PASSED` is 0
  - Output shows the "⚠️ Agent tests could not run automatically" block with explanation
  - User is prompted for manual confirmation
  - Answering `n` → `❌ Release aborted` + script exits 1
  - Answering `y` → `✅ Agent tests manually confirmed by user` → release continues to tag

- [ ] **Step 7: Manually verify — dry-run mode does not invoke tests**

  ```bash
  bash scripts/release.sh --dry-run
  ```

  Expected: script exits before the execution section (at line ~160); agent test gate is never reached; output shows agent tests in the "Actions" list.

- [ ] **Step 8: Update the release script header comment**

  Find the header block at the top of `scripts/release.sh`:

  ```bash
  # CodeMie Code Release Script
  # Simple script to automate releases following KISS principles
  # Designed to be resumable - can continue from failed steps
  ```

  Replace with:

  ```bash
  # CodeMie Code Release Script
  # Simple script to automate releases following KISS principles
  # Designed to be resumable - can continue from failed steps
  #
  # Release flow: version bump → commit → agent tests gate → tag → push → GitHub release
  # Agent tests gate: runs `npm run test:integration:agent` before tagging.
  #   - Tests pass → continue automatically
  #   - Tests fail → release blocked (fix tests first)
  #   - Tests cannot run (missing SSO/JWT credentials) → manual confirmation required
  ```

- [ ] **Step 9: Commit**

  ```bash
  git add scripts/release.sh
  git commit -m "feat(release): add agent tests validation gate

  Block the release if agent tests fail. When tests cannot run
  automatically (missing SSO credentials or network), require
  explicit user confirmation before proceeding.

  Closes EPMCDME-13925"
  ```
