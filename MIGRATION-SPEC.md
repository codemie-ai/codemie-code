# Bun Migration Specification
## CodeMie Code - Package Manager Migration from npm to Bun

**Version**: 1.0
**Date**: February 10, 2026
**Status**: Draft
**Owner**: Engineering Team
**Branch**: `feat/migrate-to-bun`

---

## Executive Summary

This specification outlines the migration of the CodeMie Code project from npm to Bun as the primary package manager for development, testing, and CI/CD workflows. The migration aims to improve developer experience through faster build times, reduced dependency installation overhead, and modern tooling while maintaining full compatibility with npm for package publishing and end-user consumption.

### Key Metrics
- **Current State**: npm 9.x with package-lock.json (221MB node_modules)
- **Target State**: Bun 1.3.9+ with bun.lockb
- **Expected Benefits**: 3-5x faster installs, 2-3x faster tests, smaller lockfile
- **Risk Level**: Low (high compatibility, easy rollback)
- **Timeline**: 3-5 days

---

## 1. Goals and Objectives

### Primary Goals
1. **Performance**: Reduce development cycle time through faster package installation and test execution
2. **Developer Experience**: Modernize tooling with native TypeScript support and better error messages
3. **CI/CD Efficiency**: Decrease pipeline execution time by 30-50%
4. **Compatibility**: Maintain 100% compatibility with npm publishing and end-user installation

### Non-Goals
- Rewriting any application code
- Changing runtime behavior for end users
- Migrating away from npm as a distribution channel
- Modifying package structure or API

### Success Criteria
- ✅ All 300+ tests pass with Bun
- ✅ Build output identical to npm version
- ✅ CI/CD pipelines complete successfully
- ✅ Native modules (keytar) work on all platforms
- ✅ npm publishing workflow unchanged
- ✅ Developer onboarding time reduced
- ✅ Zero breaking changes for end users

---

## 2. Technical Architecture

### 2.1 Current Architecture

```
┌─────────────────────────────────────────────────┐
│           Developer Workstation                  │
├─────────────────────────────────────────────────┤
│  npm install → node_modules (221MB)              │
│  npm run build → TypeScript → dist/              │
│  npm test → Vitest → Test Results                │
│  npm publish → npm registry                      │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│           CI/CD (GitHub Actions)                 │
├─────────────────────────────────────────────────┤
│  setup-node@v4 (Node 20)                        │
│  npm ci → Install deps (90-120s)                │
│  npm run lint → ESLint                          │
│  npm run build → Build (30-40s)                 │
│  npm test → Test (60-90s)                       │
│  npm publish → Publish to registry              │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│           npm Registry                           │
├─────────────────────────────────────────────────┤
│  @codemieai/code@0.0.37                         │
│  End users: npm install -g @codemieai/code      │
└─────────────────────────────────────────────────┘
```

### 2.2 Target Architecture

```
┌─────────────────────────────────────────────────┐
│           Developer Workstation                  │
├─────────────────────────────────────────────────┤
│  bun install → node_modules (same size)          │
│  bun run build → TypeScript → dist/ (same)       │
│  bun test → Vitest → Test Results (faster)       │
│  npm publish → npm registry (unchanged)          │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│           CI/CD (GitHub Actions)                 │
├─────────────────────────────────────────────────┤
│  setup-bun@v1 (Bun 1.3.9)                       │
│  bun install --frozen-lockfile → (20-30s)       │
│  bun run lint → ESLint (same)                   │
│  bun run build → Build (same)                   │
│  bun test → Test (30-40s)                       │
│  setup-node@v4 → npm publish (unchanged)        │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│           npm Registry                           │
├─────────────────────────────────────────────────┤
│  @codemieai/code@0.0.37                         │
│  End users: npm install -g @codemieai/code      │
│  NO CHANGES - Same package structure            │
└─────────────────────────────────────────────────┘
```

### 2.3 Key Changes

