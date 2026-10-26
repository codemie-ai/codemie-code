
import { basename } from 'node:path';
import type {
  ConfigChangeHookInput,
  HookInput,
  PostCompactHookInput,
  PostModelSwitchHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  UserPromptExpansionHookInput,
  UserPromptSubmitHookInput,
  UserPromptSubmitHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { describeLogin } from '@/providers/plugins/sso/sso.detached-login.js';
import { ConfigLoader } from '@/utils/config.js';
import { parsePromptFields } from '@/agents/core/ticket-parser.js';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { resolveEnvFields } from '@/agents/core/event-fields/env-fields.js';
import { resolveIdentityCandidateFields } from '@/agents/core/event-fields/identity-fields.js';
import {
  resolveGitCommitFields,
  resolveGitHeadFields,
  type GitCommitSummary,
} from '@/agents/core/event-fields/repo-fields.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { type ClaudeForwardDecision, isClaudeCodeHookInput } from './claude-code-otlp.types.js';
import { buildClaudeEventId } from './claude-code-otlp.event-id.js';
import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';
import {
  buildSessionEnvEvent,
  openMainTranscriptPass,
  openPostCompactPass,
  openSessionEnvCheckPass,
  openSessionStartPass,
  openSubagentPass,
  openSessionEndPass,
  type SessionEnvCheckInput,
  type SubagentFile,
} from './transcript/orchestrator.js';
import { readForkedSkillMarker, readSubagentMeta, subagentFilePath } from './transcript/subagent-usage.js';
import { resolveClientVersion } from './client-version-cache.js';
import { resolveCommandFields } from './event-fields/command-fields.js';
import { resolveSessionEnvFields } from './event-fields/session-env-fields.js';
import { resolveSubagentStopFields } from './event-fields/subagent-fields.js';
import {
  resolveSkillForkFields,
  resolveToolContextFields,
  resolveToolDiffFields,
} from './event-fields/tool-fields.js';

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: 'agent.session.start',
  Stop: 'agent.session.stop',
  StopFailure: 'agent.turn.error',
  SessionEnd: 'agent.session.end',
  UserPromptSubmit: 'agent.prompt.submit',
  UserPromptExpansion: 'agent.skill.dispatch',
  PreToolUse: 'agent.tool.start',
  PostToolUse: 'agent.tool.end',
  PostToolUseFailure: 'agent.tool.error',
  SubagentStart: 'agent.subagent.start',
  SubagentStop: 'agent.subagent.stop',
  PreCompact: 'agent.session.compact',
  Notification: 'agent.notification',
};

export class ClaudeCodeOtlpPlugin extends OtlpAgentAdapter<HookInput, UserPromptSubmitHookSpecificOutput> {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;

  protected extractHookContext(hookInput: HookInput): OtlpHookContext {
    return {
      cwd: hookInput.cwd,
      prompt: hookInput.hook_event_name === 'UserPromptSubmit' ? hookInput.prompt : undefined,
      sessionId: hookInput.session_id,
    };
  }

  protected parseHookInput(raw: string): HookInput | null {
    const parsed: unknown = JSON.parse(raw);
    return isClaudeCodeHookInput(parsed) ? parsed : null;
  }

  protected async isTracked(hookInput: HookInput): Promise<boolean> {
    return isProjectTracked(hookInput.cwd, await readAllowlistState());
  }

