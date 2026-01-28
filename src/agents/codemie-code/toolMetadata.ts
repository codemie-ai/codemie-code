/**
 * Tool Metadata Extraction Utilities
 *
 * Extracts meaningful information from tool results for enhanced UI display
 */

import { ToolMetadata } from './types.js';
import { formatTokens, formatCost } from './tokenUtils.js';
import path from 'path';
import { ReadFileTool, WriteFileTool, ListDirectoryTool, ExecuteCommandTool } from './tools/index.js';

/**
 * Extract metadata from tool results based on tool name and result
 */
export function extractToolMetadata(
  toolName: string,
  result: string,
  toolArgs?: Record<string, any>
): ToolMetadata | undefined {
  try {
    switch (toolName) {
      case ReadFileTool.name:
        return extractReadFileMetadata(result, toolArgs);

      case WriteFileTool.name:
        return extractWriteFileMetadata(result, toolArgs);

      case ListDirectoryTool.name:
        return extractListDirectoryMetadata(result, toolArgs);

      case ExecuteCommandTool.name:
        return extractExecuteCommandMetadata(result, toolArgs);

      default:
        return undefined;
    }
  } catch {
    // If metadata extraction fails, return basic info
    return {
      success: !result.toLowerCase().includes('error'),
      errorMessage: result.toLowerCase().includes('error') ? result : undefined
    };
  }
}

/**
 * Extract metadata from read_file tool results
 */
function extractReadFileMetadata(result: string, toolArgs?: Record<string, any>): ToolMetadata {
  const isError = result.toLowerCase().startsWith('error');

  if (isError) {
    return {
      success: false,
      errorMessage: result,
      filePath: toolArgs?.filePath
    };
  }

  // Parse successful read result: "File: {filePath}\n\n{content}"
  const lines = result.split('\n');
  let filePath = toolArgs?.filePath;

  // Try to extract file path from result if not in args
  if (!filePath && lines[0]?.startsWith('File: ')) {
    filePath = lines[0].substring(6); // Remove "File: " prefix
  }

  // Extract content (skip "File: path" and empty line)
  const contentStart = result.indexOf('\n\n');
  const content = contentStart >= 0 ? result.substring(contentStart + 2) : '';

  // Create content preview (first 3 lines or 100 characters)
  const contentLines = content.split('\n');
  const lineCount = contentLines.length;

  let contentPreview = '';
  if (lineCount > 3) {
    contentPreview = contentLines.slice(0, 3).join('\n') + `\n... (${lineCount} lines total)`;
  } else if (content.length > 100) {
    contentPreview = content.substring(0, 100) + '...';
  } else {
    contentPreview = content;
  }

  return {
    success: true,
    filePath,
    fileSize: Buffer.byteLength(content, 'utf8'),
    contentPreview
  };
}

/**
 * Extract metadata from write_file tool results
 */
function extractWriteFileMetadata(result: string, toolArgs?: Record<string, any>): ToolMetadata {
  const isError = result.toLowerCase().startsWith('error');

  if (isError) {
    return {
      success: false,
      errorMessage: result,
      filePath: toolArgs?.filePath
    };
  }

  // Parse successful result: "Successfully wrote {length} characters to {filePath}"
  const bytesMatch = result.match(/wrote (\d+) characters/);
  const bytesWritten = bytesMatch ? parseInt(bytesMatch[1], 10) : undefined;

  // Try to extract file path from result or use from args
  let filePath = toolArgs?.filePath;
  if (!filePath) {
    const pathMatch = result.match(/to (.+)$/);
    if (pathMatch) {
      filePath = pathMatch[1].trim();
    }
  }

  return {
    success: true,
    filePath,
    bytesWritten,
    contentPreview: toolArgs?.content ?
      (toolArgs.content.length > 50 ?
        toolArgs.content.substring(0, 50) + '...' :
        toolArgs.content) : undefined
  };
}

/**
 * Extract metadata from list_directory tool results
 */
function extractListDirectoryMetadata(result: string, toolArgs?: Record<string, any>): ToolMetadata {
  const isError = result.toLowerCase().startsWith('error');

  if (isError) {
    return {
      success: false,
      errorMessage: result,
      directoryPath: toolArgs?.directoryPath || '.'
    };
  }

  // Count files and directories from the result and extract items for preview
  const lines = result.split('\n');
  let fileCount = 0;
  let directoryCount = 0;
  let inFilesSection = false;
  let inDirectoriesSection = false;
  let directoryPath = toolArgs?.directoryPath;
  const items: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Extract directory path from the result header
    if (trimmedLine.startsWith('Directory:') && !directoryPath) {
      directoryPath = trimmedLine.substring(10).trim();
      continue;
    }

    if (trimmedLine === 'Files:') {
      inFilesSection = true;
      inDirectoriesSection = false;
      continue;
    }
    if (trimmedLine === 'Directories:') {
      inDirectoriesSection = true;
      inFilesSection = false;
      continue;
    }
    if (trimmedLine === '' || trimmedLine.startsWith('Directory:')) {
      inFilesSection = false;
      inDirectoriesSection = false;
      continue;
    }

    // Count items and collect for preview in each section
    if (inFilesSection && line.startsWith('  ') && trimmedLine.length > 0) {
      fileCount++;
      if (items.length < 3) {
        items.push(trimmedLine);
      }
    }
    if (inDirectoriesSection && line.startsWith('  ') && trimmedLine.length > 0) {
      directoryCount++;
      if (items.length < 3) {
        items.push(trimmedLine);
      }
    }
  }

  // Handle empty directory case
  if (result.includes('Directory is empty')) {
    fileCount = 0;
    directoryCount = 0;
  }

  // Create item preview
  let itemPreview = '';
  if (items.length > 0) {
    itemPreview = items.join(', ');
    if (fileCount + directoryCount > items.length) {
      const remaining = (fileCount + directoryCount) - items.length;
      itemPreview += ` +${remaining} more`;
    }
  } else {
    itemPreview = 'Empty directory';
  }

  return {
    success: true,
    directoryPath: directoryPath || '.',
    fileCount,
    directoryCount,
    contentPreview: itemPreview
  };
}

