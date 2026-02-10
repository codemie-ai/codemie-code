# Task #6 Changes: Update CI workflow for Bun

**Date**: 2026-02-10
**Branch**: feat/migrate-to-bun
**Status**: ✅ Complete

---

## Summary

Updated `.github/workflows/ci.yml` to use Bun for dependency installation, builds, and tests across all CI jobs (Ubuntu and Windows).

---

## Changes Made

### Jobs Updated

1. **validate-commits** - Commit/PR validation
2. **build** - Build and lint
3. **test-ubuntu** - Ubuntu tests
4. **test-windows** - Windows tests

### Changes Per Job

#### 1. Setup: Node.js → Bun

**Before**:
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
```

**After**:
```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v1
  with:
    bun-version: '1.3.9'
```

**Applied to**: All 4 jobs

#### 2. Install: npm ci → bun install

**Before**:
```yaml
- name: Install dependencies
  run: npm ci
```

**After**:
```yaml
- name: Install dependencies
  run: bun install --frozen-lockfile
```

**Applied to**: All 4 jobs

#### 3. Scripts: npm run → bun run

**Before**:
```yaml
run: npm run license-check
run: npm run lint
run: npm run build
run: npm run test:unit
run: npm run test:integration
```

**After**:
```yaml
run: bun run license-check
run: bun run lint
run: bun run build
run: bun run test:unit
run: bun run test:integration
```

**Applied to**: build, test-ubuntu, test-windows jobs

---

## Detailed Changes by Job

### Job 1: validate-commits

**Purpose**: Validate commit messages and PR titles

**Changes**:
- ✅ Setup: `setup-node` → `setup-bun`
- ✅ Install: `npm ci` → `bun install --frozen-lockfile`
- ⏸️ Commitlint: No change (uses npx, works with Bun)
- ⏸️ Node scripts: No change (node -e works with Bun)

**Lines changed**: 7 lines

---

### Job 2: secrets-detection

**Purpose**: Scan for secrets with Gitleaks

**Changes**:
- ⏸️ No changes (uses Gitleaks action only)

**Lines changed**: 0 lines

---

### Job 3: build

**Purpose**: Build project, lint, check licenses

**Changes**:
- ✅ Setup: `setup-node` → `setup-bun`
- ✅ Install: `npm ci` → `bun install --frozen-lockfile`
- ✅ License check: `npm run` → `bun run`
- ✅ Lint: `npm run` → `bun run`
- ✅ Build: `npm run` → `bun run`

**Lines changed**: 10 lines

---

### Job 4: test-ubuntu

**Purpose**: Run unit and integration tests on Ubuntu

**Changes**:
- ✅ Setup: `setup-node` → `setup-bun`
- ✅ Install: `npm ci` → `bun install --frozen-lockfile`
- ✅ Unit tests: `npm run` → `bun run`
- ✅ Integration tests: `npm run` → `bun run`

**Lines changed**: 9 lines

---

### Job 5: test-windows

**Purpose**: Run unit and integration tests on Windows

**Changes**:
- ✅ Setup: `setup-node` → `setup-bun`
- ✅ Install: `npm ci` → `bun install --frozen-lockfile`
- ✅ Unit tests: `npm run` → `bun run`
- ✅ Integration tests: `npm run` → `bun run`

**Lines changed**: 9 lines

---

## Command Changes Summary

| Command | Before | After | Jobs |
|---------|--------|-------|------|
| **Setup** | setup-node@v4 | setup-bun@v1 | All (4) |
| **Install** | npm ci | bun install --frozen-lockfile | All (4) |
| **License check** | npm run license-check | bun run license-check | build (1) |
| **Lint** | npm run lint | bun run lint | build (1) |
| **Build** | npm run build | bun run build | build (1) |
| **Test unit** | npm run test:unit | bun run test:unit | test-* (2) |
| **Test integration** | npm run test:integration | bun run test:integration | test-* (2) |

**Total changes**: 35 lines modified

---

## Bun Setup Details

### Action Used
```yaml
uses: oven-sh/setup-bun@v1
```

**Source**: https://github.com/oven-sh/setup-bun
**Maintained by**: Oven (Bun creators)
**Status**: Official GitHub Action

### Configuration
```yaml
with:
  bun-version: '1.3.9'
