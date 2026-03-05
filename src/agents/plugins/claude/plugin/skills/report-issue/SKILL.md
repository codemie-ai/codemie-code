---
name: report-issue
description: >-
  This skill should be used when the user wants to report a bug, file an issue, or suggest a
  feature for the CodeMie Code CLI tool (codemie-ai/codemie-code repository on GitHub).
  Trigger phrases include: "report a bug", "open an issue", "submit an issue", "file a bug
  report", "something is broken in CodeMie", "report to GitHub", "create a GitHub issue",
  "suggest a feature for CodeMie", "request an enhancement", "I have a feature idea",
  "codemie is not working", or any mention of filing a report for CodeMie. This skill
  automatically collects diagnostic context (OS, Node.js, CLI version, installed agents,
  active profile, codemie doctor output, recent debug logs) and creates a structured GitHub
  issue via `gh issue create` with a user-confirmed preview step before submission.
---

# Report Issue to CodeMie Code

Help the user file a well-structured bug report or feature request to [codemie-ai/codemie-code](https://github.com/codemie-ai/codemie-code) on GitHub.

The goal is to create a rich issue that gives maintainers everything they need to triage and reproduce the problem — without requiring the user to manually gather technical details.

---

## Step 1: Pre-flight and Diagnostic Collection

### 1a. Check `gh` CLI first — do this before anything else

```bash
if ! command -v gh &>/dev/null; then
  echo "GH_NOT_INSTALLED"
else
  gh auth status 2>&1 || echo "GH_NOT_AUTHENTICATED"
fi
```

**If `GH_NOT_INSTALLED`:** Stop immediately and tell the user:

> "`gh` (GitHub CLI) is not installed. It is required to create issues from the terminal.
>
> Install it with one of:
> - **macOS**: `brew install gh`
> - **Linux (apt)**: `sudo apt install gh`
> - **Linux (dnf)**: `sudo dnf install gh`
> - **Windows**: `winget install --id GitHub.cli`
> - Or download from: https://cli.github.com
>
> After installing, run `gh auth login` to connect your GitHub account, then try this skill again."

**If `GH_NOT_AUTHENTICATED`:** Stop and tell the user:

> "`gh` is installed but not authenticated. Run `gh auth login` to connect to your GitHub account, then try again."

Do not proceed past this point until `gh` is installed and authenticated.

### 1b. Gather diagnostic context

Run the following and capture results. Don't display raw output yet.

```bash
# OS + platform
uname -srm 2>/dev/null || echo "unknown"

# Node.js version
node --version 2>/dev/null || echo "not found"

# npm version
npm --version 2>/dev/null || echo "not found"

# CodeMie CLI version
codemie --version 2>/dev/null || echo "not found"

# Installed agents and versions
codemie list --installed 2>/dev/null || echo "unavailable"

# Full doctor output (profile, provider, dependency health, agent versions)
codemie doctor 2>/dev/null || echo "unavailable"

# Shell + terminal environment
echo "Shell: $SHELL"
echo "Terminal: ${TERM_PROGRAM:-unknown}"

# Extract ERROR and WARN lines from the two most recent log files.
# Log format: [TIMESTAMP] [LEVEL] [agent] [session-id] [profile] [component] message
# Files: ~/.codemie/logs/debug-YYYY-MM-DD.log (one per day, can be several MB)
LOG_DIR="$HOME/.codemie/logs"
RECENT_LOGS=$(ls -t "$LOG_DIR"/debug-*.log 2>/dev/null | head -2)
if [ -n "$RECENT_LOGS" ]; then
  echo "=== ERROR and WARN entries from recent logs ==="
  # Print filename headers and filter by level; limit to last 100 matches to keep size reasonable
  for f in $RECENT_LOGS; do
    echo "--- $f ---"
    grep -E '\[(ERROR|WARN)\]' "$f" | tail -50
  done
  echo "=== Full log files ==="
  for f in $RECENT_LOGS; do
    echo "$f"
  done
else
  echo "No debug logs found"
fi
```

**Log file paths** (captured above) will be used in Step 6 to upload as Gist.

---

## Step 2: Understand the Issue

**Extraction-first:** If the user already described the issue in their request (problem, error message, steps, etc.), extract that information directly without asking them to repeat it. Only ask follow-up questions for missing pieces.

If no description was provided yet, ask the user for:
1. **Issue type**: Bug report, feature request, or question?
2. **Title**: A short, specific summary (one line)
3. **Description**: What happened, what they expected, and any reproduction steps

When prompting for description, share these tips:
- Include the exact command that triggered the problem
- Paste the exact error message verbatim (not paraphrased)
- Note whether it happens every time or intermittently
- For feature requests: describe the use case and the expected behavior

---

## Step 3: Classify the Issue

Determine the issue type based on the user's description:
- **Bug report** — unexpected error, crash, wrong output → label: `bug`
- **Feature request** — missing capability, enhancement ask → label: `enhancement`
- **Question / unclear behavior** — seeking clarification → label: `question`

---

## Step 4: Compose the Issue Body

Build the issue body using the appropriate template below.

**Security — before embedding diagnostic output:**
- Scan for and redact full API keys, tokens, or passwords (show only first 4 chars + `***`)
- The masked format `proxy-ha***dled` already used by `codemie doctor` is safe to include as-is
- Remove any personal access tokens or private credential URLs

### Template: Bug Report

~~~markdown
## Description

<user's description of the problem>

## Steps to Reproduce

1.
2.
3.

## Expected Behavior

<what the user expected to happen>

## Actual Behavior

<what actually happened — paste error messages verbatim>

## Environment

| Field       | Value                        |
|-------------|------------------------------|
| OS          | <uname output>               |
| Node.js     | <node --version>             |
| npm         | <npm --version>              |
| CodeMie CLI | <codemie --version>          |
| Shell       | <$SHELL>                     |
| Terminal    | <$TERM_PROGRAM>              |

## Installed Agents

<formatted list from `codemie list --installed` — agent name and version per line>

## CodeMie Doctor Output

<details>
<summary>Full doctor output</summary>

<pre>
<codemie doctor output — with credentials redacted>
</pre>

</details>

## Recent Errors

<details>
<summary>ERROR and WARN entries from recent logs</summary>

<pre>
<filtered ERROR/WARN lines from the two most recent debug-YYYY-MM-DD.log files, or "No errors found">
</pre>

</details>

## Full Debug Logs

<full log file(s) attached as GitHub Gist — see link below, or "No log files found">
~~~

### Template: Feature Request

~~~markdown
## Summary

<one-sentence description of the feature>

## Motivation

<the problem this feature would solve, or the use case that is currently missing>

## Proposed Behavior

<what the user wants to happen — be specific about inputs, outputs, and commands>

## Alternatives Considered

<other ways you have worked around this, if any>

## Environment

| Field       | Value                        |
|-------------|------------------------------|
| OS          | <uname output>               |
| Node.js     | <node --version>             |
| CodeMie CLI | <codemie --version>          |

## Installed Agents

<formatted list from `codemie list --installed`>
~~~

---

## Step 5: Preview and Confirm

Show the user the proposed issue title and full body. Ask:

> "Here's the issue I'll create on GitHub. Does this look right, or would you like to change anything before I submit?"

Wait for confirmation before creating the issue.

---

## Step 6: Upload Log Files as Gist

If log files were found in Step 1b, upload the two most recent ones as a **secret Gist** so they can be referenced in the issue. This keeps the issue body readable while giving maintainers the full context.

```bash
# Upload the two most recent log files as a single secret Gist
gh gist create \
  --desc "CodeMie debug logs for issue report ($(date +%Y-%m-%d))" \
  ~/.codemie/logs/debug-$(date +%Y-%m-%d).log \
  ~/.codemie/logs/debug-$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d).log \
  2>/dev/null
```

Capture the Gist URL from the output (it looks like `https://gist.github.com/...`).

- If only one log file exists, pass just that file.
- If no log files exist, skip this step and note "No log files available" in the issue body.
- Replace the `<full log file(s) attached as GitHub Gist — see link below>` placeholder in the issue body with the actual Gist URL.

**Note:** Gists are secret (not listed publicly) but accessible to anyone with the link.

---

## Step 7: Create the GitHub Issue

```bash
gh issue create \
  --repo codemie-ai/codemie-code \
  --title "<issue title>" \
  --body "<issue body with gist URL inserted>" \
  --label "<bug|enhancement|question>"
```

---

## Step 8: Confirm and Link

After the issue is created, tell the user:
- The issue URL (from `gh issue create` output)
- They can add screenshots or additional files directly on GitHub
- Track progress at: https://github.com/codemie-ai/codemie-code/issues
