/**
 * GitHub Copilot local statistics: scan the artifacts Copilot writes on this machine
 * (CLI/Desktop session store, its `events.jsonl` fallback, VS Code chat sessions, WSL homes)
 * and map them into the analytics pipeline.
 *
 * See `docs/SPEC-copilot-local-statistics.md` for the design and the ported-from mapping.
 */

export {
  loadCopilotLocalSessions,
  totalBilledNanoAiu,
  totalPremiumRequests,
  NANO_AIU_PER_UNIT,
} from './copilot-local-loader.js';
export type { CopilotLocalLoadOptions, CopilotLocalResult } from './copilot-local-loader.js';
export type {
  CopilotAgentKey,
  CopilotRowSource,
  CopilotScanHealth,
  CopilotScanReason,
  CopilotScanResult,
  CopilotUsageRow,
} from './types.js';
export { scanSessionStore } from './store-reader.js';
export { scanSessionEvents } from './events-reader.js';
export { scanVsCodeSessions } from './vscode-sessions-reader.js';
export { scanWslHomes, runningDistros } from './wsl-reader.js';
export { readDesktopSessionIds, desktopDbPath } from './desktop-sessions.js';
export { vsCodeChatLocations, localCopilotHome } from './copilot-local-paths.js';
