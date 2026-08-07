#!/usr/bin/env node

/**
 * Pi Agent Entry Point
 * Direct entry point for codemie-pi command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('pi');
if (!agent) {
  console.error('✗ Pi agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
