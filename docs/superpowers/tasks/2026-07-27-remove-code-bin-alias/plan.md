# Remove `code` bin alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `"code"` npm bin entry from `package.json` to prevent collisions with VS Code's `code` CLI, and document the migration path for existing users.

**Architecture:** One-line deletion from `package.json` eliminates the npm-level alias at install time. A new `docs/MIGRATION.md` file explains the breaking change, the stale-symlink caveat (existing installs retain the symlink until reinstall), and two workaround options for users who relied on the `code` shorthand.

**Tech Stack:** npm bin declarations, Markdown

## Global Constraints

- ES modules only — no `require()` in any changed file
- No installer opt-in (`postinstall.mjs` is out of scope for this ticket)
- Migration note must mention the stale-symlink limitation and both workaround options
- Ticket: EPMCDME-13589

---

### Task 1: Remove `code` from `package.json` bin block

**Test-first:** no — manifest change, not runtime behaviour. Verification is a `grep` assertion on the file.

**Files:**
- Modify: `package.json:10` — delete the `"code"` entry

**Interfaces:**
- Consumes: nothing
- Produces: `package.json` with `bin` block that no longer declares `"code"` — `codemie`, `codemie-code`, and all other entries remain intact

- [ ] **Step 1: Delete the `"code"` bin line**

Open `package.json`. The `bin` block currently looks like:

```json
"bin": {
  "codemie": "./bin/codemie.js",
  "code": "./bin/codemie.js",
  "codemie-code": "./bin/agent-executor.js",
  ...
```

Remove exactly this line (line 10):

```
  "code": "./bin/codemie.js",
```

After the edit:

```json
"bin": {
  "codemie": "./bin/codemie.js",
  "codemie-code": "./bin/agent-executor.js",
  ...
```

- [ ] **Step 2: Verify `code` is absent and JSON is valid**

```bash
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(Object.keys(p.bin));"
```

Expected output must include `codemie` and `codemie-code` but must NOT include `code`.

```bash
grep '"code"' package.json | grep -v codemie-code | grep -v codemie-claude
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "fix(cli): remove \`code\` bin alias from package.json (EPMCDME-13589)"
```

---

### Task 2: Create migration note

**Test-first:** no — documentation task.

**Files:**
- Create: `docs/MIGRATION.md`

**Interfaces:**
- Consumes: nothing
- Produces: `docs/MIGRATION.md` — top-level migration guide

- [ ] **Step 1: Create `docs/MIGRATION.md`**

```markdown
# Migration Guide

## Removing the `code` CLI alias (v0.10.x → next)

### What changed

The `code` npm bin alias has been removed from `@codemieai/code`. Running `code` after upgrading will no longer invoke the CodeMie CLI.

**Why:** The `code` alias collides with the VS Code CLI (`code`) that is widely installed on developer machines. This collision caused confusing behaviour and is a potential security footgun.

### Who is affected

Users who invoked CodeMie via the `code` command instead of `codemie`.

### What to do

**Option 1 (recommended): Use `codemie` instead.**

​```sh
# Before
code chat

# After
codemie chat
​```

All CodeMie commands are available under `codemie` and `codemie-code`.

**Option 2: Add your own shell alias.**

If you prefer the shorter name, add this to your `~/.zshrc` or `~/.bashrc`:

​```sh
alias code=codemie
​```

Then reload your shell:

​```sh
source ~/.zshrc   # or ~/.bashrc
​```

### Stale symlink note

If you installed `@codemieai/code` globally **before this release**, npm may have already created a `code` symlink in your global bin directory. Upgrading via `npm update -g @codemieai/code` removes it for a fresh install of the new package, but existing symlinks from older installs may persist.

To verify and clean up:

​```sh
# Check if the stale symlink exists
which code

# If it still points to codemie, remove it manually
npm unlink -g @codemieai/code && npm install -g @codemieai/code
​```
```

- [ ] **Step 2: Verify file was created**

```bash
ls -la docs/MIGRATION.md
grep -c "stale symlink" docs/MIGRATION.md
```

Expected: file exists, grep returns `1`.

- [ ] **Step 3: Commit**

```bash
git add docs/MIGRATION.md
git commit -m "docs: add MIGRATION.md for \`code\` bin alias removal (EPMCDME-13589)"
```
