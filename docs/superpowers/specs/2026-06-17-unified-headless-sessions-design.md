# Design: Unified Headless Sessions for All Supported Agents

**Date:** 2026-06-17
**Status:** Approved
**Source spec:** `docs/specs/unified-headless-sessions/task.md`
**Branch:** `feat/unified-headless-sessions`

---

## 1. Goal

Add two unified CLI flags across every `codemie-*` wrapper:

- `--reasoning-effort <level>` — pin the model's thinking/reasoning effort.
- `--resume <session-id>` — resume an existing session and optionally send a new task.

```bash
codemie-<agent> --model M --reasoning-effort high [--resume <id>] --task "T"
```

Where `<agent>` ∈ { `claude`, `codex`, `opencode`, `kimi` }.

---

## 2. Design decisions locked during review

| # | Decision | Rationale |
|---|---|---|
| D1 | Approach A — central applier in `BaseAgentAdapter` after `transformFlags` | Declarative metadata; one injection point; matches `flagMappings` pattern |
| D2 | Types (`CanonicalReasoningEffort`, `ReasoningEffortStrategy`, `ReasoningEffortConfig`) live in `types.ts` | Single type home; `reasoning-effort.ts` imports them type-only |
| D3 | Drop `AgentConfig.reasoningEffort` | Dead field under Approach A; central applier reads `env.CODEMIE_REASONING_EFFORT` directly |
| D4 | `mapLevel` optional with identity default | Clamping handles all current agent cases; escape hatch for future providers |
| D5 | `placement` applies to both `cli-flag` and `cli-config`; only `env` ignores it | Codex `cli-config` uses `prepend` |
| D6 | Codex `configFlag: '--config'` | Consistent with existing `--config` tuning block in codex enrichArgs |
| D7 | Kimi full env bundle: `THINKING_MODE + THINKING_EFFORT + CAPABILITIES + DEFAULT_THINKING` | Defensive; activates thinking across all Kimi 0.16.0 paths |
| D8 | Validate resolved `config.reasoningEffort` (post-merge) | Catches bad profile defaults, not just CLI flag |
| D9 | All user-facing validation/warn via `console.error` (stderr); `logger.*` for file only | `logger.error/warn` is gated behind `isDebugMode()` |
| D10 | Codex `--resume` without `--task` → `codex resume <id>` (interactive) | Avoids broken passthrough; consistent with native codex behavior |
| D11 | Kimi Q4 — carry as live-run verification item | Env bundle shape is correct; sufficiency needs one real `codemie-kimi --reasoning-effort high --task …` run |

---

## 3. Canonical effort vocabulary

```
minimal < low < medium < high < xhigh < max
```

Per-agent supported levels and clamping:

| Canonical | claude (`--effort`) | codex (`model_reasoning_effort`) | opencode (`--variant`) | kimi (env) |
|---|---|---|---|---|
| `minimal` | → `low` | `minimal` | `minimal` | → `low` |
| `low`–`xhigh` | identity | identity | identity | identity |
| `max` | `max` | → `xhigh` | `max` | `max` |

Clamping emits a dim/cyan advisory to stderr (not red — not an error); also logged at `logger.debug`.

---

## 4. New shared module — `src/agents/core/reasoning-effort.ts`

Imports types from `types.ts` (type-only). Exports:

```ts
export const CANONICAL_EFFORT_ORDER: CanonicalReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Case-insensitive parse; returns undefined for unknown input. */
export function normalizeReasoningEffort(raw: string): CanonicalReasoningEffort | undefined;

/**
 * Clamp a canonical level to the nearest level in `supported`.
 * Pure function — no side effects, no logging.
 * Returns a CanonicalReasoningEffort (clamped value is still canonical).
 */
export function clampToSupported(
  level: CanonicalReasoningEffort,
  supported: CanonicalReasoningEffort[],
): CanonicalReasoningEffort;

/**
 * Apply effort to args/env per strategy.
 * - cli-flag / cli-config: mutates/returns args.
 * - env: mutates env in place; args unchanged.
 * - Checks userOverrideFlags first; skips + logger.debug if user already set the native flag.
 * - normalizeReasoningEffort() === undefined → skip + logger.debug (safety net only; hard exit in AgentCLI).
 * - Logs clamp info (dim/cyan stderr + logger.debug) when clamping occurs.
 */
export function applyReasoningEffort(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: ReasoningEffortConfig,
  rawLevel: string | undefined,
  agentName: string,
): { args: string[] };
```

### Override detection (strategy-aware)

