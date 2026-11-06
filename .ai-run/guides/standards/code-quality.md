# Code Quality Standards

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: typing conventions ESLint does not enforce and the Pi extension JavaScript; lint and type-check commands live in `.ai-run/guides/quality-gates.md`

## Type safety

### Rules
- R2. Do not use `any` in new code (editorial convention; ESLint does not enforce it). Known debt, to fix: src/agents/registry.ts, src/agents/plugins/gemini/gemini-acp.plugin.ts. Evidence: `eslint.config.mjs::no-explicit-any`

## Imports

### Rules
- R1. Write `src/agents/plugins/pi/extension/*.js` as plain ESM JavaScript with no project imports (tsc does not compile it, `copy-plugins.js` ships it byte-identical, and it has its own ESLint block). Evidence: `scripts/copy-plugins.js::copyConfigs`
