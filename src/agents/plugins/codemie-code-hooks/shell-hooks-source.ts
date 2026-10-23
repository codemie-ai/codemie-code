/**
 * Shell Hooks Plugin Source
 *
 * Contains the OpenCode plugin TypeScript source as a string constant.
 * At runtime this is written to a temp file and loaded by the OpenCode binary.
 *
 * The plugin reads hooks configuration from the OPENCODE_HOOKS environment variable
 * (Anthropic/Claude Code format) and maps them to OpenCode plugin lifecycle hooks.
 *
 * Why a string constant: The plugin uses `import type { Plugin } from "@opencode-ai/plugin"`
 * which doesn't exist in this package's dependencies. Embedding as a string avoids
 * TypeScript compilation issues. Bun strips the type import at runtime.
 *
 * PLUGIN CONTRACT — see reasoning-sanitizer-source.ts for the reference shape:
 * a Plugin is an async factory returning a FLAT map of dotted-key handlers, and
 * each handler takes `(input, output)` and MUTATES `output`. Returned values are
 * discarded. An earlier version of this file exported a plain object with nested
 * `hooks: { tool: { execute: { before } } }` keys and returned values from every
 * handler, so none of it ever ran.
 *
 * The code shared with the 2.x payload (matcher, config loading, shell execution,
 * response parsing, idle de-duplication) lives in `shell-hooks-common-source.ts`;
 * only the registration surface and the session-id lookup are defined here.
 *
 * Session id: taken from the payload OpenCode passes in (`input.sessionID`, or
 * `input.event.properties.sessionID` for bus events). `codemie hook` rejects an
 * empty session_id with exit code 2, so a hook with no resolvable session id is
 * skipped rather than invoked.
 */

import { SHELL_HOOKS_COMMON_SOURCE } from './shell-hooks-common-source.js';