- `cli-flag`: `arg === config.flag || arg.startsWith(config.flag + '=')` for each arg in `args`.
- `cli-config`: any arg in `args` that `includes(config.configKey!)` (substring match for `model_reasoning_effort=…`).
- `env`: N/A — env vars are always set (they were absent before; setting them doesn't collide).

### Kimi env injection

Iterates `config.envVars` generically, replacing `'%s'` with the mapped level:
```ts
for (const [key, template] of Object.entries(config.envVars)) {
  env[key] = template === '%s' ? mappedLevel : template;
}
```
Kimi env var names live entirely in Kimi's metadata block.

---

## 5. Types additions — `src/agents/core/types.ts` + `src/env/types.ts`

### `src/agents/core/types.ts`

```ts
export type CanonicalReasoningEffort =
  | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReasoningEffortStrategy = 'cli-flag' | 'cli-config' | 'env';

export interface ReasoningEffortConfig {
  strategy: ReasoningEffortStrategy;
  supportedLevels: CanonicalReasoningEffort[];

  /** Optional: identity default. Escape hatch for providers that rename levels. */
  mapLevel?: (level: CanonicalReasoningEffort) => string | null;

  /** Shared by cli-flag and cli-config. Default: 'append'. Ignored by env. */
  placement?: 'prepend' | 'append';

  // cli-flag  (claude: --effort, opencode: --variant)
  flag?: string;

  // cli-config  (codex: --config model_reasoning_effort="<level>")
  configFlag?: string;   // default '--config'; '-c' is its alias
  configKey?: string;    // e.g. 'model_reasoning_effort'

  // env  (kimi: KIMI_MODEL_THINKING_* etc.)
  envVars?: Record<string, string>;  // '%s' replaced by mapped level

  /**
   * Native flag/key names whose presence in args suppresses auto-injection.
   * Strategy-aware detection: exact+= for cli-flag, substring for cli-config.
   */
  userOverrideFlags?: string[];
}
```

Add `reasoningEffort?: ReasoningEffortConfig` to `AgentMetadata` (near `flagMappings`).

**No change to `AgentConfig`** — the central applier reads `env.CODEMIE_REASONING_EFFORT` directly.

### `src/env/types.ts`

Add to `ProviderProfile`:
```ts
reasoningEffort?: CanonicalReasoningEffort;
```

---

## 6. AgentCLI plumbing — `src/agents/core/AgentCLI.ts`

### `setupProgram`

```ts
.option('--reasoning-effort <level>', 'Reasoning/thinking effort: minimal|low|medium|high|xhigh|max')
.option('--resume <session-id>', 'Resume an existing session by ID')
```

### `collectPassThroughArgs`

- Add `'reasoningEffort'` to `configOnlyOptions` — not forwarded verbatim to the agent.
- Do **not** add `'resume'` — it must flow through to per-agent flag transforms / enrichArgs.

### `handleRun` — validation (after `ConfigLoader.load`)

```ts
// Validate reasoning effort (catches both CLI flag and profile default)
const normalizedEffort = config.reasoningEffort
  ? normalizeReasoningEffort(config.reasoningEffort)
  : undefined;
if (config.reasoningEffort && !normalizedEffort) {
  console.error(chalk.red(`\n✗ Invalid --reasoning-effort '${config.reasoningEffort}'`));
  console.error(chalk.white('  Valid values: minimal, low, medium, high, xhigh, max\n'));
  logger.error(`Invalid --reasoning-effort value '${config.reasoningEffort}'`);
  process.exit(1);
}
if (normalizedEffort) {
  config.reasoningEffort = normalizedEffort;  // store canonical lowercase
}

// Validate resume
if (options.resume !== undefined && !options.resume) {
  console.error(chalk.red('\n✗ --resume requires a session id\n'));
  process.exit(1);
}
```

### `handleRun` — ConfigLoader overrides

```ts
ConfigLoader.load(cwd, { name, provider, model, apiKey, baseUrl, timeout, reasoningEffort: options.reasoningEffort })
```

### `exportProviderEnvVars` — `src/utils/config.ts`

```ts
if (config.reasoningEffort) env.CODEMIE_REASONING_EFFORT = config.reasoningEffort;
```

---

## 7. BaseAgentAdapter integration — `src/agents/core/BaseAgentAdapter.ts`

After `transformedArgs = transformFlags(enrichedArgs, metadata.flagMappings, config)` and **before** the `Executing:` debug log:

```ts
if (this.metadata.reasoningEffort && env.CODEMIE_REASONING_EFFORT) {
  const { applyReasoningEffort } = await import('./reasoning-effort.js');
  transformedArgs = applyReasoningEffort(
    transformedArgs,
    env,
    this.metadata.reasoningEffort,
    env.CODEMIE_REASONING_EFFORT,
    this.metadata.name,
  ).args;
} else if (env.CODEMIE_REASONING_EFFORT) {
  // Agent has no reasoningEffort block — warn and continue (§6.4)
  logger.warn(`[${this.metadata.name}] --reasoning-effort is set but not supported; ignoring`);
  console.error(chalk.yellow(`⚠  --reasoning-effort is not supported for ${this.displayName}; ignoring.`));
}
```

**Placement rationale:** after `transformFlags`, the args have their final flag names; `CODEMIE_REASONING_EFFORT` is set at this point (exported by `exportProviderEnvVars` before `run` is called). The `Executing:` debug log therefore shows the fully-resolved args including the injected effort flag.

**No change to `extractConfig`** (D3).

---

## 8. Per-agent metadata

### claude — `src/agents/plugins/claude/claude.plugin.ts`

```ts
reasoningEffort: {
  strategy: 'cli-flag',
  flag: '--effort',
  placement: 'append',
  supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  userOverrideFlags: ['--effort'],
},
```

Adds to `flagMappings`:
```ts
'--resume': { type: 'flag', target: '-r' },
```

Result: `claude -p "T" --effort high -r <id>` (order-insensitive for claude).

### codex — `src/agents/plugins/codex/codex.plugin.ts`

```ts
reasoningEffort: {
  strategy: 'cli-config',
  configFlag: '--config',
  configKey: 'model_reasoning_effort',
  placement: 'prepend',
  supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  userOverrideFlags: ['model_reasoning_effort'],
},
```

`enrichArgs` extension (handles both resume cases):

```ts
const resumeIdx = enriched.indexOf('--resume');
const resumeId  = resumeIdx !== -1 ? enriched[resumeIdx + 1] : undefined;
// strip --resume <id> pair
if (resumeId) enriched.splice(resumeIdx, 2);

if (taskValue !== undefined) {
  // headless: exec [resume <id>] <task>
  const head = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
  enriched = [...head, ...rest, taskValue];
} else if (resumeId) {
  // interactive resume
  enriched = ['resume', resumeId, ...rest];
}
// else: no --task, no --resume → existing interactive behavior
```

Result: `codex --config model_reasoning_effort="high" --model M exec resume <id> "T"` (effort prepended before subcommand).

> **Verify during implementation:** `codex resume --help` to confirm top-level `resume <id>` arg signature.

> **Q4 live-run:** confirm the full Kimi env bundle is sufficient with one real `codemie-kimi --reasoning-effort high --task …` run and inspect for thinking in the response.

### opencode — `src/agents/plugins/opencode/opencode.plugin.ts`

```ts
reasoningEffort: {
  strategy: 'cli-flag',
  flag: '--variant',
  placement: 'append',
  supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  userOverrideFlags: ['--variant'],
},
flagMappings: { '--resume': { type: 'flag', target: '-s' } },
```

Arg flow: `['--task', t, '--resume', id]` → `enrichArgs` → `['run', t, '--resume', id]` → `transformFlags` → `['run', t, '-s', id]` → central applier → `['run', t, '-s', id, '--variant', 'high']`.

Result: `opencode run "T" -s <id> --variant high`.

### kimi — `src/agents/plugins/kimi/kimi.plugin.ts`

```ts
reasoningEffort: {
  strategy: 'env',
  envVars: {
    KIMI_MODEL_THINKING_MODE: 'on',
    KIMI_MODEL_THINKING_EFFORT: '%s',
    KIMI_MODEL_CAPABILITIES: 'thinking',
    KIMI_MODEL_DEFAULT_THINKING: 'true',
  },
  supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
},
```

Adds to `flagMappings`:
```ts
'--resume': { type: 'flag', target: '-S' },
```

Result: `kimi -p "T" -S <id>` with env `KIMI_MODEL_NAME=M`, `KIMI_MODEL_THINKING_MODE=on`, `KIMI_MODEL_THINKING_EFFORT=high`, `KIMI_MODEL_CAPABILITIES=thinking`, `KIMI_MODEL_DEFAULT_THINKING=true`.

---

## 9. Edge cases

| Scenario | Behavior |
|---|---|
| No `--reasoning-effort` | Unchanged from today; no injection, no new env vars |
| `--reasoning-effort ultra` (invalid) | `console.error` (red) + exit 1; also catches bad profile defaults |
| Effort without `--model` | Allowed; agent's configured/default model is used |
| Agent without `reasoningEffort` block (e.g. gemini) | `console.error` (yellow ⚠) to stderr + `logger.warn` to file; continues |
| Clamping (codex `max` → `xhigh`) | Dim/cyan advisory to stderr + `logger.debug` to file |
| User already passed native flag (e.g. `--effort` in pass-through) | `userOverrideFlags` match → skip injection + `logger.debug` |
| `--resume ""` | `console.error` (red) + exit 1 |
| `--resume <id>` + `--task` | Native resume invocation for all four agents |
| `--resume <id>` without `--task` | Interactive for claude/kimi/opencode (flag rename, no `-p`); `codex resume <id>` for codex |
| Unknown/expired session id | Delegated to underlying CLI; non-zero exit surfaced unchanged |

---

## 10. File-by-file change list

| # | File | Change |
|---|---|---|
| 1 | `src/agents/core/reasoning-effort.ts` | **NEW**: `CANONICAL_EFFORT_ORDER`, `normalizeReasoningEffort`, `clampToSupported` (pure), `applyReasoningEffort` |
| 2 | `src/agents/core/types.ts` | Add `CanonicalReasoningEffort`, `ReasoningEffortStrategy`, `ReasoningEffortConfig`; add `reasoningEffort?` to `AgentMetadata` |
| 3 | `src/agents/core/AgentCLI.ts` | Register `--reasoning-effort`, `--resume`; add `'reasoningEffort'` to `configOnlyOptions`; validate post-merge; pass `reasoningEffort` into `ConfigLoader.load` |
| 4 | `src/agents/core/BaseAgentAdapter.ts` | Apply central injection after `transformFlags`; add `else if` warn for unsupported agents |
| 5 | `src/env/types.ts` | Add `reasoningEffort?: CanonicalReasoningEffort` to `ProviderProfile` |
| 6 | `src/utils/config.ts` | `exportProviderEnvVars`: emit `CODEMIE_REASONING_EFFORT` |
| 7 | `src/agents/plugins/claude/claude.plugin.ts` | Add `reasoningEffort` block; add `--resume` → `-r` to `flagMappings` |
| 8 | `src/agents/plugins/codex/codex.plugin.ts` | Add `reasoningEffort` block; extend `enrichArgs` for both resume cases |
| 9 | `src/agents/plugins/opencode/opencode.plugin.ts` | Add `reasoningEffort` block; add `flagMappings: {'--resume': {type:'flag', target:'-s'}}` |
| 10 | `src/agents/plugins/kimi/kimi.plugin.ts` | Add `reasoningEffort` block (env strategy, full bundle); add `--resume` → `-S` to `flagMappings` |

---

## 11. Acceptance criteria

- `codemie-<agent> --model M --reasoning-effort high --task "T"` produces:
  - claude → `claude -p "T" --effort high` with `ANTHROPIC_MODEL=M`
  - codex → `codex --config model_reasoning_effort="high" --model M exec "T"`
  - opencode → `opencode run "T" --variant high` with config model M
  - kimi → `kimi -p "T"` with `KIMI_MODEL_NAME=M` + all four `KIMI_MODEL_THINKING_*` env vars
- `--reasoning-effort` accepts `minimal|low|medium|high|xhigh|max` (case-insensitive); others exit 1 with visible error (also catches profile defaults)
- `--reasoning-effort max` on codex clamps to `xhigh` with dim/cyan advisory
- `minimal` on claude/kimi clamps to `low`
- Omitting `--reasoning-effort` → today's exact behavior (no injection, no new env)
- Explicit native effort flags in pass-through args suppress injection (no double-injection)
- `--reasoning-effort` works in interactive mode (no `--task`); does not enable silent mode
- Agent without `reasoningEffort` block → yellow warning to stderr + continues (no abort)
- `--help` for each wrapper lists `--reasoning-effort` (canonical values) and `--resume <session-id>`
- `codemie-<agent> --model M --reasoning-effort high --resume <id> --task "T"` produces native resume invocation for all four agents
- `--resume ""` exits 1 with visible error
- Omitting `--resume` → fresh session (today's behavior)
- `codemie-codex --resume <id>` (no `--task`) → interactive `codex resume <id>`

---

## 12. Open verification item

**Q4 (Kimi env bundle):** After implementation, run one live `codemie-kimi --reasoning-effort high --task "summarise the file list"` and inspect the response for thinking/reasoning content. If thinking does not activate, add `KIMI_MODEL_PROVIDER_TYPE` / `KIMI_MODEL_MAX_CONTEXT_SIZE` to the env bundle.
