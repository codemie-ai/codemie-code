/**
 * Plain-language advice for `codemie proxy analytics`: why a project is not collected right now and
 * which command changes that. Kept free of I/O so it can never affect a command's outcome.
 *
 * `include`/`exclude` only edit the exclusion list; whether a project is collected at all also
 * depends on the connector scope written by `connect` (Project-scope allowlist, or "connected").
 * The advice makes that boundary visible instead of leaving users to guess.
 */

import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';

export interface NotTrackedAdvice {
  /** Why the project is not collected, as a clause ("it is excluded"). */
  description: string;
  /** The command (or action) that would change it, when there is one. */
  nextStep?: string;
}

function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

function claudeAdvice(reason: string, path: string): NotTrackedAdvice | undefined {
  switch (reason) {
    case 'disabled':
      return { description: 'analytics collection is disabled', nextStep: 'codemie proxy analytics enable' };
    case 'project-excluded':
      return { description: 'this project is excluded', nextStep: `codemie proxy analytics include ${quotePath(path)}` };
    case 'not-in-allowlist':
      return {
        description: 'it is not in the Project-scope allowlist',
        nextStep: `run this inside that project: codemie proxy connect --${CLAUDE_CODE_OTLP_AGENT_NAME} --scope project`,
      };
    case 'preferences-corrupt':
      return {
        description: 'the analytics preferences file is corrupt',
        nextStep: 'fix or delete it; `codemie proxy analytics status` shows where it is',
      };
    default:
      return undefined;
  }
}

function copilotAdvice(connectorId: string, reason: string, path: string): NotTrackedAdvice | undefined {
  const flag = `--${connectorId}`;
  switch (reason) {
    case 'analytics-disabled':
      return { description: 'analytics collection is disabled', nextStep: `codemie proxy analytics enable ${flag}` };
    case 'project-excluded':
      return { description: 'this project is excluded', nextStep: `codemie proxy analytics include ${quotePath(path)} ${flag}` };
    case 'scope-untracked':
      return {
        description: "it is outside this connector's Project scope",
        nextStep: `run this inside that project: codemie proxy connect ${flag} --scope project`,
      };
    case 'scope-disabled':
      return { description: 'the connector is not connected', nextStep: `codemie proxy connect ${flag}` };
    case 'scope-corrupt':
      return {
        description: 'the connector scope config is corrupt',
        nextStep: 'fix or delete ~/.codemie/copilot-connectors.json, then reconnect',
      };
    case 'preferences-corrupt':
      return {
        description: 'the analytics preferences file is corrupt',
        nextStep: 'fix or delete it; `codemie proxy analytics status` shows where it is',
      };
    default:
      return undefined;
  }
}

/** Advice for a gate reason, or `undefined` when the project is tracked or the reason is unknown. */
export function adviceForReason(connectorId: string, reason: string, path: string): NotTrackedAdvice | undefined {
  if (connectorId === CLAUDE_CODE_OTLP_AGENT_NAME) {
    return claudeAdvice(reason, path);
  }
  if (connectorId === COPILOT_CLI_OTLP_AGENT_NAME || connectorId === COPILOT_CHAT_OTLP_AGENT_NAME) {
    return copilotAdvice(connectorId, reason, path);
  }
  return undefined;
}
