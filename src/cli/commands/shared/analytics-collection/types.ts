/**
 * The object of a collection mode: every part of the CLI that collects, exports, installs, removes or diagnoses
 * analytics differently by mode takes its part from one `AnalyticsCollection`.
 */
import type { CollectionPolicy } from '@/agents/core/types.js';
import type { ExportSource, SyncSettings } from '../../analytics/sync/types.js';
import type { DoctorPlan } from '../../proxy/doctor/plan.js';
import type { ProxyStartOptions } from '../../proxy/start.js';
import type { ProxyRestartOptions } from '../../proxy/restart.js';

/** What one install step did: `skipped` — it had nothing to do; `absent` — its client is not on this machine. */
export interface StepOutcome {
  name: string;
  state: 'done' | 'skipped' | 'absent';
  note?: string;
}

/** One step of a mode's install, run before the job is registered and undone when the install fails after it. */
export interface InstallStep {
  name: string;
  apply(): Promise<StepOutcome>;
  undo(): Promise<void>;
}

export interface InstallPlan {
  /** The steps for the settings the install is about to write. */
  steps(settings: SyncSettings): InstallStep[];
  /** Settings fields the mode adds, given the job's command. */
  settingsExtras(job: { node: string; entry: string }): Partial<SyncSettings>;
  /**
   * The summary lines of the steps' outcomes, or the failure that ends the install. `standDown` — the plan asks for
   * none of its changes: the install undoes the plan's steps and saves none of the plan's settings, and prints the
   * summary; `undoFailed` is what the install prints instead when a step of the plan could not be undone.
   */
  conclude(outcomes: StepOutcome[]): { summary: string[]; failure?: string; standDown?: { undoFailed: string } };
}

export interface AnalyticsCollection {
  /** The policy the hook adapters collect under. */
  hookPolicy(): CollectionPolicy;
  /** Brings up the daemon a hook or a launched agent needs. */
  launcher: (agentName: string, event?: string) => Promise<void>;
  /** The files the daily sync delivers. */
  exportSource(): ExportSource;
  install: InstallPlan;
  /**
   * The mode's own removal around the uninstall's: it calls `removeInstall` once, and answers whether its own removal
   * took anything away.
   */
  teardown(removeInstall: () => Promise<void>): Promise<boolean>;
  /** The lines `sync status` prints after its first line. */
  statusLines(): string[];
  doctor: DoctorPlan;
  /** Refuses a `proxy` command the mode does not allow; returns when it may run. */
  guardProxyCommand(name: 'connect' | 'disconnect'): void;
  /** What `proxy start` and `proxy restart` do. */
  daemon: {
    start(opts: ProxyStartOptions): Promise<void>;
    restart(opts: ProxyRestartOptions): Promise<void>;
  };
}
