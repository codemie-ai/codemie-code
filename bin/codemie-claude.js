#!/usr/bin/env node

/**
 * Claude Code Agent Entry Point
 * Direct entry point for codemie-claude command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('claude');
if (!agent) {
  console.error('✗ Claude agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
