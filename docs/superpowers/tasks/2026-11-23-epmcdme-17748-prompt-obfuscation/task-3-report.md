status: DONE_WITH_CONCERNS

commit: c5d04720 feat(analytics): EPMCDME-17748 analytics settings resolver and setup step

changed paths:
- src/utils/analytics-settings.ts (new)
- src/utils/__tests__/analytics-settings.test.ts (new)
- src/cli/commands/setup.ts (promptAnalyticsSettings step after profile save)
- src/env/types.ts (AnalyticsSettingsConfig; MultiProviderConfig.analytics)

test command: npx vitest run src/utils/__tests__/analytics-settings.test.ts
RED: module missing, EXIT=1. GREEN: 7/7 pass, EXIT=0. tsc and eslint (max-warnings 0) clean. Pre-commit hooks passed.

exported signatures:
- resolveAnalyticsSettings(cwd: string): AnalyticsSettings
- interface AnalyticsSettings { obfuscation: ObfuscationMode; ticketTracker?: TicketTracker }
- interface AnalyticsSettingsConfig (env/types.ts) { obfuscation?: 'on'|'off'; ticketTracker?: ... }

config keys / locations: top-level `analytics: { obfuscation, ticketTracker }` in ~/.codemie/codemie-cli.config.json (via getCodemiePath, honours CODEMIE_HOME) and <cwd>/.codemie/codemie-cli.config.json. Not `.claude/analytics.local.json` (rationale comment in module).

renames: none. reused: getCodemiePath, ConfigLoader.load/save(Local)MultiProviderConfig, inquirer prompts in setup.ts.

standards: ES modules, .js imports, type-only imports of ObfuscationMode/TicketTracker (module stays light: node:fs, node:path, paths.ts), no any, logger.warn not console.

concerns:
- A layer never read successfully before and unreadable now contributes nothing (off) unless the other layer was on; only prior-read state can protect.
- ENOENT (file deleted) is treated as absent, so it can resolve to off.
- Setup step failures only log a warning and do not fail setup. Setup step has no unit test.
- Pre-commit hook took many minutes (lint-staged tests).
