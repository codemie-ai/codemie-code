import { logger } from '@/utils/logger.js';
import { extractRepository } from '@/utils/paths.js';
import { AnalyticsSourceError } from '@/utils/errors.js';
import { maskSecretsDeep } from '@/utils/security.js';
import { AgentAdapterType, type OtlpAdapterDeps } from './types.js';
import { resolveRepoFields, type RepoFields } from './event-fields/repo-fields.js';
import { resolveIdentityFields, resolveProjectAtCwd, type IdentityFields, type ProjectPolicy } from './event-fields/identity-fields.js';
import { resolveBranchStory } from './story-resolver.js';
import { stampEvidence, type EvidenceInputs } from './evidence/stamp.js';
import { frozenProfileOf, type EvidenceRecord } from './evidence/record-store.js';
import { enqueuePendingOwner } from './evidence/owner-pending.js';

export type ForwardDecision<TBlockOutput = Record<string, unknown>> =
  | {
    decision: 'forward';
    payload: Record<string, unknown>[];
    /** SessionEnd only: resend the same built events once if the first attempt failed. */
    retryOnce?: boolean;
    /** Called exactly once, after the send attempt. Commits state only when accepted; always releases any lock the handler is holding. */
    finalize?: (accepted: boolean) => Promise<void>;
  }
  | { decision: 'block'; reason: string; hookSpecificOutput: TBlockOutput };

export interface OtlpHookContext {
  cwd: string;
  /** Only for prompt-submit style events; enables the marker/mention story tiers. */
  prompt?: string;
  /** Pins the resolved project per session (see `resolveProjectName`); omitted adapters get the unpinned, per-hook-cwd behavior. */
  sessionId?: string;
  /** Optional tool evidence, resolved with the context before the shared persistence step. */
  evidenceInputs?: EvidenceInputs;
}

/** Agent-independent fields resolved by the base class at hook time. */
type CommonFields = RepoFields & IdentityFields;

interface PreparedForward {
  events: Record<string, unknown>[];
  options?: Parameters<OtlpAdapterDeps['forwardOtlpEventsToSpool']>[2];
  /** A loss report never acknowledges source data, even if the transport accepts it. */
  failure?: string;
  /** The events are durably held for their login (owner not resolved yet): the hook batch counts as accepted. */
  pendingStored?: true;
}

/** Common fields an event may bring itself: its own non-empty value wins. All others are stamped. */
const OVERRIDABLE_FIELD_KEYS = ['git_branch', 'repo_remote', 'story_id', 'story_source'] as const;

/** Everything resolved once per hook invocation and shared by every event of that invocation. */
interface InvocationContext {
  cwd: string;
  /** Captured once, so the fallback timestamp is the same for every event and every retry. */
  hookTime: Date;
  commonFields: CommonFields;
  agentFields: Record<string, unknown>;
}

const SCHEMA_VERSION = 2;
const MAX_PROMPT_CHARS = 200;
export const MAX_TOOL_FIELD_CHARS = 300;

/** Free-text fields cut after masking, each to its own limit. */
export const TEXT_FIELD_LIMITS: Readonly<Record<string, number>> = {
  prompt: MAX_PROMPT_CHARS,
  tool_input: MAX_TOOL_FIELD_CHARS,
  tool_response: MAX_TOOL_FIELD_CHARS,
  error: MAX_TOOL_FIELD_CHARS,
  description: MAX_TOOL_FIELD_CHARS,
};

/** Top-level identifier fields that are never free text; masking must not touch them. */
export const UNMASKED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'session_id', 'type', 'timestamp', 'file_path', 'skill_name', 'subagent_type', 'fork_agent_id',
  'hook_event_name', 'tool_name', 'tool_use_id', 'agent_id', 'agent_type', 'agent_name',
  'notification_type', 'error_type',
]);

