import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ClaudeMessage, ContentItem } from '@/agents/plugins/claude/claude-message-types.js';

export function extractClaudeDesktopMetrics(
  messages: ClaudeMessage[]
): ParsedSession['metrics'] {
  const toolCounts: Record<string, number> = {};
  const toolStatus: Record<string, { success: number; failure: number }> = {};
  const fileOperations: NonNullable<ParsedSession['metrics']>['fileOperations'] = [];
  const toolResultsMap = new Map<string, boolean>();

  for (const msg of messages) {
    if (!msg.message?.content || !Array.isArray(msg.message.content)) continue;
    for (const item of msg.message.content as ContentItem[]) {
      if (item.type === 'tool_result' && item.tool_use_id) {
        const isError = item.isError === true || (item as ContentItem & { is_error?: boolean }).is_error === true;
        toolResultsMap.set(item.tool_use_id, isError);
      }
    }
  }

  for (const msg of messages) {
    if (msg.message?.content && Array.isArray(msg.message.content)) {
      for (const item of msg.message.content as ContentItem[]) {
        if (item.type !== 'tool_use' || !item.name || !item.id) continue;

        toolCounts[item.name] = (toolCounts[item.name] || 0) + 1;
        toolStatus[item.name] ??= { success: 0, failure: 0 };

        if (toolResultsMap.has(item.id)) {
          if (toolResultsMap.get(item.id)) {
            toolStatus[item.name].failure++;
          } else {
            toolStatus[item.name].success++;
          }
        }
      }
    }

    const filePath = msg.toolUseResult?.file?.filePath;
    const toolType = msg.toolUseResult?.type?.toLowerCase();
    if (!filePath || !toolType) continue;

    if (toolType.includes('write')) {
      fileOperations.push({ type: 'write', path: filePath });
    } else if (toolType.includes('edit')) {
      fileOperations.push({ type: 'edit', path: filePath });
    } else if (toolType.includes('delete') || toolType.includes('remove')) {
      fileOperations.push({ type: 'delete', path: filePath });
    }
  }

  return {
    tools: toolCounts,
    toolStatus,
    fileOperations
  };
}
