---
name: dependency-audit
description: Audit project dependencies for security vulnerabilities, outdated packages, and license compliance
version: 1.0.0
category: validation
userInvocable: true
triggerHooks:
  - PreToolUse
hookMatchers:
  - event: PreToolUse
    toolNames:
      - npm_install
      - yarn_add
      - pnpm_add
allowedTools:
  - Bash
  - Read
  - Write
  - Grep
inputSchema:
  type: object
  properties:
    checkType:
      type: string
      enum: [security, outdated, licenses, all]
      description: Type of audit to perform
      default: all
    autoFix:
      type: boolean
      description: Automatically fix security vulnerabilities when possible
      default: false
    reportFormat:
      type: string
      enum: [text, json, markdown]
      description: Format for the audit report
      default: markdown
  required: []
---

# Dependency Audit Skill

Perform comprehensive dependency audits to identify security vulnerabilities, outdated packages, and license compliance issues.

## When to Use

- Before deploying to production
- During regular security reviews
- Before adding new dependencies
- When updating existing dependencies
- As part of CI/CD pipeline checks

## Audit Types

### Security Audit
Check for known security vulnerabilities in dependencies.

### Outdated Packages
Identify packages that have newer versions available.

### License Compliance
Review licenses of all dependencies for compliance with project requirements.

## Audit Process

### 1. Detect Package Manager

First, identify which package manager the project uses:

```bash
# Check for package manager lock files
if [ -f "package-lock.json" ]; then
  echo "npm"
elif [ -f "yarn.lock" ]; then
  echo "yarn"
elif [ -f "pnpm-lock.yaml" ]; then
  echo "pnpm"
else
  echo "unknown"
fi
```

### 2. Security Audit

Run security audit based on detected package manager:

#### NPM
```bash
# Run security audit
npm audit --json > audit-report.json

# Get summary
npm audit

# Check for critical/high vulnerabilities
npm audit --audit-level=moderate
```

#### Yarn
```bash
# Run security audit
yarn audit --json > audit-report.json

# Get summary
yarn audit
```

#### PNPM
```bash
# Run security audit
pnpm audit --json > audit-report.json

# Get summary
pnpm audit
```

### 3. Check Outdated Packages

#### NPM
```bash
# List outdated packages
npm outdated --json > outdated-report.json

# Human-readable format
npm outdated
```

#### Yarn
```bash
# List outdated packages
yarn outdated --json > outdated-report.json

# Human-readable format
yarn outdated
```

#### PNPM
```bash
# List outdated packages
pnpm outdated --json > outdated-report.json

# Human-readable format
pnpm outdated
```

### 4. License Audit

Check licenses of all dependencies:

```bash
# Install license-checker if not available
npx license-checker --json > licenses-report.json

# Check for specific license types
npx license-checker --summary

# Identify problematic licenses (GPL, AGPL, etc.)
npx license-checker --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC"
```

### 5. Analyze Results

Parse the JSON reports and categorize findings:

```bash
# Read audit report
cat audit-report.json

# Count vulnerabilities by severity
jq '.metadata.vulnerabilities' audit-report.json

# List critical vulnerabilities
jq '.vulnerabilities | to_entries[] | select(.value.severity == "critical")' audit-report.json
```

## Auto-Fix Capabilities

When `autoFix: true` is specified:

### NPM
```bash
# Fix vulnerabilities automatically (may update dependencies)
npm audit fix

# Fix only production dependencies
npm audit fix --only=prod

# Force fix (may introduce breaking changes)
npm audit fix --force
```

### Yarn
```bash
# Upgrade vulnerable packages
yarn upgrade --latest
```

### PNPM
```bash
# Update vulnerable packages
pnpm update
```

## Output Format

### Markdown Report (Default)

