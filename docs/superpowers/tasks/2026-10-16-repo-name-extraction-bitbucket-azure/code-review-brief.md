# Code review — 2026-10-16-repo-name-extraction-bitbucket-azure (2026-10-16)

**request-changes** · confidence: high · 2 blocking · 0 deferred · 0 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance ✓  (2/2 expected lenses ran)

## Look here first

- `src/utils/processes.ts:459` — [other: data quality] lone `~` first segment yields empty/bogus repo name; unparseable-remote criterion partial — CR-002

## Also flagged

- `src/utils/processes.ts:446` — [other: data quality] legacy visualstudio.com path with no repo returns bare org — CR-001

## Checked and clean

Standards audit not run for this profile · 11 of 12 acceptance criteria pass
