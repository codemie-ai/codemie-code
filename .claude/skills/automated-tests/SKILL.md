---
name: automated-tests
description: This skill should be used when a user says "run automated tests", "run lint", "run build", "run unit tests", "check the tests", or when qa-lead invokes it as the primary quality gate. Runs the full automated test pipeline in sequence: lint → build → unit tests. Reports pass/fail for each stage with output. Invoke for any Node.js project before marking work complete.
version: 0.1.0
---

# Automated Tests: Lint + Build + Unit Tests

## Purpose

Runs the three-stage automated test pipeline for Node.js projects. Each stage must pass before the next runs. Designed to be invoked by `qa-lead` as the primary quality gate, or directly by the user.

## Pipeline

```
Stage 1: Lint
    ↓ PASS
Stage 2: Build
    ↓ PASS
Stage 3: Unit Tests
    ↓ PASS / FAIL
Report
```

---

## Stage 1: Lint

```bash
npm run lint
```

**Expected**: zero errors, zero warnings (project requires clean lint)

**If FAIL**:
- Report the lint errors
- If fixable automatically: `npm run lint:fix` then re-run `npm run lint`
- If not auto-fixable: report specific file:line violations and stop — do not proceed to Stage 2

---

## Stage 2: Build

```bash
npm run build
```

**Expected**: TypeScript compiles to `dist/` with zero errors

**If FAIL**:
- Report the TypeScript compiler errors (file, line, message)
- Stop — do not proceed to Stage 3
- Common causes: missing `.js` extensions on imports, type mismatches, missing declarations

---

## Stage 3: Unit Tests

```bash
npm test
```

**Expected**: all test suites pass, zero failures

**If FAIL**:
- Report: which suites failed, which tests failed, error messages
- Distinguish: assertion failures (logic bugs) vs. infrastructure failures (module not found, import errors)
- Stop — mark pipeline as FAILED

---

## Report Format

### All stages pass:

```markdown
## Automated Tests: PASSED ✅

- Lint:        ✅ clean
- Build:       ✅ compiled to dist/
- Unit Tests:  ✅ N suites, N tests

Pipeline complete. qa-lead may proceed to next gate.
```

### Stage fails:

```markdown
## Automated Tests: FAILED ⛔

- Lint:        ✅ clean
- Build:       ❌ FAILED
  - src/utils/errors.ts:45 — TS2339: Property 'foo' does not exist on type 'Bar'
- Unit Tests:  ⏭️ skipped

Fix the build errors above, then re-invoke automated-tests.
```

---

## Key Principles

### Do's
✅ Run stages in order: lint → build → unit tests
✅ Stop at first failure — don't run Stage 3 if Stage 2 fails
✅ Report specific file:line errors, not just "build failed"
✅ Try `npm run lint:fix` for auto-fixable lint issues before reporting failure
✅ Report test counts (suites and individual tests) on success

### Don'ts
❌ Don't skip stages
❌ Don't run tests if build fails (output is unreliable against stale dist/)
❌ Don't swallow error output — full error messages help diagnose root cause
❌ Don't run `npm run test:integration` unless explicitly requested (only unit tests here)

---

## Integration

### qa-lead
- Invoked as Stage 2 of qa-lead's quality gate flow
- Returns PASSED or FAILED with stage breakdown
- PASSED → qa-lead proceeds to ui-tests (conditional) or spec-refinement
- FAILED → qa-lead stops and reports the blocking gate

### Project Commands Reference

| Stage | Command | Fix Command |
|---|---|---|
| Lint | `npm run lint` | `npm run lint:fix` |
| Build | `npm run build` | fix TypeScript errors manually |
| Unit Tests | `npm test` | fix failing tests |
| Watch (dev) | `npm run test:watch` | — |
| Coverage | `npm run test:coverage` | — |
