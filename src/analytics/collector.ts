/**
 * Event collector with buffering
 * Collects analytics events and flushes them periodically
 */

import type { AnalyticsEvent, CollectorConfig } from './types.js';

/**
 * Collects and buffers analytics events
 */
export class EventCollector {
  private buffer: AnalyticsEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private maxBufferSize: number;
  private flushInterval: number;
  private flushCallback?: (events: AnalyticsEvent[]) => Promise<void>;

  constructor(config: CollectorConfig) {
    this.maxBufferSize = config.maxBufferSize;
    this.flushInterval = config.flushInterval;
    this.startFlushTimer();
  }

  /**
   * Add an event to the buffer
   * Auto-flushes if buffer is full
   */
  add(event: AnalyticsEvent): void {
    this.buffer.push(event);

    // Auto-flush if buffer is full
    if (this.buffer.length >= this.maxBufferSize) {
      void this.flush();
    }
  }

  /**
   * Get all buffered events
   */
  getBuffered(): AnalyticsEvent[] {
    return [...this.buffer];
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Flush buffered events
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    if (this.flushCallback) {
      const events = this.getBuffered();
      this.clear();
      await this.flushCallback(events);
    }
  }

  /**
   * Register flush callback
   */
  onFlush(callback: (events: AnalyticsEvent[]) => Promise<void>): void {
    this.flushCallback = callback;
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);

    // Don't prevent process from exiting
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Stop flush timer and cleanup
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
