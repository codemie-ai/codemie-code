/**
 * Shared body of the OpenCode shell-hooks plugin payloads.
 *
 * Both payloads (`shell-hooks-source.ts` for OpenCode 1.x and
 * `shell-hooks-v2-source.ts` for 2.x) are embedded strings that only run
 * inside the OpenCode binary. They differ ONLY in how they register with the
 * host (flat dotted-key handler map vs `Plugin.define`) and in how they read
 * the session id from the host's event shape. Everything else is identical
 * and lives here, once: types, the tool-name matcher, hooks config loading,
 * command resolution, the sync/async shell execution (including the Windows
 * spawn rules from second-audit F5), response parsing and idle de-duplication.
 *
 * Before this module existed the two payloads were copy-pasted, and they had
 * already drifted: the v2 copy carried a mis-escaped matcher regex, so a
 * pattern such as `Edit|Write` never matched any tool there.
 *
 * Composition: each payload is `<its own import> + ${SHELL_HOOKS_COMMON_SOURCE}
 * + <its own resolveSessionId, runner and plugin definition>`. This constant
 * is itself a template literal, so it follows the payloads' escaping rules: a
 * backslash is written doubled, a backtick is written `\``, and no `$` + `{`.
 *
 * Contract. Names defined here, which a payload must NOT redefine:
 * HookConfig, HookMatcherEntry, HookEventName, HooksConfig, HookStdinPayload,
 * matchesPattern, loadHooksConfig, getMatchingCommands, transcriptPath,
 * buildEnvVars, basePayload, ExecResult, execCommand, execCommandAsync,
 * ParsedResponse, parseResponse, idleState, shouldEmitIdle.
 * Names the payload must provide: resolveSessionId (the event shapes differ).
 * Imports the payload must NOT repeat: child_process (execSync, spawn),
 * fs (readFileSync, existsSync), path (join, delimiter).
 */

export const SHELL_HOOKS_COMMON_SOURCE = `
import { execSync, spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, delimiter } from "path";

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

// ─── Payload Helpers ─────────────────────────────────────────────────────────

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

// ─── Async hook spawn: platform notes (second-audit F5) ──────────────────────
//
// History. This used to be spawn("sh", ["-c", command]). On a Windows machine
// whose PATH has no sh (stock Windows; Git for Windows does not add its usr/bin
// to the system PATH) that spawn fails with ENOENT. The failure was swallowed
// by the child.on("error", () => {}) guard below, so every async hook was
// silently ignored there: nothing ran and nothing was reported. Only the sync
// path (execSync, which goes through %ComSpec%) worked. In practice that meant
// the async-configured Stop hook (and every UserPromptSubmit/Stop hook on v2)
// never delivered telemetry on such machines, with no visible symptom.
//
// Verified live on Windows 11 with the real system PATH (no sh):
//   - old spawn("sh", ...)            -> ENOENT, nothing delivered
//   - spawn(command, {shell: true})   -> delivered through cmd.exe
//   - same, with a PATH that has sh   -> delivered through sh -c
//
// detached. detached: true combined with shell: true left cmd.exe and the child
// node process hung on Windows: the hook command never ran and the processes
// piled up. The cause was not established; only the symptom was reproduced.
// Without detached the hook is delivered, so detaching is POSIX-only (where
// setsid keeps the child out of the host process group, e.g. on Ctrl+C).
//
// Why the host is still not blocked without detached (checked on Windows 11):
//   - unref() plus ignored stdout/stderr: the host exited in ~50 ms while the
//     child kept running and wrote its payload 2.5 s later;
//   - killing the host by PID while the child was running did not kill the
//     child, and the payload was still delivered;
//   - Ctrl+C in an interactive cmd.exe console shared by host and child: the host
//     exited, the non-detached child survived and still wrote its payload ~3 s
//     later (checked by hand with a stand-in host/child pair; not re-checked in
//     other shells such as Windows Terminal).
//
// On Windows prefer a POSIX sh found on PATH (Git for Windows, MSYS, WSL
// shims) so hook commands written in bash syntax keep working; without one,
// fall back to the platform shell (%ComSpec%) instead of failing with ENOENT.
// POSIX hosts always use shell: true (/bin/sh -c), as before.
let cachedPosixShell: boolean | undefined;
function hasPosixShellOnPath(): boolean {
  if (cachedPosixShell !== undefined) return cachedPosixShell;
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter);
  cachedPosixShell = dirs.some(
    (dir) => dir && (existsSync(join(dir, "sh.exe")) || existsSync(join(dir, "sh"))),
  );
  return cachedPosixShell;
}

function spawnHookCommand(command: string, env: Record<string, string>) {
  const options = {
    env: { ...process.env, ...env },
    stdio: ["pipe", "ignore", "ignore"] as ["pipe", "ignore", "ignore"],
    // POSIX-only: detached + shell:true hangs cmd.exe on Windows (see the notes above).
    detached: process.platform !== "win32",
  };
  if (process.platform === "win32" && hasPosixShellOnPath()) {
    return spawn("sh", ["-c", command], options);
  }
  return spawn(command, { ...options, shell: true });
}

function execCommandAsync(
  command: string,
  stdin: string,
  env: Record<string, string>,
): void {
  const child = spawnHookCommand(command, env);
  // A ChildProcess or stdin 'error' with no listener is an UNHANDLED error
  // event, which throws inside the host OpenCode process. Async hooks (v1:
  // the async-configured Stop; v2: every fire-and-forget event) are the
  // production path here: a failed spawn (ENOENT for the shell, EAGAIN) or a
  // broken pipe must degrade telemetry, never kill the session.
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

// ─── Idle Deduplication ──────────────────────────────────────────────────────

// A turn can end through several events: v1 publishes both the deprecated
// \`session.idle\` and the newer \`session.status\` {type:"idle"} back to back,
// and v2 publishes the durable session.execution.* lifecycle (parallel subagent
// executions each publish their own end event). Subscribing to only one risks
// silently losing active-time accounting if it is removed upstream, so every
// variant is handled and collapsed on the busy→idle transition: only the first
// end event after a busy period emits a Stop.
const idleState = new Map<string, boolean>();

function shouldEmitIdle(sessionId: string, isIdle: boolean): boolean {
  const wasIdle = idleState.get(sessionId) === true;
  idleState.set(sessionId, isIdle);
  return isIdle && !wasIdle;
}
`;
