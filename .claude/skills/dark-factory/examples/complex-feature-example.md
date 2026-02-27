# Example: Complex Feature — Full Autonomous Run

## Scenario

**Input:** `"Implement EPMCDME-10750"`

**Ticket Description:**
```
As a user, I want to view analytics on a dashboard with customizable widgets
so I can monitor assistant usage and performance metrics.

Acceptance Criteria:
- Dashboard page with grid layout for widgets
- Widgets: message volume chart, top assistants list, response time chart
- Data fetched from analytics API endpoints
- Fixed CSS grid layout (drag-and-drop deferred to follow-up)
- Chart library: Recharts
```

---

## Phase 1: Requirement Gathering

**Action 1** — Fetch ticket details:
```
Skill(skill="brianna", args="get ticket EPMCDME-10750 fields: description, summary")
```
→ Receives: title "Analytics dashboard with widgets", AC as above

**Action 2** — Check for duplicates:
```
Skill(skill="brianna", args="search for tickets similar to 'analytics dashboard widgets' in EPMCDME project, status: open")
```
→ No duplicates found. Proceeding.

Requirements are sufficiently clear. No blocking clarifications needed.

---

## Phase 2: Complexity Assessment

```markdown
## Complexity: Complex (Score: 13/15)
- Scope: New page + new store + 3 new widget components + route + nav link (6+ areas)
- Risk: New dependency (Recharts), no existing analytics pattern, widget state isolation
- Files affected: ~12 files (4 modified, 8 new)
→ Path: Specification first (solution-architect), then implementation
```

---

## Phase 3: Specification

### Step 3a: Invoke Solution Architect

```
Task(subagent_type="solution-architect", prompt="
  Generate implementation plan for EPMCDME-10750: Analytics Dashboard.

  Requirements:
  - Dashboard page with CSS grid layout for 3 widgets
  - Widgets: message volume chart, top assistants list, response time chart
  - Data from analytics API endpoints
  - Chart library: Recharts (to be installed)
  - No drag-and-drop, fixed layout only

  Complexity: Complex
  Affected areas: router, analytics page, 3 widget components, analytics Valtio store,
    types, constants, Layout nav link

  Constraints:
  - Follow CLAUDE.md and .codemie/guides/ standards
  - Valtio for state, Tailwind for styling, custom fetch wrapper for API
  - Each widget manages its own loading/error state
")
```

### Step 3b: Spec Review

Spec received. Checking against AC:

- ✅ Dashboard grid layout covered
- ✅ All 3 widget components specified with props interface
- ✅ Analytics store shape defined with per-endpoint fetch methods
- ✅ Recharts installation step included
- ✅ Route and nav link placement documented
- ✅ Loading/error state strategy per widget clear

No issues. Proceeding to implementation.

---

## Phase 4: Branch Creation and Implementation

**Branch creation:**
```bash
git checkout main
git pull origin main
git checkout -b EPMCDME-10750
git push -u origin EPMCDME-10750
```

**Guide consultation:**
```
Read .codemie/guides/architecture/project-architecture.md
Read .codemie/guides/patterns/state-management.md
Read .codemie/guides/development/api-integration.md
Read .codemie/guides/architecture/routing-patterns.md
Read .codemie/guides/development/performance-patterns.md
```

**Implementation order (per spec):**

1. **Install dependency:**
   ```bash
   npm install recharts
   ```

2. **Types** — `src/types/entity/analytics.ts`:
   ```ts
   export interface MessageVolumePoint { date: string; count: number; }
   export interface TopAssistant { id: string; name: string; messageCount: number; }
   export interface ResponseTimeStat { period: string; avgMs: number; }
   ```

3. **Constants** — `src/constants/analytics.ts`

4. **Store** — `src/store/analytics.ts` (Valtio, per-widget loading/error state)

5. **Widget components** — `src/pages/analytics/components/widgets/`
   - `MessageVolumeChart.tsx`
   - `TopAssistantsList.tsx`
   - `ResponseTimeChart.tsx`