| Component | Before | After | Impact |
|-----------|--------|-------|--------|
| Package Manager | npm 9.x | Bun 1.3.9 | Developer only |
| Lockfile | package-lock.json (1MB+) | bun.lockb (~50KB) | Git repo size |
| Install Command | `npm ci` | `bun install --frozen-lockfile` | CI/CD scripts |
| Script Runner | `npm run <cmd>` | `bun run <cmd>` | package.json scripts |
| Build Process | tsc + tsc-alias | Same (via Bun) | No change |
| Test Runner | Vitest (via npm) | Vitest (via Bun) | Faster execution |
| Publishing | npm publish | npm publish | **No change** |
| CI Runtime | Node.js 20 | Bun 1.3.9 + Node 20 (publish) | Hybrid approach |

---

## 3. Migration Scope

### 3.1 In-Scope

#### Configuration Files
- ✅ `package.json` - Add `packageManager` field, update scripts
- ✅ `.gitignore` - Add Bun cache directory
- ✅ `package-lock.json` → `bun.lockb` - Replace lockfile
- ✅ `.github/workflows/ci.yml` - Update CI pipeline
- ✅ `.github/workflows/publish.yml` - Update publish pipeline

#### Documentation
- ✅ `README.md` - Update installation instructions
- ✅ `CONTRIBUTING.md` - Update development setup
- ✅ `scripts/README.md` - Update script examples

#### Testing
- ✅ Unit tests (300+ tests)
- ✅ Integration tests
- ✅ Native modules (keytar)
- ✅ CLI binaries
- ✅ CI/CD workflows

### 3.2 Out-of-Scope

#### No Changes Required
- ❌ Source code (`src/` directory)
- ❌ Application logic or business rules
- ❌ TypeScript configuration (`tsconfig.json`)
- ❌ ESLint configuration (`eslint.config.mjs`)
- ❌ Vitest configuration (`vitest.config.ts`)
- ❌ Husky git hooks
- ❌ Commitlint configuration
- ❌ Package distribution structure
- ❌ npm registry publishing
- ❌ End-user installation process

---

## 4. Implementation Plan

### Phase 1: Preparation (Day 1)
**Duration**: 4-6 hours
**Risk**: Low

```bash
# Task 1: Verify current state
npm run ci                    # Ensure baseline works
npm run build                 # Verify build output
npm test                      # Confirm all tests pass

# Task 2: Test Bun compatibility
bun install                   # Dry run installation
bun run build                 # Verify build compatibility
bun test                      # Verify test compatibility
```

**Deliverables**:
- ✅ Baseline metrics documented
- ✅ Bun compatibility confirmed
- ✅ Known issues identified

### Phase 2: Configuration (Day 1-2)
**Duration**: 4-6 hours
**Risk**: Low

```json
// package.json changes
{
  "packageManager": "bun@1.3.9",
  "scripts": {
    "build": "bun run tsc && bun run tsc-alias && bun scripts/copy-plugins.js",
    "test": "bun test",
    // ... all scripts updated
  }
}
```

**Steps**:
1. Update `package.json` with Bun scripts
2. Remove `package-lock.json`
3. Generate `bun.lockb`
4. Update `.gitignore`

**Deliverables**:
- ✅ package.json updated
- ✅ bun.lockb generated
- ✅ .gitignore updated

### Phase 3: CI/CD Migration (Day 2)
**Duration**: 4-6 hours
**Risk**: Medium

```yaml
# .github/workflows/ci.yml
- name: Setup Bun
  uses: oven-sh/setup-bun@v1
  with:
    bun-version: '1.3.9'

- name: Install dependencies
  run: bun install --frozen-lockfile

- name: Build
  run: bun run build

- name: Test
  run: bun test
```

**Steps**:
1. Update CI workflow
2. Update publish workflow (hybrid: Bun + npm)
3. Test workflows locally with act (if possible)

**Deliverables**:
- ✅ CI workflow updated
- ✅ Publish workflow updated
- ✅ Workflows tested

### Phase 4: Documentation (Day 2-3)
**Duration**: 2-3 hours
**Risk**: Low

**Updates**:
- README.md installation section
- CONTRIBUTING.md development setup
- scripts/README.md examples

**Deliverables**:
- ✅ All documentation updated
- ✅ Bun installation instructions added
- ✅ Migration notes documented

### Phase 5: Validation (Day 3)
**Duration**: 4-6 hours
**Risk**: Medium

