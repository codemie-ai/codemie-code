import type { readState } from './daemon-manager.js';

/** The text `proxy start` fails with when a daemon with other settings is already running. */
export function formatDaemonConflict(
  state: NonNullable<Awaited<ReturnType<typeof readState>>>
): string {
  const details = [
    'A proxy is already running with different settings:',
    `  profile: ${state.profile}`,
    `  port: ${state.port}`,
  ];

  if (state.clientType) {
    details.push(`  client: ${state.clientType}`);
  }
  if (state.project) {
    details.push(`  project: ${state.project}`);
  }

  details.push('', 'Stop it first:', '  codemie proxy stop');
  return details.join('\n');
}
