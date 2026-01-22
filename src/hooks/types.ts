/**
 * Hook System Types
 *
 * Defines interfaces and types for the CodeMie hooks system.
 * Hooks allow users to execute custom shell commands or LLM-based prompts
 * at key lifecycle points (PreToolUse, PostToolUse, UserPromptSubmit, Stop).
 */

/**
 * Input data passed to hooks via stdin (JSON format)
 */
export interface HookInput {
	/** Unique session identifier */
	session_id: string;

	/** Path to session transcript file */
	transcript_path: string;

	/** Current working directory */
	cwd: string;

	/** Permission mode (e.g., 'auto', 'manual') */
	permission_mode: string;

	/** Hook event name (PreToolUse, PostToolUse, etc.) */
	hook_event_name: string;

	/** Tool name (for PreToolUse/PostToolUse) */
	tool_name?: string;

	/** Tool input arguments (for PreToolUse/PostToolUse) */
	tool_input?: Record<string, unknown>;

	/** Tool use identifier */
	tool_use_id?: string;

	/** Tool output/result (for PostToolUse) */
	tool_output?: string;

	/** Tool metadata (for PostToolUse) */
	tool_metadata?: Record<string, unknown>;

	/** User prompt text (for UserPromptSubmit) */
	prompt?: string;

	/** Agent name */
	agent_name?: string;

	/** Profile name */
	profile_name?: string;

	/** Tool execution history (for Stop hooks) */
	tool_execution_history?: Array<{
		toolName: string;
		success: boolean;
		exitCode?: number;
		duration?: number;
		errorMessage?: string;
	}>;

	/** Execution statistics (for Stop hooks) */
	execution_stats?: {
		totalToolCalls: number;
		successfulTools: number;
		failedTools: number;
	};
}

/**
 * Output data returned by hooks via stdout (JSON format)
 */
export interface HookResult {
	/** Hook decision (allow, deny, block, approve) */
	decision?: 'allow' | 'deny' | 'block' | 'approve';

	/** Human-readable reason for decision */
	reason?: string;

	/** Whether to suppress tool output from being shown to user */
	suppressOutput?: boolean;

	/** Modified tool input (for PreToolUse) */
	updatedInput?: Record<string, unknown>;

	/** Additional context to inject into conversation */
	additionalContext?: string;

	/** Permission decision (for PermissionRequest hooks) */
	permissionDecision?: 'allow' | 'deny' | 'ask';

	/** Reason for permission decision */
	permissionDecisionReason?: string;
}

/**
 * Hook type enumeration
 */
export type HookType = 'command' | 'prompt';

/**
 * Hook configuration
 */
export interface HookConfig {
	/** Hook type (command executes shell script, prompt calls LLM) */
	type: HookType;

	/** Shell command path (required for command hooks) */
	command?: string;

	/** LLM prompt template (required for prompt hooks) */
	prompt?: string;

	/** Timeout in milliseconds (default: 60000) */
	timeout?: number;
}

/**
 * Hook matcher configuration
 * Matches tool names against patterns to determine which hooks to run
 */
export interface HookMatcher {
	/** Pattern to match tool names (regex, wildcard *, or literal) */
	matcher?: string;

	/** Hooks to execute when matcher matches */
	hooks: HookConfig[];
}

/**
 * Complete hooks configuration
 * Maps hook event names to arrays of matchers
 */
export interface HooksConfiguration {
	/** Hooks executed before tool use (can block/modify) */
	PreToolUse?: HookMatcher[];

	/** Hooks executed after tool completes (informational) */
	PostToolUse?: HookMatcher[];

	/** Hooks executed before processing user prompt (can block/add context) */
	UserPromptSubmit?: HookMatcher[];

	/** Hooks executed when agent completes (can continue execution) */
	Stop?: HookMatcher[];

	/** Hooks executed when subagent stops (already implemented) */
	SubagentStop?: HookMatcher[];

	/** Hooks executed at session start (already implemented) */
	SessionStart?: HookMatcher[];

	/** Hooks executed at session end (already implemented) */
	SessionEnd?: HookMatcher[];
}

/**
 * Hook execution context
 * Internal state passed between hook execution methods
 */
export interface HookExecutionContext {
	/** Session ID */
	sessionId: string;

	/** Working directory */
	workingDir: string;

	/** Transcript file path */
	transcriptPath: string;

	/** Permission mode */
	permissionMode: string;

	/** Agent name */
	agentName?: string;

	/** Profile name */
	profileName?: string;
}

/**
 * Aggregated result from multiple hooks
 */
export interface AggregatedHookResult extends HookResult {
	/** Number of hooks executed */
	hooksExecuted: number;

	/** Number of hooks that succeeded */
	hooksSucceeded: number;

	/** Number of hooks that failed */
	hooksFailed: number;

	/** Individual hook errors (non-blocking) */
	errors?: Array<{ hook: string; error: string }>;
}
