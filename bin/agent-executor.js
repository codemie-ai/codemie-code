#!/usr/bin/env node

/**
 * Universal Agent Executor
 * Single bin script that handles all agents based on executable name
 *
 * How it works:
 * - npm creates symlinks: codemie-claude, codemie-codex, codemie-code
 * - All point to this single script
 * - Script detects agent from executable name
 * - Loads appropriate plugin from registry
 * - Runs universal CLI
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';
import { basename } from 'path';
import { logger } from '../dist/utils/logger.js';

// Detect agent from executable name
// /usr/local/bin/codemie-claude → 'claude'
// /usr/local/bin/codemie-code → 'codemie-code' (special case for built-in agent)
// NOTE: 'codemie-code' constant defined in src/agents/plugins/codemie-code.plugin.ts
const executableName = basename(process.argv[1]);
const BUILTIN_AGENT_NAME = 'codemie-code';

let agentName;
if (executableName === BUILTIN_AGENT_NAME) {
  agentName = BUILTIN_AGENT_NAME; // Keep full name for built-in agent
} else {
  agentName = executableName.replace('codemie-', ''); // Strip prefix for external agents
}

// Load agent from registry
const agent = AgentRegistry.getAgent(agentName);

if (!agent) {
  logger.error(`Unknown agent '${agentName}'`);
  console.log('Available agents:', AgentRegistry.getAgentNames().join(', '));
  process.exit(1);
}

// Create and run CLI
const cli = new AgentCLI(agent);
await cli.run(process.argv);
