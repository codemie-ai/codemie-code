/**
 * Analytics aggregator - processes raw session data into hierarchical analytics
 * Uses core MetricDelta type from src/metrics/types.ts
 */

import type {
  SessionAnalytics,
  BranchAnalytics,
  ProjectAnalytics,
  RootAnalytics,
  TokenBreakdown,
  ModelStats,
  ToolStats,
  LanguageStats,
  FileOperationSummary
} from './types.js';
import type { MetricDelta } from '../../../agents/core/metrics/types.js';
import type { RawSessionData } from './data-loader.js';
import { normalizeModelName } from './model-normalizer.js';

/**
 * Aggregates raw session data into hierarchical analytics
 */
export class AnalyticsAggregator {
  private static shouldNormalizeModels = true;

  /**
   * Process raw sessions into root analytics
   */
  static aggregate(rawSessions: RawSessionData[], normalizeModels = true): RootAnalytics {
    this.shouldNormalizeModels = normalizeModels;

    // Build session analytics first
    const sessions = rawSessions
      .map(raw => this.buildSessionAnalytics(raw))
      .filter((s): s is SessionAnalytics => s !== null);

    // Group deltas by project → branch across ALL sessions
    // Key: project → branch, Value: deltas from all sessions on that branch
    const projectBranchDeltas = new Map<string, Map<string, MetricDelta[]>>();

    // Collect all deltas grouped by project and branch
    for (const raw of rawSessions) {
      if (!raw.startEvent) continue;
      const projectPath = raw.startEvent.data.workingDirectory || 'Unknown';

      // Group deltas from this session by branch
      for (const delta of raw.deltas) {
        const branchName = delta.gitBranch || 'Unknown';

        // Get or create project map
        if (!projectBranchDeltas.has(projectPath)) {
          projectBranchDeltas.set(projectPath, new Map());
        }

        const branchMap = projectBranchDeltas.get(projectPath)!;

        // Get or create branch deltas array
        if (!branchMap.has(branchName)) {
          branchMap.set(branchName, []);
        }

        branchMap.get(branchName)!.push(delta);
      }
    }

    // Build project → branch hierarchy from aggregated deltas
    const projectsMap = new Map<string, ProjectAnalytics>();

    for (const [projectPath, branchMap] of projectBranchDeltas) {
      // Get or create project
      if (!projectsMap.has(projectPath)) {
        projectsMap.set(projectPath, {
          projectPath,
          branches: [],
          totalSessions: 0,
          totalDuration: 0,
          totalTokens: this.emptyTokenBreakdown(),
          totalTurns: 0,
          totalFileOperations: 0,
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          totalLinesModified: 0,
          netLinesChanged: 0,
          totalToolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
          toolSuccessRate: 0,
          models: [],
          tools: [],
          languages: [],
          formats: []
        });
      }

      const project = projectsMap.get(projectPath)!;

      // Create branch analytics from aggregated deltas
      for (const [branchName, deltas] of branchMap) {
        // Find which sessions contributed to this branch
        const contributingSessions = sessions.filter(session =>
          session.workingDirectory === projectPath
        );

        const branch: BranchAnalytics = {
          branchName,
          sessions: contributingSessions, // Sessions that contributed deltas to this branch
          totalSessions: new Set(deltas.map(d => d.sessionId)).size, // Count unique sessions
          totalDuration: 0, // Will be calculated from sessions
          totalTokens: this.calculateTokenBreakdown(deltas),
          totalTurns: deltas.length,
          totalFileOperations: 0,
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          totalLinesModified: 0,
          netLinesChanged: 0,
          totalToolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
          toolSuccessRate: 0,
          models: [],
          tools: [],
          languages: [],
          formats: []
        };

        // Aggregate branch metrics from deltas
        this.aggregateBranchFromDeltas(branch, deltas);

        project.branches.push(branch);
      }
    }

    // Aggregate project stats from branches
    for (const project of projectsMap.values()) {
      this.aggregateProject(project);
    }

    // Build root analytics
    const projects = Array.from(projectsMap.values());
    const root: RootAnalytics = {
      projects,
      totalSessions: 0,
      totalDuration: 0,
      totalTokens: this.emptyTokenBreakdown(),
      totalTurns: 0,
      totalFileOperations: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalLinesModified: 0,
      netLinesChanged: 0,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      toolSuccessRate: 0,
      models: [],
      tools: [],
      languages: [],
      formats: []
    };

    this.aggregateRoot(root);

    return root;
  }

