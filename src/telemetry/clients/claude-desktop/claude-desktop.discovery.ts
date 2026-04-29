import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir, normalizePathSeparators } from '@/utils/paths.js';
import type { LocalTelemetryDiscoveredSession } from '@/telemetry/runtime/types.js';
import { logger } from '@/utils/logger.js';
import {
  getClaudeDesktopCodeSessionsRoot,
  getClaudeDesktopLocalSessionsRoot
} from './claude-desktop.paths.js';

interface DesktopMetadata {
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  originCwd?: string;
  worktreePath?: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  isArchived?: boolean;
}

async function loadCompanionMetadata(metadataPath: string): Promise<DesktopMetadata | null> {
  const localRoot = getClaudeDesktopLocalSessionsRoot();
  const codeRoot = getClaudeDesktopCodeSessionsRoot();
  const companionPath = metadataPath.startsWith(localRoot)
    ? metadataPath.replace(localRoot, codeRoot)
    : metadataPath;

  if (!existsSync(companionPath)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(companionPath, 'utf-8')) as DesktopMetadata;
  } catch (error) {
    logger.debug('[claude-desktop-discovery] Failed to read companion metadata', {
      companionPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function buildClaudeProjectsSlug(projectPath: string): string {
  const normalized = normalizePathSeparators(projectPath).replace(/\/+$/, '');
  return normalized.replaceAll('/', '-');
}

async function resolveClaudeTranscriptPath(metadata: DesktopMetadata): Promise<string | null> {
  if (!metadata.cliSessionId) {
    return null;
  }

  const projectCandidates = [
    metadata.originCwd,
    metadata.worktreePath,
    metadata.cwd
  ].filter((value): value is string => Boolean(value));

  const claudeProjectsRoot = join(resolveHomeDir('.claude'), 'projects');

  for (const projectPath of projectCandidates) {
    const candidate = join(
      claudeProjectsRoot,
      buildClaudeProjectsSlug(projectPath),
      `${metadata.cliSessionId}.jsonl`
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const projectDirs = await readdir(claudeProjectsRoot, { withFileTypes: true });
    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;
      const candidate = join(claudeProjectsRoot, dirent.name, `${metadata.cliSessionId}.jsonl`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch (error) {
    logger.debug('[claude-desktop-discovery] Failed to search ~/.claude/projects for transcript', {
      cliSessionId: metadata.cliSessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.startsWith('local_') && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function discoverClaudeDesktopSessions(
  sinceMs: number
): Promise<LocalTelemetryDiscoveredSession[]> {
  const localRoot = getClaudeDesktopLocalSessionsRoot();
  const codeRoot = getClaudeDesktopCodeSessionsRoot();
  const metadataFiles = [
    ...(existsSync(localRoot) ? await walk(localRoot) : []),
    ...(existsSync(codeRoot) ? await walk(codeRoot) : [])
  ];
  const discovered: LocalTelemetryDiscoveredSession[] = [];
  const seenSessionIds = new Set<string>();

  for (const metadataPath of metadataFiles) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as DesktopMetadata;
      const companionMetadata = await loadCompanionMetadata(metadataPath);
      const transcriptDir = metadataPath.replace(/\.json$/, '');
      const auditTranscriptPath = join(transcriptDir, 'audit.jsonl');
      const claudeTranscriptPath = await resolveClaudeTranscriptPath({
        ...companionMetadata,
        ...metadata
      });
      const transcriptPath = existsSync(auditTranscriptPath)
        ? auditTranscriptPath
        : claudeTranscriptPath;

      if (!metadata.sessionId.startsWith('local_')) continue;
      if (!transcriptPath || !existsSync(transcriptPath)) continue;
      if (metadata.lastActivityAt < sinceMs && metadata.createdAt < sinceMs) continue;
      if (seenSessionIds.has(metadata.sessionId)) continue;

      seenSessionIds.add(metadata.sessionId);

      discovered.push({
        externalSessionId: metadata.sessionId,
        agentSessionId: metadata.cliSessionId || metadata.sessionId,
        transcriptPath,
        metadataPath,
        workingDirectory:
          companionMetadata?.originCwd
          || companionMetadata?.worktreePath
          || metadata.originCwd
          || metadata.worktreePath
          || metadata.cwd
          || transcriptDir,
        createdAt: metadata.createdAt,
        updatedAt: metadata.lastActivityAt,
        model: metadata.model || companionMetadata?.model,
        isArchived: metadata.isArchived
      });
    } catch (error) {
      logger.debug('[claude-desktop-discovery] Failed to read session metadata', {
        metadataPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return discovered.sort((a, b) => a.updatedAt - b.updatedAt);
}