6. **Page** — `src/pages/analytics/AnalyticsDashboardPage.tsx`

7. **Router** — add `/analytics` route to `src/router.tsx`

8. **Nav link** — add Analytics entry to Layout sidebar

**Incremental commits after each layer:**
```bash
git commit -m "EPMCDME-10750: Add analytics types, constants, and Valtio store

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git commit -m "EPMCDME-10750: Add MessageVolumeChart, TopAssistantsList, ResponseTimeChart widgets

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git commit -m "EPMCDME-10750: Add AnalyticsDashboardPage, route, and nav link

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Phase 5: Code Review

```
Task(subagent_type="code-reviewer", prompt="
  Review all changes for EPMCDME-10750 on branch EPMCDME-10750.
  Changed files: analytics store, 3 widget components, dashboard page, router, layout nav.
  Focus on: Valtio patterns, Recharts usage, Tailwind styling, per-widget loading state,
  TypeScript completeness, accessibility of charts.
")
```

**Review output:**
- 🔴 Critical: `MessageVolumeChart` calls API directly instead of reading from store snapshot
- 🟡 Major: Missing `aria-label` on chart containers (accessibility)
- 🟢 Minor: Unused import in `analytics.ts`

**Auto-fix critical and major issues:**
```tsx
// Fix 1: Move API call to store, read via useSnapshot in component
const snap = useSnapshot(analyticsStore);
const data = snap.messageVolume.data;

// Fix 2: Add aria-label to chart wrappers
<div aria-label='Message volume over time' role='img'>
  <LineChart ... />
</div>
```

```bash
npm run lint:fix
```

---

## Phase 6: UI Validation

```
Task(subagent_type="ui-tester", prompt="
  Verify in browser at http://localhost:5173:
  1. Navigate to /analytics — page loads without error
  2. All 3 widgets render: message volume chart, top assistants list, response time chart
  3. Each widget shows a loading state before data arrives
  4. Each widget shows data after load (no blank/broken state)
  5. Analytics link appears in sidebar navigation
  6. Charts are readable (labels, axes, data points visible)
  Do NOT post to Jira. Report pass/fail for each scenario.
")
```

**Result:**
- Scenario 1-5: ✅ Pass
- Scenario 6: ❌ Fail — axis labels not visible due to white-on-white color

**Fix applied:**
```tsx
// Override Recharts tick color to match Tailwind theme
<XAxis tick={{ fill: '#374151' }} />   // text-gray-700
<YAxis tick={{ fill: '#374151' }} />
```

**Re-run ui-tester:**
```
Task(subagent_type="ui-tester", prompt="Re-verify scenario 6 only: chart labels/axes visible.")
```
→ ✅ All scenarios pass.

---

## Phase 7: Quality Gates and MR

```bash
npm test
# ✅ All tests pass

npm run lint
# ✅ No lint errors
```

```bash
git add .
git commit -m "EPMCDME-10750: Fix chart axis colors and code review issues

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push

gh pr create --title "EPMCDME-10750: Analytics dashboard with widgets" --body "$(cat <<'EOF'
## Summary
- New /analytics route with AnalyticsDashboardPage
- 3 widgets: MessageVolumeChart, TopAssistantsList, ResponseTimeChart (Recharts)
- Analytics Valtio store with per-widget loading/error state
- Fixed CSS grid layout, sidebar nav link added

## Test Plan
- [x] Unit tests pass
- [x] Lint passes
- [x] UI validation passed (ui-tester) — all 6 scenarios verified

## Related
- Jira: EPMCDME-10750

🤖 Generated with Claude Code
EOF
)"
```

---

## Outcome

| Metric | Value |
|--------|-------|
| Files changed | 12 |
| Lines added | ~650 |
| New dependencies | 1 (recharts) |
| Spec iterations | 1 (approved on first review) |
| Code review issues | 1 critical + 1 major (auto-fixed) |
| UI validation failures | 1 (axis colors — fixed, re-verified) |
| Tests | ✅ All pass |
| Total phases | 7 (all phases) |
