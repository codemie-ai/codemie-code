/**
 * Keep-list of the hook event schema (EPMCDME-17748). Daemon-safe leaf module, declared beside the
 * hook event built by `OtlpAgentAdapter.buildEvent` and by the daemon-side producers of the same event.
 *
 * Only these string fields leave a reduced event as written. Numbers and booleans always pass; every
 * other field, including one added later, becomes `REDACTED:<FIELD>`. `tool_input`, `tool_response`,
 * `description` and `error` are deliberately absent. `git_branch` is cut by `reduceBranch` before the
 * record reducer runs.
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
