/**
 * Cursor IDE stdout response contract.
 *
 * Cursor reads a JSON object off the hook process's stdout to decide how to
 * proceed for a subset of its events - `{"permission":"allow"}` for
 * tool-permission events, `{"continue":true}` for `beforeSubmitPrompt`.
 * Every other event reads nothing from stdout, so this writer emits nothing
 * for them: an unexpected stdout payload is exactly as unsafe here as a
 * missing one.
 *
 * This module never decides *whether* to run - it is wired in declaratively
 * via `AgentHookConfig.writeStdoutResponse` (see cursor-ide.plugin.ts), so
 * `hook.ts` never needs an `if (agentName === 'cursor-ide')` branch to call
 * it only for this agent.
 *
 * See: https://cursor.com/docs/hooks
 */

const ALLOW_RESPONSE = JSON.stringify({ permission: 'allow' });
const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

/**
 * Cursor-native event names (not the internal names they map onto) that
 * carry a response contract.
 */
const CURSOR_STDOUT_RESPONSES: Readonly<Record<string, string>> = {
  preToolUse: ALLOW_RESPONSE,
  beforeShellExecution: ALLOW_RESPONSE,
  beforeMCPExecution: ALLOW_RESPONSE,
  beforeReadFile: ALLOW_RESPONSE,
  beforeTabFileRead: ALLOW_RESPONSE,
  subagentStart: ALLOW_RESPONSE,
  beforeSubmitPrompt: CONTINUE_RESPONSE,
};

/**
 * Writes Cursor's expected stdout response for `nativeEventName`, if any.
 * A no-op for every event outside the response matrix above.
 *
 * @param nativeEventName - The Cursor-native event name (`hook_event_name`
 *   on the raw/transformed payload - never the internal name it maps onto).
 */
export function writeCursorResponse(nativeEventName: string): void {
  const response = CURSOR_STDOUT_RESPONSES[nativeEventName];
  if (response) {
    process.stdout.write(`${response}\n`);
  }
}
