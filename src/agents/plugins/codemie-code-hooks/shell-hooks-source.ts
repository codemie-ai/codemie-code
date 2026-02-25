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
 * which doesn't exist in codemie-code's dependencies. Embedding as a string avoids
 * TypeScript compilation issues. Bun strips the type import at runtime.
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
  | "PermissionRequest"
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
  // Priority 1: OPENCODE_HOOKS env var (set by codemie-code)
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

// ─── Shell Execution ─────────────────────────────────────────────────────────

function buildEnvVars(sessionId: string, event: string): Record<string, string> {
  const projectDir = process.env.OPENCODE_PROJECT_DIR || process.cwd();
  return {
    OPENCODE_PROJECT_DIR: projectDir,
    OPENCODE_SESSION_ID: sessionId,
    OPENCODE_HOOK_EVENT: event,
    CLAUDE_PROJECT_DIR: projectDir, // Anthropic alias
  };
}

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
  });
  if (child.stdin) {
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
  permissionDecision?: "allow" | "deny" | "ask";
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

  // Parse stdout JSON
  const trimmed = result.stdout.trim();
  if (!trimmed) return { blocked: false };

  try {
    const json = JSON.parse(trimmed);

    // PreToolUse: check for hookSpecificOutput.updatedInput or plain object → merge into args
    if (event === "PreToolUse") {
      const updated = json.hookSpecificOutput?.updatedInput || json.updatedInput;
      if (updated && typeof updated === "object") {
        return { blocked: false, updatedInput: updated };
      }
      // If it's a plain object without known keys, treat as updatedInput
      if (typeof json === "object" && !json.hookSpecificOutput && !json.decision) {
        return { blocked: false, updatedInput: json };
      }
    }

    // PermissionRequest: check for permissionDecision
    if (event === "PermissionRequest") {
      const decision =
        json.hookSpecificOutput?.permissionDecision || json.permissionDecision;
      if (decision && ["allow", "deny", "ask"].includes(decision)) {
        return { blocked: false, permissionDecision: decision };
      }
      // Plain string
      if (typeof json === "string" && ["allow", "deny", "ask"].includes(json)) {
        return { blocked: false, permissionDecision: json };
      }
    }

    // PreCompact: additionalContext
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

// ─── Plugin Definition ───────────────────────────────────────────────────────

const config = loadHooksConfig();
const hasHooks = config.hooks && Object.keys(config.hooks).length > 0;

const plugin: Plugin = {
  name: "shell-hooks",
  ...(hasHooks
    ? {
        hooks: {
          // PreToolUse → tool.execute.before (blocking)
          tool: {
            execute: {
              before: async (input) => {
                const commands = getMatchingCommands(config, "PreToolUse", input.tool);
                if (commands.length === 0) return input;

                const sessionId = process.env.OPENCODE_SESSION_ID || "";
                const env = buildEnvVars(sessionId, "PreToolUse");
                const payload: HookStdinPayload = {
                  hook_event_name: "PreToolUse",
                  session_id: sessionId,
                  cwd: process.cwd(),
                  permission_mode: "default",
                  transcript_path: "",
                  tool_name: input.tool,
                  tool_input: input.args as Record<string, unknown>,
                };
                const stdin = JSON.stringify(payload);

                let mergedInput = { ...input };
                for (const cmd of commands) {
                  if (cmd.isAsync) {
                    execCommandAsync(cmd.command, stdin, env);
                    continue;
                  }
                  const result = execCommand(cmd.command, stdin, env, cmd.timeout);
                  const parsed = parseResponse(result, "PreToolUse");
                  if (parsed.blocked) {
                    throw new Error(parsed.reason || "Hook blocked tool execution");
                  }
                  if (parsed.updatedInput) {
                    mergedInput = {
                      ...mergedInput,
                      args: { ...(mergedInput.args as Record<string, unknown>), ...parsed.updatedInput },
                    };
                  }
                }
                return mergedInput;
              },

              // PostToolUse → tool.execute.after (fire-and-forget)
              after: async (output) => {
                const commands = getMatchingCommands(config, "PostToolUse", output.tool);
                if (commands.length === 0) return output;

                const sessionId = process.env.OPENCODE_SESSION_ID || "";
                const env = buildEnvVars(sessionId, "PostToolUse");
                const payload: HookStdinPayload = {
                  hook_event_name: "PostToolUse",
                  session_id: sessionId,
                  cwd: process.cwd(),
                  permission_mode: "default",
                  transcript_path: "",
                  tool_name: output.tool,
                  tool_input: output.args as Record<string, unknown>,
                  tool_output: typeof output.result === "string" ? output.result : JSON.stringify(output.result),
                };
                const stdin = JSON.stringify(payload);

                for (const cmd of commands) {
                  if (cmd.isAsync) {
                    execCommandAsync(cmd.command, stdin, env);
                    continue;
                  }
                  try {
                    execCommand(cmd.command, stdin, env, cmd.timeout);
                  } catch {
                    // PostToolUse is fire-and-forget
                  }
                }
                return output;
              },
            },
          },

          // UserPromptSubmit → chat.message (blocking)
          chat: {
            message: async (input) => {
              const commands = getMatchingCommands(config, "UserPromptSubmit");
              if (commands.length === 0) return input;

              const sessionId = process.env.OPENCODE_SESSION_ID || "";
              const env = buildEnvVars(sessionId, "UserPromptSubmit");
              const payload: HookStdinPayload = {
                hook_event_name: "UserPromptSubmit",
                session_id: sessionId,
                cwd: process.cwd(),
                permission_mode: "default",
                transcript_path: "",
                prompt: Array.isArray(input.parts)
                  ? input.parts
                      .filter((p: any) => p.type === "text")
                      .map((p: any) => p.text)
                      .join("\\n")
                  : String(input.parts),
              };
              const stdin = JSON.stringify(payload);

              for (const cmd of commands) {
                if (cmd.isAsync) {
                  execCommandAsync(cmd.command, stdin, env);
                  continue;
                }
                const result = execCommand(cmd.command, stdin, env, cmd.timeout);
                const parsed = parseResponse(result, "UserPromptSubmit");
                if (parsed.blocked) {
                  // Clear message parts to block submission
                  return { ...input, parts: [] };
                }
              }
              return input;
            },
          },

          // PermissionRequest → permission.ask (blocking)
          permission: {
            ask: async (input) => {
              const commands = getMatchingCommands(config, "PermissionRequest", input.tool);
              if (commands.length === 0) return input;

              const sessionId = process.env.OPENCODE_SESSION_ID || "";
              const env = buildEnvVars(sessionId, "PermissionRequest");
              const payload: HookStdinPayload = {
                hook_event_name: "PermissionRequest",
                session_id: sessionId,
                cwd: process.cwd(),
                permission_mode: "default",
                transcript_path: "",
                tool_name: input.tool,
                tool_input: input.args as Record<string, unknown>,
              };
              const stdin = JSON.stringify(payload);

              for (const cmd of commands) {
                if (cmd.isAsync) {
                  execCommandAsync(cmd.command, stdin, env);
                  continue;
                }
                const result = execCommand(cmd.command, stdin, env, cmd.timeout);
                const parsed = parseResponse(result, "PermissionRequest");
                if (parsed.permissionDecision === "allow") {
                  return { ...input, allowed: true };
                }
                if (parsed.permissionDecision === "deny") {
                  return { ...input, allowed: false };
                }
              }
              return input;
            },
          },

          // PreCompact → experimental.session.compacting (non-blocking)
          experimental: {
            session: {
              compacting: async (input) => {
                const commands = getMatchingCommands(config, "PreCompact");
                if (commands.length === 0) return input;

                const sessionId = process.env.OPENCODE_SESSION_ID || "";
                const env = buildEnvVars(sessionId, "PreCompact");
                const payload: HookStdinPayload = {
                  hook_event_name: "PreCompact",
                  session_id: sessionId,
                  cwd: process.cwd(),
                  permission_mode: "default",
                  transcript_path: "",
                };
                const stdin = JSON.stringify(payload);

                for (const cmd of commands) {
                  if (cmd.isAsync) {
                    execCommandAsync(cmd.command, stdin, env);
                    continue;
                  }
                  try {
                    const result = execCommand(cmd.command, stdin, env, cmd.timeout);
                    const parsed = parseResponse(result, "PreCompact");
                    if (parsed.additionalContext) {
                      return {
                        ...input,
                        context: ((input as any).context || "") + "\\n" + parsed.additionalContext,
                      };
                    }
                  } catch {
                    // Non-blocking
                  }
                }
                return input;
              },
            },
          },

          // SessionStart/SessionEnd/Stop/Notification → event (non-blocking)
          event: async (input) => {
            let hookEvent: HookEventName | undefined;
            const eventType = (input as any).type || (input as any).event;
            if (eventType === "session.created") hookEvent = "SessionStart";
            else if (eventType === "session.deleted") hookEvent = "SessionEnd";
            else if (eventType === "session.idle") hookEvent = "Stop";
            else if (eventType === "session.error") hookEvent = "Notification";

            if (!hookEvent) return;

            const commands = getMatchingCommands(config, hookEvent);
            if (commands.length === 0) return;

            const sessionId = process.env.OPENCODE_SESSION_ID || "";
            const env = buildEnvVars(sessionId, hookEvent);
            const payload: HookStdinPayload = {
              hook_event_name: hookEvent,
              session_id: sessionId,
              cwd: process.cwd(),
              permission_mode: "default",
              transcript_path: "",
            };
            const stdin = JSON.stringify(payload);

            for (const cmd of commands) {
              if (cmd.isAsync) {
                execCommandAsync(cmd.command, stdin, env);
                continue;
              }
              try {
                execCommand(cmd.command, stdin, env, cmd.timeout);
              } catch {
                // Event hooks are non-blocking
              }
            }
          },
        },
      }
    : {}),
};

export default plugin;
`;
