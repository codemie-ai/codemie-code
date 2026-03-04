---
# ✅ GOOD SKILL EXAMPLE
# Score: ~30/32 pts (Grade A)
# What makes it good: See inline comments marked ✅
#
# ✅ S1.1: Named SKILL.md in skills/ directory
# ✅ S1.2: name is [a-z0-9-]+ pattern
# ✅ S1.3: Description >20 chars, third-person, specific triggers
# ✅ S1.4: allowed-tools explicitly specified
# ✅ S2.1: Step-by-step methodology
# ✅ S2.2: Output format section defined
# ✅ S2.3: Concrete examples provided
# ✅ S2.4: Actionable checklists present
# ✅ S3.1: No absolute paths
# ✅ S3.2: No secrets
# ✅ S4.1: Single focused purpose
# ✅ S4.2: "When to use" section present
#
# ⚠️ Minor gap: S3.4 — no dependencies section (would add 1 pt)
---
name: commit-helper
description: This skill should be used when the user asks to "commit my changes",
  "create a conventional commit", "write a commit message", "stage and commit files",
  or wants to follow conventional commits format. Guides through staged file review,
  semantic commit message generation, and commit creation with pre-commit validation.
allowed-tools: [Read, Bash, Glob]
version: 1.0.0

---

# Commit Helper

Guides staged commit creation following the Conventional Commits specification.
Generates semantic commit messages based on diff analysis and confirms before committing.

## When to Use

Use this skill when:
- User has staged changes and wants a commit message
- User wants to follow conventional commits format automatically
- User needs to review staged changes before committing
- User says "commit", "create a commit", "stage and commit"

Do NOT use this skill for:
- Pushing to remote (that's a separate action requiring user confirmation)
- Creating pull requests (use `pr-creator` skill)
- Branch management operations

## Methodology

### Step 1: Review Staged Changes

1. Run `git status` to list staged and unstaged files
2. Run `git diff --cached` to review the full staged diff
3. If no files staged: warn user and exit — do not commit unstaged work

### Step 2: Determine Commit Type

Map changes to conventional commit types:

| Type | When to use |
|------|-------------|
| `feat` | New feature or behavior added |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds feature |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Build process, tooling, dependencies |
| `ci` | CI/CD pipeline changes |
| `perf` | Performance improvement |

### Step 3: Generate Commit Message

Format:
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Checklist:
- [ ] Type is lowercase and from the table above
- [ ] Scope is the module, component, or area affected
- [ ] Description is imperative mood ("add" not "added"), lowercase, <72 chars, no period
- [ ] Body explains WHY (not WHAT — the diff shows WHAT)
- [ ] Breaking changes use `feat!:` or `fix!:` and include `BREAKING CHANGE:` footer

### Step 4: Confirm and Commit

Show the proposed commit for user approval:
```
Staged files:
  modified: src/auth/login.ts
  modified: src/auth/token.ts

Proposed commit:
  fix(auth): refresh OAuth token before expiry on 401 response

  Tokens were silently expiring mid-session causing user logout.
  Refresh is now triggered proactively when token age > 80% of TTL.

Commit? [y/n/edit]
```

- [ ] User confirmed `y` before running `git commit`
- [ ] If user says `edit`: re-prompt for message
- [ ] Never use `--no-verify` unless user explicitly requests it

## Output Format

```
Staged: [list of files]

Proposed message:
  [type(scope): description]

  [body if needed]

✓ Committed: [hash] [message]
```

## Error Handling

| Situation | Action |
|-----------|--------|
| No staged files | Print: "No staged files. Use `git add` first." Exit. |
| User cancels | Print: "Commit cancelled." Exit cleanly. |
| Pre-commit hook fails | Print hook output, do NOT retry, suggest fixing the issue |
| `git commit` fails | Show error message, do not suppress it |

## Examples

```bash
# User: "commit my changes"
→ Run git status + diff, generate message, show for confirmation

# User: "commit the auth fix as a hotfix"
→ Use type=fix, analyze staged auth files, generate message

# User: "commit with message 'update readme'"
→ Use user's message, format to conventional commits if needed
```
