// src/agents/plugins/kimi/kimi.hook-transformer.ts
/**
 * Kimi hook payload transformer.
 *
 * Kimi emits lifecycle hooks as JSON on stdin with Kimi-specific field names.
 * Unlike Claude and Gemini, Kimi payloads do not include a transcript path;
 * the transformer computes it from the working directory and session id using
 * the same deterministic layout Kimi uses for its session storage.
 */

import type { BaseHookEvent, HookTransformer } from '../../core/types.js';
import { getKimiMainWirePath } from './kimi.paths.js';

/**
 * Transforms Kimi hook payloads to CodeMie's internal BaseHookEvent format.
 */
export class KimiHookTransformer implements HookTransformer {
  readonly agentName = 'kimi';

  /**
   * Transform a Kimi hook event into the internal BaseHookEvent shape.
   *
   * @param event - Raw JSON payload received from Kimi on stdin
   * @returns Transformed event compatible with CodeMie hook handlers
   */
  transform(event: unknown): BaseHookEvent {
    const payload = event as Record<string, unknown>;

    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const hookEventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';

    const transformed: BaseHookEvent = {
      hook_event_name: hookEventName,
      session_id: sessionId,
      transcript_path: sessionId ? getKimiMainWirePath(cwd, sessionId) : '',
      permission_mode: 'default',
      cwd,
    };

    if (typeof payload.source === 'string') {
      transformed.source = payload.source;
    }

    if (typeof payload.reason === 'string') {
      transformed.reason = payload.reason;
    }

    if (typeof payload.stop_hook_active === 'boolean') {
      transformed.stop_hook_active = payload.stop_hook_active;
    }

    return transformed;
  }
}
