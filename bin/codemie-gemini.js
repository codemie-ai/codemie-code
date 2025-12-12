#!/usr/bin/env node

/**
 * Gemini Agent Entry Point
 * Direct entry point for codemie-gemini command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('gemini');
if (!agent) {
  console.error('✗ Gemini agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
