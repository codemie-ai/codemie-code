# Workflow Patterns Guide

## Quick Summary

CodeMie Code ships workflow management for CI/CD templates and agent-driven automation. Workflow commands stay in the CLI layer and delegate template discovery, installation, and detection to `src/workflows/`.

**Category**: Workflows
**Complexity**: Medium
**Prerequisites**: Commander, GitHub Actions, GitLab CI, YAML

---

## Workflow Surface Map

| Surface | Role | Evidence |
|---|---|---|
| `codemie workflow` command | User-facing workflow management | `src/cli/commands/workflow.ts:23` |
| Workflow detector | VCS provider and workflow directory detection | `src/workflows/detector.ts:18` |
| GitHub templates | Installed workflow templates | `src/workflows/templates/github/metadata.ts:18` |
| CI workflow | Repository validation workflow | `.github/workflows/ci.yml:8` |
| Publish workflow | Manual publish workflow | `.github/workflows/publish.yml:4` |

---

## CLI Workflow Command

### Rule

Keep workflow command parsing in `src/cli/commands/workflow.ts`; delegate file detection, template lookup, install, and uninstall work to `src/workflows/`.

| Subcommand | Practice | Evidence |
|---|---|---|
| `list` | Filter by provider and installed state | `src/cli/commands/workflow.ts:55`, `src/cli/commands/workflow.ts:68` |
| `install` | Resolve provider, get template, build install options | `src/cli/commands/workflow.ts:150`, `src/cli/commands/workflow.ts:178` |
| `uninstall` | Resolve provider and remove installed workflow | `src/cli/commands/workflow.ts:378`, `src/cli/commands/workflow.ts:390` |

### Anti-Patterns

| Avoid | Prefer |
|---|---|
| Writing workflow files directly in command parsing branches | Use workflow installer helpers |
| Assuming GitHub only | Detect or force provider with options |
| Hiding required secrets | Surface template requirements in command output |
| Skipping dry-run paths for destructive workflow changes | Preserve preview behavior |

---

## Provider Detection

### Rule

The workflow detector maps repository remotes to GitHub or GitLab and derives provider-specific workflow directories.

| Concern | Evidence |
|---|---|
| Initial detection result shape | `src/workflows/detector.ts:18` |
| GitHub remote detection | `src/workflows/detector.ts:44` |
| GitLab remote detection | `src/workflows/detector.ts:47` |
| Workflow directory resolution | `src/workflows/detector.ts:61` |
| Directory existence check | `src/workflows/detector.ts:71` |
| Directory creation | `src/workflows/detector.ts:79` |

### Practice

| Avoid | Prefer |
|---|---|
| Inferring provider from local folder names only | Use remote detection plus explicit `--github` or `--gitlab` overrides |
| Hardcoding `.github/workflows` outside detector utilities | Use `getWorkflowDir()` |
| Treating missing workflow directory as fatal for install | Use `ensureWorkflowDir()` |

---

## Template Metadata

### Rule

Workflow templates are represented by metadata objects that name provider, template file, triggers, permissions, and required secrets.

| Template Concern | Evidence |
|---|---|
| GitHub template metadata array | `src/workflows/templates/github/metadata.ts:18` |
| Template file path resolution | `src/workflows/templates/github/metadata.ts:12` |
| Workflow trigger metadata | `src/workflows/templates/github/metadata.ts:31` |
| Workflow dispatch support | `src/workflows/templates/github/metadata.ts:93` |

### Practice

| Avoid | Prefer |
|---|---|
| Installing templates with hidden assumptions | Put configuration in metadata |
| Duplicating template IDs across providers without care | Include provider in lookup |
| Embedding generated YAML in TypeScript strings | Keep YAML templates under `src/workflows/templates/` |

---

## GitHub Workflow Template Rules

### Rule

GitHub templates are package assets and should remain deterministic YAML. Template changes must preserve secret references, permissions, and trigger logic.

| Concern | Evidence |
|---|---|
| Code CI template includes allowed tools | `src/workflows/templates/github/code-ci.yml:241` |
| Inline fix template includes mention filtering | `src/workflows/templates/github/inline-fix.yml:26` |
| Inline fix concurrency group | `src/workflows/templates/github/inline-fix.yml:12` |
| GitHub script dependency pinning | `src/workflows/templates/github/inline-fix.yml:60` |

