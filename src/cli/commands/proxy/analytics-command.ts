/**
 * `codemie proxy analytics` — turns analytics collection off/on or excludes a single project for
 * the OTLP connectors (every connected connector by default; one connector via a connector flag),
 * without uninstalling the hooks `connect` already wrote. Deliberately nested under `proxy`, not
 * a new top-level command, so it is never confused with the unrelated reporting command at
 * `codemie analytics` (`src/cli/commands/analytics/`).
 */


import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import {
  addProjectPath,
  canonicalizePath,
  comparable,
  isPathInside,
  removeProjectPath,
} from '@/agents/core/project-allowlist.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { listConsents } from '@/agents/core/evidence/consent-store.js';
import { coverageNote } from './analytics-hints.js';
import { ANALYTICS_CONNECTORS, hasActiveAnalyticsConnector, listActiveAnalyticsConnectors, type AnalyticsConnector } from './analytics-connectors.js';
import { printNext } from '../../related-commands.js';
import { renderHint } from '@/utils/hint.js';
import type { DoctorRemedies } from './doctor/plan.js';
import { resolveCollection } from '../shared/analytics-collection/resolve.js';
import { formatReportRows, type ReportRow } from './analytics-report.js';
import {
  errorMessage,
  forEachTarget,
  printSaved,
  reportEffectiveState,
  hasConnectorFlag,
  resolveAnalyticsConnector,
  resolveAnalyticsConnectors,
  storeForConnector,
  withConnectorOptions,
  withErrorHandling,
  type AnalyticsConnectorId,
  type ConnectorOptions,
} from './analytics-targets.js';
import { addConsentCommands } from './analytics-consent-command.js';
import { addResendCommand } from './analytics-resend-command.js';
import { vendorFlag } from './flag-list.js';

export { resolveAnalyticsConnector, selectTargetConnectors, type TargetSelection } from './analytics-targets.js';

async function setEnabledFor(connectorId: AnalyticsConnectorId, enabled: boolean, remedies: DoctorRemedies): Promise<boolean> {
  const store = storeForConnector(connectorId);
  let changed = true;
  await store.update((current) => {
    changed = current.enabled !== enabled;
    return { ...current, enabled };
  });
  if (!changed) {
    console.log(chalk.dim('Nothing to change.'));
  } else {
    printSaved(store);
  }
  if (!enabled) {
    console.log(chalk.dim(coverageNote(connectorId, 'disable')));
    return true;
  }
  const resume = changed ? remedies.resumeNote(connectorId) : undefined;
  if (resume) {
    console.log(chalk.dim(resume));
  }
  await reportEffectiveState(connectorId, process.cwd(), remedies);
  return true;
}

async function setEnabled(enabled: boolean, opts: ConnectorOptions): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  const { remedies } = (await resolveCollection()).doctor;
  const succeeded = await forEachTarget(verb, opts, (connector) => setEnabledFor(connector.id, enabled, remedies), remedies);
  if (succeeded) printNext(`proxy analytics ${verb}`);
}

async function excludeFor(connectorId: AnalyticsConnectorId, path: string | undefined): Promise<boolean> {
  const store = storeForConnector(connectorId);
  const target = path ?? resolveProjectRoot();
  const canonical = await canonicalizePath(target);
  let changed = true;
  let coveredBy: string | undefined;
  await store.update(async (current) => {
    for (const entry of current.excludedProjects) {
      const canonicalEntry = await canonicalizePath(entry);
      if (comparable(canonicalEntry) !== comparable(canonical) && isPathInside(canonical, canonicalEntry)) {
        coveredBy = entry;
        break;
      }
    }
    if (coveredBy) {
      changed = false;
      return current;
    }
    // Drop entries strictly nested under the new, broader exclusion — they are now redundant.
    // The entry equal to the new target itself is kept so `addProjectPath` can dedupe it.
    const kept: string[] = [];
    for (const entry of current.excludedProjects) {
      const canonicalEntry = await canonicalizePath(entry);
      const isRedundantChild = comparable(canonicalEntry) !== comparable(canonical) && isPathInside(canonicalEntry, canonical);
      if (!isRedundantChild) {
        kept.push(entry);
      }
    }
    const excludedProjects = await addProjectPath(kept, target);
    changed = excludedProjects.length !== current.excludedProjects.length || kept.length !== current.excludedProjects.length;
    return changed ? { ...current, excludedProjects } : current;
  });
  if (!changed) {
    console.log(
      chalk.dim(
        coveredBy ? `Nothing to change: ${canonical} is already excluded via ${coveredBy}.` : 'Nothing to change.'
      )
    );
    return true;
  }
  printSaved(store, ` (project: ${canonical})`);
  console.log(chalk.dim(coverageNote(connectorId, 'exclude')));
  return true;
}

