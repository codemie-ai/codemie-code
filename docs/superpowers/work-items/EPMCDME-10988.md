# Work Item: EPMCDME-10988

**Type**: Bug
**Status**: Ready for dev
**Assignee**: Aleksandr Budanov
**External Ticket**: EPMCDME-10988 (Jira EPM-CDME)
**External Sync**: synced

## Summary

codemie-code does not check for environment variable overrides caused by `~/.claude/settings.json`; no warning/error issued for config mismatch.

## Description

When `~/.claude/settings.json` contains an `ANTHROPIC_BASE_URL` key, that setting takes precedence over any environment variables set by codemie-code runtime profiles. codemie-code does not detect or report this override — it continues to display the profile's backend URL while the session silently uses the `settings.json` value. This causes invisible misconfiguration and session failures.

## Acceptance Criteria

- codemie-code inspects `~/.claude/settings.json` at startup and detects if `ANTHROPIC_BASE_URL` there will override the env var.
- If override is detected, a clear warning or error is printed before the session starts.
- The CLI displays the actual endpoint/model being used.
- Documentation updated regarding config file/env var precedence.
- Tests updated to cover the override scenario and expected warnings/errors.

## Linked Artifacts

- `docs/superpowers/runs/20260715-1402-EPMCDME-10988/requirements.md`

## History

| When | Event | Detail |
|---|---|---|
| 2026-07-15T14:02:00Z | work_item.created | SDLC run 20260715-1402-EPMCDME-10988 initialized |
| 2026-07-15T14:02:00Z | work_item.adapter_receipt | Jira lookup succeeded — summary, description, AC retrieved |
