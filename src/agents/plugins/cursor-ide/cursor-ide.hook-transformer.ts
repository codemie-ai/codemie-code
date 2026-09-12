// src/agents/plugins/cursor-ide/cursor-ide.hook-transformer.ts
/**
 * Cursor IDE hook payload transformer.
 *
 * Cursor emits hooks as JSON on stdin using its own field names -
 * `conversation_id` instead of `session_id`, a nullable `transcript_path`,
 * and no `permission_mode`. This transformer maps a raw Cursor payload onto
 * CodeMie's internal `BaseHookEvent` shape without renaming
 * `hook_event_name`: `normalizeEventName` reads the mapping declaratively
 * from `hookConfig.eventNameMapping` and returns a local variable rather
 * than mutating the event, so leaving the Cursor-native name on the
 * transformed event is what keeps the many-to-one mapping (Task 4) lossless
 * downstream.
 */

import type { HookTransformer } from '../../core/types.js';
import { CURSOR_IDE_AGENT_NAME } from './cursor-ide.constants.js';
import type { CursorIdeHookEvent } from './cursor-ide.types.js';

/**
 * Transforms Cursor IDE hook payloads to CodeMie's internal BaseHookEvent format.
 */
export class CursorIdeHookTransformer implements HookTransformer {
  readonly agentName = CURSOR_IDE_AGENT_NAME;

  /**
   * Transform a Cursor hook event into the internal BaseHookEvent shape.
   *
   * @param event - Raw JSON payload received from Cursor on stdin
   * @returns Transformed event compatible with CodeMie hook handlers
   */
  transform(event: unknown): CursorIdeHookEvent {
    const payload = event as Record<string, unknown>;

    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined;
    const rawSessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    const generationId = typeof payload.generation_id === 'string' ? payload.generation_id : undefined;
    const sessionId = conversationId || rawSessionId || generationId || '';

    const workspaceRoots = Array.isArray(payload.workspace_roots)
      ? (payload.workspace_roots as unknown[]).filter((root): root is string => typeof root === 'string')
      : undefined;

    const cwd = typeof payload.cwd === 'string'
      ? payload.cwd
      : (workspaceRoots?.[0] ?? process.cwd());

    const transformed: CursorIdeHookEvent = {
      ...payload,
      hook_event_name: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '',
      session_id: sessionId,
      transcript_path: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
      permission_mode: 'default',
      cwd,
    };

    if (conversationId) {
      transformed.conversation_id = conversationId;
    }
    if (generationId) {
      transformed.generation_id = generationId;
    }
    if (workspaceRoots) {
      transformed.workspace_roots = workspaceRoots;
    }

    // subagentStart's `tool_call_id` correlates with tool_use_id on the shared type.
    if (typeof payload.tool_call_id === 'string' && !transformed.tool_use_id) {
      transformed.tool_use_id = payload.tool_call_id as string;
    }

    return transformed;
  }
}
