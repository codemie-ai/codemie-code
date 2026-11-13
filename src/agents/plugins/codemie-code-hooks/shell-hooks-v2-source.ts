/**
 * Shell Hooks Plugin Source — OpenCode v2
 *
 * Same job as SHELL_HOOKS_PLUGIN_SOURCE (run the OPENCODE_HOOKS commands at OpenCode lifecycle
 * points), written against the OpenCode v2 plugin API, which shares nothing with v1's:
 *
 * - The default export is a definition `{ id, setup }`, not a factory returning dotted-key
 *   handlers. OpenCode v2 rejects a v1 plugin outright.
 * - Hooks are registered on the domain that owns the operation (`ctx.tool`, `ctx.session`) and
 *   receive ONE mutable event instead of separate `input` / `output` objects.
 * - Bus events come from the `ctx.event.subscribe()` stream; their payload is `event.data`.
 *
 * No import from "@opencode/plugin": the definition is a plain object, so the temp directory
 * the source is written to needs no node_modules.
 */

import { SHELL_HOOKS_SHARED_SOURCE } from './shell-hooks-source.js';

export const SHELL_HOOKS_V2_PLUGIN_SOURCE = `${SHELL_HOOKS_SHARED_SOURCE}
// ─── Plugin Definition (OpenCode v2) ─────────────────────────────────────────

const config = loadHooksConfig();

/** A tool result as the text a PostToolUse command expects. */
function resultText(result: any): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text)
      .join("");
  }
  return JSON.stringify(result?.output ?? null);
}

// Stop / Notification. OpenCode v2 ends a turn with one of the session.execution.* events
// (session.idle is kept for builds that still publish it; shouldEmitIdle collapses repeats).
// SessionStart and SessionEnd are deliberately NOT mapped: the CodeMie CLI raises both
// lifecycle events in-process.
const BUS_EVENT_HOOKS: Record<string, HookEventName[]> = {
  "session.execution.succeeded": ["Stop"],
  "session.execution.interrupted": ["Stop"],
  "session.execution.failed": ["Notification", "Stop"],
  "session.idle": ["Stop"],
};

function onBusEvent(event: any): void {
  const sessionId = event?.data?.sessionID;
  if (!sessionId) return;

  for (const hookEvent of BUS_EVENT_HOOKS[event?.type] ?? []) {
    if (hookEvent === "Stop" && !shouldEmitIdle(sessionId, true)) continue;

    const commands = getMatchingCommands(config, hookEvent);
    if (commands.length === 0) continue;

    runCommands(hookEvent, sessionId, basePayload(hookEvent, sessionId), commands, true);
  }
}

export default {
  id: "codemie.shell-hooks",

  async setup(ctx: any) {
    // PreToolUse (blocking: a thrown error fails the tool call; event.input is mutable)
    await ctx.tool.hook("execute.before", (event: any) => {
      const commands = getMatchingCommands(config, "PreToolUse", event.tool);
      if (commands.length === 0 || !event.sessionID) return;

      const payload = basePayload("PreToolUse", event.sessionID);
      payload.tool_name = event.tool;
      payload.tool_input = event.input as Record<string, unknown>;

      for (const parsed of runCommands("PreToolUse", event.sessionID, payload, commands, false)) {
        if (parsed.blocked) {
          throw new Error(parsed.reason || "Hook blocked tool execution");
        }
        if (parsed.updatedInput) {
          event.input = { ...(event.input || {}), ...parsed.updatedInput };
        }
      }
    });

    // PostToolUse (fire-and-forget)
    await ctx.tool.hook("execute.after", (event: any) => {
      const commands = getMatchingCommands(config, "PostToolUse", event.tool);
      if (commands.length === 0 || !event.sessionID) return;

      const payload = basePayload("PostToolUse", event.sessionID);
      payload.tool_name = event.tool;
      payload.tool_output =
        event.status === "completed" ? resultText(event.result) : String(event.error?.message ?? "");

      runCommands("PostToolUse", event.sessionID, payload, commands, true);
    });

    // UserPromptSubmit. Marks the start of an active period; codemie hook forwards it to
    // SessionStore.startActivityTracking.
    await ctx.session.hook("prompt", (event: any) => {
      if (!event.sessionID) return;

      // A new prompt makes the session busy again, so the next idle emits a Stop.
      idleState.set(event.sessionID, false);

      const commands = getMatchingCommands(config, "UserPromptSubmit");
      if (commands.length === 0) return;

      const payload = basePayload("UserPromptSubmit", event.sessionID);
      payload.prompt = typeof event.prompt?.text === "string" ? event.prompt.text : "";

      runCommands("UserPromptSubmit", event.sessionID, payload, commands, true);
    });

    // PreCompact (non-blocking; extra context joins the compaction request's system prompt)
    await ctx.session.hook("compaction", (event: any) => {
      const commands = getMatchingCommands(config, "PreCompact");
      if (commands.length === 0 || !event.sessionID) return;

      const responses = runCommands(
        "PreCompact", event.sessionID, basePayload("PreCompact", event.sessionID), commands, true
      );

      for (const parsed of responses) {
        if (parsed.additionalContext && Array.isArray(event.system)) {
          event.system.push({ type: "text", text: parsed.additionalContext });
        }
      }
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          onBusEvent(event);
        } catch {
          // Telemetry must never break the session.
        }
      }
    })().catch(() => {});

    return () => controller.abort();
  },
};
`;
