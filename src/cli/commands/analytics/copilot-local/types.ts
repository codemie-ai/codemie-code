/**
 * The row every Copilot local scanner emits, and the health record describing a scan.
 *
 * {@link CopilotUsageRow} is the TypeScript counterpart of `AiRequest` in
 * `sl-ai-sdlc-cost-tracking` (`src/model.py`), narrowed to the fields the CodeMie analytics
 * pipeline consumes. Rows are flat and already carry their tokens; the loader groups them by
 * session and prices them, exactly as `otel-loader.ts` does for OTEL api_request events.
 */

/** Which local artifact a row was read from. */
export type CopilotRowSource = 'copilot-cli-store' | 'copilot-cli-events' | 'copilot-vscode-sessions';

/** Analytics agent key a row is attributed to. Must stay in step with `agent-labels.ts`. */
export type CopilotAgentKey = 'copilot-cli' | 'copilot-desktop' | 'copilot-vscode';

/** One billed Copilot model call. */
export interface CopilotUsageRow {
  sessionId: string;
  /** Stable per-row id; used to dedupe a session read through two roots (shared + profile). */
  requestId: string;
  /** Epoch ms, UTC. */
  tsMs: number;
  agentName: CopilotAgentKey;
  /** Human-readable surface, e.g. `Copilot CLI`, `Copilot Desktop`, `VS Code (WSL:Ubuntu)`. */
  surface: string;
  source: CopilotRowSource;
  /** Raw model id as the source wrote it; normalized/priced downstream. */
  model: string;
  /** `inferred` when the id is a router alias (`copilot/auto`) with no resolved model. */
  modelConfidence: 'exact' | 'inferred';
  /** `chat/agent`, `chat/tool-loop`, `chat/sub-agent`, `feature/compaction`. */
  category: string;
  status: 'success' | 'error' | 'cancelled';
  /** True only for the user's own turn; false for tool-loop and internal calls. */
  isUserTurn: boolean;
  /**
   * Tokens in COPILOT's convention, passed through untouched: `inputTokens` INCLUDES
   * `cacheReadTokens`. The loader converts with `copilotUsageToTokens()` so this repo's
   * billing convention is applied in exactly one place.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  durationMs: number;
  /** API calls behind this row; >1 when the source reports a tool-call loop as one turn. */
  apiCalls: number;
  workingDirectory?: string;
  branch?: string;
  repository?: string;
  /** VS Code workspace hash, or the location kind for window-less/transferred chats. */
  workspaceId?: string;
  /** `stable` | `insiders` for VS Code rows. */
  ideProfile?: string;
  /**
   * Chat mode behind the turn (`agent`, `ask`, `edit`, or a custom mode's own name).
   * VS Code rows only — the local store is the one place exact agent attribution exists for
   * the extension. Surfaced as the session's `agentInvocations` breakdown.
   */
  agentMode?: string;
  /** True when {@link agentMode} names a user-defined chat mode rather than a built-in one. */
  isCustomAgent?: boolean;
  userPrompt?: string;
  /**
   * Copilot's own billing unit for premium requests (`total_nano_aiu` / `totalNanoAiu`),
   * 1e-9 of an AI unit. Carried because a Copilot subscription is NOT billed on tokens, so
   * this is the only figure that reconciles against an invoice.
   */
  billedNanoAiu?: number;
  /** Credits VS Code reports GitHub actually billed for the turn (`copilotCredits`). */
  reportedCredits?: number;
  /**
   * Copilot's premium-request multiplier for the call (`request_multiplier` in the store).
   * Real stores carry 15 for the overwhelming majority of rows and 1 for the rest, so a
   * premium-request total computed as "one request per call" is wrong by more than an order of
   * magnitude. Carried rather than applied: how it combines with the seat's allowance is a
   * billing question, not a parsing one.
   */
  requestMultiplier?: number;
  /**
   * Premium-request cost Copilot charged for this call (`data.usage.cost` on a
   * `session.usage_record`). The events-side counterpart of {@link requestMultiplier}.
   */
  premiumRequestCost?: number;
}

/** Closed set of reasons a scan produced nothing, so health never carries free text. */
export type CopilotScanReason =
  | 'no_store'
  | 'sqlite_unavailable'
  | 'sqlite_error'
  | 'schema_drift'
  | 'permission'
  | 'snapshot_failed'
  | 'absent'
  | 'other_error';

/** What one scanner did, for the report's honesty banner. Never carries a path or user name. */
export interface CopilotScanHealth {
  scanner: string;
  filesSeen: number;
  rowsRead: number;
  rowsSkipped: number;
  errors: number;
  reasons: CopilotScanReason[];
  notes: string[];
}

export function emptyHealth(scanner: string): CopilotScanHealth {
  return { scanner, filesSeen: 0, rowsRead: 0, rowsSkipped: 0, errors: 0, reasons: [], notes: [] };
}

/** A scanner's output: its rows plus how the scan went. */
export interface CopilotScanResult {
  rows: CopilotUsageRow[];
  health: CopilotScanHealth;
  /** Session ids this scanner covered, so a later fallback scanner can skip them. */
  coveredSessionIds: Set<string>;
}

/** Tolerant integer read: hostile logs put lists, null and strings in numeric fields. */
export function toInt(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Non-negative integer, for a token count a source may report as negative or absent. */
export function toCount(value: unknown): number {
  return Math.max(0, toInt(value));
}
