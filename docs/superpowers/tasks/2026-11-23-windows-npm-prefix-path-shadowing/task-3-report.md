DONE
commit: ea80de4e
files: src/utils/path-shadow.ts, src/utils/active-cli.ts, src/utils/__tests__/path-shadow.test.ts, src/utils/__tests__/active-cli.test.ts
test_command: npx vitest run src/utils/__tests__/path-shadow.test.ts src/utils/__tests__/active-cli.test.ts (25 passed)
exports:
- active-cli.ts: formatPutAheadLine(binDir: string | null, aheadOfDir: string): string
- path-shadow.ts: formatShadowWarning(verdict: Extract<ShadowVerdict,{status:'shadowed'}>, platform: NodeJS.Platform = process.platform): string[]
- path-shadow.ts: formatNotOnPathHint(verdict: Extract<ShadowVerdict,{status:'missing-on-path'}>, _platform: NodeJS.Platform = process.platform): string[]
- path-shadow.ts: formatNotOnPathShort(verdict: Extract<ShadowVerdict,{status:'missing-on-path'}>): string
notes: PowerShell command omitted when dir has ' " ; % or control chars. formatStaleWarning output pinned by new tests before refactor (unchanged). path-shadow.ts now imports active-cli.ts.
