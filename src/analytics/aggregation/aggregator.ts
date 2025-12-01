/**
 * CodeMie Analytics Aggregator
 *
 * Main service for aggregating analytics data from multiple AI agents.
 * Uses AgentRegistry to automatically discover all registered analytics adapters.
 */

import { AgentRegistry } from '../../agents/registry.js';
import {
  AggregationOptions,
  CodemieSession,
  SessionDetails,
  AnalyticsReport,
  ReportSummary,
  AgentStats,
  ModelStats,
  ProjectStats,
  DayStats
} from './types.js';

/**
 * Main aggregator service
 */
export class CodemieAnalyticsAggregator {
  /**
   * Aggregate sessions from all agents
   */
  async aggregateSessions(options: AggregationOptions = {}): Promise<CodemieSession[]> {
    const sessions: CodemieSession[] = [];

    // Get all analytics adapters from registry (automatically registered with plugins)
    const adapters = AgentRegistry.getAllAnalyticsAdapters();

    // Filter by agent if specified
    const filteredAdapters = options.agent
      ? adapters.filter(a => a.agentName === options.agent)
      : adapters;

    // Query all adapters in parallel
    const promises = filteredAdapters.map(async (adapter) => {
      try {
        // Check if source is valid
        const isValid = await adapter.validateSource();
        if (!isValid) {
          return;
        }

        // Find sessions matching criteria
        const descriptors = await adapter.findSessions({
          projectPath: options.projectPath,
          dateFrom: options.dateFrom,
          dateTo: options.dateTo,
          limit: options.limit,
          offset: options.offset
        });

        // Extract session details
        for (const descriptor of descriptors) {
          try {
            const session = await adapter.extractSession(descriptor);
            sessions.push(session);
          } catch (error) {
            console.error(`Error extracting session ${descriptor.sessionId}: ${error}`);
          }
        }
      } catch (error) {
        console.error(`Error aggregating ${adapter.displayName} (${adapter.agentName}): ${error}`);
      }
    });

    await Promise.all(promises);

    // Sort by startTime
    return sessions.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }

  /**
   * Get detailed information for a specific session
   */
  async getSessionDetails(sessionId: string, agentName: string): Promise<SessionDetails> {
    // Get adapter from registry
    const adapter = AgentRegistry.getAnalyticsAdapter(agentName);
    if (!adapter) {
      throw new Error(`Unknown agent or no analytics adapter: ${agentName}`);
    }

    // Find session descriptor
    const descriptors = await adapter.findSessions();
    const descriptor = descriptors.find(d => d.sessionId === sessionId);

    if (!descriptor) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Extract all details in parallel
    const [session, messages, toolCalls, fileModifications] = await Promise.all([
      adapter.extractSession(descriptor),
      adapter.extractMessages(descriptor),
      adapter.extractToolCalls(descriptor),
      adapter.extractFileModifications(descriptor)
    ]);

    return {
      session,
      messages,
      toolCalls,
      fileModifications
    };
  }