  /**
   * Build session analytics from raw records (using MetricDelta)
   */
  private static buildSessionAnalytics(raw: RawSessionData): SessionAnalytics | null {
    const startEvent = raw.startEvent;
    const endEvent = raw.endEvent;
    const deltas = raw.deltas;

    if (!startEvent) {
      return null;
    }

    // Calculate token breakdown from MetricDelta records
    const tokens = this.calculateTokenBreakdown(deltas);

    // Build model distribution from MetricDelta.models
    const modelCounts = new Map<string, number>();
    for (const delta of deltas) {
      if (delta.models) {
        for (const model of delta.models) {
          const modelName = this.shouldNormalizeModels ? normalizeModelName(model) : model;
          modelCounts.set(modelName, (modelCounts.get(modelName) || 0) + 1);
        }
      }
    }
    const totalModelCalls = Array.from(modelCounts.values()).reduce((sum, count) => sum + count, 0);
    const models: ModelStats[] = Array.from(modelCounts.entries())
      .map(([model, calls]) => ({
        model,
        calls,
        percentage: totalModelCalls > 0 ? (calls / totalModelCalls) * 100 : 0
      }))
      .sort((a, b) => b.calls - a.calls);

    // Build tool usage stats from MetricDelta.toolStatus
    const toolCounts = new Map<string, { success: number; failure: number }>();
    for (const delta of deltas) {
      if (delta.toolStatus) {
        for (const [toolName, status] of Object.entries(delta.toolStatus)) {
          if (!toolCounts.has(toolName)) {
            toolCounts.set(toolName, { success: 0, failure: 0 });
          }
          const counts = toolCounts.get(toolName)!;
          counts.success += status.success;
          counts.failure += status.failure;
        }
      }
    }

    const tools: ToolStats[] = Array.from(toolCounts.entries())
      .map(([toolName, counts]) => {
        const total = counts.success + counts.failure;
        return {
          toolName,
          totalCalls: total,
          successCount: counts.success,
          failureCount: counts.failure,
          successRate: total > 0 ? (counts.success / total) * 100 : 0
        };
      })
      .sort((a, b) => b.totalCalls - a.totalCalls);

    // Build file operation summaries from MetricDelta.fileOperations
    const fileOps = new Map<string, FileOperationSummary>();
    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const fileOp of delta.fileOperations) {
          if (!fileOp.path) continue;

          if (!fileOps.has(fileOp.path)) {
            fileOps.set(fileOp.path, {
              filePath: fileOp.path,
              operationCount: 0,
              linesAdded: 0,
              linesRemoved: 0,
              linesModified: 0,
              netLinesChanged: 0
            });
          }

          const summary = fileOps.get(fileOp.path)!;
          summary.operationCount++;
          summary.linesAdded += fileOp.linesAdded || 0;
          summary.linesRemoved += fileOp.linesRemoved || 0;
          summary.linesModified += fileOp.linesModified || 0;
          summary.netLinesChanged += (fileOp.linesAdded || 0) - (fileOp.linesRemoved || 0);
        }
      }
    }

    // Build language stats from FileOperation.language
    const languageCounts = new Map<string, { created: number; modified: number; lines: number; tokens: number }>();
    const totalLines = Array.from(fileOps.values()).reduce((sum, f) => sum + f.linesAdded, 0) || 1;

    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const fileOp of delta.fileOperations) {
          if (!fileOp.language) continue;

          const lang = fileOp.language;
          if (!languageCounts.has(lang)) {
            languageCounts.set(lang, { created: 0, modified: 0, lines: 0, tokens: 0 });
          }

          const counts = languageCounts.get(lang)!;
          if (fileOp.type === 'write') {
            counts.created++;
          } else if (fileOp.type === 'edit') {
            counts.modified++;
          }
          counts.lines += fileOp.linesAdded || 0;

          // Proportional token attribution
          const tokenShare = ((fileOp.linesAdded || 0) / totalLines) * tokens.total;
          counts.tokens += tokenShare;
        }
      }
    }

    const languages: LanguageStats[] = Array.from(languageCounts.entries())
      .map(([language, counts]) => ({
        language,
        filesCreated: counts.created,
        filesModified: counts.modified,
        linesAdded: counts.lines,
        linesRemoved: 0,
        tokens: counts.tokens,
        percentage: totalLines > 0 ? (counts.lines / totalLines) * 100 : 0
      }))
      .sort((a, b) => b.linesAdded - a.linesAdded);

    // Build format stats from FileOperation.format
    const formatCounts = new Map<string, { created: number; modified: number; lines: number; tokens: number }>();

    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const fileOp of delta.fileOperations) {
          if (!fileOp.format) continue;

          const fmt = fileOp.format;
          if (!formatCounts.has(fmt)) {
            formatCounts.set(fmt, { created: 0, modified: 0, lines: 0, tokens: 0 });
          }

          const counts = formatCounts.get(fmt)!;
          if (fileOp.type === 'write') {
            counts.created++;
          } else if (fileOp.type === 'edit') {
            counts.modified++;
          }
          counts.lines += fileOp.linesAdded || 0;

          // Proportional token attribution
          const tokenShare = ((fileOp.linesAdded || 0) / totalLines) * tokens.total;
          counts.tokens += tokenShare;
        }
      }
    }

    const formats: LanguageStats[] = Array.from(formatCounts.entries())
      .map(([language, counts]) => ({
        language,
        filesCreated: counts.created,
        filesModified: counts.modified,
        linesAdded: counts.lines,
        linesRemoved: 0,
        tokens: counts.tokens,
        percentage: totalLines > 0 ? (counts.lines / totalLines) * 100 : 0
      }))
      .sort((a, b) => b.linesAdded - a.linesAdded);

    // Calculate aggregated stats
    const fileOpsArray = Array.from(fileOps.values());
    const totalFileOperations = fileOpsArray.length;
    const totalLinesAdded = fileOpsArray.reduce((sum, f) => sum + f.linesAdded, 0);
    const totalLinesRemoved = fileOpsArray.reduce((sum, f) => sum + f.linesRemoved, 0);
    const totalLinesModified = fileOpsArray.reduce((sum, f) => sum + f.linesModified, 0);
    const netLinesChanged = totalLinesAdded - totalLinesRemoved;

    const totalToolCalls = tools.reduce((sum, t) => sum + t.totalCalls, 0);
    const successfulToolCalls = tools.reduce((sum, t) => sum + t.successCount, 0);
    const failedToolCalls = tools.reduce((sum, t) => sum + t.failureCount, 0);
    const toolSuccessRate = totalToolCalls > 0 ? (successfulToolCalls / totalToolCalls) * 100 : 0;

    return {
      sessionId: raw.sessionId,
      agentName: startEvent.agentName,
      provider: startEvent.data.provider,
      workingDirectory: startEvent.data.workingDirectory,
      startTime: startEvent.data.startTime,
      endTime: endEvent?.data.endTime || Date.now(),
      duration: endEvent?.data.duration || (Date.now() - startEvent.data.startTime),
      tokens,
      totalTurns: deltas.length,
      totalFileOperations,
      totalLinesAdded,
      totalLinesRemoved,
      totalLinesModified,
      netLinesChanged,
      totalToolCalls,
      successfulToolCalls,
      failedToolCalls,
      toolSuccessRate,
      models,
      tools,
      files: fileOpsArray,
      languages,
      formats
    };
  }

  /**
   * Calculate token breakdown from MetricDelta records
   */
  private static calculateTokenBreakdown(deltas: MetricDelta[]): TokenBreakdown {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheCreation = 0;

    for (const delta of deltas) {
      input += delta.tokens.input || 0;
      output += delta.tokens.output || 0;
      cacheRead += delta.tokens.cacheRead || 0;
      cacheCreation += delta.tokens.cacheCreation || 0;
    }

    const total = input + output + cacheRead + cacheCreation;
    const totalInput = input + cacheCreation + cacheRead;
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

    return {
      input,
      output,
      cacheRead,
      cacheCreation,
      total,
      cacheHitRate
    };
  }

  /**
   * Aggregate branch statistics directly from deltas
   * Used for branch-level aggregation across all sessions
   */
  private static aggregateBranchFromDeltas(branch: BranchAnalytics, deltas: MetricDelta[]): void {
    // Calculate duration from contributing sessions
    branch.totalDuration = branch.sessions.reduce((sum, s) => sum + s.duration, 0);

    // File operations and line counts
    const fileOps = new Map<string, { linesAdded: number; linesRemoved: number; linesModified: number }>();

    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const op of delta.fileOperations) {
          if (op.path) {
            const existing = fileOps.get(op.path) || { linesAdded: 0, linesRemoved: 0, linesModified: 0 };
            existing.linesAdded += op.linesAdded || 0;
            existing.linesRemoved += op.linesRemoved || 0;
            existing.linesModified += op.linesModified || 0;
            fileOps.set(op.path, existing);
          }
        }
      }
    }

    const fileOpsArray = Array.from(fileOps.values());
    branch.totalFileOperations = fileOpsArray.length;
    branch.totalLinesAdded = fileOpsArray.reduce((sum, f) => sum + f.linesAdded, 0);
    branch.totalLinesRemoved = fileOpsArray.reduce((sum, f) => sum + f.linesRemoved, 0);
    branch.totalLinesModified = fileOpsArray.reduce((sum, f) => sum + f.linesModified, 0);
    branch.netLinesChanged = branch.totalLinesAdded - branch.totalLinesRemoved;

    // Tool calls
    let totalToolCalls = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;

    for (const delta of deltas) {
      if (delta.tools) {
        for (const count of Object.values(delta.tools)) {
          totalToolCalls += count;
        }
      }
      if (delta.toolStatus) {
        for (const status of Object.values(delta.toolStatus)) {
          successfulToolCalls += status.success || 0;
          failedToolCalls += status.failure || 0;
        }
      }
    }

    branch.totalToolCalls = totalToolCalls;
    branch.successfulToolCalls = successfulToolCalls;
    branch.failedToolCalls = failedToolCalls;
    branch.toolSuccessRate = totalToolCalls > 0 ? (successfulToolCalls / totalToolCalls) * 100 : 0;

    // Models - aggregate from deltas
    const modelCounts = new Map<string, number>();
    for (const delta of deltas) {
      if (delta.models) {
        for (const model of delta.models) {
          const normalizedModel = this.shouldNormalizeModels ? normalizeModelName(model) : model;
          modelCounts.set(normalizedModel, (modelCounts.get(normalizedModel) || 0) + 1);
        }
      }
    }
    const totalModelCalls = Array.from(modelCounts.values()).reduce((sum, count) => sum + count, 0);
    branch.models = Array.from(modelCounts.entries()).map(([model, count]) => ({
      model,
      calls: count,
      percentage: totalModelCalls > 0 ? (count / totalModelCalls) * 100 : 0
    })).sort((a, b) => b.calls - a.calls);

    // Tools - aggregate from deltas
    const toolCounts = new Map<string, { total: number; success: number; failure: number }>();
    for (const delta of deltas) {
      if (delta.tools) {
        for (const [toolName, count] of Object.entries(delta.tools)) {
          const existing = toolCounts.get(toolName) || { total: 0, success: 0, failure: 0 };
          existing.total += count;
          toolCounts.set(toolName, existing);
        }
      }
      if (delta.toolStatus) {
        for (const [toolName, status] of Object.entries(delta.toolStatus)) {
          const existing = toolCounts.get(toolName) || { total: 0, success: 0, failure: 0 };
          existing.success += status.success || 0;
          existing.failure += status.failure || 0;
          toolCounts.set(toolName, existing);
        }
      }
    }
    branch.tools = Array.from(toolCounts.entries()).map(([toolName, counts]) => ({
      toolName,
      totalCalls: counts.total,
      successCount: counts.success,
      failureCount: counts.failure,
      successRate: counts.total > 0 ? (counts.success / counts.total) * 100 : 0
    })).sort((a, b) => b.totalCalls - a.totalCalls);

    // Languages and formats - aggregate from file operations
    const languageCounts = new Map<string, {
      filesCreated: Set<string>;
      filesModified: Set<string>;
      linesAdded: number;
      linesRemoved: number;
      tokens: number;
    }>();
    const formatCounts = new Map<string, {
      filesCreated: Set<string>;
      filesModified: Set<string>;
      linesAdded: number;
      linesRemoved: number;
      tokens: number;
    }>();

    // Track file operations per language/format
    for (const delta of deltas) {
      if (delta.fileOperations) {
        for (const op of delta.fileOperations) {
          const deltaTokens = (delta.tokens.input || 0) + (delta.tokens.output || 0);

          if (op.language) {
            const existing = languageCounts.get(op.language) || {
              filesCreated: new Set(),
              filesModified: new Set(),
              linesAdded: 0,
              linesRemoved: 0,
              tokens: 0
            };

            if (op.type === 'write' && op.path) {
              existing.filesCreated.add(op.path);
            } else if (op.type === 'edit' && op.path) {
              existing.filesModified.add(op.path);
            }

            existing.linesAdded += op.linesAdded || 0;
            existing.linesRemoved += op.linesRemoved || 0;
            existing.tokens += deltaTokens;
            languageCounts.set(op.language, existing);
          }

          if (op.format) {
            const existing = formatCounts.get(op.format) || {
              filesCreated: new Set(),
              filesModified: new Set(),
              linesAdded: 0,
              linesRemoved: 0,
              tokens: 0
            };

            if (op.type === 'write' && op.path) {
              existing.filesCreated.add(op.path);
            } else if (op.type === 'edit' && op.path) {
              existing.filesModified.add(op.path);
            }

            existing.linesAdded += op.linesAdded || 0;
            existing.linesRemoved += op.linesRemoved || 0;
            existing.tokens += deltaTokens;
            formatCounts.set(op.format, existing);
          }
        }
      }
    }

    const totalLinesForLang = Array.from(languageCounts.values()).reduce((sum, l) => sum + l.linesAdded, 0);
    branch.languages = Array.from(languageCounts.entries()).map(([language, data]) => ({
      language,
      filesCreated: data.filesCreated.size,
      filesModified: data.filesModified.size,
      linesAdded: data.linesAdded,
      linesRemoved: data.linesRemoved,
      tokens: data.tokens,
      percentage: totalLinesForLang > 0 ? (data.linesAdded / totalLinesForLang) * 100 : 0
    })).sort((a, b) => b.linesAdded - a.linesAdded);

    const totalLinesForFormat = Array.from(formatCounts.values()).reduce((sum, l) => sum + l.linesAdded, 0);
    branch.formats = Array.from(formatCounts.entries()).map(([format, data]) => ({
      language: format,
      filesCreated: data.filesCreated.size,
      filesModified: data.filesModified.size,
      linesAdded: data.linesAdded,
      linesRemoved: data.linesRemoved,
      tokens: data.tokens,
      percentage: totalLinesForFormat > 0 ? (data.linesAdded / totalLinesForFormat) * 100 : 0
    })).sort((a, b) => b.linesAdded - a.linesAdded);
  }

  /**
   * Aggregate branch statistics from sessions (legacy method, no longer used)
   */
  private static aggregateBranch(branch: BranchAnalytics): void {
    branch.totalSessions = branch.sessions.length;
    branch.totalDuration = branch.sessions.reduce((sum, s) => sum + s.duration, 0);
    branch.totalTurns = branch.sessions.reduce((sum, s) => sum + s.totalTurns, 0);
    branch.totalFileOperations = branch.sessions.reduce((sum, s) => sum + s.totalFileOperations, 0);
    branch.totalLinesAdded = branch.sessions.reduce((sum, s) => sum + s.totalLinesAdded, 0);
    branch.totalLinesRemoved = branch.sessions.reduce((sum, s) => sum + s.totalLinesRemoved, 0);
    branch.totalLinesModified = branch.sessions.reduce((sum, s) => sum + s.totalLinesModified, 0);
    branch.netLinesChanged = branch.sessions.reduce((sum, s) => sum + s.netLinesChanged, 0);
    branch.totalToolCalls = branch.sessions.reduce((sum, s) => sum + s.totalToolCalls, 0);
    branch.successfulToolCalls = branch.sessions.reduce((sum, s) => sum + s.successfulToolCalls, 0);
    branch.failedToolCalls = branch.sessions.reduce((sum, s) => sum + s.failedToolCalls, 0);
    branch.toolSuccessRate = branch.totalToolCalls > 0 ? (branch.successfulToolCalls / branch.totalToolCalls) * 100 : 0;

    // Aggregate tokens
    branch.totalTokens = {
      input: branch.sessions.reduce((sum, s) => sum + s.tokens.input, 0),
      output: branch.sessions.reduce((sum, s) => sum + s.tokens.output, 0),
      cacheRead: branch.sessions.reduce((sum, s) => sum + s.tokens.cacheRead, 0),
      cacheCreation: branch.sessions.reduce((sum, s) => sum + s.tokens.cacheCreation, 0),
      total: branch.sessions.reduce((sum, s) => sum + s.tokens.total, 0),
      cacheHitRate: 0
    };
    const totalInput = branch.totalTokens.input + branch.totalTokens.cacheCreation + branch.totalTokens.cacheRead;
    branch.totalTokens.cacheHitRate = totalInput > 0 ? branch.totalTokens.cacheRead / totalInput : 0;

    // Aggregate models
    branch.models = this.aggregateModels(branch.sessions.flatMap(s => s.models));

    // Aggregate tools
    branch.tools = this.aggregateTools(branch.sessions.flatMap(s => s.tools));

    // Aggregate languages
    branch.languages = this.aggregateLanguages(branch.sessions.flatMap(s => s.languages));

    // Aggregate formats
    branch.formats = this.aggregateLanguages(branch.sessions.flatMap(s => s.formats));
  }

  /**
   * Aggregate project statistics from branches
   */
  private static aggregateProject(project: ProjectAnalytics): void {
    project.totalSessions = project.branches.reduce((sum, b) => sum + b.totalSessions, 0);
    project.totalDuration = project.branches.reduce((sum, b) => sum + b.totalDuration, 0);
    project.totalTurns = project.branches.reduce((sum, b) => sum + b.totalTurns, 0);
    project.totalFileOperations = project.branches.reduce((sum, b) => sum + b.totalFileOperations, 0);
    project.totalLinesAdded = project.branches.reduce((sum, b) => sum + b.totalLinesAdded, 0);
    project.totalLinesRemoved = project.branches.reduce((sum, b) => sum + b.totalLinesRemoved, 0);
    project.totalLinesModified = project.branches.reduce((sum, b) => sum + b.totalLinesModified, 0);
    project.netLinesChanged = project.branches.reduce((sum, b) => sum + b.netLinesChanged, 0);
    project.totalToolCalls = project.branches.reduce((sum, b) => sum + b.totalToolCalls, 0);
    project.successfulToolCalls = project.branches.reduce((sum, b) => sum + b.successfulToolCalls, 0);
    project.failedToolCalls = project.branches.reduce((sum, b) => sum + b.failedToolCalls, 0);
    project.toolSuccessRate = project.totalToolCalls > 0 ? (project.successfulToolCalls / project.totalToolCalls) * 100 : 0;

    // Aggregate tokens
    project.totalTokens = {
      input: project.branches.reduce((sum, b) => sum + b.totalTokens.input, 0),
      output: project.branches.reduce((sum, b) => sum + b.totalTokens.output, 0),
      cacheRead: project.branches.reduce((sum, b) => sum + b.totalTokens.cacheRead, 0),
      cacheCreation: project.branches.reduce((sum, b) => sum + b.totalTokens.cacheCreation, 0),
      total: project.branches.reduce((sum, b) => sum + b.totalTokens.total, 0),
      cacheHitRate: 0
    };
    const totalInput = project.totalTokens.input + project.totalTokens.cacheCreation + project.totalTokens.cacheRead;
    project.totalTokens.cacheHitRate = totalInput > 0 ? project.totalTokens.cacheRead / totalInput : 0;

    // Aggregate models
    project.models = this.aggregateModels(project.branches.flatMap(b => b.models));

    // Aggregate tools
    project.tools = this.aggregateTools(project.branches.flatMap(b => b.tools));

    // Aggregate languages
    project.languages = this.aggregateLanguages(project.branches.flatMap(b => b.languages));

    // Aggregate formats
    project.formats = this.aggregateLanguages(project.branches.flatMap(b => b.formats));
  }

  /**
   * Aggregate root statistics from projects
   */
  private static aggregateRoot(root: RootAnalytics): void {
    root.totalSessions = root.projects.reduce((sum, p) => sum + p.totalSessions, 0);
    root.totalDuration = root.projects.reduce((sum, p) => sum + p.totalDuration, 0);
    root.totalTurns = root.projects.reduce((sum, p) => sum + p.totalTurns, 0);
    root.totalFileOperations = root.projects.reduce((sum, p) => sum + p.totalFileOperations, 0);
    root.totalLinesAdded = root.projects.reduce((sum, p) => sum + p.totalLinesAdded, 0);
    root.totalLinesRemoved = root.projects.reduce((sum, p) => sum + p.totalLinesRemoved, 0);
    root.totalLinesModified = root.projects.reduce((sum, p) => sum + p.totalLinesModified, 0);
    root.netLinesChanged = root.projects.reduce((sum, p) => sum + p.netLinesChanged, 0);
    root.totalToolCalls = root.projects.reduce((sum, p) => sum + p.totalToolCalls, 0);
    root.successfulToolCalls = root.projects.reduce((sum, p) => sum + p.successfulToolCalls, 0);
    root.failedToolCalls = root.projects.reduce((sum, p) => sum + p.failedToolCalls, 0);
    root.toolSuccessRate = root.totalToolCalls > 0 ? (root.successfulToolCalls / root.totalToolCalls) * 100 : 0;

    // Aggregate tokens
    root.totalTokens = {
      input: root.projects.reduce((sum, p) => sum + p.totalTokens.input, 0),
      output: root.projects.reduce((sum, p) => sum + p.totalTokens.output, 0),
      cacheRead: root.projects.reduce((sum, p) => sum + p.totalTokens.cacheRead, 0),
      cacheCreation: root.projects.reduce((sum, p) => sum + p.totalTokens.cacheCreation, 0),
      total: root.projects.reduce((sum, p) => sum + p.totalTokens.total, 0),
      cacheHitRate: 0
    };
    const totalInput = root.totalTokens.input + root.totalTokens.cacheCreation + root.totalTokens.cacheRead;
    root.totalTokens.cacheHitRate = totalInput > 0 ? root.totalTokens.cacheRead / totalInput : 0;

    // Aggregate models
    root.models = this.aggregateModels(root.projects.flatMap(p => p.models));

    // Aggregate tools
    root.tools = this.aggregateTools(root.projects.flatMap(p => p.tools));

    // Aggregate languages
    root.languages = this.aggregateLanguages(root.projects.flatMap(p => p.languages));

    // Aggregate formats
    root.formats = this.aggregateLanguages(root.projects.flatMap(p => p.formats));
  }

  /**
   * Aggregate model statistics
   */
  private static aggregateModels(models: ModelStats[]): ModelStats[] {
    const modelCounts = new Map<string, number>();

    for (const model of models) {
      modelCounts.set(model.model, (modelCounts.get(model.model) || 0) + model.calls);
    }

    const totalCalls = Array.from(modelCounts.values()).reduce((sum, count) => sum + count, 0);

    return Array.from(modelCounts.entries())
      .map(([model, calls]) => ({
        model,
        calls,
        percentage: totalCalls > 0 ? (calls / totalCalls) * 100 : 0
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * Aggregate tool statistics
   */
  private static aggregateTools(tools: ToolStats[]): ToolStats[] {
    const toolCounts = new Map<string, { success: number; failure: number }>();

    for (const tool of tools) {
      if (!toolCounts.has(tool.toolName)) {
        toolCounts.set(tool.toolName, { success: 0, failure: 0 });
      }

      const counts = toolCounts.get(tool.toolName)!;
      counts.success += tool.successCount;
      counts.failure += tool.failureCount;
    }

    return Array.from(toolCounts.entries())
      .map(([toolName, counts]) => {
        const total = counts.success + counts.failure;
        return {
          toolName,
          totalCalls: total,
          successCount: counts.success,
          failureCount: counts.failure,
          successRate: total > 0 ? (counts.success / total) * 100 : 0
        };
      })
      .sort((a, b) => b.totalCalls - a.totalCalls);
  }

  /**
   * Aggregate language/format statistics
   */
  private static aggregateLanguages(languages: LanguageStats[]): LanguageStats[] {
    const langCounts = new Map<string, { created: number; modified: number; lines: number; tokens: number }>();

    for (const lang of languages) {
      if (!langCounts.has(lang.language)) {
        langCounts.set(lang.language, { created: 0, modified: 0, lines: 0, tokens: 0 });
      }

      const counts = langCounts.get(lang.language)!;
      counts.created += lang.filesCreated;
      counts.modified += lang.filesModified;
      counts.lines += lang.linesAdded;
      counts.tokens += lang.tokens;
    }

    const totalLines = Array.from(langCounts.values()).reduce((sum, c) => sum + c.lines, 0) || 1;

    return Array.from(langCounts.entries())
      .map(([language, counts]) => ({
        language,
        filesCreated: counts.created,
        filesModified: counts.modified,
        linesAdded: counts.lines,
        linesRemoved: 0,
        tokens: counts.tokens,
        percentage: totalLines > 0 ? (counts.lines / totalLines) * 100 : 0
      }))
      .sort((a, b) => b.linesAdded - a.linesAdded);
  }

  /**
   * Create empty token breakdown
   */
  private static emptyTokenBreakdown(): TokenBreakdown {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      cacheHitRate: 0
    };
  }
}
