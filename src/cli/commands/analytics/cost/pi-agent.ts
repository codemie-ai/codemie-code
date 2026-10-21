/**
 * Agent-name helpers for Pi-family analytics: Pi (`pi`) and its oh-my-pi fork (`omp`).
 *
 * The two share one transcript format and one session adapter (registered as `pi`), but are
 * reported as separate agents because their session roots, tooling and users differ.
 */

/** Agent key oh-my-pi sessions are reported under. */
export const OMP_AGENT = 'omp';

/** True for any agent whose transcripts the Pi session adapter reads and the Pi readers price. */
export function isPiFamilyAgent(agentName: string | undefined): boolean {
  const a = (agentName ?? '').toLowerCase();
  return a === 'pi' || a === OMP_AGENT;
}

/** Registry key of the session adapter that parses this agent's transcripts. */
export function sessionAdapterKey(agentName: string): string {
  return isPiFamilyAgent(agentName) ? 'pi' : agentName;
}