```bash
# Full validation suite
bun run ci                    # Complete CI locally
bun test --coverage           # Coverage report
./bin/codemie.js --version    # Binary test
npm link && codemie doctor    # Global install test
```

**Test Matrix**:
- ✅ All scripts execute
- ✅ All tests pass
- ✅ Native modules work
- ✅ CLI binaries functional
- ✅ Build output identical

**Deliverables**:
- ✅ Validation report
- ✅ Test results documented
- ✅ Issues resolved

### Phase 6: Review & Merge (Day 3-5)
**Duration**: Variable
**Risk**: Low

**Process**:
1. Create PR with comprehensive description
2. Request team review
3. Address feedback
4. Monitor CI/CD on GitHub
5. Merge to main

**Deliverables**:
- ✅ PR created and reviewed
- ✅ CI passing on GitHub
- ✅ Branch merged
- ✅ Team notified

---

## 5. Risk Assessment & Mitigation

### 5.1 Technical Risks

| Risk | Probability | Impact | Mitigation | Rollback |
|------|------------|--------|------------|----------|
| **Native modules fail** | Low | High | Test keytar on all platforms early | Keep package-lock.json in git history |
| **CI/CD failures** | Low | Medium | Dry run with act locally, hybrid npm/bun approach | Revert workflow files |
| **Test failures** | Very Low | High | Run full test suite before commit | Cherry-pick commits |
| **Build output differs** | Very Low | High | Compare dist/ checksums | Revert to npm |
| **Windows compatibility** | Low | Medium | Test in Windows CI early | Platform-specific fixes |
| **Publishing breaks** | Very Low | Critical | Keep npm publish unchanged | No changes to publish step |

### 5.2 Process Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| **Team unfamiliarity** | Medium | Low | Comprehensive documentation, training session |
| **Onboarding friction** | Medium | Low | Update setup guides, provide install script |
| **Downstream impacts** | Very Low | Medium | Verify no changes to distributed package |
| **Timeline slippage** | Medium | Low | Buffer time in estimate, prioritize blockers |

### 5.3 Rollback Plan

If critical issues are discovered:

```bash
# Emergency rollback (< 5 minutes)
git checkout main
git revert <migration-commit-sha>
git push origin main

# Or revert PR merge on GitHub
# Developers:
npm install  # Falls back to npm automatically
```

**Rollback Triggers**:
- Publishing to npm fails
- Native modules broken on >1 platform
- >50% test failures
- Critical production issues
- Team consensus to abort

---

## 6. Dependencies & Prerequisites

### 6.1 Software Requirements

| Component | Current | Required | Notes |
|-----------|---------|----------|-------|
| Bun | N/A | 1.3.9+ | Install via curl -fsSL https://bun.sh/install |
| Node.js | 20.x | 20.x | Still required for npm publish |
| Git | Any | 2.x+ | Standard |
| GitHub Actions | N/A | oven-sh/setup-bun@v1 | CI/CD |

### 6.2 Access Requirements

- ✅ Write access to repository
- ✅ GitHub Actions permissions
- ✅ npm registry access (unchanged)
- ✅ Ability to create branches/PRs

### 6.3 Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| macOS (arm64) | ✅ Primary | Development platform |
| macOS (x64) | ✅ Supported | CI tested |
| Linux (x64) | ✅ Supported | CI tested |
| Windows (x64) | ✅ Supported | CI tested |

---

## 7. Success Metrics

### 7.1 Performance Benchmarks

| Metric | Baseline (npm) | Target (Bun) | Actual |
|--------|----------------|--------------|--------|
| Clean install | 90-120s | 20-30s | TBD |
| Incremental install | 30-60s | 5-10s | TBD |
| Build time | 30-40s | 25-35s | TBD |
| Test suite (all) | 60-90s | 30-45s | TBD |
| CI pipeline total | 8-12 min | 5-8 min | TBD |
| Lockfile size | 1MB+ | <100KB | TBD |

### 7.2 Quality Gates

Before merge:
- ✅ 100% test pass rate (300+ tests)
- ✅ 0 ESLint errors
- ✅ 0 TypeScript errors
- ✅ All CI checks green
- ✅ Code review approved
- ✅ Documentation complete