```markdown
# Dependency Audit Report

**Date:** 2024-01-15
**Project:** codemie-code
**Package Manager:** npm

## Security Vulnerabilities

### Critical (2)
- **lodash** (4.17.15 → 4.17.21)
  - CVE-2020-8203: Prototype Pollution
  - Affected: Direct dependency
  - Fix: `npm install lodash@^4.17.21`

- **minimist** (1.2.5 → 1.2.6)
  - CVE-2021-44906: Prototype Pollution
  - Affected: Transitive dependency (via mkdirp)
  - Fix: Update parent package

### High (5)
[List high-severity vulnerabilities]

### Moderate (12)
[List moderate-severity vulnerabilities]

## Outdated Packages

### Major Updates Available (3)
- **typescript**: 5.0.0 → 6.0.0 (breaking changes expected)
- **eslint**: 8.0.0 → 9.0.0 (review migration guide)

### Minor Updates Available (8)
- **vitest**: 1.0.0 → 1.2.0 (recommended)
- **@types/node**: 20.0.0 → 20.10.0 (recommended)

### Patch Updates Available (15)
[List patch updates]

## License Compliance

### Summary
- Total dependencies: 142
- Unique licenses: 8

### License Distribution
- MIT: 120 packages (84%)
- Apache-2.0: 15 packages (11%)
- BSD-3-Clause: 5 packages (3%)
- ISC: 2 packages (1%)

### ⚠️ Problematic Licenses
- **gpl-package** (GPL-3.0) - Not compatible with Apache-2.0 project
  - Consider alternative: [suggest MIT-licensed alternative]

## Recommendations

### Immediate Action Required
1. Fix critical vulnerabilities in lodash and minimist
2. Review GPL-licensed dependency (gpl-package)

### Recommended Actions
1. Update TypeScript to 5.3.x (latest in v5 series)
2. Apply patch updates for security improvements

### Optional Improvements
1. Consider upgrading to ESLint 9.x (review breaking changes)
2. Update dev dependencies to latest versions

## Commands to Fix

```bash
# Fix critical vulnerabilities
npm install lodash@^4.17.21

# Update patch versions
npm update

# Review and update major versions manually
npm install typescript@^5.3.0
```
```

### JSON Report

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "project": "codemie-code",
  "packageManager": "npm",
  "security": {
    "critical": 2,
    "high": 5,
    "moderate": 12,
    "low": 3,
    "vulnerabilities": [...]
  },
  "outdated": {
    "major": 3,
    "minor": 8,
    "patch": 15,
    "packages": [...]
  },
  "licenses": {
    "total": 142,
    "distribution": {...},
    "problematic": [...]
  },
  "recommendations": [...]
}
```

## Best Practices

### DO
- Run audits regularly (at least weekly)
- Address critical and high vulnerabilities immediately
- Review licenses before adding new dependencies
- Keep dependencies up to date with patch versions
- Test thoroughly after dependency updates

### DON'T
- Ignore security warnings
- Use `--force` flag without understanding implications
- Update all dependencies blindly
- Add dependencies without checking licenses
- Skip testing after security fixes

## Integration with CI/CD

This skill can be integrated into CI/CD pipelines:

```yaml
# .github/workflows/security-audit.yml
name: Security Audit
on:
  schedule:
    - cron: '0 0 * * 1'  # Weekly on Monday
  pull_request:
    paths:
      - 'package.json'
      - 'package-lock.json'

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run Dependency Audit
        run: |
          npm install -g @codemieai/code
          codemie-code --task "Run dependency-audit skill"
```

## Hook Integration

This skill automatically triggers before installing new packages:

```yaml
hookMatchers:
  - event: PreToolUse
    toolNames:
      - npm_install
      - yarn_add
      - pnpm_add
```

When triggered, it:
1. Audits existing dependencies
2. Warns if adding a package with known vulnerabilities
3. Checks license compatibility
4. Provides recommendations before proceeding

## Advanced Usage

### Custom License Whitelist

Create a `.license-whitelist` file:

```
MIT
Apache-2.0
BSD-2-Clause
BSD-3-Clause
ISC
```

### Vulnerability Exceptions

Create a `.audit-exceptions.json` file:

```json
{
  "exceptions": [
    {
      "package": "package-name",
      "cve": "CVE-2020-1234",
      "reason": "False positive - not using vulnerable code path",
      "expires": "2024-12-31"
    }
  ]
}
```

## Troubleshooting

### Audit Fails
```bash
# Clear npm cache
npm cache clean --force

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### False Positives
```bash
# Check if vulnerability affects your code path
npm audit --json | jq '.vulnerabilities'

# Review vulnerability details
npm audit
```

### License Checker Issues
```bash
# Install globally for better performance
npm install -g license-checker

# Run with custom format
license-checker --customPath custom-format.json
```

## Output Example

After running the audit:

```markdown
## Dependency Audit Complete

**Status:** ⚠️ Issues Found

### Critical Issues (2)
- 2 critical security vulnerabilities
- 1 GPL-licensed package (incompatible)

### Summary
- Security: 2 critical, 5 high, 12 moderate
- Outdated: 3 major, 8 minor, 15 patch
- Licenses: 1 problematic

**Full report saved to:** `dependency-audit-report.md`

**Next Steps:**
1. Run `npm install lodash@^4.17.21` to fix critical vulnerability
2. Review GPL-licensed package: gpl-package
3. Update patch versions: `npm update`

**Estimated fix time:** 15 minutes
```