/**
 * Extract metadata from execute_command tool results
 */
function extractExecuteCommandMetadata(result: string, toolArgs?: Record<string, any>): ToolMetadata {
  const isError = result.toLowerCase().includes('error executing command') ||
                  result.toLowerCase().includes('command rejected for security');

  if (isError) {
    return {
      success: false,
      errorMessage: result,
      command: toolArgs?.command
    };
  }

  const command = toolArgs?.command;

  // Extract output preview (first few lines)
  let outputPreview = '';

  if (result.includes('STDOUT:')) {
    const stdoutStart = result.indexOf('STDOUT:\n') + 8;
    const stdoutEnd = result.indexOf('\nSTDERR:');
    const stdout = result.substring(stdoutStart, stdoutEnd > 0 ? stdoutEnd : result.length);

    const lines = stdout.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length > 3) {
      outputPreview = lines.slice(0, 3).join('\n') + `\n... (${lines.length} lines total)`;
    } else if (lines.length > 0) {
      outputPreview = stdout.trim();
    } else {
      outputPreview = 'No output';
    }
  } else if (result === 'Command executed successfully (no output)') {
    outputPreview = 'No output';
  } else {
    // Fallback for other formats - take first few non-empty lines
    const lines = result.split('\n').filter(line => line.trim() !== '');
    if (lines.length > 3) {
      outputPreview = lines.slice(0, 3).join('\n') + '...';
    } else if (lines.length > 0) {
      outputPreview = result.trim();
    } else {
      outputPreview = 'Command executed successfully';
    }
  }

  return {
    success: true,
    command,
    outputPreview: outputPreview || 'Command executed successfully'
  };
}

/**
 * Format tool metadata for display
 */
export function formatToolMetadata(toolName: string, metadata: ToolMetadata): string {
  if (!metadata.success) {
    const baseMsg = `✗ ${toolName} failed${metadata.filePath ? ` (${path.basename(metadata.filePath)})` : ''}`;
    return addTokenInfo(baseMsg, metadata);
  }

  let baseMessage = '';

  switch (toolName) {
    case ReadFileTool.name: {
      const fileName = metadata.filePath ? path.basename(metadata.filePath) : 'file';
      const sizeInfo = metadata.fileSize ? ` (${formatBytes(metadata.fileSize)})` : '';
      baseMessage = `✓ Read ${fileName}${sizeInfo}`;
      break;
    }

    case WriteFileTool.name: {
      const writeFileName = metadata.filePath ? path.basename(metadata.filePath) : 'file';
      const bytesInfo = metadata.bytesWritten ? ` (${formatBytes(metadata.bytesWritten)})` : '';
      baseMessage = `✓ Wrote ${writeFileName}${bytesInfo}`;
      break;
    }

    case ListDirectoryTool.name: {
      const dirName = metadata.directoryPath === '.' ? 'current directory' : path.basename(metadata.directoryPath || '');
      const counts = `${metadata.fileCount || 0} files, ${metadata.directoryCount || 0} dirs`;
      baseMessage = `✓ Listed ${dirName} (${counts})`;
      break;
    }

    case ExecuteCommandTool.name: {
      const cmd = metadata.command ? metadata.command.split(' ')[0] : 'command';
      baseMessage = `✓ Executed ${cmd}`;
      break;
    }

    default:
      baseMessage = `✓ ${toolName} completed`;
  }

  return addTokenInfo(baseMessage, metadata);
}

/**
 * Add token usage information to the tool message
 */
function addTokenInfo(baseMessage: string, metadata: ToolMetadata): string {
  if (!metadata.tokenUsage) {
    return baseMessage;
  }

  const tokenInfo: string[] = [];

  // Add token counts with clear input/output labels
  tokenInfo.push(`${formatTokens(metadata.tokenUsage.inputTokens)} in, ${formatTokens(metadata.tokenUsage.outputTokens)} out`);

  // Add cached tokens if present
  if (metadata.tokenUsage.cachedTokens && metadata.tokenUsage.cachedTokens > 0) {
    tokenInfo.push(`${formatTokens(metadata.tokenUsage.cachedTokens)} cached`);
  }

  // Add cost if present
  if (metadata.tokenUsage.estimatedCost && metadata.tokenUsage.estimatedCost > 0) {
    tokenInfo.push(formatCost(metadata.tokenUsage.estimatedCost));
  }

  if (tokenInfo.length > 0) {
    return `${baseMessage} [${tokenInfo.join(', ')}]`;
  }

  return baseMessage;
}

/**
 * Format bytes in human readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}