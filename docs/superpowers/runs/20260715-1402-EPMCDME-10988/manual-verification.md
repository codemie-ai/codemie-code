# Manual Verification — EPMCDME-10988

How to confirm the fix works locally before raising a PR.

## Repository setup

The upstream repo is `codemie-ai/codemie-code` (read-only for contributors).
The fix lives on branch `EPMCDME-10988` in the personal fork and the PR is open:
**https://github.com/codemie-ai/codemie-code/pull/425**

**If you don't have the repo locally, clone directly from the fork:**

```bash
git clone https://github.com/alex-budanov/codemie-code.git
```

The branch `EPMCDME-10988` is already in that fork — `git checkout EPMCDME-10988` after cloning.

**If you already have the repo cloned** (e.g. from upstream), the recommended remote layout is:

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/codemie-ai/codemie-code.git` | Upstream — fetch/pull only |
| `fork` | `https://github.com/alex-budanov/codemie-code.git` | Personal fork — push here |

### Working with the fork

```bash
# Fetch latest upstream changes
git fetch origin

# Push a new branch to your fork
git push fork <branch-name>

# Create a PR from your fork to upstream
gh pr create \
  --repo codemie-ai/codemie-code \
  --head alex-budanov:<branch-name> \
  --base main

# If git push asks for credentials, use your gh token:
GH_TOKEN=$(gh auth token)
git remote set-url fork "https://alex-budanov:${GH_TOKEN}@github.com/alex-budanov/codemie-code.git"
git push fork <branch-name>
git remote set-url fork https://github.com/alex-budanov/codemie-code.git  # reset to safe URL after push
```

---

## Safety first — create a restore script

Run this **before touching anything**. It saves your current `~/.claude/settings.json`
so you can get back to a clean state in one command if anything goes wrong.

```bash
cp ~/.claude/settings.json /tmp/claude-settings-backup.json
```

Then create the restore script:

```bash
cat > /tmp/restore-claude-settings.sh << SCRIPT
#!/usr/bin/env bash
cp /tmp/claude-settings-backup.json ~/.claude/settings.json
echo "Restored ~/.claude/settings.json"
cat ~/.claude/settings.json
SCRIPT
chmod +x /tmp/restore-claude-settings.sh
```

If anything breaks at any point, run:

```bash
bash /tmp/restore-claude-settings.sh
```

---

## Step 1 — Get the branch and build

**If you do not have the repo cloned yet**, clone from the fork:

```bash
git clone https://github.com/alex-budanov/codemie-code.git
cd codemie-code
git checkout EPMCDME-10988
```

**If you already have the repo cloned**, fetch the branch from the fork:

```bash
cd <your-repo-dir>

# Make sure the fork is a registered remote (add it once if missing)
git remote get-url fork 2>/dev/null || \
  git remote add fork https://github.com/alex-budanov/codemie-code.git

git fetch fork
git checkout EPMCDME-10988
```

Then build, and capture the repo path for later steps:

```bash
npm run build
REPO_DIR=$(pwd)
echo "REPO_DIR=$REPO_DIR"   # keep this shell open — Steps 3c/3d need it
```

Expected: build completes with no TypeScript errors.

---

## Step 2 — Run the automated tests

```bash
npx vitest run \
  src/agents/plugins/claude/__tests__/settings-conflict.test.ts \
  src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts \
  --reporter=verbose
```

Expected: **12 passed** (6 unit + 6 integration).

This is the primary verification — the tests exercise every code path
including the warning, the empty-string fallback, the try/catch degradation,
and the ANSI stripping. If all 12 pass, the fix is correct.

---

## Step 3 — Manual E2E: see the warning in a real terminal

This shows the warning as an end-user would see it.
Do this in a **plain terminal** (not inside a Claude Code session) to avoid
any self-disruption risk.

### 3a — Find your active profile's base URL

```bash
cat ~/.codemie/codemie-cli.config.json | grep baseUrl
```

