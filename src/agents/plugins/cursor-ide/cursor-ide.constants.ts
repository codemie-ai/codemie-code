/**
 * Shared Cursor IDE identifiers.
 *
 * Kept apart from `cursor-ide.plugin.ts` so other modules (the connector, the
 * hook transformer) can import identifiers without pulling in the full plugin.
 */

/** Internal agent key. Canonical everywhere: the `--cursor-ide` flag, `--agent cursor-ide`, `metadata.name`. */
export const CURSOR_IDE_AGENT_NAME = 'cursor-ide';

/** User-facing label shown in analytics output. */
export const CURSOR_IDE_DISPLAY_NAME = 'Cursor IDE';

/** Runtime client type recorded on ingested analytics events. */
export const CURSOR_IDE_CLIENT_TYPE = 'codemie-cursor-ide';
