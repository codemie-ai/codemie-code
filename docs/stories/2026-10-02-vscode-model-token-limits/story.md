# VS Code models get too-low token limits — Story

**Date**: 2026-10-02
**Status**: Approved
**Type**: Bug
**Ticket**: [EPMCDME-15572](https://jiraeu.epam.com/browse/EPMCDME-15572)

---

## Context

- `codemie proxy connect --vscode` creates one VS Code model entry per enabled tenant model, each with an input and an output token limit.
- Today those limits come only from a built-in table of known models, with a generic default for everything else.
- The tenant model catalog the command already reads reports the input limit for most models, but it is ignored.
- Models missing from the built-in table fall back to 128000 even when the tenant reports up to 1M.
- The output limit is not returned by the catalog yet, so it keeps coming from the table or default for now.

---

## Complexity

**Size**: S (13/36) · **Recommended flow**: sdlc-light

Small, contained change in a single repository; plan directly.

---

## Story

**As a** developer using CodeMie models in VS Code, **I want** each model's token limits to reflect what the tenant actually reports **so that** long conversations aren't summarized or truncated earlier than necessary.

---

## Background

VS Code uses the configured input limit as its prompt budget. Newer models (large-context GPT, Gemini, Claude, DeepSeek, Grok) are configured with 128000 although the tenant reports 500k–1M, so context is cut far earlier than needed. Limits should come from the tenant first, then the built-in table, then the generic defaults. The catalog input value may be the whole context window, so the resolved output limit is subtracted from it.

---

## Acceptance Criteria

- [ ] Given the tenant catalog reports an input limit for a model, when VS Code models are generated, then the input limit is that value minus the resolved output limit, even if the built-in table has a different one.
- [ ] Given the tenant catalog reports an output limit for a model, when VS Code models are generated, then that value is used as the model's output limit.
- [ ] Given the catalog has no usable input limit for a model that exists in the built-in table, when VS Code models are generated, then the table value is used.
- [ ] Given the catalog has no usable input limit for a model that is not in the table, when VS Code models are generated, then the default value is used.
- [ ] Given the catalog value for a limit is missing, zero, negative or not a number, when VS Code models are generated, then it is ignored and the next source is used.
- [ ] Given the input and output limits come from different sources, when a model is generated, then each limit is resolved independently.
- [ ] Given a tenant that reports no token limits at all, when VS Code models are generated, then results are identical to today's.
- [ ] Given the change is released, when a user reads the VS Code section of the command documentation, then it states the order: tenant catalog, built-in table, defaults.

---

## Out of Scope

- Changing the backend to return an output limit.
- Moving reasoning effort, API type or header settings out of the built-in table.
- Removing existing built-in table values.

---

## Open Questions

- None.
