/**
 * Analytics settings resolver (EPMCDME-17748).
 *
 * Reads the optional `analytics` block of the global and project CodeMie config files:
 *   { "analytics": { "obfuscation": "on" | "off", "ticketTracker": "jira" | ... } }
 *
 * These live in `codemie-cli.config.json`, not in `.claude/analytics.local.json`: that file holds
 * session state, not user settings, and must not be reused for them.
 *
 * Kept deliberately light (node built-ins plus path helpers, type-only imports otherwise) because
 * it is loaded from the proxy daemon and from hook processes.
 *
 * Rules:
 * - Obfuscation is on if the global or the project layer is on. A project can only turn it on.
 * - `ticketTracker` resolves project over global; unset by default (no git-remote inference).
 * - Results are cached per file and re-read when the file mtime changes.
 * - An unreadable or unparsable file keeps that layer's prior value; a layer that was never read and
 *   cannot be parsed counts as on. A file that disappears after it was read as on keeps its on state.
 *   Obfuscation therefore never silently drops to off once a layer was on.
 * - A missing or non-string `cwd` skips the project layer instead of throwing.
 */

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCodemiePath } from './paths.js';
import type { ObfuscationMode } from './analytics-obfuscation.js';
import type { TicketTracker } from '@/agents/core/ticket-parser.js';

export interface AnalyticsSettings {
  obfuscation: ObfuscationMode;
  ticketTracker?: TicketTracker;
}

interface LayerState {
  /** mtime of the last successful read; -1 when the file was absent. */
  mtimeMs: number;
  obfuscationOn: boolean;
  ticketTracker?: TicketTracker;
}

const CONFIG_FILE = 'codemie-cli.config.json';
const TRACKERS: readonly TicketTracker[] = ['jira', 'azure-devops', 'github', 'gitlab'];
const ABSENT: LayerState = { mtimeMs: -1, obfuscationOn: false };
/** A file that exists but could not be parsed on first read: protective, and never cached. */
const UNREADABLE: LayerState = { mtimeMs: -2, obfuscationOn: true };

const layerCache = new Map<string, LayerState>();

function isTracker(value: unknown): value is TicketTracker {
  return typeof value === 'string' && (TRACKERS as readonly string[]).includes(value);
}

function parseLayer(raw: string, mtimeMs: number): LayerState {
  const parsed: unknown = JSON.parse(raw);
  const analytics = (parsed as { analytics?: { obfuscation?: unknown; ticketTracker?: unknown } } | null)?.analytics;
  return {
    mtimeMs,
    obfuscationOn: analytics?.obfuscation === 'on',
    ...(isTracker(analytics?.ticketTracker) ? { ticketTracker: analytics.ticketTracker } : {}),
  };
}

/** Current state of one config layer; on any read failure the prior state (if any) is kept. */
function readLayer(file: string): LayerState | undefined {
  const prior = layerCache.get(file);
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (prior && prior.mtimeMs === mtimeMs) return prior;
    const next = parseLayer(readFileSync(file, 'utf-8'), mtimeMs);
    layerCache.set(file, next);
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // A config deleted or replaced after an `on` read keeps its `on` state.
      if (prior?.obfuscationOn) return prior;
      layerCache.set(file, ABSENT);
      return ABSENT;
    }
    return prior ?? UNREADABLE;
  }
}

export function resolveAnalyticsSettings(cwd: string | undefined): AnalyticsSettings {
  const global = readLayer(getCodemiePath(CONFIG_FILE));
  const project = typeof cwd === 'string' && cwd.length > 0 ? readLayer(join(cwd, '.codemie', CONFIG_FILE)) : undefined;
  const ticketTracker = project?.ticketTracker ?? global?.ticketTracker;
  return {
    obfuscation: global?.obfuscationOn || project?.obfuscationOn ? 'on' : 'off',
    ...(ticketTracker ? { ticketTracker } : {}),
  };
}
