/**
 * Analytics Reader Utility
 * Reads and aggregates analytics data from JSONL files
 */

import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AnalyticsEvent } from '../analytics/types.js';
import {
  getUTCDateString,
  localDateToUTCRange,
  getUTCFilesForLocalDate
} from './date-formatter.js';
import { AgentRegistry } from '../agents/registry.js';

export interface AnalyticsFilters {
  agent?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
}

export interface AnalyticsStats {
  totalSessions: number;
  successRate: number;
  avgLatency: number;

  // API metrics
  apiRequests: number;
  apiErrors: number;

  // Agent usage breakdown
  agentUsage: Record<string, {
    displayName: string;
    sessions: number;
    apiCalls: number;
  }>;

  // Model usage breakdown
  modelUsage: Record<string, {
    apiCalls: number;
  }>;
}

/**
 * Get analytics directory path
 */
export function getAnalyticsPath(): string {
  return join(homedir(), '.codemie', 'analytics');
}

/**
 * Get analytics file path for a specific date
 * @param date - Date in YYYY-MM-DD format
 */
export function getAnalyticsFilePath(date: string): string {
  return join(getAnalyticsPath(), `${date}.jsonl`);
}

/**
 * Read analytics events for a specific date
 * @param date - Date in YYYY-MM-DD format (UTC)
 * @returns Array of analytics events
 */
export async function readAnalyticsForDate(date: string): Promise<AnalyticsEvent[]> {
  const filePath = getAnalyticsFilePath(date);
  const events: AnalyticsEvent[] = [];

  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line) as AnalyticsEvent;
          events.push(event);
        } catch {
          // Skip invalid lines
        }
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, return empty array
      return [];
    }
    throw error;
  }

  return events;
}

/**
 * Read analytics events for a local date
 * Handles timezone conversion to read correct UTC files
 * @param localDate - Date in YYYY-MM-DD format (local timezone)
 * @returns Array of analytics events that fall within the local date
 */
export async function readAnalyticsForLocalDate(localDate: string): Promise<AnalyticsEvent[]> {
  // Get UTC files that might contain events for this local date
  const utcDates = getUTCFilesForLocalDate(localDate);

  // Get the UTC time range for the local date
  const { start, end } = localDateToUTCRange(localDate);

  // Read all potentially relevant UTC files
  const allEvents: AnalyticsEvent[] = [];
  for (const utcDate of utcDates) {
    const events = await readAnalyticsForDate(utcDate);
    allEvents.push(...events);
  }

  // Filter to only events within the local date range
  return allEvents.filter(event => {
    const eventTime = new Date(event.timestamp);
    return eventTime >= start && eventTime <= end;
  });
}

/**
 * Read analytics events for a date range (UTC dates)
 * @param from - Start date (YYYY-MM-DD, UTC)
 * @param to - End date (YYYY-MM-DD, UTC)
 * @returns Array of analytics events
 */