Note the value — you'll use it below. Example: `https://codemie.lab.epam.com/code-assistant-api`

### 3b — Inject a conflicting URL into `~/.claude/settings.json`

Open `~/.claude/settings.json` in any editor and add one key:

```json
{
  "ANTHROPIC_BASE_URL": "https://a-different-url.example.com",
  ... existing keys stay as-is ...
}
```

Or with Python (no editor needed):

```bash
python3 - << 'EOF'
import json, pathlib
p = pathlib.Path.home() / '.claude' / 'settings.json'
s = json.loads(p.read_text())
s['ANTHROPIC_BASE_URL'] = 'https://a-different-url.example.com'
p.write_text(json.dumps(s, indent=2))
print("Injected. Current file:")
print(p.read_text())
EOF
```

### 3c — Write a one-file smoke test

Use `$REPO_DIR` set in Step 1 — run this in the **same shell**:

```bash
# Replace the URL below with the one you found in Step 3a
PROFILE_URL='https://codemie.lab.epam.com/code-assistant-api'

cat > /tmp/smoke.mjs << EOF
import { ClaudePluginMetadata } from '${REPO_DIR}/dist/agents/plugins/claude/claude.plugin.js';

const beforeRun = ClaudePluginMetadata.lifecycle?.beforeRun;
if (!beforeRun) { console.error('beforeRun not found'); process.exit(1); }

const env = { ...process.env, ANTHROPIC_BASE_URL: '${PROFILE_URL}' };

console.error('[smoke] Calling beforeRun — the ⚠️ warning should appear below:\n');
await beforeRun(env, {});
console.error('\n[smoke] Done.');
EOF
```

### 3d — Run the smoke test

```bash
node /tmp/smoke.mjs 2>&1
```

### Expected output

```
[smoke] Calling beforeRun — the ⚠️ warning should appear below:

⚠️  ANTHROPIC_BASE_URL override detected in ~/.claude/settings.json
────────────────────────────────────────────────────────────
  Profile URL  │ https://codemie.lab.epam.com/code-assistant-api
  Active URL   │ https://a-different-url.example.com  ← settings.json wins

  ~/.claude/settings.json ANTHROPIC_BASE_URL takes precedence
  over the profile value. Session will use the settings.json URL.

  To fix: remove ANTHROPIC_BASE_URL from ~/.claude/settings.json
────────────────────────────────────────────────────────────

[smoke] Done.
```

The warning text is printed to **stderr** (yellow), so you may need to redirect
stderr to stdout to see it in some terminals: `node /tmp/smoke.mjs 2>&1`

### 3e — Verify the no-conflict case

Change the injected URL in `~/.claude/settings.json` to **match** the profile URL
(same value as `ANTHROPIC_BASE_URL` in the env). Re-run the smoke test.
Expected: no warning, just the `[smoke] Done.` line.

---

## Step 4 — Restore `~/.claude/settings.json`

**Do this immediately after Step 3**, before opening any Claude session.

```bash
bash /tmp/restore-claude-settings.sh
```

Verify the file no longer contains `ANTHROPIC_BASE_URL`:

```bash
grep ANTHROPIC_BASE_URL ~/.claude/settings.json && echo "NOT CLEAN" || echo "Clean ✓"
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '.../claude.plugin.js'` | Run `npm run build` first; use the absolute path in the import |
| Warning not shown | Check that `ANTHROPIC_BASE_URL` in `settings.json` differs from the env value |
| Session broken / Claude not responding | Run `bash /tmp/restore-claude-settings.sh` immediately |
| `[smoke] beforeRun not found` | The build is stale; re-run `npm run build` |
| `git push fork` asks for credentials | Use the token approach: `GH_TOKEN=$(gh auth token)` then set the URL as shown in the fork setup section above |
| PR not visible on `codemie-ai/codemie-code` | Confirm you used `--repo codemie-ai/codemie-code` and `--head alex-budanov:<branch>` in the `gh pr create` command |
