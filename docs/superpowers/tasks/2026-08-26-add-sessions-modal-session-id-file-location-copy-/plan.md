# Sessions Modal — Session ID & File Location Copy Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the analytics HTML report's Sessions details modal, show the session ID (header) and the session's native log file location (body) each with a copy-to-clipboard button.

**Architecture:** Client-only change for the session ID (already on `ReportSessionRecord`). The file location requires threading `agentSessionFile` (already present on `RawSessionData`, consumed today only by the cost enricher) through `SessionAnalytics` → `buildPayload()` → `ReportSessionRecord` → `app.js`. One reusable `copyButton()` helper (Clipboard API with `execCommand('copy')` fallback for `file://`) backs both rows.

**Tech Stack:** TypeScript + Vitest (pipeline), vanilla uncompiled browser JS (report client — no test harness introduced).

Commit per task using the repository's existing convention.

**Out of scope (owned by the calling flow, not this plan):** whole-suite quality gates (lint/build/test), browser/feature verification, code review, committing as a separate step. The task explicitly excludes feature verification — app.js changes are validated by code reading only.

---

## Acceptance criteria

- [ ] Modal header shows the session ID (escaped via `esc()`) next to the existing meta line, with a working copy button.
- [ ] Modal body shows a file-location row directly below the header (before the Cost & Time cards) with a working copy button, when the session has a resolvable log path.
- [ ] When a session has no `agentSessionFile`, the file-location row renders "Not available" text and shows **no** copy button for that row (not a disabled/broken one).
- [ ] Both copy buttons use one shared helper; each copies its own exact string (`sessionId` or the file path) and gives brief visual feedback on both success ("Copied") and failure ("Copy failed").
- [ ] The copy helper falls back to a hidden `<textarea>` + `document.execCommand('copy')` when `navigator.clipboard.writeText` is unavailable or its promise rejects (the report is typically opened via `file://`, with no server).
- [ ] `SessionAnalytics`, `ReportSessionRecord`, and `buildPayload()` carry `agentSessionFile` end-to-end: present when the underlying raw session had one, **absent** (not `null`/`''`) otherwise — verified by Vitest, not just by inspection.
- [ ] No new test framework, build tooling, or CSS file is introduced; no browser/feature-verification task exists anywhere in this plan.

## Negative-constraint pass

- "do not run feature verification" → honored: no task in this plan runs a browser/Playwright/UI check; Tasks 3–4 (app.js) are validated by code reading only (`Test-first: no`, with a reading note in lieu of a test).
- "disable/hide the copy button" when the path is missing, not an empty/broken control → Task 4's step renders the copy button only inside the `if (s.agentSessionFile)` branch; the `else` branch renders text only, no button element at all.
- Clipboard mechanism must work under `file://` → Task 3's `copyButton()` helper always has an `execCommand('copy')` fallback path, not just a `navigator.clipboard` call.
- "every interpolation through `esc()`" (XSS convention) → Tasks 3 and 4 both pass `esc(s.sessionId)` / `esc(s.agentSessionFile)` through `el()`'s `html` argument, matching the existing header/body idiom; no raw interpolation is introduced.
- Keep scope minimal / no unrelated refactors → Tasks 1–2 touch only the 4 named pipeline files with additive, optional fields; no other `ReportSessionRecord` field or view is touched.

---

### Task 1: Thread `agentSessionFile` through `SessionAnalytics`

