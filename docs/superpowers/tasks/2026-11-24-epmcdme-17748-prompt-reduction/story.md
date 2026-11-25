# Analytics Prompt Reduction for Restricted Projects — Story

**Date**: 2026-11-24
**Status**: Approved
**Architecture review**: intent, 2026-11-24, 9d42ccff2699
**Ticket**: EPMCDME-17748

---

## Context

- On `main`, CLI analytics has no obfuscation or reduction setting. Secrets are always masked, and the hook collectors, the proxy, the local `codemie analytics` report and `analytics sync` send the prompt text (cut to 200 characters) as is. `--claude-otlp` sends tool details but not prompt text.
- On `main`, analytics also carries other free text besides the prompt: Skill/Agent tool inputs, tool responses, the AI-written session title, error messages and descriptions.
- Ticket references (`PROJ-123`) are already extracted from the raw prompt for attribution. Claude Code and Copilot CLI already identify a leading slash command. Copilot Chat and Claude Desktop Cowork do not.
- Nothing detects MR/PR numbers.
- The backend reads the prompt text to leave automatic prompts (background notifications) out of turn counts and to skip built-in commands such as `/clear` when it picks a session's first prompt.
- An earlier implementation on branch `feat/EPMCDME-17748` masked PII with typed placeholders. It will not be merged. This story starts again from `main` and uses that branch for reference only.

---

## Complexity

**Size**: XL (27/36) · **Recommended flow**: sdlc-standard (one ticket by user choice; split by dependency suggested)

At the bottom of XL, one point above L. It scored higher for being compliance-sensitive (must fail closed) and for new MR and false-positive edge cases with no test pattern on `main`. Suggested split by dependency: reduction core plus hook collectors, then proxy daemon, report, sync and setup.

---

## Story

**As a** developer working on a project whose rules forbid sharing project information, **I want** to turn on prompt reduction for analytics, globally or for one project, **so that** analytics keep only which command or skill I ran and which ticket and MR it was for, and no other project content leaves my machine.

---

## Background

EPMCDME-17748 first asked for PII (emails, IBANs and similar) to be masked in analytics. The real case is stricter. Some projects must not share any project information, and masking PII still lets the rest of the prompt and tool content through. What analytics needs from these projects is the work signal: which command or skill ran (the backend uses these names), and on which ticket and MR. This story keeps that signal and drops everything else, behind an opt-in flag.

---

## Acceptance Criteria

- [ ] AC1: Given a developer is running `codemie setup`, when they reach the analytics step, then they can turn prompt reduction on or off globally, or turn it on for the current project, and the default is off. The project choice is saved in the project's CodeMie config file (`.codemie/codemie-cli.config.json`), so it can be committed and apply to every developer on the project.
- [ ] AC2: Given reduction is on for a project and off globally, when the developer uses an agent in that project, then that project's analytics are reduced and other projects' analytics are not. Setup does not offer a project-level off while reduction is on globally. It says that the global setting applies.
- [ ] AC3: Given reduction is on, when a prompt starts with a command or skill invocation (for example `/sdlc-factory:sdlc-standard EPMCDME-123 fix the login bug` or `/review-pr !456 check auth`), then the prompt sent to analytics is the command name plus any ticket and MR references found in it (`/sdlc-factory:sdlc-standard EPMCDME-123`, `/review-pr !456`). Arguments other than those references are dropped.
- [ ] AC4: Given reduction is on, when a command, skill or agent is used (a slash command, built-in commands such as `/clear` or `/compact`, a Skill tool invocation, or an Agent tool call that launches a subagent), then its name is sent unchanged: in the prompt and in the separate command, skill and agent type fields, whether or not it is an sdlc-factory one. The description and prompt passed to a subagent are dropped.
- [ ] AC5: Given reduction is on, when a prompt has no command but mentions tickets or MRs (for example `please fix login, see EPMCDME-123 and MR !456`), then only those references are sent (`EPMCDME-123 !456`).
- [ ] AC6: Given reduction is on, when a prompt has no command, ticket or MR (for example `refactor the payment module`), then `REDACTED:PROMPT` is sent, so the prompt is still counted but carries no content.
- [ ] AC7: Given reduction is on, when the agent sends a prompt on its own (a background task notification, an agent message, a continuation prompt after a context reset), then only its leading marker is sent (for example `<task-notification>`), with nothing after it. The backend can then still leave it out of turn counts.
- [ ] AC8: Given reduction is on, when the developer types several prompts in a session, then every prompt is reduced the same way, not only the first.
- [ ] AC9: Given reduction is on, when MR or PR references appear as GitLab `!456`, GitHub `#456` or a GitLab/GitHub MR or PR URL, then each is kept as its number in the reduced prompt, and the rest of the URL is dropped.
- [ ] AC10: Given reduction is on, when any route sends or stores analytics (hook collectors for every agent, proxy, `--claude-otlp`, the local report, `analytics sync`), then only a fixed list of fields is sent as captured: metrics, event and tool type names (including MCP tool names), command, skill and agent type names, ticket attribution fields, the repository name and the git remote. The git branch is cut down to the ticket keys it contains (`REDACTED:BRANCH` if none). Every other string field is dropped or replaced with `REDACTED:<FIELD>` (for example `REDACTED:TOOL-INPUT`). This includes tool inputs and responses, file paths, transcript paths, the session title, error messages, descriptions, and any field added later.
- [ ] AC11: Given reduction is on, when the developer runs the local `codemie analytics` report, then it is reduced by default, both on screen and in any file written with `--output`, so a shared report carries no project content.
- [ ] AC12: Given reduction is on, when the developer runs `codemie analytics --unreduced`, then the local report, on screen and in `--output` files, shows full prompts and fields from the session files on their machine. Nothing is sent anywhere, and the flag stays on for every other route.
- [ ] AC13 (negative): Given reduction is on, when the developer runs `codemie analytics sync`, then the data is always reduced, and there is no option that sends unreduced data.
- [ ] AC14: Given reduction is on, when the session is attributed to a ticket, then attribution works exactly as with reduction off, because it is computed from the raw prompt and raw branch before reduction.
- [ ] AC15 (negative): Given reduction is on, when reducing a field fails, then that field is sent as `REDACTED:FAILED`, never raw, the record's metrics are still sent, and the failure is logged locally without content.
- [ ] AC16 (negative): Given reduction is on, when a prompt only looks like a command or reference (a path such as `/usr/bin/node` mid-sentence, `#fff`, a heading `# Plan`, `v1.2.3`), then it is not kept as a command, ticket or MR. A prompt that does not start with a command keeps no command name.
- [ ] AC17: Given reduction is off, when prompts are captured, then analytics output is exactly what it is on `main` today.