export const SHELL_HOOKS_PLUGIN_SOURCE = `
import type { Plugin } from "@opencode-ai/plugin";
${SHELL_HOOKS_COMMON_SOURCE}
// ─── Session Id (v1 event shapes) ────────────────────────────────────────────

// OPENCODE_SESSION_ID is a last-resort fallback only: nothing sets it today, and
// relying on it is what made every previous hook invocation ship an empty
// session_id and get rejected with exit code 2.
function resolveSessionId(input: any): string {
  return (
    input?.sessionID ||
    input?.event?.properties?.sessionID ||
    input?.event?.properties?.info?.id ||
    process.env.OPENCODE_SESSION_ID ||
    ""
  );
}

/** Run every configured command for an event. Returns the parsed responses. */
function runCommands(
  event: HookEventName,
  sessionId: string,
  payload: HookStdinPayload,
  commands: Array<{ command: string; timeout: number; isAsync: boolean }>,
  swallowErrors: boolean,
): ParsedResponse[] {
  const env = buildEnvVars(sessionId, event);
  const stdin = JSON.stringify(payload);
  const responses: ParsedResponse[] = [];

  for (const cmd of commands) {
    if (cmd.isAsync) {
      execCommandAsync(cmd.command, stdin, env);
      continue;
    }
    if (swallowErrors) {
      try {
        responses.push(parseResponse(execCommand(cmd.command, stdin, env, cmd.timeout), event));
      } catch {
        // Fire-and-forget events must never break the session.
      }
      continue;
    }
    responses.push(parseResponse(execCommand(cmd.command, stdin, env, cmd.timeout), event));
  }

  return responses;
}

// ─── Plugin Definition ───────────────────────────────────────────────────────

const config = loadHooksConfig();

const ShellHooksPlugin: Plugin = async (_input) => ({
  // PreToolUse → tool.execute.before (blocking; mutate output.args)
  "tool.execute.before": async (input: any, output: any) => {
    const commands = getMatchingCommands(config, "PreToolUse", input?.tool);
    if (commands.length === 0) return;

    const sessionId = resolveSessionId(input);
    if (!sessionId) return;

    const payload = basePayload("PreToolUse", sessionId);
    payload.tool_name = input?.tool;
    payload.tool_input = output?.args as Record<string, unknown>;

    for (const parsed of runCommands("PreToolUse", sessionId, payload, commands, false)) {
      if (parsed.blocked) {
        throw new Error(parsed.reason || "Hook blocked tool execution");
      }
      if (parsed.updatedInput && output) {
        output.args = { ...(output.args || {}), ...parsed.updatedInput };
      }
    }
  },

  // PostToolUse → tool.execute.after (fire-and-forget)
  "tool.execute.after": async (input: any, output: any) => {
    const commands = getMatchingCommands(config, "PostToolUse", input?.tool);
    if (commands.length === 0) return;

    const sessionId = resolveSessionId(input);
    if (!sessionId) return;

    const payload = basePayload("PostToolUse", sessionId);
    payload.tool_name = input?.tool;
    payload.tool_output =
      typeof output?.output === "string" ? output.output : JSON.stringify(output?.output ?? null);

    runCommands("PostToolUse", sessionId, payload, commands, true);
  },

  // UserPromptSubmit → chat.message. Marks the start of an active period;
  // codemie hook forwards it to SessionStore.startActivityTracking.
  "chat.message": async (input: any, output: any) => {
    const sessionId = resolveSessionId(input);
    if (!sessionId) return;

    // A new prompt opens a new active period, so the session is busy again.
    // Clearing the flag here is what lets the NEXT idle emit a Stop: on a build
    // that publishes session.idle without session.status, nothing else ever
    // resets it, so every turn after the first would be suppressed and
    // active_duration_ms would count only turn one.
    idleState.set(sessionId, false);

    const commands = getMatchingCommands(config, "UserPromptSubmit");
    if (commands.length === 0) return;

    // The message parts live on output, not input.
    const parts = output?.parts;
    const payload = basePayload("UserPromptSubmit", sessionId);
    payload.prompt = Array.isArray(parts)
      ? parts
          .filter((p: any) => p?.type === "text")
          .map((p: any) => p.text)
          .join("\\n")
      : "";

    runCommands("UserPromptSubmit", sessionId, payload, commands, true);
  },

  // PreCompact → experimental.session.compacting (non-blocking)
  "experimental.session.compacting": async (input: any, output: any) => {
    const commands = getMatchingCommands(config, "PreCompact");
    if (commands.length === 0) return;

    const sessionId = resolveSessionId(input);
    if (!sessionId) return;

    const responses = runCommands(
      "PreCompact", sessionId, basePayload("PreCompact", sessionId), commands, true
    );

    for (const parsed of responses) {
      if (parsed.additionalContext && output) {
        output.context = (output.context || "") + "\\n" + parsed.additionalContext;
      }
    }
  },

  // Stop / Notification → event bus (non-blocking).
  // SessionStart and SessionEnd are deliberately NOT mapped here: session.created
  // and session.deleted do not correspond to CLI process start/exit, and the
  // CodeMie CLI raises both lifecycle events in-process instead.
  "event": async (input: any) => {
    const eventType = input?.event?.type;
    if (typeof eventType !== "string") return;

    const sessionId = resolveSessionId(input);
    if (!sessionId) return;

    let hookEvent: HookEventName | undefined;

    if (eventType === "session.idle") {
      if (!shouldEmitIdle(sessionId, true)) return;
      hookEvent = "Stop";
    } else if (eventType === "session.status") {
      const isIdle = input?.event?.properties?.status?.type === "idle";
      if (!shouldEmitIdle(sessionId, isIdle)) return;
      hookEvent = "Stop";
    } else if (eventType === "session.error") {
      hookEvent = "Notification";
    }

    if (!hookEvent) return;

    const commands = getMatchingCommands(config, hookEvent);
    if (commands.length === 0) return;

    runCommands(hookEvent, sessionId, basePayload(hookEvent, sessionId), commands, true);
  },
});

export default ShellHooksPlugin;
`;
