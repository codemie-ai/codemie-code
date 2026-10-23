/**
 * Shell Hooks Plugin Source for OpenCode 2.x.
 *
 * Same delivery contract as the v1 payload (`shell-hooks-source.ts`): reads
 * hooks configuration from the OPENCODE_HOOKS environment variable (set by
 * the CodeMie CLI before every launch, both schemas) with `.opencode/hooks.json`
 * as fallback, matches tool events by pattern, and invokes `codemie hook`
 * with the Anthropic-format stdin payload.
 *
 * Only the registration surface differs (v2 plugin API, source-verified
 * against 2.0.27):
 * - `export default Plugin.define({ id, setup })` from `@opencode/plugin`
 *   instead of the flat dotted-key handler map;
 * - `ctx.session.hook("prompt", …)` instead of `"chat.message"` (single
 *   mutable event; runs before durable prompt admission, so delivery is
 *   detached-spawn and never blocks);
 * - `ctx.event.subscribe()` instead of `"event"` (turn end is the durable
 *   session.execution.* lifecycle; `session.status`/`session.idle` branches
 *   stay as fallback);
 * - `ctx.tool.hook("execute.before"/"execute.after")` instead of
 *   `"tool.execute.before/after"`;
 * - `ctx.session.hook("compaction", …)` instead of
 *   `"experimental.session.compacting"`;
 * - cleanup function returned by `setup` instead of `dispose`.
 *
 * The code shared with the 1.x payload (matcher, config loading, shell execution,
 * response parsing, idle de-duplication) lives in `shell-hooks-common-source.ts`;
 * only the registration surface and the session-id lookup are defined here.
 *
 * Session id: taken from the hook event (`event.sessionID`, or
 * `event.properties.sessionID` for bus events). `codemie hook` rejects an
 * empty session_id with exit code 2, so a hook with no resolvable session id
 * is skipped rather than invoked.
 *
 * Why a string constant: same reason as v1 — the payload imports
 * `@opencode/plugin`, which doesn't exist in this package's dependencies.
 * At runtime it is written to `<tmpdir>/codemie-hooks/shell-hooks-v2/index.ts`
 * and loaded by the OpenCode 2.x binary (directory-only scanner).
 */

import { SHELL_HOOKS_COMMON_SOURCE } from './shell-hooks-common-source.js';