---

## Out of Scope

- NG1: Reading a CodeMie (backend) project setting from the CLI. This needs the backend to expose the setting first and will be a follow-up story.
- NG2: PII masking with typed placeholders (`[REDACTED:EMAIL]` and others). This replaces the original request and will not be built.
- NG3: Backend-side reduction or changes to how the backend stores or shows prompts.
- NG4: Reducing analytics data already stored, synced or spooled before the flag was turned on.
- NG5: Changing secret masking when reduction is off.

---

## Decisions

- D1: What is sent besides the reduced prompt when the flag is on? → Only a fixed keep-list: metrics, event and tool type names (MCP names included), command, skill and agent type names, ticket fields, the repository name and the git remote. Everything else is dropped or replaced, including fields added later. The repository name and remote are kept because the backend uses them for project routing (matching against registered repositories) and for factory attribution per repository. — user (revised after architecture review AR-1)
- D2: What happens to the PII masking built on `feat/EPMCDME-17748`? → It is removed. The feature is rebuilt from `main` as reduction only, and that branch is not used. — user
- D3: Should the CLI read a CodeMie backend project setting? → No. Only the CLI flag set in `codemie setup`, global or per project. The backend setting is a follow-up. — user
- D4: What does the reduced prompt look like? → Command name plus ticket and MR references. A prompt with nothing to keep becomes `REDACTED:PROMPT`. — user
- D5: Which routes and agents are covered? → Every analytics route and every agent that sends prompt text, including Copilot Chat and Cowork. — proposed by PO: the point of the flag is that nothing leaves, so one uncovered route breaks it (technical analysis §2)
- D6: Are command and skill names redacted? → No. Every command and skill name is sent as is, sdlc-factory or not, because the backend uses them. Only their arguments are reduced. `REDACTED:COMMAND-USAGE` is dropped. — user (second PO request, 2026-11-24; replaces the original request to redact non-sdlc-factory commands)
- D7: Is the git branch name kept? → Only its ticket keys (`REDACTED:BRANCH` if there are none). Attribution reads the raw branch before reduction. — user (architecture review AR-1)
- D8: Which setting wins? → Reduction is on if either the global or the project setting is on. A project cannot turn it off. — proposed by PO: carried over from the approved earlier design, and the safe direction for restricted projects
- D14: Are agent type names kept? → Yes. The subagent and agent type of every Agent call is sent unchanged, sdlc-factory or not, because the backend attributes agent calls and rolls up token usage by them. The description and prompt passed to the subagent are dropped. — user
- D15: How can a developer see their full data locally while the flag is on? → With `codemie analytics --unreduced`, which applies only to the local report (screen and `--output`). It reads local session files and sends nothing. `analytics sync` has no such option. By default the local report is reduced, so files that get shared are safe. — user
- D9: How is GitHub `#456` told apart from a GitHub issue reference? → It is kept either way. Both are only numbers and carry no project content. — proposed by PO: removes the need for tracker detection in this story
- D10: Where is the project-level choice saved, and can a project turn reduction off? → In the project's `.codemie/codemie-cli.config.json`. Only "on" is offered at project level. — proposed by PO: architecture review (AR-4, AR-5)
- D11: What exactly are the placeholders? → `REDACTED:<KIND>` without brackets (`REDACTED:PROMPT`, `REDACTED:FAILED`, `REDACTED:<FIELD>`), so backend filters can rely on fixed values. — proposed by PO: architecture review
- D12: How are automatic prompts sent? → As their bare leading marker only, so turn counts stay correct without a backend change. — user (architecture review AR-2)
- D13: Is only the first prompt reduced? → No. Every prompt in the session is reduced. — user

---

## Open Questions

- None
