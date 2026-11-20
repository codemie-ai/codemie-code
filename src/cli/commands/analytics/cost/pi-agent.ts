/**
 * Agent-name helpers for Pi-family analytics: Pi (`pi`) and its oh-my-pi fork (`omp`).
 *
 * The two share one transcript format and one session adapter (registered as `pi`), but are
 * reported as separate agents because their session roots, tooling and users differ.
 */

import { COPILOT_CLI_AGENT_NAME, COPILOT_DESKTOP_AGENT_NAME } from '../../../../agents/plugins/copilot-cli/copilot-cli.constants.js';

/** Agent key oh-my-pi sessions are reported under. */
export const OMP_AGENT = 'omp';

/** True for any agent whose transcripts the Pi session adapter reads and the Pi readers price. */
export function isPiFamilyAgent(agentName: string | undefined): boolean {
  const a = (agentName ?? '').toLowerCase();
  return a === 'pi' || a === OMP_AGENT;
}

/**
 * Registry key of the session adapter that parses this agent's transcripts. Discovery and cost
 * enrichment both resolve through it, so a session is replayed with the adapter that found it:
 * oh-my-pi reads with the Pi adapter, Copilot Desktop with the Copilot CLI adapter.
 */
export function sessionAdapterKey(agentName: string): string {
  if (isPiFamilyAgent(agentName)) return 'pi';
  return agentName === COPILOT_DESKTOP_AGENT_NAME ? COPILOT_CLI_AGENT_NAME : agentName;
}
