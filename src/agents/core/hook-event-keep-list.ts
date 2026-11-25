/**
 * Keep-list of the hook event schema (EPMCDME-17748). Daemon-safe leaf module, declared beside the
 * hook event built by `OtlpAgentAdapter.buildEvent` and by the daemon-side producers of the same event.
 *
 * Only these string fields leave a reduced event as written. Numbers and booleans always pass; every
 * other field, including one added later, becomes `REDACTED:<FIELD>`. `tool_input`, `tool_response`,
 * `description` and `error` are deliberately absent. `git_branch` is cut by `reduceBranch` before the
 * record reducer runs.
 *
 * `tool_use_id`, `agent_id` and `fork_agent_id` are opaque runtime ids: they carry no user content and
 * are needed to pair tool start/end and subagent events. `codemie_cli_version` is the client version
 * envelope identifier. Identity fields (`user_email`, `developer_name`, `identity_source`) and
 * `file_path` stay redacted.
 */
import type { KeepList } from './analytics-reduction.js';

export const HOOK_EVENT_KEEP_LIST: KeepList = {
  keep: new Set<string>([
    // Envelope identifiers
    'session_id',
    'event_id',
    'timestamp',
    'schema_version',
    'platform',
    'client_version',
    'codemie_project_name',
    'entrypoint',
    'story_marker',
    'prompt_source',
    'analytics_reduction',
    'codemie_cli_version',
    // Opaque runtime ids (tool start/end and subagent pairing)
    'tool_use_id',
    'agent_id',
    'fork_agent_id',
    // Event, tool, command, skill and agent type names, MCP names
    'type',
    'hook_event_name',
    'tool_name',
    'command_name',
    'skill_name',
    'subagent_type',
    'agent_type',
    'agent_name',
    'mcp_server_name',
    'mcp_tool_name',
    // Model usage: model names and fixed enums of `agent.usage.request`. Needed to price a request;
    // a redacted model makes the dashboard report a partial estimate for the whole session.
    'request_id',
    'message_id',
    'model',
    'model_raw',
    'speed',
    'inference_geo',
    'service_tier',
    'stop_reason',
    'scope_kind',
    'scope_name',
    // Session summary: timestamps, model names, and name lists/maps of tools, skills, agents and commands
    // (a kept container keeps scalars and identifier-like strings only). `title`, `compactions` and
    // `branch_counts` / `branch_dominant` stay redacted.
    'started_at',
    'ended_at',
    'models',
    'primary_model',
    'tools',
    'skills',
    'agents',
    'commands',
    'primary_command',
    'client_versions',
    // Reduced prompt
    'prompt_body',
    // Ticket attribution
    'story_id',
    'story_source',
    'ticket_mentions',
    // Repository name, git remote, reduced branch
    'cwd',
    'repo_remote',
    'git_branch',
  ]),
};
