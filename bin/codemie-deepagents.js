#!/usr/bin/env node

/**
 * Deep Agents Entry Point
 * Direct entry point for codemie-deepagents command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('deepagents');
if (!agent) {
  console.error('✗ Deep Agents not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
