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
 * Session id: taken from the payload OpenCode passes in (`input.sessionID`, or
 * `input.event.properties.sessionID` for bus events). `codemie hook` rejects an
 * empty session_id with exit code 2, so a hook with no resolvable session id is
 * skipped rather than invoked.
 */

export const SHELL_HOOKS_PLUGIN_SOURCE = `
import type { Plugin } from "@opencode-ai/plugin";
import { execSync, spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HookConfig {
  type: "command" | "prompt" | "agent";
  command?: string;
  timeout?: number; // seconds
  async?: boolean;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks: HookConfig[];
}

type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "Notification";

interface HooksConfig {
  hooks?: Partial<Record<HookEventName, HookMatcherEntry[]>>;
}

interface HookStdinPayload {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  permission_mode: string;
  transcript_path: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  prompt?: string;
  [key: string]: unknown;
}

// ─── Matcher (ported from codemie-code src/hooks/matcher.ts) ─────────────────

function matchesPattern(pattern: string, toolName: string): boolean {
  try {
    if (!pattern || pattern === "*") return true;
    if (/[|[\\]{}()]/.test(pattern)) {
      try {
        return new RegExp("^(" + pattern + ")$").test(toolName);
      } catch {
        return pattern === toolName;
      }
    }
    return pattern === toolName;
  } catch {
    return false;
  }
}

// ─── Config Loading ──────────────────────────────────────────────────────────

function loadHooksConfig(): HooksConfig {
  // Priority 1: OPENCODE_HOOKS env var (set by the CodeMie CLI)
  const envHooks = process.env.OPENCODE_HOOKS;
  if (envHooks) {
    try {
      const parsed = JSON.parse(envHooks);
      if (parsed.hooks && Object.keys(parsed.hooks).length > 0) {
        return parsed as HooksConfig;
      }
    } catch {
      // Fall through to file-based config
    }
  }

  // Priority 2: .opencode/hooks.json in project directory
  const projectDir = process.env.OPENCODE_PROJECT_DIR || process.cwd();
  const hooksFile = join(projectDir, ".opencode", "hooks.json");
  if (existsSync(hooksFile)) {
    try {
      const content = readFileSync(hooksFile, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.hooks) return parsed as HooksConfig;
    } catch {
      // Ignore parse errors
    }
  }

  return { hooks: {} };
}

// ─── Hook Resolution ─────────────────────────────────────────────────────────

function getMatchingCommands(
  config: HooksConfig,
  event: HookEventName,
  toolName?: string,
): Array<{ command: string; timeout: number; isAsync: boolean }> {
  const matchers = config.hooks?.[event];
  if (!matchers || matchers.length === 0) return [];

  const result: Array<{ command: string; timeout: number; isAsync: boolean }> = [];

  for (const entry of matchers) {
    const pattern = entry.matcher || "*";
    const shouldMatch = !toolName || matchesPattern(pattern, toolName);
    if (!shouldMatch) continue;

    for (const hook of entry.hooks) {
      // Only support "command" type — skip "prompt" and "agent"
      if (hook.type !== "command" || !hook.command) continue;
      result.push({
        command: hook.command,
        timeout: (hook.timeout || 60) * 1000, // seconds → ms
        isAsync: hook.async === true,
      });
    }
  }

  return result;
}

// ─── Session / Payload Helpers ───────────────────────────────────────────────

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

// codemie hook needs a transcript path to re-parse the session; for OpenCode
// that is the SQLite database, exported by the CLI before spawning.
function transcriptPath(): string {
  return process.env.CODEMIE_OPENCODE_TRANSCRIPT || "";
}

function buildEnvVars(sessionId: string, event: string): Record<string, string> {
  const projectDir = process.env.OPENCODE_PROJECT_DIR || process.cwd();
  return {
    OPENCODE_PROJECT_DIR: projectDir,
    OPENCODE_SESSION_ID: sessionId,
    OPENCODE_HOOK_EVENT: event,
    CLAUDE_PROJECT_DIR: projectDir, // Anthropic alias
  };
}

function basePayload(event: HookEventName, sessionId: string): HookStdinPayload {
  return {
    hook_event_name: event,
    session_id: sessionId,
    cwd: process.cwd(),
    permission_mode: "default",
    transcript_path: transcriptPath(),
  };
}

// ─── Shell Execution ─────────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCommand(
  command: string,
  stdin: string,
  env: Record<string, string>,
  timeout: number,
): ExecResult {
  try {
    const stdout = execSync(command, {
      input: stdin,
      timeout,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout || "", stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

function execCommandAsync(
  command: string,
  stdin: string,
  env: Record<string, string>,
): void {
  const child = spawn("sh", ["-c", command], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    windowsHide: true,
  });
  // A ChildProcess or stdin 'error' with no listener is an UNHANDLED error
  // event, which throws inside the host OpenCode process. Stop is configured
  // async, so this is the production path: a failed spawn (ENOENT for sh,
  // EAGAIN) or a broken pipe must degrade telemetry, never kill the session.
  child.on("error", () => {});
  if (child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.write(stdin);
    child.stdin.end();
  }
  child.unref();
}

// ─── Response Parsing ────────────────────────────────────────────────────────

interface ParsedResponse {
  blocked: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

function parseResponse(
  result: ExecResult,
  event: HookEventName,
): ParsedResponse {
  // Exit code 2 = block
  if (result.exitCode === 2) {
    const reason = [result.stderr, result.stdout.trim()].filter(Boolean).join("\\n");
    return { blocked: true, reason: reason || "Hook blocked execution (exit code 2)" };
  }

  // Non-zero, non-2 = non-blocking error (allow)
  if (result.exitCode !== 0) {
    return { blocked: false };
  }

  const trimmed = result.stdout.trim();
  if (!trimmed) return { blocked: false };

  try {
    const json = JSON.parse(trimmed);

    // PreToolUse: hookSpecificOutput.updatedInput, or a bare object → merged args
    if (event === "PreToolUse") {
      const updated = json.hookSpecificOutput?.updatedInput || json.updatedInput;
      if (updated && typeof updated === "object") {
        return { blocked: false, updatedInput: updated };
      }
      if (typeof json === "object" && !json.hookSpecificOutput && !json.decision) {
        return { blocked: false, updatedInput: json };
      }
    }

    if (event === "PreCompact") {
      const context = json.additionalContext || json.context;
      if (typeof context === "string") {
        return { blocked: false, additionalContext: context };
      }
    }

    return { blocked: false };
  } catch {
    // Non-JSON output — treat as informational
    return { blocked: false };
  }
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

// ─── Idle Deduplication ──────────────────────────────────────────────────────

// OpenCode publishes both the deprecated \`session.idle\` and the newer
// \`session.status\` {type:"idle"} back to back. Subscribing to only one risks
// silently losing active-time accounting if it is removed upstream, so both are
// handled and collapsed on the busy→idle transition.
const idleState = new Map<string, boolean>();

function shouldEmitIdle(sessionId: string, isIdle: boolean): boolean {
  const wasIdle = idleState.get(sessionId) === true;
  idleState.set(sessionId, isIdle);
  return isIdle && !wasIdle;
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
