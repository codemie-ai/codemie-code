/**
 * Session management for analytics
 * Tracks session lifecycle and metadata
 */

import { randomUUID } from 'node:crypto';
import type { SessionConfig, SessionMetadata } from './types.js';

/**
 * Manages analytics session lifecycle
 */
export class SessionManager {
  private session: SessionMetadata | null = null;

  /**
   * Start a new session
   */
  start(config: SessionConfig): void {
    this.session = {
      id: randomUUID(),
      startTime: Date.now(),
      agent: config.agent,
      agentVersion: config.agentVersion,
      cliVersion: config.cliVersion,
      profile: config.profile,
      provider: config.provider,
      model: config.model,
      workingDir: config.workingDir,
      interactive: config.interactive,
    };
  }

  /**
   * Get current session ID
   */
  get id(): string {
    if (!this.session) {
      throw new Error('No active session');
    }
    return this.session.id;
  }

  /**
   * Get session duration in milliseconds
   */
  get durationMs(): number {
    if (!this.session) {
      return 0;
    }
    return Date.now() - this.session.startTime;
  }

  /**
   * Get session agent name
   */
  get agent(): string {
    return this.session?.agent || 'unknown';
  }

  /**
   * Get session agent version
   */
  get agentVersion(): string {
    return this.session?.agentVersion || 'unknown';
  }

  /**
   * Get session CLI version
   */
  get cliVersion(): string {
    return this.session?.cliVersion || 'unknown';
  }

  /**
   * Get session profile
   */
  get profile(): string {
    return this.session?.profile || 'unknown';
  }

  /**
   * Get session provider
   */
  get provider(): string {
    return this.session?.provider || 'unknown';
  }

  /**
   * Get session model
   */
  get model(): string {
    return this.session?.model || 'unknown';
  }

  /**
   * Check if session is active
   */
  get isActive(): boolean {
    return this.session !== null;
  }

  /**
   * End the current session
   */
  end(): void {
    this.session = null;
  }
}
