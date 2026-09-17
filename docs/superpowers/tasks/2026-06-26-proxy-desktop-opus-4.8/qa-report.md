# QA Report — proxy connect desktop: single Opus (prefer 4.8)

Branch: `fix/proxy-desktop-opus-4.8`

## Gates

| Gate | Command | Result |
|---|---|---|
| Unit tests (affected) | `vitest run …/desktop.test.ts` | PASS — 44/44 (5 new `selectDesktopClaudeModels` cases) |
| Lint | `eslint desktop.ts desktop.test.ts` | PASS — no issues |
| Typecheck | `tsc --noEmit` | PASS — no errors |
| Build | `npm run build` | PASS — `dist/` reflects the change |

## Live end-to-end check (non-destructive)

Ran real gateway discovery + new selection against the running proxy
(`preview-kimi`, http://127.0.0.1:4001). No Claude Desktop config was mutated.

- Gateway serves: `claude-sonnet-4-6`, `claude-opus-4-5-20251101`,
  `claude-opus-4-6-20260205`, `claude-opus-4-7`, **`claude-opus-4-8`**,
  `claude-haiku-4-5-20251001` (+ older sonnet ids).
- `selectDesktopClaudeModels` →
  `["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"]`.
- **Opus entries exposed to Desktop: exactly 1 — `claude-opus-4-8`.**

Confirms the original symptom (Opus 4.6 **and** 4.7 shown) is resolved: a single
Opus 4.8 is now offered. When a gateway lacks 4.8, the same logic falls back to the
next-best available opus (proven by unit tests).

## Notes

- `.codemie/codemie-cli.config.json` is a pre-existing local profile change, unrelated
  to this task and intentionally not staged.