**Files:**
- Modify: `src/cli/commands/analytics/types.ts:130-133` (add optional field to `SessionAnalytics`)
- Modify: `src/cli/commands/analytics/aggregator.ts:405-436` (populate it in `buildSessionAnalytics()`'s return object, from `raw.agentSessionFile`)
- Test: `src/cli/commands/analytics/__tests__/aggregator.test.ts`

**Test-first: yes — `aggregate()` must carry `agentSessionFile` from `RawSessionData` through to `SessionAnalytics` when present, and leave it `undefined` when absent.**

- [ ] **Step 1: Write the failing test** — add to `aggregator.test.ts` (reuses the file's existing `session()`/`delta()` factories):

```ts
it('carries agentSessionFile through from RawSessionData when present, and leaves it undefined otherwise', () => {
  const withFile = session('A', '/repo', [delta('A', 'main', 0)]);
  withFile.agentSessionFile = '/logs/a.jsonl';
  const withoutFile = session('B', '/repo', [delta('B', 'main', 0)]);

  const root = AnalyticsAggregator.aggregate([withFile, withoutFile]);
  const sessions = root.projects[0].branches[0].sessions;
  expect(sessions.find((s) => s.sessionId === 'A')?.agentSessionFile).toBe('/logs/a.jsonl');
  expect(sessions.find((s) => s.sessionId === 'B')?.agentSessionFile).toBeUndefined();
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/cli/commands/analytics/__tests__/aggregator.test.ts` → FAILs (`agentSessionFile` not on the result).
- [ ] **Step 3: Implement** — in `types.ts`, after `costUSD?: number;` (line 132) add `agentSessionFile?: string; // native log path used for cost pricing; absent when none resolved`. In `aggregator.ts`, in the return object at lines 405-436, add `agentSessionFile: raw.agentSessionFile,` alongside the other `raw.*`-sourced fields.
- [ ] **Step 4: Run it again** — same command → PASSes.
- [ ] **Step 5: Commit.**

---

### Task 2: Thread `agentSessionFile` through `ReportSessionRecord` / `buildPayload()`

**Files:**
- Modify: `src/cli/commands/analytics/report/types.ts:43-58` (add optional field to `ReportSessionRecord`, next to `hadLog`)
- Modify: `src/cli/commands/analytics/report/payload-builder.ts:103-112` (add conditional spread, matching the existing `usagePartial`/`premiumRequests` idiom)
- Test: `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`

**Test-first: yes — `buildPayload()` must include `agentSessionFile` on the built record when present on the session, and omit it (not just `undefined`-valued) when absent.**

- [ ] **Step 1: Write the failing test** — add to `payload-builder.test.ts` (reuses the file's existing `singleBranchRoot()`/`session()`/`costIndex`/`summary` fixtures):

```ts
it('threads agentSessionFile onto the record when present, and omits it when absent', () => {
  const withFile = singleBranchRoot([session({ agentSessionFile: '/logs/a.jsonl' })]);
  const ctx = { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' };
  expect(buildPayload(withFile, costIndex, summary, ctx).sessions[0].agentSessionFile).toBe('/logs/a.jsonl');

  const noFile = buildPayload(root, costIndex, summary, ctx);
  expect('agentSessionFile' in noFile.sessions[0]).toBe(false);
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` → FAILs.
- [ ] **Step 3: Implement** — in `report/types.ts`, after `hadLog: boolean;` (line 43) add `agentSessionFile?: string; // native log path; absent when none was resolved for this session`. In `payload-builder.ts`, inside the `sessions.push({...})` object (near line 103, alongside `hadLog: cost?.hadLog ?? false,`), add `...(s.agentSessionFile ? { agentSessionFile: s.agentSessionFile } : {}),`.
- [ ] **Step 4: Run it again** → PASSes.
- [ ] **Step 5: Commit.**

---

### Task 3: Session ID + copy button in the modal header

**Files:**
- Modify: `src/cli/commands/analytics/report/client/app.js` — add a `copyButton()`/`fallbackCopy()` helper pair near `el()` (~line 250, before `card()`); add a session-ID row in `openSessionModal()`'s header, after the existing `metaBits` line (`app.js:1100-1103`)

**Test-first: no — `app.js` is plain, uncompiled browser JS with zero test coverage; no test framework is introduced for it. Validation: read the diff and confirm `idRow` is appended once per `htxt` block using the existing `el()`/`esc()` idiom, and that `copyButton()`'s click handler closes over `s.sessionId` (not a stale value).**

- [ ] **Step 1: Add the shared copy-button helper**, right after `el()`'s definition (`app.js:250`):

```js
// ---- copy-to-clipboard helper -------------------------------------------
// getText(): () => string|undefined. label: base button text. Falls back to a
// hidden textarea + execCommand('copy') when the Clipboard API is unavailable
// or its promise rejects (reports are typically opened via file://, no server).
function copyButton(getText, label) {
  var btn = el('button', 'modal-copy', esc(label));
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', function () {
    var text = getText();
    if (!text) return;
    var show = function (ok) {
      var prev = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = prev; btn.disabled = false; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { show(true); }, function () { fallbackCopy(text, show); });
    } else {
      fallbackCopy(text, show);
    }
  });
  return btn;
}
function fallbackCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  done(ok);
}
```

- [ ] **Step 2: Add the session-ID row** — insert immediately after `app.js:1102` (`htxt.appendChild(el('div', 'modal-meta', metaBits...))`), before `head.appendChild(htxt);`:

```js
var idRow = el('div', 'modal-meta');
idRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';
idRow.appendChild(el('span', '', 'ID: ' + esc(s.sessionId)));
idRow.appendChild(copyButton(function () { return s.sessionId; }, 'Copy ID'));
htxt.appendChild(idRow);
```

- [ ] **Step 3: Validate by reading** — confirm the row renders for every session (sessionId is always present, unlike the file path), the button label reverts after the `setTimeout`, and no other call site of `openSessionModal()` (e.g. the project-sessions modal's "Back" flow) is affected since this only adds to the existing `htxt` block.
- [ ] **Step 4: Commit.**

---

### Task 4: File location + copy button in the modal body

**Files:**
- Modify: `src/cli/commands/analytics/report/client/app.js` — add a file-location row in `openSessionModal()`'s body, immediately after `var body = el('div', 'modal-body');` (`app.js:1124`), before the `grid3` cards.

**Test-first: no — same rationale as Task 3 (no test harness for `app.js`). Validation: read the diff and confirm the copy button element is only created inside the `if (s.agentSessionFile)` branch — the `else` branch must contain no button.**

- [ ] **Step 1: Add the file-location row**, reusing `copyButton()` from Task 3:

```js
var fileRow = el('div', 'text-muted');
fileRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:12px;';
if (s.agentSessionFile) {
  fileRow.appendChild(el('span', '', 'File: ' + esc(s.agentSessionFile)));
  fileRow.appendChild(copyButton(function () { return s.agentSessionFile; }, 'Copy path'));
} else {
  fileRow.appendChild(el('span', '', 'File: Not available'));
}
body.appendChild(fileRow);
```

- [ ] **Step 2: Validate by reading** — confirm this is the first child appended to `body` (so it renders directly below the header, above the Cost & Time / Token usage / Activity cards), the missing-path branch renders text only (no button, matching the `hadLog`/`usageUnavailableReason` empty-state convention already used lower in this same modal), and `s.agentSessionFile` flows correctly from Task 2's `ReportSessionRecord` field.
- [ ] **Step 3: Commit.**
