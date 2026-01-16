import type { HookTransformer, BaseHookEvent } from '../../core/types.js';

/**
 * Gemini hook event structure
 * Based on Gemini CLI hook documentation: https://geminicli.com/docs/hooks/#hook-inputoutput-contract
 *
 * Key findings:
 * - Field names are IDENTICAL to Claude's (session_id, transcript_path, cwd, hook_event_name)
 * - Only difference: Gemini includes `timestamp` field (we ignore it)
 * - Only transformation needed: Add default `permission_mode: 'default'`
 */
interface GeminiHookEvent {
  session_id: string;              // Session identifier
  transcript_path: string;         // Path to transcript file (.json in Gemini)
  cwd: string;                     // Current working directory
  hook_event_name: string;         // Event identifier (SessionStart, AfterAgent, etc.)
  timestamp?: string;              // ISO 8601 timestamp (ignored in transformation)
  source?: string;                 // SessionStart only: "startup", "resume", "clear"
  reason?: string;                 // SessionEnd only: "exit", "logout", "clear", etc.
  // Note: Gemini doesn't have permission_mode - we add it as default
}

/**
 * Gemini Hook Transformer
 * Transforms Gemini hook events to internal BaseHookEvent format
 *
 * Implementation is extremely simple because Gemini and Claude use nearly identical formats.
 * The only transformation needed is adding a default permission_mode field.
 *
 * @example SessionStart transformation
 * ```typescript
 * // Input (Gemini):
 * {
 *   session_id: "405de5f5-...",
 *   transcript_path: "/Users/x/.gemini/tmp/.../session-2026-01-14T19-23-405de5f5.json",
 *   cwd: "/Users/x/project",
 *   hook_event_name: "SessionStart",
 *   timestamp: "2026-01-14T19:24:04.203Z",
 *   source: "startup"
 * }
 *
 * // Output (Internal):
 * {
 *   session_id: "405de5f5-...",
 *   transcript_path: "/Users/x/.gemini/tmp/.../session-2026-01-14T19-23-405de5f5.json",
 *   cwd: "/Users/x/project",
 *   hook_event_name: "SessionStart",
 *   source: "startup",
 *   permission_mode: "default"  // Added
 * }
 * ```
 */
export class GeminiHookTransformer implements HookTransformer {
  readonly agentName = 'gemini';

  /**
   * Transform Gemini hook event to internal format
   * Transformation is minimal: add permission_mode, remove timestamp
   *
   * @param event - Raw hook event from Gemini CLI
   * @returns Transformed event in internal BaseHookEvent format
   */
  transform(event: unknown): BaseHookEvent {
    const geminiEvent = event as GeminiHookEvent;

    // Transform is almost pass-through since field names match
    const transformed: BaseHookEvent = {
      session_id: geminiEvent.session_id,
      transcript_path: geminiEvent.transcript_path,
      hook_event_name: geminiEvent.hook_event_name,
      permission_mode: 'default',  // Gemini doesn't have this concept - use default

      // Optional fields (pass through if present)
      ...(geminiEvent.cwd && { cwd: geminiEvent.cwd }),
      ...(geminiEvent.source && { source: geminiEvent.source }),
      ...(geminiEvent.reason && { reason: geminiEvent.reason })
    };

    // Note: timestamp is intentionally omitted (not needed in internal format)

    return transformed;
  }
}
