/** Internal agent key. Canonical everywhere: the `--agent copilot-cli-otlp` flag */
export const COPILOT_CLI_OTLP_AGENT_NAME = 'copilot-cli-otlp';

/**
 * `--event` values the connector's hook file entries pass to `codemie hook`, exactly as
 * GitHub's camelCase native event names (the CLI payload itself carries no event-name field).
 * `userPromptSubmitted` and `permissionRequest` are deliberately not installed:
 * prompt telemetry is owned entirely by `userPromptTransformed`, and
 * `permissionRequest`'s input schema is undocumented.
 */
export const CLI_HOOK_EVENT_NAMES = [
  'sessionStart',
  'sessionEnd',
  'userPromptTransformed',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'agentStop',
  'subagentStart',
  'subagentStop',
  'errorOccurred',
  'preCompact',
  'notification',
] as const;
