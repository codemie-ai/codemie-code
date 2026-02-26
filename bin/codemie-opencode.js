#!/usr/bin/env node

/**
 * OpenCode Agent Entry Point
 * Direct entry point for codemie-opencode command
 */

import './_bootstrap.js';

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('opencode');
if (!agent) {
  console.error('✗ OpenCode agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