export function boundedText(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const cut = text.slice(0, maxChars);
  // A cut inside a surrogate pair would leave a lone high surrogate, which strict UTF-8 consumers reject.
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Base class for adapters that ingest a coding tool's native hook events into the
 * analytics spool. Owns the fixed flow (parse, allowlist gate, daemon start, evaluate,
 * enrichment, spool forward); subclasses supply the tool-specific parts.
 *
 * The complete event is built here, in the short-lived hook process, because
 * the forwarder runs in a long-lived daemon whose environment (cwd, profile, credentials,
 * CLI version) is frozen at spawn time. The forwarder only transports it.
 */
export abstract class OtlpAgentAdapter<TInput = unknown, TBlockOutput = Record<string, unknown>> {
  abstract readonly name: string;
  /** Claude Code and Copilot adapters only: a native session's configured project wins over a shell CODEMIE_PROJECT. */
  protected readonly configuredProjectWins: boolean = false;
  /** Copilot adapters only (no CLAUDE_PROJECT_DIR): find config from the nearest `.codemie` up from the hook cwd. */
  protected readonly walkProjectFromCwd: boolean = false;
  private get projectPolicy(): ProjectPolicy {
    return { configuredWins: this.configuredProjectWins, walkFromCwd: this.walkProjectFromCwd };
  }
  readonly type = AgentAdapterType.OTLP;

  public async processOtlpEvent(rawHookInput: string, deps: OtlpAdapterDeps): Promise<void> {
    const { ensureOtlpProxy, forwardOtlpEventsToSpool } = deps;
    // JSON.parse failures intentionally propagate to the caller.
    const hookInput = this.parseHookInput(rawHookInput);
    if (hookInput === null) {
      logger.debug(`[${this.name}] hook payload has an unknown shape, ignoring`);
      return;
    }

    // INVARIANT - do not weaken. An untracked project must produce NO hooks data
    // in the daemon spool, must not start the daemon, and must not run the SSO
    // check. The daemon has no allowlist of its own. Its completeness gate
    // (`otlp-spool/completeness-gate.ts`) only sends sessions that have hooks
    // data, and skips sessions that only have OTEL data. Forwarding a hook event
    // for an untracked project would make the session sendable and leak its
    // data to the backend.
    if (!(await this.isTracked(hookInput))) {
      logger.debug(`[${this.name}] project not in analytics allowlist, ignoring hook event`);
      await this.onUntrackedHook(hookInput);
      return;
    }

    // Per-hook session transition check (stop markers, folder / consent / generation changes). Adapters without one continue.
    if ((await this.transitionGate(hookInput)) === 'stop') return;

    try {
      try {
        await ensureOtlpProxy(this.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[${this.name}] ensureOtlpProxy failed (non-blocking): ${message}`);
      }

      const decision = await this.evaluate(hookInput);
      if (decision.decision === 'block') {
        logger.error(`[${this.name}] Blocking prompt: ${decision.reason}`);
        this.emitBlock(decision);
        return;
      }

      // Commit-after-send: a handler with a cursor to protect (parse-state offsets) hands
      // back `finalize`, which persists its state only when `accepted` is true. This keeps
      // the whole invocation's events a single all-or-nothing unit: on failure nothing is
      // committed, so the next hook re-derives and re-sends the same events.
      let accepted = false;
      try {
        if (decision.payload.length === 0) {
          accepted = true; // nothing to send, nothing to lose
          return;
        }

        const context = await this.extractHookContext(hookInput);
        const batch = await this.prepareForward(context, decision, hookInput);
        const args: Parameters<OtlpAdapterDeps['forwardOtlpEventsToSpool']> = batch.options
          ? [batch.events, this.name, batch.options]
          : [batch.events, this.name];
        // One transport call site; retries reuse the same prepared bytes and event IDs.
        const send = (): Promise<boolean> => forwardOtlpEventsToSpool(...args);
        if (batch.pendingStored) {
          accepted = true; // durable: finalize commits any source cursor, a retry would only duplicate
        } else if (batch.failure) {
          // Loss reporting is best-effort and never acknowledges source data.
          if (batch.options?.evidenceLoss) await send().catch(() => false);
        } else {
          accepted = await send();
          if (!accepted && decision.retryOnce) accepted = await send();
        }
        if (!accepted && this.requiresSpoolAcceptance(hookInput)) {
          throw new AnalyticsSourceError(batch.failure ?? 'Local analytics spool did not accept the hook event batch');
        }
      } finally {
        try {
          await decision.finalize?.(accepted);
        } catch (err) {
          logger.warn(`[${this.name}] finalize failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      await this.onHookError(err, hookInput);
    }
  }

  /** Prepare data or a loss report before the single transport step; no source cursor is committed here. */
  private async prepareForward(
    context: OtlpHookContext,
    decision: Extract<ForwardDecision<TBlockOutput>, { decision: 'forward' }>,
    hookInput: TInput
  ): Promise<PreparedForward> {
    let record: EvidenceRecord | undefined;
    if (context.evidenceInputs) {
      const stamp = await stampEvidence(context, context.evidenceInputs, this.projectPolicy);
      if (!stamp.ok) {
        if (stamp.pending && (await this.holdForOwner(context, decision.payload, stamp.pending, hookInput))) {
          logger.warn(`[${this.name}] owner not resolved yet; ${decision.payload.length} event(s) held for this login`);
          return { events: [], pendingStored: true };
        }
        logger.warn(`[${this.name}] evidence record unavailable (${stamp.reason}${stamp.detail ? `: ${stamp.detail}` : ''}); event not enqueued`);
        return {
          events: [],
          options: !decision.finalize && context.sessionId
            ? { evidenceLoss: { sessionId: context.sessionId, reason: stamp.reason, events: decision.payload.length } }
            : undefined,
          failure: 'Evidence record unavailable; hook event not enqueued',
        };
      }
      record = stamp.record;
      if ((await this.recordGate(context, record)) === 'stop') return { events: [], failure: 'Session scope check stopped publication; hook event not enqueued' };
    }
    const [commonFields, agentFields] = await Promise.all([
      this.resolveCommonFields(context, record),
      this.resolveAgentFields(hookInput),
    ]);
    const invocation: InvocationContext = { cwd: context.cwd, hookTime: new Date(), commonFields, agentFields };
    return {
      events: decision.payload.map((hookEvent) => this.buildEvent(hookEvent, invocation)),
      options: record ? { evidenceV: 1 } : undefined,
    };
  }

  /**
   * Profile to resolve the folder's project with: the one an already-recorded session froze (so an active-profile switch
   * is not read as a folder move), else the current one (a fresh session freezes it at replay).
   */
  private async scopeProfile(fields: { session_id: string; api_identity: string; profile?: string }): Promise<string | undefined> {
    const frozen = await frozenProfileOf(fields.session_id, fields.api_identity);
    return frozen === 'not-recorded' ? fields.profile : frozen.profile;
  }

  /**
   * Builds the events exactly as a stamped hook would (hook-time facts) and parks them for the login that could not name its owner.
   * Identity fields are rewritten at replay from the verified login; nothing here is sent.
   */
  private async holdForOwner(
    context: OtlpHookContext,
    payload: Record<string, unknown>[],
    pending: NonNullable<Extract<Awaited<ReturnType<typeof stampEvidence>>, { ok: false }>['pending']>,
    hookInput: TInput
  ): Promise<boolean> {
    try {
      const now = Date.now();
      const provisional: EvidenceRecord = { schema: 1, ...pending.fields, owner_hash: '', created: now, last_used: now };
      const [commonFields, agentFields] = await Promise.all([this.resolveCommonFields(context, provisional), this.resolveAgentFields(hookInput)]);
      const invocation: InvocationContext = { cwd: context.cwd, hookTime: new Date(now), commonFields, agentFields };
      return await enqueuePendingOwner({
        fp: pending.fp,
        agentName: this.name,
        api_identity: pending.fields.api_identity,
        session_id: pending.fields.session_id,
        fields: pending.fields,
        cwd: context.cwd,
        project_at_cwd: await resolveProjectAtCwd(context.cwd, await this.scopeProfile(pending.fields), this.projectPolicy),
        events: payload.map((hookEvent) => this.buildEvent(hookEvent, invocation)),
      }, now);
    } catch (error) {
      logger.debug(`[${this.name}] holding events for owner failed: ${error instanceof Error ? error.name : 'error'}`);
      return false;
    }
  }

  /**
   * Claude Code hook protocol: a blocking decision is returned as JSON on stdout.
   * A subclass whose tool uses a different block protocol (e.g. Copilot's
   * `{"continue": false}` / `{"modifiedTransformedPrompt": ...}` / `{"permissionDecision": "deny"}`)
   * overrides this instead of changing the shared flow above.
   */
  protected emitBlock(decision: Extract<ForwardDecision<TBlockOutput>, { decision: 'block' }>): void {
    console.log(JSON.stringify(decision));
  }

  /**
   * Called when `evaluate` or the forward/finalize step throws (e.g. an enforced event whose
   * spool write was rejected). A daemon-start failure from `ensureOtlpProxy` is logged and
   * does not reach here. `input` is the already-parsed, already-tracked hook input,
   * so a subclass can tell an enforcement event (which must still produce its host's
   * block/replacement output on an internal failure) from one where logging and swallowing
   * the error is enough. Default rethrows, so Claude's existing behavior (the error propagates
   * to the hook command's own catch-all) is unchanged.
   */
  protected async onHookError(err: unknown, _input: TInput): Promise<void> {
    throw err;
  }

  /** Runs after the allowlist gate and before the daemon or any spool write. `stop`: nothing is spooled for this hook. */
  protected async transitionGate(_input: TInput): Promise<'continue' | 'stop'> {
    return 'continue';
  }

  /** Runs on the record the stamp returned, before anything is built or spooled. `stop`: nothing is spooled for this hook. */
  protected async recordGate(_context: OtlpHookContext, _record: EvidenceRecord): Promise<'continue' | 'stop'> {
    return 'continue';
  }

  /** Optional host-specific response when a recognized hook cannot be tracked. */
  protected async onUntrackedHook(_input: TInput): Promise<void> {}

  /** Enforcement adapters opt in; other adapters retain commit-after-send retry behavior. */
  protected requiresSpoolAcceptance(_input: TInput): boolean {
    return false;
  }

  /** Returns null to ignore a payload of an unknown shape. May throw on malformed JSON. */
  protected abstract parseHookInput(raw: string): TInput | null;
  protected abstract extractHookContext(input: TInput): OtlpHookContext | Promise<OtlpHookContext>;
  /** Allowlist gate; evaluated before the daemon is started. */
  protected abstract isTracked(input: TInput): Promise<boolean>;
  protected abstract evaluate(input: TInput): Promise<ForwardDecision<TBlockOutput>>;
  /** Agent-owned fields (platform, version, entrypoint, ...); override everything else. */
  protected abstract resolveAgentFields(input: TInput): Promise<Record<string, unknown>>;
  /** `type` of a native event that does not carry an explicit one. */
  protected abstract resolveEventType(event: Record<string, unknown>): string;
  protected abstract buildEventId(event: Record<string, unknown>, payload: Record<string, unknown>, timestamp: string): string;

  /** Assembles the final event: masked and truncated hook fields plus the common and agent fields, all at the top level. */
  private buildEvent(hookEvent: Record<string, unknown>, ctx: InvocationContext): Record<string, unknown> {
    const limited = this.limitPayload(hookEvent);
    const explicitType = hookEvent['type'];

    const event: Record<string, unknown> = {
      ...this.mergeCommonFields(limited, ctx.commonFields),
      ...ctx.agentFields,
      type: typeof explicitType === 'string' && explicitType.length > 0 ? explicitType : this.resolveEventType(hookEvent),
      session_id: String(hookEvent['session_id'] ?? ''),
      timestamp: this.resolveEventTimestamp(hookEvent['timestamp'], ctx.hookTime),
      cwd: extractRepository(ctx.cwd),
      prompt_body: boundedText(limited['prompt'], MAX_PROMPT_CHARS),
      schema_version: SCHEMA_VERSION,
    };
    event['event_id'] = this.buildEventId(event, limited, String(event['timestamp']));
    return event;
  }

  /**
   * Fields a subclass never forwards (e.g. unbounded, unused ones). Removed before masking
   * and truncation, so they never reach the spool. Default: none.
   */
  protected droppedFields(_hookEvent: Record<string, unknown>): readonly string[] {
    return [];
  }

  /**
   * Masks secrets in every field, then truncates the free-text fields: `prompt` and the
   * tool fields (mask first, so a secret straddling a cut is never half-shown). An incoming `raw` is dropped so it cannot bypass the limits.
   */
  private limitPayload(hookEvent: Record<string, unknown>): Record<string, unknown> {
    const dropped = new Set(this.droppedFields(hookEvent));
    const unmasked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(hookEvent)) {
      if (!dropped.has(key) && key !== 'raw') {
        unmasked[key] = value;
      }
    }
    const effort = unmasked['effort'];
    if (typeof effort === 'object' && effort !== null && !Array.isArray(effort)) {
      const level: unknown = Reflect.get(effort, 'level');
      if (typeof level === 'string') {
        unmasked['effort'] = level;
      } else {
        delete unmasked['effort'];
      }
    }
    const limited = maskSecretsDeep(unmasked, UNMASKED_FIELD_KEYS) as Record<string, unknown>;
    for (const [field, maxChars] of Object.entries(TEXT_FIELD_LIMITS)) {
      if (Object.prototype.hasOwnProperty.call(limited, field)) {
        limited[field] = boundedText(limited[field], maxChars);
      }
    }
    return limited;
  }

  /**
   * The event's own timestamp (e.g. the transcript line time on `agent.usage.request`) wins
   * over hook time. Falls back when the event has none or an unparseable one.
   */
  private resolveEventTimestamp(eventTimestamp: unknown, hookTime: Date): string {
    if (typeof eventTimestamp === 'string' && eventTimestamp.length > 0) {
      const parsed = new Date(eventTimestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return hookTime.toISOString();
  }

  private async resolveCommonFields(context: OtlpHookContext, record?: EvidenceRecord): Promise<CommonFields> {
    const [repoFields, identityFields] = await Promise.all([
      resolveRepoFields(context),
      resolveIdentityFields(context, record, this.projectPolicy),
    ]);
    return { ...repoFields, ...identityFields };
  }

  /** Stamps the common fields; for the overridable ones a hook event's own non-empty string value wins. */
  private mergeCommonFields(hookEvent: Record<string, unknown>, commonFields: CommonFields): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...hookEvent, ...commonFields };
    for (const key of OVERRIDABLE_FIELD_KEYS) {
      const own = hookEvent[key];
      if (typeof own === 'string' && own.length > 0) {
        merged[key] = own;
      }
    }

    // An event can carry its own git_branch (e.g. agent.usage.request's transcript-line branch),
    // which lags the hook-time branch whenever the branch changes mid-turn — a hook fires once
    // per turn, on the branch current *at that time*, but an event inside the same payload can
    // describe something that happened earlier, on a different branch. The
    // explicit/marker/mention story tiers are not branch-scoped, so only the branch tier (or "no
    // story resolved") is worth re-deriving here, and only for the event's own branch.
    const ownBranch = merged['git_branch'];
    if (
      (commonFields.story_source === 'branch' || commonFields.story_source === '') &&
      typeof ownBranch === 'string' &&
      ownBranch.length > 0 &&
      ownBranch !== commonFields.git_branch
    ) {
      const rebased = resolveBranchStory(ownBranch);
      merged['story_id'] = rebased?.storyId ?? '';
      merged['story_source'] = rebased?.storySource ?? '';
    }

    return merged;
  }
}