  /** Resolved once per call so every record in the batch shares one client-version lookup. */
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {
      platform: 'claude-code',
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '',
      client_version: await resolveClientVersion(),
    };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['hook_event_name'] ?? '')] ?? 'agent.event';
  }

  /** Claude's deterministic id: per-event templates for derived records, content hash otherwise. */
  protected buildEventId(
    event: Record<string, unknown>,
    payload: Record<string, unknown>,
    timestamp: string
  ): string {
    return buildClaudeEventId(event, payload, timestamp);
  }

  protected async evaluate(hookInput: HookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.hook_event_name === 'SessionStart') {
      return await this.onSessionStart(hookInput);
    }
    if (hookInput.hook_event_name === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(hookInput);
    }
    if (hookInput.hook_event_name === 'UserPromptExpansion') {
      return await this.onUserPromptExpansion(hookInput);
    }
    if (hookInput.hook_event_name === 'PreToolUse') {
      return await this.onPreToolUse(hookInput);
    }
    if (hookInput.hook_event_name === 'PostToolUse') {
      return await this.onPostToolUse(hookInput);
    }
    if (hookInput.hook_event_name === 'Stop') {
      return await this.onStopEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PreCompact') {
      return await this.onPreCompactEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PostCompact') {
      return await this.onPostCompactEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'StopFailure') {
      return await this.onStopFailureEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SessionEnd') {
      return await this.onSessionEndEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SubagentStop') {
      return await this.onSubagentStopEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SubagentStart') {
      return await this.onSubagentStartEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PostModelSwitch') {
      return await this.onPostModelSwitch(hookInput);
    }
    if (hookInput.hook_event_name === 'ConfigChange') {
      return await this.onConfigChange(hookInput);
    }

    return { decision: 'forward', payload: [hookInput] };
  }

  private async onSubagentStartEvent(hookInput: SubagentStartHookInput): Promise<ClaudeForwardDecision> {
    if (!hookInput.agent_type) {
      // Same internal check-in filter as onSubagentStopEvent — not a real subagent dispatch.
      return { decision: 'forward', payload: [] };
    }

    // SubagentStart carries no agent_transcript_path (unlike SubagentStop) — build the path from
    // the triggering hook's own transcript_path (the main transcript) and agent_id instead.
    const agentTranscriptPath = subagentFilePath(hookInput.transcript_path, hookInput.agent_id);
    const marker = await readForkedSkillMarker(agentTranscriptPath);
    const payload = marker.skillName ? { ...hookInput, skill_name: marker.skillName } : hookInput;
    return { decision: 'forward', payload: [payload] };
  }

  /**
   * Enriches the session start with opt-in fields (not stamped on other events). The hook payload is
   * spread first so a same-named payload key can never override a resolved value. The payload's
   * `model` only feeds `agent.session.env`'s `configured_model` — it is not stamped onto
   * `agent.session.start`, whose backend reads `configured_model` from the env snapshot instead.
   *
   * Also emits `agent.session.env`. `openSessionStartPass` records `git_head_start`/the session's
   * wall-clock start time into the parse state — same commit-after-send contract as every other
   * trigger (`pass.finalize`), so `onSessionEndEvent` only ever reads back a value that was
   * actually persisted after a successful send, never persisted ahead of it.
   */
  private async onSessionStart(hookInput: SessionStartHookInput): Promise<ClaudeForwardDecision> {
    const context: OtlpHookContext = { cwd: hookInput.cwd };
    const model = readOptionalString(hookInput, 'model') ?? '';
    const permissionMode = hookInput.permission_mode ?? '';
    const [envFields, identityCandidateFields, gitHeadStart, sessionEnvFields] = await Promise.all([
      resolveEnvFields(),
      resolveIdentityCandidateFields(context),
      resolveGitHeadFields(context, 'start'),
      resolveSessionEnvFields(hookInput.cwd, model, permissionMode),
    ]);
    const pass = await openSessionStartPass(hookInput.session_id, gitHeadStart.git_head_start, sessionEnvFields);

    const sessionStartEvent: Record<string, unknown> = {
      ...hookInput,
      ...envFields,
      ...identityCandidateFields,
      ...gitHeadStart,
      git_head_start: pass.gitHeadStart,
    };
    // The payload's `model` only feeds `agent.session.env`'s `configured_model` — the field the
    // backend actually reads. `model` on `agent.session.start` is not read, so it is not sent.
    delete sessionStartEvent.model;

    const sessionEnvEvent = buildSessionEnvEvent(hookInput.session_id, pass.sessionEnvFields);
    return {
      decision: 'forward',
      payload: [sessionStartEvent, sessionEnvEvent],
      finalize: pass.finalize,
    };
  }

  private async onStopEvent(hookInput: StopHookInput): Promise<ClaudeForwardDecision> {
    const [pass, gitHeadEnd] = await Promise.all([
      openMainTranscriptPass(hookInput.session_id, hookInput.transcript_path, 'Stop', envCheckInput(hookInput)),
      resolveGitHeadFields({ cwd: hookInput.cwd }, 'end'),
    ]);
    return {
      decision: 'forward',
      payload: [{ ...hookInput, ...gitHeadEnd }, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async onPreCompactEvent(hookInput: PreCompactHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openMainTranscriptPass(
      hookInput.session_id,
      hookInput.transcript_path,
      'PreCompact',
      envCheckInput(hookInput)
    );
    return {
      decision: 'forward',
      payload: [hookInput, ...pass.events],
      finalize: pass.finalize,
    };
  }

  /**
   * `openPostCompactPass` does the detection work itself, including the bounded, lock-free wait
   * for a still-landing `compact_boundary` line — see its own doc comment. The native
   * `PostCompact` hook event is never forwarded, same as `onPostModelSwitch`/`onConfigChange`:
   * only the derived `agent.session.compact.done` record goes out, if one was found. Forwarding
   * the raw hook too would double-emit it, since `buildCompactionDoneEvent` already sets its own
   * explicit `type`.
   */
  private async onPostCompactEvent(hookInput: PostCompactHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openPostCompactPass(hookInput.session_id, hookInput.transcript_path);
    return {
      decision: 'forward',
      payload: pass.events,
      finalize: pass.finalize,
    };
  }

  private async onStopFailureEvent(hookInput: StopFailureHookInput): Promise<ClaudeForwardDecision> {
    const pass = await openMainTranscriptPass(
      hookInput.session_id,
      hookInput.transcript_path,
      'StopFailure',
      envCheckInput(hookInput)
    );
    return {
      decision: 'forward',
      payload: [hookInput, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async onSessionEndEvent(hookInput: SessionEndHookInput): Promise<ClaudeForwardDecision> {
    const [pass, gitHeadEnd, identityCandidateFields] = await Promise.all([
      openSessionEndPass(hookInput.session_id, hookInput.transcript_path, hookInput.cwd, envCheckInput(hookInput)),
      resolveGitHeadFields({ cwd: hookInput.cwd }, 'end'),
      resolveIdentityCandidateFields({ cwd: hookInput.cwd }),
    ]);
    const gitCommitFields = await resolveGitCommitFields(
      hookInput.cwd,
      pass.sessionStartedAt,
      identityCandidateFields.git_email
    );
    const gitSnapshotEvent = buildGitSnapshotEvent(hookInput.session_id, {
      gitHeadStart: pass.gitHeadStart,
      gitHeadEnd: gitHeadEnd.git_head_end,
      gitEmail: identityCandidateFields.git_email,
      gitCommits: gitCommitFields.git_commits,
    });

    // No later hook retries a failed SessionEnd batch, so it gets one in-process resend.
    return {
      decision: 'forward',
      payload: [{ ...hookInput, ...gitHeadEnd }, gitSnapshotEvent, ...pass.events],
      finalize: pass.finalize,
      retryOnce: true,
    };
  }

  private async onUserPromptExpansion(hookInput: UserPromptExpansionHookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.expansion_type !== 'slash_command') {
      return { decision: 'forward', payload: [] };
    }

    return {
      decision: 'forward',
      payload: [{
        session_id: hookInput.session_id,
        prompt_id: hookInput.prompt_id,
        hook_event_name: hookInput.hook_event_name,
        expansion_type: hookInput.expansion_type,
        command_name: hookInput.command_name,
        command_source: hookInput.command_source,
        skill_name: hookInput.command_name,
      }],
    };
  }

  /**
   * `/model` always changes `agent.session.env`'s `configured_model`, and might as well pay for
   * a full recompute while it's at it (rare hook, I/O cost is a non-issue) in case something else
   * drifted too. The native `PostModelSwitch`/`ConfigChange` events are never forwarded
   * themselves — only the derived `agent.session.env`, if anything actually changed.
   */
  private async onPostModelSwitch(hookInput: PostModelSwitchHookInput): Promise<ClaudeForwardDecision> {
    const check = await openSessionEnvCheckPass(hookInput.session_id, {
      effort: hookInput.effort?.level ?? '',
      permissionMode: hookInput.permission_mode ?? '',
      full: { cwd: hookInput.cwd, configuredModel: hookInput.to_model, replaceEffort: true },
    });
    if (!check.sessionEnvFields) {
      return { decision: 'forward', payload: [], finalize: check.finalize };
    }
    return {
      decision: 'forward',
      payload: [buildSessionEnvEvent(hookInput.session_id, check.sessionEnvFields)],
      finalize: check.finalize,
    };
  }

  /**
   * `source: 'skills'` is a skill-*content* edit (e.g. a `SKILL.md` change) — never env-relevant,
   * so it's skipped before touching any lock or file. Every other source
   * (`user_settings`/`project_settings`/`local_settings`/`policy_settings`) is where
   * `outputStyle`/`enabledPlugins` actually live, so those get a full recompute.
   * `configuredModel` is omitted — `ConfigChangeHookInput` doesn't carry one — so
   * `openSessionEnvCheckPass` falls back to the last snapshot's value.
   */
  private async onConfigChange(hookInput: ConfigChangeHookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.source === 'skills') {
      return { decision: 'forward', payload: [] };
    }
    const check = await openSessionEnvCheckPass(hookInput.session_id, {
      effort: hookInput.effort?.level ?? '',
      permissionMode: hookInput.permission_mode ?? '',
      full: { cwd: hookInput.cwd },
    });
    if (!check.sessionEnvFields) {
      return { decision: 'forward', payload: [], finalize: check.finalize };
    }
    return {
      decision: 'forward',
      payload: [buildSessionEnvEvent(hookInput.session_id, check.sessionEnvFields)],
      finalize: check.finalize,
    };
  }

  private async onSubagentStopEvent(hookInput: SubagentStopHookInput): Promise<ClaudeForwardDecision> {
    if (!hookInput.agent_type) {
      // Claude Code's own internal check-ins ("is it done yet?") fire SubagentStop with no
      // agent_type — not a real subagent, so nothing is derived or forwarded for it.
      return { decision: 'forward', payload: [] };
    }

    const agentTranscriptPath = hookInput.agent_transcript_path;
    if (!agentTranscriptPath) {
      return { decision: 'forward', payload: [hookInput] };
    }

    const [meta, marker] = await Promise.all([
      readSubagentMeta(agentTranscriptPath),
      readForkedSkillMarker(agentTranscriptPath),
    ]);
    // Never let agentId resolve to '' (CR-001): deriveMainEvents' api_calls filter treats an
    // empty agentId as main-thread, so a forked skill's subagent ending up with one here would
    // double-count its usage right back into api_calls. agentTranscriptPath is already confirmed
    // non-empty above, so it is always a safe final fallback.
    const derivedAgentId = basename(agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const subagentFile: SubagentFile = {
      agentId: hookInput.agent_id || derivedAgentId || agentTranscriptPath,
      filePath: agentTranscriptPath,
      // `tool_use_id` is not declared on the SDK's SubagentStopHookInput type; the hook payload
      // wins when it carries it anyway, else fall back to the `.meta.json` sidecar.
      toolUseId: readOptionalString(hookInput, 'tool_use_id') ?? meta.toolUseId,
      agentType: hookInput.agent_type,
      spawnDepth: meta.spawnDepth,
      description: meta.description,
      cwd: hookInput.cwd,
      skillName: marker.skillName,
    };

    const pass = await openSubagentPass(hookInput.session_id, subagentFile, envCheckInput(hookInput));
    const stopFields = resolveSubagentStopFields(subagentFile, pass.events);
    const stopPayload = {
      ...hookInput,
      ...stopFields,
      ...(marker.skillName ? { skill_name: marker.skillName } : {}),
    };
    return {
      decision: 'forward',
      payload: [stopPayload, ...pass.events],
      finalize: pass.finalize,
    };
  }

  private async ensureProxyAuth(): Promise<AuthGateResult> {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);

    return await ensureCodeMieSsoAuth({
      provider: config.provider,
      ssoUrl: config.codeMieUrl || config.baseUrl,
      baseUrl: config.baseUrl,
    });
  }

  private async onUserPromptSubmit(hookInput: UserPromptSubmitHookInput): Promise<ClaudeForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      // Derived from the full prompt: the base class truncates `prompt` to 200 chars later.
      const prompt = typeof hookInput.prompt === 'string' ? hookInput.prompt : '';
      return {
        decision: 'forward',
        payload: [{ ...hookInput, ...parsePromptFields(prompt), ...resolveCommandFields(prompt) }],
      }
    }

    return {
      decision: 'block',
      reason: [
        `CodeMie SSO authentication is invalid - you are blocked until you re-authenticate (${authResult.reason}).`,
        describeLogin(authResult.loginOutcome),
      ].join("\n"),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        suppressOriginalPrompt: true,
      }
    }
  }

  private async onPreToolUse(hookInput: PreToolUseHookInput): Promise<ClaudeForwardDecision> {
    const contextFields = resolveToolContextFields(hookInput.tool_name, hookInput.tool_input);
    return { decision: 'forward', payload: [{ ...hookInput, ...contextFields }] };
  }

  private async onPostToolUse(hookInput: PostToolUseHookInput): Promise<ClaudeForwardDecision> {
    const contextFields = resolveToolContextFields(hookInput.tool_name, hookInput.tool_input);
    const diffFields = resolveToolDiffFields(hookInput.tool_name, hookInput.tool_input, hookInput.tool_response);
    const forkFields = resolveSkillForkFields(hookInput.tool_name, hookInput.tool_response);
    return { decision: 'forward', payload: [{ ...hookInput, ...contextFields, ...diffFields, ...forkFields }] };
  }
}

/** Cheap env fields (no I/O), folded into the handler's own transcript/subagent pass. */
function envCheckInput(hookInput: Pick<HookInput, 'cwd' | 'effort' | 'permission_mode'>): SessionEnvCheckInput {
  return {
    effort: hookInput.effort?.level ?? '',
    permissionMode: hookInput.permission_mode ?? '',
    cwd: hookInput.cwd,
  };
}

function buildGitSnapshotEvent(
  sessionId: string,
  input: { gitHeadStart: string; gitHeadEnd: string; gitEmail: string; gitCommits: GitCommitSummary[] }
): Record<string, unknown> {
  return {
    type: 'agent.git.snapshot',
    session_id: sessionId,
    git_head_start: input.gitHeadStart,
    git_head_end: input.gitHeadEnd,
    git_email: input.gitEmail,
    git_commits: input.gitCommits,
  };
}

/**
 * Reads a string field not declared on the SDK's `HookInput` typings (e.g. `tool_use_id` on
 * `SubagentStop`), in case the raw hook payload carries it anyway.
 */
function readOptionalString(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