async function excludeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  const { remedies } = (await resolveCollection()).doctor;
  await forEachTarget('exclude', opts, (connector) => excludeFor(connector.id, path), remedies);
}

/** An excluded entry other than `target` itself that still covers it, or undefined. */
async function findCoveringExclusion(excludedProjects: string[], target: string, canonical: string): Promise<string | undefined> {
  for (const entry of await removeProjectPath(excludedProjects, target)) {
    if (isPathInside(canonical, await canonicalizePath(entry))) {
      return entry;
    }
  }
  return undefined;
}

async function isListed(paths: string[], canonical: string): Promise<boolean> {
  for (const entry of paths) {
    if (isPathInside(canonical, await canonicalizePath(entry))) return true;
  }
  return false;
}

/**
 * Makes `path` tracked by one connector. In project scope the connector's own project list is written
 * first and the exclusion removed second, so a failure between them leaves the project still excluded
 * (never tracked by half a change) and a re-run finishes the job.
 */
async function includeFor(connector: AnalyticsConnector, path: string | undefined, remedies: DoctorRemedies): Promise<boolean> {
  const connectorId = connector.id;
  const store = storeForConnector(connectorId);
  const target = path ?? resolveProjectRoot();
  const canonical = await canonicalizePath(target);
  const current = await store.read();
  const blockedBy = current ? await findCoveringExclusion(current.excludedProjects, target, canonical) : undefined;

  let added = false;
  const scope = await connector.readScope();
  if (!blockedBy && 'scope' in scope && scope.scope === 'project' && !(await isListed(scope.paths, canonical))) {
    try {
      await connector.addProject(target);
    } catch (error) {
      throw new ConfigurationError(
        `Could not add ${canonical} to the ${store.label} tracked projects: ${errorMessage(error)} Nothing was changed; a re-run is safe.`
      );
    }
    added = true;
    console.log(chalk.green(`✓ Added ${canonical} to the ${store.label} tracked projects.`));
  }

  let removed = true;
  let coveringParent: string | undefined;
  try {
    await store.update(async (prefs) => {
      const excludedProjects = await removeProjectPath(prefs.excludedProjects, target);
      removed = excludedProjects.length !== prefs.excludedProjects.length;
      // Checked against the list AFTER removal: a redundant entry nested under a
      // still-present parent must not be reported as "resumed" (CR-003 follow-up).
      coveringParent = await findCoveringExclusion(excludedProjects, target, canonical);
      return removed ? { ...prefs, excludedProjects } : prefs;
    });
  } catch (error) {
    if (!added) throw error;
    throw new ConfigurationError(
      `${canonical} was added to the ${store.label} tracked projects, but removing its exclusion failed: ${errorMessage(error)} ` +
        `Still owed: remove the exclusion. A re-run is safe: codemie proxy analytics include "${canonical}" ${vendorFlag(`--${connectorId}`)}`
    );
  }
  if (coveringParent) {
    console.log(chalk.yellow(`${canonical} is not tracked: it is still excluded via ${coveringParent}.`));
    console.log(
      chalk.yellow(
        `  ${renderHint({ reason: 'To remove that exclusion', command: `codemie proxy analytics include "${coveringParent}" ${vendorFlag(`--${connectorId}`)}` })}`
      )
    );
    return false;
  }
  if (removed) {
    printSaved(store, ` (project: ${canonical})`);
    const resume = remedies.resumeNote(connectorId);
    if (resume) {
      console.log(chalk.dim(resume));
    }
  } else if (!added) {
    console.log(chalk.dim('Nothing to change.'));
  }
  await reportEffectiveState(connectorId, canonical, remedies, store.label);
  return true;
}

async function includeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  const { remedies } = (await resolveCollection()).doctor;
  await forEachTarget('include', opts, (connector) => includeFor(connector, path, remedies), remedies);
}

