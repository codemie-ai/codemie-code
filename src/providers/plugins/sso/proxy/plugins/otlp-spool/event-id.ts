/**
 * Pure, deterministic `event_id` derivation for analytics events.
 */
export function computeEventId(
  type: string,
  sessionId: string,
  fields: Record<string, unknown>
): string {
  switch (type) {
    case 'agent.usage.request': {
      const requestId = String(fields['request_id'] ?? '');
      const model = String(fields['model'] ?? '');
      return `${sessionId}:agent.usage.request:${requestId}:${model}`;
    }
    case 'agent.subagent.usage': {
      const toolUseId = String(fields['tool_use_id'] ?? '');
      const agentId = String(fields['agent_id'] ?? '');
      return `${sessionId}:agent.subagent.usage:${toolUseId || agentId}`;
    }
    case 'agent.session.summary': {
      const phase = String(fields['phase'] ?? '');
      return `${sessionId}:agent.session.summary:${phase}`;
    }
    default: {
      const byteOffset = String(fields['byteOffset'] ?? '');
      return `${sessionId}:${type}:${byteOffset}`;
    }
  }
}