  /**
   * Generate analytics report with statistics
   */
  async generateReport(options: AggregationOptions = {}): Promise<AnalyticsReport> {
    const sessions = await this.aggregateSessions(options);

    return {
      summary: this.calculateSummary(sessions),
      sessions,
      breakdown: {
        byAgent: this.groupByAgent(sessions),
        byModel: this.groupByModel(sessions),
        byProject: this.groupByProject(sessions),
        byDay: this.groupByDay(sessions)
      }
    };
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(sessions: CodemieSession[]): ReportSummary {
    const totalMessages = sessions.reduce((sum, s) => sum + s.userMessageCount + s.assistantMessageCount, 0);
    const totalTokens = sessions.reduce((sum, s) => sum + s.tokens.total, 0);
    const totalToolCalls = sessions.reduce((sum, s) => sum + s.toolCallCount, 0);
    const totalFileModifications = sessions.reduce((sum, s) => sum + s.fileModifications, 0);

    const durations = sessions.map(s => s.durationMs || 0).filter(d => d > 0);
    const averageSessionDuration = durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;

    const successRate = this.calculateSuccessRate(sessions);

    return {
      totalSessions: sessions.length,
      totalMessages,
      totalTokens,
      totalToolCalls,
      totalFileModifications,
      averageSessionDuration,
      successRate
    };
  }

  /**
   * Calculate success rate (sessions without errors)
   */
  private calculateSuccessRate(sessions: CodemieSession[]): number {
    if (sessions.length === 0) return 0;
    const successfulSessions = sessions.filter(s => !s.hadErrors).length;
    return successfulSessions / sessions.length;
  }

  /**
   * Group sessions by agent
   */
  private groupByAgent(sessions: CodemieSession[]): Record<string, AgentStats> {
    const grouped: Record<string, AgentStats> = {};

    for (const session of sessions) {
      if (!grouped[session.agent]) {
        grouped[session.agent] = {
          sessions: 0,
          messages: 0,
          tokens: 0,
          toolCalls: 0,
          fileModifications: 0,
          averageDuration: 0,
          successRate: 0
        };
      }

      const stats = grouped[session.agent];
      stats.sessions++;
      stats.messages += session.userMessageCount + session.assistantMessageCount;
      stats.tokens += session.tokens.total;
      stats.toolCalls += session.toolCallCount;
      stats.fileModifications += session.fileModifications;
    }

    // Calculate averages
    for (const agent in grouped) {
      const stats = grouped[agent];
      const agentSessions = sessions.filter(s => s.agent === agent);

      const durations = agentSessions.map(s => s.durationMs || 0).filter(d => d > 0);
      stats.averageDuration = durations.length > 0
        ? durations.reduce((sum, d) => sum + d, 0) / durations.length
        : 0;

      stats.successRate = this.calculateSuccessRate(agentSessions);
    }

    return grouped;
  }

  /**
   * Group sessions by model
   */
  private groupByModel(sessions: CodemieSession[]): Record<string, ModelStats> {
    const grouped: Record<string, ModelStats> = {};

    for (const session of sessions) {
      if (!grouped[session.model]) {
        grouped[session.model] = {
          sessions: 0,
          tokens: 0,
          averageTokensPerSession: 0
        };
      }

      const stats = grouped[session.model];
      stats.sessions++;
      stats.tokens += session.tokens.total;
    }

    // Calculate averages
    for (const model in grouped) {
      const stats = grouped[model];
      stats.averageTokensPerSession = stats.tokens / stats.sessions;
    }

    return grouped;
  }

  /**
   * Group sessions by project
   */
  private groupByProject(sessions: CodemieSession[]): Record<string, ProjectStats> {
    const grouped: Record<string, ProjectStats> = {};

    for (const session of sessions) {
      const project = session.projectPath || 'other';
      if (!grouped[project]) {
        grouped[project] = {
          sessions: 0,
          messages: 0,
          fileModifications: 0
        };
      }

      const stats = grouped[project];
      stats.sessions++;
      stats.messages += session.userMessageCount + session.assistantMessageCount;
      stats.fileModifications += session.fileModifications;
    }

    return grouped;
  }

  /**
   * Group sessions by day
   */
  private groupByDay(sessions: CodemieSession[]): Record<string, DayStats> {
    const grouped: Record<string, DayStats> = {};

    for (const session of sessions) {
      const date = session.startTime.toISOString().split('T')[0];
      if (!grouped[date]) {
        grouped[date] = {
          date,
          sessions: 0,
          messages: 0,
          tokens: 0
        };
      }

      const stats = grouped[date];
      stats.sessions++;
      stats.messages += session.userMessageCount + session.assistantMessageCount;
      stats.tokens += session.tokens.total;
    }

    return grouped;
  }
}
