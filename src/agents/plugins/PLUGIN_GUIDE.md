# Plugin Authoring Guide

Reference for adding a new agent plugin to CodeMie. Read this before touching any plugin file.

---

## Checklist: minimum files for a new plugin

| File | Required | Purpose |
|---|---|---|
| `<agent>/<agent>.plugin.ts` | Yes | Metadata object + class extending `BaseAgentAdapter` |
| `<agent>/<agent>.session.ts` | Yes | Class extending `AbstractBaseSessionAdapter` |
| `<agent>/session/processors/<agent>.metrics-processor.ts` | Yes | Extracts tool usage to `MetricDelta` JSONL |
| `<agent>/session/processors/<agent>.conversations-processor.ts` | Yes | Extracts conversation history to JSONL |
| `<agent>/__tests__/` | Yes | Plugin lifecycle smoke, `enrichArgs` unit, metrics processor fixture |

---

## What the base handles — do not override

| Behaviour | How to enable |
|---|---|
| npm install / uninstall | Provided by `BaseAgentAdapter`; set `metadata.npmPackage` |
| Version compatibility check | Provided by `BaseAgentAdapter`; set `supportedVersion` + `minimumSupportedVersion` |
| Semver extraction from `--version` output | Set `metadata.dataPaths.binary` for native-path first; base parses `/(\d+\.\d+\.\d+)/` |
| Native binary path check in `isInstalled` | Set `metadata.dataPaths.binary`; base tries it before PATH |
| Processor registration + priority sort | Extend `AbstractBaseSessionAdapter`; call `this.registerProcessor()` in `initializeProcessors()` |

---

## When you MUST override

- **Native installer** — override `install()` / `installVersion()` when the agent ships a shell-script installer (not npm). See `claude.plugin.ts` and `kimi.plugin.ts` for examples.
- **Arg enrichment** — override `lifecycle.enrichArgs` for any transformation beyond the `flagMappings` config (subcommand injection, model provider config, etc.).
- **Hook transformer** — implement `getHookTransformer()` when the agent emits non-standard hook event names. See `gemini.hook-transformer.ts` and `kimi.hook-transformer.ts`.

---

## Required metadata fields

```typescript
const metadata: AgentMetadata = {
  name: 'myagent',                     // snake_case; used as CLI selector and log prefix
  displayName: 'My Agent CLI',         // human-readable
  description: 'One-sentence summary',
  npmPackage: '@vendor/myagent',        // omit if native-only
  cliCommand: 'myagent',

  supportedVersion: '1.2.3',           // latest version tested with CodeMie backend
  minimumSupportedVersion: '1.1.0',    // rule: ~10 patch/minor versions below supportedVersion

  dataPaths: {
    home: '.myagent',                  // required; e.g. ~/.myagent
    binary: '.myagent/bin/myagent',    // set when agent installs outside PATH on Unix
  },

  envMapping: {
    baseUrl: ['MYAGENT_BASE_URL'],     // CODEMIE_BASE_URL is written here
    apiKey:  ['MYAGENT_API_KEY'],      // CODEMIE_API_KEY is written here
    model:   ['MYAGENT_MODEL'],        // CODEMIE_MODEL is written here (empty [] = not forwarded)
  },

  supportedProviders: ['ai-run-sso', 'litellm', 'bearer-auth'],
  ssoConfig: { enabled: true, clientType: 'codemie-myagent' },

  extensionsConfig: {
    project: '.myagent',
    global: '~/.myagent',
    skillsEntryFile: 'SKILL.md',
  },
};
```

---

## Async rules

### Dynamic imports in lifecycle hooks are intentional

`await import(...)` inside `beforeRun` / `onSessionEnd` avoids circular dependencies at module load time. Do not hoist these to top-level `import` statements.

```typescript
// Correct — dynamic import inside lifecycle hook
async beforeRun(env) {
  const { processEvent } = await import('../../../cli/commands/hook.js');
  await processEvent(...);
  return env;
}
```

### Fire-and-forget pattern

Use `void promise.catch(err => logger.debug(...))` for non-blocking side effects (e.g. stale session reconciliation, incremental sync start). Never leave a bare `void` with no `.catch()`.

```typescript
// Correct
void reconcileStale(env).catch(err => {
  logger.debug(`[myagent] Reconciliation failed (non-blocking): ${err instanceof Error ? err.message : err}`);
});

// Wrong — unhandled rejection
void reconcileStale(env);
```

### `isInstalled()` must be side-effect free

No writes to stdout, no mutations, no file creation. `logger.debug()` (file-only) is acceptable. This method is called by `codemie doctor` and must not produce output or side effects.

### `onSessionEnd` failures must never throw

Metrics or sync failure must be caught and swallowed — an uncaught error here blocks agent process exit.

```typescript
async onSessionEnd(exitCode, env) {
  try {
    await processMetrics(env);
  } catch (error) {
    // Non-fatal — log and continue
    logger.error(`[myagent] Metrics processing failed (non-blocking): ${error instanceof Error ? error.message : error}`);
  }
}
```

---

## Testing rules

### Unit-test `enrichArgs` and version parsing

These are pure transformations. Test them without any I/O, mocks, or subprocess calls.

```typescript
// Example: enrichArgs test
it('prepends --model when config.model is set', () => {
  const result = metadata.lifecycle!.enrichArgs!(['--task', 'do something'], { model: 'my-model' } as AgentConfig);
  expect(result[0]).toBe('--model');
  expect(result[1]).toBe('my-model');
});
```

### Use fixture JSONL/JSON files for processor tests

Place fixtures in `__tests__/fixtures/`, named for the scenario they cover — not for dates or versions.

```
__tests__/fixtures/
  session-empty.jsonl           # empty session — processor returns no deltas
  session-single-turn.jsonl     # one user prompt, one assistant response with tool use
  session-error-response.jsonl  # API error in assistant message
```

### Mock the filesystem, not the adapter

Pass a fixture file path into the processor under test. Do not mock the session adapter.

```typescript
it('extracts one delta per assistant turn', async () => {
  const processor = new MyAgentMetricsProcessor();
  const session = await adapter.parseSessionFile(
    path.join(__dirname, 'fixtures/session-single-turn.jsonl'),
    'test-session-id',
  );
  const result = await processor.process(session, mockContext);
  expect(result.success).toBe(true);
});
```

### Don't test lifecycle hooks with real subprocesses

Inject env vars and spy on `processEvent`. No end-to-end agent invocations in unit tests.

```typescript
it('calls processEvent with SessionStart on session start', async () => {
  const processEvent = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../../cli/commands/hook.js', () => ({ processEvent }));
  await plugin.metadata.lifecycle!.onSessionStart!('test-id', { CODEMIE_URL: 'http://local' });
  expect(processEvent).toHaveBeenCalledWith(
    expect.objectContaining({ hook_event_name: 'SessionStart' }),
    expect.any(Object),
  );
});
```

### One fixture per edge case

Each fixture covers exactly one scenario. Prefer fewer, named fixtures over large catch-all files.