### Anti-Patterns

| Avoid | Prefer |
|---|---|
| Broad tool permissions by default | Keep allowed tools explicit |
| Running inline fix for review triggers that belong to review workflow | Preserve mention filtering |
| Omitting concurrency controls | Keep workflow concurrency groups |
| Unpinned third-party actions | Use pinned or versioned action refs |

---

## Repository CI Workflow

### Rule

The repository’s own CI enforces commit format, PR title format, secret scanning, license checks, lint, build, and package verification.

| Gate | Evidence |
|---|---|
| Commitlint on PR commits | `.github/workflows/ci.yml:37` |
| PR title commitlint | `.github/workflows/ci.yml:66` |
| Secret scanning through Gitleaks action | `.github/workflows/ci.yml:104` |
| License check | `.github/workflows/ci.yml:133`, `package.json:47` |
| CI script composition | `package.json:48` |

### Practice

| Avoid | Prefer |
|---|---|
| Adding local-only checks without CI equivalent | Wire important checks into CI |
| Changing commit rules without updating docs | Keep `commitlint.config.cjs` and guide text aligned |
| Logging secrets in CI scripts | Use secret scanning and sanitizers |

---

## Workflow Installation Flow

### Rule

Workflow installation should gather provider, template, and user options before writing files.

| Step | Practice | Evidence |
|---|---|---|
| 1 | Determine provider from flags or detector | `src/cli/commands/workflow.ts:194` |
| 2 | Resolve template by workflow id and provider | `src/cli/commands/workflow.ts:211` |
| 3 | Build install options | `src/cli/commands/workflow.ts:261` |
| 4 | Prompt for interactive settings if requested | `src/cli/commands/workflow.ts:268` |
| 5 | Call installer | `src/cli/commands/workflow.ts:345` |
| 6 | Print next steps and required secrets | `src/cli/commands/workflow.ts:363` |

---

## Installed Workflow Detection

### Rule

Provider-specific installed workflow detection belongs in detector utilities, not command handlers.

| Provider | Detection | Evidence |
|---|---|---|
| GitHub | List `.yml` and `.yaml` in workflow dir | `src/workflows/detector.ts:99` |
| GitLab | Check `.gitlab-ci.yml` | `src/workflows/detector.ts:105` |
| Specific workflow | Look for `codemie-<workflow-id>` | `src/workflows/detector.ts:114`, `src/workflows/detector.ts:123` |

---

## Session Workflow Processing

### Rule

Agent session workflows use processors with priorities rather than direct one-off uploads.

| Concern | Evidence |
|---|---|
| Session processor contract | `src/agents/core/session/BaseProcessor.ts:73` |
| Gemini processor registration | `src/agents/plugins/gemini/gemini.session-adapter.ts:97` |
| Codex processor registration | `src/agents/plugins/codex/codex.session.ts:53` |
| Shared SessionSyncer | `src/providers/plugins/sso/session/SessionSyncer.ts:4` |

### Practice

| Avoid | Prefer |
|---|---|
| Uploading session data inline in every hook | Route through `SessionSyncer` |
| Giving processors hidden order dependencies | Use explicit processor priority |
| Ignoring partial processor failures | Return aggregated processor results |

---

## Quick Reference

| Need | Location |
|---|---|
| Workflow CLI | `src/cli/commands/workflow.ts` |
| Provider detection | `src/workflows/detector.ts` |
| Workflow exports | `src/workflows/index.ts` |
| GitHub templates | `src/workflows/templates/github/` |
| Template metadata | `src/workflows/templates/github/metadata.ts` |
| Repo CI | `.github/workflows/ci.yml` |
| Publish workflow | `.github/workflows/publish.yml` |

---

## Delivery Checklist

| Check | Reason |
|---|---|
| Provider handling supports GitHub/GitLab paths | Avoids GitHub-only assumptions |
| Template metadata and YAML stay aligned | Keeps installer output correct |
| Required secrets are visible to users | Prevents broken installed workflows |
| Generated workflow files are deterministic | Reduces noisy diffs |
| CI gate docs match `package.json` scripts | Keeps agent instructions reliable |

---