export async function readAnalyticsForDateRange(from: string, to: string): Promise<AnalyticsEvent[]> {
  const events: AnalyticsEvent[] = [];
  const fromDate = new Date(from + 'T00:00:00.000Z');
  const toDate = new Date(to + 'T23:59:59.999Z');

  // Iterate through each UTC date in the range
  const currentDate = new Date(fromDate);
  while (currentDate <= toDate) {
    const dateStr = getUTCDateString(currentDate);
    const dateEvents = await readAnalyticsForDate(dateStr);
    events.push(...dateEvents);

    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  return events;
}

/**
 * Read analytics events for a local date range
 * Handles timezone conversion to read correct UTC files
 * @param from - Start date (YYYY-MM-DD, local timezone)
 * @param to - End date (YYYY-MM-DD, local timezone)
 * @returns Array of analytics events that fall within the local date range
 */
export async function readAnalyticsForLocalDateRange(from: string, to: string): Promise<AnalyticsEvent[]> {
  // Get UTC time range for the local date range
  const { start: startLocal } = localDateToUTCRange(from);
  const { end: endLocal } = localDateToUTCRange(to);

  // Determine which UTC files to read
  const utcFrom = getUTCDateString(startLocal);
  const utcTo = getUTCDateString(endLocal);

  // Read all events in UTC range
  const allEvents = await readAnalyticsForDateRange(utcFrom, utcTo);

  // Filter to only events within the local date range
  return allEvents.filter(event => {
    const eventTime = new Date(event.timestamp);
    return eventTime >= startLocal && eventTime <= endLocal;
  });
}

/**
 * Filter analytics events
 * @param events - Array of events to filter
 * @param filters - Filter criteria
 * @returns Filtered events
 */
export function filterEvents(events: AnalyticsEvent[], filters: AnalyticsFilters): AnalyticsEvent[] {
  return events.filter(event => {
    if (filters.agent && event.agent !== filters.agent) {
      return false;
    }

    if (filters.eventType && event.eventType !== filters.eventType) {
      return false;
    }

    if (filters.from || filters.to) {
      const eventDate = new Date(event.timestamp);

      if (filters.from && eventDate < filters.from) {
        return false;
      }

      if (filters.to && eventDate > filters.to) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Calculate statistics from analytics events
 * @param events - Array of analytics events
 * @returns Calculated statistics
 */
export function calculateStats(events: AnalyticsEvent[]): AnalyticsStats {
  const sessions = new Set<string>();
  let totalLatency = 0;
  let latencyCount = 0;

  // API counters
  let apiRequests = 0;
  let apiErrors = 0;

  // Agent usage tracking
  const agentUsage: Record<string, { sessions: Set<string>; apiCalls: number }> = {};

  // Model usage tracking
  const modelUsage: Record<string, { apiCalls: number }> = {};

  for (const event of events) {
    // Track sessions
    if (event.sessionId) {
      sessions.add(event.sessionId);
    }

    // Track event types
    switch (event.eventType) {
      case 'api_request':
        apiRequests++;
        if (event.agent) {
          if (!agentUsage[event.agent]) {
            agentUsage[event.agent] = { sessions: new Set(), apiCalls: 0 };
          }
          agentUsage[event.agent].apiCalls++;
        }
        if (event.model) {
          if (!modelUsage[event.model]) {
            modelUsage[event.model] = { apiCalls: 0 };
          }
          modelUsage[event.model].apiCalls++;
        }
        break;

      case 'api_error':
        apiErrors++;
        if (event.agent) {
          if (!agentUsage[event.agent]) {
            agentUsage[event.agent] = { sessions: new Set(), apiCalls: 0 };
          }
          agentUsage[event.agent].apiCalls++;
        }
        if (event.model) {
          if (!modelUsage[event.model]) {
            modelUsage[event.model] = { apiCalls: 0 };
          }
          modelUsage[event.model].apiCalls++;
        }
        break;
    }

    // Track latency
    if (event.metrics?.latencyMs) {
      totalLatency += event.metrics.latencyMs;
      latencyCount++;
    }

    // Ensure agent sessions are tracked
    if (event.agent && event.sessionId) {
      if (!agentUsage[event.agent]) {
        agentUsage[event.agent] = { sessions: new Set(), apiCalls: 0 };
      }
      agentUsage[event.agent].sessions.add(event.sessionId);
    }
  }

  // Calculate success rate from API responses
  let apiSuccessCount = 0;
  let apiTotalCount = 0;

  for (const event of events) {
    if (event.eventType === 'api_response' && event.attributes.statusCode) {
      apiTotalCount++;
      const statusCode = Number(event.attributes.statusCode);
      if (statusCode >= 200 && statusCode < 300) {
        apiSuccessCount++;
      }
    }
  }

  const successRate = apiTotalCount > 0 ? (apiSuccessCount / apiTotalCount) * 100 : 0;

  // Convert agent usage to final format with display names from registry
  const finalAgentUsage: Record<string, { displayName: string; sessions: number; apiCalls: number }> = {};
  for (const [agentName, data] of Object.entries(agentUsage)) {
    // Get display name from plugin registry
    const adapter = AgentRegistry.getAgent(agentName);
    const displayName = adapter?.displayName || agentName;

    finalAgentUsage[agentName] = {
      displayName,
      sessions: data.sessions.size,
      apiCalls: data.apiCalls
    };
  }

  return {
    totalSessions: sessions.size,
    successRate,
    avgLatency: latencyCount > 0 ? totalLatency / latencyCount : 0,
    apiRequests,
    apiErrors,
    agentUsage: finalAgentUsage,
    modelUsage
  };
}

/**
 * Export analytics events to CSV format
 * @param events - Array of events to export
 * @param outputPath - Output file path
 */
export async function exportToCSV(events: AnalyticsEvent[], outputPath: string): Promise<void> {
  const writeStream = createWriteStream(outputPath);

  // Write CSV header
  const headers = [
    'timestamp',
    'eventType',
    'sessionId',
    'installationId',
    'agent',
    'agentVersion',
    'cliVersion',
    'profile',
    'provider',
    'model',
    'latencyMs',
    'attributes'
  ];
  writeStream.write(headers.join(',') + '\n');

  // Write events
  for (const event of events) {
    const row = [
      event.timestamp,
      event.eventType,
      event.sessionId,
      event.installationId,
      event.agent,
      event.agentVersion,
      event.cliVersion,
      event.profile,
      event.provider,
      event.model,
      event.metrics?.latencyMs || '',
      JSON.stringify(event.attributes).replaceAll('"', '""') // Escape quotes
    ];
    writeStream.write(row.join(',') + '\n');
  }

  writeStream.end();

  return new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

/**
 * Export analytics events to JSON format
 * @param events - Array of events to export
 * @param outputPath - Output file path
 */
export async function exportToJSON(events: AnalyticsEvent[], outputPath: string): Promise<void> {
  const writeStream = createWriteStream(outputPath);

  // Write as JSON array
  writeStream.write('[\n');

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const json = JSON.stringify(event, null, 2);
    const indented = json.split('\n').map(line => '  ' + line).join('\n');
    writeStream.write(indented);

    if (i < events.length - 1) {
      writeStream.write(',\n');
    }
  }

  writeStream.write('\n]\n');
  writeStream.end();

  return new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

/**
 * List all analytics files
 * @returns Array of file info with dates and sizes
 */
export async function listAnalyticsFiles(): Promise<Array<{ date: string; path: string; size: number; events: number }>> {
  const analyticsPath = getAnalyticsPath();
  const files: Array<{ date: string; path: string; size: number; events: number }> = [];

  try {
    const entries = await readdir(analyticsPath);

    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        const filePath = join(analyticsPath, entry);
        const stats = await stat(filePath);
        const date = entry.replace('.jsonl', '');

        // Count events by counting lines
        let eventCount = 0;
        try {
          const fileStream = createReadStream(filePath);
          const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity
          });

          for await (const line of rl) {
            if (line.trim()) {
              eventCount++;
            }
          }
        } catch {
          // If counting fails, estimate from file size
          eventCount = Math.floor(stats.size / 500); // Rough estimate: 500 bytes per event
        }

        files.push({
          date,
          path: filePath,
          size: stats.size,
          events: eventCount
        });
      }
    }

    // Sort by date descending (newest first)
    files.sort((a, b) => b.date.localeCompare(a.date));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory doesn't exist, return empty array
      return [];
    }
    throw error;
  }

  return files;
}

/**
 * Delete analytics files older than a threshold
 * @param olderThanDays - Delete files older than this many days
 * @returns Array of deleted file paths
 */
export async function clearOldAnalytics(olderThanDays: number): Promise<string[]> {
  const files = await listAnalyticsFiles();
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - olderThanDays);

  const deletedFiles: string[] = [];

  for (const file of files) {
    const fileDate = new Date(file.date);

    if (fileDate < threshold) {
      await unlink(file.path);
      deletedFiles.push(file.path);
    }
  }

  return deletedFiles;
}

/**
 * Format file size for display
 * @param bytes - Size in bytes
 * @returns Formatted string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format duration in milliseconds to human-readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}
