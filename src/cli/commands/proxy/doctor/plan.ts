/**
 * What the proxy diagnosis and the status commands take from the collection mode: the remedies they name to the user,
 * the mode's own sections and display groups, and the lines that describe its daemon.
 */
import type { AnalyticsHealthReply } from '@/providers/plugins/sso/proxy/plugins/types.js';
import type { DaemonState } from '../daemon-manager.js';
import type { ProxyDoctorGroup } from './groups.js';
import type { Sections } from './sections.js';

/** The commands a hint names to fix a client, a connector or the daemon. */
export interface DoctorRemedies {
  /** Connects a client or connector; `flags` are its connect flags, none for the bare command. */
  connect(flags?: string): string;
  /** Disconnects a client; `flags` are its disconnect flags. */
  disconnect(flags: string): string;
  /** Connects an analytics connector when none is connected. */
  connectAnalytics: string;
  /** Starts a stopped daemon. */
  start: string;
  /** Restarts a running daemon. */
  restart: string;
  /** The words that end an advice to set a connector up again. */
  reconnect: string;
  /** What to know once collection of a connector is back on; `undefined` when there is nothing to say. */
  resumeNote(connectorId: string): string | undefined;
}

export interface DoctorPlan {
  remedies: DoctorRemedies;
  /** The sign-in sections of a running daemon whose `/health` answered with its own pid. */
  authSections(state: DaemonState, reply: AnalyticsHealthReply | undefined, authProbe: boolean): Promise<Sections>;
  /** The analytics delivery sections of a running daemon. */
  deliverySections(state: DaemonState, reply: AnalyticsHealthReply | undefined): Promise<Sections>;
  /**
   * The mode's own sections, after every other one, whether the daemon runs or not. Never rejects: the diagnosis calls it
   * unguarded, so a plan builds its sections under `guarded`, each with its own section id.
   */
  extraSections(): Promise<Sections>;
  /** The display groups, in order. */
  groups: readonly ProxyDoctorGroup[];
  /** What the daemon's running line names after its pid. */
  daemonLabel(state: DaemonState): string;
  /** The `Next:` commands after `proxy stop` and after `proxy status` of a stopped daemon. */
  nextSteps(command: 'stop' | 'status'): string[];
  /** Whether the authenticated probe runs when the caller `requested` it. */
  authProbe(requested: boolean): boolean;
  /** The `proxy status` lines that describe the running daemon's identity. */
  statusLines(state: DaemonState): string[];
  /**
   * Delivery health for `proxy analytics status`: with `json`, the value its `--json` document carries as `delivery`;
   * without, the `lines` its text report ends with.
   */
  deliveryHealth(opts: { json: boolean }): Promise<{ json?: unknown; lines: string[] }>;
}