Post-merge monitoring:
- ✅ No increase in error rates
- ✅ No publishing failures
- ✅ No user-reported issues
- ✅ Team onboarding smooth

---

## 8. Communication Plan

### 8.1 Stakeholders

| Group | Impact | Communication |
|-------|--------|---------------|
| **Engineering Team** | High | PR review, team meeting, docs |
| **Contributors** | Medium | GitHub issue, CONTRIBUTING.md update |
| **End Users** | None | No communication needed (transparent) |
| **DevOps/CI** | Low | Workflow changes documented |

### 8.2 Timeline

```
Day 0: ✅ Spec review and approval
Day 1: 🔄 Phase 1-2 (Prep & Config)
Day 2: 🔄 Phase 3-4 (CI/CD & Docs)
Day 3: 🔄 Phase 5 (Validation)
Day 4: 🔄 PR review
Day 5: ✅ Merge to main
```

### 8.3 Notifications

**Before Migration**:
- [ ] Spec shared with team
- [ ] Migration plan approved
- [ ] Branch created announcement

**During Migration**:
- [ ] PR created notification
- [ ] Review requests sent
- [ ] CI status updates

**After Migration**:
- [ ] Merge announcement
- [ ] Updated setup guide shared
- [ ] Team training session (if needed)

---

## 9. Validation Checklist

### Pre-Migration
- [ ] All npm tests passing
- [ ] Current build verified
- [ ] Baseline metrics captured
- [ ] Bun 1.3.9+ available
- [ ] Team notified

### During Migration
- [ ] package.json updated
- [ ] bun.lockb generated
- [ ] .gitignore updated
- [ ] CI workflows updated
- [ ] Documentation updated
- [ ] All scripts tested
- [ ] Native modules verified
- [ ] CLI binaries tested

### Post-Migration
- [ ] All tests passing
- [ ] CI/CD green on GitHub
- [ ] Build output identical
- [ ] npm publish verified
- [ ] Documentation accurate
- [ ] Team can build locally
- [ ] Performance metrics captured

---

## 10. Appendices

### Appendix A: Command Mapping

| npm Command | Bun Equivalent | Notes |
|-------------|----------------|-------|
| `npm install` | `bun install` | Standard install |
| `npm ci` | `bun install --frozen-lockfile` | CI install |
| `npm run <script>` | `bun run <script>` | Script execution |
| `npm test` | `bun test` | Test runner |
| `npm run build` | `bun run build` | Build command |
| `npm publish` | `npm publish` | **No change** |

### Appendix B: File Changes Summary

```
Modified:
- package.json (packageManager field, scripts)
- .gitignore (.bun/ directory)
- .github/workflows/ci.yml (setup-bun)
- .github/workflows/publish.yml (hybrid setup)
- README.md (installation instructions)
- CONTRIBUTING.md (development setup)
- scripts/README.md (command examples)

Deleted:
- package-lock.json

Added:
- bun.lockb
- MIGRATION-SPEC.md (this document)
```

### Appendix C: References

- [Bun Documentation](https://bun.sh/docs)
- [Bun GitHub Actions](https://github.com/oven-sh/setup-bun)
- [npm vs Bun Compatibility](https://bun.sh/docs/cli/install)
- [Vitest with Bun](https://bun.sh/docs/test/vitest)

### Appendix D: Support & Contact

| Issue Type | Contact | Response Time |
|------------|---------|---------------|
| Migration Questions | Engineering Team | 1-2 hours |
| Build Failures | CI/CD Team | 30 min |
| Technical Issues | GitHub Issues | 1-2 days |
| Urgent Blockers | Team Lead | Immediate |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-10 | Engineering Team | Initial specification |

---

**Approval**:
- [ ] Engineering Lead: __________________ Date: __________
- [ ] Tech Lead: ________________________ Date: __________
- [ ] Team Review: ______________________ Date: __________

---

## Next Steps

1. **Review this specification** with the team
2. **Get approval** from stakeholders
3. **Begin Phase 1** (Preparation)
4. **Track progress** using GitHub Tasks
5. **Update this document** as needed during implementation

---

*This specification is a living document and will be updated throughout the migration process.*