export const SHELL_HOOKS_V2_PLUGIN_SOURCE = `
import { Plugin } from "@opencode/plugin";
${SHELL_HOOKS_COMMON_SOURCE}
// ─── Session Id (v2 event shapes) ────────────────────────────────────────────

// OPENCODE_SESSION_ID is a last-resort fallback only: nothing sets it today, and
// relying on it is what made every previous hook invocation ship an empty
// session_id and get rejected with exit code 2.
function resolveSessionId(input: any): string {
  return (
    input?.sessionID ||
    input?.data?.sessionID ||
    input?.properties?.sessionID ||
    input?.properties?.info?.id ||
    process.env.OPENCODE_SESSION_ID ||
    ""
  );
}

/** Fire a command list without blocking the caller (detached spawn). */
function fireCommands(
  event: HookEventName,
  sessionId: string,
  payload: HookStdinPayload,
  commands: Array<{ command: string; timeout: number; isAsync: boolean }>,
): void {
  const env = buildEnvVars(sessionId, event);
  const stdin = JSON.stringify(payload);
  for (const cmd of commands) {
    execCommandAsync(cmd.command, stdin, env);
  }
}

// ─── Plugin Definition (v2 API) ──────────────────────────────────────────────

const config = loadHooksConfig();

export default Plugin.define({
  id: "codemie-hooks",
  async setup(ctx) {
    // UserPromptSubmit → session "prompt" hook. Marks the start of an active
    // period; codemie hook forwards it to SessionStore.startActivityTracking.
    // Detached spawn: this hook runs before durable prompt admission, so it
    // must return immediately and never block on the child.
    await ctx.session.hook("prompt", (event: any) => {
      const sessionId = resolveSessionId(event);
      if (!sessionId) return;

      // A new prompt opens a new active period, so the session is busy again.
      // Clearing the flag here is what lets the NEXT idle emit a Stop.
      idleState.set(sessionId, false);

      const commands = getMatchingCommands(config, "UserPromptSubmit");
      if (commands.length === 0) return;

      const payload = basePayload("UserPromptSubmit", sessionId);
      payload.prompt = typeof event?.prompt?.text === "string" ? event.prompt.text : "";

      fireCommands("UserPromptSubmit", sessionId, payload, commands);
    });

    // PreToolUse → tool "execute.before" (blocking; only this hook may fail —
    // a throw rejects the tool call, matching the v1 throw-on-block).
    await ctx.tool.hook("execute.before", (event: any) => {
      const commands = getMatchingCommands(config, "PreToolUse", event?.tool);
      if (commands.length === 0) return;

      const sessionId = resolveSessionId(event);
      if (!sessionId) return;

      const payload = basePayload("PreToolUse", sessionId);
      payload.tool_name = event?.tool;
      payload.tool_input = (event?.input ?? {}) as Record<string, unknown>;

      const env = buildEnvVars(sessionId, "PreToolUse");
      const stdin = JSON.stringify(payload);
      for (const cmd of commands) {
        const parsed = parseResponse(execCommand(cmd.command, stdin, env, cmd.timeout), "PreToolUse");
        if (parsed.blocked) {
          throw new Error(parsed.reason || "Hook blocked tool execution");
        }
        if (parsed.updatedInput && event) {
          event.input = { ...((event.input as Record<string, unknown>) || {}), ...parsed.updatedInput };
        }
      }
    });

    // PostToolUse → tool "execute.after" (fire-and-forget).
    await ctx.tool.hook("execute.after", (event: any) => {
      const commands = getMatchingCommands(config, "PostToolUse", event?.tool);
      if (commands.length === 0) return;

      const sessionId = resolveSessionId(event);
      if (!sessionId) return;

      const payload = basePayload("PostToolUse", sessionId);
      payload.tool_name = event?.tool;
      const output = event?.status === "completed" ? event?.result : event?.error;
      payload.tool_output = typeof output === "string" ? output : JSON.stringify(output ?? null);

      fireCommands("PostToolUse", sessionId, payload, commands);
    });

    // PreCompact → session "compaction" hook (non-blocking; additional
    // context is appended to the compaction system prompt).
    await ctx.session.hook("compaction", (event: any) => {
      const commands = getMatchingCommands(config, "PreCompact");
      if (commands.length === 0) return;

      const sessionId = resolveSessionId(event);
      if (!sessionId) return;

      const payload = basePayload("PreCompact", sessionId);
      const env = buildEnvVars(sessionId, "PreCompact");
      const stdin = JSON.stringify(payload);
      for (const cmd of commands) {
        try {
          const parsed = parseResponse(execCommand(cmd.command, stdin, env, cmd.timeout), "PreCompact");
          if (parsed.additionalContext && event) {
            event.system.push({ type: "text", text: parsed.additionalContext });
          }
        } catch {
          // Fire-and-forget: a failing compaction hook must never break the session.
        }
      }
    });

    // Stop / Notification → event bus (non-blocking).
    // SessionStart and SessionEnd are deliberately NOT mapped here: session.created
    // and session.deleted do not correspond to CLI process start/exit, and the
    // CodeMie CLI raises both lifecycle events in-process instead.
    const controller = new AbortController();
    (async () => {
      for await (const busEvent of ctx.event.subscribe({ signal: controller.signal })) {
        const eventType = (busEvent as any)?.type;
        if (typeof eventType !== "string") continue;

        const sessionId = resolveSessionId(busEvent);
        if (!sessionId) continue;

        // One bus event can map to several hooks: a failed execution is both a
        // turn boundary (Stop) and an error (Notification).
        const hookEvents: HookEventName[] = [];
        let message: string | undefined;

        // v2 turn boundaries are the durable execution-lifecycle events
        // (core publishes session.execution.* — session.status/session.idle
        // are schema-only in 2.0.27, derived client-side, never on the bus;
        // their branches below stay as fallback for other versions).
        if (eventType === "session.execution.started") {
          // Busy again without a new prompt (resume/retry): clear the flag
          // so the matching end event emits a Stop. No hook fires here —
          // the prompt hook already delivered UserPromptSubmit.
          idleState.set(sessionId, false);
          continue;
        } else if (
          eventType === "session.execution.succeeded" ||
          eventType === "session.execution.failed" ||
          eventType === "session.execution.interrupted"
        ) {
          if (shouldEmitIdle(sessionId, true)) hookEvents.push("Stop");
          // The legacy session.error event is not published by 2.0.x core;
          // v2 reports errors as session.execution.failed carrying
          // data.error.message, so that is where Notification comes from.
          // Not gated by the idle collapse: every failure is a real error.
          if (eventType === "session.execution.failed") {
            hookEvents.push("Notification");
            const errorMessage = (busEvent as any)?.data?.error?.message;
            if (typeof errorMessage === "string") message = errorMessage;
          }
        } else if (eventType === "session.idle") {
          if (shouldEmitIdle(sessionId, true)) hookEvents.push("Stop");
        } else if (eventType === "session.status") {
          // Bus envelope is { type, data }; v1 used properties — not data.
          const isIdle = (busEvent as any)?.data?.status?.type === "idle";
          if (shouldEmitIdle(sessionId, isIdle)) hookEvents.push("Stop");
        } else if (eventType === "session.error") {
          // Legacy fallback for versions that still publish it.
          hookEvents.push("Notification");
        }

        for (const hookEvent of hookEvents) {
          const commands = getMatchingCommands(config, hookEvent);
          if (commands.length === 0) continue;

          const payload = basePayload(hookEvent, sessionId);
          if (hookEvent === "Notification" && message !== undefined) payload.message = message;
          fireCommands(hookEvent, sessionId, payload, commands);
        }
      }
    })();

    return () => controller.abort();
  },
});
`;
