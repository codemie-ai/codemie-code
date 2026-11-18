# Review facts for the final review of 252233ba...ee54d4da (inputs, not conclusions)

Evaluate independently; these are source-backed facts supplied with the spec, not a verdict. Do not suppress findings.

- Spec: Jira snapshot (EPMCDME-17385, EPMCDME-17410) and `record.md` (design, verification, limitations).
- Prior round at 16567370 (superseded, edge-case lens failed): CR-001 security sign-off, CR-002 identity-failure guessed `profile`, CR-003 17410 AC1 partial. Do not treat it as coverage of this head.
- Delta since 16567370 = commit ee54d4da: `resolveProject` catch now returns `projectSource: 'none'` (no funding declared) instead of guessing `profile`; +13-line test (red against the old fallback; `CoworkEventProducer.test.ts` 87 passed / 2 skipped).
- CR-001: attribution-header change is CRITICAL under the security guide. Security-review sign-off is an EXTERNAL pre-MERGE gate, outstanding, not fabricated. The authorized deliverable is a PR; merge is forbidden. It does not block creating the reviewable PR. Reports must distinguish PR-ready from merge-ready.
- 17410 reproducer starts a task after connecting (profile project, task with or without a folder). The funding gate is evaluated at each send (served mark + pin with a real source), so a mark written after the pin still enables funding; a fresh served session with a profile or linked-folder project declares codemie (producer/forwarder tests and the real-local-backend synthetic probe in record.md).
- Cases that do not declare funding: sessions collected before marks/pins existed and rows already stored `unknown` (history; the handoff excluded history repair; disclosed in record.md before approval); a session with no project (header-less legacy send, unchanged from baseline); an unresolved project origin (conservative). Assess whether any is a genuinely reachable defect for the current reproducer, with exact trigger and consumer result; do not treat unknown folder provenance as unknown funding, and do not require Project-Source to be fabricated.
- Backend scope: read-only; no backend change.
