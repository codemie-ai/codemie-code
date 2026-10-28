import { logger } from '@/utils/logger.js';
import { extractRepository } from '@/utils/paths.js';
import { AnalyticsSourceError } from '@/utils/errors.js';
import { AgentAdapterType, type OtlpAdapterDeps } from './types.js';
import { resolveRepoFields, type RepoFields } from './event-fields/repo-fields.js';
import { resolveIdentityFields, type IdentityFields } from './event-fields/identity-fields.js';
import { resolveBranchStory } from './story-resolver.js';

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
}

/** Agent-independent fields resolved by the base class at hook time. */
type CommonFields = RepoFields & IdentityFields;

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

        const context = this.extractHookContext(hookInput);
        const [commonFields, agentFields] = await Promise.all([
          this.resolveCommonFields(context),
          this.resolveAgentFields(),
        ]);
        const invocation: InvocationContext = { cwd: context.cwd, hookTime: new Date(), commonFields, agentFields };

        // Built once: a retry below resends these exact bytes, event_ids included.
        const events = decision.payload.map((hookEvent) => this.buildEvent(hookEvent, invocation));

        accepted = await forwardOtlpEventsToSpool(events, this.name);
        if (!accepted && decision.retryOnce) {
          accepted = await forwardOtlpEventsToSpool(events, this.name);
        }
        if (!accepted && this.requiresSpoolAcceptance(hookInput)) {
          throw new AnalyticsSourceError('Local analytics spool did not accept the hook event batch');
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

  /** Optional host-specific response when a recognized hook cannot be tracked. */
  protected async onUntrackedHook(_input: TInput): Promise<void> {}

  /** Enforcement adapters opt in; other adapters retain commit-after-send retry behavior. */
  protected requiresSpoolAcceptance(_input: TInput): boolean {
    return false;
  }

  /** Returns null to ignore a payload of an unknown shape. May throw on malformed JSON. */
  protected abstract parseHookInput(raw: string): TInput | null;
  protected abstract extractHookContext(input: TInput): OtlpHookContext;
  /** Allowlist gate; evaluated before the daemon is started. */
  protected abstract isTracked(input: TInput): Promise<boolean>;
  protected abstract evaluate(input: TInput): Promise<ForwardDecision<TBlockOutput>>;
  /** Agent-owned fields (platform, version, entrypoint, ...); override everything else. */
  protected abstract resolveAgentFields(): Promise<Record<string, unknown>>;
  /** `type` of a native event that does not carry an explicit one. */
  protected abstract resolveEventType(event: Record<string, unknown>): string;
  protected abstract buildEventId(event: Record<string, unknown>, payload: Record<string, unknown>, timestamp: string): string;

  /**
   * Assembles the final event. `raw` mirrors the full enriched event, so the top
   * level and `raw` carry the same fields.
   */
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
      prompt_body: this.boundedText(hookEvent['prompt'], MAX_PROMPT_CHARS),
      schema_version: SCHEMA_VERSION,
    };
    event['event_id'] = this.buildEventId(event, limited, String(event['timestamp']));
    return { ...event, raw: { ...event } };
  }

  /** Truncates the free-text fields; a nested `raw` is dropped so it cannot bypass the limits. */
  private limitPayload(hookEvent: Record<string, unknown>): Record<string, unknown> {
    const limited: Record<string, unknown> = { ...hookEvent };
    const effort = limited['effort'];
    if (typeof effort === 'object' && effort !== null && !Array.isArray(effort)) {
      const level: unknown = Reflect.get(effort, 'level');
      if (typeof level === 'string') {
        limited['effort'] = level;
      } else {
        delete limited['effort'];
      }
    }
    if (Object.prototype.hasOwnProperty.call(hookEvent, 'prompt')) {
      limited['prompt'] = this.boundedText(hookEvent['prompt'], MAX_PROMPT_CHARS);
    }
    for (const field of ['tool_input', 'tool_response', 'error', 'description']) {
      if (Object.prototype.hasOwnProperty.call(hookEvent, field)) {
        limited[field] = this.boundedText(hookEvent[field], MAX_TOOL_FIELD_CHARS);
      }
    }
    delete limited['raw'];
    return limited;
  }

  private boundedText(value: unknown, maxChars: number): string {
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
    return text.slice(0, maxChars);
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

  private async resolveCommonFields(context: OtlpHookContext): Promise<CommonFields> {
    const [repoFields, identityFields] = await Promise.all([
      resolveRepoFields(context),
      resolveIdentityFields(context),
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
