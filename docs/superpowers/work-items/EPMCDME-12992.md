# Work Item: EPMCDME-12992

**External Ticket**: https://jiraeu.epam.com/browse/EPMCDME-12992  
**Type**: Bug | **Priority**: Critical  
**Status**: In Progress  
**Assignee**: Sviatoslav Likhtarchyk  
**Epic**: EPMCDME-347  
**Labels**: analytics, claude, codemie-cli, codemie_feedback, codemie_implemented, data-leakage, security  
**Component**: CodeMie Backend

## Summary
CodeMie imports unrelated Claude Code sessions from .claude/projects causing potential data leakage

## Description
CodeMie does not reliably distinguish between Claude Code sessions belonging to CodeMie and sessions created outside of CodeMie. Users who run regular Claude sessions and then connect via CodeMie SSO see unrelated sessions in CodeMie Analytics and history.

**Security Risk**: `codemie-claude --resume <session-id>` can ingest a non-CodeMie session into CodeMie datasets, potentially exposing customer code and conversation history.

## Acceptance Criteria
- [ ] CodeMie does not ingest Claude Code sessions created outside CodeMie
- [ ] CodeMie Analytics shows only CodeMie-associated Claude sessions
- [ ] `codemie-claude --resume <session-id>` validates session ownership/origin before syncing data
- [ ] Non-CodeMie sessions are blocked from syncing or require explicit safe handling that does not upload data
- [ ] `.claude/projects` parsing is restricted to CodeMie-owned sessions only
- [ ] Existing unrelated test data can be removed from affected user's CodeMie account history/analytics
- [ ] Regression tests cover: CodeMie-created sessions sync, external sessions ignored, external resumed sessions not uploaded, Analytics shows no non-CodeMie sessions
- [ ] Security review confirms customer/private Claude session data cannot be accidentally ingested into CodeMie

## Linked Artifacts
- docs/superpowers/runs/20260630-1451-main/requirements.md

## History
| Timestamp | Event | Actor | Note |
|-----------|-------|-------|------|
| 2026-06-30T14:51:00Z | work_item.created | requirements-intake | Created from EPMCDME-12992 via brianna adapter |
| 2026-06-30T14:51:00Z | work_item.adapter_receipt | requirements-intake | Jira ticket resolved successfully via brianna |
| 2026-06-30T14:51:00Z | work_item.linked_artifact | requirements-intake | Linked requirements.md |