/**
 * The connectors the status reports on: the ones the filters select, or without a filter every connected
 * connector. When none is connected the default connector reports it is not connected.
 */
async function selectStatusConnectors(opts: ConnectorOptions, fallback: AnalyticsConnector): Promise<AnalyticsConnector[]> {
  if (hasConnectorFlag(opts)) {
    const ids = resolveAnalyticsConnectors(opts);
    return ANALYTICS_CONNECTORS.filter((entry) => ids.includes(entry.id));
  }
  const connected = await listActiveAnalyticsConnectors();
  return connected.length > 0 ? connected : [fallback];
}

/**
 * The signed-in account's consented folders: empty when nobody is signed in (no consent can apply then), null when
 * the store cannot be read.
 */
async function readConsentedFolders(): Promise<Array<{ folder: string; project: string; allFolders?: true }> | null> {
  const identity = await currentEvidenceIdentity();
  if (!identity) return [];
  const listed = await listConsents(identity);
  return listed.kind === 'ok'
    ? listed.entries.map(({ folder, project, all_folders }) => ({ folder, project, ...(all_folders && { allFolders: true as const }) }))
    : null;
}

async function showStatus(opts: ConnectorOptions & { json?: boolean }): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    const connector = ANALYTICS_CONNECTORS.find((entry) => entry.id === connectorId);
    if (!connector) {
      throw new ConfigurationError(`Unknown analytics connector: ${connectorId}`);
    }
    const shown = await selectStatusConnectors(opts, connector);
    const statuses = await Promise.all(shown.map(async (entry) => ({ entry, status: await entry.collect() })));
    const plan = (await resolveCollection()).doctor;
    const consentedFolders = await readConsentedFolders();
    if (opts.json) {
      // Delivery stays in the JSON for scripts (null unless a connector is connected and the daemon runs);
      // the text report leaves it to `proxy doctor`.
      const delivery = (await hasActiveAnalyticsConnector()) ? (await plan.deliveryHealth({ json: true })).json : null;
      const connectors = statuses.map(({ entry, status }) => ({ ...status, connector: entry.id }));
      console.log(JSON.stringify({ delivery, connectors, consentedFolders }, null, 2));
      return;
    }
    const sections = await Promise.all(statuses.map(({ entry, status }) => entry.format(status, plan.remedies)));
    const consentRow: ReportRow =
      consentedFolders === null
        ? { message: 'Consented folders: unknown (the work-consent store cannot be read)' }
        : consentedFolders.length === 0
          ? { message: 'Consented folders: none' }
          : { message: 'Consented folders:', items: consentedFolders.map((c) => (c.allFolders ? 'any repository' : `${c.folder} (${c.project})`)) };
    const { lines } = await plan.deliveryHealth({ json: false });
    console.log([...sections, [...formatReportRows([consentRow]), ...lines].join('\n')].join('\n\n'));
    printNext('proxy analytics status');
  });
}

export function createProxyAnalyticsCommand(): Command {
  const analytics = new Command('analytics');
  analytics.description(
    'Control analytics collection: enable/disable, include/exclude projects, work-folder consent, and status'
  );

  withConnectorOptions(
    analytics.command('disable').description('Stop all analytics collection (every connected connector, or the flagged one; for Claude this covers hooks, Cowork and Claude Desktop chats; hooks stay installed)')
  ).action((opts: ConnectorOptions) => setEnabled(false, opts));

  withConnectorOptions(analytics.command('enable').description('Resume analytics collection (every connected connector, or the flagged one)')).action(
    (opts: ConnectorOptions) => setEnabled(true, opts)
  );

  withConnectorOptions(
    analytics
      .command('exclude [path]')
      .description('Exclude one project from analytics collection (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => excludeProject(path, opts));

  withConnectorOptions(
    analytics
      .command('include [path]')
      .description('Track a project again: remove its exclusion and, in project scope, add it to the tracked list (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => includeProject(path, opts));

  addConsentCommands(analytics);
  addResendCommand(analytics);

  withConnectorOptions(
    analytics.command('status').description('Show the effective analytics configuration for the connector')
  )
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action((opts: ConnectorOptions & { json?: boolean }) => showStatus(opts));

  return analytics;
}
