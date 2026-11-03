/**
 * Local ambient hook type declarations for `@anthropic-ai/claude-agent-sdk`.
 *
 * NOT HAND-WRITTEN. This is a trimmed copy of the hook-related exports from
 * the real SDK's `sdk.d.ts` (version 0.3.292), kept only because we cannot
 * depend on the npm package itself:
 *
 * `@anthropic-ai/claude-agent-sdk` ships one `optionalDependencies` entry per
 * platform (`-darwin-x64`, `-linux-arm64`, etc.) containing the native CLI
 * binary. Those per-platform packages declare `"license": "SEE LICENSE IN README.md"`,
 * which `license-checker` (`npm run license-check`) reports as an unrecognized
 * "Custom" license and fails the build. We only ever use this package for
 * `import type` - no SDK runtime code is used - so there is no reason to carry
 * the dependency (and its native binaries) just to satisfy the compiler.
 *
 * To update after bumping the version referenced in comments above, or after
 * adding a new hook event:
 *   1. `npm install @anthropic-ai/claude-agent-sdk@<version>` into a scratch/throwaway
 *      location (e.g. `npm pack` + extract, or a disposable project) - do not add
 *      it back to this repo's package.json.
 *   2. Diff that package's `sdk.d.ts` against this file for the hook-related
 *      types (anything with `Hook` in the name, plus their referenced support
 *      types) and copy over what changed.
 *   3. Bump the version noted above and re-check that
 *      `src/agents/plugins/claude-code-otlp/` still type-checks.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  export type PermissionBehavior = 'allow' | 'deny' | 'ask';

  export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

  export type PermissionRuleValue = {
      toolName: string;
      ruleContent?: string;
  };

  export type BackgroundTaskSummary = {
      id: string;
      /**
       * Friendly task-type label (e.g. 'shell', 'subagent', 'monitor', 'workflow'). Falls back to the raw discriminant for unknown types.
       */
      type: string;
      status: string;
      /**
       * Free-text description. Capped at 1000 chars; clipped values append an in-string "… [+N chars]" marker.
       */
      description: string;
      /**
       * Shell command line. Only present for 'shell' tasks. Capped at 1000 chars with the same "… [+N chars]" marker.
       */
      command?: string;
      /**
       * Subagent type name. Only present for 'subagent' tasks.
       */
      agent_type?: string;
      /**
       * MCP server name. Only present for 'monitor' / 'MCP task' tasks.
       */
      server?: string;
      /**
       * MCP tool name. Only present for 'monitor' / 'MCP task' tasks.
       */
      tool?: string;
      /**
       * Workflow name. Only present for 'workflow' tasks.
       */
      name?: string;
  };

  export type ExitReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';

  export type McpServerProvenance = {
      name: string;
      /**
       * sdk | plugin | user | project | local | dynamic | managed | enterprise | claudeai | agent — an open set; treat unknown values as an unrecognized configured source, never as sdk.
       */
      source: string;
  };

  export type PermissionUpdate = {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
  } | {
      type: 'replaceRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
  } | {
      type: 'removeRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
  } | {
      type: 'setMode';
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
  } | {
      type: 'addDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
  } | {
      type: 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
  };

  export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';

  export type PostToolBatchToolCall = {
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      tool_response?: unknown;
  };

  export type SDKAssistantMessageError = 'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'verification_required' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens' | 'cloud_credential_error';

  export type SessionCronSummary = {
      id: string;
      /**
       * Cron expression, e.g. "0 9 * * 1-5".
       */
      schedule: string;
      /**
       * False for one-shot wakeups whose cron field encodes a single fire time; true for tasks that re-fire on every match.
       */
      recurring: boolean;
      /**
       * Prompt text submitted when the cron fires. Capped at 1000 chars; clipped values append an in-string "… [+N chars]" marker.
       */
      prompt: string;
  };

  export type AsyncHookJSONOutput = {
      async: true;
      asyncTimeout?: number;
  };

  export type BaseHookInput = {
      session_id: string;
      transcript_path: string;
      cwd: string;
      /**
       * UUID correlating a user prompt with all subsequent events until the next prompt. Same value emitted on OpenTelemetry events as the `prompt.id` attribute, so hook output can be joined to OTel events at prompt grain. Absent until the first user input of the process lifetime.
       */
      prompt_id?: string;
      permission_mode?: string;
      /**
       * Subagent identifier. Present only when the hook fires from within a subagent (e.g., a tool called by an AgentTool worker). Absent for the main thread, even in --agent sessions. Use this field (not agent_type) to distinguish subagent calls from main-thread calls.
       */
      agent_id?: string;
      /**
       * Agent type name (e.g., "general-purpose", "code-reviewer"). Present when the hook fires from within a subagent (alongside agent_id), or on the main thread of a session started with --agent (without agent_id).
       */
      agent_type?: string;
      /**
       * Reasoning effort applied to the current turn. Same shape as StatusLineCommandInput.effort. Present for hooks that fire within a tool-use context (PreToolUse, PostToolUse, Stop, SubagentStop, etc.) on a model that supports the effort parameter; absent for session-lifecycle hooks and models without effort support.
       */
      effort?: {
          /**
           * Active effort level for the current turn (e.g., "low", "medium", "high", "xhigh", "max"), after any silent downgrade for the selected model. Also exposed to hook commands and Bash as the CLAUDE_EFFORT env var.
           */
          level: string;
      };
  };

  export type ConfigChangeHookInput = BaseHookInput & {
      hook_event_name: 'ConfigChange';
      source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills';
      file_path?: string;
  };

  export type CwdChangedHookInput = BaseHookInput & {
      hook_event_name: 'CwdChanged';
      old_cwd: string;
      new_cwd: string;
  };

  export type CwdChangedHookSpecificOutput = {
      hookEventName: 'CwdChanged';
      watchPaths?: string[];
  };

  export type DirectoryAddedHookInput = BaseHookInput & {
      hook_event_name: 'DirectoryAdded';
      /**
       * Absolute path of the directory that was added.
       */
      directory: string;
      /**
       * How the directory was added: "slash_command" for /add-dir, "register_repo_root" for the SDK control_request.
       */
      source: 'slash_command' | 'register_repo_root';
  };

  export type ElicitationHookInput = BaseHookInput & {
      hook_event_name: 'Elicitation';
      mcp_server_name: string;
      message: string;
      mode?: 'form' | 'url';
      url?: string;
      elicitation_id?: string;
      requested_schema?: Record<string, unknown>;
  };

  export type ElicitationHookSpecificOutput = {
      hookEventName: 'Elicitation';
      action?: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
  };

  export type ElicitationResultHookInput = BaseHookInput & {
      hook_event_name: 'ElicitationResult';
      mcp_server_name: string;
      elicitation_id?: string;
      mode?: 'form' | 'url';
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
  };

  export type ElicitationResultHookSpecificOutput = {
      hookEventName: 'ElicitationResult';
      action?: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
  };

  export type FileChangedHookInput = BaseHookInput & {
      hook_event_name: 'FileChanged';
      file_path: string;
      event: 'change' | 'add' | 'unlink';
  };

  export type FileChangedHookSpecificOutput = {
      hookEventName: 'FileChanged';
      watchPaths?: string[];
  };

  export type HookCallback = (input: HookInput, toolUseID: string | undefined, options: {
      signal: AbortSignal;
  }) => Promise<HookJSONOutput>;

  export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'Notification' | 'UserPromptSubmit' | 'UserPromptExpansion' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact' | 'PreModelSwitch' | 'PostModelSwitch' | 'PermissionRequest' | 'PermissionDenied' | 'Setup' | 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted' | 'Elicitation' | 'ElicitationResult' | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove' | 'InstructionsLoaded' | 'CwdChanged' | 'FileChanged' | 'DirectoryAdded' | 'MessageDisplay';

  export type HookInput = PreToolUseHookInput | PostToolUseHookInput | PostToolUseFailureHookInput | PostToolBatchHookInput | PermissionDeniedHookInput | NotificationHookInput | UserPromptSubmitHookInput | UserPromptExpansionHookInput | SessionStartHookInput | SessionEndHookInput | StopHookInput | StopFailureHookInput | SubagentStartHookInput | SubagentStopHookInput | PreCompactHookInput | PostCompactHookInput | PreModelSwitchHookInput | PostModelSwitchHookInput | PermissionRequestHookInput | SetupHookInput | TeammateIdleHookInput | TaskCreatedHookInput | TaskCompletedHookInput | ElicitationHookInput | ElicitationResultHookInput | ConfigChangeHookInput | InstructionsLoadedHookInput | WorktreeCreateHookInput | WorktreeRemoveHookInput | CwdChangedHookInput | FileChangedHookInput | DirectoryAddedHookInput | MessageDisplayHookInput;

  export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

  export type HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';

  export type InstructionsLoadedHookInput = BaseHookInput & {
      hook_event_name: 'InstructionsLoaded';
      file_path: string;
      memory_type: 'User' | 'Project' | 'Local' | 'Managed';
      load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
      globs?: string[];
      trigger_file_path?: string;
      parent_file_path?: string;
  };

  export type MessageDisplayHookInput = BaseHookInput & {
      hook_event_name: 'MessageDisplay';
      /**
       * UUID of the current turn.
       */
      turn_id: string;
      /**
       * UUID of the assistant message being displayed. Stable across every flush of the same message. Not the API msg_… id.
       */
      message_id: string;
      /**
       * Zero-based index of this delta within the message. Increments by one per flush.
       */
      index: number;
      /**
       * True on the message's last flush. Exactly one flush per message has it.
       */
      final: boolean;
      /**
       * The newly completed lines since the prior flush. Always whole lines, except on the final flush which may end mid-line. The delta of the final flush is empty when the message ends on a newline; treat final as the end-of-message signal regardless.
       */
      delta: string;
  };

  export type MessageDisplayHookSpecificOutput = {
      hookEventName: 'MessageDisplay';
      /**
       * Text displayed in place of the delta. Omit (or return the delta unchanged) to display the original.
       */
      displayContent?: string;
  };

  export type NotificationHookInput = BaseHookInput & {
      hook_event_name: 'Notification';
      message: string;
      title?: string;
      notification_type: string;
  };

  export type NotificationHookSpecificOutput = {
      hookEventName: 'Notification';
      additionalContext?: string;
  };

  export type PermissionDeniedHookInput = BaseHookInput & {
      hook_event_name: 'PermissionDenied';
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      reason: string;
      mcp_server?: McpServerProvenance;
  };

  export type PermissionDeniedHookSpecificOutput = {
      hookEventName: 'PermissionDenied';
      retry?: boolean;
  };

  export type PermissionRequestHookInput = BaseHookInput & {
      hook_event_name: 'PermissionRequest';
      tool_name: string;
      tool_input: unknown;
      permission_suggestions?: PermissionUpdate[];
      mcp_server?: McpServerProvenance;
  };

  export type PermissionRequestHookSpecificOutput = {
      hookEventName: 'PermissionRequest';
      decision: {
          behavior: 'allow';
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: PermissionUpdate[];
      } | {
          behavior: 'deny';
          message?: string;
          interrupt?: boolean;
      };
  };

  export type PostCompactHookInput = BaseHookInput & {
      hook_event_name: 'PostCompact';
      trigger: 'manual' | 'auto';
      /**
       * The conversation summary produced by compaction
       */
      compact_summary: string;
  };

  export type PostModelSwitchHookInput = (BaseHookInput & {
      hook_event_name: 'PostModelSwitch';
  }) & {
      /**
       * Resolved model id the session was running before the switch
       */
      from_model: string;
      /**
       * Resolved model id the session runs after the switch
       */
      to_model: string;
      /**
       * What was asked for (alias such as "opus", a full id, or null for "default")
       */
      requested_model: string | null;
      /**
       * command: /model <name>, the /config Model row, or enabling fast mode when that promotes the model; picker: an interactive model picker; sdk: headless set_model (SDK, Remote Control, IDE); auto: automatic fallback or other programmatic change; resume: model restored while resuming a session
       */
      source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume';
      /**
       * Prompt tokens the next request re-sends: the last main-thread response's input + cache_read + cache_creation + output tokens (0 before the first response; for a server-side tool loop, its last iteration's window, not the summed totals)
       */
      context_tokens: number;
      /**
       * Whether the current model's prompt cache is likely still warm (a switch then forfeits it)
       */
      prompt_cache_warm: boolean;
      cache_ttl: '5m' | '1h';
      /**
       * Estimated cost of re-caching context_tokens on to_model at its cache-write rate — the managed modelPricing when set, otherwise list price; excludes the response
       */
      estimated_cache_write_usd: number;
      /**
       * configured: priced at the managed modelPricing setting; catalog: list price; default: to_model unknown, the default tier was assumed
       */
      pricing: 'configured' | 'catalog' | 'default';
  };

  export type PostModelSwitchHookSpecificOutput = {
      hookEventName: 'PostModelSwitch';
      /**
       * Reaches the model with the next request the new model serves
       */
      additionalContext?: string;
  };

  export type PostToolBatchHookInput = BaseHookInput & {
      hook_event_name: 'PostToolBatch';
      tool_calls: PostToolBatchToolCall[];
  };

  export type PostToolBatchHookSpecificOutput = {
      hookEventName: 'PostToolBatch';
      additionalContext?: string;
  };

  export type PostToolUseFailureHookInput = BaseHookInput & {
      hook_event_name: 'PostToolUseFailure';
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      error: string;
      is_interrupt?: boolean;
      /**
       * Tool execution time in milliseconds. Excludes permission-prompt and hook time.
       */
      duration_ms?: number;
      mcp_server?: McpServerProvenance;
  };

  export type PostToolUseFailureHookSpecificOutput = {
      hookEventName: 'PostToolUseFailure';
      additionalContext?: string;
  };

  export type PostToolUseHookInput = BaseHookInput & {
      hook_event_name: 'PostToolUse';
      tool_name: string;
      tool_input: unknown;
      tool_response: unknown;
      tool_use_id: string;
      /**
       * Tool execution time in milliseconds. Excludes permission-prompt and hook time.
       */
      duration_ms?: number;
      mcp_server?: McpServerProvenance;
  };

  export type PostToolUseHookSpecificOutput = {
      hookEventName: 'PostToolUse';
      additionalContext?: string;
      /**
       * Host-asserted context shown to the auto-mode permission classifier alongside this tool call's result. In the live session the classifier may weigh a user statement relayed here as user intent (it can satisfy a consent bar a user turn would satisfy, never a hard boundary); values restored from saved session state are treated as unverified context only. Relay discipline is the host's obligation: put ONLY genuine user statements in intent-bearing positions — never tool output or model text dressed as one. Capped at 2000 UTF-16 code units, a budget shared across all hooks that contribute to one call (surrogate-pair-safe; emoji and other astral characters count as two). Honored on synchronous hook responses only: an async hook's late response arrives after the result message is frozen and this field in it is silently ignored. Security note: do not copy untrusted tool output or third-party text into it blindly — content placed here reaches the permission classifier with host-application framing. Applies only to calls the classifier transcript shows: read-only lookups the transcript omits (file reads, searches) and remote-engine shells produce no per-result line, and context attached to them is silently unused. Not a delivery channel: it is bound to a single call id and sized for a short assertion, not for relaying messages or events. Rewrite integrity: if this assertion describes output you are rewriting, return it in the SAME hook result as the rewrite — it is then dropped automatically if your rewrite is rejected or superseded by a later hook's rewrite; assertions returned without a rewrite are never invalidated by other hooks' rewrites, so a non-rewriting hook should assert only what holds regardless of other hooks' rewrites — hosts that need an assertion bound to exact output bytes should make it in the hook that produces those bytes. (Do NOT return an identity rewrite just to pair an assertion: hooks run in parallel on the ORIGINAL output, so an identity rewrite competes last-write-wins with sibling rewrites and can clobber a real redaction.)
       */
      classifierContext?: string;
      /**
       * Replaces the tool output before it is sent to the model
       */
      updatedToolOutput?: unknown;
      /**
       * Replaces the output for MCP tools only. Prefer updatedToolOutput, which works for all tools
       */
      updatedMCPToolOutput?: unknown;
  };

  export type PreCompactHookInput = BaseHookInput & {
      hook_event_name: 'PreCompact';
      trigger: 'manual' | 'auto';
      custom_instructions: string | null;
  };

  export type PreModelSwitchHookInput = (BaseHookInput & {
      hook_event_name: 'PreModelSwitch';
  }) & {
      /**
       * Resolved model id the session was running before the switch
       */
      from_model: string;
      /**
       * Resolved model id the session runs after the switch
       */
      to_model: string;
      /**
       * What was asked for (alias such as "opus", a full id, or null for "default")
       */
      requested_model: string | null;
      /**
       * command: /model <name>, the /config Model row, or enabling fast mode when that promotes the model; picker: an interactive model picker; sdk: headless set_model (SDK, Remote Control, IDE)
       */
      source: 'command' | 'picker' | 'sdk';
      /**
       * Prompt tokens the next request re-sends: the last main-thread response's input + cache_read + cache_creation + output tokens (0 before the first response; for a server-side tool loop, its last iteration's window, not the summed totals)
       */
      context_tokens: number;
      /**
       * Whether the current model's prompt cache is likely still warm (a switch then forfeits it)
       */
      prompt_cache_warm: boolean;
      cache_ttl: '5m' | '1h';
      /**
       * Estimated cost of re-caching context_tokens on to_model at its cache-write rate — the managed modelPricing when set, otherwise list price; excludes the response
       */
      estimated_cache_write_usd: number;
      /**
       * configured: priced at the managed modelPricing setting; catalog: list price; default: to_model unknown, the default tier was assumed
       */
      pricing: 'configured' | 'catalog' | 'default';
  };

  export type PreModelSwitchHookSpecificOutput = {
      hookEventName: 'PreModelSwitch';
      /**
       * Same contract as PreToolUse: allow proceeds (skipping the interactive cache-miss confirm), deny cancels the switch, ask asks the user to confirm (a headless session refuses instead)
       */
      permissionDecision?: 'allow' | 'deny' | 'ask';
      permissionDecisionReason?: string;
  };

  export type PreToolUseHookInput = BaseHookInput & {
      hook_event_name: 'PreToolUse';
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      mcp_server?: McpServerProvenance;
  };

  export type PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse';
      permissionDecision?: HookPermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: Record<string, unknown>;
      additionalContext?: string;
  };

  export type SessionEndHookInput = BaseHookInput & {
      hook_event_name: 'SessionEnd';
      reason: ExitReason;
  };

  export type SessionStartHookInput = BaseHookInput & {
      hook_event_name: 'SessionStart';
      source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
      agent_type?: string;
      model?: string;
      session_title?: string;
      /**
       * resume/fork: seconds since the resumed transcript's last assistant response
       */
      seconds_since_last_response?: number;
      /**
       * resume/fork: the resumed transcript's last response input + cache_read + cache_creation + output tokens (for a server-side tool loop, its last iteration's window, not the summed totals)
       */
      context_tokens?: number;
      /**
       * resume/fork: seconds_since_last_response exceeds the prompt-cache TTL, so the first request re-caches context_tokens
       */
      prompt_cache_likely_expired?: boolean;
      /**
       * resume/fork: estimated cost of re-caching context_tokens on the session model — the managed modelPricing when set, otherwise list price; excludes the response
       */
      estimated_cache_write_usd?: number;
  };

  export type SessionStartHookSpecificOutput = {
      hookEventName: 'SessionStart';
      additionalContext?: string;
      initialUserMessage?: string;
      sessionTitle?: string;
      watchPaths?: string[];
      /**
       * Re-scan skill and command directories after SessionStart hooks complete, so skills installed by the hook are available in the same session
       */
      reloadSkills?: boolean;
  };

  export type SetupHookInput = BaseHookInput & {
      hook_event_name: 'Setup';
      trigger: 'init' | 'maintenance';
  };

  export type SetupHookSpecificOutput = {
      hookEventName: 'Setup';
      additionalContext?: string;
  };

  export type StopFailureHookInput = BaseHookInput & {
      hook_event_name: 'StopFailure';
      error: SDKAssistantMessageError;
      error_details?: string;
      last_assistant_message?: string;
  };

  export type StopHookInput = BaseHookInput & {
      hook_event_name: 'Stop';
      stop_hook_active: boolean;
      /**
       * Text content of the last assistant message before stopping. Avoids the need to read and parse the transcript file.
       */
      last_assistant_message?: string;
      /**
       * In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
       */
      background_tasks?: BackgroundTaskSummary[];
      /**
       * Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will wake this session later. Empty array when none are scheduled.
       */
      session_crons?: SessionCronSummary[];
  
  
  };

  export type StopHookSpecificOutput = {
      hookEventName: 'Stop';
      additionalContext?: string;
  };

  export type SubagentStartHookInput = BaseHookInput & {
      hook_event_name: 'SubagentStart';
      agent_id: string;
      agent_type: string;
  };

  export type SubagentStartHookSpecificOutput = {
      hookEventName: 'SubagentStart';
      additionalContext?: string;
  };

  export type SubagentStopHookInput = BaseHookInput & {
      hook_event_name: 'SubagentStop';
      stop_hook_active: boolean;
      agent_id: string;
      agent_transcript_path: string;
      agent_type: string;
      /**
       * Text content of the last assistant message before stopping. Avoids the need to read and parse the transcript file.
       */
      last_assistant_message?: string;
      /**
       * In-flight background work (running/pending + backgrounded) registered in this session. Lets hooks distinguish "session is done" from "session is paused waiting for background work to wake it". Empty array when nothing is in flight.
       */
      background_tasks?: BackgroundTaskSummary[];
      /**
       * Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will wake this session later. Empty array when none are scheduled.
       */
      session_crons?: SessionCronSummary[];
  
  
  };

  export type SubagentStopHookSpecificOutput = {
      hookEventName: 'SubagentStop';
      additionalContext?: string;
  };

  export type SyncHookJSONOutput = {
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: 'approve' | 'block';
      systemMessage?: string;
      /**
       * A terminal escape sequence (e.g. OSC 9 / OSC 777 desktop-notification) for Claude Code to emit on your behalf. Only notification/title OSCs (0, 1, 2, 9, 99, 777) and BEL are permitted; anything else is dropped.
       */
      terminalSequence?: string;
      reason?: string;
  
  
      hookSpecificOutput?: PreToolUseHookSpecificOutput | UserPromptSubmitHookSpecificOutput | UserPromptExpansionHookSpecificOutput | SessionStartHookSpecificOutput | SetupHookSpecificOutput | PreModelSwitchHookSpecificOutput | PostModelSwitchHookSpecificOutput | SubagentStartHookSpecificOutput | PostToolUseHookSpecificOutput | PostToolUseFailureHookSpecificOutput | PostToolBatchHookSpecificOutput | StopHookSpecificOutput | SubagentStopHookSpecificOutput | PermissionDeniedHookSpecificOutput | NotificationHookSpecificOutput | PermissionRequestHookSpecificOutput | ElicitationHookSpecificOutput | ElicitationResultHookSpecificOutput | CwdChangedHookSpecificOutput | FileChangedHookSpecificOutput | WorktreeCreateHookSpecificOutput | MessageDisplayHookSpecificOutput;
  };

  export type TaskCompletedHookInput = BaseHookInput & {
      hook_event_name: 'TaskCompleted';
      task_id: string;
      task_subject: string;
      task_description?: string;
      teammate_name?: string;
      /**
       * @deprecated Sessions have a single implicit team; this carries the session-derived team name and will be removed in a future release.
       */
      team_name?: string;
  };

  export type TaskCreatedHookInput = BaseHookInput & {
      hook_event_name: 'TaskCreated';
      task_id: string;
      task_subject: string;
      task_description?: string;
      teammate_name?: string;
      /**
       * @deprecated Sessions have a single implicit team; this carries the session-derived team name and will be removed in a future release.
       */
      team_name?: string;
  };

  export type TeammateIdleHookInput = BaseHookInput & {
      hook_event_name: 'TeammateIdle';
      teammate_name: string;
      /**
       * @deprecated Sessions have a single implicit team; this carries the session-derived team name and will be removed in a future release.
       */
      team_name: string;
  };

  export type UserPromptExpansionHookInput = BaseHookInput & {
      hook_event_name: 'UserPromptExpansion';
      expansion_type: 'slash_command' | 'mcp_prompt';
      command_name: string;
      command_args: string;
      command_source?: string;
      prompt: string;
  };

  export type UserPromptExpansionHookSpecificOutput = {
      hookEventName: 'UserPromptExpansion';
      additionalContext?: string;
      /**
       * When decision is "block", omit the original prompt from the block message
       */
      suppressOriginalPrompt?: boolean;
  };

  export type UserPromptSubmitHookInput = BaseHookInput & {
      hook_event_name: 'UserPromptSubmit';
      prompt: string;
      /**
       * Who authored/injected the prompt: `user` = submitted from the interactive composer, `sdk` = non-interactive entrypoint (`-p` / Agent SDK), `loop_wakeup` = dynamic /loop wakeup, `schedule_wakeup` = scheduled-task fire (CronCreate/routine), `system` = other machine-injected turns (peer/channel messages, task notifications, auto-continuation), `poll_event` = the poll-event channel enqueue-time pass (the hook fires when the host submits an event, before its delivery ack exists — a blocking verdict rejects the event). Payloads may omit it while the field rolls out.
       */
      source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event';
      session_title?: string;
  };

  export type UserPromptSubmitHookSpecificOutput = {
      hookEventName: 'UserPromptSubmit';
      additionalContext?: string;
      sessionTitle?: string;
      /**
       * When decision is "block", omit the original prompt from the block message
       */
      suppressOriginalPrompt?: boolean;
  };

  export type WorktreeCreateHookInput = BaseHookInput & {
      hook_event_name: 'WorktreeCreate';
      name: string;
  };

  export type WorktreeCreateHookSpecificOutput = {
      hookEventName: 'WorktreeCreate';
      worktreePath: string;
  };

  export type WorktreeRemoveHookInput = BaseHookInput & {
      hook_event_name: 'WorktreeRemove';
      worktree_path: string;
  };
}
