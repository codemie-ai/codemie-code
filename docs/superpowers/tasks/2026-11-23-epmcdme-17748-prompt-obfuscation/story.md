---
schema_version: 1
id: prompt-obfuscation-cli
parent: analytics-prompt-obfuscation
repository: codemie-code
depends_on: []
---
# CLI Analytics Prompt Obfuscation and Multi-Tracker Attribution — Story

**Date**: 2026-11-20
**Status**: Approved
**Ticket**: —
**Parent**: ../../story.md
**Feature**: prompt-obfuscation

---

## Context

- The CLI already masks secrets in analytics, always on and secrets-only. That masking is spread across the hook-collector base, the `--claude-otlp` proxy JSON path and copies in individual collectors.
- The `--claude-otlp` protobuf path is forwarded unmasked. The local `codemie analytics` report keeps the full first prompt as the session title unless `--redact` is passed.
- The CLI masks first, then cuts prompts to 200 characters and tool fields to 300.
- Ticket attribution is computed from the raw prompt before masking, but only Jira-style keys (`PROJ-123`) are recognised. This is verified for the Claude Code collector only.

---

## Complexity

**Size**: XL (27/36) · **Recommended flow**: flagged for manual re-split

Scored split-required (bottom of the XL band): new obfuscation layer across every CLI analytics route including protobuf, plus multi-tracker attribution in the parser and story resolver. Suggested re-split: tracker attribution → obfuscation core → route wiring.

---

## Story

**As a** developer using CodeMie CLI analytics in an organisation with data-protection rules, **I want** to turn on obfuscation of sensitive data in everything the CLI sends or stores for analytics, globally or per project, and have my Azure DevOps and GitHub/GitLab ticket references attributed like Jira ones, **so that** analytics carry no personal or secret data and my work is still credited to the right ticket.

---

## Background

Personal data in prompts and tool output (emails, phone numbers, IP addresses, card and bank numbers) reaches analytics today. Only secrets are masked, and not on every route. Teams on Azure DevOps or GitHub/GitLab also get no ticket attribution at all. This story gives the CLI one obfuscation layer for every analytics route, an opt-in setting, and attribution for non-Jira trackers. It also defines the rules and sample set the backend will copy.

---

## Acceptance Criteria

- [ ] AC1: Given a developer is setting up analytics locally, when they reach the obfuscation step, then they can turn prompt obfuscation on or off and choose to save it globally or for the current project, and the default is off. *(parent AC1)*
- [ ] AC2: Given obfuscation is on for a project but off globally, when the developer uses an agent in that project, then prompts from that project are obfuscated, and prompts from other projects are not. *(parent AC2)*
- [ ] AC3: Given obfuscation is on, when a prompt or tool detail containing an email, phone number, IPv4/IPv6 address, payment card number, IBAN or a secret is captured, then every such value is replaced with a typed placeholder (e.g. `[REDACTED:EMAIL]`) in all data sent or stored by every route: hook collectors, proxy, `--claude-otlp` (JSON and protobuf), the local `codemie analytics` report and `analytics sync`. The rest stays readable. *(parent AC3)*
- [ ] AC4: Given obfuscation is on, when a prompt contains ticket references (`PROJ-123`, `AB#123`, `#123`, `org/repo#123`), then they stay unchanged in the obfuscated text, and for every hook collector the ticket fields are computed from the raw prompt before obfuscation and before truncation (tested per collector). *(parent AC4, D11)*
- [ ] AC5: Given a prompt references an Azure DevOps work item (`AB#123`) or a GitHub/GitLab issue (`#123`, `org/repo#123`), whether obfuscation is on or off, when the event is captured, then the session is attributed to that ticket with the existing priority (explicit setting, then marker, then branch, then mention). *(parent AC4a)*
- [ ] AC6 (negative): Given a bare `#123` that is not a ticket reference (a heading, `#fff`, a list number), when attribution runs, then it is not attributed unless the project's configured tracker is GitHub/GitLab or the reference uses the `AB#` or `org/repo#` form. *(parent AC4b)*
- [ ] AC7: Given obfuscation is off, when prompts are captured, then analytics output is exactly what it is today, apart from the new tracker attribution in AC5. *(parent AC5)*
- [ ] AC8 (negative): Given obfuscation is on, when obfuscating a field fails, then that field is sent as a failure placeholder (never raw), the record's metrics are still sent, and the failure is logged locally without content. The record is dropped only if the placeholder step also fails. *(parent AC6)*
- [ ] AC9 (negative): Given look-alikes that are not sensitive (`1.2.3`, `v1.2.3.4`, `ABC-1234`, `#42`), when obfuscation runs, then they are left unchanged, and a dotted four-part number without a `v` prefix is masked as an IP address. *(parent AC7, D10)*
- [ ] AC10: Given the canonical sample set of prompts with expected outputs (including trailing values cut at the 200/300 limits and already-obfuscated text), when the CLI tests run, then every sample matches its expected output byte-for-byte, and running the rules twice changes nothing. This sample set is the one the backend copies. *(parent AC10 and AC13, CLI side)*

---

## Out of Scope

- NG1: Backend obfuscation, the customer setting and backend storage (child `prompt-obfuscation-backend`).
- NG2: Whole-prompt redaction modes, and detecting names or addresses that need language understanding.
- NG3: Reading the backend customer setting from the CLI (the settings are independent).
- NG4: Changing secret masking behaviour when obfuscation is off.

---

## Decisions

Inherited from the parent: D1, D2, D3, D4, D6, D7, D9, D10, D11, D12, D15.

---

## Open Questions

- None