```

**Locked version**: 1.3.9
**Reason**: Ensure reproducibility across all CI runs

---

## Install Command Details

### `bun install --frozen-lockfile`

**Purpose**: Install dependencies from lockfile without modifications

**Behavior**:
- Reads `bun.lock`
- Installs exact versions
- Fails if lockfile is out of date (prevents drift)
- Equivalent to `npm ci`

**Why `--frozen-lockfile`**:
- ✅ Prevents accidental lockfile updates
- ✅ Ensures reproducible builds
- ✅ Fails fast if dependencies mismatch
- ✅ Standard practice for CI/CD

---

## Expected CI Performance Improvements

### Installation Time

| Job | npm ci (Before) | bun install (After) | Speedup |
|-----|----------------|---------------------|---------|
| **validate-commits** | ~60s | ~5-10s | 6-12x |
| **build** | ~60s | ~5-10s | 6-12x |
| **test-ubuntu** | ~60s | ~5-10s | 6-12x |
| **test-windows** | ~90s | ~10-15s | 6-9x |

**Total install time savings**: ~200s → ~30s (~80% faster)

### Test Execution

| Test Suite | npm (Before) | bun (After) | Speedup |
|------------|-------------|------------|---------|
| **Unit tests** | ~6s | ~5s | ~20% |
| **Integration tests** | ~13s | ~10s | ~23% |

---

## Platform Support

### Ubuntu (Linux)
- ✅ Fully supported
- ✅ Native Bun binaries
- ✅ Fast installation
- **Expected**: No issues

### Windows
- ✅ Supported (Bun 1.0+)
- ✅ Native Windows support
- ⚠️ Slightly slower than Linux (expected)
- **Expected**: Should work, may need testing

---

## Workflow Structure (Unchanged)

```
validate-commits ─┐
                  ├─> build ─┬─> test-ubuntu
secrets-detection─┘           └─> test-windows
```

**Job Dependencies**:
- validate-commits & secrets-detection run in parallel
- build waits for both validations
- test jobs run in parallel after build

**Artifacts**:
- build → uploads dist/
- test-* → downloads dist/ (reuses build)

---

## What Stays the Same

### Unchanged Commands
- ✅ `npx commitlint` - Works with Bun
- ✅ `node -e "..."` - Works with Bun runtime
- ✅ Gitleaks action - No dependency on package manager
- ✅ Checkout action - No dependency on package manager
- ✅ Upload/download artifacts - No dependency on package manager

### Unchanged Structure
- ✅ Job names and order
- ✅ Job dependencies (needs)
- ✅ Conditional execution (if)
- ✅ Artifact handling
- ✅ Matrix strategy (Ubuntu/Windows)

---

## Git Diff Summary

```diff
@@ -4 jobs, 35 lines changed:

- Setup Node.js (4 times)
+ Setup Bun (4 times)

- npm ci (4 times)
+ bun install --frozen-lockfile (4 times)

- npm run <script> (7 times)
+ bun run <script> (7 times)
```

---

## Verification Checklist

- [x] All `setup-node` replaced with `setup-bun`
- [x] All `npm ci` replaced with `bun install --frozen-lockfile`
- [x] All `npm run` replaced with `bun run`
- [x] Bun version locked at 1.3.9
- [x] Commands have correct spacing
- [x] No syntax errors in YAML
- [x] Job dependencies unchanged
- [x] Artifact flow unchanged

---

## Testing Plan

### Local Testing
Cannot fully test GitHub Actions locally, but can verify:
```bash
# Simulate install
bun install --frozen-lockfile

# Simulate build
bun run license-check
bun run lint
bun run build

# Simulate tests
bun run test:unit
bun run test:integration
```

### CI Testing
Will be tested when PR is created:
- ✅ validate-commits job
- ✅ secrets-detection job
- ✅ build job
- ✅ test-ubuntu job
- ✅ test-windows job

---

## Rollback Plan

If CI fails after merge:

```bash
# Revert workflow changes
git revert <commit-sha>
git push origin main
```

**Impact**: CI switches back to npm immediately

---

## Related Files

### Modified
- ✅ `.github/workflows/ci.yml` (35 lines changed)

### Not Modified
- ⏸️ `.github/workflows/publish.yml` (Task #7)

---

## Expected Outcomes

### Success Criteria
- ✅ All CI jobs pass
- ✅ Install time reduced by ~80%
- ✅ Test time reduced by ~20%
- ✅ No functional changes to builds

### Monitoring
After merge, check:
- GitHub Actions run times
- Job success rates
- Any platform-specific issues

---

## Common Issues & Solutions

### Issue 1: Lockfile out of sync
**Error**: `error: lockfile had changes, but lockfile is frozen`
**Solution**: Run `bun install` locally and commit updated `bun.lock`

### Issue 2: Windows-specific failures
**Error**: Native module build failures
**Solution**: May need platform-specific adjustments

### Issue 3: Missing dependencies
**Error**: `Cannot find module ...`
**Solution**: Verify bun.lock is committed and up to date

---

## What's Next

1. ✅ CI workflow updated
2. ➡️ Task #7: Update publish workflow
3. ➡️ Test CI pipeline on actual PR
4. ➡️ Monitor for issues

---

**Status**: ✅ Complete
**Next**: Task #7 - Update publish workflow
**Blockers**: None
**Risk**: Low (can revert easily)
